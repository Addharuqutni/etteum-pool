/**
 * EMPIRICAL REPRO: is the combo fallback ORDER actually honored?
 *
 * Drives the real /v1/chat/completions route with globalThis.fetch stubbed at
 * the transport boundary. The stub records EVERY upstream attempt (model id +
 * bearer token) in call order, so we can assert the observed attempt sequence
 * equals the configured target sequence.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { accounts, combos, requestLogs } from "../../src/db/schema";
import { eq, inArray } from "drizzle-orm";
import { encrypt } from "../../src/utils/crypto";
import { refreshByokModels } from "../../src/proxy/providers/registry";
import { ensureCombosTable, loadCombos, createCombo } from "../../src/proxy/combos";

const FAKE_UPSTREAM = "https://api.test.invalid/v1";

async function deleteByokAccounts() {
  const ids = (await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.provider, "byok"))).map(
    (r) => r.id
  );
  if (ids.length > 0) {
    await db.update(requestLogs).set({ accountId: null }).where(inArray(requestLogs.accountId, ids));
  }
  await db.delete(accounts).where(eq(accounts.provider, "byok"));
}

async function seedByok(prefix: string, models: string[], status = "active") {
  await db.insert(accounts).values({
    provider: "byok",
    email: prefix,
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

type Attempt = { model?: string; bearer: string };
type Plan = Array<{ status: number; body: unknown }>;

function okResponse(content: string) {
  return {
    status: 200,
    body: {
      id: "ok",
      object: "chat.completion",
      model: "glm-5.3",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    },
  };
}

const RATE_LIMITED = {
  status: 429,
  body: { error: { message: "Upstream rate limit or quota exceeded" } },
};
const SERVER_ERROR = {
  status: 500,
  body: { error: { message: "upstream blew up" } },
};

/**
 * Installs a fetch stub that records every upstream attempt and replays
 * `plan` in order (attempt N -> plan[N-1]). Extra attempts beyond the plan
 * fall through to plan[plan.length - 1] so unexpected extra calls show up in
 * the recorded list rather than crashing the stub.
 */
function installFetchStub(attempts: Attempt[], plan: Plan) {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    let model: string | undefined;
    try {
      model = (JSON.parse(String(init?.body ?? "{}")) as { model?: string }).model;
    } catch {
      model = undefined;
    }
    attempts.push({ model, bearer: readBearer(init?.headers) });
    const step = plan[Math.min(attempts.length, plan.length) - 1] ?? { status: 500, body: { error: "no plan" } };
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

async function postChat(model: string) {
  const { proxyRouter } = await import("../../src/proxy/index");
  return proxyRouter.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

const ALPHA = "Bearer test-key-alpha";
const BETA = "Bearer test-key-beta";
const GAMMA = "Bearer test-key-gamma";

describe("combo fallback ORDER (repro)", () => {
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

  async function seedThree() {
    await seedByok("alpha", ["glm-5.3"]);
    await seedByok("beta", ["glm-5.3"]);
    await seedByok("gamma", ["glm-5.3"]);
  }

  it("(a) walks the 3-target chain in the configured order", async () => {
    await seedThree();
    await createCombo({ name: "OrderRepro", targets: ["alpha-glm-5.3", "beta-glm-5.3", "gamma-glm-5.3"] });
    await loadCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [RATE_LIMITED, RATE_LIMITED, RATE_LIMITED]);

    const res = await postChat("OrderRepro");
    // Exhausted chain: an error status is surfaced (route maps generic
    // upstream failure to 503; only invalid-model shapes become 400).
    expect(res.status).toBeGreaterThanOrEqual(400);

    expect(attempts.map((a) => a.bearer)).toEqual([ALPHA, BETA, GAMMA]);
  });

  it("(b) first target succeeds -> exactly ONE upstream call, to the first target", async () => {
    await seedThree();
    await createCombo({ name: "FirstWins", targets: ["alpha-glm-5.3", "beta-glm-5.3", "gamma-glm-5.3"] });
    await loadCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [okResponse("served-by-alpha")]);

    const res = await postChat("FirstWins");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(json.choices?.[0]?.message?.content).toBe("served-by-alpha");

    expect(attempts.length).toBe(1);
    expect(attempts[0]?.bearer).toBe(ALPHA);
  });

  it("(c) middle target 429s -> third target is attempted next, no repeats", async () => {
    await seedThree();
    await createCombo({ name: "MiddleFails", targets: ["alpha-glm-5.3", "beta-glm-5.3", "gamma-glm-5.3"] });
    await loadCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [SERVER_ERROR, RATE_LIMITED, okResponse("served-by-gamma")]);

    const res = await postChat("MiddleFails");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(json.choices?.[0]?.message?.content).toBe("served-by-gamma");

    expect(attempts.map((a) => a.bearer)).toEqual([ALPHA, BETA, GAMMA]);
    // No target attempted twice.
    expect(new Set(attempts.map((a) => a.bearer)).size).toBe(attempts.length);
  });

  it("(d) first fails, second succeeds -> attempt order [first, second]", async () => {
    await seedThree();
    await createCombo({ name: "SecondWins", targets: ["alpha-glm-5.3", "beta-glm-5.3", "gamma-glm-5.3"] });
    await loadCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [SERVER_ERROR, okResponse("served-by-beta")]);

    const res = await postChat("SecondWins");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(json.choices?.[0]?.message?.content).toBe("served-by-beta");

    expect(attempts.map((a) => a.bearer)).toEqual([ALPHA, BETA]);
  });
});
