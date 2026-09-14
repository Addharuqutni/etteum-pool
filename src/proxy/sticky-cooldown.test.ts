/**
 * Unit tests for sticky cache-affine sessions + graduated 429 backoff
 * (pure modules — no DB/wiring needed).
 *
 * Run with:  bun test src/proxy/sticky-cooldown.test.ts
 */

import { describe, it, expect } from "bun:test";
import { StickyStore, computeStickyKey } from "./sticky";
import { CooldownTracker } from "./cooldown";

describe("computeStickyKey", () => {
  it("prefers the user field when present", () => {
    const key1 = computeStickyKey("gpt-4", { user: "alice", messages: [{ role: "user", content: "hi" }] });
    const key2 = computeStickyKey("gpt-4", { user: "bob", messages: [{ role: "user", content: "hi" }] });
    expect(key1).not.toBeNull();
    expect(key1).not.toBe(key2);
  });

  it("is stable across calls for the same user+model", () => {
    expect(computeStickyKey("gpt-4", { user: "alice" })).toBe(computeStickyKey("gpt-4", { user: "alice" }));
  });

  it("falls back to first non-empty message content", () => {
    const key = computeStickyKey("gpt-4", { messages: [{ role: "system", content: "" }, { role: "user", content: "You are a helpful assistant." }] });
    expect(key).not.toBeNull();
    const same = computeStickyKey("gpt-4", { messages: [{ role: "system", content: "" }, { role: "user", content: "You are a helpful assistant." }] });
    expect(key).toBe(same);
  });

  it("different model yields different key", () => {
    const a = computeStickyKey("gpt-4", { user: "alice" });
    const b = computeStickyKey("gpt-4o", { user: "alice" });
    expect(a).not.toBe(b);
  });

  it("returns null when no usable anchor exists", () => {
    expect(computeStickyKey("gpt-4", undefined)).toBeNull();
    expect(computeStickyKey("gpt-4", { messages: [] })).toBeNull();
    expect(computeStickyKey("gpt-4", { messages: [{ role: "user", content: "   " }] })).toBeNull();
  });
});

describe("StickyStore", () => {
  it("sets and gets a binding", () => {
    const store = new StickyStore();
    store.set("k", 7, "claude");
    expect(store.get("k", "claude")).toBe(7);
  });

  it("rejects a binding for a different provider", () => {
    const store = new StickyStore();
    store.set("k", 7, "claude");
    expect(store.get("k", "codex")).toBeNull();
  });

  it("expires after TTL (30 min)", () => {
    const store = new StickyStore();
    const now = Date.now();
    store.set("k", 7, "claude");
    // force-expire by advancing past the TTL
    store.sweep(now + 31 * 60_000);
    expect(store.get("k", "claude")).toBeNull();
  });

  it("deletes a binding", () => {
    const store = new StickyStore();
    store.set("k", 7, "claude");
    store.delete("k");
    expect(store.get("k", "claude")).toBeNull();
  });

  it("evicts oldest entry at capacity", () => {
    const store = new StickyStore();
    for (let i = 0; i < 2048; i++) store.set(`k${i}`, i, "claude");
    // 2049th insert evicts the oldest (k0) and keeps k2048 (set)
    store.set("overflow", 9999, "claude");
    expect(store.get("k0", "claude")).toBeNull();
    expect(store.get("overflow", "claude")).toBe(9999);
  });
});

describe("CooldownTracker", () => {
  it("escalates backoff: 30s / 60s / 120s / 240s / 300s cap", () => {
    const tracker = new CooldownTracker();
    const t0 = 1_000_000_000;
    tracker.mark(1, t0);
    expect(tracker.strikes(1)).toBe(1);
    expect(tracker.isCooldown(1, t0 + 29_000)).toBe(true);
    expect(tracker.isCooldown(1, t0 + 31_000)).toBe(false);

    tracker.mark(1, t0 + 31_000);
    expect(tracker.strikes(1)).toBe(2);
    expect(tracker.isCooldown(1, t0 + 31_000 + 59_000)).toBe(true);
    expect(tracker.isCooldown(1, t0 + 31_000 + 61_000)).toBe(false);

    // escalates from previous strikes even after the window expired
    tracker.mark(1, t0 + 5 * 60_000);
    expect(tracker.strikes(1)).toBe(3);
  });

  it("caps at 5 minutes even after many strikes", () => {
    const tracker = new CooldownTracker();
    const t0 = 1_000_000_000;
    for (let i = 0; i < 10; i++) tracker.mark(1, t0); // all at once
    expect(tracker.strikes(1)).toBe(10); // strikes survive while cooling
    expect(tracker.isCooldown(1, t0 + 299_000)).toBe(true);
    expect(tracker.isCooldown(1, t0 + 301_000)).toBe(false); // expired → cleaned up
  });

  it("clear removes the cooldown", () => {
    const tracker = new CooldownTracker();
    const t0 = 1_000_000_000;
    tracker.mark(1, t0);
    tracker.clear(1);
    expect(tracker.isCooldown(1, t0 + 1)).toBe(false);
    expect(tracker.strikes(1)).toBe(0);
  });

  it("activeIds only returns accounts still cooling", () => {
    const tracker = new CooldownTracker();
    const t0 = 1_000_000_000;
    tracker.mark(1, t0);        // until t0+30s
    tracker.mark(2, t0 + 1000); // until t0+31s
    tracker.mark(3, t0 + 2000); // until t0+32s
    expect(tracker.activeIds(t0 + 100).sort()).toEqual([1, 2, 3]);
    expect(tracker.activeIds(t0 + 31_500)).toEqual([3]); // 1,2 expired
  });

  it("sweep removes expired entries and reports count", () => {
    const tracker = new CooldownTracker();
    const t0 = 1_000_000_000;
    tracker.mark(1, t0);        // until t0+30s
    tracker.mark(2, t0 + 1000); // until t0+31s
    expect(tracker.sweep(t0 + 30_500)).toBe(1); // #1 expired, #2 still cooling
    expect(tracker.size).toBe(1);
    expect(tracker.sweep(t0 + 31_500)).toBe(1); // #2 expired
    expect(tracker.size).toBe(0);
  });
});