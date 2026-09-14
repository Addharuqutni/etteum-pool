import { afterEach, describe, expect, test } from "bun:test";
import {
  AntigravityProvider,
  antigravityProvider,
  antigravityWireTier,
  antigravityThinkingBudget,
  wantsWebSearch,
  discoverOrProvisionProject,
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
