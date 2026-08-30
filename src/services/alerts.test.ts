/**
 * Unit tests for the alert engine's pure helpers — no DB, no network.
 *
 * Run with:  bun test src/services/alerts.test.ts
 */

import { describe, it, expect } from "bun:test";
import { computeDaysLeft, shouldFire, buildAlertPayload } from "./alerts";

describe("computeDaysLeft", () => {
  it("returns null when 7d usage is zero (no burn to project)", () => {
    expect(computeDaysLeft(100, 0)).toBeNull();
  });

  it("returns null when quota remaining is zero", () => {
    expect(computeDaysLeft(0, 70)).toBeNull();
  });

  it("divides remaining quota by (7d usage / 7)", () => {
    // 70 credits used over 7 days = 10/day → 100 remaining = 10 days
    expect(computeDaysLeft(100, 70)).toBe(10);
  });

  it("rounds up partial days", () => {
    expect(computeDaysLeft(101, 70)).toBe(11);
  });
});

describe("shouldFire", () => {
  it("fires on first occurrence (no prior send)", () => {
    const map = new Map<string, number>();
    expect(shouldFire("low_credits:codex", 1_000_000, 30, map)).toBe(true);
  });

  it("does not fire again inside the cooldown window", () => {
    const map = new Map<string, number>([["low_credits:codex", 1_000_000]]);
    expect(shouldFire("low_credits:codex", 1_000_000 + 29 * 60_000, 30, map)).toBe(false);
  });

  it("fires again once the cooldown has elapsed", () => {
    const map = new Map<string, number>([["low_credits:codex", 1_000_000]]);
    expect(shouldFire("low_credits:codex", 1_000_000 + 31 * 60_000, 30, map)).toBe(true);
  });

  it("cooldowns are per alert key, not global", () => {
    const map = new Map<string, number>([["low_credits:codex", 1_000_000]]);
    expect(shouldFire("error_rate:canva", 1_000_000, 30, map)).toBe(true);
  });
});

describe("buildAlertPayload", () => {
  it("ships both Discord (content) and Slack (text) fields", () => {
    const payload = buildAlertPayload("something is on fire");
    expect(payload).toEqual({ content: "something is on fire", text: "something is on fire" });
  });
});