/**
 * Dual base-URL failover for the CodeBuddy Global provider.
 *
 * The provider has two candidate hosts:
 *   - primary  : https://www.workbuddy.ai
 *   - fallback : https://www.codebuddy.ai
 *
 * Failover happens ONLY on network/transient failures — a thrown fetch error
 * (DNS / connection refused / timeout), HTTP 5xx, HTTP 404 and HTTP 405. The two
 * hosts are separate deployments, so one refusing a route does not mean the
 * other will; conversely an account/payload error (400/401/403/429) is answered
 * identically by both, so retrying the peer only doubles the latency (and the
 * auth / rate-limit pressure) for a turn that cannot succeed.
 *
 * The `X-Domain` request header identifies the host being called, so it MUST
 * follow whichever base URL the request actually went to — not the primary.
 *
 * OAuth/device-flow and token refresh stay pinned to the primary host: a login
 * session lives on one deployment only, so walking hosts there would just burn
 * the auth round-trips.
 *
 * Everything here runs against a stubbed protected HTTP seam
 * (`fetchWithTimeout`) — no test touches the real network.
 *
 * Run with:  bun test test/proxy/codebuddy-intl-failover.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  CodeBuddyProvider,
  CODEBUDDY_BASE_URLS,
  CODEBUDDY_OAUTH,
  CODEBUDDY_PRIMARY_BASE_URL,
  codebuddyDomain,
  refreshCodebuddyToken,
  shouldFailoverStatus,
} from "../../src/proxy/providers/codebuddy";
import type { ChatCompletionRequest } from "../../src/proxy/providers/base";
import type { Account } from "../../src/db/schema";

const PRIMARY_URL = "https://www.workbuddy.ai";
const FALLBACK_URL = "https://www.codebuddy.ai";
const PRIMARY_HOST = "www.workbuddy.ai";
const FALLBACK_HOST = "www.codebuddy.ai";
const CHAT_PATH = "/v2/chat/completions";

type ProviderWithFetch = CodeBuddyProvider & {
  fetchWithTimeout: (url: string, init: RequestInit, timeoutMs?: number) => Promise<Response>;
};

/** One recorded call the provider made through the HTTP seam. */
interface RecordedCall {
  url: string;
  host: string;
  /** Normalized `X-Domain` header value, or `null` when the header was absent. */
  domain: string | null;
}

/** What the stub should do for one call: reply, or blow up like a dead socket. */
type StubStep =
  | { kind: "response"; response: Response }
  | { kind: "throw"; error: Error };

/** A 200 SSE answer — enough for `chatCompletion` to succeed end to end. */
function streamOkResponse(): Response {
  const event = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "claude-opus",
    choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  }) as unknown as Response;
}

/** A non-OK upstream reply. */
function errorResponse(status: number, body: string): Response {
  return new Response(body, { status }) as unknown as Response;
}

/** `X-Domain` is a plain object today but may become `Headers`/`[string,string][]`. */
function readDomainHeader(headers: RequestInit["headers"]): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get("X-Domain");
  if (Array.isArray(headers)) {
    for (const [key, value] of headers as [string, string][]) {
      if (key.toLowerCase() === "x-domain") return value;
    }
    return null;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === "x-domain") return value;
  }
  return null;
}

/** Host of a recorded URL — `<unparseable>` keeps a bad URL visible, not invisible. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<unparseable>";
  }
}

/**
 * Build a provider whose HTTP seam replays `steps` in call order while recording
 * every URL and `X-Domain` it was asked for. The final step repeats forever, so
 * an unexpected extra call is visible in `calls` instead of throwing.
 */
function stubProvider(steps: StubStep[]): { provider: ProviderWithFetch; calls: RecordedCall[] } {
  if (steps.length === 0) throw new Error("stubProvider called with no steps");
  const calls: RecordedCall[] = [];
  let index = 0;
  const provider = new CodeBuddyProvider() as ProviderWithFetch;

  provider.fetchWithTimeout = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, host: hostOf(url), domain: readDomainHeader(init.headers) });

    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (!step) throw new Error("stubProvider exhausted");

    if (step.kind === "throw") throw step.error;
    return step.response.clone() as unknown as Response;
  };

  return { provider, calls };
}

/**
 * The chat endpoint on each candidate host, in the order the provider should
 * try them. `CODEBUDDY_BASE_URLS` is the feature's own contract, so the tests
 * assert against it rather than against a private field.
 */
function candidateUrls(): { primary: string; fallback: string } {
  const urls = CODEBUDDY_BASE_URLS.map((base: string) => `${base}${CHAT_PATH}`);
  if (urls.length !== 2) {
    throw new Error(
      `expected exactly 2 candidate base URLs in CODEBUDDY_BASE_URLS, got ${CODEBUDDY_BASE_URLS.length}`,
    );
  }
  return { primary: urls[0]!, fallback: urls[1]! };
}

function makeAccount(): Account {
  return {
    id: 1,
    provider: "codebuddy",
    email: "test@example.com",
    password: "x",
    status: "active",
    enabled: true,
    tokens: JSON.stringify({ api_key: "test-key" }),
    createdAt: new Date(),
  } as Account;
}

function makeRequest(): ChatCompletionRequest {
  return { model: "cb-claude-opus", messages: [{ role: "user", content: "hi" }] };
}

/**
 * Every call this provider makes must name its own host in `X-Domain`: upstream
 * picks the tenant/region from that header, so a mismatch fails auth even with
 * a valid key.
 */
function expectDomainMatchesHost(calls: RecordedCall[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.domain).toBe(call.host);
  }
}

/** Drain a stream so the SSE loop reads its upstream body before the test ends. */
async function drain(result: { stream?: ReadableStream<Uint8Array> }): Promise<void> {
  if (!result.stream) return;
  const reader = result.stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

/**
 * Neutralize the 401/403 refresh-and-retry path so a test can observe the
 * failover decision alone (stubbed to fail, so `chatCompletion` terminates).
 */
function withoutRefresh(provider: ProviderWithFetch): ProviderWithFetch {
  provider.refreshToken = async () => ({ success: false, error: "no refresh" });
  return provider;
}

describe("CodeBuddyProvider dual base-URL failover", () => {
  test("exports the primary and fallback base URLs in order", () => {
    expect(CODEBUDDY_BASE_URLS.length).toBe(2);
    expect(CODEBUDDY_BASE_URLS[0]).toBe(PRIMARY_URL);
    expect(CODEBUDDY_BASE_URLS[1]).toBe(FALLBACK_URL);
    expect(CODEBUDDY_PRIMARY_BASE_URL).toBe(PRIMARY_URL);
    expect(candidateUrls()).toEqual({
      primary: PRIMARY_URL + CHAT_PATH,
      fallback: FALLBACK_URL + CHAT_PATH,
    });
  });

  test("classifies only host-scoped failures as failover-worthy", () => {
    // Transient / host-level: the peer host can still serve this account.
    expect(shouldFailoverStatus(500)).toBe(true);
    expect(shouldFailoverStatus(502)).toBe(true);
    expect(shouldFailoverStatus(503)).toBe(true);
    // ~12s openresty/APISIX 504s show up transiently on the chat route of BOTH
    // hosts, so it is a host-scoped retryable, not evidence one host is down.
    expect(shouldFailoverStatus(504)).toBe(true);
    expect(shouldFailoverStatus(404)).toBe(true);
    expect(shouldFailoverStatus(405)).toBe(true);
    // Account/payload-level: identical answer from the peer host.
    expect(shouldFailoverStatus(400)).toBe(false);
    expect(shouldFailoverStatus(401)).toBe(false);
    expect(shouldFailoverStatus(403)).toBe(false);
    expect(shouldFailoverStatus(429)).toBe(false);
    expect(shouldFailoverStatus(200)).toBe(false);
  });

  test("stays on the primary host (and its X-Domain) when it succeeds", async () => {
    const { provider, calls } = stubProvider([{ kind: "response", response: streamOkResponse() }]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(true);
    await drain(result);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(candidateUrls().primary);
    expect(calls[0]!.domain).toBe(PRIMARY_HOST);
    expect(calls.filter((call) => call.host === FALLBACK_HOST).length).toBe(0);
  });

  test("falls back for a thrown network error and reports success from the fallback", async () => {
    const { provider, calls } = stubProvider([
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "response", response: streamOkResponse() },
    ]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(true);
    await drain(result);

    expect(calls.map((call) => call.url)).toEqual([PRIMARY_URL + CHAT_PATH, FALLBACK_URL + CHAT_PATH]);
  });

  test("falls back for a timeout-style abort from the primary", async () => {
    // `fetchWithTimeout` enforces its deadline inside safeFetch and rethrows, so
    // an upstream timeout arrives here as a thrown abort — not as a response.
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "AbortError",
    });
    const { provider, calls } = stubProvider([
      { kind: "throw", error: timeout },
      { kind: "response", response: streamOkResponse() },
    ]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(true);
    await drain(result);
    expect(calls.map((call) => call.host)).toEqual([PRIMARY_HOST, FALLBACK_HOST]);
  });

  test("sends an X-Domain header matching the host actually called", async () => {
    const { provider, calls } = stubProvider([
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "response", response: streamOkResponse() },
    ]);
    await provider.chatCompletion(makeAccount(), makeRequest());

    expect(calls.length).toBe(2);
    expect(calls[0]!.host).toBe(PRIMARY_HOST);
    expect(calls[0]!.domain).toBe(PRIMARY_HOST);
    // The regression this guards: a hardcoded intl X-Domain riding along with a
    // request that actually went to the fallback host.
    expect(calls[1]!.host).toBe(FALLBACK_HOST);
    expect(calls[1]!.domain).toBe(FALLBACK_HOST);
    expectDomainMatchesHost(calls);
  });

  test("falls back on HTTP 500", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(500, "upstream exploded") },
      { kind: "response", response: streamOkResponse() },
    ]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(true);
    await drain(result);
    expect(calls.map((call) => call.host)).toEqual([PRIMARY_HOST, FALLBACK_HOST]);
    expectDomainMatchesHost(calls);
  });

  test("falls back on HTTP 404", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(404, "not found") },
      { kind: "response", response: streamOkResponse() },
    ]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(true);
    await drain(result);
    expect(calls.map((call) => call.host)).toEqual([PRIMARY_HOST, FALLBACK_HOST]);
    expectDomainMatchesHost(calls);
  });

  test("falls back on HTTP 405", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(405, "method not allowed") },
      { kind: "response", response: streamOkResponse() },
    ]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(true);
    await drain(result);
    expect(calls.map((call) => call.host)).toEqual([PRIMARY_HOST, FALLBACK_HOST]);
    expectDomainMatchesHost(calls);
  });
});

/**
 * Account/payload errors are host-independent: the fallback would answer the
 * same way, so retrying it only doubles the latency (and the rate-limit or
 * auth pressure) for a turn that cannot succeed.
 */
describe("CodeBuddyProvider failover exclusions", () => {
  test("does not fall back on HTTP 401 (auth error belongs to the account)", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(401, "unauthorized") },
      { kind: "response", response: streamOkResponse() },
    ]);
    const result = await withoutRefresh(provider).chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(false);
    expect(calls.filter((call) => call.host === FALLBACK_HOST).length).toBe(0);
    expect(calls.filter((call) => call.host === PRIMARY_HOST).length).toBe(1);
    expectDomainMatchesHost(calls);
  });

  test("does not fall back on HTTP 403", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(403, "forbidden") },
      { kind: "response", response: streamOkResponse() },
    ]);
    const result = await withoutRefresh(provider).chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(false);
    expect(calls.filter((call) => call.host === FALLBACK_HOST).length).toBe(0);
    expectDomainMatchesHost(calls);
  });

  test("does not fall back on HTTP 400", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(400, "bad payload") },
      { kind: "response", response: streamOkResponse() },
    ]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(false);
    expect(calls.filter((call) => call.host === FALLBACK_HOST).length).toBe(0);
    expectDomainMatchesHost(calls);
  });

  test("does not fall back on HTTP 429 and reports the quota as exhausted", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(429, "slow down") },
      { kind: "response", response: streamOkResponse() },
    ]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(false);
    expect(result.quotaExhausted).toBe(true);
    expect(calls.filter((call) => call.host === FALLBACK_HOST).length).toBe(0);
    expectDomainMatchesHost(calls);
  });
});

describe("CodeBuddyProvider failover exhaustion", () => {
  test("fails after both hosts answer 5xx and never retries the primary", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(500, "boom") },
      { kind: "response", response: errorResponse(500, "boom") },
    ]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(false);
    if (result.error === undefined) throw new Error("expected a failover error message");
    // The operator needs the upstream status, not a bare "failed" (CN twin
    // asserts the same surface).
    expect(result.error).toMatch(/50[0-9]/);
    expect(calls.length).toBe(2);
    expect(calls.map((call) => call.host)).toEqual([PRIMARY_HOST, FALLBACK_HOST]);
    expectDomainMatchesHost(calls);
  });

  test("fails after both hosts throw network errors", async () => {
    const { provider, calls } = stubProvider([
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "throw", error: new TypeError("fetch failed") },
    ]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(false);
    expect(calls.map((call) => call.host)).toEqual([PRIMARY_HOST, FALLBACK_HOST]);
    expectDomainMatchesHost(calls);
  });
});

/**
 * A login session lives on ONE deployment: the device-code state, the token
 * poll and the refresh call all have to hit the host that minted the session.
 * Walking the candidate list here would not recover anything — it would just
 * burn the auth round-trips and could mint a token on a host whose session the
 * rest of the account flow never sees.
 *
 * `refreshCodebuddyToken` is the sharpest case: it calls `globalThis.fetch`
 * directly, NOT the `fetchWithTimeout` seam the rest of this file overrides, so
 * it is invisible to every other test here. 503 is failover-worthy on the chat
 * path, which is exactly why it makes a clean probe — a refresh that inherited
 * the chat path's behaviour would visibly call the peer host.
 */
describe("CodeBuddyProvider auth pinning to the primary host", () => {
  test("resolves every OAuth endpoint to the primary host", () => {
    expect(CODEBUDDY_OAUTH.baseUrl).toBe(CODEBUDDY_PRIMARY_BASE_URL);

    const endpoints = {
      stateUrl: CODEBUDDY_OAUTH.stateUrl,
      tokenUrl: CODEBUDDY_OAUTH.tokenUrl,
      refreshUrl: CODEBUDDY_OAUTH.refreshUrl,
    };
    for (const url of Object.values(endpoints)) {
      expect(url.startsWith(CODEBUDDY_PRIMARY_BASE_URL)).toBe(true);
      // The regression this guards: a host-walking auth path picking the peer.
      expect(url).not.toContain(FALLBACK_URL);
      expect(new URL(url).origin).toBe(PRIMARY_URL);
      // Still a real endpoint, not just a bare host that happens to match.
      expect(new URL(url).pathname.startsWith("/v2/plugin/auth/")).toBe(true);
    }
  });

  test("does not fail the refresh call over to the peer host", async () => {
    const realFetch = globalThis.fetch;
    const seen: { url: string; domain: string | null }[] = [];
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen.push({ url: String(input), domain: readDomainHeader(init?.headers) });
        return errorResponse(503, "gateway timeout");
      }) as unknown as typeof fetch;

      let thrown: unknown;
      try {
        await refreshCodebuddyToken("test-token");
      } catch (error) {
        thrown = error;
      }

      expect(seen.length).toBe(1);
      expect(seen[0]!.url.startsWith(CODEBUDDY_PRIMARY_BASE_URL)).toBe(true);
      expect(new URL(seen[0]!.url).host).toBe(PRIMARY_HOST);
      expect(seen[0]!.url).not.toContain(FALLBACK_URL);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/503/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("succeeds on a valid refresh envelope from the primary host", async () => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        seen.push(String(input));
        return new Response(
          JSON.stringify({ code: 0, data: { accessToken: "test-token", refreshToken: "test-refresh", expiresIn: 3600 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ) as unknown as Response;
      }) as unknown as typeof fetch;

      const refreshed = await refreshCodebuddyToken("test-token");

      expect(refreshed.access_token).toBe("test-token");
      expect(refreshed.refresh_token).toBe("test-refresh");
      expect(Number(refreshed.expires_at)).toBeGreaterThan(0);
      expect(seen.length).toBe(1);
      expect(seen[0]!.startsWith(CODEBUDDY_PRIMARY_BASE_URL)).toBe(true);
      expect(seen[0]!).not.toContain(FALLBACK_URL);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("derives X-Domain from the host it is given", () => {
    // The default-argument form (`codebuddyDomain()`) is the fragile spot: if it
    // ever ignored its argument, the fallback's requests would carry the
    // primary's X-Domain and upstream would pick the wrong tenant.
    expect(codebuddyDomain(FALLBACK_URL)).toBe(FALLBACK_HOST);
    expect(codebuddyDomain(PRIMARY_URL)).toBe(PRIMARY_HOST);
    expect(codebuddyDomain(`${FALLBACK_URL}/v2/chat/completions`)).toBe(FALLBACK_HOST);
    // No argument still resolves to the primary, so existing call sites are safe.
    expect(codebuddyDomain()).toBe(PRIMARY_HOST);
    expect(codebuddyDomain("not a url")).toBe(PRIMARY_HOST);
  });

  test("pins the provider's own base URL to the first candidate host", () => {
    const provider = new CodeBuddyProvider() as unknown as { baseUrl: string };
    expect(provider.baseUrl).toBe(CODEBUDDY_BASE_URLS[0]);
    expect(provider.baseUrl).toBe(CODEBUDDY_PRIMARY_BASE_URL);
  });
});
