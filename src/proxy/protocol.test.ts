/**
 * Unit tests for proxy protocol detection (pure functions).
 *
 * Run with:  bun test src/proxy/protocol.test.ts
 */

import { describe, it, expect } from "bun:test";
import { detectProtocol, canonicalizeProxyUrl, normalizeProtocol } from "./protocol";

describe("detectProtocol", () => {
  it("detects known schemes", () => {
    expect(detectProtocol("http://proxy.example.com:8080")).toBe("http");
    expect(detectProtocol("https://proxy.example.com:8443")).toBe("https");
    expect(detectProtocol("socks5://1.2.3.4:1080")).toBe("socks5");
    expect(detectProtocol("socks4://1.2.3.4:1080")).toBe("socks4");
    expect(detectProtocol("socks4a://1.2.3.4:1080")).toBe("socks4a");
    expect(detectProtocol("socks5h://1.2.3.4:1080")).toBe("socks5h");
  });

  it("defaults bare host:port to http", () => {
    expect(detectProtocol("1.2.3.4:8080")).toBe("http");
    expect(detectProtocol("proxy.example.com:3128")).toBe("http");
  });

  it("aliases bare socks to socks5", () => {
    expect(detectProtocol("socks://1.2.3.4:1080")).toBe("socks5");
  });

  it("is case-insensitive on scheme", () => {
    expect(detectProtocol("SOCKS5://1.2.3.4:1080")).toBe("socks5");
    expect(detectProtocol("HTTP://proxy.example.com:8080")).toBe("http");
  });

  it("returns null for garbage / unsupported", () => {
    expect(detectProtocol("")).toBeNull();
    expect(detectProtocol("   ")).toBeNull();
    expect(detectProtocol("ftp://1.2.3.4:21")).toBeNull();
    expect(detectProtocol("not a url")).toBeNull();
    expect(detectProtocol("12345")).toBeNull();
  });
});

describe("canonicalizeProxyUrl", () => {
  it("preserves scheme + auth + port", () => {
    expect(canonicalizeProxyUrl("http://user:pass@host:8080")).toBe("http://user:pass@host:8080");
  });

  it("adds scheme to bare host:port", () => {
    expect(canonicalizeProxyUrl("host:3128")).toBe("http://host:3128");
  });

  it("normalizes scheme case and strips trailing slashes", () => {
    expect(canonicalizeProxyUrl("HTTPS://host:8443/")).toBe("https://host:8443");
  });

  it("returns null for unparseable", () => {
    expect(canonicalizeProxyUrl("garbage")).toBeNull();
    expect(canonicalizeProxyUrl("")).toBeNull();
  });
});

describe("normalizeProtocol", () => {
  it("maps aliases", () => {
    expect(normalizeProtocol("socks")).toBe("socks5");
    expect(normalizeProtocol("socks5h")).toBe("socks5h");
  });

  it("handles whitespace and case", () => {
    expect(normalizeProtocol("  HTTP ")).toBe("http");
  });

  it("returns null for unknown", () => {
    expect(normalizeProtocol("ftp")).toBeNull();
    expect(normalizeProtocol("")).toBeNull();
  });
});