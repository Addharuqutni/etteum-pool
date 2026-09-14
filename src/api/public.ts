import { Hono } from "hono";
import { db } from "../db/index";
import { requestLogs, usageSummary } from "../db/schema";
import { desc, sql } from "drizzle-orm";
import { getAllModels } from "../proxy/router";
import { refreshByokModels } from "../proxy/providers/registry";
import { getCombosCached } from "../proxy/combos";
import { inspectUserKey } from "../services/api-keys";

export const publicRouter = new Hono();

function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

// GET /api/public/models — model catalog, no auth (ids + owner only)
publicRouter.get("/models", async (c) => {
  await refreshByokModels();
  const models = getAllModels().map((m) => ({ id: m.id, owned_by: m.owned_by }));
  const combos = getCombosCached().map((combo) => ({ id: combo.name, owned_by: "combo" }));
  return c.json({ data: [...models, ...combos] });
});

// GET /api/public/usage — per-model totals, no auth (aggregate only)
publicRouter.get("/usage", async (c) => {
  const rows = await db
    .select({
      model: usageSummary.model,
      totalRequests: sql<number>`SUM(total_requests)`,
      totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
    })
    .from(usageSummary)
    .groupBy(usageSummary.model)
    .having(sql`COALESCE(SUM(total_tokens), 0) > 0`)
    .orderBy(sql`COALESCE(SUM(total_tokens), 0) DESC`);
  return c.json({ data: rows });
});

// GET /api/public/requests — recent logs, no auth (no emails, no bodies)
publicRouter.get("/requests", async (c) => {
  const limit = clampNumber(c.req.query("limit"), 40, 1, 40);
  const logs = await db
    .select({
      id: requestLogs.id,
      provider: requestLogs.provider,
      model: requestLogs.model,
      promptTokens: requestLogs.promptTokens,
      completionTokens: requestLogs.completionTokens,
      totalTokens: requestLogs.totalTokens,
      status: requestLogs.status,
      durationMs: requestLogs.durationMs,
      createdAt: requestLogs.createdAt,
    })
    .from(requestLogs)
    .orderBy(desc(requestLogs.createdAt))
    .limit(limit);
  return c.json({ data: logs });
});

// POST /api/public/quota { key } — validate pasted user key + quota (no inflight slot)
publicRouter.post("/quota", async (c) => {
  const body = await c.req.json<{ key: string }>().catch(() => ({ key: "" }));
  const key = (body.key || "").replace(/^Bearer\s+/i, "").trim();
  if (!key) return c.json({ error: "key is required" }, 400);
  const result = await inspectUserKey(key);
  if (!result.ok) return c.json({ error: result.error }, result.status as 401 | 403);
  return c.json(result.data);
});
