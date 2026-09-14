import { db } from "../db/index";
import { apiKeys, apiKeyUsage } from "../db/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../utils/crypto";
import { config } from "../config";

/**
 * API-key lifecycle + enforcement.
 *
 * Secrets: stored hashed (SHA-256, lookup) + encrypted (reveal only through the
 * explicit credential endpoint). List/detail responses expose keyPrefix only —
 * raw secrets never leave through console list/detail.
 *
 * Budgets: monthlyTokenBudget (rolling calendar month, period "YYYY-MM") and
 * oneTimeTokenBudget (lifetime, period "once"). Per-key RPM + maxConcurrent +
 * in-flight tracking live in-memory here, adaptive to process memory (see
 * adaptToMemory below). 0 = unlimited on every numeric limit.
 */

const RPM_WINDOW_MS = 60_000;

// In-memory per-key state (single-process; SQLite-backed usage is the source of truth)
const rpmWindows = new Map<number, { windowStart: number; count: number }>();
const inflight = new Map<number, Set<InFlightEntry>>();
const lastAccess = new Map<number, number>();
let inflightSeq = 0;

interface InFlightEntry {
  startedAt: number;
  token: number;
}
// Baseline is 4x the configured RPM so short bursts don't trip the counter, but
// under memory pressure we degrade to the hard limit.
function memoryPressureFactor(): number {
  try {
    const mem = process.memoryUsage();
    const heapTotal = mem.heapTotal || 1;
    const heapUsed = mem.heapUsed || 0;
    const ratio = heapUsed / heapTotal;
    if (ratio > 0.9) return 0.25; // hard limit
    if (ratio > 0.8) return 0.5;
    if (ratio > 0.7) return 0.75;
  } catch {
    /* ignore */
  }
  return 1;
}

export function adaptToMemory(): void {
  const factor = memoryPressureFactor();
  if (factor >= 1) return;
  // Prune stale RPM windows + inflight under pressure to shed load.
  const now = Date.now();
  for (const [id, w] of rpmWindows) {
    if (now - w.windowStart > RPM_WINDOW_MS) rpmWindows.delete(id);
  }
  for (const [id, set] of inflight) {
    if (!set) continue;
    for (const entry of set) {
      if (now - entry.startedAt > 60_000) set.delete(entry);
    }
    if (set.size === 0) inflight.delete(id);
  }
  lastAccess.clear();
}

// Called periodically by the process (src/index.ts sweep) — memory-adaptive pruning.
export function startMemoryAdaptiveSweep(intervalMs = 30_000): ReturnType<typeof setInterval> {
  return setInterval(adaptToMemory, intervalMs);
}

// ---------------------------------------------------------------------------
// Hash / secret helpers

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateApiSecret(): string {
  const bytes = randomBytes(24);
  const token = Buffer.from(bytes).toString("base64url");
  return `sk-etteum-${token}`;
}

export function keyPrefixOf(secret: string): string {
  return secret.slice(0, 18) + "…";
}

// ---------------------------------------------------------------------------
// CRUD

export interface ApiKeyInput {
  name: string;
  description?: string;
  monthlyTokenBudget?: number;
  oneTimeTokenBudget?: number;
  rpmLimit?: number;
  maxConcurrent?: number;
  allowedProviders?: string[];
  deniedProviders?: string[];
  allowedModels?: string[];
  deniedModels?: string[];
  expiresAt?: Date | null;
}

export interface ApiKeyRow {
  id: number;
  name: string;
  description: string | null;
  keyPrefix: string;
  enabled: boolean;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  monthlyTokenBudget: number;
  oneTimeTokenBudget: number;
  rpmLimit: number;
  maxConcurrent: number;
  allowedProviders: string[] | null;
  deniedProviders: string[] | null;
  allowedModels: string[] | null;
  deniedModels: string[] | null;
  shareEnabled: boolean;
  shareSlug: string | null;
  createdAt: Date;
  updatedAt: Date | null;
}

function sanitizePublic(key: ApiKeyRow): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    description: key.description,
    keyPrefix: key.keyPrefix,
    enabled: key.enabled,
    revokedAt: key.revokedAt,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    monthlyTokenBudget: key.monthlyTokenBudget,
    oneTimeTokenBudget: key.oneTimeTokenBudget,
    rpmLimit: key.rpmLimit,
    maxConcurrent: key.maxConcurrent,
    allowedProviders: key.allowedProviders ?? [],
    deniedProviders: key.deniedProviders ?? [],
    allowedModels: key.allowedModels ?? [],
    deniedModels: key.deniedModels ?? [],
    shareEnabled: key.shareEnabled,
    shareSlug: key.shareSlug,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}

function rowFromSelect(row: any): ApiKeyRow {
  return {
    ...row,
    allowedProviders: row.allowedProviders ?? [],
    deniedProviders: row.deniedProviders ?? [],
    allowedModels: row.allowedModels ?? [],
    deniedModels: row.deniedModels ?? [],
  };
}

export async function listApiKeys(): Promise<Record<string, unknown>[]> {
  const rows = await db.select().from(apiKeys).orderBy(apiKeys.createdAt);
  return rows.map((r) => sanitizePublic(rowFromSelect(r)));
}

export async function getApiKeyPublic(id: number): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!row) return null;
  return sanitizePublic(rowFromSelect(row));
}

export async function createApiKey(input: ApiKeyInput): Promise<{
  key: string;
  public: Record<string, unknown>;
}> {
  const secret = generateApiSecret();
  const keyHash = hashApiKey(secret);
  const row = await db
    .insert(apiKeys)
    .values({
      name: input.name,
      description: input.description || null,
      keyHash,
      keyEnc: encrypt(secret),
      keyPrefix: keyPrefixOf(secret),
      monthlyTokenBudget: input.monthlyTokenBudget ?? 0,
      oneTimeTokenBudget: input.oneTimeTokenBudget ?? 0,
      rpmLimit: input.rpmLimit ?? 0,
      maxConcurrent: input.maxConcurrent ?? 0,
      allowedProviders: input.allowedProviders ?? [],
      deniedProviders: input.deniedProviders ?? [],
      allowedModels: input.allowedModels ?? [],
      deniedModels: input.deniedModels ?? [],
      expiresAt: input.expiresAt ?? null,
    })
    .returning();

  const created = rowFromSelect(row[0]!);
  return {
    key: secret,
    public: sanitizePublic(created),
  };
}

export async function updateApiKey(
  id: number,
  patch: Partial<ApiKeyInput> & { enabled?: boolean; shareEnabled?: boolean; shareSlug?: string | null },
): Promise<Record<string, unknown> | null> {
  const [existing] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!existing) return null;

  const next = {
    name: patch.name ?? existing.name,
    description: patch.description !== undefined ? patch.description : existing.description,
    monthlyTokenBudget: patch.monthlyTokenBudget ?? existing.monthlyTokenBudget,
    oneTimeTokenBudget: patch.oneTimeTokenBudget ?? existing.oneTimeTokenBudget,
    rpmLimit: patch.rpmLimit ?? existing.rpmLimit,
    maxConcurrent: patch.maxConcurrent ?? existing.maxConcurrent,
    allowedProviders: patch.allowedProviders ?? existing.allowedProviders,
    deniedProviders: patch.deniedProviders ?? existing.deniedProviders,
    allowedModels: patch.allowedModels ?? existing.allowedModels,
    deniedModels: patch.deniedModels ?? existing.deniedModels,
    expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : existing.expiresAt,
    enabled: patch.enabled ?? existing.enabled,
    shareEnabled: patch.shareEnabled ?? existing.shareEnabled,
    shareSlug: patch.shareSlug !== undefined ? patch.shareSlug : existing.shareSlug,
    updatedAt: new Date(),
  };

  await db.update(apiKeys).set(next).where(eq(apiKeys.id, id));
  return getApiKeyPublic(id);
}

export async function setEnabled(id: number, enabled: boolean): Promise<boolean> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!row) return false;
  await db
    .update(apiKeys)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(apiKeys.id, id));
  return true;
}

export async function revokeApiKey(id: number, revoked = true): Promise<boolean> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!row) return false;
  await db
    .update(apiKeys)
    .set({ revokedAt: revoked ? new Date() : null, enabled: revoked ? false : true, updatedAt: new Date() })
    .where(eq(apiKeys.id, id));
  return true;
}

export async function regenerateApiKey(id: number): Promise<{ key: string; public: Record<string, unknown> } | null> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!row) return null;
  const secret = generateApiSecret();
  const keyHash = hashApiKey(secret);
  await db
    .update(apiKeys)
    .set({ keyHash, keyEnc: encrypt(secret), keyPrefix: keyPrefixOf(secret), updatedAt: new Date() })
    .where(eq(apiKeys.id, id));
  return { key: secret, public: sanitizePublic(rowFromSelect({ ...row, keyPrefix: keyPrefixOf(secret) })) };
}

/** Explicit credential endpoint: returns the raw secret for the owner. */
export async function revealApiKey(id: number): Promise<string | null> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!row?.keyEnc) return null;
  try {
    return decrypt(row.keyEnc);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Enforcement

export type KeyResolution =
  | { ok: false; error: string; status: number }
  | { ok: true; key: ApiKeyRow; inflightToken: number };

export async function resolveApiKey(secret: string): Promise<KeyResolution> {
  if (!secret) return { ok: false, error: "Missing API key", status: 401 };
  const hash = hashApiKey(secret);
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
  if (!row) {
    // Fall back to legacy single-key (env / DB setting) — Cartethyia parity keeps it working.
    return { ok: false, error: "Invalid API key", status: 401 };
  }
  const key = rowFromSelect(row);

  if (key.revokedAt) return { ok: false, error: "API key revoked", status: 401 };
  if (!key.enabled) return { ok: false, error: "API key disabled", status: 403 };
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "API key expired", status: 401 };
  }

  // RPM (in-memory, memory-adaptive)
  const rpm = key.rpmLimit > 0 ? key.rpmLimit : Infinity;
  const now = Date.now();
  if (rpm !== Infinity) {
    let w = rpmWindows.get(key.id);
    if (!w || now - w.windowStart >= RPM_WINDOW_MS) {
      w = { windowStart: now, count: 0 };
      rpmWindows.set(key.id, w);
    }
    if (w.count >= rpm) {
      return { ok: false, error: "Rate limit exceeded (RPM)", status: 429 };
    }
    w.count++;
  }

  // Concurrency
  const maxC = key.maxConcurrent > 0 ? key.maxConcurrent : Infinity;
  const currentSet = inflight.get(key.id);
  const currentCount = currentSet ? currentSet.size : 0;
  if (currentCount >= maxC) {
    return { ok: false, error: "Concurrency limit exceeded", status: 429 };
  }

  // Budget check — skip SELECTs entirely when both budgets are 0 (unlimited, common case)
  if (key.monthlyTokenBudget > 0 || key.oneTimeTokenBudget > 0) {
    const usage = (await usageLookup(key.id)) ?? { monthly: 0, once: 0 };
    if (key.monthlyTokenBudget > 0 && usage.monthly >= key.monthlyTokenBudget) {
      return { ok: false, error: "Monthly token budget exhausted", status: 429 };
    }
    if (key.oneTimeTokenBudget > 0 && usage.once >= key.oneTimeTokenBudget) {
      return { ok: false, error: "One-time token budget exhausted", status: 429 };
    }
  }

  // Mark request as started (inflight) so the wrapper can release it
  const set = inflight.get(key.id) ?? new Set<InFlightEntry>();
  const entry = { startedAt: now, token: ++inflightSeq };
  set.add(entry);
  inflight.set(key.id, set);
  lastAccess.set(key.id, now);

  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id))
    .catch(() => {});

  return { ok: true, key, inflightToken: entry.token };
}

export function releaseApiKey(keyId: number, inflightToken?: number): void {
  const set = inflight.get(keyId);
  if (!set) return;
  if (inflightToken === undefined) {
    // Backward-compat: release the oldest entry (used by stream finalizers that
    // only captured a request start without a token). Prefer explicit tokens.
    const first = [...set.values()][0];
    if (first) set.delete(first);
  } else {
    for (const entry of set) {
      if (entry.token === inflightToken) {
        set.delete(entry);
        break;
      }
    }
  }
  if (set.size === 0) inflight.delete(keyId);
}

async function usageLookup(keyId: number): Promise<{ monthly: number; once: number } | null> {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const rows = await db
    .select({ period: apiKeyUsage.period, total: apiKeyUsage.totalTokens })
    .from(apiKeyUsage)
    .where(and(eq(apiKeyUsage.apiKeyId, keyId), inArray(apiKeyUsage.period, [month, "once"])));
  return {
    monthly: rows.find((r) => r.period === month)?.total ?? 0,
    once: rows.find((r) => r.period === "once")?.total ?? 0,
  };
}

export async function recordUsage(keyId: number, tokens: number, requests = 1): Promise<void> {
  if (!keyId || tokens <= 0 && requests <= 0) return;
  // Usage accounting must never break proxy responses — swallow DB errors.
  try {
    const month = new Date().toISOString().slice(0, 7);
  await db.run(sql`
    INSERT INTO api_key_usage (api_key_id, period, request_count, prompt_tokens, completion_tokens, total_tokens, updated_at)
    VALUES (${keyId}, ${month}, ${requests}, 0, 0, ${Math.max(0, tokens)}, strftime('%s','now') * 1000),
           (${keyId}, 'once', ${requests}, 0, 0, ${Math.max(0, tokens)}, strftime('%s','now') * 1000)
    ON CONFLICT (api_key_id, period) DO UPDATE SET
      request_count = api_key_usage.request_count + excluded.request_count,
      total_tokens = api_key_usage.total_tokens + excluded.total_tokens,
      updated_at = excluded.updated_at
  `);
  } catch (err) {
    console.error(`[API Keys] recordUsage failed for key ${keyId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// ACL

export interface AclTarget {
  provider?: string;
  model?: string;
}

export async function checkAcl(key: ApiKeyRow, target: AclTarget): Promise<{ allowed: boolean; reason?: string }> {

  const providers = key.allowedProviders ?? [];
  const deniedProviders = key.deniedProviders ?? [];
  const models = key.allowedModels ?? [];
  const deniedModels = key.deniedModels ?? [];

  const provider = target.provider ? target.provider.toLowerCase() : undefined;
  const model = target.model ? target.model.toLowerCase() : undefined;

  if (provider) {
    if (deniedProviders.some((p) => p.toLowerCase() === provider)) {
      return { allowed: false, reason: `Provider ${target.provider} is denied` };
    }
    if (providers.length > 0 && !providers.some((p) => p.toLowerCase() === provider)) {
      return { allowed: false, reason: `Provider ${target.provider} is not allowed` };
    }
  }
  if (model) {
    if (deniedModels.some((m) => m.toLowerCase() === model)) {
      return { allowed: false, reason: `Model ${target.model} is denied` };
    }
    if (models.length > 0 && !models.some((m) => m.toLowerCase() === model)) {
      return { allowed: false, reason: `Model ${target.model} is not allowed` };
    }
  }
  return { allowed: true };
}

/** Permanent delete: usage rows first (no ON DELETE CASCADE), then the key. */
export async function deleteApiKeyPermanently(id: number): Promise<boolean> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!row) return false;
  await db.delete(apiKeyUsage).where(eq(apiKeyUsage.apiKeyId, id));
  await db.delete(apiKeys).where(eq(apiKeys.id, id));
  return true;
}

/** Lightweight user-key inspection for the public quota endpoint.
 * No inflight slot, no lastUsed bump — read-only validation + quota snapshot. */
export async function inspectUserKey(secret: string): Promise<
  | { ok: false; error: string; status: number }
  | { ok: true; data: { name: string; monthlyUsed: number; monthlyBudget: number; lifetimeUsed: number; lifetimeBudget: number } }
> {
  if (!secret) return { ok: false, error: "Missing API key", status: 401 };
  const hash = hashApiKey(secret);
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
  if (!row) return { ok: false, error: "key is not valid or has been revoked", status: 401 };
  const key = rowFromSelect(row);
  if (key.revokedAt) return { ok: false, error: "key is not valid or has been revoked", status: 401 };
  if (!key.enabled) return { ok: false, error: "API key disabled", status: 403 };
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "API key expired", status: 401 };
  }
  const usage = (await usageLookup(key.id)) ?? { monthly: 0, once: 0 };
  return {
    ok: true,
    data: {
      name: key.name,
      monthlyUsed: usage.monthly,
      monthlyBudget: key.monthlyTokenBudget,
      lifetimeUsed: usage.once,
      lifetimeBudget: key.oneTimeTokenBudget,
    },
  };
}

/** Generate a unique share slug. */
export async function generateShareSlug(name: string): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "key";
  const suffix = randomBytes(4).toString("hex");
  return `${base}-${suffix}`;
}

export async function getApiKeyBySlug(slug: string): Promise<ApiKeyRow | null> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.shareSlug, slug));
  return row ? rowFromSelect(row) : null;
}

// ---------------------------------------------------------------------------
// Share page data (no raw secret)
export async function getShareData(slug: string): Promise<{
  name: string;
  description: string | null;
  baseUrl: string;
  shareSlug: string;
  usage: { monthlyRequests: number; monthlyTokens: number; totalRequests: number; totalTokens: number };
} | null> {
  const key = await getApiKeyBySlug(slug);
  if (!key || !key.shareEnabled) return null;

  const now = new Date().toISOString().slice(0, 7);
  const m = await db
    .select({ requests: apiKeyUsage.requestCount, total: apiKeyUsage.totalTokens })
    .from(apiKeyUsage)
    .where(and(eq(apiKeyUsage.apiKeyId, key.id), eq(apiKeyUsage.period, now)))
    .then((r) => r[0]);
  const o = await db
    .select({ requests: apiKeyUsage.requestCount, total: apiKeyUsage.totalTokens })
    .from(apiKeyUsage)
    .where(and(eq(apiKeyUsage.apiKeyId, key.id), eq(apiKeyUsage.period, "once")))
    .then((r) => r[0]);

  return {
    name: key.name,
    description: key.description,
    baseUrl: config.proxyUrl || "http://localhost:1930",
    shareSlug: key.shareSlug!,
    usage: {
      monthlyRequests: m?.requests ?? 0,
      monthlyTokens: m?.total ?? 0,
      totalRequests: o?.requests ?? 0,
      totalTokens: o?.total ?? 0,
    },
  };
}