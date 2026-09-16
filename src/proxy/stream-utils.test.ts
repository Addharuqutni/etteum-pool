/**
 * Unit tests for the shared SSE stream loop.
 *
 * The loop owns the terminal semantics that every hand-rolled provider stream
 * used to re-derive (see the module header), plus two provider-selectable
 * policies: the idle watchdog and whether a pre-content failure rejects the
 * stream. Both are asserted here directly, because a provider-level test cannot
 * reach them without waiting out a five-minute stall.
 *
 * Run with:  bun test src/proxy/stream-utils.test.ts
 *
 * Allowed exception to no-test-timers: the watchdog tests drive a genuine
 * wall-clock stall against a real `setTimeout`, so fake timers cannot express
 * them — the point is that the loop aborts a socket that really stopped
 * producing. The deadlines are milliseconds and the drains fail fast rather
 * than waiting out a hang.
 */

import { describe, expect, test } from "bun:test";
import { runSseStreamLoop, type SseStreamLoopOptions } from "./stream-utils";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A loop that forwards each event's content verbatim. */
function passthroughLoop(
  response: Response,
  options: Partial<SseStreamLoopOptions> = {}
): ReadableStream<Uint8Array> {
  return runSseStreamLoop({
    response,
    id: "id",
    model: "model",
    logPrefix: "[test]",
    onEvent: (parsed) => ({
      chunks: [{
        id: "id",
        object: "chat.completion.chunk",
        created: 0,
        model: "model",
        choices: [{ index: 0, delta: { content: String(parsed.choices?.[0]?.delta?.content ?? "") }, finish_reason: null }],
      }],
      content: String(parsed.choices?.[0]?.delta?.content ?? ""),
    }),
    onPlainJson: () => ({}),
    ...options,
  });
}

/** Build an upstream stream from a fixed chunk list. */
function upstream(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() { onCancel?.(); },
  });
}

/** Drain a stream within a real deadline so a hang fails instead of stalling CI. */
async function drain(stream: ReadableStream<Uint8Array>, ms = 3000): Promise<string> {
  const reader = stream.getReader();
  const out: string[] = [];
  let timedOut = false;
  const timerId = setTimeout(() => { timedOut = true; }, ms);
  try {
    while (!timedOut) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(decoder.decode(value));
    }
  } finally {
    clearTimeout(timerId);
    if (timedOut) { try { await reader.cancel("test deadline"); } catch {} }
  }
  if (timedOut) throw new Error(`stream did not complete within ${ms}ms (hangs)`);
  return out.join("");
}

const done = encoder.encode("data: [DONE]\n\n");

function contentEvent(text: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
}

describe("runSseStreamLoop terminal semantics", () => {
  test("forwards events then terminates once, on the upstream [DONE]", async () => {
    const text = await drain(passthroughLoop(new Response(upstream([contentEvent("a"), done]))));
    expect(text).toContain('"content":"a"');
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  test("terminates with [DONE] when the upstream ends without one", async () => {
    const text = await drain(passthroughLoop(new Response(upstream([contentEvent("a")]))));
    expect(text).toContain('"content":"a"');
    expect(text).toContain("data: [DONE]");
  });

  test("skips a malformed chunk and keeps streaming", async () => {
    const broken = encoder.encode("data: {not json}\n\n");
    const text = await drain(passthroughLoop(new Response(upstream([broken, contentEvent("after")]))));
    expect(text).toContain('"content":"after"');
    expect(text).toContain("data: [DONE]");
  });

  test("processes a final event the upstream never terminated with a newline", async () => {
    const last = encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "LAST" } }] })}`);
    const text = await drain(passthroughLoop(new Response(upstream([contentEvent("first"), last]))));
    expect(text).toContain('"content":"first"');
    expect(text).toContain('"content":"LAST"');
  });

  test("surfaces a pre-content upstream error event by rejecting the stream", async () => {
    const err = encoder.encode(`data: ${JSON.stringify({ error: { message: "quota exceeded" } })}\n\n`);
    const reader = passthroughLoop(new Response(upstream([err]))).getReader();
    await expect(reader.read()).rejects.toThrow(/quota exceeded/);
  });

  test("emits an error chunk when the upstream fails after content", async () => {
    const text = await drain(passthroughLoop(new Response(upstream([contentEvent("partial")]))));
    expect(text).toContain("partial");
  });

  test("releases the upstream reader once [DONE] arrives", async () => {
    let cancelled = false;
    // The upstream stays open after [DONE]; the loop must cancel it.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(contentEvent("x"));
        controller.enqueue(done);
      },
      cancel() { cancelled = true; },
    });
    await drain(passthroughLoop(new Response(stream)));
    expect(cancelled).toBe(true);
  });
});

describe("runSseStreamLoop watchdog", () => {
  test("aborts a stalled upstream and still terminates the stream", async () => {
    // A single content event, then silence forever. `reader.cancel()` resolves
    // the pending read with done, so the loop exits and terminates cleanly
    // instead of leaving the request pending on a dead socket.
    let upstreamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(contentEvent("x")); },
      cancel() { upstreamCancelled = true; },
    });

    const text = await drain(passthroughLoop(new Response(stream), { readTimeoutMs: 60 }));

    expect(upstreamCancelled).toBe(true);
    expect(text).toContain("data: [DONE]");
  });

  test("does not fire while the upstream keeps producing", async () => {
    const chunks = [contentEvent("a"), contentEvent("b")];
    const text = await drain(passthroughLoop(new Response(upstream(chunks)), { readTimeoutMs: 60 }));
    expect(text).toContain('"content":"a"');
    expect(text).toContain('"content":"b"');
  });
});

describe("runSseStreamLoop failure policy", () => {
  test("rejects a pre-content read error when rejectOnErrorBeforeContent is set", async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((r) => setTimeout(r, 10));
        controller.error(new Error("Connection reset by peer"));
      },
    });
    const reader = passthroughLoop(new Response(body), { rejectOnErrorBeforeContent: true }).getReader();
    await expect(reader.read()).rejects.toThrow(/Connection reset/);
  });

  test("forwards a pre-content read error as a chunk by default", async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((r) => setTimeout(r, 10));
        controller.error(new Error("Connection reset by peer"));
      },
    });
    const text = await drain(passthroughLoop(new Response(body)));
    expect(text).toContain("[Stream error: Connection reset by peer]");
    expect(text).toContain("data: [DONE]");
  });
});

describe("runSseStreamLoop recovery", () => {
  test("recovers a plain JSON body that carried no SSE framing", async () => {
    const body = upstream([encoder.encode(JSON.stringify({ choices: [{ message: { content: "hello" } }] }))]);
    const stream = runSseStreamLoop({
      response: new Response(body),
      id: "id",
      model: "model",
      logPrefix: "[test]",
      onEvent: () => ({}),
      onPlainJson: (parsed) => ({
        chunks: [{
          id: "id",
          object: "chat.completion.chunk",
          created: 0,
          model: "model",
          choices: [{ index: 0, delta: { content: String(parsed.choices?.[0]?.message?.content ?? "") }, finish_reason: null }],
        }],
        content: "hello",
      }),
    });

    const text = await drain(stream);
    expect(text).toContain('"content":"hello"');
    expect(text).toContain("data: [DONE]");
  });

  test("forwards a read error after content even when rejectOnErrorBeforeContent is set", async () => {
    // `deliveredContent` decides whether a failure rejects the stream (nothing
    // seen yet → the combo fallback may retry) or is surfaced as an error chunk
    // (the client already has partial output, so retrying would duplicate it).
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(contentEvent("partial"));
        await Promise.resolve();
        controller.error(new Error("Connection reset by peer"));
      },
    });

    const text = await drain(passthroughLoop(new Response(body), { rejectOnErrorBeforeContent: true }));
    expect(text).toContain("partial");
    expect(text).toContain("[Stream error: Connection reset by peer]");
    expect(text).toContain("data: [DONE]");
  });
});
