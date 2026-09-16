import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config";
import { runMigrations } from "./db/migrate";
import { apiRouter } from "./api/index";
import { authRouter } from "./auth/index";
import { proxyRouter } from "./proxy/index";
import { websocketHandler, getClientCount } from "./ws/index";
import { isValidApiKey } from "./api/keys";
import { resolveApiKey, releaseApiKey, startMemoryAdaptiveSweep, getShareData, type ApiKeyRow } from "./services/api-keys";
import { SsrfError } from "./utils/ssrf";
import { autoWarmupScheduler } from "./auth/warmup-scheduler";
import { db } from "./db/index";
import { accounts, filterRules, requestLogs, settings } from "./db/schema";
import { eq, inArray, like, or, sql } from "drizzle-orm";
import { PUDIDIL_FILTERS } from "./proxy/filters";
import { loadFilterCache } from "./proxy/filter-cache";
import { ensureModelMappingTable, seedModelMappings, loadModelMappingCache } from "./proxy/model-mapping";
import { ensureCombosTable, loadCombos } from "./proxy/combos";
import { refreshByokModels } from "./proxy/providers/registry";
import { runPeriodicChecks } from "./services/alerts";
import { stickyStore } from "./proxy/sticky";
import { cooldowns } from "./proxy/cooldown";

// Crash forensics: without these, an uncaught async error in a route/timer/promise
// silently kills Bun with no useful trace — matches the user's "crashed, no reason"
// symptom. Log full context, THEN exit non-zero so production.ts sees it.
process.on("uncaughtException", (err, origin) => {
  console.error(`[FATAL] uncaughtException (${origin}):`, err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason instanceof Error ? reason.stack || reason.message : reason);
  process.exit(1);
});

// Memory watchdog: exit CLEANLY (so production.ts can restart just the backend)
// before RSS reaches the point where Windows' low-memory killer takes down the
// whole process tree with no trace. Bun's reported RSS well exceeds heapUsed, and
// an unbounded stream/request on previous crashes grew past 12 GB and killed the
// server with zero log output. Threshold ~5 GB leaves room for the rest of the
// machine while aborting long before a crash. Clear a flag so we log once.
let watchdogTriggered = false;
setInterval(() => {
  try {
    const rss = process.memoryUsage().rss;
    if (rss > 5 * 1024 * 1024 * 1024) {
      if (!watchdogTriggered) {
        watchdogTriggered = true;
        console.error(`[FATAL] Memory watchdog: RSS ${(rss / 1024 / 1024 / 1024).toFixed(1)}GB exceeds 5GB; exiting cleanly to allow restart`);
      }
      process.exit(1);
    }
  } catch {
    /* ignore */
  }
}, 2_000).unref();
// Run database migrations on startup
await runMigrations();

// Seed filter rules from PUDIDIL_FILTERS if table is empty (first boot only)
try {
  const [row] = await db.select({ count: sql<number>`COUNT(*)` }).from(filterRules);
  if (Number(row?.count || 0) === 0) {
    await db.insert(filterRules).values(
      PUDIDIL_FILTERS.map((r, i) => ({
        ruleId: r.id,
        pattern: r.pattern,
        replacement: r.replacement,
        isActive: r.is_active,
        isRegex: r.is_regex,
        sortOrder: i,
      }))
    );
    console.log(`[DB] Seeded ${PUDIDIL_FILTERS.length} filter rules`);
  }
  await loadFilterCache();
} catch (e) {
  console.error("[DB] Filter rules seed/load skipped:", e instanceof Error ? e.message : e);
}

// Ensure model_mappings table exists (idempotent), seed Claude Code templates
// on first boot, then load the in-memory cache used by the proxy hot path.
try {
  ensureModelMappingTable();
  await seedModelMappings();
  await loadModelMappingCache();
} catch (e) {
  console.error("[DB] Model mapping init skipped:", e instanceof Error ? e.message : e);
}

// Ensure combos table exists (idempotent) and load the in-memory cache used by
// the proxy hot path (combo fallback loop) and /v1/models listing.
try {
  ensureCombosTable();
  await loadCombos();
} catch (e) {
  console.error("[DB] Combo init skipped:", e instanceof Error ? e.message : e);
}

// Pre-warm BYOK provider cache so ownsModel() works from the first request
try {
  console.log("[BYOK] Warming up cache...");
  await refreshByokModels();
  console.log("[BYOK] Cache warmed up successfully");
} catch (e) {
  console.error("[BYOK] Cache warm-up skipped:", e instanceof Error ? e.message : e);
}

// Purge accounts/settings for removed providers (kiro, kiro-pro, qoder,
// gitlab-duo, youmind). Null out request_logs.account_id first so the FK
// reference is dropped before the account rows are deleted.
try {
  const doomedProviders = ["kiro", "kiro-pro", "qoder", "gitlab-duo", "youmind"];

  await db.update(requestLogs).set({ accountId: null }).where(inArray(requestLogs.provider, doomedProviders));

  const deletedAccounts = await db.delete(accounts)
    .where(inArray(accounts.provider, doomedProviders))
    .returning({ id: accounts.id });

  const deletedSettings = await db.delete(settings)
    .where(or(
      like(settings.key, "auto_warmup_provider_kiro%"),
      like(settings.key, "auto_warmup_provider_qoder%"),
      like(settings.key, "auto_warmup_provider_gitlab-duo%"),
      like(settings.key, "auto_warmup_provider_youmind%"),
      eq(settings.key, "kiro_pro_upgrade"),
    ))
    .returning({ key: settings.key });

  if (deletedAccounts.length > 0 || deletedSettings.length > 0) {
    console.log(`[DB] Removed ${deletedAccounts.length} accounts, ${deletedSettings.length} settings for removed providers (kiro/kiro-pro/qoder/gitlab-duo/youmind)`);
  }
} catch (e) {
  console.error("[DB] Removed-provider cleanup skipped:", e instanceof Error ? e.message : e);
}

// Start auto-warmup scheduler (reads settings from DB)
await autoWarmupScheduler.start();

// Periodic alert checks (low credits, error rate, proxy pool empty) every 60s.
// Safe to run repeatedly — each event fires at most once per cooldown window.
setInterval(() => {
  void runPeriodicChecks();
}, 60_000);

// Memory hygiene: drop expired 429 cooldown + sticky session entries.
setInterval(() => {
  cooldowns.sweep();
  stickyStore.sweep();
}, 60_000);

// Create Hono app
const app = new Hono<{ Variables: { apiKey?: ApiKeyRow; apiKeyId?: number; apiKeyInflightToken?: number } }>();

// Middleware
app.use("*", cors());
app.use("*", logger());

// Per-IP admission — adaptive to free memory. Backs off fast when the process
// heap is hot (memory exhaustion is a DoS amplifier), reopens when it cools.
const ipBuckets = new Map<string, { count: number; resetAt: number }>();
const IP_WINDOW_MS = 10_000;
const IP_BASE_LIMIT = 120; // per 10s
const ipLimit = () => {
  try {
    const mem = process.memoryUsage();
    const ratio = mem.heapUsed / (mem.heapTotal || 1);
    if (ratio > 0.9) return Math.floor(IP_BASE_LIMIT * 0.25);
    if (ratio > 0.8) return Math.floor(IP_BASE_LIMIT * 0.5);
    if (ratio > 0.7) return Math.floor(IP_BASE_LIMIT * 0.75);
  } catch {
    /* ignore */
  }
  return IP_BASE_LIMIT;
};

function admitIp(ip: string): boolean {
  const now = Date.now();
  let b = ipBuckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + IP_WINDOW_MS };
    ipBuckets.set(ip, b);
  }
  b.count++;
  return b.count <= ipLimit();
}

async function cleanupIpBuckets() {
  const now = Date.now();
  for (const [ip, b] of ipBuckets) {
    if (now > b.resetAt) ipBuckets.delete(ip);
  }
}
setInterval(cleanupIpBuckets, IP_WINDOW_MS).unref();

// Memory-adaptive sweep for API-key limits (see services/api-keys.ts)
startMemoryAdaptiveSweep().unref();

// ---- Bounded-body + global concurrency protections -----------------------
// A request that exceeds the body cap is rejected before any JSON parsing.
// Global concurrency is capped by memory pressure (not a hard number): the
// limit scales down when heap is hot. 0 in config = adaptive-only.
let activeRequests = 0;
async function boundRequestMiddleware(c: any, next: () => Promise<void>) {
  // Concurrency gate (adaptive to heap pressure)
  const mem = (() => {
    try {
      const m = process.memoryUsage();
      return m.heapUsed / (m.heapTotal || 1);
    } catch {
      return 0;
    }
  })();
  let cap = 0;
  if (config.maxConcurrentRequests > 0) cap = config.maxConcurrentRequests;
  if (mem > 0.9) {
    const adaptive = Math.max(8, Math.floor((cap || 256) * 0.25));
    cap = cap ? Math.min(cap, adaptive) : adaptive;
  } else if (mem > 0.8) {
    const adaptive = Math.max(16, Math.floor((cap || 256) * 0.5));
    cap = cap ? Math.min(cap, adaptive) : adaptive;
  }
  if (cap > 0 && activeRequests >= cap) {
    return c.json(
      { error: { message: "Server busy — retry shortly", type: "rate_limit_error" } },
      503
    );
  }
  activeRequests++;
  try {
    await next();
  } finally {
    activeRequests--;
  }
}

// Apply the body cap only where a JSON body is read (proxy + management API).
app.use("/v1/*", async (c, next) => {
  const len = Number(c.req.header("Content-Length") || 0);
  if (len > config.maxBodyBytes) {
    return c.json(
      { error: { message: "Request body too large", type: "invalid_request_error" } },
      413
    );
  }
  return boundRequestMiddleware(c, next);
});
app.use("/api/*", async (c, next) => {
  const len = Number(c.req.header("Content-Length") || 0);
  if (len > config.maxBodyBytes) {
    return c.json(
      { error: { message: "Request body too large", type: "invalid_request_error" } },
      413
    );
  }
  return boundRequestMiddleware(c, next);
});

// API Key authentication middleware for proxy endpoints
app.use("/v1/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const xApiKey = c.req.header("x-api-key");
  const token = authHeader?.replace("Bearer ", "") || xApiKey;

  if (!token) {
    return c.json(
      { error: { message: "Missing Authorization header", type: "auth_error" } },
      401
    );
  }

  // Per-IP admission (adaptive to free memory)
  const ip = (c.env as any)?.ip as string | undefined;
  if (ip && !admitIp(ip)) {
    return c.json(
      { error: { message: "Too many requests from this address", type: "rate_limit_error" } },
      429
    );
  }

  const resolved = await resolveApiKey(token);
  if (!resolved.ok) {
    // Legacy keys (env/settings) still authenticate — resolveApiKey only knows
    // hashed keys, so fall back to the legacy check before rejecting.
    if (await isValidApiKey(token)) {
      await next();
      return;
    }
    return c.json(
      { error: { message: "Unauthorized", type: "auth_error" } },
      401
    );
  }

  // Infuse resolved key row so proxy routes can enforce ACL, budgets, usage
  // recording without re-fetching. Kept as full row; id used for usage joins.
  c.set("apiKey", resolved.key);
  c.set("apiKeyId", resolved.key.id);
  c.set("apiKeyInflightToken", resolved.inflightToken);

  // Streaming responses outlive the middleware — the stream finalizer in
  // proxy/index.ts releases the in-flight slot when the stream ends. Every
  // other response (JSON, errors thrown before a stream exists) releases here.
  // NOTE: Hono's next() resolves to the context, not a Response — read c.res.
  await next();
  const res = c.res;
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    releaseApiKey(resolved.key.id, resolved.inflightToken);
  }
});

// API Key authentication for management API
app.use("/api/*", async (c, next) => {
  // Allow health check, info, and key validation without auth
  if (c.req.path === "/api/health" || c.req.path === "/api/info" || c.req.path === "/api/keys/test") {
    await next();
    return;
  }

  // Allow public share pages (connection details + usage, never raw secrets)
  if (c.req.path.startsWith("/api/keys/share/")) {
    await next();
    return;
  }

  // Allow public pool landing data (models, aggregate usage, recent logs, key quota check)
  if (c.req.path.startsWith("/api/public/")) {
    await next();
    return;
  }

  // Allow OAuth endpoints without auth (before user login)
  if (c.req.path.startsWith("/api/oauth")) {
    await next();
    return;
  }

  const authHeader = c.req.header("Authorization");
  const apiKeyQuery = c.req.query("api_key");
  const token = authHeader?.replace("Bearer ", "") || apiKeyQuery;

  if (!token) {
    return c.json(
      { error: { message: "Unauthorized", type: "auth_error" } },
      401
    );
  }

  const ip = (c.env as any)?.ip as string | undefined;
  if (ip && !admitIp(ip)) {
    return c.json(
      { error: { message: "Too many requests from this address", type: "rate_limit_error" } },
      429
    );
  }

  const resolved = await resolveApiKey(token);
  if (!resolved.ok) {
    // Legacy keys (env/settings) still valid here — resolveApiKey only knows hashed keys.
    if (!(await isValidApiKey(token))) {
      return c.json(
        { error: { message: "Unauthorized", type: "auth_error" } },
        401
      );
    }
  } else {
    // Per-user hashed keys are proxy-only: management API is admin (legacy key).
    return c.json(
      { error: { message: "Forbidden: admin key required", type: "auth_error" } },
      403
    );
  }

  await next();
});

// Mount routes
app.route("/", proxyRouter); // /v1/chat/completions, /v1/models
app.route("/api", apiRouter); // /api/accounts, /api/settings, /api/stats
app.route("/api/auth", authRouter); // /api/auth/login, /api/auth/queue

// Sanitized error boundary: internal messages/stack traces are never returned
// to clients. Full detail goes to the server log only.
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  const path = c.req.path;
  const isProxy = path.startsWith("/v1");
  const status = err instanceof SsrfError ? 400 : 500;

  if (status === 500) {
    console.error(`[Error] ${path}:`, err);
  }

  if (isProxy) {
    return c.json(
      { error: { message: "Internal proxy error", type: "api_error" } },
      status
    );
  }
  return c.json({ error: "Internal server error" }, status);
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api") || c.req.path.startsWith("/v1")) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.text("Not found", 404);
});

// Health/info endpoint (moved from / to /api/health)
app.get("/api/info", (c) => {
  return c.json({
    name: "pool-proxy",
    version: "1.0.0",
    status: "running",
    endpoints: {
      proxy: "/v1/chat/completions",
      anthropic: "/v1/messages",
      models: "/v1/models",
      accounts: "/api/accounts",
      stats: "/api/stats",
      settings: "/api/settings",
      auth: "/api/auth",
      health: "/api/health",
      websocket: "/ws",
    },
    wsClients: getClientCount(),
  });
});

// Public share page (connection details + usage, no raw secret). Rendered as
// plain HTML so it works without JS and never exposes the key value.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string
  ));
}

app.get("/s/:slug", async (c) => {
  const data = await getShareData(c.req.param("slug"));
  if (!data) {
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title>
      <style>body{font-family:ui-monospace,monospace;background:#0f1115;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}p{color:#8b949e}</style></head>
      <body><main><h1>Share not found</h1><p>This share page is disabled or never existed.</p></main></body></html>`,
      404
    );
  }

  const curl = `curl ${data.baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${data.name.replace(/[^a-zA-Z0-9_.-]/g, "-")}" \\
  -H "Content-Type: application/json" \\
  -d '{ "model": "claude-sonnet-4", "messages": [{"role":"user","content":"ping"}] }'`;

  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.name)} — API Endpoint</title>
<style>
  body{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;background:#0f1115;color:#c9d1d9;margin:0;line-height:1.55}
  main{max-width:720px;margin:0 auto;padding:48px 20px}
  h1{font-size:20px;margin:0 0 4px;color:#f0f6fc}
  .desc{color:#8b949e;margin:0 0 24px;font-size:13px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8b949e;margin:28px 0 8px}
  .box{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 16px;font-size:13px;word-break:break-all}
  .box small{display:block;color:#8b949e;font-size:11px;margin-top:8px}
  pre{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 16px;font-size:12px;overflow-x:auto;color:#7ee787}
  .row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #21262d;font-size:13px}
  .row:last-child{border-bottom:none}
  .row span{color:#8b949e}
  .ok{color:#3fb950;font-weight:600}
</style>
</head>
<body><main>
  <h1>${escapeHtml(data.name)}</h1>
  ${data.description ? `<p class="desc">${escapeHtml(data.description)}</p>` : `<p class="desc">Shared proxy API endpoint</p>`}
  <h2>Connection</h2>
  <div class="box">
    Base URL<br>
    <strong>${escapeHtml(data.baseUrl)}</strong>
    <small>Use this endpoint with any OpenAI-compatible client (chat completions, models, streaming). The API key is provided by the owner — it is never shown on this page.</small>
  </div>
  <h2>Example</h2>
  <pre>${escapeHtml(curl)}</pre>
  <h2>Usage</h2>
  <div class="row"><span>Requests</span><strong class="ok">${data.usage.monthlyRequests.toLocaleString()}</strong></div>
  <div class="row"><span>Tokens</span><strong class="ok">${data.usage.monthlyTokens.toLocaleString()}</strong></div>
</main></body></html>`);
});

// Serve dashboard static files (SPA fallback)
const dashboardDist = new URL("../dashboard/dist", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
const dashboardIndex = `${dashboardDist}/index.html`;

const staticMimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// Start server with WebSocket support
const server = Bun.serve({
  port: config.port,
  idleTimeout: 255,
  async fetch(req, server) {
    // Handle WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: {} });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Try Hono routes first (API, proxy, etc.)
    const response = await app.fetch(req, { ip: server.requestIP(req) });
    if (response.status !== 404) return response;

    // Fallback: serve dashboard static files
    const pathname = url.pathname;
    const filePath = `${dashboardDist}${pathname}`;
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const ext = pathname.slice(pathname.lastIndexOf("."));
      return new Response(file, {
        headers: {
          "Content-Type": staticMimeTypes[ext] || "application/octet-stream",
          // Don't cache HTML so rebuilt bundles are picked up on refresh.
          ...(ext === ".html" ? { "Cache-Control": "no-cache" } : {}),
        },
      });
    }

    // SPA fallback: serve index.html for non-file routes.
    // Missing .js/.css are old hashed bundles → 404 so the browser fetches
    // the current index and its fresh chunks instead of stale cached ones.
    if (pathname.includes(".")) {
      return new Response("Not Found", { status: 404 });
    }
    const indexFile = Bun.file(dashboardIndex);
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: websocketHandler,
});

console.log(`
╔══════════════════════════════════════════════════╗
║           🔄 Pool Proxy Server                   ║
╠══════════════════════════════════════════════════╣
║  HTTP:      http://localhost:${config.port}               ║
║  WebSocket: ws://localhost:${config.port}/ws              ║
║  Database:  SQLite                              ║
║  Dashboard: http://localhost:${config.dashboardPort}              ║
╠══════════════════════════════════════════════════╣
║  Endpoints:                                      ║
║    POST /v1/chat/completions  (proxy)            ║
║    POST /v1/messages          (Anthropic)        ║
║    GET  /v1/models            (models)           ║
║    GET  /api/accounts         (management)       ║
║    GET  /api/stats            (statistics)       ║
║    WS   /ws                   (real-time)        ║
╚══════════════════════════════════════════════════╝
`);

export default server;
