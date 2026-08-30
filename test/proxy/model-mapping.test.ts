import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { accounts, modelMappings } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { encrypt } from "../../src/utils/crypto";
import { refreshByokModels } from "../../src/proxy/providers/registry";
import { resolveModelAlias, loadModelMappingCache } from "../../src/proxy/model-mapping";

// Regression: BYOK account ids ("prefix-model") are valid in-pool ids and must
// bypass the generic assistant mapping templates ("opus"/"sonnet"/"haiku"
// contains-rules). Before the fix, "genspark-claude-opus-5" was rewritten by
// the "opus" rule and failed routing with "No active accounts available".

async function seedByok(prefix: string, models: string[]) {
  await db.insert(accounts).values({
    provider: "byok",
    email: prefix,
    password: encrypt("test-key"),
    status: "active",
    enabled: true,
    tokens: JSON.stringify({
      base_url: `https://${prefix}.test/v1`,
      format: "openai",
      models,
      model_prefix: prefix,
    }),
  });
}

async function seedMapping(sourcePattern: string, targetModel: string, priority = 0) {
  await db.insert(modelMappings).values({
    sourcePattern,
    matchType: "contains",
    targetModel,
    enabled: true,
    priority,
  });
}

async function refreshCaches() {
  await refreshByokModels();
  await loadModelMappingCache();
}

describe("resolveModelAlias vs BYOK ids", () => {
  beforeEach(async () => {
    await db.delete(accounts).where(eq(accounts.provider, "byok"));
    await db.delete(modelMappings);
    await refreshCaches();
  });

  afterEach(async () => {
    await db.delete(accounts).where(eq(accounts.provider, "byok"));
    await db.delete(modelMappings);
    await refreshCaches();
  });

  it("does not rewrite valid BYOK prefixed ids, even when they contain the mapped pattern", async () => {
    await seedByok("genspark", ["claude-opus-5"]);
    await seedByok("justwork", ["claude-opus-5"]);
    await seedMapping("opus", "genspark-claude-opus-5", 2);
    await refreshCaches();

    expect(resolveModelAlias("genspark-claude-opus-5")).toBe("genspark-claude-opus-5");
    expect(resolveModelAlias("justwork-claude-opus-5")).toBe("justwork-claude-opus-5");
  });

  it("still maps the assistant's generic anthropic ids", async () => {
    await seedByok("genspark", ["claude-opus-5"]);
    await seedMapping("opus", "genspark-claude-opus-5", 2);
    await refreshCaches();

    expect(resolveModelAlias("claude-opus-4-20250514")).toBe("genspark-claude-opus-5");
  });
});
