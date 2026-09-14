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
