import { describe, expect, test } from "bun:test";
import {
  GrokCliProvider,
  extractGrokCliCredits,
  extractGrokCliTokenUsage,
} from "../../src/proxy/providers/grok-cli";
import { providers } from "../../src/proxy/providers/registry";

describe("GrokCliProvider", () => {
  const p = new GrokCliProvider();

  test("owns exact grok-4.5 catalog ids only", () => {
    expect(p.ownsModel("grok-4.5")).toBe(true);
    expect(p.ownsModel("grok-4.5-high")).toBe(true);
    expect(p.ownsModel("grok-4.5-medium")).toBe(true);
    expect(p.ownsModel("grok-4.5-low")).toBe(true);
    expect(p.ownsModel("grok-3")).toBe(false);
    expect(p.ownsModel("gcli-4.5")).toBe(false);
  });

  test("registry exposes grok-cli", () => {
    expect(providers["grok-cli"]).toBeTruthy();
    expect(providers["grok-cli"].name).toBe("grok-cli");
  });

  test("validateAccount requires access_token", async () => {
    expect(await p.validateAccount({ tokens: null } as any)).toBe(false);
    expect(await p.validateAccount({ tokens: { access_token: "x" } } as any)).toBe(true);
  });

  test("refreshToken fails without refresh_token", async () => {
    const r = await p.refreshToken({ tokens: { access_token: "a" } } as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/refresh/i);
  });

  test("effort variants share same fallback credit rate", () => {
    const base = p.getProviderCreditRate("grok-4.5");
    expect(base).toBe(0.02 / 1000);
    expect(p.getProviderCreditRate("grok-4.5-high")).toBe(base);
    expect(p.getProviderCreditRate("grok-4.5-medium")).toBe(base);
    expect(p.getProviderCreditRate("grok-4.5-low")).toBe(base);
  });
});

describe("extractGrokCliCredits", () => {
  test("reads common upstream credit fields", () => {
    expect(extractGrokCliCredits({ credit: 1.5 })).toBe(1.5);
    expect(extractGrokCliCredits({ credits: 2 })).toBe(2);
    expect(extractGrokCliCredits({ credits_used: 0.25 })).toBe(0.25);
    expect(extractGrokCliCredits({ creditsUsed: 3 })).toBe(3);
    expect(extractGrokCliCredits({ num_credits: 4 })).toBe(4);
    expect(extractGrokCliCredits({ cost_in_credits: 0.1 })).toBe(0.1);
    expect(extractGrokCliCredits({ cost: { credits: 0.2 } })).toBe(0.2);
    expect(extractGrokCliCredits({ billing: { credits: 0.3 } })).toBe(0.3);
  });

  test("reads camelCase token fields", () => {
    expect(extractGrokCliTokenUsage({ inputTokens: 12, outputTokens: 8 })).toEqual({
      inputTokens: 12,
      outputTokens: 8,
    });
  });

  test("ignores missing/zero/invalid", () => {
    expect(extractGrokCliCredits(null)).toBe(null);
    expect(extractGrokCliCredits({})).toBe(null);
    expect(extractGrokCliCredits({ credit: 0 })).toBe(null);
    expect(extractGrokCliCredits({ credit: "nope" })).toBe(null);
    expect(extractGrokCliCredits({ input_tokens: 10, output_tokens: 5 })).toBe(null);
  });
});

describe("extractGrokCliTokenUsage", () => {
  test("reads Responses API token fields", () => {
    expect(extractGrokCliTokenUsage({ input_tokens: 100, output_tokens: 20 })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(extractGrokCliTokenUsage({ prompt_tokens: 50, completion_tokens: 10 })).toEqual({
      inputTokens: 50,
      outputTokens: 10,
    });
  });
});

describe("GrokCliProvider.fetchQuota billing shapes", () => {
  const p = new GrokCliProvider();

  // Stub fetchWithTimeout by overriding the prototype method.
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

  const account = { tokens: JSON.stringify({ access_token: "x", email: "a@b", user_id: "u" }) } as any;

  test("parses format=credits shape (currentPeriod + onDemand)", async () => {
    stubFetch({
      config: {
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-07-22T00:00:00+00:00", end: "2026-07-29T00:00:00+00:00" },
        onDemandCap: { val: 100 },
        onDemandUsed: { val: 30 },
        prepaidBalance: { val: 5 },
      },
    });
    try {
      const r = await p.fetchQuota(account);
      expect(r.success).toBe(true);
      expect(r.quota).toMatchObject({ limit: 100, remaining: 70, used: 30 });
      expect(r.quota?.resetAt).toBe("2026-07-29T00:00:00+00:00");
    } finally {
      restoreFetch();
    }
  });

  test("parses format=json shape (monthlyLimit + used)", async () => {
    stubFetch({
      config: {
        monthlyLimit: { val: 500 },
        used: { val: 120 },
        onDemandCap: { val: 0 },
        billingPeriodEnd: "2026-08-01T00:00:00+00:00",
      },
    });
    try {
      const r = await p.fetchQuota(account);
      expect(r.success).toBe(true);
      expect(r.quota).toMatchObject({ limit: 500, remaining: 380, used: 120 });
    } finally {
      restoreFetch();
    }
  });

  test("zero cap reports sentinel -1 remaining (unknown, not exhausted)", async () => {
    stubFetch({
      config: { monthlyLimit: { val: 0 }, used: { val: 0 }, onDemandCap: { val: 0 } },
    });
    try {
      const r = await p.fetchQuota(account);
      expect(r.success).toBe(true);
      expect(r.quota?.limit).toBe(0);
      expect(r.quota?.remaining).toBe(-1);
    } finally {
      restoreFetch();
    }
  });

  test("unknown shape returns sentinel -1/-1", async () => {
    stubFetch({ weird: true });
    try {
      const r = await p.fetchQuota(account);
      expect(r.success).toBe(true);
      expect(r.quota).toMatchObject({ limit: -1, remaining: -1, used: 0 });
    } finally {
      restoreFetch();
    }
  });

  test("HTTP 402 surfaces as exhausted", async () => {
    stubFetch({ error: "no credits" }, 402);
    try {
      const r = await p.fetchQuota(account);
      expect(r.success).toBe(true);
      expect(r.quota).toMatchObject({ limit: 1, remaining: 0, used: 1 });
    } finally {
      restoreFetch();
    }
  });
});
