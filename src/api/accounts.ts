import { Hono } from "hono";
import { db } from "../db/index";
import { accounts, requestLogs, vccCards, vccTransactions, settings } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import type { Account, NewAccount } from "../db/schema";
import { loginQueue } from "../auth/queue";
import { warmupQueue } from "../auth/warmup-queue";
import { warmupAccount } from "../auth/warmup-runner";
import { pool, type ProviderName } from "../proxy/pool";
import type { Provider } from "../config";
import {
  exchangeClaudeAuthorizationCode,
  fetchClaudeProfile,
  type ClaudeTokens,
} from "../proxy/providers/claude";
import { ANTIGRAVITY_OAUTH, discoverOrProvisionProject } from "../proxy/providers/antigravity";

export const accountsRouter = new Hono();

type ByokKeyInput = {
  id?: number;
  label?: string;
  key?: string;
  api_key?: string;
  enabled?: boolean;
  weight?: number;
  priority?: number;
};

type ByokTokensShape = {
  base_url?: string;
  api_key?: string;
  format?: "openai" | "anthropic" | "auto";
  models?: string[];
  model_prefix?: string;
  headers?: Record<string, string>;
  key_label?: string;
  weight?: number;
  priority?: number;
  load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
};

const BYOK_PREFIX_RE = /^[a-z0-9-]+$/;
const BYOK_KEY_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

function parseByokTokens(raw: unknown): ByokTokensShape {
  if (!raw) return {};
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as ByokTokensShape;
  } catch (err) {
    console.warn("[API accounts] Failed to parse BYOK tokens JSON:", err);
    return {};
  }
}

function getByokPrefix(account: { email: string; tokens: unknown }): string {
  const tokens = parseByokTokens(account.tokens);
  return tokens.model_prefix || account.email.split("#")[0] || account.email;
}

function getByokKeyLabel(account: { email: string; tokens: unknown }): string {
  const tokens = parseByokTokens(account.tokens);
  if (tokens.key_label) return tokens.key_label;
  const marker = account.email.indexOf("#");
  return marker >= 0 ? account.email.slice(marker + 1) || "default" : "default";
}

function normalizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return Array.from(new Set(models.map((m) => String(m).trim()).filter(Boolean)));
}

function normalizeByokKeys(apiKeys: unknown, legacyApiKey?: string): Array<{ label: string; key: string; weight?: number; priority?: number }> {
  const rawKeys = Array.isArray(apiKeys)
    ? apiKeys as ByokKeyInput[]
    : legacyApiKey
      ? [{ label: "default", key: legacyApiKey }]
      : [];

  const normalized: Array<{ label: string; key: string; weight?: number; priority?: number }> = [];
  const seen = new Set<string>();
  for (const [index, item] of rawKeys.entries()) {
    const label = String(item.label || `key-${index + 1}`).trim().toLowerCase();
    const key = String(item.key || item.api_key || "").trim();
    if (!key) continue;
    if (!BYOK_KEY_LABEL_RE.test(label)) {
      throw new Error("key label must start with lowercase alphanumeric and contain only lowercase letters, numbers, hyphen, or underscore");
    }
    if (seen.has(label)) throw new Error(`duplicate BYOK key label: ${label}`);
    seen.add(label);
    normalized.push({
      label,
      key,
      weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined,
      priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : index,
    });
  }
  return normalized;
}

function buildByokEmail(prefix: string, keyLabel: string): string {
  return `${prefix}#${keyLabel}`;
}

function byokLbSettingKey(prefix: string): string {
  return `byok_${prefix}_lb_method`;
}

function normalizeByokLbMethod(value: unknown): "round_robin" | "sequential" | "least_inflight" {
  return value === "sequential" || value === "least_inflight" ? value : "round_robin";
}

async function setByokLbMethod(prefix: string, method: string) {
  const key = byokLbSettingKey(prefix);
  const value = normalizeByokLbMethod(method);
  const existing = await db.select().from(settings).where(eq(settings.key, key));
  if (existing.length > 0) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value });
  }
  pool.invalidateLoadBalancingCache();
}

async function getByokLbMethods(prefixes: string[]): Promise<Map<string, string>> {
  const wanted = new Set(prefixes.map(byokLbSettingKey));
  const rows = await db.select().from(settings);
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!wanted.has(row.key) || !row.value) continue;
    const prefix = row.key.replace(/^byok_/, "").replace(/_lb_method$/, "");
    result.set(prefix, normalizeByokLbMethod(row.value));
  }
  return result;
}

async function refreshByokRuntime() {
  pool.invalidate("byok" as ProviderName);
  const { refreshByokModels } = await import("../proxy/providers/registry");
  await refreshByokModels();
}

/**
 * GET /api/accounts/warmup-queue - Get warmup progress per provider
 */
accountsRouter.get("/warmup-queue", (c) => {
  return c.json({ data: warmupQueue.getProgressByProvider() });
});

/**
 * GET /api/accounts - List all accounts
 */
accountsRouter.get("/", async (c) => {
  try {
    const allAccounts = await db.select().from(accounts);

    // Don't expose passwords in response
    const sanitized = allAccounts.map((acc) => ({
      ...acc,
      password: "***",
      tokens: acc.tokens ? "[set]" : null,
    }));

    return c.json({ data: sanitized, total: sanitized.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API accounts] Failed to list accounts:", error);
    return c.json({ error: `Failed to list accounts: ${msg}` }, 500);
  }
});

/**
 * BYOK (Bring Your Own Key) Management Endpoints
 * NOTE: Must be defined BEFORE /:id routes to avoid route collision
 */

/**
 * POST /api/accounts/byok - Create BYOK provider group with one or more API keys.
 * Backward compatible: accepts either `api_key` or `api_keys[]`.
 */
accountsRouter.post("/byok", async (c) => {
  const body = await c.req.json<{
    label: string;
    base_url: string;
    api_key?: string;
    api_keys?: ByokKeyInput[];
    format?: "openai" | "anthropic" | "auto";
    models: string[];
    headers?: Record<string, string>;
    load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
  }>();

  const label = String(body.label || "").trim().toLowerCase();
  const baseUrl = String(body.base_url || "").trim().replace(/\/$/, "");
  const models = normalizeModels(body.models);

  if (!label || !baseUrl || models.length === 0) {
    return c.json({ error: "label, base_url, and models[] are required" }, 400);
  }
  if (!BYOK_PREFIX_RE.test(label)) {
    return c.json({ error: "label must be lowercase alphanumeric with hyphens only" }, 400);
  }

  let keyInputs: Array<{ label: string; key: string; weight?: number; priority?: number }>;
  try {
    keyInputs = normalizeByokKeys(body.api_keys, body.api_key);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (keyInputs.length === 0) {
    return c.json({ error: "At least one API key is required" }, 400);
  }

  let existingByok;
  try {
    existingByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API accounts] Failed to check existing BYOK providers:", error);
    return c.json({ error: `Failed to check existing providers: ${msg}` }, 500);
  }
  if (existingByok.some((acc) => getByokPrefix(acc) === label)) {
    return c.json({ error: "BYOK provider with this label already exists" }, 409);
  }

  try {
    const createdRows = [];
    for (const [index, keyInput] of keyInputs.entries()) {
      const tokens: ByokTokensShape = {
        base_url: baseUrl,
        format: body.format || "auto",
        models,
        model_prefix: label,
        headers: body.headers || {},
        key_label: keyInput.label,
        weight: keyInput.weight,
        priority: keyInput.priority ?? index,
        load_balancing_method: normalizeByokLbMethod(body.load_balancing_method),
      };

      const result = await db.insert(accounts).values({
        provider: "byok",
        email: buildByokEmail(label, keyInput.label),
        password: encrypt(keyInput.key),
        status: "active",
        enabled: true,
        tokens,
        quotaLimit: -1,
        quotaRemaining: -1,
      }).returning();
      if (result[0]) createdRows.push(result[0]);
    }

    await setByokLbMethod(label, normalizeByokLbMethod(body.load_balancing_method));
    await refreshByokRuntime();
    broadcast({
      type: "byok_created",
      data: { id: createdRows[0]?.id, label, keyCount: createdRows.length },
    });

    return c.json({
      success: true,
      id: createdRows[0]?.id,
      label,
      key_count: createdRows.length,
      models: models.map((m) => `${label}-${m}`),
    }, 201);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API accounts] Failed to create BYOK provider:", error);
    return c.json({ error: `Failed to create BYOK provider: ${msg}` }, 500);
  }
});

/**
 * GET /api/accounts/byok - List BYOK provider groups with masked key metadata.
 */
accountsRouter.get("/byok", async (c) => {
  try {
    const byokAccounts = await db.select().from(accounts)
      .where(eq(accounts.provider, "byok"));

    const lbMethods = await getByokLbMethods(Array.from(new Set(byokAccounts.map((acc) => getByokPrefix(acc)))));

    const groups = new Map<string, {
      id: number;
      label: string;
      base_url: string;
      format: "openai" | "anthropic" | "auto";
      models: string[];
      model_prefix: string;
      headers?: Record<string, string>;
      status: string;
      enabled: boolean;
      available_models: string[];
      key_count: number;
      active_key_count: number;
      load_balancing_method: string;
      keys: Array<{
        id: number;
        label: string;
        status: string;
        enabled: boolean;
        weight?: number;
        priority?: number;
        lastUsedAt?: Date | null;
        errorMessage?: string | null;
      }>;
    }>();

    for (const acc of byokAccounts) {
      const tokens = parseByokTokens(acc.tokens);
      const prefix = tokens.model_prefix || getByokPrefix(acc);
      const keyLabel = getByokKeyLabel(acc);
      const models = normalizeModels(tokens.models || []);
      const existing = groups.get(prefix);

      if (!existing) {
        groups.set(prefix, {
          id: acc.id,
          label: prefix,
          base_url: tokens.base_url || "",
          format: tokens.format || "auto",
          models,
          model_prefix: prefix,
          headers: tokens.headers || {},
          status: acc.status,
          enabled: Boolean(acc.enabled),
          available_models: models.map((m) => `${prefix}-${m}`),
          key_count: 0,
          active_key_count: 0,
          load_balancing_method: lbMethods.get(prefix) || tokens.load_balancing_method || "round_robin",
          keys: [],
        });
      } else {
        const modelSet = new Set(existing.models);
        for (const model of models) modelSet.add(model);
        existing.models = Array.from(modelSet);
        existing.available_models = existing.models.map((m) => `${prefix}-${m}`);
        existing.enabled = existing.enabled || Boolean(acc.enabled);
        existing.status = existing.status === "active" || acc.status !== "active" ? existing.status : "active";
      }

      const group = groups.get(prefix)!;
      group.key_count += 1;
      if (acc.enabled && acc.status === "active") group.active_key_count += 1;
      group.keys.push({
        id: acc.id,
        label: keyLabel,
        status: acc.status,
        enabled: Boolean(acc.enabled),
        weight: tokens.weight,
        priority: tokens.priority,
        lastUsedAt: acc.lastUsedAt,
        errorMessage: acc.errorMessage,
      });
    }

    const providers = Array.from(groups.values()).map((group) => ({
      ...group,
      keys: group.keys.sort((a, b) => (Number(a.priority ?? 9999) - Number(b.priority ?? 9999)) || a.id - b.id),
    })).sort((a, b) => a.label.localeCompare(b.label));

    return c.json({ providers, total: providers.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API accounts] Failed to list BYOK providers:", error);
    return c.json({ error: `Failed to list BYOK providers: ${msg}` }, 500);
  }
});

/**
 * POST /api/accounts/byok/fetch-models - Probe an upstream base_url + api_key
 * (OpenAI or Anthropic compatible) and return the model IDs it advertises.
 *
 * Body: { base_url, api_key, format?, headers? }
 * Response: { models: string[] } (sorted, deduped)
 *
 * Never persists anything — it is a pure "what models does this key see?"
 * lookup used by the dashboard to pre-fill the BYOK model list.
 */
accountsRouter.post("/byok/fetch-models", async (c) => {
  const body = await c.req.json<{
    base_url?: string;
    api_key?: string;
    format?: "openai" | "anthropic" | "auto";
    headers?: Record<string, string>;
  }>();

  const baseUrl = String(body.base_url || "").trim().replace(/\/$/, "");
  const apiKey = String(body.api_key || "").trim();
  if (!baseUrl || !apiKey) {
    return c.json({ error: "base_url and api_key are required" }, 400);
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return c.json({ error: "base_url must start with http:// or https://" }, 400);
  }

  const format = body.format === "anthropic" ? "anthropic" : "openai";
  const upstreamHeaders: Record<string, string> = { ...(body.headers || {}) };
  if (format === "anthropic") {
    upstreamHeaders["x-api-key"] = apiKey;
    upstreamHeaders["anthropic-version"] = "2023-06-01";
  } else {
    upstreamHeaders["Authorization"] = `Bearer ${apiKey}`;
  }

  let res: Response;
  try {
    const { safeFetch } = await import("../utils/ssrf");
    res = await safeFetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Accept: "application/json", ...upstreamHeaders },
    }, { timeoutMs: 15000 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[API accounts] fetch-models failed for ${baseUrl}:`, error);
    return c.json({ error: `Failed to reach upstream: ${msg}` }, 502);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[API accounts] fetch-models upstream ${res.status} for ${baseUrl}: ${text.slice(0, 200)}`);
    return c.json({ error: `Upstream returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` }, 502);
  }

  let data: Array<{ id?: unknown }> = [];
  try {
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (json && Array.isArray(json.data)) data = json.data;
  } catch (error) {
    return c.json({ error: "Upstream returned an unparseable response" }, 502);
  }

  const models = Array.from(
    new Set(data.map((m) => String(m?.id ?? "").trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  return c.json({ models });
});

/**
 * POST /api/accounts/byok/:id/reveal - Reveal a stored BYOK key secret.
 *
 * The list endpoint intentionally keeps secrets masked. This endpoint is called
 * only on an explicit eye-icon action from the authenticated dashboard so the
 * secret is not sent with normal page loads or websocket refreshes.
 */
accountsRouter.post("/byok/:id/reveal", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid BYOK key id" }, 400);

  let account;
  try {
    account = await db.select().from(accounts).where(eq(accounts.id, id)).get();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API accounts] Failed to fetch BYOK key for reveal:", error);
    return c.json({ error: `Failed to fetch BYOK key: ${msg}` }, 500);
  }
  if (!account || account.provider !== "byok") {
    return c.json({ error: "BYOK key not found" }, 404);
  }

  try {
    return c.json({
      success: true,
      id: account.id,
      label: getByokKeyLabel(account),
      key: decrypt(account.password),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API accounts] Failed to decrypt BYOK key:", error);
    return c.json({ error: `Failed to decrypt BYOK key: ${msg}` }, 500);
  }
});

/**
 * PATCH /api/accounts/byok/:id - Update a BYOK provider group.
 * If `api_keys` is provided it becomes the desired key set: existing keys can be
 * referenced by id/label and omitted keys are deleted from the group.
 */
accountsRouter.patch("/byok/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    base_url?: string;
    api_key?: string;
    api_keys?: ByokKeyInput[];
    format?: "openai" | "anthropic" | "auto";
    models?: string[];
    headers?: Record<string, string>;
    load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
  }>();

  let account;
  try {
    account = await db.select().from(accounts)
      .where(eq(accounts.id, id))
      .get();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to fetch BYOK account ${id} for update:`, error);
    return c.json({ error: `Failed to fetch account: ${msg}` }, 500);
  }

  if (!account || account.provider !== "byok") {
    return c.json({ error: "BYOK provider not found" }, 404);
  }

  const prefix = getByokPrefix(account);
  let allByok;
  try {
    allByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API accounts] Failed to fetch BYOK group accounts:", error);
    return c.json({ error: `Failed to fetch BYOK accounts: ${msg}` }, 500);
  }
  const groupAccounts = allByok.filter((acc) => getByokPrefix(acc) === prefix);
  const currentTokens = parseByokTokens(account.tokens);
  const nextBaseUrl = body.base_url?.trim().replace(/\/$/, "") || currentTokens.base_url || "";
  const nextFormat = body.format || currentTokens.format || "auto";
  const nextModels = body.models ? normalizeModels(body.models) : normalizeModels(currentTokens.models || []);
  const nextHeaders = body.headers ?? currentTokens.headers ?? {};

  if (!nextBaseUrl || nextModels.length === 0) {
    return c.json({ error: "base_url and at least one model are required" }, 400);
  }

  try {
    const keyPayloadProvided = Array.isArray(body.api_keys);
    const desiredKeys = keyPayloadProvided ? (body.api_keys || []) : [];
    const touchedIds = new Set<number>();

    if (keyPayloadProvided) {
      const seenLabels = new Set<string>();
      for (const [index, keyInput] of desiredKeys.entries()) {
        const keyLabel = String(keyInput.label || `key-${index + 1}`).trim().toLowerCase();
        const keySecret = String(keyInput.key || keyInput.api_key || "").trim();
        if (!BYOK_KEY_LABEL_RE.test(keyLabel)) {
          return c.json({ error: "key label must start with lowercase alphanumeric and contain only lowercase letters, numbers, hyphen, or underscore" }, 400);
        }
        if (seenLabels.has(keyLabel)) return c.json({ error: `duplicate BYOK key label: ${keyLabel}` }, 400);
        seenLabels.add(keyLabel);

        const existing = groupAccounts.find((acc) =>
          (keyInput.id && acc.id === keyInput.id) || getByokKeyLabel(acc) === keyLabel
        );
        const tokens: ByokTokensShape = {
          ...parseByokTokens(existing?.tokens),
          base_url: nextBaseUrl,
          format: nextFormat,
          models: nextModels,
          model_prefix: prefix,
          headers: nextHeaders,
          key_label: keyLabel,
          weight: Number.isFinite(Number(keyInput.weight)) ? Number(keyInput.weight) : undefined,
          priority: Number.isFinite(Number(keyInput.priority)) ? Number(keyInput.priority) : index,
          load_balancing_method: normalizeByokLbMethod(body.load_balancing_method || currentTokens.load_balancing_method),
        };

        if (existing) {
          const updateData: Record<string, unknown> = {
            email: buildByokEmail(prefix, keyLabel),
            tokens,
            enabled: typeof keyInput.enabled === "boolean" ? keyInput.enabled : existing.enabled,
            updatedAt: new Date(),
          };
          if (keySecret) updateData.password = encrypt(keySecret);
          await db.update(accounts).set(updateData).where(eq(accounts.id, existing.id));
          touchedIds.add(existing.id);
        } else {
          if (!keySecret) return c.json({ error: `new key "${keyLabel}" requires a secret` }, 400);
          const inserted = await db.insert(accounts).values({
            provider: "byok",
            email: buildByokEmail(prefix, keyLabel),
            password: encrypt(keySecret),
            status: "active",
            enabled: keyInput.enabled ?? true,
            tokens,
            quotaLimit: -1,
            quotaRemaining: -1,
          }).returning();
          if (inserted[0]) touchedIds.add(inserted[0].id);
        }
      }

      const toDelete = groupAccounts.filter((acc) => !touchedIds.has(acc.id));
      for (const acc of toDelete) {
        await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, acc.id));
        await db.delete(accounts).where(eq(accounts.id, acc.id));
      }
    } else {
      for (const acc of groupAccounts) {
        const tokens = parseByokTokens(acc.tokens);
        const updateData: Record<string, unknown> = {
          tokens: {
            ...tokens,
            base_url: nextBaseUrl,
            format: nextFormat,
            models: nextModels,
            model_prefix: prefix,
            headers: nextHeaders,
            load_balancing_method: normalizeByokLbMethod(body.load_balancing_method || tokens.load_balancing_method),
          },
          updatedAt: new Date(),
        };
        if (body.api_key && acc.id === id) updateData.password = encrypt(body.api_key);
        await db.update(accounts).set(updateData).where(eq(accounts.id, acc.id));
      }
    }

    await setByokLbMethod(prefix, normalizeByokLbMethod(body.load_balancing_method || currentTokens.load_balancing_method));
    await refreshByokRuntime();
    broadcast({ type: "byok_updated", data: { id, label: prefix } });

    return c.json({
      success: true,
      id,
      label: prefix,
      models: nextModels.map((m) => `${prefix}-${m}`),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to update BYOK provider ${id}:`, error);
    return c.json({ error: `Failed to update BYOK provider: ${msg}` }, 500);
  }
});

/**
 * DELETE /api/accounts/byok/:id - Delete a BYOK provider group and all keys in it.
 */
accountsRouter.delete("/byok/:id", async (c) => {
  const id = Number(c.req.param("id"));
  let account;
  try {
    account = await db.select().from(accounts).where(eq(accounts.id, id)).get();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to fetch BYOK account ${id} for delete:`, error);
    return c.json({ error: `Failed to fetch account: ${msg}` }, 500);
  }

  if (!account || account.provider !== "byok") {
    return c.json({ error: "BYOK provider not found" }, 404);
  }

  const prefix = getByokPrefix(account);
  try {
    const allByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
    const groupAccounts = allByok.filter((acc) => getByokPrefix(acc) === prefix);
    const deletedIds: number[] = [];

    for (const acc of groupAccounts) {
      await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, acc.id));
      const result = await db.delete(accounts).where(eq(accounts.id, acc.id)).returning();
      if (result[0]) deletedIds.push(result[0].id);
    }

    await refreshByokRuntime();
    broadcast({ type: "byok_deleted", data: { id, label: prefix, deletedIds } });

    return c.json({ success: true, deleted: id, deletedIds, label: prefix });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to delete BYOK provider ${id}:`, error);
    return c.json({ error: `Failed to delete BYOK provider: ${msg}` }, 500);
  }
});

/**
 * Helper: Auto-fix account if in error state after successful test
 */
async function autoFixAccountIfError(accountId: number, accountStatus: string) {
  if (accountStatus === 'error') {
    await db.update(accounts)
      .set({
        status: 'active',
        errorMessage: null,
        updatedAt: new Date()
      })
      .where(eq(accounts.id, accountId));
    pool.invalidate('byok');
    const { refreshByokModels } = await import("../proxy/providers/registry");
    await refreshByokModels();
    broadcast({
      type: 'account_status',
      data: { id: accountId, status: 'active' }
    });
    return true;
  }
  return false;
}

/**
 * POST /api/accounts/byok/:id/test - Test BYOK connection
 * Accepts optional { model?: string } body to test a specific model.
 * Returns latency_ms and auto_fixed status.
 */
accountsRouter.post("/byok/:id/test", async (c) => {
  const id = Number(c.req.param("id"));
  const reqBody = await c.req.json().catch(() => ({})) as { model?: string };

  let account;
  try {
    account = await db.select().from(accounts)
      .where(eq(accounts.id, id))
      .get();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API accounts] Failed to fetch BYOK account for test:", error);
    return c.json({ success: false, error: `Failed to fetch account: ${msg}` }, 500);
  }

  if (!account || account.provider !== "byok") {
    return c.json({ error: "BYOK provider not found" }, 404);
  }

  let tokens: any;
  try {
    tokens = typeof account.tokens === "string"
      ? JSON.parse(account.tokens)
      : account.tokens;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to parse BYOK tokens for account ${id}:`, error);
    return c.json({ success: false, error: `Corrupt BYOK tokens: ${msg}` }, 500);
  }

  if (!tokens?.base_url || !tokens?.models || tokens.models.length === 0) {
    return c.json({ success: false, error: "Invalid BYOK configuration: missing base_url or models" }, 400);
  }

  let apiKey: string;
  try {
    apiKey = decrypt(account.password);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to decrypt BYOK key for account ${id}:`, error);
    return c.json({ success: false, error: `Failed to decrypt API key: ${msg}` }, 500);
  }
  const format = tokens.format || "auto";
  const testModel = reqBody.model || tokens.models[0];

  // Any model id may be tested — including ones discovered via /models that
  // are not in the routing list yet. Unknown models surface as the remote
  // API's own error, which is exactly what a test should report.

  // Determine endpoint based on format
  const isAnthropic = format === "anthropic" ||
    (format === "auto" && (tokens.base_url.includes("anthropic.com") || tokens.base_url.includes("/v1/messages")));

  const url = isAnthropic
    ? `${tokens.base_url}/messages`
    : `${tokens.base_url}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(tokens.headers || {}),
  };

  const body = isAnthropic
    ? {
        model: testModel,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
      }
    : {
        model: testModel,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
      };

  if (isAnthropic) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const startTime = Date.now();
    const { safeFetch } = await import("../utils/ssrf");
    const response = await safeFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, { timeoutMs: 20_000 });
    const latencyMs = Date.now() - startTime;

    if (response.status === 401 || response.status === 403) {
      return c.json({ success: false, error: "Authentication failed", latency_ms: latencyMs });
    }

    if (response.status === 429) {
      const autoFixed = await autoFixAccountIfError(id, account.status);
      return c.json({
        success: true,
        warning: "Rate limited but authentication works",
        latency_ms: latencyMs,
        auto_fixed: autoFixed
      });
    }

    if (!response.ok) {
      const text = await response.text();
      return c.json({ success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}`, latency_ms: latencyMs });
    }

    const autoFixed = await autoFixAccountIfError(id, account.status);
    return c.json({
      success: true,
      message: "Connection test passed",
      model: testModel,
      format: isAnthropic ? "anthropic" : "openai",
      latency_ms: latencyMs,
      auto_fixed: autoFixed
    });
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    });
  }
});

/**
 * GET /api/accounts/:id - Get single account
 */
accountsRouter.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  let account;
  try {
    [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to fetch account ${id}:`, error);
    return c.json({ error: `Failed to fetch account: ${msg}` }, 500);
  }

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  return c.json({
    ...account,
    password: "***",
    tokens: account.tokens ? "[set]" : null,
  });
});

/**
 * POST /api/accounts - Create new account
 */
accountsRouter.post("/", async (c) => {
  const body = await c.req.json<{
    provider: Provider;
    email?: string;
    password?: string;
    personalToken?: string;
    apiKey?: string; // Single API key flow (ck_...): codebuddy / codebuddy-china
    apiKeys?: string; // Bulk API key flow: newline-separated ck_... keys
    accessToken?: string; // CodeBuddy global/CN: OAuth access_token (JWT)
    access_token?: string; // snake_case alias for accessToken
    refresh_token?: string; // snake_case alias for tokens.refresh_token
    uid?: string; // CodeBuddy global/CN: Keycloak user id (optional, else from JWT sub)
    tokens?: Record<string, unknown>;
    status?: "active" | "pending";
    browserEngine?: string;
    headless?: boolean;
  }>();

  if (!body.provider) {
    return c.json({ error: "provider is required" }, 400);
  }

  // ── CodeBuddy China: Single API key flow (ck_...) ────────────────────
  // Accept a single API key, validate format, and create one account with
  // an auto-generated email label.
  if (body.provider === "codebuddy-china" && body.apiKey) {
    const key = body.apiKey.trim();
    if (!key) return c.json({ error: "apiKey is empty" }, 400);
    if (!key.startsWith("ck_")) {
      return c.json({ error: `Invalid API key format: ${key.substring(0, 20)}... (must start with ck_)` }, 400);
    }

    const encryptedKey = encrypt(key);
    const tokens = JSON.stringify({ api_key: key });

    // Generate a unique email label that doesn't collide with existing accounts.
    const existingEmails = await db.select({ email: accounts.email }).from(accounts)
      .where(eq(accounts.provider, "codebuddy-china"))
      .then((rows) => new Set(rows.map((r) => r.email)));
    let suffix = 1;
    let email = `cbc-account-${suffix}`;
    while (existingEmails.has(email)) {
      suffix++;
      email = `cbc-account-${suffix}`;
    }

    try {
      const inserted = await db.insert(accounts).values({
        provider: "codebuddy-china",
        email,
        password: encryptedKey,
        status: "active",
        tokens,
        quotaLimit: -1,
        quotaRemaining: -1,
        lastLoginAt: new Date(),
      }).returning();
      const created = inserted[0]!;
      pool.invalidate("codebuddy-china" as any);
      broadcast({ type: "account_created", data: { id: created.id, provider: "codebuddy-china", email } });
      return c.json({ ...created, password: "***", tokens: "[set]" }, 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `Failed to create CodeBuddy China account: ${msg}` }, 500);
    }
  }

  // ── CodeBuddy China: Bulk API key flow (ck_...) ─────────────────────
  // Accept multiple API keys (one per line), validate format, and create
  // account per key with auto-generated email label.
  if (body.provider === "codebuddy-china" && body.apiKeys) {
    const keys = body.apiKeys
      .split("\n")
      .map((k: string) => k.trim())
      .filter((k: string) => k.length > 0);

    if (keys.length === 0) {
      return c.json({ error: "apiKeys is empty" }, 400);
    }

    // Validate format
    for (const key of keys) {
      if (!key.startsWith("ck_")) {
        return c.json({ error: `Invalid API key format: ${key.substring(0, 20)}... (must start with ck_)` }, 400);
      }
    }

    const created: Array<{ id: number; email: string }> = [];
    let existingEmails: Set<string>;
    try {
      existingEmails = await db.select({ email: accounts.email }).from(accounts)
        .where(eq(accounts.provider, "codebuddy-china"))
        .then((rows) => new Set(rows.map((r) => r.email)));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[API accounts] Failed to query existing CodeBuddy China accounts:", error);
      return c.json({ error: `Failed to query existing accounts: ${msg}` }, 500);
    }
    const existingCount = existingEmails.size;

    try {
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const encryptedKey = encrypt(key);

        // Store API key in BOTH password (for encryption) and tokens (for provider to read)
        const tokens = JSON.stringify({ api_key: key });

        // Generate a unique email label that doesn't collide with existing accounts.
        // existingCount + i + 1 may collide if accounts were deleted (gaps in numbering),
        // so we keep incrementing the candidate until we find a free slot.
        let suffix = existingCount + i + 1;
        let email = `cbc-account-${suffix}`;
        while (existingEmails.has(email)) {
          suffix++;
          email = `cbc-account-${suffix}`;
        }
        existingEmails.add(email);

        const inserted = await db.insert(accounts).values({
          provider: "codebuddy-china",
          email,
          password: encryptedKey,
          status: "active",
          tokens,
          quotaLimit: -1,
          quotaRemaining: -1,
          lastLoginAt: new Date(),
        }).returning();

        if (inserted[0]) {
          created.push({ id: inserted[0].id, email });
        }
      }

      pool.invalidate("codebuddy-china" as any);
      broadcast({ type: "account_created", data: { provider: "codebuddy-china", count: created.length } });

      return c.json({
        success: true,
        count: created.length,
        accounts: created,
      }, 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[API accounts] Failed to bulk create CodeBuddy China accounts:", error);
      return c.json({ error: `Failed to create accounts: ${msg}` }, 500);
    }
  }

  // ── CodeBuddy Global: Single API key flow (ck_...) ───────────────────
  // Accept a single API key, validate format, and create one account with
  // an auto-generated email label. Host: www.workbuddy.ai.
  if (body.provider === "codebuddy" && body.apiKey) {
    const key = body.apiKey.trim();
    if (!key) return c.json({ error: "apiKey is empty" }, 400);
    if (!key.startsWith("ck_")) {
      return c.json({ error: `Invalid API key format: ${key.substring(0, 20)}... (must start with ck_)` }, 400);
    }

    const encryptedKey = encrypt(key);
    const tokens = JSON.stringify({ api_key: key });

    // Generate a unique email label that doesn't collide with existing accounts.
    const existingEmails = await db.select({ email: accounts.email }).from(accounts)
      .where(eq(accounts.provider, "codebuddy"))
      .then((rows) => new Set(rows.map((r) => r.email)));
    let suffix = 1;
    let email = `cb-account-${suffix}`;
    while (existingEmails.has(email)) {
      suffix++;
      email = `cb-account-${suffix}`;
    }

    try {
      const inserted = await db.insert(accounts).values({
        provider: "codebuddy",
        email,
        password: encryptedKey,
        status: "active",
        tokens,
        quotaLimit: -1,
        quotaRemaining: -1,
        lastLoginAt: new Date(),
      }).returning();
      const created = inserted[0]!;
      pool.invalidate("codebuddy" as any);
      broadcast({ type: "account_created", data: { id: created.id, provider: "codebuddy", email } });
      return c.json({ ...created, password: "***", tokens: "[set]" }, 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `Failed to create CodeBuddy account: ${msg}` }, 500);
    }
  }

  // ── CodeBuddy Global: Bulk API key flow (ck_...) ─────────────────────
  // Accept multiple API keys (one per line), validate format, and create
  // account per key with auto-generated email label.
  if (body.provider === "codebuddy" && body.apiKeys) {
    const keys = body.apiKeys
      .split("\n")
      .map((k: string) => k.trim())
      .filter((k: string) => k.length > 0);

    if (keys.length === 0) {
      return c.json({ error: "apiKeys is empty" }, 400);
    }

    // Validate format
    for (const key of keys) {
      if (!key.startsWith("ck_")) {
        return c.json({ error: `Invalid API key format: ${key.substring(0, 20)}... (must start with ck_)` }, 400);
      }
    }

    const created: Array<{ id: number; email: string }> = [];
    let existingEmails: Set<string>;
    try {
      existingEmails = await db.select({ email: accounts.email }).from(accounts)
        .where(eq(accounts.provider, "codebuddy"))
        .then((rows) => new Set(rows.map((r) => r.email)));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[API accounts] Failed to query existing CodeBuddy accounts:", error);
      return c.json({ error: `Failed to query existing accounts: ${msg}` }, 500);
    }
    const existingCount = existingEmails.size;

    try {
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const encryptedKey = encrypt(key);

        // Store API key in BOTH password (for encryption) and tokens (for provider to read)
        const tokens = JSON.stringify({ api_key: key });

        // Generate a unique email label that doesn't collide with existing accounts.
        let suffix = existingCount + i + 1;
        let email = `cb-account-${suffix}`;
        while (existingEmails.has(email)) {
          suffix++;
          email = `cb-account-${suffix}`;
        }
        existingEmails.add(email);

        const inserted = await db.insert(accounts).values({
          provider: "codebuddy",
          email,
          password: encryptedKey,
          status: "active",
          tokens,
          quotaLimit: -1,
          quotaRemaining: -1,
          lastLoginAt: new Date(),
        }).returning();

        if (inserted[0]) {
          created.push({ id: inserted[0].id, email });
        }
      }

      pool.invalidate("codebuddy" as any);
      broadcast({ type: "account_created", data: { provider: "codebuddy", count: created.length } });

      return c.json({
        success: true,
        count: created.length,
        accounts: created,
      }, 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[API accounts] Failed to bulk create CodeBuddy accounts:", error);
      return c.json({ error: `Failed to create accounts: ${msg}` }, 500);
    }
  }

  // ── CodeBuddy Global: import via access_token (OAuth JWT) ────────────
  // Accept an access_token (JWT) directly, decode email/sub, and upsert the
  // account. Optional uid overrides the JWT sub; optional refresh_token is
  // stored for token rotation. This is the manual path alongside the OAuth
  // device flow (POST /api/oauth/codebuddy/*).
  if (body.provider === "codebuddy" && (body.accessToken || body.access_token)) {
    const accessToken = body.accessToken || body.access_token!;
    try {
      const connection = await completeCodebuddyOAuthLogin({
        accessToken,
        refreshToken: body.refresh_token
          ?? (body.tokens && typeof body.tokens === "object"
            ? (body.tokens as Record<string, unknown>).refresh_token as string | null
            : null),
        uid: body.uid ?? null,
      });
      return c.json({ ...connection, success: true }, 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `Failed to import CodeBuddy access_token: ${msg}` }, 500);
    }
  }

  // ── CodeBuddy China: import via access_token (JWT) + uid ────────────
  // Accept an access_token (JWT from codebuddy.cn Keycloak), decode email/sub,
  // and upsert the account. Optional uid overrides the JWT sub; optional
  // refresh_token is stored for future token rotation.
  if (body.provider === "codebuddy-china" && (body.accessToken || body.access_token)) {
    const accessToken = body.accessToken || body.access_token!;
    try {
      const connection = await completeCodebuddyChinaOAuthLogin({
        accessToken,
        refreshToken: body.refresh_token
          ?? (body.tokens && typeof body.tokens === "object"
            ? (body.tokens as Record<string, unknown>).refresh_token as string | null
            : null),
        uid: body.uid ?? null,
      });
      return c.json({ ...connection, success: true }, 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `Failed to import CodeBuddy China access_token: ${msg}` }, 500);
    }
  }

  if (!body.email || !body.password) {
    return c.json(
      { error: "email and password are required" },
      400
    );
  }

  const encryptedPassword = encrypt(body.password);

  const newAccount: NewAccount = {
    provider: body.provider,
    email: body.email,
    password: encryptedPassword,
    status: body.tokens ? "active" : (body.status || "pending"),
    tokens: body.tokens || null,
  };

  try {
    const result = await db.insert(accounts).values(newAccount).returning();
    const created = result[0]!;
    pool.invalidate(created.provider as ProviderName);

    broadcast({
      type: "account_created",
      data: { id: created.id, provider: created.provider, email: created.email },
    });

    if (!body.tokens) {
      loginQueue.enqueue(created.id, { browserEngine: body.browserEngine, headless: body.headless });
    }

    return c.json(
      { ...created, password: "***", tokens: created.tokens ? "[set]" : null, loginQueued: true },
      201
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("unique") || error.message.includes("duplicate"))
    ) {
      return c.json({ error: "Account with this email already exists for this provider" }, 409);
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API accounts] Failed to create account:", error);
    return c.json({ error: `Failed to create account: ${msg}` }, 500);
  }
});

/**
 * POST /api/accounts/instant-login - Instant login via refresh token (bulk)
 * No browser needed — just exchange refresh token for access token.
 * Codex-only: tokens are OpenAI OAuth refresh tokens (start with rt_*, ~200 chars).
 */
accountsRouter.post("/instant-login", async (c) => {
  const body = await c.req.json<{ tokens: string[] }>();

  if (!body.tokens || !Array.isArray(body.tokens) || body.tokens.length === 0) {
    return c.json({ error: "tokens array is required (array of refresh token strings)" }, 400);
  }

  return await handleCodexInstantLogin(c, body.tokens);
});


/**
 * POST /api/accounts/bulk - Create multiple accounts
 */
accountsRouter.post("/bulk", async (c) => {
  const body = await c.req.json<{
    accounts: Array<{
      provider: Provider;
      email: string;
      password: string;
    }>;
  }>();

  if (!body.accounts || !Array.isArray(body.accounts)) {
    return c.json({ error: "accounts array is required" }, 400);
  }

  const results: Array<{ email: string; success: boolean; error?: string }> = [];

  for (const acc of body.accounts) {
    try {
      await db.insert(accounts).values({
        provider: acc.provider,
        email: acc.email,
        password: encrypt(acc.password),
        status: "pending",
      });
      results.push({ email: acc.email, success: true });
    } catch (error) {
      results.push({
        email: acc.email,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  pool.invalidate();
  broadcast({ type: "accounts_bulk_created", data: { count: results.filter((r) => r.success).length } });

  return c.json({
    total: body.accounts.length,
    success: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  });
});

/**
 * PATCH /api/accounts/:id - Update account
 */
accountsRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Partial<{
    status: "active" | "exhausted" | "error" | "pending";
    enabled: boolean;
    tokens: Record<string, unknown>;
    password: string;
    quotaLimit: number;
    quotaRemaining: number;
    quotaResetAt: string;
    errorMessage: string | null;
  }>>();

  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (body.status) updateData.status = body.status;
  if (typeof body.enabled === "boolean") updateData.enabled = body.enabled;
  if (body.tokens) updateData.tokens = body.tokens;
  if (body.password) {
    try {
      updateData.password = encrypt(body.password);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[API accounts] Failed to encrypt password for account ${id}:`, error);
      return c.json({ error: `Failed to encrypt password: ${msg}` }, 500);
    }
  }
  if (body.quotaLimit !== undefined) updateData.quotaLimit = body.quotaLimit;
  if (body.quotaRemaining !== undefined) updateData.quotaRemaining = body.quotaRemaining;
  if (body.quotaResetAt) updateData.quotaResetAt = new Date(body.quotaResetAt);
  if (body.errorMessage !== undefined) updateData.errorMessage = body.errorMessage;

  let result;
  try {
    result = await db
      .update(accounts)
      .set(updateData)
      .where(eq(accounts.id, id))
      .returning();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to update account ${id}:`, error);
    return c.json({ error: `Failed to update account: ${msg}` }, 500);
  }

  if (result.length === 0) {
    return c.json({ error: "Account not found" }, 404);
  }

  const updated = result[0]!;
  pool.invalidate(updated.provider as ProviderName);
  broadcast({
    type: "account_updated",
    data: { id: updated.id, status: updated.status, enabled: updated.enabled, provider: updated.provider },
  });

  return c.json({ ...updated, password: "***", tokens: updated.tokens ? "[set]" : null });
});

/**
 * POST /api/accounts/:id/toggle - Toggle account enabled flag
 */
accountsRouter.post("/:id/toggle", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }));

  let current;
  try {
    [current] = await db
      .select({ enabled: accounts.enabled })
      .from(accounts)
      .where(eq(accounts.id, id));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to fetch account ${id} for toggle:`, error);
    return c.json({ error: `Failed to fetch account: ${msg}` }, 500);
  }

  if (!current) {
    return c.json({ error: "Account not found" }, 404);
  }

  const next = typeof body.enabled === "boolean" ? body.enabled : !current.enabled;
  let updated;
  try {
    updated = await pool.setEnabled(id, next);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to toggle account ${id}:`, error);
    return c.json({ error: `Failed to toggle account: ${msg}` }, 500);
  }

  if (!updated) {
    return c.json({ error: "Account not found" }, 404);
  }

  return c.json({
    id: updated.id,
    enabled: updated.enabled,
    status: updated.status,
    provider: updated.provider,
  });
});

/**
 * POST /api/accounts/toggle-all - Bulk toggle enabled for all accounts of a provider
 * Body: { provider: string, enabled: boolean }
 */
accountsRouter.post("/toggle-all", async (c) => {
  const body = await c.req.json<{ provider: string; enabled: boolean }>();

  if (!body.provider) {
    return c.json({ error: "provider is required" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled (boolean) is required" }, 400);
  }

  try {
    const count = await pool.setEnabledByProvider(body.provider as ProviderName, body.enabled);
    return c.json({ provider: body.provider, enabled: body.enabled, count });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to toggle all accounts for provider ${body.provider}:`, error);
    return c.json({ error: `Failed to toggle accounts: ${msg}` }, 500);
  }
});

/**
 * POST /api/accounts/bulk-delete - Delete multiple accounts at once.
 *
 * Works for every provider (the row shape is identical). Defined BEFORE the
 * dynamic `/:id` route so Hono matches the literal path first.
 *
 * Body: { ids: number[] }
 * Returns: { success, requested, deleted, providers, notFound }
 */
accountsRouter.post("/bulk-delete", async (c) => {
  const body = await c.req.json<{ ids?: Array<number | string> }>().catch(() => ({} as { ids?: Array<number | string> }));

  // Coerce + dedupe + drop anything non-numeric so a malformed entry can't
  // widen the delete (e.g. NaN turning into "delete everything").
  const ids = Array.from(
    new Set(
      (body.ids ?? [])
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  );

  if (ids.length === 0) {
    return c.json({ error: "ids must be a non-empty array of account ids" }, 400);
  }

  // Resolve providers up front so we can invalidate exactly the affected pools.
  let targets;
  try {
    targets = await db
      .select({ id: accounts.id, provider: accounts.provider })
      .from(accounts)
      .where(inArray(accounts.id, ids));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API accounts] Failed to resolve accounts for bulk delete:", error);
    return c.json({ error: `Failed to resolve accounts: ${msg}` }, 500);
  }

  if (targets.length === 0) {
    return c.json({ error: "No matching accounts found" }, 404);
  }

  const foundIds = targets.map((t) => t.id);
  const providersAffected = Array.from(new Set(targets.map((t) => t.provider)));

  try {
    // Nullify / clean foreign keys before the delete (mirrors DELETE /:id).
    await db.update(requestLogs).set({ accountId: null }).where(inArray(requestLogs.accountId, foundIds));
    await db.update(vccCards).set({ usedByAccountId: null }).where(inArray(vccCards.usedByAccountId, foundIds));
    await db.delete(vccTransactions).where(inArray(vccTransactions.accountId, foundIds));

    const result = await db.delete(accounts).where(inArray(accounts.id, foundIds)).returning();
    const deletedIds = result.map((r) => r.id);

    for (const provider of providersAffected) {
      pool.invalidate(provider as ProviderName);
    }
    // Mirror single-delete's broadcast shape per id so existing dashboard
    // listeners (`account_deleted`) keep working without changes, then send
    // one summary frame for clients that prefer the bulk signal.
    for (const id of deletedIds) {
      broadcast({ type: "account_deleted", data: { id } });
    }
    broadcast({ type: "accounts_deleted", data: { ids: deletedIds, providers: providersAffected } });

    const notFound = ids.filter((id) => !foundIds.includes(id));
    return c.json({
      success: true,
      requested: ids.length,
      deleted: deletedIds.length,
      deletedIds,
      providers: providersAffected,
      notFound,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API accounts] Failed to bulk delete accounts:", error);
    return c.json({ error: `Failed to delete accounts: ${msg}` }, 500);
  }
});

/**
 * DELETE /api/accounts/:id - Delete account
 */
accountsRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));

  try {
    // Nullify foreign key references before deleting
    await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, id));
    await db.update(vccCards).set({ usedByAccountId: null }).where(eq(vccCards.usedByAccountId, id));
    await db.delete(vccTransactions).where(eq(vccTransactions.accountId, id));

    const result = await db
      .delete(accounts)
      .where(eq(accounts.id, id))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Account not found" }, 404);
    }

    const deleted = result[0]!;
    pool.invalidate(deleted.provider as ProviderName);
    broadcast({ type: "account_deleted", data: { id } });

    return c.json({ success: true, deleted: id });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to delete account ${id}:`, error);
    return c.json({ error: `Failed to delete account: ${msg}` }, 500);
  }
});

/**
 * POST /api/accounts/:id/login - Trigger login for account
 */
accountsRouter.post("/:id/login", async (c) => {
  const id = Number(c.req.param("id"));
  let account;
  try {
    [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to fetch account ${id} for login:`, error);
    return c.json({ error: `Failed to fetch account: ${msg}` }, 500);
  }

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  try {
    // Import auth runner dynamically to avoid circular deps
    const { loginAccount } = await import("../auth/runner");
    const result = await loginAccount(account);
    return c.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Login failed for account ${id}:`, error);
    return c.json({ error: `Login failed: ${msg}` }, 500);
  }
});

/**
 * POST /api/accounts/:id/refresh-quota - Refresh quota for account
 */
accountsRouter.post("/:id/refresh-quota", async (c) => {
  const id = Number(c.req.param("id"));
  let account;
  try {
    [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to fetch account ${id} for quota refresh:`, error);
    return c.json({ error: `Failed to fetch account: ${msg}` }, 500);
  }

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  try {
    const result = await warmupAccount(account);
    if (!result.success && !result.retryable && result.kind !== "unsupported") {
      return c.json(result, 500);
    }
    return c.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Quota refresh failed for account ${id}:`, error);
    return c.json({ error: `Quota refresh failed: ${msg}` }, 500);
  }
});

/**
 * POST /api/accounts/:id/warmup - Queue non-login WarmUp for account
 */
accountsRouter.post("/:id/warmup", async (c) => {
  const id = Number(c.req.param("id"));
  let account;
  try {
    [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API accounts] Failed to fetch account ${id} for warmup:`, error);
    return c.json({ error: `Failed to fetch account: ${msg}` }, 500);
  }

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  warmupQueue.enqueue(id);
  return c.json({ message: "WarmUp queued", accountId: id });
});

const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_SCOPE = "openid profile email offline_access";

export function decodeJwtPayload(token: string): Record<string, any> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const padded = parts[1]! + "=".repeat((4 - parts[1]!.length % 4) % 4);
    const json = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch (err) {
    console.warn("[Codex] Failed to decode JWT payload:", err);
    return {};
  }
}

async function upsertCodexAccount(email: string, tokens: Record<string, unknown>) {
  const existing = await db.select().from(accounts)
    .where(eq(accounts.email, email))
    .then((rows) => rows.find((r) => r.provider === "codex"));

  if (existing) {
    await db.update(accounts).set({
      status: "active",
      tokens: tokens as unknown,
      errorMessage: null,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(accounts.id, existing.id));
    return existing.id;
  }

  const inserted = await db.insert(accounts).values({
    provider: "codex",
    email,
    password: encrypt("instant-login"),
    status: "active",
    tokens: tokens as unknown,
    lastLoginAt: new Date(),
  }).returning();

  return inserted[0]!.id;
}

export async function importCodexAccessToken(accessToken: string, name?: string) {
  const token = accessToken.trim();
  if (!token) {
    throw new Error("Access token is required");
  }

  const claims = decodeJwtPayload(token);
  const authClaim = claims["https://api.openai.com/auth"];
  const profileClaim = claims["https://api.openai.com/profile"];

  let email = String(profileClaim?.email || claims.email || claims.preferred_username || "");
  let accountId = String(
    authClaim?.chatgpt_account_id || authClaim?.account_id || authClaim?.user_id || claims.chatgpt_account_id || claims.account_id || ""
  );
  const planType = String(authClaim?.chatgpt_plan_type || claims.plan_type || "");
  const jwtExp = claims.exp ? Number(claims.exp) : null;

  if (!email || !accountId) {
    try {
      const usageResp = await fetch(CODEX_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "codex_cli_rs/0.1.0",
        },
      });
      if (usageResp.ok) {
        const usage = await usageResp.json() as any;
        if (!email) email = String(usage.email || "");
        if (!accountId) accountId = String(usage.account_id || usage.chatgpt_account_id || "");
      }
    } catch (err) {
      console.warn("[Codex] Failed to fetch usage info for token import:", err);
    }
  }

  if (!email) {
    email = name?.trim() || `codex-${token.slice(-8)}@token.local`;
  }

  const newTokens = {
    access_token: token,
    refresh_token: "",
    id_token: "",
    expires_at: jwtExp ? String(jwtExp) : "",
    email,
    account_id: accountId,
    method: "access_token",
    plan_type: planType,
  };

  const id = await upsertCodexAccount(email, newTokens);
  pool.invalidate("codex" as ProviderName);
  broadcast({ type: "accounts_updated", data: { provider: "codex", count: 1 } });

  return {
    id,
    provider: "codex",
    email,
    name: name?.trim() || email,
    workspace: accountId || null,
    plan: planType || null,
  };
}

export async function exchangeCodexAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: input.codeVerifier,
  });

  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Codex token exchange failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const data = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error("Codex token exchange returned no access_token");
  }

  const claims = data.id_token ? decodeJwtPayload(data.id_token) : {};
  let email = String(claims.email || "");
  let accountId = "";
  const authClaim = claims["https://api.openai.com/auth"];
  const profileClaim = claims["https://api.openai.com/profile"];
  const planType = String(authClaim?.chatgpt_plan_type || claims.plan_type || "");

  if (profileClaim && typeof profileClaim === "object") {
    email = String(profileClaim.email || email || "");
  }

  if (authClaim && typeof authClaim === "object") {
    accountId = String(
      authClaim.chatgpt_account_id || authClaim.account_id || authClaim.user_id || ""
    );
  }
  if (!accountId) {
    accountId = String(claims.chatgpt_account_id || claims.account_id || "");
  }

  if (!email || !accountId) {
    try {
      const usageResp = await fetch(CODEX_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${data.access_token}`,
          "User-Agent": "codex_cli_rs/0.1.0",
        },
      });
      if (usageResp.ok) {
        const usage = await usageResp.json() as any;
        if (!email) email = String(usage.email || "");
        if (!accountId) accountId = String(usage.account_id || usage.chatgpt_account_id || "");
      }
    } catch (err) {
      console.warn("[Codex] Failed to fetch usage info for OAuth exchange:", err);
    }
  }

  if (!email) {
    email = `codex-${input.code.slice(-8)}@oauth.local`;
  }

  const expiresIn = Number(data.expires_in) || 3600;
  const expiresAt = String(Math.floor(Date.now() / 1000) + expiresIn);
  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || "",
    id_token: data.id_token || "",
    expires_at: expiresAt,
    email,
    account_id: accountId,
    method: "authorization_code",
    plan_type: planType,
  };

  const id = await upsertCodexAccount(email, newTokens);
  pool.invalidate("codex" as ProviderName);
  broadcast({ type: "accounts_updated", data: { provider: "codex", count: 1 } });

  return {
    id,
    provider: "codex",
    email,
    name: email,
    workspace: accountId || null,
    plan: planType || null,
  };
}

export async function exchangeCodexRefreshTokens(tokens: string[]) {
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const refreshToken of tokens) {
    const trimmed = refreshToken.trim();
    if (!trimmed) { failed++; continue; }

    try {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: trimmed,
        client_id: CODEX_CLIENT_ID,
        scope: CODEX_SCOPE,
      });

      const response = await fetch(CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        errors.push(`token ...${trimmed.slice(-8)}: refresh failed (${response.status}): ${text.slice(0, 100)}`);
        failed++;
        continue;
      }

      const data = await response.json() as {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        expires_in?: number;
      };

      if (!data.access_token) {
        errors.push(`token ...${trimmed.slice(-8)}: no access_token in response`);
        failed++;
        continue;
      }

      const claims = data.id_token ? decodeJwtPayload(data.id_token) : {};
      let email = String(claims.email || "");
      let accountId = "";
      const authClaim = claims["https://api.openai.com/auth"];
      if (authClaim && typeof authClaim === "object") {
        accountId = String(
          authClaim.chatgpt_account_id || authClaim.account_id || authClaim.user_id || ""
        );
      }
      if (!accountId) {
        accountId = String(claims.chatgpt_account_id || claims.account_id || "");
      }

      if (!email || !accountId) {
        try {
          const usageResp = await fetch(CODEX_USAGE_URL, {
            headers: {
              "Authorization": `Bearer ${data.access_token}`,
              "User-Agent": "codex_cli_rs/0.1.0",
            },
          });
          if (usageResp.ok) {
            const usage = await usageResp.json() as any;
            if (!email) email = usage.email || "";
            if (!accountId) {
              accountId = String(usage.account_id || usage.chatgpt_account_id || "");
            }
          }
        } catch (err) {
          console.warn("[Codex] Failed to fetch usage info for bulk token import:", err);
        }
      }

      if (!email) email = `codex-${trimmed.slice(-8)}@token.local`;

      const expiresIn = Number(data.expires_in) || 3600;
      const expiresAt = String(Math.floor(Date.now() / 1000) + expiresIn);

      const newTokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || trimmed,
        id_token: data.id_token || "",
        expires_at: expiresAt,
        email,
        account_id: accountId,
        method: "refresh_token",
      };

      await upsertCodexAccount(email, newTokens);
      success++;
    } catch (err) {
      errors.push(`token ...${trimmed.slice(-8)}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  pool.invalidate("codex" as ProviderName);
  if (success > 0) {
    broadcast({ type: "accounts_updated", data: { provider: "codex", count: success } });
  }

  return { success, failed, errors: errors.length > 0 ? errors : undefined };
}

async function handleCodexInstantLogin(c: any, tokens: string[]) {
  const result = await exchangeCodexRefreshTokens(tokens);
  return c.json(result);
}

async function upsertGrokCliAccount(
  email: string,
  tokens: Record<string, unknown>,
  password?: string,
) {
  const encryptedPassword = encrypt(password || "oauth-device");
  const now = new Date();
  const setFields = {
    status: "active",
    tokens: tokens as unknown,
    password: encryptedPassword,
    errorMessage: null,
    lastLoginAt: now,
    updatedAt: now,
    quotaLimit: -1,
    quotaRemaining: -1,
  };

  // Atomic upsert on (provider, email) unique index.
  // ON CONFLICT DO UPDATE keeps idempotent re-imports safe under concurrency.
  try {
    const inserted = await db.insert(accounts).values({
      provider: "grok-cli",
      email,
      password: encryptedPassword,
      status: "active",
      tokens: tokens as unknown,
      lastLoginAt: now,
      quotaLimit: -1,
      quotaRemaining: -1,
    })
      .onConflictDoUpdate({
        target: [accounts.provider, accounts.email],
        set: setFields,
      })
      .returning();
    return inserted[0]!.id;
  } catch (err) {
    // Fallback path if drizzle onConflictDoUpdate is not supported by the
    // active sqlite driver / build — mirrors the original select-then-upsert.
    const existing = await db.select().from(accounts)
      .where(eq(accounts.email, email))
      .then((rows) => rows.find((r) => r.provider === "grok-cli"));

    if (existing) {
      await db.update(accounts).set(setFields).where(eq(accounts.id, existing.id));
      return existing.id;
    }
    throw err;
  }
}

/** Complete Grok CLI device-code OAuth and upsert account. */
export async function completeGrokCliDeviceLogin(input: {
  accessToken: string;
  refreshToken?: string | null;
  idToken?: string | null;
  expiresIn?: number | null;
  scope?: string | null;
  user?: any;
}) {
  const claims = decodeJwtPayload(input.idToken || input.accessToken);
  const emailFromJwt =
    String(claims.email || claims.preferred_username || claims.upn || "").trim() || null;
  const emailFromUser =
    String(input.user?.email || input.user?.userEmail || "").trim() || null;
  const userId =
    input.user?.userId ||
    input.user?.principalId ||
    claims.sub ||
    null;
  const displayName =
    [input.user?.firstName, input.user?.lastName].filter(Boolean).join(" ").trim() ||
    String(input.user?.name || claims.name || "").trim() ||
    null;

  const email =
    emailFromUser ||
    emailFromJwt ||
    (userId ? `grok-cli-${String(userId).slice(0, 12)}@token.local` : `grok-cli-${input.accessToken.slice(-8)}@token.local`);

  const expiresIn = Number(input.expiresIn) || 3600;
  const expiresAt = String(Math.floor(Date.now() / 1000) + expiresIn);

  const tokens = {
    access_token: input.accessToken,
    refresh_token: input.refreshToken || "",
    id_token: input.idToken || "",
    expires_at: expiresAt,
    email,
    user_id: userId ? String(userId) : null,
    method: "device_code",
    subscription_tier: input.user?.subscriptionTier ?? null,
    has_grok_code_access: input.user?.hasGrokCodeAccess ?? null,
  };

  const id = await upsertGrokCliAccount(email, tokens);
  pool.invalidate("grok-cli" as ProviderName);
  broadcast({ type: "accounts_updated", data: { provider: "grok-cli", count: 1 } });

  return {
    id,
    provider: "grok-cli",
    email,
    name: displayName || email,
  };
}

async function upsertCodebuddyAccount(
  email: string,
  tokens: Record<string, unknown>,
  password?: string,
) {
  const encryptedPassword = encrypt(password || "oauth-device");
  const now = new Date();
  const setFields = {
    status: "active",
    tokens: tokens as unknown,
    password: encryptedPassword,
    errorMessage: null,
    lastLoginAt: now,
    updatedAt: now,
    quotaLimit: -1,
    quotaRemaining: -1,
  };

  // Atomic upsert on (provider, email) unique index — idempotent re-login.
  try {
    const inserted = await db.insert(accounts).values({
      provider: "codebuddy",
      email,
      password: encryptedPassword,
      status: "active",
      tokens: tokens as unknown,
      lastLoginAt: now,
      quotaLimit: -1,
      quotaRemaining: -1,
    })
      .onConflictDoUpdate({
        target: [accounts.provider, accounts.email],
        set: setFields,
      })
      .returning();
    return inserted[0]!.id;
  } catch (err) {
    // Fallback: select-then-upsert if the driver lacks onConflictDoUpdate.
    const existing = await db.select().from(accounts)
      .where(eq(accounts.email, email))
      .then((rows) => rows.find((r) => r.provider === "codebuddy"));

    if (existing) {
      await db.update(accounts).set(setFields).where(eq(accounts.id, existing.id));
      return existing.id;
    }
    throw err;
  }
}

/** Complete CodeBuddy global OAuth device flow and upsert account (access_token). */
export async function completeCodebuddyOAuthLogin(input: {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
  uid?: string | null;
}) {
  const claims = decodeJwtPayload(input.accessToken);
  const email = String(claims.email || "").trim() || null;
  // Prefer the response's uid, fall back to the JWT sub claim.
  const sub = String(input.uid || claims.sub || "").trim() || null;

  const label =
    email ||
    (sub ? `cb-${sub.slice(0, 12)}@token.local` : `cb-${input.accessToken.slice(-8)}@token.local`);

  // Derive expiry from the JWT `exp` claim when present (authoritative), else
  // fall back to the response's expiresIn, else a 24h default.
  const jwtExp = claims.exp ? Number(claims.exp) : null;
  const expiresIn = Number(input.expiresIn) || 86400;
  const expiresAt = String(
    (Number.isFinite(jwtExp) && jwtExp && jwtExp > 0 ? jwtExp : Math.floor(Date.now() / 1000) + expiresIn),
  );

  const tokens = {
    access_token: input.accessToken,
    refresh_token: input.refreshToken || "",
    expires_at: expiresAt,
    email: label,
    user_id: sub,
    method: "oauth_device_code",
  };

  const id = await upsertCodebuddyAccount(label, tokens);
  pool.invalidate("codebuddy" as ProviderName);
  broadcast({ type: "accounts_updated", data: { provider: "codebuddy", count: 1 } });

  return {
    id,
    provider: "codebuddy",
    email: label,
    name: label,
  };
}

async function upsertCodebuddyChinaAccount(
  email: string,
  tokens: Record<string, unknown>,
  password?: string,
) {
  const encryptedPassword = encrypt(password || "oauth-access-token");
  const now = new Date();
  const setFields = {
    status: "active",
    tokens: tokens as unknown,
    password: encryptedPassword,
    errorMessage: null,
    lastLoginAt: now,
    updatedAt: now,
    quotaLimit: -1,
    quotaRemaining: -1,
  };

  try {
    const inserted = await db.insert(accounts).values({
      provider: "codebuddy-china",
      email,
      password: encryptedPassword,
      status: "active",
      tokens: tokens as unknown,
      lastLoginAt: now,
      quotaLimit: -1,
      quotaRemaining: -1,
    })
      .onConflictDoUpdate({
        target: [accounts.provider, accounts.email],
        set: setFields,
      })
      .returning();
    return inserted[0]!.id;
  } catch (err) {
    const existing = await db.select().from(accounts)
      .where(eq(accounts.email, email))
      .then((rows) => rows.find((r) => r.provider === "codebuddy-china"));

    if (existing) {
      await db.update(accounts).set(setFields).where(eq(accounts.id, existing.id));
      return existing.id;
    }
    throw err;
  }
}

/** Import CodeBuddy China account from an access_token (Keycloak JWT) + uid. */
export async function completeCodebuddyChinaOAuthLogin(input: {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
  uid?: string | null;
}) {
  const claims = decodeJwtPayload(input.accessToken);
  const email = String(claims.email || "").trim() || null;
  // Prefer the response's uid, fall back to the JWT sub claim.
  const sub = String(input.uid || claims.sub || "").trim() || null;

  const label =
    email ||
    (sub ? `cbc-${sub.slice(0, 12)}@token.local` : `cbc-${input.accessToken.slice(-8)}@token.local`);

  // Derive expiry from the JWT `exp` claim when present (authoritative), else
  // fall back to the response's expiresIn, else a 24h default.
  const jwtExp = claims.exp ? Number(claims.exp) : null;
  const expiresIn = Number(input.expiresIn) || 86400;
  const expiresAt = String(
    (Number.isFinite(jwtExp) && jwtExp && jwtExp > 0 ? jwtExp : Math.floor(Date.now() / 1000) + expiresIn),
  );

  const tokens = {
    access_token: input.accessToken,
    refresh_token: input.refreshToken || "",
    expires_at: expiresAt,
    email: label,
    user_id: sub,
    method: "manual_access_token",
  };

  const id = await upsertCodebuddyChinaAccount(label, tokens);
  pool.invalidate("codebuddy-china" as ProviderName);
  broadcast({ type: "accounts_updated", data: { provider: "codebuddy-china", count: 1 } });

  return {
    id,
    provider: "codebuddy-china",
    email: label,
    name: label,
  };
}

async function upsertClaudeAccount(email: string, tokens: ClaudeTokens) {
  const existing = await db.select().from(accounts)
    .where(eq(accounts.email, email))
    .then((rows) => rows.find((r) => r.provider === "claude"));

  if (existing) {
    await db.update(accounts).set({
      status: "active",
      tokens: tokens as unknown,
      errorMessage: null,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        ...(typeof existing.metadata === "object" && existing.metadata ? existing.metadata as object : {}),
        subscription_type: tokens.subscription_type || null,
        account_id: tokens.account_id || null,
      },
    }).where(eq(accounts.id, existing.id));
    return existing.id;
  }

  const inserted = await db.insert(accounts).values({
    provider: "claude",
    email,
    password: encrypt("oauth-pkce"),
    status: "active",
    tokens: tokens as unknown,
    lastLoginAt: new Date(),
    metadata: {
      subscription_type: tokens.subscription_type || null,
      account_id: tokens.account_id || null,
    },
  }).returning();

  return inserted[0]!.id;
}

export async function completeClaudeOAuthLogin(input: {
  code: string;
  codeVerifier: string;
  state?: string;
}) {
  const tokens = await exchangeClaudeAuthorizationCode({
    code: input.code,
    codeVerifier: input.codeVerifier,
    state: input.state,
  });

  const profile = await fetchClaudeProfile(tokens.access_token);
  const email =
    tokens.email ||
    profile.email ||
    (tokens.account_id ? `claude-${String(tokens.account_id).slice(0, 12)}@oauth.local` : `claude-${tokens.access_token.slice(-8)}@oauth.local`);

  const merged: ClaudeTokens = {
    ...tokens,
    email,
    account_id: tokens.account_id || profile.accountId,
    subscription_type: tokens.subscription_type || profile.subscriptionType,
    method: "oauth_pkce",
  };

  const id = await upsertClaudeAccount(email, merged);
  pool.invalidate("claude" as ProviderName);
  broadcast({ type: "accounts_updated", data: { provider: "claude", count: 1 } });
  broadcast({ type: "account_created", data: { id, provider: "claude", email } });

  return {
    id,
    provider: "claude",
    email,
    name: profile.displayName || email,
    plan: merged.subscription_type || null,
  };
}

/**
 * POST /api/accounts/grok-cli/import - Import a farmed Grok CLI account.
 *
 * Used by the grok farmer (farm.py) to push freshly farmed accounts directly
 * into the pool. Idempotent on (provider, email): re-imports update tokens and
 * password instead of failing with 409.
 *
 * Body:
 *   {
 *     "email": "user@domain",                  // required
 *     "password": "account-password",          // optional, stored encrypted
 *     "tokens": {                              // required, must be object
 *       "access_token": "...",                 // required
 *       "refresh_token": "...",                // required
 *       "id_token": "...",                     // optional
 *       "expires_at": "2026-07-23T...Z",       // optional, ISO 8601
 *       "expires_in": 21600,                   // optional, seconds
 *       "email": "user@domain",                // optional
 *       "client_id": "...",                    // optional
 *       "auth_mode": "oidc",                   // optional
 *       "scope": "..."                         // optional
 *     }
 *   }
 */
accountsRouter.post("/grok-cli/import", async (c) => {
  let body: {
    email?: string;
    password?: string;
    tokens?: Record<string, unknown>;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return c.json({ error: "email is required and must be valid" }, 400);
  }

  const tokens = body.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return c.json({ error: "tokens must be an object" }, 400);
  }

  const accessToken = String(tokens.access_token || "").trim();
  const refreshToken = String(tokens.refresh_token || "").trim();
  if (!accessToken || !refreshToken) {
    return c.json(
      { error: "tokens.access_token and tokens.refresh_token are required" },
      400,
    );
  }

  const normalizedTokens: Record<string, unknown> = { ...tokens };
  // Normalize expires_at to a unix-seconds string to match the existing
  // grok-cli token shape used by completeGrokCliDeviceLogin.
  if (typeof normalizedTokens.expires_at === "string") {
    const iso = normalizedTokens.expires_at;
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) {
      normalizedTokens.expires_at = String(Math.floor(parsed / 1000));
    }
  }

  try {
    const id = await upsertGrokCliAccount(email, normalizedTokens, body.password);
    pool.invalidate("grok-cli" as ProviderName);
    broadcast({ type: "accounts_updated", data: { provider: "grok-cli", count: 1 } });
    return c.json(
      { id, provider: "grok-cli", email, status: "active", updated: true },
      200,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[API accounts] Failed to import grok-cli account:", error);
    return c.json({ error: `Failed to import account: ${msg}` }, 500);
  }
});


// ============================================================================
// Antigravity (Google Cloud Code Assist) Account Import Functions
// ============================================================================

export async function completeAntigravityOAuthLogin(code: string, redirectUri: string, _state?: string): Promise<{
  id: number;
  provider: "antigravity";
  email: string;
  name?: string;
  projectId: string;
}> {
  // 9router pattern: public installed-app client, no PKCE, no env config.
  const tokenResponse = await fetch(ANTIGRAVITY_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: ANTIGRAVITY_OAUTH.clientId,
      client_secret: ANTIGRAVITY_OAUTH.clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${text}`);
  }

  const tokens = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!tokens.access_token) {
    throw new Error("No access_token in OAuth response");
  }

  const userinfoResponse = await fetch(`${ANTIGRAVITY_OAUTH.userinfoUrl}?alt=json`, {
    headers: { "Authorization": `Bearer ${tokens.access_token}` },
  });
  const userInfo = userinfoResponse.ok
    ? ((await userinfoResponse.json()) as { id?: string; email?: string; name?: string })
    : {};
  const email = (userInfo.email || `antigravity-${code.slice(-8)}@oauth.local`).toLowerCase();

  console.log(`[Antigravity OAuth] token ok, provisioning project for ${email}...`);
  let projectId: string;
  try {
    projectId = await discoverOrProvisionProject(tokens.access_token);
  } catch (err) {
    console.error(`[Antigravity OAuth] provisioning FAILED:`, err instanceof Error ? err.message : String(err));
    throw err;
  }
  console.log(`[Antigravity OAuth] provisioned projectId=${projectId}`);

  const credential = {
    accessToken: tokens.access_token,
    projectId,
    email,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined,
    scope: tokens.scope,
  };

  const id = await upsertAntigravityAccount(email, credential);
  pool.invalidate("antigravity" as ProviderName);
  broadcast({ type: "accounts_updated", data: { provider: "antigravity", count: 1 } });
  broadcast({ type: "account_created", data: { id, provider: "antigravity", email } });

  return { id, provider: "antigravity", email, name: userInfo.name || email, projectId };
}

async function upsertAntigravityAccount(email: string, tokens: unknown): Promise<number> {
  const existing = await db
    .select()
    .from(accounts)
    .where(eq(accounts.email, email))
    .then((rows) => rows.find((r) => r.provider === "antigravity"));

  if (existing) {
    await db
      .update(accounts)
      .set({
        status: "active",
        tokens: tokens as unknown,
        errorMessage: null,
        lastLoginAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, existing.id));
    return existing.id;
  }

  const inserted = await db
    .insert(accounts)
    .values({
      provider: "antigravity",
      email,
      password: encrypt("oauth-google"),
      status: "active",
      tokens: tokens as unknown,
      lastLoginAt: new Date(),
    })
    .returning();

  return inserted[0]!.id;
}

/**
 * POST /api/accounts/antigravity/import - Import Antigravity account via API
 */
accountsRouter.post("/antigravity/import", async (c) => {
  let body: {
    email?: string;
    tokens?: Record<string, unknown>;
    displayName?: string;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return c.json({ error: "email is required and must be valid" }, 400);
  }

  if (!body.tokens || typeof body.tokens !== "object") {
    return c.json({ error: "tokens object is required" }, 400);
  }

  const tokens = body.tokens as Record<string, unknown>;
  
  if (!tokens.accessToken || typeof tokens.accessToken !== "string") {
    return c.json({ error: "tokens.accessToken is required" }, 400);
  }

  if (!tokens.projectId || typeof tokens.projectId !== "string") {
    return c.json({ error: "tokens.projectId is required" }, 400);
  }

  // Ensure email matches token metadata if available
  if (typeof tokens.email === "string") {
    if (tokens.email.toLowerCase() !== email) {
      return c.json({ 
        error: "Email mismatch between request and tokens",
        request_email: email,
        token_email: tokens.email
      }, 400);
    }
  } else {
    tokens.email = email;
  }

  const id = await upsertAntigravityAccount(email, tokens);
  pool.invalidate("antigravity" as ProviderName);
  broadcast({ type: "accounts_updated", data: { provider: "antigravity", count: 1 } });
  broadcast({ type: "account_created", data: { id, provider: "antigravity", email } });

  return c.json({
    success: true,
    id,
    provider: "antigravity",
    email,
    name: body.displayName || email,
    projectId: tokens.projectId,
  });
});
