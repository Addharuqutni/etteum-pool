import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { accounts, combos, requestLogs } from "../../src/db/schema";
import { eq, inArray, desc } from "drizzle-orm";
import { encrypt } from "../../src/utils/crypto";
import { refreshByokModels } from "../../src/proxy/providers/registry";
import { ensureCombosTable, loadCombos, createCombo } from "../../src/proxy/combos";

/**
 * BUG G: error-log attribution named the last CONFIGURED combo target instead
 * of the last ATTEMPTED one. With [alpha, beta, gamma] where only alpha was
 * contacted, request_logs.model was written as gamma — and the WS broadcast
 * reported gamma too — so the operator debugged the wrong account/model.
 */

const FAKE_UPSTREAM = "https://api.test.invalid/v1";

async function wipeAccounts() {
  const ids = (await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.provider, "byok"))).map(
    (r) => r.id
  );
  if (ids.length > 0) {
    await db.update(requestLogs).set({ accountId: null }).where(inArray(requestLogs.accountId, ids));
  }
  await db.delete(accounts).where(eq(accounts.provider, "byok"));
}

async function seedByok(prefix: string, models: string[]) {
  await db.insert(accounts).values({
    provider: "byok",
    email: prefix,
    password: encrypt(`test-key-${prefix}`),
    status: "active",
    enabled: true,
    tokens: JSON.stringify({
      base_url: FAKE_UPSTREAM,
      format: "openai",
      models,
      model_prefix: prefix,
    }),
  });
}

describe("combo error attribution", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    ensureCombosTable();
    await db.delete(combos);
    await wipeAccounts();
  });

  afterEach(async () => {
    if (originalFetch) globalThis.fetch = originalFetch;
    await db.delete(combos);
    await wipeAccounts();
    await db.delete(requestLogs);
    await loadCombos();
    await refreshByokModels();
  });

  it("attributes the failure to the ATTEMPTED target, not the last configured one", async () => {
    await seedByok("alpha", ["glm-5.3"]);
    await seedByok("beta", ["glm-5.3"]);
    await seedByok("gamma", ["glm-5.3"]);
    await refreshByokModels();

    // [alpha, beta, gamma] — alpha is contacted and fails with a CONTENT
    // MODERATION error, which aborts the chain (it describes the request body
    // and would recur on every target). So only target 1 is ever attempted,
    // yet the error must still be attributed to alpha — not to gamma.
    await createCombo({
      name: "AttribCombo",
      targets: ["alpha-glm-5.3", "beta-glm-5.3", "gamma-glm-5.3"],
    });
    await loadCombos();
    await db.delete(requestLogs);

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      // Only alpha is ever contacted; moderation aborts the chain.
      return new Response(
        JSON.stringify({ error: { message: "content moderation: sensitive content" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const { proxyRouter } = await import("../../src/proxy/index");
    const res = await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "AttribCombo",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const rows = await db.select().from(requestLogs).orderBy(desc(requestLogs.id)).limit(10);
    const models = rows.map((r) => r.model);
    // The failure must be attributed to alpha (the only target contacted),
    // never to gamma (the last configured target).
    expect(models).toContain("alpha-glm-5.3");
    expect(models).not.toContain("gamma-glm-5.3");
  });
});
