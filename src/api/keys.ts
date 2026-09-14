import { Hono } from "hono";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../config";
import {
  listApiKeys,
  getApiKeyPublic,
  createApiKey,
  updateApiKey,
  setEnabled,
  revokeApiKey,
  deleteApiKeyPermanently,
  regenerateApiKey,
  revealApiKey,
  getShareData,
  generateShareSlug,
  type ApiKeyInput,
} from "../services/api-keys";

const API_KEY_SETTING = "api_key";
const API_KEY_CACHE_TTL_MS = 5_000;

let activeApiKeyCache: { key: string; expiresAt: number } | null = null;

export const keysRouter = new Hono();

function clampNumber(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((v) => String(v).trim()).filter(Boolean)));
}

function parseKeyInput(body: Record<string, unknown>): ApiKeyInput {
  const expiresRaw = body.expiresAt ? new Date(String(body.expiresAt)) : undefined;
  return {
    name: typeof body.name === "string" ? body.name.trim() : "",
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    monthlyTokenBudget: body.monthlyTokenBudget !== undefined ? clampNumber(body.monthlyTokenBudget, 0) : undefined,
    oneTimeTokenBudget: body.oneTimeTokenBudget !== undefined ? clampNumber(body.oneTimeTokenBudget, 0) : undefined,
    rpmLimit: body.rpmLimit !== undefined ? clampNumber(body.rpmLimit, 0) : undefined,
    maxConcurrent: body.maxConcurrent !== undefined ? clampNumber(body.maxConcurrent, 0) : undefined,
    allowedProviders: body.allowedProviders !== undefined ? parseStringArray(body.allowedProviders) : undefined,
    deniedProviders: body.deniedProviders !== undefined ? parseStringArray(body.deniedProviders) : undefined,
    allowedModels: body.allowedModels !== undefined ? parseStringArray(body.allowedModels) : undefined,
    deniedModels: body.deniedModels !== undefined ? parseStringArray(body.deniedModels) : undefined,
    expiresAt: expiresRaw && !Number.isNaN(expiresRaw.getTime()) ? expiresRaw : undefined,
  };
}

// Legacy single-key helpers (kept for backwards compat: env API_KEY + settings).
function generateLegacyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `sk-pool-${token}`;
}

export async function getActiveApiKey(): Promise<string> {
  const now = Date.now();
  if (activeApiKeyCache && activeApiKeyCache.expiresAt > now) {
    return activeApiKeyCache.key;
  }

  const [row] = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  const key = row?.value || config.apiKey;
  activeApiKeyCache = { key, expiresAt: now + API_KEY_CACHE_TTL_MS };
  return key;
}

export async function isValidApiKey(token: string): Promise<boolean> {
  if (!token) return false;
  if (token === config.apiKey) return true;
  const active = await getActiveApiKey();
  return token === active;
}

// ---------------------------------------------------------------------------
// Routes — order matters: literal paths before /:id.

// List (masked) + legacy single-key view
keysRouter.get("/", async (c) => {
  const keys = await listApiKeys();
  const [legacy] = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  // This endpoint requires the authenticated admin key (middleware /api/*), so
  // returning the active legacy key is safe — the operator must see it to use
  // the pool. Serialize preserving the raw secret for the dashboard copy-widget.
  const activeKey = await getActiveApiKey();
  return c.json({
    keys,
    legacy: {
      activeKey,
      source: legacy?.value ? "database" : "env",
      fromEnv: !legacy?.value,
      configured: Boolean(legacy?.value || config.apiKey),
    },
  });
});

// Create — returns the raw secret exactly once
keysRouter.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  const key = await createApiKey(parseKeyInput(body));
  return c.json({ ...key.public, key: key.key });
});

// Legacy: test key validity (public, no raw secret returned)
keysRouter.post("/test", async (c) => {
  const body = await c.req.json<{ key: string }>().catch(() => ({ key: "" }));
  const valid = await isValidApiKey((body.key || "").replace(/^Bearer\s+/i, ""));
  return c.json({ valid });
});

// Legacy: regenerate single key / set single key (kept for main ApiKey page compat)
keysRouter.post("/regenerate", async (c) => {
  const key = generateLegacyKey();
  const existing = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  if (existing.length > 0) {
    await db.update(settings).set({ value: key, updatedAt: new Date() }).where(eq(settings.key, API_KEY_SETTING));
  } else {
    await db.insert(settings).values({ key: API_KEY_SETTING, value: key });
  }
  activeApiKeyCache = { key, expiresAt: Date.now() + API_KEY_CACHE_TTL_MS };
  return c.json({ key, source: "database" });
});

keysRouter.post("/set", async (c) => {
  const body = await c.req.json<{ key: string }>().catch(() => ({ key: "" }));
  if (!body.key || body.key.length < 16) {
    return c.json({ error: "API key must be at least 16 characters" }, 400);
  }
  const existing = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  if (existing.length > 0) {
    await db.update(settings).set({ value: body.key, updatedAt: new Date() }).where(eq(settings.key, API_KEY_SETTING));
  } else {
    await db.insert(settings).values({ key: API_KEY_SETTING, value: body.key });
  }
  activeApiKeyCache = { key: body.key, expiresAt: Date.now() + API_KEY_CACHE_TTL_MS };
  return c.json({ key: body.key, source: "database" });
});

// Public share-page data (no raw secret) — must precede /:id
keysRouter.get("/share/:slug", async (c) => {
  const data = await getShareData(c.req.param("slug"));
  if (!data) return c.json({ error: "Share not found or disabled" }, 404);
  return c.json(data);
});

// Detail (masked) + usage summary
keysRouter.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const key = await getApiKeyPublic(id);
  if (!key) return c.json({ error: "API key not found" }, 404);
  return c.json({ ...key, shareUrl: key.shareSlug ? `/keys/share/${key.shareSlug}` : null });
});

// Update (name, budgets, limits, ACL, expiry)
keysRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const patch = parseKeyInput(body);
  const updated = await updateApiKey(id, patch);
  if (!updated) return c.json({ error: "API key not found" }, 404);
  return c.json(updated);
});

// Enable / disable
keysRouter.post("/:id/enable", async (c) => {
  const ok = await setEnabled(Number(c.req.param("id")), true);
  return ok ? c.json({ ok: true }) : c.json({ error: "API key not found" }, 404);
});

keysRouter.post("/:id/disable", async (c) => {
  const ok = await setEnabled(Number(c.req.param("id")), false);
  return ok ? c.json({ ok: true }) : c.json({ error: "API key not found" }, 404);
});

// Revoke (permanently) / un-revoke
keysRouter.delete("/:id", async (c) => {
  const ok = await revokeApiKey(Number(c.req.param("id")), true);
  return ok ? c.json({ ok: true }) : c.json({ error: "API key not found" }, 404);
});

// Hard delete — removes the row + its usage (irreversible)
keysRouter.delete("/:id/permanent", async (c) => {
  const ok = await deleteApiKeyPermanently(Number(c.req.param("id")));
  return ok ? c.json({ ok: true }) : c.json({ error: "API key not found" }, 404);
});

// Regenerate — raw secret returned exactly once
keysRouter.post("/:id/regenerate", async (c) => {
  const result = await regenerateApiKey(Number(c.req.param("id")));
  if (!result) return c.json({ error: "API key not found" }, 404);
  return c.json({ ...result.public, key: result.key });
});

// Explicit credential endpoint — raw secret only here
keysRouter.get("/:id/credential", async (c) => {
  const id = Number(c.req.param("id"));
  const secret = await revealApiKey(id);
  if (secret === null) return c.json({ error: "API key not found" }, 404);
  return c.json({ key: secret });
});

// Enable / disable public share page
keysRouter.post("/:id/share", async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING)); // no-op, just to read shape
  void row;
  const pub = await getApiKeyPublic(id);
  if (!pub) return c.json({ error: "API key not found" }, 404);
  let slug = pub.shareSlug as string | null;
  if (!slug) {
    slug = await generateShareSlug(pub.name as string);
  }
  const updated = await updateApiKey(id, { shareEnabled: true, shareSlug: slug } as any);
  return c.json({ ok: true, shareUrl: `/keys/share/${slug}`, ...(updated || {}) });
});

keysRouter.delete("/:id/share", async (c) => {
  const updated = await updateApiKey(Number(c.req.param("id")), { shareEnabled: false, shareSlug: null } as any);
  if (!updated) return c.json({ error: "API key not found" }, 404);
  return c.json({ ok: true });
});