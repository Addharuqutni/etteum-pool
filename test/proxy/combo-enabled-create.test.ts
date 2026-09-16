import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { combos } from "../../src/db/schema";
import { ensureCombosTable, loadCombos, resolveCombo } from "../../src/proxy/combos";
import { combosRouter } from "../../src/api/combos";

/**
 * POST /api/combos accepts `enabled` (KNOWN_FIELDS) but never forwarded it to
 * createCombo, so {"enabled": false} silently created an ENABLED combo — which
 * then ran in the proxy despite the caller asking for it off.
 */
describe("combo POST enabled passthrough", () => {
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

  it("honors enabled:false — the combo is disabled and does not resolve", async () => {
    const res = await post({ name: "OffCombo", targets: ["a", "b"], enabled: false });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: { enabled?: boolean; name?: string } };
    expect(json.data?.enabled).toBe(false);

    // The runtime hot path must NOT match a disabled combo.
    await loadCombos();
    expect(resolveCombo("OffCombo")).toBeNull();
  });

  it("defaults to enabled:true when the field is omitted", async () => {
    const res = await post({ name: "OnCombo", targets: ["a", "b"] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: { enabled?: boolean } };
    expect(json.data?.enabled).toBe(true);

    await loadCombos();
    expect(resolveCombo("OnCombo")).toEqual(["a", "b"]);
  });

  it("round-trips enabled through GET and PUT", async () => {
    const created = await post({ name: "RoundTrip", targets: ["a", "b"], enabled: false });
    const createdJson = (await created.json()) as { data?: { id?: number } };
    const id = createdJson.data?.id;
    expect(typeof id).toBe("number");

    // GET reflects the disabled state.
    const listRes = await combosRouter.request("/");
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      data?: Array<{ id?: number; enabled?: boolean }>;
    };
    const row = listJson.data?.find((r) => r.id === id);
    expect(row?.enabled).toBe(false);

    // PUT flips it back on.
    const putRes = await combosRouter.request(`/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as { data?: { enabled?: boolean } };
    expect(putJson.data?.enabled).toBe(true);

    await loadCombos();
    expect(resolveCombo("RoundTrip")).toEqual(["a", "b"]);
  });
});
