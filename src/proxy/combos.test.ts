/**
 * Unit tests for the combo feature's PURE helpers — no DB, no proxy wiring.
 *
 * Run with:  bun test src/proxy/combos.test.ts
 */

import { describe, it, expect } from "bun:test";
import { parseTargets, comboMatches } from "./combos";

describe("parseTargets", () => {
  it("accepts a valid array and trims each target", () => {
    expect(parseTargets(["gpt-4o", " claude-3-5-sonnet ", "grok-3"])).toEqual([
      "gpt-4o",
      "claude-3-5-sonnet",
      "grok-3",
    ]);
  });

  it("accepts a single target (lower bound)", () => {
    expect(parseTargets(["gpt-4o"])).toEqual(["gpt-4o"]);
  });

  it("accepts exactly 10 targets (upper bound)", () => {
    const targets = Array.from({ length: 10 }, (_, i) => `model-${i}`);
    expect(parseTargets(targets)).toEqual(targets);
  });

  it("rejects 11 targets (too many)", () => {
    const targets = Array.from({ length: 11 }, (_, i) => `model-${i}`);
    expect(() => parseTargets(targets)).toThrow(/between 1 and 10/);
  });

  it("rejects an empty array", () => {
    expect(() => parseTargets([])).toThrow(/between 1 and 10/);
  });

  it("rejects duplicate targets", () => {
    expect(() => parseTargets(["gpt-4o", "gpt-4o"])).toThrow(/duplicate/);
  });

  it("rejects duplicates that only differ by whitespace", () => {
    expect(() => parseTargets(["gpt-4o", "  gpt-4o  "])).toThrow(/duplicate/);
  });

  it("rejects non-string entries", () => {
    expect(() => parseTargets(["gpt-4o", 42])).toThrow(/non-empty strings/);
  });

  it("rejects empty-string entries", () => {
    expect(() => parseTargets(["gpt-4o", "  "])).toThrow(/non-empty strings/);
  });

  it("rejects non-array input", () => {
    expect(() => parseTargets("gpt-4o")).toThrow(/array/);
  });
});

describe("comboMatches", () => {
  const combos = [
    { name: "fast", targets: ["gpt-4o-mini", "claude-3-5-haiku"], enabled: true },
    { name: "disabled-combo", targets: ["gpt-4o"], enabled: false },
  ];

  it("returns the ordered targets on an exact enabled match", () => {
    expect(comboMatches("fast", combos)).toEqual(["gpt-4o-mini", "claude-3-5-haiku"]);
  });

  it("returns null for an exact match on a disabled combo", () => {
    expect(comboMatches("disabled-combo", combos)).toBeNull();
  });

  it("returns null when no combo matches", () => {
    expect(comboMatches("gpt-4o", combos)).toBeNull();
  });

  it("returns null for a case-different name (exact match is the key)", () => {
    expect(comboMatches("Fast", combos)).toBeNull();
  });

  it("returns null for a partial / substring name", () => {
    expect(comboMatches("fa", combos)).toBeNull();
  });

  it("returns null for an empty combo list", () => {
    expect(comboMatches("fast", [])).toBeNull();
  });
});
