import { Hono } from "hono";
import { db } from "../db/index";
import { proxyPool } from "../db/schema";
import { eq, desc, sql, inArray } from "drizzle-orm";
import {
  getNextProxy,
  markProxySuccess,
  markProxyFail,
  checkProxyHealth,
  invalidateProxyCache,
} from "../services/proxy-pool";
import { detectProtocol, canonicalizeProxyUrl } from "../proxy/protocol";
import {
  scrapeProxiesDetailed,
  verifyProxies,
  COUNTRIES,
  type ScrapeSource,
  type ScrapeProtocol,
} from "../services/proxy-scraper";

export const proxyPoolRouter = new Hono();

proxyPoolRouter.get("/pool", async (c) => {
  const proxies = await db
    .select()
    .from(proxyPool)
    .orderBy(desc(proxyPool.priority), desc(proxyPool.createdAt));

  return c.json({
    count: proxies.length,
    activeCount: proxies.filter((p) => p.status === "active").length,
    proxies,
  });
});

proxyPoolRouter.post("/pool", async (c) => {
  const body = await c.req.json<{ proxies: string[]; priority?: number; usage?: string }>();
  if (!Array.isArray(body.proxies) || body.proxies.length === 0) {
    return c.json({ error: "proxies must be a non-empty array of URLs" }, 400);
  }
  const usage = body.usage === "model" || body.usage === "auth" ? body.usage : "all";

  // Detect protocol + canonicalize; skip unparseable entries.
  const entries: Array<{ url: string; type: string; label: string; priority: number; usage: string }> = [];
  const seen = new Set<string>();
  for (const raw of body.proxies) {
    const url = canonicalizeProxyUrl(raw);
    if (!url) continue;
    if (seen.has(url)) continue; // dedupe within this batch
    seen.add(url);
    entries.push({
      url,
      type: detectProtocol(url) || "http",
      label: new URL(url).hostname || url,
      priority: Number.isFinite(body.priority) ? Math.max(0, Math.floor(body.priority || 0)) : 0,
      usage,
    });
  }

  // Dedupe against rows already in the pool.
  const existing =
    entries.length > 0
      ? await db
          .select({ url: proxyPool.url })
          .from(proxyPool)
          .where(inArray(proxyPool.url, entries.map((e) => e.url)))
      : [];
  const existingSet = new Set(existing.map((e) => e.url));
  const toInsert = entries.filter((e) => !existingSet.has(e.url));

  if (toInsert.length > 0) {
    await db.insert(proxyPool).values(toInsert);
  }

  invalidateProxyCache();
  return c.json({ added: toInsert.length, skipped: entries.length - toInsert.length, invalid: body.proxies.length - entries.length });
});

proxyPoolRouter.put("/pool/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ status?: string; label?: string; priority?: number; usage?: string }>();

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (body.status) updates.status = body.status;
  if (body.label !== undefined) updates.label = body.label;
  if (body.usage === "all" || body.usage === "model" || body.usage === "auth") {
    updates.usage = body.usage;
  }
  if (body.priority !== undefined) {
    updates.priority = Number.isFinite(body.priority) ? Math.max(0, Math.floor(body.priority)) : 0;
  }

  await db.update(proxyPool).set(updates).where(eq(proxyPool.id, id));
  invalidateProxyCache();

  return c.json({ success: true });
});

proxyPoolRouter.delete("/pool/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(proxyPool).where(eq(proxyPool.id, id));
  invalidateProxyCache();
  return c.json({ success: true });
});

proxyPoolRouter.delete("/pool", async (c) => {
  await db.delete(proxyPool);
  invalidateProxyCache();
  return c.json({ success: true });
});

proxyPoolRouter.post("/pool/:id/check", async (c) => {
  const id = Number(c.req.param("id"));
  const [proxy] = await db.select().from(proxyPool).where(eq(proxyPool.id, id));
  if (!proxy) return c.json({ error: "Proxy not found" }, 404);

  const result = await checkProxyHealth(proxy.url);

  await db
    .update(proxyPool)
    .set({
      status: result.ok ? "active" : "error",
      errorMessage: result.error || null,
      latencyMs: result.latencyMs,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proxyPool.id, id));

  invalidateProxyCache();
  return c.json({ id, ...result });
});

proxyPoolRouter.post("/pool/check-all", async (c) => {
  // ponytail: include error so failures can recover; disabled stays manual-only.
  const proxies = await db
    .select()
    .from(proxyPool)
    .where(inArray(proxyPool.status, ["active", "error"]));

  const results: Array<{ id: number; url: string; ok: boolean; latencyMs: number; error?: string; ip?: string }> = [];
  let cursor = 0;
  // ponytail: bounded workers like verifyProxies — unbounded spawn + parallel SQLite writes = SQLITE_BUSY.
  const CONCURRENCY = 10;

  async function worker() {
    while (cursor < proxies.length) {
      const proxy = proxies[cursor++];
      if (!proxy) break;
      try {
        const result = await checkProxyHealth(proxy.url);
        await db
          .update(proxyPool)
          .set({
            status: result.ok ? "active" : "error",
            errorMessage: result.error || null,
            latencyMs: result.latencyMs,
            lastCheckedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proxyPool.id, proxy.id));
        results.push({ id: proxy.id, url: proxy.url, ...result });
      } catch (err) {
        results.push({
          id: proxy.id,
          url: proxy.url,
          ok: false,
          latencyMs: 0,
          error: err instanceof Error ? err.message : "check failed",
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(proxies.length, 1)) }, worker),
  );

  invalidateProxyCache();
  const ok = results.filter((r) => r.ok).length;
  return c.json({
    checked: results.length,
    ok,
    failed: results.length - ok,
    results,
  });
});

// List the regions available for scraping (for the dashboard dropdown).
proxyPoolRouter.get("/scrape/countries", (c) => {
  return c.json({ countries: COUNTRIES });
});

// Scrape proxies from free sources, optionally filtered by region/protocol,
// optionally health-verified, then add the survivors to the pool.
proxyPoolRouter.post("/scrape", async (c) => {
  const body = await c.req.json<{
    source?: ScrapeSource;
    country?: string;
    protocol?: ScrapeProtocol;
    limit?: number;
    verify?: boolean;
  }>().catch(() => ({} as Record<string, never>));

  const source = (body.source ?? "all") as ScrapeSource;
  const country = body.country ?? "all";
  const protocol = (body.protocol ?? "all") as ScrapeProtocol;
  const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500);
  const verify = body.verify !== false; // verify by default

  let { proxies: scraped, sources } = await scrapeProxiesDetailed({ source, country, protocol, limit });
  const scrapedCount = scraped.length;

  if (scrapedCount === 0) {
    return c.json({ scraped: 0, verified: 0, added: 0, skipped: 0, proxies: [], sources });
  }

  // Health-check before adding so the pool only gets working proxies.
  let verifiedCount = scrapedCount;
  if (verify) {
    scraped = await verifyProxies(scraped);
    verifiedCount = scraped.length;
  }

  // Skip proxies already in the pool (dedupe by URL).
  const urls = scraped.map((p) => p.url);
  const existing =
    urls.length > 0
      ? await db
          .select({ url: proxyPool.url })
          .from(proxyPool)
          .where(inArray(proxyPool.url, urls))
      : [];
  const existingSet = new Set(existing.map((e) => e.url));

  const toInsert = scraped.filter((p) => !existingSet.has(p.url));
  if (toInsert.length > 0) {
    await db.insert(proxyPool).values(
      toInsert.map((p) => ({
        url: p.url,
        type: p.type,
        label: p.country ? `scraped:${p.country}` : "scraped",
      })),
    );
    invalidateProxyCache();
  }

  return c.json({
    scraped: scrapedCount,
    verified: verifiedCount,
    added: toInsert.length,
    skipped: verifiedCount - toInsert.length,
    sources,
  });
});
