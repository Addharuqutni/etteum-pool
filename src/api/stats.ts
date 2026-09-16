import { Hono } from "hono";
import { db } from "../db/index";
import { requestLogs, accounts, usageSummary } from "../db/schema";
import { desc, sql, eq, and, or, like, ne, lt, type SQL } from "drizzle-orm";
import { pool } from "../proxy/pool";
import { config } from "../config";
import { getAllModels } from "../proxy/router";
import { getRequestLogRetentionConfig } from "../proxy/logging";

export const statsRouter = new Hono();

function normalizeTimeZone(value: string | undefined): string {
  if (!value) return "UTC";
  if (!/^[A-Za-z0-9_+./-]+$/.test(value)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
}

function sqlString(value: string) {
  return sql.raw(`'${value.replace(/'/g, "''")}'`);
}

function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function summaryBucketExpr(grain: "hour" | "day" | "month", timeZone: string) {
  // NOTE: usage_summary.bucket is a TEXT ISO-8601 UTC string (e.g. '2026-06-03T09:00:00Z').
  // SQLite's strftime cannot apply IANA time zone names, so the timeZone param is accepted
  // and echoed back in the JSON response but intentionally ignored here: all bucketing is
  // done in UTC directly over the already-UTC bucket string.
  void timeZone;
  switch (grain) {
    case "hour":
      return sql<string>`strftime('%Y-%m-%dT%H:00:00Z', ${usageSummary.bucket})`;
    case "day":
      return sql<string>`strftime('%Y-%m-%dT00:00:00Z', ${usageSummary.bucket})`;
    case "month":
      return sql<string>`strftime('%Y-%m-01T00:00:00Z', ${usageSummary.bucket})`;
  }
}

/**
 * GET /api/stats - Get overall statistics (from usage_summary)
 * Supports optional ?hours=N&range=all to filter by time period
 */
statsRouter.get("/", async (c) => {
  const range = c.req.query("range");
  const hours = c.req.query("hours") ? clampNumber(c.req.query("hours"), 24, 1, 24 * 365) : null;
  const isAll = range === "all";

  const timeFilter = (!isAll && hours)
    ? sql`${usageSummary.bucket} >= ${new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()}`
    : sql`1=1`;

  const [poolStats, requestStats] = await Promise.all([
    pool.getStats(),
    db
      .select({
        total: sql<number>`COALESCE(SUM(total_requests), 0)`,
        success: sql<number>`COALESCE(SUM(success_requests), 0)`,
        errors: sql<number>`COALESCE(SUM(error_requests), 0)`,
        totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
        promptTokens: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
        completionTokens: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
        credits: sql<number>`COALESCE(SUM(credits_used), 0)`,
        avgDuration: sql<number>`CASE WHEN SUM(success_requests) > 0 THEN CAST(SUM(total_duration_ms) AS REAL) / SUM(success_requests) ELSE 0 END`,
      })
      .from(usageSummary)
      .where(timeFilter),
  ]);

  const stats = requestStats[0];

  return c.json({
    pool: poolStats,
    requests: {
      total: stats?.total || 0,
      success: stats?.success || 0,
      errors: stats?.errors || 0,
    },
    tokens: {
      total: stats?.totalTokens || 0,
      prompt: stats?.promptTokens || 0,
      completion: stats?.completionTokens || 0,
      credits: stats?.credits || 0,
    },
    performance: {
      avgDurationMs: Math.round(stats?.avgDuration || 0),
    },
  });
});

/**
 * GET /api/stats/requests - Get recent request logs (from request_logs, max 500)
 *
 * IMPORTANT: This endpoint intentionally OMITS the heavy `requestBody` and
 * `responseBody` columns to keep list payloads small. Each row's prompt can be
 * ~1 MB (system prompt + conversation history), so selecting them here would
 * mean tens of MB of JSON over the wire just to render a table. The full
 * bodies are loaded on demand via `GET /api/stats/requests/:id` when the user
 * opens the detail drawer.
 */
statsRouter.get("/requests", async (c) => {
  const limit = clampNumber(c.req.query("limit"), 50, 1, 500);
  const offset = clampNumber(c.req.query("offset"), 0, 0, 100_000);
  const provider = c.req.query("provider");
  const status = c.req.query("status");
  const search = c.req.query("search")?.trim();

  const lightColumns = {
    id: requestLogs.id,
    accountId: requestLogs.accountId,
    provider: requestLogs.provider,
    model: requestLogs.model,
    promptTokens: requestLogs.promptTokens,
    completionTokens: requestLogs.completionTokens,
    totalTokens: requestLogs.totalTokens,
    creditsUsed: requestLogs.creditsUsed,
    status: requestLogs.status,
    durationMs: requestLogs.durationMs,
    errorMessage: requestLogs.errorMessage,
    accountEmail: requestLogs.accountEmail,
    accountQuotaBefore: requestLogs.accountQuotaBefore,
    accountQuotaAfter: requestLogs.accountQuotaAfter,
    compressionStats: requestLogs.compressionStats,
    createdAt: requestLogs.createdAt,
  };

  const conditions: SQL[] = [];
  if (provider && provider !== "all") conditions.push(eq(requestLogs.provider, provider));
  if (status === "success" || status === "error") conditions.push(eq(requestLogs.status, status));
  if (search) {
    // LIKE is ASCII-case-insensitive in SQLite, so no lowercasing is needed.
    const needle = `%${search}%`;
    conditions.push(
      or(
        like(requestLogs.model, needle),
        like(requestLogs.provider, needle),
        like(requestLogs.errorMessage, needle),
        like(requestLogs.accountEmail, needle)
      )!
    );
  }
  const whereClause = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);

  const [logs, countRows] = await Promise.all([
    db
      .select(lightColumns)
      .from(requestLogs)
      .where(whereClause)
      .orderBy(desc(requestLogs.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(requestLogs).where(whereClause),
  ]);

  return c.json({ data: logs, total: Number(countRows[0]?.count ?? 0), limit, offset });
});

/**
 * DELETE /api/stats/requests - Prune or purge stored request logs.
 *
 * Registered before `/requests/:id` so the literal path is never parsed as an id.
 * Supported (at least one required, else 400):
 *   all=true              purge every row
 *   olderThanDays=N       drop rows older than N days ("retention" = use the saved policy)
 *   status=error          drop failed requests only
 *   provider=xxx          drop rows for one provider
 * `all=true` wins and ignores any other condition.
 */
statsRouter.delete("/requests", async (c) => {
  const all = c.req.query("all") === "true";
  const provider = c.req.query("provider");
  const status = c.req.query("status");
  const olderThanRaw = c.req.query("olderThanDays");

  const conditions: SQL[] = [];
  let supplied = all;

  if (!all) {
    if (olderThanRaw !== undefined) {
      supplied = true;
      const days =
        olderThanRaw === "retention"
          ? (await getRequestLogRetentionConfig()).retentionDays
          : clampNumber(olderThanRaw, 0, 0, 3650);
      if (days > 0) {
        const cutoffSeconds = Math.floor(Date.now() / 1000) - days * 86_400;
        conditions.push(lt(requestLogs.createdAt, new Date(cutoffSeconds * 1000)));
      }
    }
    if (status === "error") {
      supplied = true;
      conditions.push(ne(requestLogs.status, "success"));
    }
    if (provider && provider !== "all") {
      supplied = true;
      conditions.push(eq(requestLogs.provider, provider));
    }
  }

  if (!supplied) {
    return c.json(
      { error: "At least one of all, olderThanDays, status, or provider is required" },
      400
    );
  }

  // A supplied filter can still yield no condition (e.g. olderThanDays=retention
  // with the saved policy set to 0 = keep forever). That must delete nothing —
  // never fall through to an unconditional DELETE.
  if (!all && conditions.length === 0) {
    return c.json({ success: true, deletedCount: 0 });
  }

  try {
    const query = db.delete(requestLogs);
    const rows = await (all
      ? query
      : query.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    ).returning({ id: requestLogs.id });
    return c.json({ success: true, deletedCount: rows.length });
  } catch (err) {
    console.error("[Stats] Failed to delete request logs:", err);
    return c.json({ error: "Failed to delete request logs" }, 500);
  }
});

/**
 * GET /api/stats/requests/:id - Get request log detail
 */
statsRouter.get("/requests/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const [log] = await db.select().from(requestLogs).where(eq(requestLogs.id, id));
  if (!log) return c.json({ error: "Request log not found" }, 404);
  return c.json({ data: log });
});

/**
 * GET /api/stats/usage - Get usage over time (from usage_summary)
 */
statsRouter.get("/usage", async (c) => {
  const range = c.req.query("range");
  const hours = clampNumber(c.req.query("hours"), 24, 1, 24 * 365);
  const timeZone = normalizeTimeZone(c.req.query("timeZone"));
  const isAll = range === "all";
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const bucketExpr =
    isAll
      ? summaryBucketExpr("month", timeZone)
      : hours <= 48
      ? summaryBucketExpr("hour", timeZone)
      : hours <= 24 * 32
        ? summaryBucketExpr("day", timeZone)
        : summaryBucketExpr("month", timeZone);

  const whereExpr = isAll
    ? sql`${usageSummary.totalTokens} > 0`
    : sql`${usageSummary.bucket} >= ${since.toISOString()} AND ${usageSummary.totalTokens} > 0`;

  const hourlyUsage = await db
    .select({
      hour: bucketExpr,
      provider: usageSummary.provider,
      model: usageSummary.model,
      count: sql<number>`SUM(total_requests)`,
      tokens: sql<number>`SUM(total_tokens)`,
      promptTokens: sql<number>`SUM(prompt_tokens)`,
      completionTokens: sql<number>`SUM(completion_tokens)`,
      credits: sql<number>`SUM(credits_used)`,
      avgDuration: sql<number>`CASE WHEN SUM(success_requests) > 0 THEN CAST(SUM(total_duration_ms) AS REAL) / SUM(success_requests) ELSE 0 END`,
    })
    .from(usageSummary)
    .where(whereExpr)
    .groupBy(bucketExpr, usageSummary.provider, usageSummary.model)
    .orderBy(bucketExpr, usageSummary.provider, usageSummary.model);

  return c.json({ data: hourlyUsage, hours: isAll ? null : hours, range: isAll ? "all" : `${hours}h`, timeZone });
});

/**
 * GET /api/stats/providers - Get per-provider statistics (from usage_summary + accounts)
 */
statsRouter.get("/providers", async (c) => {
  const allowedProviders = new Set<string>(config.providers);
  const requestStats = await db
    .select({
      provider: usageSummary.provider,
      totalRequests: sql<number>`SUM(total_requests)`,
      successRequests: sql<number>`SUM(success_requests)`,
      errorRequests: sql<number>`SUM(error_requests)`,
      totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
      promptTokens: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
      completionTokens: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
      creditsUsed: sql<number>`COALESCE(SUM(credits_used), 0)`,
      avgDuration: sql<number>`CASE WHEN SUM(success_requests) > 0 THEN CAST(SUM(total_duration_ms) AS REAL) / SUM(success_requests) ELSE 0 END`,
    })
    .from(usageSummary)
    .groupBy(usageSummary.provider);

  const quotaStats = await db
    .select({
      provider: accounts.provider,
      activeAccounts: sql<number>`SUM(CASE WHEN status = 'active' AND enabled = 1 THEN 1 ELSE 0 END)`,
      exhaustedAccounts: sql<number>`SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END)`,
      errorAccounts: sql<number>`SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`,
      pendingAccounts: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
      disabledAccounts: sql<number>`SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END)`,
      totalAccounts: sql<number>`count(*)`,
      quotaLimit: sql<number>`COALESCE(SUM(quota_limit), 0)`,
      quotaRemaining: sql<number>`COALESCE(SUM(quota_remaining), 0)`,
    })
    .from(accounts)
    .groupBy(accounts.provider);

  const byProvider = new Map(
    requestStats
      .filter((row) => row.provider && allowedProviders.has(row.provider))
      .map((row) => [row.provider, row])
  );
  for (const quota of quotaStats) {
    if (!allowedProviders.has(quota.provider)) continue;
    const current = byProvider.get(quota.provider) || { provider: quota.provider } as any;
    byProvider.set(quota.provider, { ...current, ...quota });
  }

  const data = config.providers
    .map((provider) => byProvider.get(provider))
    .filter(Boolean);

  return c.json({ data });
});

/**
 * GET /api/stats/models - Get per-model statistics (from usage_summary)
 * Supports optional ?hours=N&range=all to filter by time period
 */
statsRouter.get("/models", async (c) => {
  const range = c.req.query("range");
  const hours = c.req.query("hours") ? clampNumber(c.req.query("hours"), 24, 1, 24 * 365) : null;
  const isAll = range === "all";

  const whereExpr = (!isAll && hours)
    ? sql`${usageSummary.bucket} >= ${new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()}`
    : sql`1=1`;

  const modelMeta = new Map(getAllModels().map((model) => [model.id, model]));
  const modelStats = await db
    .select({
      provider: usageSummary.provider,
      model: usageSummary.model,
      totalRequests: sql<number>`SUM(total_requests)`,
      totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
      promptTokens: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
      completionTokens: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
      credits: sql<number>`COALESCE(SUM(credits_used), 0)`,
      avgDuration: sql<number>`CASE WHEN SUM(success_requests) > 0 THEN CAST(SUM(total_duration_ms) AS REAL) / SUM(success_requests) ELSE 0 END`,
    })
    .from(usageSummary)
    .where(whereExpr)
    .groupBy(usageSummary.provider, usageSummary.model)
    .having(sql`COALESCE(SUM(total_tokens), 0) > 0 OR COALESCE(SUM(credits_used), 0) > 0`)
    .orderBy(sql`COALESCE(SUM(total_tokens), 0) DESC`);

  const data = modelStats.map((row) => {
    const meta = modelMeta.get(row.model || "");
    return {
      ...row,
      creditUnit: meta?.creditUnit || "token",
      creditRate: meta?.creditRate || 1 / 1000,
      creditSource: meta?.creditSource || "estimated",
    };
  });

  return c.json({ data });
});
