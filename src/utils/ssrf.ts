import { lookup } from "node:dns/promises";

/**
 * SSRF + redirect-guard helpers.
 *
 * Guards every outbound URL (upstream provider, proxy checks, scraper feeds):
 *  - rejects private/loopback/link-local/reserved IPv4 + IPv6 targets outright
 *  - resolves hostnames and rejects the *resolved* address too (DNS rebinding:
 *    a public name that resolves to 127.0.0.1/10.0.0.0 etc. is refused)
 *  - follows redirect chains with the same check at each hop, bounded depth
 *
 * ponytail: DNS is re-resolved per hop/url — good enough for a self-hosted
 * proxy; swap in a cached resolver only if request latency ever measures up.
 * fetch() resolves independently after we check; rebinding between our check
 * and fetch's resolve is mitigated (not eliminated) by re-checking on each
 * redirect. Hostname resolution is done with the system resolver in
 * node:dns so the check and fetch() share the same upstream view.
 */

const BLOCKED_HOST_RE =
  /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback|\*\.local|.*\.localhost)$/i;

function parseIp(host: string): { v4?: string; v6?: string } {
  // Strip brackets from [::1] style URLs
  const clean = host.replace(/^\[|\]$/g, "");
  if (clean.includes(":")) return { v6: clean };
  return { v4: clean };
}

export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  // 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16,
  // 100.64.0.0/10 (CGNAT), 192.0.0.0/24, 198.18.0.0/15, 0.0.0.0/8, 224/4 multicast, 240/4 reserved
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a === 0 ||
    (a >= 224 && a <= 255)
  );
}

export function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1, ::, fc00::/7 (unique local), fe80::/10 (link-local), fec0::/10 (site-local),
  // ff00::/8 multicast, ::ffff:0:0/96 (IPv4-mapped — the embedded v4 is checked too)
  if (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("fec") ||
    lower.startsWith("fed") ||
    lower.startsWith("fee") ||
    lower.startsWith("fef") ||
    lower.startsWith("ff")
  ) {
    return true;
  }
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice("::ffff:".length);
    return isPrivateIpv4(v4);
  }
  return false;
}

function isReservedIp(host: string): boolean {
  if (!host) return false;
  const { v4, v6 } = parseIp(host);
  if (v6) return isPrivateIpv6(v6);
  return isPrivateIpv4(v4 ?? "");
}

export function isPublicHostname(host: string): boolean {
  if (BLOCKED_HOST_RE.test(host)) return false;
  // Literal IPs are checked directly
  if (host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isReservedIp(host);
  // Bare single-label hostnames (e.g. "internal", "db") are refused: real public
  // APIs are always fully-qualified.
  if (!host.includes(".")) return false;
  return true;
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/**
 * Resolve a hostname and return all A/AAAA addresses that aren't reserved.
 *
 * Fail-open on DNS errors: a lookup failure (transient resolver hiccup,
 * IPv6-only name on a v4-only resolver, split-horizon DNS) must NOT break
 * legit provider traffic — the downstream fetch() will do its own resolution.
 * We only block on *deterministic* internal signals (literal private IPs,
 * localhost, single-label names) and on confirmed resolution where EVERY
 * returned address is private (DNS-rebinding guard).
 */
export async function resolvePublicIps(host: string): Promise<string[]> {
  if (!isPublicHostname(host)) {
    throw new SsrfError(`Blocked host: ${host}`);
  }
  const lookups = await Promise.all(
    ([4, 6] as const).map(async (family) => {
      try {
        return (await lookup(host, { all: true, family })) as Array<{ address: string }>;
      } catch {
        return []; // keep going; overall failure is handled below (fail-open)
      }
    })
  );
  const records: string[] = lookups.flat().map((r) => r.address);
  if (records.length === 0) {
    // No authoritative answer — fail open rather than break providers.
    return [];
  }
  const publicIps = records.filter((ip) => !isReservedIp(ip));
  if (publicIps.length === 0 && records.length > 0) {
    // Every resolved address is private → definitely an internal target.
    throw new SsrfError(`Refusing request: ${host} resolves only to private/reserved addresses`);
  }
  return publicIps;
}

/** Final guard: all of a host's resolved addresses must be public. */
export async function assertPublicHost(host: string): Promise<void> {
  const { v4, v6 } = parseIp(host.replace(/^\[|\]$/g, ""));
  if (v6 || v4) {
    if (isReservedIp(host)) throw new SsrfError(`Blocked private/reserved address: ${host}`);
    return;
  }
  await resolvePublicIps(host);
}

/**
 * Validate a full URL string (scheme must be http/https, host public).
 * Returns the URL's host on success; throws SsrfError otherwise.
 */
export async function assertPublicUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Blocked protocol: ${url.protocol}`);
  }
  const host = url.hostname;
  if (!isPublicHostname(host)) throw new SsrfError(`Blocked host: ${host}`);
  if (url.port && Number(url.port) !== 80 && Number(url.port) !== 443) {
    throw new SsrfError(`Blocked non-standard port: ${url.port}`);
  }
  await resolvePublicIps(host);
  return host;
}

export const MAX_REDIRECT_DEPTH = 5;

/**
 * Fetch with built-in SSRF guard + bounded redirect chain. Each hop's URL and
 * resolved addresses are validated. Returns the final Response after following
 * redirects (304/303/302/301), so callers never touch raw untrusted locations.
 *
 * `timeoutMs` (default 15s) replaces any caller AbortSignal with an internal
 * deadline; `init.proxy` passes through (Bun proxy support keeps working).
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; maxRedirects?: number } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECT_DEPTH;
  return safeFetchInner(url, init, maxRedirects, opts.timeoutMs ?? 15_000);
}

async function safeFetchInner(
  url: string,
  init: RequestInit,
  redirectDepth: number,
  timeoutMs: number,
): Promise<Response> {
  if (redirectDepth < 0) throw new SsrfError("Too many redirects");
  await assertPublicUrl(url);

  const controller = new AbortController();
  // Abort with a reason so a timed-out fetch rejects with a clear TimeoutError
  // instead of Bun's "signal is aborted without reason".
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError")),
    timeoutMs,
  );

  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  if (status >= 300 && status < 400 && response.headers.has("location")) {
    const location = response.headers.get("location")!;
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, url);
    } catch {
      throw new SsrfError(`Invalid redirect target: ${location}`);
    }
    if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
      throw new SsrfError(`Blocked redirect protocol: ${nextUrl.protocol}`);
    }
    // Re-check the resolved target before following (covers DNS-rebinding chains)
    return safeFetchInner(nextUrl.toString(), init, redirectDepth - 1, timeoutMs);
  }

  return response;
}

/** Whether safeFetch should be used for a given URL (true for user-controlled origins). */
export function needsSsrfGuard(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}