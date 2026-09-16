import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { requestLogs, settings } from "../../src/db/schema";
import { statsRouter } from "../../src/api/stats";
import { invalidateLoggingCache } from "../../src/proxy/logging";

/**
 * Contract for GET/DELETE /api/stats/requests: provider+status+search filters
 * with an accurate `total`, and destructive pruning that must never fire on an
 * unqualified call.
 */
describe("request logs API", () => {
  async function seed() {
    await db.delete(requestLogs);
    await db.delete(settings);
    invalidateLoggingCache();
    await db.insert(requestLogs).values([
      { provider: "codebuddy", model: "gpt-5", status: "success" },
      { provider: "codebuddy", model: "gpt-5", status: "success" },
      { provider: "canva", model: "canva-image", status: "error", errorMessage: "quota exploded" },
    ]);
  }

  async function count() {
    const rows = await db.select({ id: requestLogs.id }).from(requestLogs);
    return rows.length;
  }

  const get = (qs = "") => statsRouter.request(`/requests${qs}`);
  const del = (qs = "") => statsRouter.request(`/requests${qs}`, { method: "DELETE" });

  beforeEach(seed);
  afterEach(async () => {
    await db.delete(requestLogs);
    await db.delete(settings);
    invalidateLoggingCache();
  });

  it("returns every row plus an accurate total", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[]; total: number };
    expect(json.total).toBe(3);
    expect(json.data).toHaveLength(3);
  });

  it("filters by provider and status together", async () => {
    const json = (await (await get("?provider=codebuddy&status=success")).json()) as {
      data: { provider: string }[];
      total: number;
    };
    expect(json.total).toBe(2);
    expect(json.data.every((r) => r.provider === "codebuddy")).toBe(true);
  });

  it("searches model, provider, error message and account email", async () => {
    const json = (await (await get("?search=exploded")).json()) as { total: number };
    expect(json.total).toBe(1);
  });

  it("ignores status=all instead of matching nothing", async () => {
    const json = (await (await get("?status=all")).json()) as { total: number };
    expect(json.total).toBe(3);
  });

  it("pages with a stable total and non-overlapping rows", async () => {
    const first = (await (await get("?limit=2&offset=0")).json()) as {
      data: { id: number }[];
      total: number;
    };
    const second = (await (await get("?limit=2&offset=2")).json()) as {
      data: { id: number }[];
      total: number;
    };
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
    expect(first.data).toHaveLength(2);
    expect(second.data).toHaveLength(1);
    const overlap = first.data.filter((r) => second.data.some((s) => s.id === r.id));
    expect(overlap).toHaveLength(0);
  });

  it("refuses an unqualified delete", async () => {
    const res = await del();
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("At least one of all, olderThanDays, status, or provider is required");
    expect(await count()).toBe(3);
  });

  it("deletes only failed requests for status=error", async () => {
    const json = (await (await del("?status=error")).json()) as { deletedCount: number };
    expect(json.deletedCount).toBe(1);
    expect(await count()).toBe(2);
    expect((await (await db.select({ status: requestLogs.status }).from(requestLogs))).every((r) => r.status === "success")).toBe(true);
  });

  it("deletes only the named provider", async () => {
    const json = (await (await del("?provider=canva")).json()) as { deletedCount: number };
    expect(json.deletedCount).toBe(1);
    const remaining = await db.select({ provider: requestLogs.provider }).from(requestLogs);
    expect(remaining.every((r) => r.provider === "codebuddy")).toBe(true);
  });

  it("treats olderThanDays=retention as a no-op when the saved policy keeps everything", async () => {
    const json = (await (await del("?olderThanDays=retention")).json()) as { deletedCount: number };
    expect(json.deletedCount).toBe(0);
    expect(await count()).toBe(3);
  });

  it("purges everything for all=true and reports the count", async () => {
    const json = (await (await del("?all=true")).json()) as { deletedCount: number };
    expect(json.deletedCount).toBe(3);
    expect(await count()).toBe(0);
    const after = (await (await get()).json()) as { total: number };
    expect(after.total).toBe(0);
  });
});
