import { describe, test, expect } from "bun:test";
import {
  isPrivateIpv4,
  isPrivateIpv6,
  isPublicHostname,
  assertPublicUrl,
  safeFetch,
  SsrfError,
} from "./ssrf";

describe("isPrivateIpv4", () => {
  test("private ranges", () => {
    expect(isPrivateIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateIpv4("127.0.0.1")).toBe(true);
    expect(isPrivateIpv4("169.254.1.1")).toBe(true);
    expect(isPrivateIpv4("172.16.0.1")).toBe(true);
    expect(isPrivateIpv4("172.31.255.255")).toBe(true);
    expect(isPrivateIpv4("192.168.1.1")).toBe(true);
    expect(isPrivateIpv4("100.64.0.1")).toBe(true);
    expect(isPrivateIpv4("0.0.0.0")).toBe(true);
    expect(isPrivateIpv4("224.0.0.1")).toBe(true); // multicast
    expect(isPrivateIpv4("240.0.0.1")).toBe(true); // reserved
  });

  test("public addresses", () => {
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
    expect(isPrivateIpv4("1.1.1.1")).toBe(false);
    expect(isPrivateIpv4("93.91.112.247")).toBe(false);
    expect(isPrivateIpv4("172.32.0.1")).toBe(false); // just past 172.16/12
    expect(isPrivateIpv4("not-an-ip")).toBe(false);
  });
});

describe("isPrivateIpv6", () => {
  test("private/reserved IPv6", () => {
    expect(isPrivateIpv6("::1")).toBe(true);
    expect(isPrivateIpv6("::")).toBe(true);
    expect(isPrivateIpv6("fe80::1")).toBe(true); // link-local
    expect(isPrivateIpv6("fc00::1")).toBe(true); // unique local
    expect(isPrivateIpv6("fd12:3456::1")).toBe(true);
    expect(isPrivateIpv6("ff02::1")).toBe(true); // multicast
    expect(isPrivateIpv6("::ffff:127.0.0.1")).toBe(true); // v4-mapped loopback
    expect(isPrivateIpv6("::ffff:10.1.2.3")).toBe(true);
  });

  test("public IPv6", () => {
    expect(isPrivateIpv6("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateIpv6("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateIpv6("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("isPublicHostname", () => {
  test("rejects internal names", () => {
    expect(isPublicHostname("localhost")).toBe(false);
    expect(isPublicHostname("db")).toBe(false);
    expect(isPublicHostname("internal-host")).toBe(false);
    expect(isPublicHostname("127.0.0.1")).toBe(false);
    expect(isPublicHostname("10.0.0.5")).toBe(false);
  });

  test("accepts public names", () => {
    expect(isPublicHostname("api.openai.com")).toBe(true);
    expect(isPublicHostname("8.8.8.8")).toBe(true);
    expect(isPublicHostname("raw.githubusercontent.com")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  test("rejects private literal IPs", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:1930/api")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl("http://192.168.1.5/some")).rejects.toBeInstanceOf(SsrfError);
  });

  test("rejects non-http protocols", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl("ftp://example.com/x")).rejects.toBeInstanceOf(SsrfError);
  });

  test("rejects bad URLs", async () => {
    await expect(assertPublicUrl("not a url")).rejects.toBeInstanceOf(SsrfError);
  });

  test("accepts public https URLs", async () => {
    const host = await assertPublicUrl("https://api.openai.com/v1");
    expect(host).toBe("api.openai.com");
  });
});

describe("safeFetch", () => {
  test("rejects private target before any network call", async () => {
    await expect(safeFetch("http://127.0.0.1:1/x")).rejects.toBeInstanceOf(SsrfError);
  });

  test("bounded redirect chain via manual redirect", async () => {
    // Spawn a local server, but safeFetch must refuse it — prove the guard
    // fires for loopback listeners too.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok"),
    });
    try {
      await expect(safeFetch(`http://127.0.0.1:${server.port}/x`)).rejects.toBeInstanceOf(SsrfError);
    } finally {
      server.stop(true);
    }
  });
});