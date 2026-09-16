/**
 * Dual base-URL failover for the CodeBuddy China provider.
 *
 * The provider has two candidate hosts:
 *   - primary  : https://www.codebuddy.cn
 *   - fallback : https://www.workbuddy.ai
 *
 * Failover happens ONLY on network/transient failures — a thrown fetch error
 * (DNS / connection refused / timeout), HTTP 5xx, HTTP 404 and HTTP 405. The
 * upstreams are separate deployments, so one refusing a route does not mean the
 * other will; conversely an account/payload error (400/401/403/429) is the same
 * on both hosts and must NOT be retried against the fallback.
 *
 * The `X-Domain` request header identifies the host being called, so it MUST
 * follow whichever base URL the request actually went to.
 *
 * Everything here runs against a stubbed protected HTTP seam
 * (`fetchWithTimeout`) — no test touches the real network.
 *
 * Run with:  bun test test/proxy/codebuddy-china-failover.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  CodeBuddyChinaProvider,
  CODEBUDDY_CHINA_BASE_URLS,
  CODEBUDDY_CHINA_PRIMARY_BASE_URL,
  shouldFailoverStatus,
} from "../../src/proxy/providers/codebuddy-china";
import type { ChatCompletionRequest } from "../../src/proxy/providers/base";
import type { Account } from "../../src/db/schema";

const PRIMARY_URL = "https://www.codebuddy.cn";
const FALLBACK_URL = "https://www.workbuddy.ai";
const PRIMARY_HOST = "www.codebuddy.cn";
const FALLBACK_HOST = "www.workbuddy.ai";
const CHAT_PATH = "/v2/chat/completions";

type ProviderWithFetch = CodeBuddyChinaProvider & {
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
    model: "deepseek-v3",
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
    for (const pair of headers as [string, string][]) {
      if (pair[0].toLowerCase() === "x-domain") return pair[1] ?? null;
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
  const calls: RecordedCall[] = [];
  let index = 0;
  const provider = new CodeBuddyChinaProvider() as ProviderWithFetch;

  provider.fetchWithTimeout = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, host: hostOf(url), domain: readDomainHeader(init.headers) });

    const step = steps[Math.min(index, steps.length - 1)];
    if (steps.length === 0) throw new Error("stubProvider called with no steps");
    index += 1;
    if (!step) throw new Error("stubProvider exhausted");

    if (step.kind === "throw") throw step.error;
    return step.response.clone() as unknown as Response;
  };

  return { provider, calls };
}

/**
 * The upstream endpoints this provider can reach, listed in the order it should
 * try them. `CODEBUDDY_CHINA_BASE_URLS` is the feature's own contract, so the
 * tests assert against it rather than against a private field.
 */
function candidateUrls(): { primary: string; fallback: string } {
  const urls = CODEBUDDY_CHINA_BASE_URLS.map((base: string) => `${base}${CHAT_PATH}`);
  if (urls.length !== 2) {
    throw new Error(
      `expected exactly 2 candidate base URLs in CODEBUDDY_CHINA_BASE_URLS, got ${CODEBUDDY_CHINA_BASE_URLS.length}`,
    );
  }
  return { primary: urls[0]!, fallback: urls[1]! };
}

function makeAccount(): Account {
  return {
    id: 1,
    provider: "codebuddy-china",
    email: "a@b.c",
    password: "x",
    status: "active",
    enabled: true,
    tokens: JSON.stringify({ api_key: "test-key" }),
    createdAt: new Date(),
  } as Account;
}

function makeRequest(): ChatCompletionRequest {
  return { model: "cbc-deepseek-v3", messages: [{ role: "user", content: "hi" }] };
}

/** Count how many recorded calls targeted `host`. */
function callsTo(calls: RecordedCall[], host: string): RecordedCall[] {
  return calls.filter((call) => call.host === host);
}

/**
 * Every call this provider makes must name its own host in `X-Domain`: upstream
 * picks the tenant/region from that header, so a mismatch fails auth even with
 * a valid key.
 */
function expectDomainMatchesHost(calls: RecordedCall[]): void {
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

describe("CodeBuddyChinaProvider dual base-URL failover", () => {
  test("exports the primary and fallback base URLs in order", () => {
    expect(CODEBUDDY_CHINA_BASE_URLS.length).toBe(2);
    expect(CODEBUDDY_CHINA_BASE_URLS[0]).toBe(PRIMARY_URL);
    expect(CODEBUDDY_CHINA_BASE_URLS[1]).toBe(FALLBACK_URL);
    expect(CODEBUDDY_CHINA_PRIMARY_BASE_URL).toBe(PRIMARY_URL);
    expect(candidateUrls()).toEqual({ primary: PRIMARY_URL + CHAT_PATH, fallback: FALLBACK_URL + CHAT_PATH });
  });

  test("classifies only host-scoped failures as failover-worthy", () => {
    // Transient / host-level: the peer host can still serve this account.
    expect(shouldFailoverStatus(500)).toBe(true);
    expect(shouldFailoverStatus(502)).toBe(true);
    expect(shouldFailoverStatus(503)).toBe(true);
    expect(shouldFailoverStatus(404)).toBe(true);
    expect(shouldFailoverStatus(405)).toBe(true);
    // Account/payload-level: identical answer from the peer host.
    expect(shouldFailoverStatus(400)).toBe(false);
    expect(shouldFailoverStatus(401)).toBe(false);
    expect(shouldFailoverStatus(403)).toBe(false);
    expect(shouldFailoverStatus(429)).toBe(false);
    expect(shouldFailoverStatus(200)).toBe(false);
  });

  test("stays on the primary host (and the cn X-Domain) when it succeeds", async () => {
    const { provider, calls } = stubProvider([{ kind: "response", response: streamOkResponse() }]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(true);
    await drain(result);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(candidateUrls().primary);
    expect(calls[0]!.domain).toBe(PRIMARY_HOST);
    expect(callsTo(calls, FALLBACK_HOST).length).toBe(0);
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

  test("sends an X-Domain header matching the host actually called", async () => {
    const { provider, calls } = stubProvider([
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "response", response: streamOkResponse() },
    ]);
    await provider.chatCompletion(makeAccount(), makeRequest());

    expect(calls.length).toBe(2);
    expect(calls[0]!.host).toBe(PRIMARY_HOST);
    expect(calls[0]!.domain).toBe(PRIMARY_HOST);
    // The regression this guards: a hardcoded cn X-Domain riding along with a
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
describe("CodeBuddyChinaProvider failover exclusions", () => {
  test("does not fall back on HTTP 401 (auth error belongs to the account)", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(401, "unauthorized") },
      { kind: "response", response: streamOkResponse() },
    ]);
    const result = await withoutRefresh(provider).chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(false);
    expect(callsTo(calls, FALLBACK_HOST).length).toBe(0);
    expect(callsTo(calls, PRIMARY_HOST).length).toBe(1);
    expectDomainMatchesHost(calls);
  });

  test("does not fall back on HTTP 403", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(403, "forbidden") },
      { kind: "response", response: streamOkResponse() },
    ]);
    const result = await withoutRefresh(provider).chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(false);
    expect(callsTo(calls, FALLBACK_HOST).length).toBe(0);
    expectDomainMatchesHost(calls);
  });

  test("does not fall back on HTTP 400", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(400, "bad payload") },
      { kind: "response", response: streamOkResponse() },
    ]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(false);
    expect(callsTo(calls, FALLBACK_HOST).length).toBe(0);
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
    expect(callsTo(calls, FALLBACK_HOST).length).toBe(0);
  });
});

describe("CodeBuddyChinaProvider failover exhaustion", () => {
  test("fails with an upstream-status error after both hosts were tried", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(503, "primary down") },
      { kind: "response", response: errorResponse(502, "fallback down") },
    ]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(false);
    if (result.error === undefined) throw new Error("expected a failover error message");
    expect(result.error).toMatch(/50[23]/);
    expect(result.error).toContain("CodeBuddy China");
    expect(calls.map((call) => call.host)).toEqual([PRIMARY_HOST, FALLBACK_HOST]);
    expectDomainMatchesHost(calls);
  });

  test("does not retry the primary once the fallback also fails", async () => {
    const { provider, calls } = stubProvider([
      { kind: "response", response: errorResponse(500, "boom") },
      { kind: "response", response: errorResponse(500, "boom") },
    ]);
    const result = await provider.chatCompletion(makeAccount(), makeRequest());

    expect(result.success).toBe(false);
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
