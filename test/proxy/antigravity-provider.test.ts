import { afterEach, describe, expect, test } from "bun:test";
import type { Account } from "../../src/db/schema";
import type { ChatCompletionRequest } from "../../src/proxy/providers/base";
import {
  AntigravityProvider,
  AntigravitySessionStore,
  antigravityWireTier,
  antigravityThinkingBudget,
  wantsWebSearch,
  parseAntigravityRetryDelay,
  serializeAntigravityEnvelope,
  stripAntigravityTierSuffix,
  isAntigravityTokenExpiring,
  WIRE_MODELS,
  ANTIGRAVITY_OAUTH,
} from "../../src/proxy/providers/antigravity";
import { providers } from "../../src/proxy/providers/registry";

const p = new AntigravityProvider();

describe("AntigravityProvider model catalog", () => {
  test("owns all ag-* ids", () => {
    expect(p.ownsModel("ag-gemini-3-5-flash-high")).toBe(true);
    expect(p.ownsModel("ag-gemini-3-flash")).toBe(true);
    expect(p.ownsModel("ag-gpt-oss-120b-medium")).toBe(true);
  });

  test("rejects non-ag ids", () => {
    expect(p.ownsModel("gpt-4o")).toBe(false);
    expect(p.ownsModel("gemini-3-flash")).toBe(false);
  });

  test("image model is catalogued and vision-capable", () => {
    const info = p.getModelInfo("ag-gemini-3-1-flash-image");
    expect(info).toBeDefined();
    expect(info!.vision).toBe(true);
    expect(info!.max_output).toBeGreaterThan(0);
  });

  test("registry exposes antigravity", () => {
    expect((providers as Record<string, unknown>).antigravity).toBeDefined();
  });

  // Regression: the trailing "(tier)" on a wire id is a local thinking-tier
  // annotation. Sending it upstream returns
  // `404 NOT_FOUND: Requested entity was not found.`, which surfaced as
  // "All account attempt(s) failed for provider antigravity".
  test("stripAntigravityTierSuffix removes only the trailing tier", () => {
    expect(stripAntigravityTierSuffix("gemini-3.8-flash-tiered(high)")).toBe("gemini-3.8-flash-tiered");
    expect(stripAntigravityTierSuffix("gemini-3.7-flash-tiered(medium)")).toBe("gemini-3.7-flash-tiered");
    expect(stripAntigravityTierSuffix("gemini-3.6-flash-tiered(low)")).toBe("gemini-3.6-flash-tiered");
    // Bare ids pass through untouched.
    expect(stripAntigravityTierSuffix("gemini-3-flash-agent")).toBe("gemini-3-flash-agent");
    expect(stripAntigravityTierSuffix("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  // Invariant over the whole catalog: the id that actually goes on the wire —
  // the `wire:` annotation stripped — must be a bare upstream model name. This
  // catches the original 404 (`Requested entity was not found.`) at
  // introduction, since Google rejects the annotated form.
  test("every catalog wire id strips to a bare upstream model name", () => {
    for (const model of WIRE_MODELS) {
      expect(stripAntigravityTierSuffix(model.wire)).toMatch(/^[a-z0-9.\-]+$/);
    }
  });
});

describe("AntigravityProvider wire model ids", () => {
  // The full-catalog guard: build a real envelope for every catalogued model
  // and assert the id that would be sent upstream carries no tier annotation.
  // This is the regression test for the `404 NOT_FOUND: Requested entity was
  // not found.` failure.
  test("no catalogued model sends a tier annotation on the wire", async () => {
    for (const info of p.supportedModels) {
      const provider = new CapturingProvider(() => jsonResponse(IMAGE_BODY));
      await provider.chatCompletion(agAccount, agRequest({ model: info.id }));
      expect(provider.lastEnvelope.model).not.toMatch(/\([^()]*\)$/);
      expect(provider.lastEnvelope.model).toMatch(/^[a-z0-9.\-]+$/);
    }
  });

  test("the tier annotation still drives the thinking budget", async () => {
    const budgetFor = async (model: string): Promise<number> => {
      const provider = new CapturingProvider();
      await provider.chatCompletion(agAccount, agRequest({ model }));
      return provider.lastEnvelope.request.generationConfig.thinkingConfig!.thinkingBudget;
    };
    const high = await budgetFor("ag-gemini-3-7-flash-high");
    const medium = await budgetFor("ag-gemini-3-7-flash-medium");
    const low = await budgetFor("ag-gemini-3-7-flash-low");
    // high > medium > low must survive the strip.
    expect(high).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(low);
  });
});

describe("AntigravityProvider credential guards", () => {
  const empty = { tokens: JSON.stringify({}) } as any;

  test("validateAccount false when tokens missing", async () => {
    expect(await p.validateAccount(empty)).toBe(false);
  });

  test("refreshToken fails without refresh_token", async () => {
    const res = await p.refreshToken(empty);
    expect(res.success).toBe(false);
  });
});

describe("AntigravityProvider expired-credential recovery", () => {
  const nowMs = Date.parse("2026-09-15T12:00:00.000Z");

  test("a token past its expiry is treated as expiring", () => {
    expect(isAntigravityTokenExpiring({ expiresAt: "2026-09-15T11:00:00.000Z" }, nowMs)).toBe(true);
  });

  test("a token inside the refresh lead window is treated as expiring", () => {
    // 1 minute of life left, lead is 5 — refresh before it lapses.
    expect(isAntigravityTokenExpiring({ expiresAt: "2026-09-15T12:01:00.000Z" }, nowMs)).toBe(true);
  });

  test("a healthy token is left alone", () => {
    expect(isAntigravityTokenExpiring({ expiresAt: "2026-09-15T12:30:00.000Z" }, nowMs)).toBe(false);
  });

  test("an unknown or unparseable expiry defers to the request", () => {
    expect(isAntigravityTokenExpiring({}, nowMs)).toBe(false);
    expect(isAntigravityTokenExpiring({ expiresAt: "not-a-date" }, nowMs)).toBe(false);
  });

  // Regression: an idle account used to be marked error/"No valid tokens
  // available" about an hour after login, because the scheduled health check
  // never refreshed the ~1h access token. healthCheck must now repair it and
  // hand the new tokens back so warmup can persist them.
  //
  // These use real-clock offsets because `healthCheck` calls
  // `isAntigravityTokenExpiring` without an injected `now`.
  test("healthCheck refreshes an expiring token and returns the new ones", async () => {
    const account = {
      tokens: JSON.stringify({
        accessToken: "stale",
        projectId: "proj",
        refreshToken: "refresh-1",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    } as unknown as Account;

    const provider = new AntigravityProvider();
    const refreshedPayload = { accessToken: "fresh", projectId: "proj", refreshToken: "refresh-1" };
    let refreshCalls = 0;
    provider.refreshToken = async () => {
      refreshCalls++;
      // The real refreshToken is side-effect free: it reports the new tokens
      // and leaves persistence to the caller.
      return { success: true, tokens: JSON.stringify(refreshedPayload) };
    };
    const validated: string[] = [];
    provider.validateAccount = async (candidate: Account) => {
      // `healthCheck` hands the base check the encoded credential string.
      const parsed: unknown =
        typeof candidate.tokens === "string" ? JSON.parse(candidate.tokens) : candidate.tokens;
      const token =
        typeof parsed === "object" && parsed !== null && "accessToken" in parsed ? parsed.accessToken : undefined;
      validated.push(typeof token === "string" ? token : "?");
      return true;
    };
    provider.fetchQuota = async () => ({ success: true, quota: { limit: -1, remaining: -1, used: 0 } });

    const health = await provider.healthCheck(account);

    expect(refreshCalls).toBe(1);
    // The base check must see the *refreshed* credential, and the account row
    // itself must be left untouched (the warmup runner does the writing).
    expect(validated).toEqual(["fresh"]);
    expect(health.kind).toBe("healthy");
    expect(health.tokens).toEqual(refreshedPayload);
    expect(account.tokens).toEqual(JSON.parse(JSON.stringify(account.tokens)));
  });

  test("refreshToken returns new tokens without mutating the account", async () => {
    const tokens = JSON.stringify({
      accessToken: "stale",
      projectId: "proj",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const account = { tokens } as unknown as Account;

    // Exercise the real implementation: stub the token endpoint at the
    // transport boundary so no network is touched.
    const provider = new AntigravityProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const res = await provider.refreshToken(account);
      expect(res.success).toBe(true);
      const returned: unknown = JSON.parse(res.tokens as string);
      expect(returned).toMatchObject({ accessToken: "fresh", projectId: "proj", refreshToken: "refresh-1" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The caller persists; the provider must not write through the account.
    expect(account.tokens).toBe(tokens);
  });

  test("healthCheck skips the refresh when the token is still healthy", async () => {
    const account = {
      tokens: JSON.stringify({
        accessToken: "good",
        projectId: "proj",
        refreshToken: "refresh-1",
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    } as unknown as Account;

    const provider = new AntigravityProvider();
    let refreshCalls = 0;
    provider.refreshToken = async () => {
      refreshCalls++;
      return { success: false, error: "should not be called" };
    };
    provider.validateAccount = async () => true;
    provider.fetchQuota = async () => ({ success: true, quota: { limit: -1, remaining: -1, used: 0 } });

    const health = await provider.healthCheck(account);

    expect(refreshCalls).toBe(0);
    expect(health.kind).toBe("healthy");
    expect(health.tokens).toBeUndefined();
  });
});

describe("AntigravityProvider request-path proactive refresh", () => {
  const staleAccount = () =>
    ({
      tokens: JSON.stringify({
        accessToken: "stale",
        projectId: "proj",
        refreshToken: "refresh-1",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    }) as unknown as Account;

  test("chatCompletion refreshes before sending and reports the new tokens", async () => {
    const account = staleAccount();
    const provider = new CapturingProvider(() => sseResponse([]));
    const refreshedPayload = { accessToken: "fresh", projectId: "proj", refreshToken: "refresh-1" };
    let refreshCalls = 0;
    provider.refreshToken = async () => {
      refreshCalls++;
      return { success: true, tokens: JSON.stringify(refreshedPayload) };
    };
    const sent: unknown[] = [];
    provider.captureCredential = (credential) => sent.push(credential.accessToken);

    const result = await provider.chatCompletion(account, agRequest());

    expect(refreshCalls).toBe(1);
    // The upstream call must carry the refreshed bearer token…
    expect(sent).toEqual(["fresh"]);
    // …and the router needs it back to persist (it writes `result.tokens`).
    expect(result.tokens).toEqual(JSON.stringify(refreshedPayload));
  });

  test("chatCompletion leaves a healthy token alone", async () => {
    const account = {
      tokens: JSON.stringify({
        accessToken: "good",
        projectId: "proj",
        refreshToken: "refresh-1",
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    } as unknown as Account;
    const provider = new CapturingProvider(() => sseResponse([]));
    let refreshCalls = 0;
    provider.refreshToken = async () => {
      refreshCalls++;
      return { success: false, error: "should not be called" };
    };

    const result = await provider.chatCompletion(account, agRequest());

    expect(refreshCalls).toBe(0);
    expect(result.tokens).toBeUndefined();
  });

  test("a failed refresh still attempts the request with the existing token", async () => {
    const account = staleAccount();
    const provider = new CapturingProvider(() => sseResponse([]));
    provider.refreshToken = async () => ({ success: false, error: "network down" });
    const sent: unknown[] = [];
    provider.captureCredential = (credential) => sent.push(credential.accessToken);

    const result = await provider.chatCompletion(account, agRequest());

    // Degrade to the old behaviour rather than hard-failing the turn.
    expect(sent).toEqual(["stale"]);
    expect(result.success).toBe(true);
  });
});

describe("AntigravityProvider.fetchQuota", () => {
  // Stub the instance fetchWithTimeout (fetchQuota routes through it).
  const origFetch = (p as any).fetchWithTimeout;
  function stubFetch(body: unknown, status = 200) {
    (p as any).fetchWithTimeout = async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  }
  function restoreFetch() {
    (p as any).fetchWithTimeout = origFetch;
  }

  const account = {
    tokens: JSON.stringify({ accessToken: "tok", projectId: "proj" }),
  } as any;

  afterEach(restoreFetch);

  test("parses remainingFraction into 0-100 quota", async () => {
    stubFetch({
      models: {
        "gemini-3.5-flash-high": {
          quotaInfo: { remainingFraction: 0.5, resetTime: "2026-01-02T00:00:00Z" },
          dailyQuotaInfo: { remainingFraction: 0.8 },
        },
        "claude-sonnet-4-6": {
          weeklyQuotaInfo: { remainingFraction: 0.25, resetTime: "2026-01-01T00:00:00Z" },
        },
      },
    });
    const res = await p.fetchQuota(account);
    expect(res.success).toBe(true);
    // Worst-case remaining = min(0.5, 0.8, 0.25) = 0.25 -> 25%.
    expect(res.quota!.remaining).toBe(25);
    expect(res.quota!.used).toBe(75);
    expect(res.quota!.limit).toBe(100);
    expect(res.quota!.resetAt).toBe("2026-01-01T00:00:00Z");
  });

  test("clamps remainingFraction outside [0,1]", async () => {
    stubFetch({ quota: { "gemini-3-flash": { quotaInfo: { remainingFraction: 2 } } } });
    const res = await p.fetchQuota(account);
    expect(res.success).toBe(true);
    expect(res.quota!.remaining).toBe(100);
  });

  test("no quota windows returns success without quota", async () => {
    stubFetch({ models: {} });
    const res = await p.fetchQuota(account);
    expect(res.success).toBe(true);
    expect(res.quota).toBeUndefined();
  });

  test("401 surfaces as unsupported error (not exhausted)", async () => {
    stubFetch({}, 401);
    const res = await p.fetchQuota(account);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not support/);
  });

  test("no token returns success without quota", async () => {
    const res = await p.fetchQuota({ tokens: JSON.stringify({}) } as any);
    expect(res.success).toBe(true);
    expect(res.quota).toBeUndefined();
  });
});

describe("discoverOrProvisionProject endpoint selection", () => {
  test("uses Google Cloud Code Assist load endpoint", () => {
    expect(ANTIGRAVITY_OAUTH.loadCodeAssistUrl).toContain("cloudcode-pa.googleapis.com");
    expect(ANTIGRAVITY_OAUTH.dailyEndpoint).toContain("daily-cloudcode-pa.googleapis.com");
  });
});

describe("antigravity workflow helpers (Cartethyia port)", () => {
  const noOverride = { reasoning_effort: undefined, thinking: undefined };

  test("thinking budget scales with tier", () => {
    expect(antigravityThinkingBudget("low")).toBe(1000);
    expect(antigravityThinkingBudget("medium")).toBe(4000);
    expect(antigravityThinkingBudget("high")).toBe(10000);
    expect(antigravityThinkingBudget("pro")).toBe(10001);
  });

  test("tiered wire ids (model(tier)) map to their explicit tier", () => {
    expect(antigravityWireTier("gemini-3.8-flash-high(high)", noOverride)).toBe("high");
    expect(antigravityWireTier("gemini-3.8-flash-medium(medium)", noOverride)).toBe("medium");
    expect(antigravityWireTier("gemini-3.7-flash-tiered(low)", noOverride)).toBe("low");
  });

  test("suffix wire ids map to a tier", () => {
    expect(antigravityWireTier("gemini-3.5-flash-high", noOverride)).toBe("high");
    expect(antigravityWireTier("gemini-3.5-flash-low", noOverride)).toBe("low");
    expect(antigravityWireTier("gemini-3.5-flash-extra-low", noOverride)).toBe("low");
  });

  test("pro/agent wire ids map to pro", () => {
    expect(antigravityWireTier("gemini-pro-agent", noOverride)).toBe("pro");
    expect(antigravityWireTier("gemini-3.1-pro-low", noOverride)).toBe("pro");
  });

  test("claude defaults to high thinking but honors request effort", () => {
    expect(antigravityWireTier("claude-sonnet-4-6", noOverride)).toBe("high");
    expect(antigravityWireTier("claude-sonnet-4-6", { reasoning_effort: "low", thinking: undefined })).toBe("low");
  });

  test("request effort overrides the wire tier", () => {
    expect(antigravityWireTier("gemini-3.8-flash-high(high)", { reasoning_effort: "low", thinking: undefined })).toBe("low");
  });

  test("thinking.effort is honored", () => {
    expect(antigravityWireTier("gemini-pro-agent", { reasoning_effort: undefined, thinking: { effort: "medium" } })).toBe("medium");
  });

  test("web search tools are detected", () => {
    expect(wantsWebSearch({ tools: [{ type: "web_search" }] })).toBe(true);
    expect(wantsWebSearch({ tools: [{ type: "function", function: { name: "web_search" } }] })).toBe(true);
    expect(wantsWebSearch({ tools: [] })).toBe(false);
    expect(wantsWebSearch({})).toBe(false);
  });
});

// ============================================================================
// Request building: tools, prompt rewrites, image flow, session state
// ============================================================================

/** Function-declaration group as it appears on the wire. */
interface CapturedToolGroup {
  functionDeclarations: { name: string; description: string; parameters: Record<string, unknown> }[];
}

/** Gemini content part as it appears on the wire (test-local view). */
interface CapturedPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response?: Record<string, unknown> };
}

/** Outgoing envelope as captured for assertions. Mirrors
 * `AntigravityRequestEnvelope`, plus function-call parts narrowed so tests can
 * read them without casts. */
interface CapturedEnvelope {
  project: string;
  requestId: string;
  model: string;
  userAgent: string;
  requestType: "agent" | "image_gen";
  toolNameMap: Map<string, string>;
  request: {
    contents: { role: string; parts: CapturedPart[] }[];
    generationConfig: {
      maxOutputTokens?: number;
      thinkingConfig?: { includeThoughts: boolean; thinkingBudget: number };
      imageConfig?: { aspectRatio: string };
    };
    labels: Record<string, string>;
    tools?: (CapturedToolGroup | { googleSearch: Record<string, never> })[];
    toolConfig?: { functionCallingConfig: { mode: string } };
    systemInstruction?: { parts: { text: string }[] };
  };
}

/** Provider that captures the outgoing envelope instead of hitting the network. */
class CapturingProvider extends AntigravityProvider {
  lastEnvelope!: CapturedEnvelope;
  responder: () => Response;

  constructor(responder: () => Response = () => sseResponse([]), store?: AntigravitySessionStore) {
    super(store);
    this.responder = responder;
  }

  protected override async sendAntigravityRequest(
    env: unknown,
    credential: { accessToken: string },
  ): Promise<Response> {
    this.lastEnvelope = env as CapturedEnvelope;
    // Observe which bearer token the transport was handed, so tests can prove
    // a proactive refresh actually reached the outbound call.
    this.captureCredential?.(credential);
    return this.responder();
  }

  /** Optional observer for the credential passed to the transport. */
  captureCredential?: (credential: { accessToken: string }) => void;

  /** The merged function-declaration group, when the request carried tools. */
  get declarations(): { name: string; parameters: Record<string, unknown> }[] {
    const groups = (this.lastEnvelope.request.tools ?? []) as CapturedToolGroup[];
    return groups.flatMap((group) => group.functionDeclarations ?? []);
  }

  /** Every part across every content block. */
  get parts(): CapturedPart[] {
    return this.lastEnvelope.request.contents.flatMap((content) => content.parts);
  }
}

function sseResponse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/** Single JSON body, as image generation and error responses are served. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A one-image Gemini response body. */
const IMAGE_BODY = {
  candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "QUJD" } }] } }],
};

// Stored tokens are a JSON string on the account row, so the cast is the
// boundary between the DB column type and the provider's credential parser.
const agAccount = {
  id: 7,
  provider: "antigravity",
  email: "ag@test.local",
  tokens: JSON.stringify({ accessToken: "tok", projectId: "proj-1" }),
} as unknown as Account;

function agRequest(overrides: Record<string, unknown> = {}): ChatCompletionRequest {
  return {
    model: "ag-gemini-3-5-flash-high",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  } as ChatCompletionRequest;
}

/** Assistant message as asserted in these tests (adds reasoning_content). */
interface AssertedMessage {
  content: string | null;
  reasoning_content?: string;
  tool_calls?: {
    function: { name: string; arguments: string };
    /** Gemini-issued signature, surfaced for replay on the next turn. */
    thoughtSignature?: string;
  }[];
}

/**
 * Narrow a provider result to the assistant message. The provider returns the
 * base `ChatMessage` shape, so reading the extra reasoning_content field needs
 * a named cast at this boundary.
 */
function messageOf(result: { response?: { choices: { message: unknown }[] } }): AssertedMessage {
  return result.response!.choices[0]!.message as unknown as AssertedMessage;
}

describe("AntigravityProvider tool plumbing", () => {
  test("client tools become one merged functionDeclarations group", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [
        { type: "function", function: { name: "read_file", description: "r", parameters: { type: "object", properties: { p: { type: "string" } } } } },
        { type: "function", function: { name: "write_file", parameters: { type: "object", properties: {} } } },
      ],
    }));

    const tools = provider.lastEnvelope.request.tools;
    expect(tools).toHaveLength(1);
    expect(provider.declarations.map((d) => d.name)).toEqual(["read_file", "write_file"]);
  });

  test("function names are sanitized and unsupported schema keys dropped", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [{
        type: "function",
        function: {
          name: "mcp/read file",
          parameters: { type: "object", properties: { p: { type: "string", format: "uri", $comment: "x" } }, additionalProperties: false, $schema: "https://x" },
        },
      }],
    }));

    const [declaration] = provider.declarations;
    expect(declaration!.name).toBe("mcp_read_file");
    expect(declaration!.parameters.additionalProperties).toBeUndefined();
    expect(declaration!.parameters.$schema).toBeUndefined();
    const properties = declaration!.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.p!.format).toBe("uri");
  });

  test("no tools means no tools field upstream", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest());
    expect(provider.lastEnvelope.request.tools).toBeUndefined();
  });

  // Regression: a union/nullable `type` — the standard JSON Schema spelling for
  // an optional value, emitted by agentic clients such as omp — was forwarded
  // verbatim. Gemini's `Type` is a non-repeated proto enum, so the request died
  // upstream with the whole tool group rejected:
  //
  //   400 Invalid JSON payload received. Unknown name "type" at
  //   'request.tools[0].function_declarations[3].parameters.properties[4].value':
  //   Proto field is not repeating, cannot start list. (INVALID_ARGUMENT)
  test("a union type is normalized to one scalar Gemini type", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [{
        type: "function",
        function: {
          name: "run_command",
          parameters: {
            type: "object",
            properties: {
              a: { type: "string" },
              b: { type: "string" },
              c: { type: "string" },
              d: { type: "string" },
              value: { type: ["string", "null"] },
            },
            required: ["a"],
          },
        },
      }],
    }));

    const [declaration] = provider.declarations;
    const properties = declaration!.parameters.properties as Record<string, Record<string, unknown>>;
    // The union lands at index 4 (the position that 400'd in production).
    expect(Object.keys(properties)).toEqual(["a", "b", "c", "d", "value"]);
    expect(properties.value!.type).toBe("string");
    expect(Array.isArray(properties.value!.type)).toBe(false);
  });

  // Invariant over the whole outgoing envelope: no schema node may carry an
  // array-typed `type`, since a repeated enum field is what Google rejects.
  test("no emitted schema ever sends an array-typed type", async () => {
    const provider = new CapturingProvider();
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((entry, i) => walk(entry, `${path}[${i}]`));
        return;
      }
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (key === "type") expect(Array.isArray(child), `${path}.type must be scalar`).toBe(false);
        walk(child, `${path}.${key}`);
      }
    };

    await provider.chatCompletion(agAccount, agRequest({
      tools: [{
        type: "function",
        function: {
          name: "mixed",
          parameters: {
            type: ["object", "null"],
            properties: {
              u: { type: ["string", "null"] },
              n: { type: ["integer", "number"] },
              arr: { type: ["array", "null"], items: { type: ["string", "null"] } },
              nested: { type: "object", properties: { deep: { type: ["boolean", "null"] } } },
            },
          },
        },
      }],
    }));

    walk(provider.declarations, "declarations");
  });

  test("a union keeps its non-null alternatives as anyOf", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [{
        type: "function",
        function: { name: "t", parameters: { type: "object", properties: { v: { type: ["string", "number"] } } } },
      }],
    }));

    const properties = provider.declarations[0]!.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.v!.type).toBe("string");
    expect(properties.v!.anyOf).toEqual([{ type: "number" }]);
  });

  // A `null` branch has no Gemini equivalent; it must be dropped rather than
  // sent as an unvalidatable empty alternative.
  test("null-only schema branches are dropped", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [{
        type: "function",
        function: {
          name: "t",
          parameters: { type: "object", properties: { v: { anyOf: [{ type: "string" }, { type: "null" }] } } },
        },
      }],
    }));

    const properties = provider.declarations[0]!.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.v!.anyOf).toEqual([{ type: "string" }]);
  });

  test("const, oneOf and local $ref are translated rather than dropped", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [{
        type: "function",
        function: {
          name: "t",
          parameters: {
            type: "object",
            properties: {
              kind: { const: "fixed" },
              choice: { oneOf: [{ type: "string" }, { type: "integer" }] },
              dir: { $ref: "#/$defs/Dir" },
            },
            $defs: { Dir: { type: "string", enum: ["up", "down"] } },
          },
        },
      }],
    }));

    const properties = provider.declarations[0]!.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.kind).toEqual({ type: "string", enum: ["fixed"] });
    expect(properties.choice!.anyOf).toEqual([{ type: "string" }, { type: "integer" }]);
    expect(properties.dir).toEqual({ type: "string", enum: ["up", "down"] });
  });

  test("tool_choice required forces ANY, none forces NONE", async () => {
    const required = new CapturingProvider();
    await required.chatCompletion(agAccount, agRequest({
      tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }],
      tool_choice: "required",
    }));
    expect(required.lastEnvelope.request.toolConfig!.functionCallingConfig!.mode).toBe("ANY");

    const none = new CapturingProvider();
    await none.chatCompletion(agAccount, agRequest({
      tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }],
      tool_choice: "none",
    }));
    expect(none.lastEnvelope.request.toolConfig!.functionCallingConfig!.mode).toBe("NONE");
  });

  // Regression: a built-in tool (googleSearch) alongside function declarations
  // is refused by Cloud Code:
  //
  //   400 Please enable tool_config.include_server_side_tool_invocations to
  //   use Built-in tools with Function calling. (INVALID_ARGUMENT)
  //
  // No request-body spelling of that flag is accepted (not under
  // `request.tool_config`, not at the envelope top level), so the built-in form
  // is never emitted. Web search is modelled as an ordinary function
  // declaration the model can call like any other tool.
  test("web search is sent as a function declaration, never googleSearch", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [
        { type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
        { type: "web_search" },
      ],
    }));

    const tools = provider.lastEnvelope.request.tools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools.some((t) => "googleSearch" in t)).toBe(false);
    expect(provider.declarations.map((d) => d.name)).toEqual(["read_file", "web_search"]);
    expect(provider.lastEnvelope.request.toolConfig).toBeUndefined();
  });

  test("a web_search function tool is not duplicated", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [{ type: "function", function: { name: "web_search", parameters: { type: "object", properties: {} } } }],
    }));

    expect(provider.declarations.filter((d) => d.name === "web_search")).toHaveLength(1);
  });

  test("an unused web_search tool leaves function-only requests untouched", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }],
    }));
    expect(provider.declarations.map((d) => d.name)).toEqual(["t"]);
  });

  // With no function declarations there is nothing to collide with, so the
  // built-in search tool is used (it answers 200 on its own).
  test("a web search request with no function tools uses the built-in googleSearch", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({ tools: [{ type: "web_search" }] }));

    const tools = provider.lastEnvelope.request.tools ?? [];
    expect(tools).toEqual([{ googleSearch: {} }]);
    expect(provider.declarations).toEqual([]);
  });

  // Regression: `$ref` inlining is recursive and agent tool schemas are
  // routinely self-referential. An unbounded walk overflowed the stack, and
  // that RangeError was charged to the account — sidelining healthy accounts.
  test("self-referential $defs schemas do not overflow the stack", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [{
        type: "function",
        function: {
          name: "tree",
          parameters: {
            type: "object",
            properties: { child: { $ref: "#/$defs/Node" } },
            $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } },
          },
        },
      }],
    }));

    const properties = provider.declarations[0]!.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.child!.type).toBe("object");
  });

  // Gemini's enum is a repeated string field, so a raw non-string literal in it
  // is rejected upstream.
  test("const literals are stringified into the enum", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [{
        type: "function",
        function: {
          name: "t",
          parameters: {
            type: "object",
            properties: { n: { const: 5 }, flag: { const: true }, s: { const: "x" } },
          },
        },
      }],
    }));

    const properties = provider.declarations[0]!.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.n).toEqual({ type: "integer", enum: ["5"] });
    expect(properties.flag).toEqual({ type: "boolean", enum: ["true"] });
    expect(properties.s).toEqual({ type: "string", enum: ["x"] });
  });

  // A bare `"null"` type is not a Gemini enum value; it must never be emitted.
  test("a bare null type is dropped rather than forwarded", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [{
        type: "function",
        function: { name: "t", parameters: { type: "object", properties: { p: { type: "null" } } } },
      }],
    }));

    const properties = provider.declarations[0]!.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.p!.type).toBeUndefined();
  });

  test("tool results reference the function name, not the call id", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_abc", type: "function", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_abc", content: '{"ok":true}' },
      ],
    }));

    const response = provider.parts.find((p) => p.functionResponse);
    expect(response?.functionResponse?.name).toBe("read_file");
    expect(response?.functionResponse?.response).toEqual({ ok: true });
  });

  // Regression: the provider used to substitute a hand-written constant for
  // every replayed call. That constant is not valid base64 (719 chars, so
  // length % 4 != 0) and, even when padded, Gemini rejects it as a "Corrupted
  // thought signature." — it validates the signature cryptographically. The
  // only usable signature is the one Gemini issued, so nothing is fabricated:
  // a client-supplied signature is replayed verbatim, and a part with none
  // goes out unsigned (matching the Cartethyia/9router reference).
  test("a replayed function call carries the client's thoughtSignature", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" }, thoughtSignature: "sig-from-gemini" },
        ] },
      ],
    }));

    const calls = provider.parts.filter((p) => p.functionCall);
    expect(calls[0]!.thoughtSignature).toBe("sig-from-gemini");
  });

  test("no thoughtSignature is invented when the client supplies none", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
        ] },
      ],
    }));

    const calls = provider.parts.filter((p) => p.functionCall);
    expect(calls[0]!.thoughtSignature).toBeUndefined();
    expect(calls[1]!.thoughtSignature).toBeUndefined();
  });

  // The signature is only usable if the client receives it in the first place;
  // it is surfaced on the tool call so it can be echoed on the next turn.
  test("the upstream thoughtSignature is surfaced on the response tool call", async () => {
    const provider = new CapturingProvider(() => sseResponse([
      { candidates: [{ content: { parts: [
        { functionCall: { name: "read_file", args: { p: 1 } }, thoughtSignature: "sig-abc" },
      ] }, finishReason: "STOP" }] },
    ]));
    const result = await provider.chatCompletion(agAccount, agRequest({
      tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }],
    }));
    const call = messageOf(result).tool_calls![0]!;
    expect(call.thoughtSignature).toBe("sig-abc");
  });

  // End-to-end at the envelope level: capture what upstream issued, feed it
  // back on the next turn, and confirm it is replayed unchanged.
  test("a captured signature round-trips back onto the wire unchanged", async () => {
    const first = new CapturingProvider(() => sseResponse([
      { candidates: [{ content: { parts: [
        { functionCall: { name: "read_file", args: {} }, thoughtSignature: "sig-round-trip" },
      ] }, finishReason: "STOP" }] },
    ]));
    const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }];
    const firstResult = await first.chatCompletion(agAccount, agRequest({ tools }));
    const issued = messageOf(firstResult).tool_calls![0]!;

    const second = new CapturingProvider();
    await second.chatCompletion(agAccount, agRequest({
      tools,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ ...issued, id: "c1" }] },
        { role: "tool", tool_call_id: "c1", content: "{}" },
      ],
    }));

    const replayed = second.parts.find((p) => p.functionCall);
    expect(replayed!.thoughtSignature).toBe("sig-round-trip");
  });

  // Regression: an OpenAI-shaped client (omp) drops the non-standard
  // `tool_calls[].thoughtSignature` field, and an unsigned replay is rejected
  // upstream with "Function call is missing a thought_signature in
  // functionCall parts." The signature issued for that same call is therefore
  // recovered server-side from the per-conversation stash, keyed by tool name
  // + arguments.
  test("a signature is recovered from the stash when the client echoes none", async () => {
    const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }];
    const store = new AntigravitySessionStore();

    // Turn 1 issues a signature for read_file with specific arguments.
    const first = new CapturingProvider(() => sseResponse([
      { candidates: [{ content: { parts: [
        { functionCall: { name: "read_file", args: { p: "/tmp" } }, thoughtSignature: "sig-stashed" },
      ] }, finishReason: "STOP" }] },
    ]), store);
    await first.chatCompletion(agAccount, agRequest({ tools }));

    // Turn 2 replays the call with the signature stripped, sharing the store —
    // exactly what a second HTTP request in the same conversation does.
    const second = new CapturingProvider(undefined, store);
    await second.chatCompletion(agAccount, agRequest({
      tools,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: '{"p":"/tmp"}' } },
        ] },
        { role: "tool", tool_call_id: "c1", content: "{}" },
      ],
    }));

    expect(second.parts.find((p) => p.functionCall)!.thoughtSignature).toBe("sig-stashed");
  });

  test("a client-echoed signature wins over the stash", async () => {
    const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }];
    const store = new AntigravitySessionStore();
    const first = new CapturingProvider(() => sseResponse([
      { candidates: [{ content: { parts: [
        { functionCall: { name: "read_file", args: { p: "/tmp" } }, thoughtSignature: "sig-stashed" },
      ] }, finishReason: "STOP" }] },
    ]), store);
    await first.chatCompletion(agAccount, agRequest({ tools }));

    const second = new CapturingProvider(undefined, store);
    await second.chatCompletion(agAccount, agRequest({
      tools,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: '{"p":"/tmp"}' }, thoughtSignature: "sig-from-client" },
        ] },
      ],
    }));

    expect(second.parts.find((p) => p.functionCall)!.thoughtSignature).toBe("sig-from-client");
  });

  // The stash is keyed by name + arguments, so a call with different arguments
  // must not inherit an unrelated signature.
  test("the stash does not match a call with different arguments", async () => {
    const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }];
    const store = new AntigravitySessionStore();
    const first = new CapturingProvider(() => sseResponse([
      { candidates: [{ content: { parts: [
        { functionCall: { name: "read_file", args: { p: "/tmp" } }, thoughtSignature: "sig-stashed" },
      ] }, finishReason: "STOP" }] },
    ]), store);
    await first.chatCompletion(agAccount, agRequest({ tools }));

    const second = new CapturingProvider(undefined, store);
    await second.chatCompletion(agAccount, agRequest({
      tools,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: '{"p":"/other"}' } },
        ] },
      ],
    }));

    expect(second.parts.find((p) => p.functionCall)!.thoughtSignature).toBeUndefined();
  });

  test("model_enum label comes from the wire profile", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({ model: "ag-gemini-pro-agent" }));
    expect(provider.lastEnvelope.request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M16");
  });

  test("claude output tokens are capped at 64000", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({ model: "ag-claude-sonnet-4-6", max_tokens: 200000 }));
    expect(provider.lastEnvelope.request.generationConfig.maxOutputTokens).toBe(64000);
  });

  // Regression: gpt-oss-120b-medium rejects maxOutputTokens above 32768 with a
  // bare "Request contains an invalid argument." (verified against the live
  // API: 32768 → 200, 40000 → 400). The catalog's 65536 used to win, because
  // the per-wire cap only applied when a wire profile existed.
  test("gpt-oss output tokens are capped at its real 32768 ceiling", async () => {
    const explicit = new CapturingProvider();
    await explicit.chatCompletion(agAccount, agRequest({ model: "ag-gpt-oss-120b-medium", max_tokens: 200000 }));
    expect(explicit.lastEnvelope.request.generationConfig.maxOutputTokens).toBe(32768);
  });

  test("gpt-oss is capped even when the request omits max_tokens", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({ model: "ag-gpt-oss-120b-medium" }));
    expect(provider.lastEnvelope.request.generationConfig.maxOutputTokens).toBe(32768);
  });

  test("competing-client branding is rewritten in the system prompt", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      messages: [
        { role: "system", content: "You are a Claude agent, built on Anthropic's Claude Agent SDK. powered by OpenCode" },
        { role: "user", content: "hi" },
      ],
    }));
    const text = provider.lastEnvelope.request.systemInstruction!.parts[0]!.text;
    expect(text).not.toContain("Claude Agent SDK");
    expect(text).not.toContain("OpenCode");
    expect(text).toContain("Antigravity");
  });

  test("toolNameMap stays local and is not serialized onto the wire", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest({
      tools: [{ type: "function", function: { name: "mcp/x", parameters: { type: "object", properties: {} } } }],
    }));

    // The map must exist locally (it drives response name restoration)…
    expect(provider.lastEnvelope.toolNameMap).toBeDefined();
    // …but never reach the wire: the serializer is the single definition of
    // what is sent upstream.
    const wire = serializeAntigravityEnvelope(provider.lastEnvelope);
    expect(wire).not.toContain("toolNameMap");
    expect(JSON.parse(wire).request.tools[0].functionDeclarations[0].name).toBe("mcp_x");
  });
});

describe("AntigravityProvider response handling", () => {
  test("thought parts go to reasoning_content, not content", async () => {
    const provider = new CapturingProvider(() => sseResponse([
      { candidates: [{ content: { parts: [{ text: "thinking...", thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }] },
    ]));

    const result = await provider.chatCompletion(agAccount, agRequest());
    const message = messageOf(result);
    expect(message.content).toBe("answer");
    expect(message.reasoning_content).toBe("thinking...");
  });

  test("SAFETY finish reason maps to content_filter", async () => {
    const provider = new CapturingProvider(() => sseResponse([
      { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "SAFETY" }] },
    ]));
    const result = await provider.chatCompletion(agAccount, agRequest());
    expect(result.response!.choices[0]!.finish_reason).toBe("content_filter");
  });

  test("sanitized tool names are restored in the response", async () => {
    const provider = new CapturingProvider(() => sseResponse([
      { candidates: [{ content: { parts: [{ functionCall: { name: "mcp_read_file", args: { p: 1 } } }] }, finishReason: "STOP" }] },
    ]));
    const result = await provider.chatCompletion(agAccount, agRequest({
      tools: [{ type: "function", function: { name: "mcp/read file", parameters: { type: "object", properties: {} } } }],
    }));
    const call = messageOf(result).tool_calls![0]!;
    expect(call.function.name).toBe("mcp/read file");
    expect(result.response!.choices[0]!.finish_reason).toBe("tool_calls");
  });

  test("an error frame inside a 200 stream fails the request", async () => {
    const provider = new CapturingProvider(() => sseResponse([
      { error: { code: 429, message: "Quota exhausted for this model", status: "RESOURCE_EXHAUSTED" } },
    ]));
    const result = await provider.chatCompletion(agAccount, agRequest());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Quota exhausted");
  });

  test("429 with a quota body is marked exhausted, not merely rate limited", async () => {
    const provider = new CapturingProvider(() => jsonResponse(
      { error: { message: "You have exhausted your quota. Your quota will reset after 2h7m23s" } },
      429,
    ));
    const result = await provider.chatCompletion(agAccount, agRequest());
    expect(result.success).toBe(false);
    expect(result.quotaExhausted).toBe(true);
    expect(result.rateLimited).toBe(false);
  });

  test("429 without a quota body is a rate limit, not exhaustion", async () => {
    const provider = new CapturingProvider(() => jsonResponse(
      { error: { message: "Resource has been exhausted (e.g. check quota)." } },
      429,
    ));
    const result = await provider.chatCompletion(agAccount, agRequest());
    expect(result.rateLimited).toBe(true);
    expect(result.quotaExhausted).toBe(false);
  });
});

describe("AntigravityProvider streaming", () => {
  async function collect(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text
      .split("\n\n")
      .map((block) => block.split("\n").find((line) => line.startsWith("data:")))
      .filter((line): line is string => !!line)
      .map((line) => (line.startsWith("data: ") ? line.slice(6) : line.slice(5)).trim())
      .filter((payload) => payload && payload !== "[DONE]")
      .map((payload) => JSON.parse(payload));
  }

  test("thought deltas stream as reasoning_content", async () => {
    const provider = new CapturingProvider(() => sseResponse([
      { candidates: [{ content: { parts: [{ text: "hmm", thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] },
    ]));
    const result = await provider.chatCompletionStream(agAccount, agRequest());
    const chunks = await collect(result.stream!);
    const reasoning = chunks.filter((c) => c.choices?.[0]?.delta?.reasoning_content);
    const content = chunks.filter((c) => c.choices?.[0]?.delta?.content);
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].choices[0].delta.reasoning_content).toBe("hmm");
    expect(content.some((c) => c.choices[0].delta.content === "hi")).toBe(true);
  });

  test("a stream without a finish reason still terminates with one", async () => {
    const provider = new CapturingProvider(() => sseResponse([
      { candidates: [{ content: { parts: [{ text: "truncated" }] } }] },
    ]));
    const result = await provider.chatCompletionStream(agAccount, agRequest());
    const chunks = await collect(result.stream!);
    const finishes = chunks.filter((c) => c.choices?.[0]?.finish_reason);
    expect(finishes).toHaveLength(1);
    expect(finishes[0].choices[0].finish_reason).toBe("stop");
  });

  // Same contract as the non-streaming path: the upstream signature is passed
  // through so the client can replay it on the next turn.
  test("the upstream thoughtSignature is surfaced in streamed tool calls", async () => {
    const provider = new CapturingProvider(() => sseResponse([
      { candidates: [{ content: { parts: [
        { functionCall: { name: "read_file", args: {} }, thoughtSignature: "sig-stream" },
      ] }, finishReason: "STOP" }] },
    ]));
    const result = await provider.chatCompletionStream(agAccount, agRequest({
      tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }],
    }));
    const chunks = await collect(result.stream!);
    const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(calls[0]?.thoughtSignature).toBe("sig-stream");
  });

  test("image models are served non-streamed", async () => {
    const provider = new CapturingProvider(() => jsonResponse(IMAGE_BODY));
    const result = await provider.chatCompletionStream(agAccount, agRequest({ model: "ag-gemini-3-1-flash-image" }));
    expect(result.stream).toBeUndefined();
    expect(result.success).toBe(true);
    expect(String(messageOf(result).content)).toContain("data:image/png;base64,QUJD");
  });
});

describe("AntigravityProvider image generation envelope", () => {
  test("uses requestType image_gen with an imageConfig aspect ratio", async () => {
    const provider = new CapturingProvider(() => jsonResponse(IMAGE_BODY));
    await provider.chatCompletion(agAccount, agRequest({ model: "ag-gemini-3-1-flash-image" }));
    expect(provider.lastEnvelope.requestType).toBe("image_gen");
    expect(provider.lastEnvelope.request.generationConfig.imageConfig!.aspectRatio).toBe("1:1");
    // Image backend rejects chat-shaped fields.
    expect(provider.lastEnvelope.request.tools).toBeUndefined();
    expect(provider.lastEnvelope.request.generationConfig.thinkingConfig).toBeUndefined();
  });
});

describe("AntigravityProvider session state", () => {
  test("a fresh conversation resets the step index", async () => {
    const provider = new CapturingProvider();
    await provider.chatCompletion(agAccount, agRequest());
    const firstStep = provider.lastEnvelope.request.labels.last_step_index;
    await provider.chatCompletion(agAccount, agRequest());
    expect(provider.lastEnvelope.request.labels.last_step_index).toBe(firstStep);
  });

  test("a continued conversation advances the step index", async () => {
    const provider = new CapturingProvider();
    const continued = agRequest({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
    });
    await provider.chatCompletion(agAccount, continued);
    const first = Number(provider.lastEnvelope.request.labels.last_step_index);
    await provider.chatCompletion(agAccount, continued);
    const second = Number(provider.lastEnvelope.request.labels.last_step_index);
    expect(second).toBeGreaterThan(first);
  });

  test("state stays bounded across many accounts", async () => {
    const provider = new CapturingProvider();
    for (let i = 0; i < 400; i++) {
      await provider.chatCompletion({ ...agAccount, id: i } as unknown as Account, agRequest());
    }
    expect(provider.sessionStateSize()).toBeLessThanOrEqual(256);
  });
});

describe("parseAntigravityRetryDelay", () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  test("reads Retry-After seconds", () => {
    expect(parseAntigravityRetryDelay(headers({ "retry-after": "5" }), "")).toBe(5000);
  });

  test("parses the reset-after duration embedded in the error body", () => {
    expect(parseAntigravityRetryDelay(headers({}), "quota will reset after 1h30m")).toBe(5_400_000);
  });

  test("returns null when no retry hint exists", () => {
    expect(parseAntigravityRetryDelay(headers({}), "Invalid request")).toBeNull();
  });
});
