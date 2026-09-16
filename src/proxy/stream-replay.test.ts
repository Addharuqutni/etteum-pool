/**
 * Regression tests for peekStreamForError's replay path.
 *
 * The peek reads the upstream SSE head to decide whether an error arrived
 * before content. Once it decides, the already-read chunks must be re-emitted
 * EXACTLY ONCE, in order, before continuing to read the rest of the upstream.
 *
 * Regression: the replay loop re-enqueued `chunks[0]` forever (the index was
 * never incremented). Because that loop is synchronous and has no `await`, the
 * event loop never regained control, the ReadableStream queue grew without
 * bound, and the process died (OOM / VM fault) on any stream where the peek
 * consumed at least one chunk. That is the "crash while streaming" symptom.
 *
 * Run with:  bun test src/proxy/stream-replay.test.ts
 */

import { describe, it, expect } from "bun:test";
import { peekStreamForError, EMPTY_STREAM_MESSAGE } from "./index";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** SSE content chunk in the OpenAI streaming shape. */
function contentChunk(text: string): Uint8Array {
  return encoder.encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`
  );
}

function sseErrorChunk(message: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ type: "upstream_error", error: message })}\n\n`);
}

const DONE = encoder.encode("data: [DONE]\n\n");

/** Build an upstream stream from a fixed chunk list. */
function upstream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Drain a stream into decoded text chunks, bounded so a bug can't hang the suite. */
async function drain(stream: ReadableStream<Uint8Array>, maxChunks = 50): Promise<string[]> {
  const reader = stream.getReader();
  const out: string[] = [];
  while (out.length < maxChunks) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(decoder.decode(value));
  }
  await reader.cancel().catch(() => {});
  return out;
}

describe("peekStreamForError replay", () => {
  it("re-emits each peeked chunk exactly once, then continues upstream", async () => {
    const a = contentChunk("a");
    const b = contentChunk("b");
    const { error, stream } = await peekStreamForError(upstream([a, b, DONE]));

    expect(error).toBeUndefined();
    const out = await drain(stream);

    // Exactly three chunks out: the peeked one, then the rest of the upstream.
    expect(out).toEqual([decoder.decode(a), decoder.decode(b), decoder.decode(DONE)]);
  });

  it("does not duplicate a chunk the peek consumed", async () => {
    // A single peeked chunk is the case that used to spin forever: with an
    // off-by-one index, `chunks[0]` was re-enqueued for the whole process life.
    const a = contentChunk("only");
    const { stream } = await peekStreamForError(upstream([a]));

    const out = await drain(stream);
    expect(out).toEqual([decoder.decode(a)]);
  });

  it("preserves order when the peek read several chunks before content", async () => {
    // A leading non-content event (usage-only) keeps the peek reading, so it
    // accumulates multiple chunks that must all replay in the original order.
    const usage = encoder.encode(`data: ${JSON.stringify({ usage: { total_tokens: 7 } })}\n\n`);
    const a = contentChunk("a");
    const b = contentChunk("b");
    const { error, stream } = await peekStreamForError(upstream([usage, a, b, DONE]));

    expect(error).toBeUndefined();
    const out = await drain(stream);
    expect(out).toEqual([decoder.decode(usage), decoder.decode(a), decoder.decode(b), decoder.decode(DONE)]);
  });

  it("surfaces a pre-content upstream error instead of replaying", async () => {
    const err = sseErrorChunk("rate limited");
    const { error } = await peekStreamForError(upstream([err, contentChunk("ignored")]));
    expect(error).toBe("rate limited");
  });

  it("reports a stream that ends without content or tool calls as empty", async () => {
    // A usage-only event followed by [DONE] is no answer at all. This used to
    // pass through as a successful empty stream, which stalled the combo chain
    // on the dead target instead of falling back to the next one.
    const usage = encoder.encode(`data: ${JSON.stringify({ usage: { total_tokens: 1 } })}\n\n`);
    const { error } = await peekStreamForError(upstream([usage, DONE]));

    expect(error).toBe(EMPTY_STREAM_MESSAGE);
  });

  it("treats a tool-call-only answer as delivered, not empty", async () => {
    const toolOnly = encoder.encode(
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }] }, finish_reason: null }],
      })}\n\n`
    );
    const { error, stream } = await peekStreamForError(upstream([toolOnly, DONE]));

    expect(error).toBeUndefined();
    const out = await drain(stream);
    expect(out).toEqual([decoder.decode(toolOnly), decoder.decode(DONE)]);
  });
});
