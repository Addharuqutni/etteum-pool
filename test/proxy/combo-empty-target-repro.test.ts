/**
 * REGRESSION: a combo target that answers HTTP 200 with NO content is a
 * FAILURE, not a successful empty answer — the chain must advance.
 *
 * Before the fix, `peekStreamForError` only reported an error when the upstream
 * sent an explicit error event. A stream that ended cleanly with no content
 * (or `[DONE]` only) was replayed as success, so `handleChatCompletionSingle`
 * returned normally, the combo loop stopped at target 0, and the client got an
 * empty 200 while a healthy backup sat unused. BYOK was worse: its stream was
 * never peeked at all.
 *
 * Run with:  bun test test/proxy/combo-empty-target-repro.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { accounts, combos, requestLogs } from "../../src/db/schema";
import { inArray } from "drizzle-orm";
import { encrypt } from "../../src/utils/crypto";
import { refreshByokModels } from "../../src/proxy/providers/registry";
import { ensureCombosTable, loadCombos, createCombo } from "../../src/proxy/combos";

const FAKE_UPSTREAM = "https://api.test.invalid/v1";
const encoder = new TextEncoder();

async function deleteAccounts() {
  const ids = (
    await db.select({ id: accounts.id }).from(accounts).where(inArray(accounts.provider, ["byok", "grok-cli"]))
  ).map((r) => r.id);
  if (ids.length > 0) {
    await db.update(requestLogs).set({ accountId: null }).where(inArray(requestLogs.accountId, ids));
  }
  await db.delete(accounts).where(inArray(accounts.provider, ["byok", "grok-cli"]));
}

async function seedByok(prefix: string, models: string[]) {
  await db.insert(accounts).values({
    provider: "byok",
    email: prefix,
    password: encrypt(`test-key-${prefix}`),
    status: "active",
    enabled: true,
    tokens: JSON.stringify({ base_url: FAKE_UPSTREAM, format: "openai", models, model_prefix: prefix }),
  });
  await refreshByokModels();
}

async function seedGrok(prefix: string) {
  await db.insert(accounts).values({
    provider: "grok-cli",
    email: prefix,
    password: encrypt(`grok-key-${prefix}`),
    status: "active",
    enabled: true,
    tokens: JSON.stringify({ access_token: `grok-key-${prefix}`, email: prefix }),
  });
}

/** A grok Responses-API text delta, which the provider re-emits as an OpenAI chunk. */
function grokChunk(text: string): string {
  return `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`;
}

function sseResponse(chunks: string[]): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i++]!));
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

type Attempt = { model?: string; account?: string };

/**
 * Replays one Response per upstream attempt; factories keep streams unread.
 * Records the account as well as the model: grok normalizes `grok-4.5-high`
 * down to `grok-4.5` before calling upstream, so the model alone cannot tell
 * the two targets apart.
 */
function installStub(attempts: Attempt[], responses: Array<() => Response>) {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    let parsed: { model?: string } = {};
    try {
      parsed = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    } catch {
      /* non-JSON body */
    }
    attempts.push({ model: parsed.model, account: new Headers(init?.headers).get("authorization") ?? undefined });
    const factory = responses[Math.min(attempts.length, responses.length) - 1];
    return factory!();
  }) as typeof fetch;
}

async function postChat(model: string, stream: boolean) {
  const { proxyRouter } = await import("../../src/proxy/index");
  return proxyRouter.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hi" }] }),
  });
}

function jsonOk(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "ok",
      object: "chat.completion",
      model: "glm-5.3",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("200-but-EMPTY combo target advances the chain", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    await deleteAccounts();
    await db.delete(combos);
    ensureCombosTable();
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await deleteAccounts();
    await db.delete(combos);
    await loadCombos();
    await refreshByokModels();
  });

  it("(e) NON-STREAM: a zero-byte 200 body falls through to the next target", async () => {
    await seedByok("alpha", ["glm-5.3"]);
    await seedByok("beta", ["glm-5.3"]);
    await createCombo({ name: "EmptyNonStream", targets: ["alpha-glm-5.3", "beta-glm-5.3"] });
    await loadCombos();

    const attempts: Attempt[] = [];
    installStub(attempts, [
      () => new Response("", { status: 200, headers: { "Content-Type": "application/json" } }),
      () => jsonOk("served-by-beta"),
    ]);

    const res = await postChat("EmptyNonStream", false);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("served-by-beta");
    expect(attempts).toHaveLength(2);
  });

  /** Each case: target 1 delivers nothing, target 2 must serve the answer. */
  async function expectStreamFallsThrough(name: string, firstChunks: string[]) {
    await seedByok("alpha", ["glm-5.3"]);
    await seedByok("beta", ["glm-5.3"]);
    await createCombo({ name, targets: ["alpha-glm-5.3", "beta-glm-5.3"] });
    await loadCombos();

    const attempts: Attempt[] = [];
    installStub(attempts, [
      () => sseResponse(firstChunks),
      () =>
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "served-by-beta" }, finish_reason: null }] })}\n\n`,
          "data: [DONE]\n\n",
        ]),
    ]);

    const res = await postChat(name, true);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("served-by-beta");
    expect(attempts.map((a) => a.account)).toEqual(["Bearer test-key-alpha", "Bearer test-key-beta"]);
  }

  it("(f1) STREAM: a [DONE]-only stream falls through", async () => {
    await expectStreamFallsThrough("DoneOnly", ["data: [DONE]\n\n"]);
  });

  it("(f2) STREAM: a completely empty stream body falls through", async () => {
    await expectStreamFallsThrough("EmptyBody", []);
  });

  it("(f3) STREAM: a body with no data: line at all falls through", async () => {
    await expectStreamFallsThrough("NoDataLine", ["\n\n"]);
  });

  it("(g) STREAM byok: an empty stream falls through even though BYOK errors are HTTP status codes", async () => {
    await seedByok("alpha", ["glm-5.3"]);
    await seedByok("beta", ["glm-5.3"]);
    await createCombo({ name: "ByokEmpty", targets: ["alpha-glm-5.3", "beta-glm-5.3"] });
    await loadCombos();

    const attempts: Attempt[] = [];
    installStub(attempts, [
      () => sseResponse(["data: [DONE]\n\n"]),
      () =>
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "served-by-beta" }, finish_reason: null }] })}\n\n`,
          "data: [DONE]\n\n",
        ]),
    ]);

    const res = await postChat("ByokEmpty", true);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("served-by-beta");
    expect(attempts.map((a) => a.account)).toEqual(["Bearer test-key-alpha", "Bearer test-key-beta"]);
  });

  it("(h) STREAM: a target that never sends a byte falls through instead of hanging", async () => {
    await seedByok("alpha", ["glm-5.3"]);
    await seedByok("beta", ["glm-5.3"]);
    await createCombo({ name: "Stalled", targets: ["alpha-glm-5.3", "beta-glm-5.3"] });
    await loadCombos();

    const attempts: Attempt[] = [];
    // Enqueues nothing and never closes: without a first-byte deadline this
    // read blocks forever and the chain can never advance.
    installStub(attempts, [
      () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
      () =>
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "served-by-beta" }, finish_reason: null }] })}\n\n`,
          "data: [DONE]\n\n",
        ]),
    ]);

    const res = await postChat("Stalled", true);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("served-by-beta");
    expect(attempts.map((a) => a.account)).toEqual(["Bearer test-key-alpha", "Bearer test-key-beta"]);
  }, 30_000);
});
