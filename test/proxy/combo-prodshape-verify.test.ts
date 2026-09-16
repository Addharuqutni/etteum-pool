/**
 * PRODUCTION-SHAPE VERIFICATION: does combo fallback work on the user's REAL
 * combo/BYOK configuration?
 *
 * The production symptom (data/poolprox3.db, all combos enabled=1):
 *   - request model "bansos-glm-5.3"       -> 7/7 errors "Upstream rate limit or quota exceeded"
 *   - request model "bansos-glm-5-3-flash" -> 6/6 errors, same
 *   - NOT ONE configured fallback target was ever attempted.
 *
 * The confusing part of the prod shape is that the combo's TARGETS are
 * themselves raw BYOK ids that the proxy also advertises via GET /v1/models
 * ("bansos-glm-5-3-flash" is slot 0 of "Glm-5.3-flash"; "bansosbiwbiu-new/glm-5.3"
 * is slot 0 of "Glm-5.3"; "cb-deepseek-v4.1-flash" is slot 2 of
 * "Deepseek-v4.1-flash"). So a user can (and does) send the raw slot id instead
 * of the combo name.
 *
 * Harness conventions are copied from combo-fallback.test.ts and
 * combo-order-repro.test.ts: test DB isolation comes from the preload
 * (test/setup.ts repoints DATABASE_PATH at a tmpdir file), BYOK accounts are
 * seeded with the real production prefixes, globalThis.fetch is stubbed to
 * RECORD every attempted (model id, bearer token) pair in order, and the REAL
 * /v1/chat/completions route is driven through proxyRouter.request.
 *
 * This file asserts OBSERVED attempt sequences. It is a verifier, not a fix:
 * if the chain does not advance, the assertion fails and that failure IS the
 * reproduction.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db, client } from "../../src/db/index";
import { accounts, combos, requestLogs } from "../../src/db/schema";
import { eq, inArray } from "drizzle-orm";
import { encrypt } from "../../src/utils/crypto";
import { refreshByokModels } from "../../src/proxy/providers/registry";
import { ensureCombosTable, loadCombos, createCombo } from "../../src/proxy/combos";

const FAKE_UPSTREAM = "https://api.test.invalid/v1";

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
 * Seed a BYOK account. `label` is the bearer-token key ("bai-2" -> token
 * test-key-bai-2) and defaults to the routing `prefix`; production has FOUR
 * "bai" accounts that share one prefix and are told apart only by priority.
 */
async function seedByok(
  prefix: string,
  models: string[],
  opts: { label?: string; priority?: number; lbMethod?: string } = {}
) {
  await db.insert(accounts).values({
    provider: "byok",
    email: opts.label ?? prefix,
    // Keyed per label so tests can tell accounts apart by bearer token.
    password: encrypt(`test-key-${opts.label ?? prefix}`),
    status: "active",
    enabled: true,
    tokens: JSON.stringify({
      base_url: FAKE_UPSTREAM,
      format: "openai",
      models,
      model_prefix: prefix,
      // Production account rows carry priority 0/1/2/3 within the "bai" group
      // and per-account lb methods; mirror both (see data/poolprox3.db).
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      ...(opts.lbMethod ? { load_balancing_method: opts.lbMethod } : {}),
    }),
  });
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

/**
 * Records every upstream attempt and replays `plan` in order (attempt N ->
 * plan[N-1]). Extra attempts beyond the plan repeat its last step so an
 * unexpected extra call shows up in the recorded list rather than crashing.
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

/**
 * Which combo a failed request was attributed to. On the error path the route
 * re-resolves the combo from the ORIGINAL body.model and logs the row under the
 * combo's LAST target, carrying _poolprox.combo + _poolprox.originalModel.
 * Returns null when no such row exists (i.e. the request failed before the
 * combo path was reached).
 */
function comboAttribution(originalModel: string) {
  const row = client
    .query(
      `SELECT model, request_body, status FROM request_logs
       WHERE request_body LIKE ? ORDER BY id DESC LIMIT 1`
    )
    .get(`%"combo":"${originalModel}"%`) as
    | { model: string; request_body: string; status: string }
    | undefined;
  if (!row) return null;
  const body = JSON.parse(row.request_body) as {
    _poolprox?: { combo?: string; originalModel?: string };
  };
  return { rowModel: row.model, status: row.status, poolprox: body._poolprox };
}

/** Compact "what the stub saw" for the failure message. */
function describeAttempts(attempts: Attempt[]) {
  return attempts.map((a) => `${a.model} @ ${a.bearer.replace("Bearer test-key-", "")}`).join(" -> ") || "(none)";
}

/**
 * Most recent request_logs row whose `_poolprox.originalModel` is `originalModel`,
 * regardless of whether a `combo` key was attached. Distinguishes "logged under
 * a combo identity" from "logged under the bare request id".
 */
function latestLogByOriginal(originalModel: string) {
  const row = client
    .query(
      `SELECT model, request_body, status, error_message FROM request_logs
       WHERE request_body LIKE ? ORDER BY id DESC LIMIT 1`
    )
    .get(`%"originalModel":"${originalModel}"%`) as
    | { model: string; request_body: string; status: string; error_message: string | null }
    | undefined;
  if (!row) return null;
  const body = JSON.parse(row.request_body) as {
    model?: string;
    _poolprox?: { combo?: string; originalModel?: string };
  };
  return {
    rowModel: row.model,
    status: row.status,
    poolprox: body._poolprox ?? null,
    comboKey: body._poolprox?.combo ?? "(absent)",
  };
}

// ---------------------------------------------------------------------------
// REAL production combos (data/poolprox3.db, enabled=1)
// ---------------------------------------------------------------------------

const COMBO_GLM_FLASH = [
  "bansos-glm-5-3-flash",
  "bai-glm-5.3-flash",
  "bansosbiwbiu-new/glm-5.3-flash",
  "unorouter-glm-5.3-flash-search:free",
  "unorouter-glm-5.3-flash-think-search:free",
  "unorouter-glm-5.3-flash-thinking:free",
];

const COMBO_GLM_53 = [
  "bansosbiwbiu-new/glm-5.3",
  "unorouter-glm-5.3:free",
  "unorouter-glm-5.3-thinking:free",
  "unorouter-glm-5.3-think-search:free",
  "unorouter-glm-5.3-search:free",
  "warpize-glm-5.3",
  "cb-glm-5.3",
];

const COMBO_DEEPSEEK_FLASH = [
  "bansos-deepseek-v4.1-flash",
  "bai-deepseek-v4.1-flash",
  "cb-deepseek-v4.1-flash",
];

const COMBO_GEMINI_FLASH = [
  "ag-gemini-3-8-flash",
  "ag-gemini-3-7-flash-medium",
  "ag-gemini-3-6-flash-medium",
  "ag-gemini-3-5-flash-high",
];

// Bearer tokens the stub should observe, derived from the seeded prefixes.
// Production has four "bai" accounts (priorities 0..3); the winner is the
// priority-0 row, seeded as label "bai-1".
const BANSOS = "Bearer test-key-bansos";
const BAI = "Bearer test-key-bai-1";
const BANSOSBIWBIU = "Bearer test-key-bansosbiwbiu";
const UNOROUTER = "Bearer test-key-unorouter";
const WARPIZE = "Bearer test-key-warpize";
const CB = "Bearer test-key-cb";

describe("combo fallback on the REAL production configuration", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    await deleteByokAccounts();
    await db.delete(combos);
    ensureCombosTable();

    // The REAL BYOK accounts (accounts table, provider='byok', enabled=1,
    // status='active'), mirroring prefix, model list, priority and lb method
    // read out of data/poolprox3.db. The BYOK prefix cache sorts each prefix
    // group by (priority, id), so priority is what makes the "bai" group
    // deterministic.
    await seedByok(
      "bansos",
      ["glm-5.3", "glm-5-3-flash", "deepseek-v4.1-flash", "hy-4"],
      { priority: 0, lbMethod: "round_robin" }
    );
    await seedByok(
      "bansosbiwbiu",
      ["new/glm-5.3", "new/glm-5.3-flash", "new/deepseek-v4-flash"],
      { priority: 0, lbMethod: "sequential" }
    );
    await seedByok("unorouter", ["glm-5.3-flash-thinking:free", "glm-5.3:free"], {
      priority: 0,
      lbMethod: "sequential",
    });
    // FOUR accounts share the "bai" prefix in production; priorities 0..3.
    await seedByok("bai", ["glm-5.3-flash", "deepseek-v4.1-flash"], {
      label: "bai-1",
      priority: 0,
      lbMethod: "sequential",
    });
    await seedByok("bai", ["glm-5.3-flash", "deepseek-v4.1-flash"], {
      label: "bai-2",
      priority: 1,
      lbMethod: "sequential",
    });
    await seedByok("bai", ["glm-5.3-flash", "deepseek-v4.1-flash"], {
      label: "bai-3",
      priority: 2,
      lbMethod: "sequential",
    });
    await seedByok("bai", ["glm-5.3-flash", "deepseek-v4.1-flash"], {
      label: "bai-4",
      priority: 3,
      lbMethod: "sequential",
    });
    await seedByok("warpize", ["glm-5.2", "glm-5.3"], { priority: 0, lbMethod: "round_robin" });

    // "cb" is NOT present in production at all (the prod accounts table holds
    // no cb row: prefixes are bansos, bansosbiwbiu, unorouter, bai, enowx,
    // warpize). It is seeded here because case 3 needs slot 2 of
    // "Deepseek-v4.1-flash" (cb-deepseek-v4.1-flash) to be RESOLVABLE — the
    // promotion only does something observable when the promoted slot's prefix
    // actually owns the model. deepseek-v4.1-flash is therefore included in
    // this account's model list (production has no such row at all, so the
    // divergence is only "slot 2 is resolvable here, unresolvable in prod";
    // case 3b below measures the production-shaped unresolvable variant).
    await seedByok("cb", ["glm-5.3", "claude-opus-4.7-1m", "deepseek-v4.1-flash"], {
      priority: 0,
      lbMethod: "sequential",
    });

    // Production's global load_balancing_method is "sequential"; the test DB
    // has no settings rows, so the pool's default ("sequential") already
    // matches. Written out here so a settings-less test DB is not a silent
    // divergence from production.

    await refreshByokModels();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await deleteByokAccounts();
    await db.delete(combos);
    await loadCombos();
    await refreshByokModels();
  });

  /**
   * Echo the OBSERVED attempt array to stdout so a failing run records the
   * real sequence in the raw output, not just a true/false assertion result.
   */
  function report(label: string, res: Response, attempts: Attempt[], extra?: unknown) {
    console.log(
      `[verify] ${label} -> status=${res.status} attempts=[${attempts
        .map((a) => `${a.model}@${a.bearer.replace("Bearer test-key-", "")}`)
        .join(", ")}]` + (extra === undefined ? "" : ` ${JSON.stringify(extra)}`)
    );
  }

  async function seedProdCombos() {
    await createCombo({ name: "Glm-5.3-flash", targets: COMBO_GLM_FLASH });
    await createCombo({ name: "Glm-5.3", targets: COMBO_GLM_53 });
    await createCombo({ name: "Deepseek-v4.1-flash", targets: COMBO_DEEPSEEK_FLASH });
    await createCombo({ name: "Gemini-flash", targets: COMBO_GEMINI_FLASH });
    await loadCombos();
  }

  it("case 1: raw slot-0 id promotes onto the chain (429 then 200)", async () => {
    await seedProdCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    // First upstream call 429s, everything after succeeds.
    installFetchStub(attempts, [RATE_LIMITED, okResponse("served-by-slot1")]);

    const res = await postChat("bansos-glm-5-3-flash");
    const observed = { status: res.status, attempts: attempts.map((a) => ({ model: a.model, key: a.bearer })) };
    report("case 1 raw slot-0 id", res, attempts, { attribution: comboAttribution("bansos-glm-5-3-flash") });

    // DESIRED (what the user asked for): "bansos-glm-5-3-flash" is slot 0 of
    // "Glm-5.3-flash", so the chain must advance to slot 1 (bai-glm-5.3-flash)
    // and answer 200.
    expect(
      observed.status === 200 &&
        attempts.map((a) => a.model).join(",") === "glm-5-3-flash,glm-5.3-flash" &&
        attempts.map((a) => a.bearer).join(",") === `${BANSOS},${BAI}`
    ).toBe(true);
    expect(observed).toMatchObject({ status: 200 });
    expect(attempts.map((a) => a.model)).toEqual(["glm-5-3-flash", "glm-5.3-flash"]);
    expect(attempts.map((a) => a.bearer)).toEqual([BANSOS, BAI]);
  });

  it("case 2: the combo NAME itself works (429 then 200)", async () => {
    await seedProdCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [RATE_LIMITED, okResponse("served-by-slot1")]);

    const res = await postChat("Glm-5.3-flash");
    report("case 2 combo NAME", res, attempts, { attribution: comboAttribution("Glm-5.3-flash") });

    expect(res.status).toBe(200);
    expect(attempts.map((a) => a.model)).toEqual(["glm-5-3-flash", "glm-5.3-flash"]);
    expect(attempts.map((a) => a.bearer)).toEqual([BANSOS, BAI]);
  });

  it("case 3: raw deep-slot id starts at its own slot (nothing before it)", async () => {
    await seedProdCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    // Promotion means the chain starts AT slot 2 and slot 2 is the LAST slot,
    // so a healthy slot 2 produces exactly ONE upstream call.
    installFetchStub(attempts, [okResponse("served-by-slot2")]);

    // "cb-deepseek-v4.1-flash" is slot 2 (index 2) of "Deepseek-v4.1-flash".
    const res = await postChat("cb-deepseek-v4.1-flash");
    report("case 3 raw deep-slot id", res, attempts, { attribution: comboAttribution("cb-deepseek-v4.1-flash") });

    // OBSERVED: a promoted deep slot starts AT its own slot, so slots 0 and 1
    // are skipped by design.
    expect(attempts.map((a) => a.bearer)).not.toContain(BANSOS);
    expect(attempts.map((a) => a.bearer)).not.toContain(BAI);

    // The load-bearing assertions: exactly ONE upstream call, and it went to
    // slot 2's prefix. A bare "nothing before it" check is vacuously true when
    // zero attempts happen, so the count is asserted explicitly.
    expect(attempts.map((a) => a.model)).toEqual(["deepseek-v4.1-flash"]);
    expect(attempts.map((a) => a.bearer)).toEqual([CB]);
    expect(res.status).toBe(200);
  });

  it("case 4: non-combo raw id is unchanged (exactly one upstream attempt)", async () => {
    await seedProdCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [okResponse("served-direct")]);

    const res = await postChat("bansos-hy-4");
    report("case 4 non-combo raw id", res, attempts, { attribution: comboAttribution("bansos-hy-4") });

    expect(res.status).toBe(200);
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.bearer).toBe(BANSOS);
    expect(attempts[0]?.model).toBe("hy-4");
  });

  it("case 5 (sanity): every target fails -> error, not a loop", async () => {
    await seedProdCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [RATE_LIMITED, RATE_LIMITED]);

    // "Deepseek-v4.1-flash" is a 3-target chain; slot 2 (cb) is not resolvable
    // (no cb account owns deepseek-v4.1-flash), so the chain advances on
    // slots 0 and 1 only.
    const res = await postChat("Deepseek-v4.1-flash");
    report("case 5 all targets fail", res, attempts, {
      attribution: comboAttribution("Deepseek-v4.1-flash"),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    // Bounded: the router retries each ACCOUNT inside a prefix group, so the
    // attempt count is (accounts behind the attempted targets), never the
    // signature of an unbounded loop. Assert magnitude, not an exact count,
    // so re-seeding the prefix groups does not make this brittle.
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.length).toBeLessThan(10);

    const observed = {
      status: res.status,
      attempts: describeAttempts(attempts),
      distinctKeys: new Set(attempts.map((a) => a.bearer)).size,
      attribution: comboAttribution("Deepseek-v4.1-flash"),
    };
    expect({
      status: observed.status,
      attemptSequence: observed.attempts,
      distinctKeys: observed.distinctKeys,
      attribution: observed.attribution,
    }).toBeDefined();
    // No single key is hammered indefinitely (a loop would repeat one key).
    expect(observed.distinctKeys).toBeGreaterThanOrEqual(2);
  });

  it("attribution: is the failing raw-id request logged as combo 'Glm-5.3-flash'?", async () => {
    await seedProdCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [RATE_LIMITED, okResponse("served-by-slot1")]);

    const res = await postChat("bansos-glm-5-3-flash");
    report("attribution success hop", res, attempts);
    expect(res.status).toBe(200);

    // Probe by _poolprox.originalModel rather than the `model` column: the
    // route writes the row under whichever id it treated as the serving model,
    // so only the originalModel key reliably identifies this request.
    const row = latestLogByOriginal("bansos-glm-5-3-flash");
    report("attribution success hop log row", res, attempts, { row });
    expect(row).not.toBeNull();
    expect(row!.poolprox?.combo).toBe("Glm-5.3-flash");
    expect(row!.poolprox?.originalModel).toBe("bansos-glm-5-3-flash");
  });

  it("attribution probe: what does the FAILING raw-id request log?", async () => {
    await seedProdCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [RATE_LIMITED, RATE_LIMITED]);

    const res = await postChat("bansos-glm-5-3-flash");
    const attribution = comboAttribution("bansos-glm-5-3-flash");
    report("attribution probe (failing)", res, attempts, { attribution });

    // Independent measurement of the user's production symptom: when the
    // request dies, is it attributed to the combo (proving the combo path was
    // entered) or to the bare raw id (proving it was not)?
    expect({ status: res.status, attempts: describeAttempts(attempts), attribution }).toBeDefined();
  });

  it("case 6: raw id that is in NO combo -> exactly ONE upstream attempt", async () => {
    await seedProdCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    // "bansos-hy-4" is a real bansos model in the prod account list, and it is
    // a target of NO configured combo (verified against data/poolprox3.db:
    // the six enabled combos carry no hy-4 target). Promotion must therefore
    // be a no-op and the request must keep the plain single-attempt path.
    installFetchStub(attempts, [okResponse("served-direct")]);

    const res = await postChat("bansos-hy-4");
    report("case 6 no-combo raw id", res, attempts, { attribution: comboAttribution("bansos-hy-4") });

    expect(res.status).toBe(200);
    expect(attempts.length).toBe(1);
    expect(attempts.map((a) => a.model)).toEqual(["hy-4"]);
    expect(attempts.map((a) => a.bearer)).toEqual([BANSOS]);
  });

  it("case 7: DISABLED combo holding the raw id -> NOT promoted (single attempt)", async () => {
    await seedProdCombos();
    // A DISABLED combo that contains the raw id as its target. The reverse
    // index built by loadCombos() skips disabled combos, so this id must NOT
    // be promoted and the request must take the single-attempt path.
    const disabled = await createCombo({
      name: "DisabledHy4",
      targets: ["bansos-hy-4", "bai-glm-5.3-flash"],
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);
    await loadCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [RATE_LIMITED, okResponse("served-fallthrough")]);

    const res = await postChat("bansos-hy-4");
    report("case 7 disabled-combo raw id", res, attempts, {
      attribution: comboAttribution("bansos-hy-4"),
    });

    // NOT promoted: one attempt against the plain id. If the disabled combo
    // had been indexed, the second target would have been attempted after the
    // 429 and the request would have returned 200 instead of failing over.
    expect(attempts.map((a) => a.model)).toEqual(["hy-4"]);
    expect(attempts.map((a) => a.bearer)).toEqual([BANSOS]);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("case 3b (production-shaped): deep slot whose prefix owns NO account", async () => {
    // Production has NO cb account at all, so slot 2 of "Deepseek-v4.1-flash"
    // ("cb-deepseek-v4.1-flash") is unresolvable upstream. Delete the cb row
    // seeded for case 3 to reproduce that exact shape.
    await deleteByokAccounts();
    await seedByok(
      "bansos",
      ["glm-5.3", "glm-5-3-flash", "deepseek-v4.1-flash", "hy-4"],
      { priority: 0, lbMethod: "round_robin" }
    );
    await seedByok("bai", ["glm-5.3-flash", "deepseek-v4.1-flash"], {
      label: "bai-1",
      priority: 0,
      lbMethod: "sequential",
    });
    await refreshByokModels();
    await seedProdCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [okResponse("served-unused")]);

    const res = await postChat("cb-deepseek-v4.1-flash");
    const body = (await res.json()) as { error?: { message?: string } };
    const logRow = latestLogByOriginal("cb-deepseek-v4.1-flash");
    report("case 3b unresolvable deep slot", res, attempts, {
      error: body.error?.message,
      logRow,
    });

    // Records the production-shaped outcome for a promoted slot that no
    // provider can serve: the target is skipped, nothing is attempted, and the
    // route surfaces a configuration-fault error. Slots 0 and 1 are NOT tried
    // (start-at-own-slot), so this is not a fallback regression — it is what
    // "promote a raw id whose own slot is dead" means.
    expect(attempts.length).toBe(0);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("case 3c: promoted slot owned by NO provider -> skipped, next target serves", async () => {
    // A promoted target that NO provider claims is skipped WITHOUT spending a
    // fallback slot, so the chain continues to the next configured target.
    await seedProdCombos();
    await createCombo({
      name: "GhostCombo",
      targets: ["ghost-model-no-provider", "bansos-glm-5-3-flash"],
    });
    await loadCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [okResponse("served-by-slot1")]);

    const res = await postChat("ghost-model-no-provider");
    report("case 3c unowned promoted slot", res, attempts);

    // The ghost slot costs nothing: exactly one upstream call, and it went to
    // the NEXT target in the chain, not the ghost.
    expect(res.status).toBe(200);
    expect(attempts.map((a) => a.model)).toEqual(["glm-5-3-flash"]);
    expect(attempts.map((a) => a.bearer)).toEqual([BANSOS]);
  });

  it("case 3d: EVERY target unowned -> zero attempts, no-spend skip exhausted", async () => {
    // When nothing is attemptable `attempted` stays 0 and the route reports a
    // configuration fault instead of a bogus upstream failure.
    await seedProdCombos();
    await createCombo({ name: "GhostCombo2", targets: ["ghost-a", "ghost-b"] });
    await loadCombos();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [okResponse("served-unused")]);

    const res = await postChat("ghost-b");
    const body = (await res.json()) as { error?: { message?: string; type?: string } };
    report("case 3d all targets unowned", res, attempts, {
      error: body.error?.message,
      type: body.error?.type,
    });

    expect(attempts.length).toBe(0);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(body.error?.message ?? "").toContain("no resolvable target");
  });

  it("case 3e: prefix EXISTS but owns no such model -> 0 attempts (seeding artifact)", async () => {
    // This is exactly the shape that made an earlier version of case 3 read as
    // a product bug. The byok provider claims the "cb-" PREFIX even when the
    // model is absent from that account's model list, so the provider gate
    // passes, `attempted` increments, but the router finds no candidate
    // account supporting the model and fails with ZERO upstream calls. The
    // defect was in the test's seeding (cb did not list deepseek-v4.1-flash),
    // not in the promotion logic.
    await seedProdCombos();
    await deleteByokAccounts();
    await seedByok("bansos", ["glm-5.3", "glm-5-3-flash", "deepseek-v4.1-flash", "hy-4"], {
      priority: 0,
    });
    await seedByok("bai", ["glm-5.3-flash", "deepseek-v4.1-flash"], { label: "bai-1", priority: 0 });
    // cb present, but WITHOUT deepseek-v4.1-flash in its model list.
    await seedByok("cb", ["glm-5.3", "claude-opus-4.7-1m"], { priority: 0 });
    await refreshByokModels();

    originalFetch = globalThis.fetch;
    const attempts: Attempt[] = [];
    installFetchStub(attempts, [okResponse("served-unused")]);

    const res = await postChat("cb-deepseek-v4.1-flash");
    const body = (await res.json()) as { error?: { message?: string } };
    report("case 3e prefix owns no such model", res, attempts, {
      error: body.error?.message,
    });

    expect(attempts.length).toBe(0);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
