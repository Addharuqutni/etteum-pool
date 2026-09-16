import { describe, expect, test } from "bun:test";
import { CodeBuddyProvider } from "../../src/proxy/providers/codebuddy";
import type { ChatCompletionRequest } from "../../src/proxy/providers/base";
import type { Account } from "../../src/db/schema";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type ProviderWithFetch = CodeBuddyProvider & {
  fetchWithTimeout: (url: string, init: RequestInit, timeoutMs?: number) => Promise<Response>;
};

/** Build a provider whose HTTP layer returns `response` directly (no network). */
function providerReturning(response: Response): ProviderWithFetch {
  const p = new CodeBuddyProvider() as ProviderWithFetch;
  p.fetchWithTimeout = async () => response;
  return p;
}

function makeAccount(): Account {
  return {
    id: 1,
    provider: "codebuddy",
    email: "test@example.com",
    password: "x",
    status: "active",
    enabled: true,
    tokens: JSON.stringify({ api_key: "test-key" }),
    createdAt: new Date(),
  } as Account;
}

function makeRequest(): ChatCompletionRequest {
  return { model: "cb-claude-opus", messages: [{ role: "user", content: "hi" }] };
}

/**
 * Read a stream to EOF within a real deadline (allowed exception to
 * no-test-timers: the stream is genuinely async, so a fake timer can't detect
 * a hang). Fails the test if the stream never completes.
 */
async function readAll(stream: ReadableStream<Uint8Array>, ms = 8000): Promise<string[]> {
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
  return out;
}

describe("CodeBuddyProvider stream error handling", () => {
  test("upstream body error mid-stream emits [Stream error] and completes, never hangs", async () => {
    // One normal content chunk, then the upstream connection is reset mid-stream.
    // createStreamResponse's catch must surface an error chunk + [DONE] and close.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
        await new Promise((r) => setTimeout(r, 10));
        controller.error(new Error("Connection reset by peer"));
      },
    });
    const result = await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(
      makeAccount(),
      makeRequest()
    );

    expect(result.success).toBe(true);
    expect(result.stream).toBeDefined();

    const chunks = await readAll(result.stream!, 8000);
    const text = chunks.join("");
    expect(text).toContain("hello");
    expect(text).toContain("[Stream error:");
    expect(text).toContain("data: [DONE]");
  });

  test("cancelling the stream from the consumer aborts upstream without throwing", async () => {
    // Upstream stays open (never sends [DONE]) until the consumer cancels.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
      },
    });
    const result = await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(
      makeAccount(),
      makeRequest()
    );
    expect(result.success).toBe(true);

    const reader = result.stream!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    // Cancelling must resolve (cancel handler aborts the upstream reader) and must
    // not raise an unhandled rejection that bun:test reports as a failure.
    await expect(reader.cancel("client disconnected")).resolves.toBeUndefined();
  });
});

describe("CodeBuddyProvider stream termination", () => {
  test("stops reading once [DONE] arrives, even if the upstream holds the socket open", async () => {
    // Real CodeBuddy behaviour: the payload ends with [DONE] but the connection
    // stays open. The loop must treat [DONE] as terminal — previously it kept
    // waiting on the next read until the 5-minute watchdog fired, hanging the
    // request (and the wrapper streams around it) for the whole timeout.
    let upstreamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        // deliberately never closed
      },
      cancel() { upstreamCancelled = true; },
    });

    const result = await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(
      makeAccount(),
      makeRequest()
    );

    // A short deadline: a hang would exceed it long before the 5-minute watchdog.
    const text = (await readAll(result.stream!, 3000)).join("");
    expect(text).toContain('"content":"hi"');
    expect(text).toContain("data: [DONE]");
    expect(upstreamCancelled).toBe(true);
  });

  test("emits [DONE] exactly once when the upstream sends several markers", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\ndata: [DONE]\n\n"));
        controller.close();
      },
    });

    const text = (await readAll(
      (await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(makeAccount(), makeRequest())).stream!,
      3000
    )).join("");

    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  test("terminates with [DONE] when the upstream ends without one", async () => {
    // Upstream EOF without a [DONE] marker: the client must still be told the
    // stream is over instead of waiting for a marker that never comes.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        controller.close();
      },
    });

    const text = (await readAll(
      (await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(makeAccount(), makeRequest())).stream!,
      3000
    )).join("");

    expect(text).toContain("partial");
    expect(text).toContain("data: [DONE]");
  });

  test("surfaces an SSE error event instead of forwarding a silent empty delta", async () => {
    // An HTTP 200 whose stream carries an error payload used to be parsed into a
    // chunk with an empty delta and no [DONE]: the client saw a successful,
    // completely empty answer with the real reason discarded.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"error":{"message":"quota exceeded"}}\n\n'));
        controller.close();
      },
    });

    const text = (await readAll(
      (await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(makeAccount(), makeRequest())).stream!,
      3000
    )).join("");

    expect(text).toContain("quota exceeded");
    expect(text).toContain("data: [DONE]");
  });

  test("rejects the stream when the upstream errors before any content", async () => {
    // Nothing was delivered, so the failure must reject the stream: the proxy's
    // combo fallback keys off that to try the next target. Emitting a 200 with an
    // error chunk instead would silently end the fallback chain.
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
    // A 200 whose body is a normal chat.completion JSON object carries no `data:`
    // line, so the SSE parser skipped it entirely and the answer was dropped.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({
          id: "x",
          object: "chat.completion",
          model: "cb-claude-opus",
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        })));
        controller.close();
      },
    });

    const text = (await readAll(
      (await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(makeAccount(), makeRequest())).stream!,
      3000
    )).join("");

    expect(text).toContain("hello");
    expect(text).toContain("data: [DONE]");
  });

  test("processes a final event the upstream never terminated with a newline", async () => {
    // `split("\n")` leaves the trailing partial line in the read buffer. An
    // upstream that ends its payload without a final newline (common at EOF) had
    // that last event dropped entirely, silently truncating the answer.
    const first = `data: ${JSON.stringify({ choices: [{ delta: { content: "FIRST" }, finish_reason: null }] })}\n\n`;
    const last = `data: ${JSON.stringify({ choices: [{ delta: { content: "LAST" }, finish_reason: null }] })}`;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(first + last));
        controller.close();
      },
    });

    const text = (await readAll(
      (await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(makeAccount(), makeRequest())).stream!,
      3000
    )).join("");

    expect(text).toContain("FIRST");
    expect(text).toContain("LAST");
  });

  test("terminates on a [DONE] sentinel that lacks a trailing newline", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "X" }, finish_reason: null }] })}\n\ndata: [DONE]`));
        controller.close();
      },
    });

    const text = (await readAll(
      (await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(makeAccount(), makeRequest())).stream!,
      3000
    )).join("");

    expect(text).toContain("X");
    expect(text).toContain("data: [DONE]");
  });
});

/**
 * These two behaviours exist only in the global provider (the China provider
 * shares the stream loop but not these rules), so they are pinned here to keep
 * the shared extraction honest.
 */
describe("CodeBuddyProvider stream rewrites", () => {
  test("rewrites a provider-side moderation notice and stops the turn", async () => {
    // CodeBuddy reports Chinese content moderation as ordinary delta content.
    // Forwarding it verbatim would show the user a Chinese provider message, so
    // it is replaced with an English notice plus a content_filter finish reason.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "系统检测到敏感内容" }, finish_reason: null }] })}\n\n`
        ));
        controller.close();
      },
    });

    const text = (await readAll(
      (await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(makeAccount(), makeRequest())).stream!,
      3000
    )).join("");

    expect(text).toContain("Content moderation");
    expect(text).toContain('"finish_reason":"content_filter"');
    expect(text).not.toContain("系统检测到");
  });

  test("rewrites a stop finish_reason to tool_calls once a tool call was seen", async () => {
    // The upstream sends the tool call and then finishes with "stop"; clients
    // treat "stop" as "no more tool calls" and drop the call, so it is
    // corrected to tool_calls.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`
        ));
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`
        ));
        controller.close();
      },
    });

    const text = (await readAll(
      (await providerReturning(new Response(body, { status: 200 })).chatCompletionStream(makeAccount(), makeRequest())).stream!,
      3000
    )).join("");

    expect(text).toContain('"tool_calls"');
    expect(text).toContain("data: [DONE]");
  });
});
