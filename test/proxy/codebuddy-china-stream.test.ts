/**
 * Regression tests for CodeBuddy China stream termination.
 *
 * The China provider shared the same terminal-state bugs as the international
 * one: it treated `[DONE]` as "keep reading" (so an upstream that finishes the
 * payload but holds the socket open hung the request), swallowed upstream error
 * events into an empty delta, never emitted `[DONE]` on plain EOF, dropped a
 * non-SSE JSON body entirely, and had no `cancel` handler to abort the upstream
 * reader on client disconnect.
 *
 * Run with:  bun test test/proxy/codebuddy-china-stream.test.ts
 */

import { describe, expect, test } from "bun:test";
import { CodeBuddyChinaProvider } from "../../src/proxy/providers/codebuddy-china";
import type { ChatCompletionRequest } from "../../src/proxy/providers/base";
import type { Account } from "../../src/db/schema";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type ProviderWithFetch = CodeBuddyChinaProvider & {
  fetchWithTimeout: (url: string, init: RequestInit, timeoutMs?: number) => Promise<Response>;
};

/** Build a provider whose HTTP layer returns `response` directly (no network). */
function providerReturning(response: Response): ProviderWithFetch {
  const p = new CodeBuddyChinaProvider() as ProviderWithFetch;
  p.fetchWithTimeout = async () => response;
  return p;
}

function makeAccount(): Account {
  return {
    id: 1,
    provider: "codebuddy-china",
    email: "test@example.com",
    password: "x",
    status: "active",
    enabled: true,
    tokens: JSON.stringify({ api_key: "test-key" }),
    createdAt: new Date(),
  } as Account;
}

function makeRequest(): ChatCompletionRequest {
  return { model: "cb-cn-claude-sonnet", messages: [{ role: "user", content: "hi" }] };
}

/** Drain a stream within a real deadline; a hang fails the test. */
async function readAll(stream: ReadableStream<Uint8Array>, ms = 3000): Promise<string> {
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

function contentChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`;
}

describe("CodeBuddyChinaProvider stream termination", () => {
  test("stops reading once [DONE] arrives, even if the upstream holds the socket open", async () => {
    let upstreamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(contentChunk("hi")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        // deliberately never closed — the upstream keeps the connection open
      },
      cancel() { upstreamCancelled = true; },
    });

    const result = await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(
      makeAccount(),
      makeRequest()
    );
    expect(result.success).toBe(true);

    const text = await readAll(result.stream!, 3000);
    expect(text).toContain('"content":"hi"');
    expect(text).toContain("data: [DONE]");
    expect(upstreamCancelled).toBe(true);
  });

  test("emits [DONE] exactly once when the upstream sends several markers", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(contentChunk("hi")));
        controller.enqueue(encoder.encode("data: [DONE]\n\ndata: [DONE]\n\n"));
        controller.close();
      },
    });

    const result = await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(
      makeAccount(),
      makeRequest()
    );
    const text = await readAll(result.stream!, 3000);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  test("terminates with [DONE] when the upstream ends without one", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(contentChunk("partial")));
        controller.close();
      },
    });

    const result = await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(
      makeAccount(),
      makeRequest()
    );
    const text = await readAll(result.stream!, 3000);
    expect(text).toContain("partial");
    expect(text).toContain("data: [DONE]");
  });

  test("surfaces an SSE error event instead of forwarding a silent empty delta", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(contentChunk("hi")));
        controller.enqueue(encoder.encode('data: {"error":{"message":"quota exceeded"}}\n\n'));
        controller.close();
      },
    });

    const result = await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(
      makeAccount(),
      makeRequest()
    );
    const text = await readAll(result.stream!, 3000);
    expect(text).toContain("quota exceeded");
    expect(text).toContain("data: [DONE]");
  });

  test("rejects the stream when the upstream errors before any content", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"error":{"message":"quota exceeded"}}\n\n'));
        controller.close();
      },
    });

    const result = await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(
      makeAccount(),
      makeRequest()
    );
    const reader = result.stream!.getReader();
    await expect(reader.read()).rejects.toThrow(/quota exceeded/);
  });

  test("recovers a plain JSON body returned without SSE framing", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({
          id: "x",
          object: "chat.completion",
          model: "cb-cn-claude-sonnet",
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        })));
        controller.close();
      },
    });

    const result = await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(
      makeAccount(),
      makeRequest()
    );
    const text = await readAll(result.stream!, 3000);
    expect(text).toContain("hello");
    expect(text).toContain("data: [DONE]");
  });

  test("cancelling from the consumer aborts the upstream reader without throwing", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(contentChunk("hi")));
        // never closes, never sends [DONE]
      },
    });

    const result = await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(
      makeAccount(),
      makeRequest()
    );
    const reader = result.stream!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await expect(reader.cancel("client disconnected")).resolves.toBeUndefined();
  });

  test("processes a final event the upstream never terminated with a newline", async () => {
    // `split("\n")` leaves the trailing partial line in the read buffer; an
    // upstream ending without a final newline had that last event dropped.
    const first = `data: ${JSON.stringify({ choices: [{ delta: { content: "FIRST" }, finish_reason: null }] })}\n\n`;
    const last = `data: ${JSON.stringify({ choices: [{ delta: { content: "LAST" }, finish_reason: null }] })}`;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(first + last));
        controller.close();
      },
    });

    const result = await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(
      makeAccount(),
      makeRequest()
    );
    const text = await readAll(result.stream!, 3000);
    expect(text).toContain("FIRST");
    expect(text).toContain("LAST");
  });
});
