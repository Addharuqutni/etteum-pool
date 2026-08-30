import { describe, expect, test } from "bun:test";
import { normalizeModelId } from "../../src/proxy/index";

describe("normalizeModelId", () => {
  test("strips Claude Code context-window tags", () => {
    expect(normalizeModelId("gcli/grok-4.5-high[1m]")).toBe("gcli/grok-4.5-high");
    expect(normalizeModelId("claude-sonnet-4[200k]")).toBe("claude-sonnet-4");
    expect(normalizeModelId("model[1.5M]")).toBe("model");
  });

  test("fixes sonet typo", () => {
    expect(normalizeModelId("claude-sonet-4")).toBe("claude-sonnet-4");
  });

  test("leaves plain model ids alone", () => {
    expect(normalizeModelId("gcli/grok-4.5-high")).toBe("gcli/grok-4.5-high");
  });
});
