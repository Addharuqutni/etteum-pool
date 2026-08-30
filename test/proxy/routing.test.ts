import { describe, expect, test } from "bun:test";
import { pool } from "../../src/proxy/pool";
import { providers } from "../../src/proxy/providers/registry";

/**
 * Characterization test for model → provider routing.
 *
 * This locks the CURRENT behavior of getProviderForModel so the registry/ownsModel
 * refactor can be proven behavior-identical. If you add or change a
 * provider's model patterns, update the matching case here on purpose — a failure
 * means routing for some OTHER provider shifted unintentionally.
 */
describe("getProviderForModel", () => {
  const cases: Array<[string, string]> = [
    // canva
    ["canva-image", "canva"],
    ["CANVA-IMAGE", "canva"],
    // codex (must win over codebuddy for gpt-5-codex)
    ["codex-mini", "codex"],
    ["codex-gpt-5.5-xhigh", "codex"],
    ["gpt-5-codex", "codex"],
    ["gpt-5.5-xhigh", "codex"],
    // grok-cli (Grok Build exact ids)
    ["grok-4.5", "grok-cli"],
    ["grok-4.5-high", "grok-cli"],
    ["grok-4.5-medium", "grok-cli"],
    ["grok-4.5-low", "grok-cli"],
    // codebuddy
    ["cb-claude-opus-4.6", "codebuddy"],
    ["cb-sonnet-4.6", "codebuddy"],
    // codebuddy-china
    ["cbc-claude-opus-4.6", "codebuddy-china"],
    // claude (assistant OAuth)
    ["cc-sonnet-4.6", "claude"],
    // byok
    ["byok-gpt-5", "byok"],
  ];

  for (const [model, expected] of cases) {
    test(`${model} → ${expected}`, () => {
      expect(pool.getProviderForModel(model) as string | null).toBe(expected);
    });
  }

  test("never routes to a removed provider (kiro/kiro-pro/qoder/gitlab-duo/youmind/moclaw/zai/windsurf/pioneer)", () => {
    const removed = new Set([
      "kiro", "kiro-pro", "qoder", "gitlab-duo", "youmind",
      "moclaw", "zai", "windsurf", "pioneer",
    ]);
    for (const m of [
      "auto", "claude-sonnet-4", "claude-haiku-4.5",
      "kp-opus-4.8", "qd-Lite", "ym-coder",
      "ws-claude-4.5-sonnet", "zai-glm", "pio-default", "mo-auto", "moclaw-x",
    ]) {
      expect(removed.has(pool.getProviderForModel(m) as string)).toBe(false);
    }
  });

  test("unknown model resolves to null (no fallback provider)", () => {
    expect(pool.getProviderForModel("totally-unknown-model") as string | null).toBeNull();
  });

  test("codex gpt-5.5-xhigh alias uses codex metadata", () => {
    expect(providers.codex.getModelInfo("gpt-5.5-xhigh")?.id).toBe("codex-gpt-5.5-xhigh");
    expect(providers.codex.getModelInfo("codex-gpt-5.5-xhigh")?.id).toBe("codex-gpt-5.5-xhigh");
    expect(providers.codex.getProviderCreditUnit("gpt-5.5-xhigh")).toBe("credit");
  });
});