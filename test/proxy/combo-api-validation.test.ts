import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { combos } from "../../src/db/schema";
import { ensureCombosTable, loadCombos } from "../../src/proxy/combos";
import { combosRouter } from "../../src/api/combos";

/**
 * BUG E: the POST/PUT handlers ran unresolvableTargets(targets) BEFORE
 * parseTargets(), so malformed input hit `targets.filter` and leaked an
 * internal TypeError ("targets.filter is not a function") to the client
 * instead of the documented contract message.
 */
describe("combo API target validation", () => {
  beforeEach(async () => {
    ensureCombosTable();
    await db.delete(combos);
    await loadCombos();
  });

  afterEach(async () => {
    await db.delete(combos);
    await loadCombos();
  });

  const post = (body: unknown) =>
    combosRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("rejects a non-array targets with the contract message", async () => {
    const res = await post({ name: "BadTargets", targets: "nope" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("targets must be an array");
  });

  it("rejects empty targets with the contract message", async () => {
    const res = await post({ name: "EmptyTargets", targets: [] });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("targets must contain between 1 and 10 models");
  });

  it("rejects non-string array entries with the contract message", async () => {
    const res = await post({ name: "NumTargets", targets: [1, 2] });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("targets must be an array of non-empty strings");
  });

  it("still accepts a valid chain", async () => {
    const res = await post({ name: "GoodChain", targets: ["a", "b"] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: { targets?: string[] } };
    expect(json.data?.targets).toEqual(["a", "b"]);
  });
});
