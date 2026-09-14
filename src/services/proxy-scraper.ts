import { checkProxyHealth } from "./proxy-pool";

export type ScrapeSource =
  | "proxyscrape"
  | "geonode"
  | "proxifly"
  | "thespeedx"
  | "jetkai"
  | "iplocate"
  | "vpslab"
  | "hproxy"
  | "all";
export type ScrapeSourceId = Exclude<ScrapeSource, "all">;
export type ScrapeProtocol = "http" | "socks5" | "all";

export interface ScrapedProxy {
  url: string;
  type: "http" | "socks5";
  country: string | null;
}

export interface ScrapeOptions {
  source?: ScrapeSource;
  country?: string; // ISO-2 code (e.g. "US") or "all"
  protocol?: ScrapeProtocol;
  limit?: number;
}

/** Per-source result — surfaced to the dashboard so operators see which feeds worked. */
export interface ScrapeSourceResult {
  id: string;
  label: string;
  status: "fulfilled" | "failed" | "empty";
  count: number;
  error?: string;
}

export interface ScrapeSourceDescriptor {
  readonly id: ScrapeSourceId;
  readonly label: string;
  readonly countryAware: boolean;
  /** GitHub raw feeds keyed by protocol; used by non-API sources. */
  readonly feeds?: Readonly<Record<Exclude<ScrapeProtocol, "all">, string>>;
}

// Curated region list for the dashboard dropdown. Any ISO-2 code works with
// ProxyScrape/Geonode, but these cover the common cases.
export const COUNTRIES: { code: string; name: string }[] = [
  { code: "all", name: "Any region" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "CA", name: "Canada" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "RU", name: "Russia" },
  { code: "ID", name: "Indonesia" },
  { code: "SG", name: "Singapore" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "IN", name: "India" },
  { code: "CN", name: "China" },
  { code: "HK", name: "Hong Kong" },
  { code: "BR", name: "Brazil" },
  { code: "AU", name: "Australia" },
  { code: "TR", name: "Turkey" },
  { code: "VN", name: "Vietnam" },
  { code: "TH", name: "Thailand" },
  { code: "PL", name: "Poland" },
  { code: "UA", name: "Ukraine" },
  { code: "MX", name: "Mexico" },
];

/**
 * Source catalog. API-backed sources (proxyscrape/geonode/proxifly) are
 * implemented below as functions; GitHub-feed sources share one fetcher.
 * Modeled after Cartethyia's SCRAPE_SOURCE_CATALOG.
 */
export const SCRAPE_SOURCE_CATALOG: readonly ScrapeSourceDescriptor[] = [
  { id: "proxyscrape", label: "ProxyScrape", countryAware: true },
  { id: "geonode", label: "Geonode", countryAware: true },
  { id: "proxifly", label: "Proxifly", countryAware: true },
  {
    id: "thespeedx",
    label: "TheSpeedX",
    countryAware: false,
    feeds: {
      http: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
      socks5: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    },
  },
  {
    id: "jetkai",
    label: "Jetkai",
    countryAware: false,
    feeds: {
      http: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",
      socks5: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt",
    },
  },
  {
    id: "iplocate",
    label: "IPLocate",
    countryAware: false,
    feeds: {
      http: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt",
      socks5: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt",
    },
  },
  {
    id: "vpslab",
    label: "VPSLab",
    countryAware: false,
    feeds: {
      http: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/main/http_all.txt",
      socks5: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/main/socks5_all.txt",
    },
  },
  {
    id: "hproxy",
    label: "HProxy",
    countryAware: false,
    feeds: {
      http: "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/http.txt",
      socks5: "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/socks5.txt",
    },
  },
];

const FETCH_TIMEOUT_MS = 20_000;

function normalizeProtocol(scheme: string): "http" | "socks5" | null {
  const s = scheme.toLowerCase();
  if (s === "http" || s === "https") return "http";
  if (s === "socks5" || s === "socks5h") return "socks5";
  return null; // socks4 and anything else are unsupported downstream
}

// Parse a "protocol://ip:port" line into a normalized proxy entry.
function parseProxyLine(line: string, country: string | null): ScrapedProxy | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([a-z0-9]+):\/\/([^/\s]+)$/i);
  if (!match) return null;
  const [, scheme, hostPort] = match;
  if (!scheme || !hostPort) return null;
  const type = normalizeProtocol(scheme);
  if (!type) return null;
  if (!/^[^:]+:\d+$/.test(hostPort)) return null; // must be host:port
  return { url: `${type}://${hostPort}`, type, country };
}

// Parse a bare "ip:port" line (GitHub proxy-list feeds have no scheme).
// Defaults to the feed's known protocol.
function parseHostPortLine(line: string, country: string | null, type: "http" | "socks5"): ScrapedProxy | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!/^[^:\s]+:\d+$/.test(trimmed)) return null; // must be host:port
  return { url: `${type}://${trimmed}`, type, country };
}

async function fetchText(url: string): Promise<string> {
  const { safeFetch } = await import("../utils/ssrf");
  const res = await safeFetch(url, {}, { timeoutMs: FETCH_TIMEOUT_MS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// --- Sources ---------------------------------------------------------------

async function scrapeProxyScrape(country: string, protocol: ScrapeProtocol): Promise<ScrapedProxy[]> {
  const params = new URLSearchParams({
    request: "display_proxies",
    proxy_format: "protocolipport",
    format: "text",
  });
  if (country !== "all") params.set("country", country.toLowerCase());
  if (protocol !== "all") params.set("protocol", protocol);

  const text = await fetchText(`https://api.proxyscrape.com/v4/free-proxy-list/get?${params}`);
  const countryTag = country !== "all" ? country.toUpperCase() : null;
  return text
    .split("\n")
    .map((line) => parseProxyLine(line, countryTag))
    .filter((p): p is ScrapedProxy => p !== null);
}

async function scrapeGeonode(country: string, protocol: ScrapeProtocol): Promise<ScrapedProxy[]> {
  const params = new URLSearchParams({
    limit: "500",
    page: "1",
    sort_by: "lastChecked",
    sort_type: "desc",
  });
  if (country !== "all") params.set("country", country.toUpperCase());
  if (protocol !== "all") params.set("protocols", protocol);

  const text = await fetchText(`https://proxylist.geonode.com/api/proxy-list?${params}`);
  const json = JSON.parse(text) as {
    data?: { ip: string; port: string; protocols?: string[]; country?: string }[];
  };
  const out: ScrapedProxy[] = [];
  for (const row of json.data ?? []) {
    if (!row.ip || !row.port) continue;
    const proto = (row.protocols ?? []).map((p) => normalizeProtocol(p)).find(Boolean);
    if (!proto) continue;
    if (protocol !== "all" && proto !== protocol) continue;
    out.push({ url: `${proto}://${row.ip}:${row.port}`, type: proto, country: row.country ?? null });
  }
  return out;
}

async function scrapeProxifly(country: string, protocol: ScrapeProtocol): Promise<ScrapedProxy[]> {
  const path =
    country !== "all"
      ? `proxies/countries/${country.toUpperCase()}/data.txt`
      : "proxies/all/data.txt";
  const text = await fetchText(`https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/${path}`);
  const countryTag = country !== "all" ? country.toUpperCase() : null;
  return text
    .split("\n")
    .map((line) => parseProxyLine(line, countryTag))
    .filter((p): p is ScrapedProxy => p !== null)
    .filter((p) => protocol === "all" || p.type === protocol);
}

/** Fetch a GitHub raw feed; country-aware sources get a country filter, others share one global list. */
async function scrapeFeed(
  descriptor: ScrapeSourceDescriptor,
  country: string,
  protocol: ScrapeProtocol,
): Promise<ScrapedProxy[]> {
  if (!descriptor.feeds) return [];
  // Non-country-aware sources have no per-region lists — a region request
  // yields nothing (strict), same trade as Cartethyia.
  if (country !== "all" && !descriptor.countryAware) return [];

  const types = protocol === "all" ? (["http", "socks5"] as const) : ([protocol] as const);
  const lines = await Promise.all(
    types.map(async (type) => {
      const feed = descriptor.feeds![type];
      const text = await fetchText(feed);
      return text
        .split("\n")
        .map((line) => parseHostPortLine(line, null, type))
        .filter((p): p is ScrapedProxy => p !== null);
    }),
  );
  return lines.flat();
}

// --- Orchestration ---------------------------------------------------------

function interleaveBatches(batches: ScrapedProxy[][], limit: number): ScrapedProxy[] {
  // Round-robin across batches so a huge feed doesn't starve smaller ones.
  const seen = new Set<string>();
  const out: ScrapedProxy[] = [];
  let cursor = 0;
  let progress = true;
  while (out.length < limit && progress) {
    progress = false;
    for (const batch of batches) {
      if (cursor >= batch.length) continue;
      const proxy = batch[cursor];
      if (proxy && !seen.has(proxy.url)) {
        seen.add(proxy.url);
        out.push(proxy);
        if (out.length >= limit) break;
      }
      progress = true;
    }
    cursor++;
  }
  return out;
}

/**
 * Scrape proxies from one or all free sources, filtered by region and protocol.
 * De-duplicates by URL. Failed sources are skipped — a single dead feed never
 * sinks the whole request, and each source's status is reported so the
 * dashboard can show what worked.
 */
export async function scrapeProxiesDetailed(
  options: ScrapeOptions = {},
): Promise<{ proxies: ScrapedProxy[]; sources: ScrapeSourceResult[] }> {
  const { source = "all", country = "all", protocol = "all", limit = 100 } = options;
  const selected = SCRAPE_SOURCE_CATALOG.filter((s) => source === "all" || s.id === source);

  const tasks = selected.map(async (descriptor): Promise<[ScrapeSourceDescriptor, ScrapedProxy[]]> => {
    try {
      const proxies =
        descriptor.id === "proxyscrape"
          ? await scrapeProxyScrape(country, protocol)
          : descriptor.id === "geonode"
            ? await scrapeGeonode(country, protocol)
            : descriptor.id === "proxifly"
              ? await scrapeProxifly(country, protocol)
              : await scrapeFeed(descriptor, country, protocol);
      return [descriptor, proxies];
    } catch (err) {
      throw new Error(`${descriptor.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const settled = await Promise.allSettled(tasks);

  const sources: ScrapeSourceResult[] = settled.map((result, i) => {
    const descriptor = selected[i];
    if (result.status === "rejected") {
      return {
        id: descriptor?.id ?? "unknown",
        label: descriptor?.label ?? "unknown",
        status: "failed",
        count: 0,
        error: String(result.reason?.message ?? result.reason).slice(0, 200),
      };
    }
    const [, proxies] = result.value;
    return {
      id: descriptor?.id ?? "unknown",
      label: descriptor?.label ?? "unknown",
      status: proxies.length > 0 ? "fulfilled" : "empty",
      count: proxies.length,
    };
  });

  const batches = settled
    .filter((r): r is PromiseFulfilledResult<[ScrapeSourceDescriptor, ScrapedProxy[]]> => r.status === "fulfilled")
    .map((r) => r.value[1]);

  return { proxies: interleaveBatches(batches, limit), sources };
}

/**
 * Convenience wrapper — returns just the merged proxies (source diagnostics
 * discarded). Kept for call-sites that don't need per-source status.
 */
export async function scrapeProxies(options: ScrapeOptions = {}): Promise<ScrapedProxy[]> {
  return (await scrapeProxiesDetailed(options)).proxies;
}

/**
 * Health-check scraped proxies with bounded concurrency, keeping only the ones
 * that respond. Used when the caller asks to verify before adding to the pool.
 */
export async function verifyProxies(
  proxies: ScrapedProxy[],
  concurrency = 20,
): Promise<ScrapedProxy[]> {
  const alive: ScrapedProxy[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < proxies.length) {
      const proxy = proxies[cursor++];
      if (!proxy) break;
      const result = await checkProxyHealth(proxy.url);
      if (result.ok) alive.push(proxy);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, proxies.length) }, worker);
  await Promise.all(workers);
  return alive;
}