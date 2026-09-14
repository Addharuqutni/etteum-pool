/**
 * Proxy protocol detection — pure, no I/O. Normalizes a proxy URL string
 * into a protocol tag + canonical URL.
 *
 * Supported: http, https, socks4, socks4a, socks5, socks5h. Bare
 * `host:port` (no scheme) defaults to http, matching curl's behavior.
 * Extras (user:pass auth, trailing path) are preserved.
 */

export type ProxyProtocol = "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h";

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

const PROTOCOL_ALIASES: Record<string, ProxyProtocol> = {
  http: "http",
  https: "https",
  socks: "socks5",
  socks4: "socks4",
  socks4a: "socks4a",
  socks5: "socks5",
  "socks5h": "socks5h",
};

/** A proxy protocol accepted for upstream `--proxy` use (curl supports all of these). */
const SUPPORTED = new Set<string>(["http", "https", "socks4", "socks4a", "socks5", "socks5h"]);

export function normalizeProtocol(raw: string): ProxyProtocol | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  return PROTOCOL_ALIASES[lower] ?? null;
}

/** Detect the protocol of a proxy URL string. Returns null for garbage input. */
export function detectProtocol(url: string): ProxyProtocol | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  const schemeMatch = SCHEME_RE.exec(trimmed);
  if (schemeMatch) {
    const proto = normalizeProtocol(schemeMatch[1] ?? "");
    if (!proto || !SUPPORTED.has(proto)) return null; // unknown/unsupported scheme
    return proto;
  }

  // Bare host:port — guess http (curl default). Validate shape loosely:
  // something that contains a colon and no whitespace.
  if (/^[^\s/]+:\d+$/.test(trimmed)) return "http";
  return null;
}

/** Canonicalize a proxy URL: lowercase scheme, ensure `://`, strip trailing slash. */
export function canonicalizeProxyUrl(raw: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const schemeMatch = SCHEME_RE.exec(trimmed);
  if (schemeMatch) {
    const proto = normalizeProtocol(schemeMatch[1] ?? "");
    if (!proto) return null;
    return `${proto}://${trimmed.slice(schemeMatch[0].length)}`.replace(/\/+$/, "");
  }

  if (/^[^\s/]+:\d+$/.test(trimmed)) {
    return `http://${trimmed.replace(/\/+$/, "")}`;
  }
  return null;
}