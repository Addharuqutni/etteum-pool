import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { db } from "../../src/db/index";
import { accounts, combos, requestLogs } from "../../src/db/schema";
import { eq, inArray } from "drizzle-orm";
import { encrypt } from "../../src/utils/crypto";
import { refreshByokModels } from "../../src/proxy/providers/registry";
import {
  comboMatches,
  parseTargets,
  ensureCombosTable,
  loadCombos,
  createCombo,
  deleteCombo,
  updateCombo,
  getCombosCached,
} from "../../src/proxy/combos";

/**
 * request_logs.account_id references accounts.id, so account rows cannot be
 * deleted while a log row still points at them. Detach first.
 */
async function deleteByokAccounts() {
  const ids = (await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.provider, "byok"))).map(
    (r) => r.id
  );
  if (ids.length > 0) {
    await db.update(requestLogs).set({ accountId: null }).where(inArray(requestLogs.accountId, ids));
  }
  await db.delete(accounts).where(eq(accounts.provider, "byok"));
}

/**
 * Combo fallback chain behavior.
 *
 * The bug this locks in: combo targets that resolve to no provider used to
 * consume a fallback slot and surface as an upstream (503) failure, and
 * intermediate fallback failures were logged against the TARGET model id
 * instead of the combo name, making chains impossible to attribute.
 */

const FAKE_UPSTREAM = "https://api.test.invalid/v1";

async function seedByok(prefix: string, models: string[], status = "active") {
  await db.insert(accounts).values({
    provider: "byok",
    email: prefix,
    // Keyed per prefix so tests can tell accounts apart by bearer token.
    password: encrypt(`test-key-${prefix}`),
    status,
    enabled: true,
    tokens: JSON.stringify({
      base_url: FAKE_UPSTREAM,
      format: "openai",
      models,
      model_prefix: prefix,
    }),
  });
  await refreshByokModels();
}
function readBearer(headers: RequestInit["headers"]): string {
  if (!headers) return "";
  return new Headers(headers).get("authorization") ?? "";
}

describe("combo target validation", () => {
  it("rejects non-array / empty / too-many / duplicate targets", () => {
    expect(() => parseTargets("nope")).toThrow(/array/);
    expect(() => parseTargets([])).toThrow(/between 1 and 10/);
    expect(() => parseTargets(Array.from({ length: 11 }, (_, i) => `m${i}`))).toThrow(/between 1 and 10/);
    expect(() => parseTargets(["a", "a"])).toThrow(/duplicate/);
    expect(() => parseTargets(["  "])).toThrow(/non-empty/);
    expect(parseTargets([" a ", "b"])).toEqual(["a", "b"]);
  });
});

describe("comboMatches", () => {
  const rows = [
    { name: "Enabled", targets: ["a", "b"], enabled: true },
    { name: "Disabled", targets: ["c"], enabled: false },
  ];

  it("returns ordered targets for an enabled exact match", () => {
    expect(comboMatches("Enabled", rows)).toEqual(["a", "b"]);
  });

  it("ignores disabled combos", () => {
    expect(comboMatches("Disabled", rows)).toBeNull();
  });

  // Name matching is case-insensitive (see comboMatches); substring/prefix
  // matching is still NOT performed.
  it("is case-insensitive but exact (no prefix/substring match)", () => {
    expect(comboMatches("enabled", rows)).toEqual(["a", "b"]);
    // lowercase exact ('enabled') matches (see above); 'enable'/'Enable' are
    // prefixes that drop the 'd', so they are NOT exact matches at all.
    expect(comboMatches("Enable", rows)).toBeNull(); // prefix 'Enable' is NOT exact
    expect(comboMatches("nable", rows)).toBeNull();
    expect(comboMatches("EnabledX", rows)).toBeNull();
  });

  it("returns null for unknown names", () => {
    expect(comboMatches("nope", rows)).toBeNull();
  });
});

describe("combo persistence + cache", () => {
  beforeEach(async () => {
    ensureCombosTable();
    await db.delete(combos);
    await loadCombos();
  });

  afterEach(async () => {
    await db.delete(combos);
    await loadCombos();
  });

  it("create -> cache -> delete round trip", async () => {
    const created = await createCombo({ name: "Chain", targets: ["m1", "m2"] });
    await loadCombos();
    expect(getCombosCached().map((c) => c.name)).toContain("Chain");

    const deleted = await deleteCombo(created.id);
    await loadCombos();
    expect(deleted).toBe(true);
    expect(getCombosCached().map((c) => c.name)).not.toContain("Chain");
  });

  it("rejects duplicate combo names", async () => {
    await createCombo({ name: "Dup", targets: ["m1"] });
    await expect(createCombo({ name: "Dup", targets: ["m2"] })).rejects.toThrow(/already exists/);
  });
});

describe("BYOK-backed combo target resolution", () => {
  beforeEach(async () => {
    await deleteByokAccounts();
    await refreshByokModels();
  });

  afterEach(async () => {
    await deleteByokAccounts();
    await refreshByokModels();
  });

  it("resolves each enabled prefix's models as combo-callable ids", async () => {
    await seedByok("alpha", ["glm-5.3"]);
    await seedByok("beta", ["glm-5.3"]);

    const { pool } = await import("../../src/proxy/pool");
    expect(pool.getProviderForModel("alpha-glm-5.3")).toBe("byok");
    expect(pool.getProviderForModel("beta-glm-5.3")).toBe("byok");
    expect(pool.getProviderForModel("gamma-glm-5.3")).toBeNull();
  });

  it("keeps owning a prefix when the account is in error status", async () => {
    await seedByok("erring", ["glm-5.3"], "error");
    const { pool } = await import("../../src/proxy/pool");
    expect(pool.getProviderForModel("erring-glm-5.3")).toBe("byok");
  });

  it("does not own models from a disabled account (unresolvable combo target)", async () => {
    await db.insert(accounts).values({
      provider: "byok",
      email: "offprefix",
      password: encrypt("k"),
      status: "active",
      enabled: false,
      tokens: JSON.stringify({
        base_url: FAKE_UPSTREAM, format: "openai", models: ["glm-5.3"], model_prefix: "offprefix",
      }),
    });
    await refreshByokModels();
    const { pool } = await import("../../src/proxy/pool");
    expect(pool.getProviderForModel("offprefix-glm-5.3")).toBeNull();
  });
});

/**
 * End-to-end: drive the real /v1/chat/completions route with the upstream
 * stubbed at the transport boundary. Proves the chain advances past a failing
 * target instead of dying on it.
 */
describe("combo fallback end-to-end", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    await deleteByokAccounts();
    await db.delete(combos);
    ensureCombosTable();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await deleteByokAccounts();
    await db.delete(combos);
    await loadCombos();
    await refreshByokModels();
  });

  it("falls through a failing target to a healthy one further down the chain", async () => {
    await seedByok("badprefix", ["glm-5.3"]);
    await seedByok("goodprefix", ["glm-5.3"]);

    await createCombo({ name: "ChainE2E", targets: ["badprefix-glm-5.3", "goodprefix-glm-5.3"] });
    await loadCombos();

    originalFetch = globalThis.fetch;
    const seenBodies: Array<{ model?: string }> = [];
    const seenKeys: string[] = [];
    // Both accounts share FAKE_UPSTREAM, so the account is identified by the
    // bearer token rather than the URL. The first target always fails with a
    // rate-limit; any subsequent target succeeds.
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenBodies.push(JSON.parse(String(init?.body ?? "{}")) as { model?: string });
      seenKeys.push(readBearer(init?.headers));
      const attempt = seenBodies.length;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: { message: "Upstream rate limit or quota exceeded" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "ok", object: "chat.completion", model: "glm-5.3",
          choices: [{ index: 0, message: { role: "assistant", content: "served-by-goodprefix" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const { proxyRouter } = await import("../../src/proxy/index");
    const res = await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "ChainE2E",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(json.choices?.[0]?.message?.content).toBe("served-by-goodprefix");

    // The chain advanced: the first (rate-limited) target was tried, then a
    // second upstream call was made against the other prefix.
    expect(seenBodies.length).toBe(2);
    // Every hop sent the STRIPPED model id — proving prefix routing executed.
    expect(seenBodies.every((b) => b.model === "glm-5.3")).toBe(true);
    // The fallback used a DIFFERENT account key than the failed attempt.
    expect(seenKeys[0]).not.toBe(seenKeys[1]);
  });

  it("surfaces the real upstream error, not a later unresolvable target's skip reason", async () => {
    // BUG A: `lastError` was overwritten by the "No provider found" skip
    // reason, so a real 429 from target 1 was clobbered by target 2's skip and
    // the user saw 503 "No provider found for model: nope-model".
    await seedByok("alpha", ["glm-5.3"]);

    await createCombo({ name: "Clobber", targets: ["alpha-glm-5.3", "nope-model"] });
    await loadCombos();

    originalFetch = globalThis.fetch;
    const alwaysRateLimited = async () =>
      new Response(JSON.stringify({ error: { message: "Upstream rate limit or quota exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    globalThis.fetch = alwaysRateLimited as unknown as typeof fetch;

    const { proxyRouter } = await import("../../src/proxy/index");
    const res = await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "Clobber", messages: [{ role: "user", content: "hi" }] }),
    });

    const json = (await res.json()) as { error?: { message?: string } };
    expect(json.error?.message).toContain("rate limit or quota exceeded");
    expect(json.error?.message).not.toContain("No provider found");
  });

  it("serves target 2 when target 1 fails with an invalid-model error", async () => {
    // BUG B: router.ts wraps per-account failures as
    //   All account attempt(s) failed for provider "X". Last error: <inner>
    // The combo loop ran isNonAccountRequestError() against that WRAPPED
    // string, so any inner text containing "invalid model" aborted the whole
    // chain and target 2 was never tried.
    await seedByok("alpha", ["glm-5.3"]);
    await seedByok("beta", ["glm-5.3"]);

    await createCombo({ name: "BadModelChain", targets: ["alpha-glm-5.3", "beta-glm-5.3"] });
    await loadCombos();

    originalFetch = globalThis.fetch;
    const seenKeys: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenKeys.push(readBearer(init?.headers));
      if (seenKeys.length === 1) {
        // An upstream 400 whose body mentions an invalid model.
        return new Response(
          JSON.stringify({ error: { message: "invalid model: glm-5.3 is not available" } }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          id: "ok", object: "chat.completion", model: "glm-5.3",
          choices: [{ index: 0, message: { role: "assistant", content: "served-by-beta" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const { proxyRouter } = await import("../../src/proxy/index");
    const res = await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "BadModelChain", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(json.choices?.[0]?.message?.content).toBe("served-by-beta");
    // The chain advanced past the invalid-model target instead of aborting.
    expect(seenKeys.length).toBe(2);
  });

  it("still attempts a rate-limit-cooled account on the NEXT request (full configured order)", async () => {
    // BUG C: a 429 put the account in an in-memory cooldown, and pool
    // selection EXCLUDED cooled accounts. The combo loop then skipped the
    // configured primary as "no account available", so REQ2 started at target
    // 2 while the UI still showed the user's order [alpha, beta, gamma].
    await seedByok("alpha", ["glm-5.3"]);
    await seedByok("beta", ["glm-5.3"]);
    await seedByok("gamma", ["glm-5.3"]);

    await createCombo({
      name: "CooldownChain",
      targets: ["alpha-glm-5.3", "beta-glm-5.3", "gamma-glm-5.3"],
    });
    await loadCombos();

    originalFetch = globalThis.fetch;
    let seenKeys: string[] = [];
    // alpha always 429s (cooling it); beta and gamma are healthy.
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const key = readBearer(init?.headers);
      seenKeys.push(key);
      if (key.includes("alpha")) {
        return new Response(JSON.stringify({ error: { message: "Upstream rate limit or quota exceeded" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "ok", object: "chat.completion", model: "glm-5.3",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const { proxyRouter } = await import("../../src/proxy/index");
    const post = () =>
      proxyRouter.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "CooldownChain", messages: [{ role: "user", content: "hi" }] }),
      });

    const short = () => seenKeys.map((k) => k.replace("Bearer test-key-", ""));

    seenKeys = [];
    const r1 = await post();
    expect(r1.status).toBe(200);
    // REQ1: alpha 429s, beta serves.
    expect(short()).toEqual(["alpha", "beta"]);

    // REQ2: alpha is now in cooldown, but the configured order must still be
    // attempted — it must not silently vanish from the chain.
    seenKeys = [];
    const r2 = await post();
    expect(r2.status).toBe(200);
    expect(short()).toContain("alpha");
  });

  it("reflects an update in resolveCombo immediately (no sleep)", async () => {
    // BUG D: invalidateComboCache() was fire-and-forget, so `await
    // updateCombo(...)` returned before the cache was reloaded. A request
    // racing the update resolved the OLD target order.
    const created = await createCombo({ name: "RaceCombo", targets: ["alpha-glm-5.3"] });
    await loadCombos();
    const { resolveCombo } = await import("../../src/proxy/combos");
    expect(resolveCombo("RaceCombo")).toEqual(["alpha-glm-5.3"]);

    // No sleep, no extra loadCombos(): awaiting the update must be enough.
    await updateCombo(created.id, { targets: ["alpha-glm-5.3", "beta-glm-5.3"] });
    expect(resolveCombo("RaceCombo")).toEqual(["alpha-glm-5.3", "beta-glm-5.3"]);
  });
});

/**
 * Regression guard: a standalone script run outside the bun test preload
 * resolves DATABASE_PATH from .env straight to the PRODUCTION db. Tests must
 * always run under the preload (test/setup.ts) which repoints DATABASE_PATH at
 * a tmpdir file. Fail loudly here rather than deleting real account rows.
 */
describe("test database isolation", () => {
  it("never points at the production database file", async () => {
    const { config } = await import("../../src/config");
    expect(config.databasePath).toContain("etteum-test-");
    expect(config.databasePath).not.toContain("poolprox3.db");
  });
});
