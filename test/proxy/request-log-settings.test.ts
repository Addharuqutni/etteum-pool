import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { requestLogs, settings } from "../../src/db/schema";
import {
  invalidateLoggingCache,
  reloadLoggingCache,
  prepareLogBody,
  getCachedRequestLogRetentionConfig,
} from "../../src/proxy/logging";
import { pruneRequestLogs } from "../../src/proxy/index";

/**
 * Runtime `request_log_*` settings must reach prepareLogBody and the retention
 * reader without a restart, and pruning must honor both max_records and
 * retention_days (created_at is unix SECONDS, not ISO text).
 */
describe("dynamic request log settings", () => {
  async function setSetting(key: string, value: string) {
    await db.insert(settings).values({ key, value }).onConflictDoUpdate({
      target: settings.key,
      set: { value },
    });
    // Mirrors the settings route: publish the new values before returning so
    // the very next read already observes them.
    await reloadLoggingCache();
  }

  beforeEach(async () => {
    await db.delete(settings);
    await db.delete(requestLogs);
    invalidateLoggingCache();
  });

  afterEach(async () => {
    await db.delete(settings);
    await db.delete(requestLogs);
    invalidateLoggingCache();
  });

  it("applies a runtime max_bytes setting to prepareLogBody", async () => {
    await setSetting("request_log_body_max_bytes", "100");
    const logged = prepareLogBody({ note: "x".repeat(1_000) });
    expect(logged).toMatchObject({ truncated: true, maxBytes: 100 });
  });

  it("disables body logging when request_log_body_enabled is false", async () => {
    await setSetting("request_log_body_enabled", "false");
    expect(prepareLogBody({ note: "hello" })).toBeNull();
  });

  it("restores redaction after re-enabling it at runtime", async () => {
    await setSetting("request_log_body_redact", "false");
    expect(prepareLogBody({ content: "secret" })).toEqual({ content: "secret" });
    await setSetting("request_log_body_redact", "true");
    expect(prepareLogBody({ content: "secret" })).toEqual({ content: "[redacted 6 chars]" });
  });

  it("reads retention settings from the settings table", async () => {
    await setSetting("request_log_max_records", "42");
    await setSetting("request_log_retention_days", "7");
    expect(getCachedRequestLogRetentionConfig()).toEqual({ maxRecords: 42, retentionDays: 7 });
  });

  it("falls back to documented defaults when keys are absent", async () => {
    // Prove the DB load path, not the cold-cache shortcut: reload with the
    // empty table so the value really comes from the settings query.
    await reloadLoggingCache();
    expect(getCachedRequestLogRetentionConfig()).toEqual({ maxRecords: 500, retentionDays: 0 });
  });

  it("keeps only the newest max_records rows and drops rows past retention_days", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 30 }, (_, i) => ({
      provider: "codebuddy",
      model: "gpt-5",
      status: "success",
      createdAt: new Date((nowSeconds - 40 + i) * 1000),
    }));
    // One deliberately stale row, far outside the retention window.
    rows.push({
      provider: "codebuddy",
      model: "old",
      status: "success",
      createdAt: new Date((nowSeconds - 30 * 86_400) * 1000),
    });
    await db.insert(requestLogs).values(rows);

    await setSetting("request_log_max_records", "5");
    await setSetting("request_log_retention_days", "7");

    // Drive the real production function; any regression in the unix-seconds
    // comparison or the cap is caught here, not by a copied statement.
    await pruneRequestLogs();

    const remaining = await db
      .select({ id: requestLogs.id, createdAt: requestLogs.createdAt })
      .from(requestLogs)
      .orderBy((requestLogs.createdAt) as never);
    expect(remaining).toHaveLength(5);
    const cutoff = nowSeconds - 7 * 86_400;
    expect(remaining.some((r) => r.createdAt.getTime() < (cutoff - 60) * 1000)).toBe(false);
  });

  it("leaves rows untouched when both limits are 0 (unlimited)", async () => {
    await db.insert(requestLogs).values(
      Array.from({ length: 20 }, () => ({ provider: "codebuddy", status: "success" }))
    );
    await setSetting("request_log_max_records", "0");
    await setSetting("request_log_retention_days", "0");
    await pruneRequestLogs();
    const rows = await db.select({ id: requestLogs.id }).from(requestLogs);
    expect(rows).toHaveLength(20);
  });
});
