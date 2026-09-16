import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { accounts, combos, modelMappings, requestLogs } from "../../src/db/schema";
import { eq, inArray } from "drizzle-orm";
import { encrypt } from "../../src/utils/crypto";
import { refreshByokModels } from "../../src/proxy/providers/registry";
import { loadModelMappingCache } from "../../src/proxy/model-mapping";
import { ensureCombosTable, loadCombos, createCombo } from "../../src/proxy/combos";

/**
 * BUG F: alias <-> combo resolution only worked in one direction.
 *
 * (1) resolveCombo() ran on the RAW model id, so when a model_mapping rule's
 *     targetModel is a COMBO NAME the combo was never entered and the router
 *     threw `No provider found for model: <comboName>`.
 * (2) A combo whose TARGET is an alias source was never expanded — the
 *     provider gate saw the un-expanded id, logged "matches no provider",
 *     and silently dropped the configured primary.
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

async function refreshCaches() {
  await refreshByokModels();
  await loadModelMappingCache();
}

describe("alias <-> combo resolution", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    await wipeAccounts();
    await db.delete(combos);
    await db.delete(modelMappings);
    ensureCombosTable();
    await refreshCaches();
  });

  afterEach(async () => {
    if (originalFetch) globalThis.fetch = originalFetch;
    await wipeAccounts();
    await db.delete(combos);
    await db.delete(modelMappings);
    await loadCombos();
    await refreshCaches();
  });

  it("serves via the combo when a mapping's targetModel is a combo name", async () => {
    await seedByok("alpha", ["glm-5.3"]);
    await seedByok("beta", ["glm-5.3"]);
    await refreshCaches();

    await createCombo({ name: "AliasCombo", targets: ["alpha-glm-5.3", "beta-glm-5.3"] });
    await loadCombos();
    // Map a plain model id onto the COMBO name.
    await db.insert(modelMappings).values({
      sourcePattern: "claude-3-5-haiku-20241022",
      matchType: "contains",
      targetModel: "AliasCombo",
      enabled: true,
      priority: 0,
    });
    await loadModelMappingCache();

    originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          id: "ok", object: "chat.completion", model: "glm-5.3",
          choices: [{ index: 0, message: { role: "assistant", content: "served-via-combo" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const { proxyRouter } = await import("../../src/proxy/index");
    const res = await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(calls).toBeGreaterThan(0);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(json.choices?.[0]?.message?.content).toBe("served-via-combo");
  });

  it("expands a combo target that is an alias source and attempts it as PRIMARY", async () => {
    await seedByok("alpha", ["glm-5.3"]);
    await seedByok("beta", ["glm-5.3"]);
    await refreshCaches();

    // The combo's FIRST target is an alias source that maps to the real,
    // provider-owned "alpha-glm-5.3".
    await db.insert(modelMappings).values({
      sourcePattern: "haiku-alias",
      matchType: "contains",
      targetModel: "alpha-glm-5.3",
      enabled: true,
      priority: 0,
    });
    await loadModelMappingCache();

    await createCombo({ name: "AliasTargetCombo", targets: ["haiku-alias", "beta-glm-5.3"] });
    await loadCombos();

    originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("authorization") ?? "";
      seen.push(key.replace("Bearer test-key-", ""));
      return new Response(
        JSON.stringify({
          id: "ok", object: "chat.completion", model: "glm-5.3",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const { proxyRouter } = await import("../../src/proxy/index");
    const res = await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "AliasTargetCombo",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    // The expanded target must serve FIRST — not be silently skipped in favor
    // of the second target.
    expect(seen).toEqual(["alpha"]);
  });
});
