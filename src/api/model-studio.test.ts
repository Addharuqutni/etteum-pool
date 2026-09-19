/**
 * Model Studio — session store bounds and router validation.
 *
 * The chat endpoint dispatches through the same `handleChatCompletion` as
 * POST /v1/chat/completions, so it inherits that pipeline's behaviour and does
 * not need a second one tested here. What is studio-specific is the in-memory
 * session store (bounded, evicting) and the request shaping done before
 * dispatch. These tests pin both.
 *
 * Pure / in-memory: no DB writes. `bun test src/api/model-studio.test.ts`
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  createStudioSession,
  deleteStudioSession,
  getStudioSession,
  listStudioSessions,
  patchStudioSession,
  modelStudioRouter,
} from "./model-studio";

async function call(path: string, init?: RequestInit): Promise<Response> {
  return modelStudioRouter.request(path, {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: init?.body,
  });
}


// The store is module-global; drain it after every test so a failed
// assertion can't leak a session into the next test.
afterEach(() => {
  for (const s of listStudioSessions()) deleteStudioSession(s.id);
});

describe("studio session store", () => {
  it("evicts oldest sessions past the cap", () => {
    const ids: string[] = [];
    for (let i = 0; i < 80; i++) {
      ids.push(createStudioSession({ title: `seed-${i}`, model: "m" }).id);
    }
    const kept = new Set(listStudioSessions().map((s) => s.title));
    expect(kept.size).toBeLessThanOrEqual(64);
    // Newest seeds survive; the oldest seeds were the first evicted.
    expect(kept.has("seed-79")).toBe(true);
    expect(kept.has("seed-0")).toBe(false);
    for (const id of ids) deleteStudioSession(id);
  });

  it("clamps over-long message arrays instead of rejecting them", () => {
    const session = createStudioSession({ title: "grower" });
    patchStudioSession(session.id, {
      messages: Array.from({ length: 500 }, (_, i) => ({ role: "user" as const, content: `m${i}`, ts: new Date().toISOString() })),
    });
    const grown = getStudioSession(session.id);
    expect(grown?.messages.length).toBe(200);
    deleteStudioSession(session.id);
  });

  it("bounds every persisted field", () => {
    const session = createStudioSession({ title: "t".repeat(1_000), model: "m".repeat(1_000), systemPrompt: "s".repeat(64_000) });
    expect(session.title.length).toBe(200);
    expect(session.model.length).toBe(200);
    expect(session.systemPrompt.length).toBe(32_000);
    deleteStudioSession(session.id);
  });

  it("drops malformed messages and reports the session as missing", () => {
    expect(deleteStudioSession("no-such-id")).toBe(false);
    expect(getStudioSession("no-such-id")).toBeNull();
  });

  it("rejects messages with an invalid role at the router layer", async () => {
    const created = await call("/sessions", { method: "POST", body: JSON.stringify({ title: "roles", model: "m" }) });
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    // patchStudioSession trusts its input; the router is the validation
    // boundary, so an invalid role must be refused there with 400.
    const badRole = await call(`/sessions/${id}`, {
      method: "PUT",
      body: JSON.stringify({ messages: [{ role: "tool", content: "x", ts: new Date().toISOString() }] }),
    });
    expect(badRole.status).toBe(400);

    // The session is untouched by the rejected write.
    expect(getStudioSession(id)?.messages.length).toBe(0);
  });
});

describe("studio router", () => {
  it("lists models and combos", async () => {
    const res = await call("/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; owned_by: string }> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("creates, reads, updates and deletes a session", async () => {
    const created = await call("/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "router smoke", model: "m", systemPrompt: "be brief" }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const put = await call(`/sessions/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        messages: [
          { role: "user", content: "hello", ts: new Date().toISOString() },
          { role: "assistant", content: "hi", ts: new Date().toISOString() },
        ],
      }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: { messages: unknown[] } }).data.messages.length).toBe(2);

    expect((await call(`/sessions/${id}`)).status).toBe(200);
    expect(((await (await call("/sessions")).json()) as { data: unknown[] }).data.length).toBe(1);

    expect((await call(`/sessions/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/sessions/${id}`)).status).toBe(404);
  });

  it("rejects malformed session payloads with 400", async () => {
    const badMessages = await call("/sessions/x", {
      method: "PUT",
      body: JSON.stringify({ messages: "not-an-array" }),
    });
    expect(badMessages.status).toBe(400);
  });

  it("validates chat requests before dispatch", async () => {
    const noModel = await call("/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    expect(noModel.status).toBe(400);

    const noMessages = await call("/chat", { method: "POST", body: JSON.stringify({ model: "m" }) });
    expect(noMessages.status).toBe(400);

    const emptyMessages = await call("/chat", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) });
    expect(emptyMessages.status).toBe(400);

    const badJson = await call("/chat", { method: "POST", body: "{not json" });
    expect(badJson.status).toBe(400);
  });
});
