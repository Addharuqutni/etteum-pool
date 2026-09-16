import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { accounts, combos, requestLogs } from "../../src/db/schema";
import { eq, inArray, desc } from "drizzle-orm";
import { encrypt } from "../../src/utils/crypto";
import { refreshByokModels } from "../../src/proxy/providers/registry";
import {
  ensureCombosTable,
  loadCombos,
  createCombo,
  updateCombo,
  resolveCombo,
  resolveComboByTarget,
} from "../../src/proxy/combos";

/**
 * RAWTARGET-ID -> COMBO PROMOTION (fix B) + CASE-INSENSITIVE NAMES (fix C).
 *
 * The production bug: clients send a raw upstream id ("bansos-glm-5.3")
 * instead of the combo NAME that advertises it. That id is not a combo name,
 * so resolution missed and the request took the single-attempt path with NO
 * fallback at all — one 429 and the client got a 503.
 *
 * These tests must FAIL before the fix (single attempt / null resolution /
 * duplicate accepted) and PASS after.
 */

const FAKE_UPSTREAM = "https://api.test.invalid/v1";

async function deleteByokAccounts() {
  const ids = (
    await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.provider, "byok"))
  ).map((r) => r.id);
  if (ids.length > 0) {
    await db.update(requestLogs).set({ accountId: null }).where(inArray(requestLogs.accountId, ids));
  }
  await db.delete(accounts).where(eq(accounts.provider, "byok"));
}

async function seedByok(prefix: string, models: string[], status = "active") {
  await db.insert(accounts).values({
    provider: "byok",
    // UNIQUE (provider, email): one row per prefix keeps seeding idempotent.
    email: `${prefix}@raw.test`,
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

describe("raw target id -> combo promotion", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    await deleteByokAccounts();
    await db.delete(combos);
    ensureCombosTable();
    await loadCombos();
  });

  afterEach(async () => {
    if (originalFetch) globalThis.fetch = originalFetch;
    await deleteByokAccounts();
    await db.delete(combos);
    await loadCombos();
    await refreshByokModels();
  });

  /**
   * Stub upstream: `plan[i]` is the HTTP status for upstream call i (1-based).
   * A 429 body is a hard rate limit; 200 returns content tagging the model.
   * Every call records the model id it was sent.
   */
  function stubUpstream(plan: number[]) {
    const attempts: string[] = [];
    const keys: string[] = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      attempts.push(body.model ?? "");
      keys.push(readBearer(init?.headers));
      const status = plan[attempts.length - 1] ?? 200;
      if (status !== 200) {
        return new Response(
          JSON.stringify({ error: { message: "Upstream rate limit or quota exceeded" } }),
          { status, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          id: "ok",
          object: "chat.completion",
          model: body.model ?? "unknown",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `served-by:${body.model ?? "?"}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;
    return { attempts, keys };
  }

  async function post(model: string) {
    const { proxyRouter } = await import("../../src/proxy/index");
    const res = await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON error body */
    }
    return { status: res.status, json };
  }

  /**
   * Most recent request_log row. The stored body is a REDACTED/TRUNCATED
   * string (prepareLogBody), not strict JSON, so fields are read by regex
   * rather than by parsing.
   */
  async function lastLog() {
    const [row] = await db.select().from(requestLogs).orderBy(desc(requestLogs.id)).limit(1);
    if (!row) return null;
    const raw = typeof row.requestBody === "string" ? row.requestBody : JSON.stringify(row.requestBody ?? "");
    const field = (key: string): string | undefined => {
      // Matches "key": "value" and key: value (unquoted, redacted form).
      const m = raw.match(new RegExp(`"?${key}"?\\s*:\\s*"?([^",}\\s]+)"?`));
      return m?.[1];
    };
    return {
      model: row.model,
      status: row.status,
      combo: field("combo"),
      originalModel: field("originalModel"),
      raw,
    };
  }
  // ---------------------------------------------------------------- t1
  it("t1: combo NAME still wins and matches case-insensitively", async () => {
    await seedByok("p1", ["glm-5.3"]);
    await seedByok("p2", ["glm-5.3"]);
    await createCombo({ name: "Glm-5.3", targets: ["p1-glm-5.3", "p2-glm-5.3"] });
    await loadCombos();

    // Lower-cased combo NAME resolves (fix C).
    expect(resolveCombo("Glm-5.3")).toEqual(["p1-glm-5.3", "p2-glm-5.3"]);
    expect(resolveCombo("glm-5.3")).toEqual(["p1-glm-5.3", "p2-glm-5.3"]);
    expect(resolveCombo("GLM-5.3")).toEqual(["p1-glm-5.3", "p2-glm-5.3"]);

    // And end-to-end: lower-cased name walks the chain on a 429.
    const { attempts } = stubUpstream([429, 200]);
    const res = await post("glm-5.3");
    expect(res.status).toBe(200);
    // Two upstream calls => the combo chain ran (not the single-attempt path).
    expect(attempts).toEqual(["glm-5.3", "glm-5.3"]);
  });

  // ---------------------------------------------------------------- t2
  it("t2: RAW id that is slot 0 -> chain advances [slot0(429), slot1(200)]", async () => {
    await seedByok("bansos", ["glm-5-3-flash"]);
    await seedByok("bai", ["glm-5-3-flash"]);
    await createCombo({
      name: "Glm-5.3-flash",
      targets: ["bansos-glm-5-3-flash", "bai-glm-5-3-flash"],
    });
    await loadCombos();

    // The raw id is NOT a combo name, so only the reverse index can find it.
    expect(resolveCombo("bansos-glm-5-3-flash")).toBeNull();
    expect(resolveComboByTarget("bansos-glm-5-3-flash")).toEqual({
      name: "Glm-5.3-flash",
      targets: ["bansos-glm-5-3-flash", "bai-glm-5-3-flash"],
      startIndex: 0,
    });

    const { attempts, keys } = stubUpstream([429, 200]);
    const res = await post("bansos-glm-5-3-flash");

    // Before the fix: 503 after ONE attempt. After: falls back and succeeds.
    expect(res.status).toBe(200);
    expect(attempts).toEqual(["glm-5-3-flash", "glm-5-3-flash"]);
    // The fallback ran on a different account.
    expect(keys[0]).not.toBe(keys[1]);

    // Promoted request is attributed to the COMBO, with the raw id preserved.
    const log = await lastLog();
    expect(log?.combo).toBe("Glm-5.3-flash");
    expect(log?.originalModel).toBe("bansos-glm-5-3-flash");
  });

  // ---------------------------------------------------------------- t3
  it("t3: RAW id at a DEEP slot starts there — earlier slots never attempted", async () => {
    await seedByok("s0", ["m"]);
    await seedByok("s1", ["m"]);
    await seedByok("s2", ["m"]);
    await seedByok("s3", ["m"]);
    await createCombo({
      name: "Deep",
      targets: ["s0-m", "s1-m", "s2-m", "s3-m"],
    });
    await loadCombos();

    expect(resolveComboByTarget("s2-m")).toMatchObject({ name: "Deep", startIndex: 2 });

    // s2 429s, then s3 serves it.
    const { attempts, keys } = stubUpstream([429, 200]);
    const res = await post("s2-m");

    expect(res.status).toBe(200);
    // Exactly two upstream calls: s2 then s3.
    expect(attempts.length).toBe(2);
    // The fallback hop used a different account than the first attempt, i.e.
    // a genuine second slot rather than a retry of the same one.
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys).toHaveLength(2);
  });

  // ---------------------------------------------------------------- t4
  it("t4: raw id in TWO enabled combos -> lowest combo id wins", async () => {
    await seedByok("c1", ["shared"]);
    await seedByok("c2", ["shared"]);
    const first = await createCombo({ name: "First", targets: ["c1-shared", "c2-shared"] });
    const second = await createCombo({ name: "Second", targets: ["c2-shared", "c1-shared"] });
    await loadCombos();

    // "c2-shared" sits in both combos; the lowest id (First) must win.
    expect(first.id).toBeLessThan(second.id);
    expect(resolveComboByTarget("c2-shared")).toMatchObject({ name: "First" });
    expect(resolveComboByTarget("c1-shared")).toMatchObject({ name: "First" });
  });

  // ---------------------------------------------------------------- t5
  it("t5: raw id in NO combo -> unchanged single-attempt behavior", async () => {
    await seedByok("lonely", ["m"]);
    await createCombo({ name: "Unrelated", targets: ["x-m"] });
    await loadCombos();

    const { attempts } = stubUpstream([429]);
    const res = await post("lonely-m");

    // No combo owns it: exactly one attempt, and the 429 surfaces.
    expect(res.status).toBe(503);
    expect(attempts).toEqual(["m"]);
    // Not attributed to any combo.
    const log = await lastLog();
    expect(log?.combo).toBeUndefined();
  });

  // ---------------------------------------------------------------- t6
  it("t6: DISABLED combo owning the raw id -> NOT promoted", async () => {
    await seedByok("off1", ["m"]);
    await seedByok("off2", ["m"]);
    const created = await createCombo({
      name: "OffChain",
      targets: ["off1-m", "off2-m"],
      enabled: false,
    });
    await loadCombos();
    expect(created.enabled).toBe(false);

    expect(resolveComboByTarget("off1-m")).toBeNull();

    const { attempts } = stubUpstream([429]);
    const res = await post("off1-m");

    // Disabled combos do not participate: single attempt, no fallback.
    expect(res.status).toBe(503);
    expect(attempts).toEqual(["m"]);

    // Enabling it makes the same raw id promotable again.
    await updateCombo(created.id, { enabled: true });
    await loadCombos();
    expect(resolveComboByTarget("off1-m")).toMatchObject({ name: "OffChain", startIndex: 0 });
  });

  // ---------------------------------------------------------------- t7
  it("t7: createCombo rejects a case-insensitive duplicate but accepts a new name", async () => {
    await createCombo({ name: "Glm-5.3", targets: ["a-m"] });

    // A genuinely new name is fine.
    const ok = await createCombo({ name: "Deepseek-v4.1-flash", targets: ["b-m"] });
    expect(ok.name).toBe("Deepseek-v4.1-flash");

    // Same name differing only by case must be rejected: name matching is
    // case-insensitive, so one of the two would be unreachable.
    await expect(createCombo({ name: "glm-5.3", targets: ["c-m"] })).rejects.toThrow(
      /case-insensitive clash with "Glm-5.3"/
    );
    await expect(createCombo({ name: "GLM-5.3", targets: ["c-m"] })).rejects.toThrow(
      /already exists/
    );
    // Exact duplicate keeps its original message.
    await expect(createCombo({ name: "Glm-5.3", targets: ["c-m"] })).rejects.toThrow(
      /already exists/
    );

    // updateCombo rejects a rename onto a case-clashing name (another combo) but
    // ALLOWS renaming to a case variant of ITSELF.
    const selfCaseVariant = await updateCombo(ok.id, { name: "deepseek-v4.1-flash" });
    expect(selfCaseVariant?.name).toBe("deepseek-v4.1-flash");
    const renamed = await updateCombo(ok.id, { name: "DEEPSEEK-V4.1-FLASH" });
    expect(renamed?.name).toBe("DEEPSEEK-V4.1-FLASH");
  });
});
