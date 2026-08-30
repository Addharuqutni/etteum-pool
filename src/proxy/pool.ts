import { db } from "../db/index";
import { accounts, settings } from "../db/schema";
import { eq, and, asc, sql } from "drizzle-orm";
import type { Account } from "../db/schema";
import { broadcast } from "../ws/index";
import { config } from "../config";
import { getProviderForModel, type ProviderName } from "./providers/registry";
import { notifyAccountStatus } from "../services/alerts";

export type { ProviderName };

interface PoolState {
  lastIndex: Map<ProviderName, number>;
}

interface ActiveAccountsCacheEntry {
  accounts: Account[];
  expiresAt: number;
  inFlight?: Promise<Account[]>;
}

class AccountPool {
  private state: PoolState = {
    lastIndex: new Map(),
  };

  private activeAccountsCache = new Map<ProviderName, ActiveAccountsCacheEntry>();
  private inFlightByAccountId = new Map<number, number>();
  private lbMethodCache: {
    global: string;
    perProvider: Map<ProviderName, string>;
    perByokPrefix: Map<string, string>;
    expiresAt: number;
  } | null = null;

  /**
   * Clear cached active accounts after account mutations or status changes.
   */
  invalidate(provider?: ProviderName): void {
    if (provider) {
      this.activeAccountsCache.delete(provider);
      return;
    }

    this.activeAccountsCache.clear();
  }

  async getLoadBalancingMethod(provider: ProviderName): Promise<string> {
    const now = Date.now();
    if (!this.lbMethodCache || this.lbMethodCache.expiresAt <= now) {
      try {
        const rows = await db.select().from(settings);
        const perProvider = new Map<ProviderName, string>();
        const perByokPrefix = new Map<string, string>();
        let global = "sequential";
        for (const row of rows) {
          if (!row.value) continue;
          if (row.key === "load_balancing_method") {
            global = row.value;
            continue;
          }
          const byokMatch = row.key.match(/^byok_(.+)_lb_method$/);
          if (byokMatch && byokMatch[1]) {
            perByokPrefix.set(byokMatch[1], row.value);
            continue;
          }
          const match = row.key.match(/^provider_(.+)_lb_method$/);
          if (match && match[1]) perProvider.set(match[1] as ProviderName, row.value);
        }
        this.lbMethodCache = { global, perProvider, perByokPrefix, expiresAt: now + 10000 };
      } catch (err) {
        console.warn("[Pool] Failed to load load-balancing config, using sequential defaults:", err);
        this.lbMethodCache = {
          global: "sequential",
          perProvider: new Map(),
          perByokPrefix: new Map(),
          expiresAt: now + 10000,
        };
      }
    }
    return this.lbMethodCache?.perProvider.get(provider) || this.lbMethodCache?.global || "sequential";
  }

  async getByokLoadBalancingMethod(prefix: string): Promise<string> {
    await this.getLoadBalancingMethod("byok");
    return this.lbMethodCache?.perByokPrefix.get(prefix)
      || this.lbMethodCache?.perProvider.get("byok")
      || this.lbMethodCache?.global
      || "sequential";
  }

  invalidateLoadBalancingCache(): void {
    this.lbMethodCache = null;
  }

  /**
   * Get the next available account for a provider using configured method.
   */
  async getNextAccount(provider: ProviderName, excludeAccountIds: Set<number> = new Set()): Promise<Account | null> {
    const activeAccounts = (await this.getActiveAccounts(provider))
      .filter((account) => !excludeAccountIds.has(account.id));

    if (activeAccounts.length === 0) {
      try {
        const stats = await this.getStatsByProvider(provider);
        console.warn(
          `[Pool] No active accounts for provider "${provider}" ` +
            `(total: ${stats.total}, active: ${stats.active}, exhausted: ${stats.exhausted}, ` +
            `error: ${stats.error}, disabled: ${stats.disabled})`
        );
      } catch {
        console.warn(`[Pool] No active accounts for provider "${provider}" (stats unavailable)`);
      }
      return null;
    }

    const method = await this.getLoadBalancingMethod(provider);

    if (method === "sequential") {
      // Sequential: use first account with lowest in-flight, prefer order
      for (const account of activeAccounts) {
        if (this.getInFlightCount(account.id) === 0) return account;
      }
      return activeAccounts[0] || null;
    }

    // Round Robin (default)
    const startIdx = ((this.state.lastIndex.get(provider) || 0) + 1) % activeAccounts.length;
    let selected = activeAccounts[startIdx];
    let selectedIdx = startIdx;
    let selectedLoad = selected ? this.getInFlightCount(selected.id) : Number.POSITIVE_INFINITY;

    for (let i = 1; i < activeAccounts.length; i++) {
      const idx = (startIdx + i) % activeAccounts.length;
      const candidate = activeAccounts[idx];
      if (!candidate) continue;
      const load = this.getInFlightCount(candidate.id);
      if (load < selectedLoad) {
        selected = candidate;
        selectedIdx = idx;
        selectedLoad = load;
        if (load === 0) break;
      }
    }

    this.state.lastIndex.set(provider, selectedIdx);
    return selected || null;
  }

  getInFlightCount(accountId: number): number {
    return this.inFlightByAccountId.get(accountId) || 0;
  }

  trackRequestStart(accountId: number): void {
    this.inFlightByAccountId.set(accountId, this.getInFlightCount(accountId) + 1);
  }

  trackRequestEnd(accountId: number): void {
    const next = this.getInFlightCount(accountId) - 1;
    if (next > 0) this.inFlightByAccountId.set(accountId, next);
    else this.inFlightByAccountId.delete(accountId);
  }

  async decrementQuota(accountId: number, creditsUsed: number): Promise<number> {
    if (!Number.isFinite(creditsUsed) || creditsUsed <= 0) {
      const [account] = await db
        .select({ quotaRemaining: accounts.quotaRemaining })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      return Number(account?.quotaRemaining || 0);
    }

    const [account] = await db
      .update(accounts)
      .set({
        quotaRemaining: sql`MAX(0, COALESCE(${accounts.quotaRemaining}, 0) - ${creditsUsed})`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning({ quotaRemaining: accounts.quotaRemaining });

    return Number(account?.quotaRemaining || 0);
  }

  private async getActiveAccounts(provider: ProviderName): Promise<Account[]> {
    const ttlMs = Math.max(0, config.accountCacheTtlMs);
    if (ttlMs === 0) return this.fetchActiveAccounts(provider);

    const now = Date.now();
    const cached = this.activeAccountsCache.get(provider);
    if (cached && cached.expiresAt > now) return cached.accounts;
    if (cached?.inFlight) return cached.inFlight;

    const fetchTime = now;
    const inFlight = this.fetchActiveAccounts(provider)
      .then((activeAccounts) => {
        this.activeAccountsCache.set(provider, {
          accounts: activeAccounts,
          expiresAt: fetchTime + ttlMs,
        });
        return activeAccounts;
      })
      .catch((error) => {
        this.activeAccountsCache.delete(provider);
        throw error;
      });

    this.activeAccountsCache.set(provider, {
      accounts: cached?.accounts || [],
      expiresAt: 0,
      inFlight,
    });

    return inFlight;
  }

  private async fetchActiveAccounts(provider: ProviderName): Promise<Account[]> {
    try {
      return await db
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.provider, provider),
            eq(accounts.status, "active"),
            eq(accounts.enabled, true),
          )
        )
        .orderBy(asc(accounts.id));
    } catch (err) {
      console.error(`[Pool] Failed to fetch active accounts for provider "${provider}":`, err);
      throw err;
    }
  }

  /**
   * Get any available account across all providers that support the model.
   */
  async getAccountForModel(
    model: string,
    options: { excludeAccountIds?: Set<number> } = {}
  ): Promise<{ account: Account; provider: ProviderName } | null> {
    // Determine which provider handles this model
    const provider = this.getProviderForModel(model);
    if (!provider) {
      console.warn(`[Pool] No provider owns model "${model}"`);
      return null;
    }

    // BYOK requires special handling - find account by prefix
    if (provider === "byok") {
      const { getByokProvider } = await import("./providers/registry");
      const byokProvider = getByokProvider();
      const prefix = byokProvider.findPrefixForModel(model);
      const account = await byokProvider.findAccountForModel(model, {
        excludeAccountIds: options.excludeAccountIds,
        loadBalancingMethod: prefix ? await this.getByokLoadBalancingMethod(prefix) : await this.getLoadBalancingMethod("byok"),
        getInFlightCount: (accountId) => this.getInFlightCount(accountId),
      });
      if (!account) {
        console.warn(
          `[Pool] No BYOK account available for model "${model}" ` +
            `(prefix: ${prefix || "not found"})`
        );
        return null;
      }
      return { account, provider: "byok" };
    }

    const account = await this.getNextAccount(provider);
    if (!account) return null;

    return { account, provider };
  }

  /**
   * Map model name to provider. Delegates to the provider registry, which asks
   * each provider's ownsModel() in priority order (single source of truth).
   */
  getProviderForModel(model: string): ProviderName | null {
    return getProviderForModel(model);
  }

  /**
   * Mark an account as used (update last_used_at)
   */
  async markUsed(accountId: number): Promise<void> {
    try {
      await db
        .update(accounts)
        .set({
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId));
    } catch (err) {
      console.error(`[Pool] Failed to mark account ${accountId} as used:`, err);
    }
  }

  /**
   * Mark an account as exhausted (also zeroes out quota remaining)
   */
  async markExhausted(accountId: number): Promise<void> {
    try {
      const [account] = await db
        .update(accounts)
        .set({
          status: "exhausted",
          quotaRemaining: 0,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId))
        .returning();

      if (account) {
        this.invalidate(account.provider as ProviderName);
        broadcast({
          type: "account_status",
          data: { id: accountId, status: "exhausted", provider: account.provider },
        });
        void notifyAccountStatus(account);
      }
    } catch (err) {
      console.error(`[Pool] Failed to mark account ${accountId} as exhausted:`, err);
    }
  }

  /**
   * Mark an account as errored
   */
  async markError(accountId: number, errorMessage: string): Promise<void> {
    try {
      const [account] = await db
        .update(accounts)
        .set({
          status: "error",
          errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId))
        .returning();

      if (account) {
        this.invalidate(account.provider as ProviderName);
        broadcast({
          type: "account_status",
          data: { id: accountId, status: "error", error: errorMessage },
        });
        void notifyAccountStatus(account);
      }
    } catch (err) {
      console.error(`[Pool] Failed to mark account ${accountId} as error (${errorMessage}):`, err);
    }
  }

  async markTransientFailure(accountId: number, errorMessage: string): Promise<void> {
    try {
      const [account] = await db
        .update(accounts)
        .set({
          status: "active",
          errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId))
        .returning();

      if (account) this.invalidate(account.provider as ProviderName);

      broadcast({
        type: "account_status",
        data: { id: accountId, status: "active", warning: errorMessage },
      });
    } catch (err) {
      console.error(`[Pool] Failed to mark transient failure on account ${accountId} (${errorMessage}):`, err);
    }
  }

  /**
   * Update account tokens (stored as jsonb)
   */
  async updateTokens(accountId: number, tokens: unknown): Promise<void> {
    try {
      await db
        .update(accounts)
        .set({
          tokens,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId));
    } catch (err) {
      console.error(`[Pool] Failed to update tokens for account ${accountId}:`, err);
    }
  }

  /**
   * Toggle account enabled flag (user-controlled active/inactive).
   */
  async setEnabled(accountId: number, enabled: boolean): Promise<Account | null> {
    const [account] = await db
      .update(accounts)
      .set({
        enabled,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (!account) return null;

    this.invalidate(account.provider as ProviderName);
    broadcast({
      type: "account_status",
      data: { id: accountId, enabled, provider: account.provider, status: account.status },
    });
    return account;
  }

  /**
   * Bulk toggle enabled flag for all accounts of a provider.
   */
  async setEnabledByProvider(provider: ProviderName, enabled: boolean): Promise<number> {
    const result = await db
      .update(accounts)
      .set({
        enabled,
        updatedAt: new Date(),
      })
      .where(eq(accounts.provider, provider))
      .returning();

    const count = result.length;
    this.invalidate(provider);
    broadcast({
      type: "provider_toggled",
      data: { provider, enabled, count },
    });
    return count;
  }

  /**
   * Get pool statistics
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    exhausted: number;
    error: number;
    pending: number;
    disabled: number;
    byProvider: Record<string, { active: number; total: number; disabled: number }>;
  }> {
    const [totals, providerRows] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)`,
          active: sql<number>`SUM(CASE WHEN status = 'active' AND enabled = 1 THEN 1 ELSE 0 END)`,
          exhausted: sql<number>`SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END)`,
          error: sql<number>`SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`,
          pending: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
          disabled: sql<number>`SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END)`,
        })
        .from(accounts),
      db
        .select({
          provider: accounts.provider,
          total: sql<number>`count(*)`,
          active: sql<number>`SUM(CASE WHEN status = 'active' AND enabled = 1 THEN 1 ELSE 0 END)`,
          disabled: sql<number>`SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END)`,
        })
        .from(accounts)
        .groupBy(accounts.provider),
    ]);

    const totalRow = totals[0];
    const byProvider: Record<string, { active: number; total: number; disabled: number }> = {};

    for (const row of providerRows) {
      byProvider[row.provider] = {
        active: row.active || 0,
        total: row.total || 0,
        disabled: row.disabled || 0,
      };
    }

    return {
      total: totalRow?.total || 0,
      active: totalRow?.active || 0,
      exhausted: totalRow?.exhausted || 0,
      error: totalRow?.error || 0,
      pending: totalRow?.pending || 0,
      disabled: totalRow?.disabled || 0,
      byProvider,
    };
  }

  /**
   * Get per-provider account statistics (used for descriptive error messages
   * when no active account is available).
   */
  async getStatsByProvider(provider: ProviderName): Promise<{
    total: number;
    active: number;
    exhausted: number;
    error: number;
    pending: number;
    disabled: number;
  }> {
    const [row] = await db
      .select({
        total: sql<number>`count(*)`,
        active: sql<number>`SUM(CASE WHEN status = 'active' AND enabled = 1 THEN 1 ELSE 0 END)`,
        exhausted: sql<number>`SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END)`,
        error: sql<number>`SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`,
        pending: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
        disabled: sql<number>`SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END)`,
      })
      .from(accounts)
      .where(eq(accounts.provider, provider));

    return {
      total: row?.total || 0,
      active: row?.active || 0,
      exhausted: row?.exhausted || 0,
      error: row?.error || 0,
      pending: row?.pending || 0,
      disabled: row?.disabled || 0,
    };
  }
}

export const pool = new AccountPool();
