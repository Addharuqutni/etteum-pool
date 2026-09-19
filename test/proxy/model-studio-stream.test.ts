/**
 * Model Studio SSE client — frame parsing over a real HTTP connection.
 *
 * The studio chat endpoint streams the same OpenAI-style SSE as
 * /v1/chat/completions (including the CRLF terminators the codex provider
 * emits), so the dashboard client must tolerate: \n\n and \r\n\r\n frame
 * separators, a frame split across reads, reasoning carried under either
 * `reasoning_content` or `reasoning`, and usage blocks with token details.
 *
 * Serves crafted frames from a local server — no account, no upstream call,
 * no quota. Browser globals (window/localStorage) are stubbed before the
 * dashboard module is imported, because api.ts resolves the API base at
 * module load; the client symbol is therefore loaded via a deferred import
 * (static imports evaluate before the stubs can be installed). The scenario
 * is selected from the request body so no client plumbing has to change.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { streamModelStudioChat } from "../../dashboard/src/lib/model-studio";

const encoder = new TextEncoder();

/** Builds one SSE frame from a JSON payload, with LF or CRLF terminators. */
function chunk(payload: Record<string, unknown>, crlf = false): Uint8Array {
  const sep = crlf ? "\r\n\r\n" : "\n\n";
  return encoder.encode(`data: ${JSON.stringify(payload)}${sep}`);
}

/** Builds one raw SSE frame (used for the usage block and [DONE]). */
function rawFrame(payload: string, crlf = false): Uint8Array {
  const sep = crlf ? "\r\n\r\n" : "\n\n";
  return encoder.encode(`data: ${payload}${sep}`);
}

/**
 * Emits the second half of a split frame from `pull`, which runs only once the
 * consumer has drained the first half — deterministically forcing a read
 * boundary inside a frame, with no wall-clock timers.
 */
function splitFrameStream(): ReadableStream<Uint8Array> {
  const whole = chunk({ choices: [{ delta: { content: "hello world" } }] });
  let sent = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(whole.subarray(0, 14));
    },
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(whole.subarray(14));
        return;
      }
      controller.close();
    },
  });
}

type StudioClient = typeof streamModelStudioChat;
let chat: StudioClient;
let server: Bun.Server;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/api/model-studio/chat") {
        return new Response("not found", { status: 404 });
      }

      const body = ((await req.json().catch(() => ({}))) as {
        model?: string;
        messages?: unknown[];
      }) ?? {};

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return new Response(JSON.stringify({ error: { message: "no account available" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (body.model === "split") {
        return new Response(splitFrameStream(), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      if (body.model === "abort") {
        // Emits forever until the client aborts; the interval is the test
        // server's own pacing (real streaming), not a guessed test wait.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              let n = 0;
              const tick = () => {
                try {
                  controller.enqueue(chunk({ choices: [{ delta: { content: `tick-${n++} ` } }] }));
                  setTimeout(tick, 40);
                } catch {
                  // Client disconnected; stop quietly.
                }
              };
              setTimeout(tick, 40);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        );
      }

      const usage = rawFrame(
        JSON.stringify({
          usage: {
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20,
            completion_tokens_details: { reasoning_tokens: 5 },
            prompt_tokens_details: { cached_tokens: 3 },
          },
        }),
        true
      );
      const parts = [
        chunk({ choices: [{ delta: { reasoning_content: "thinking " } }] }, true),
        chunk({ choices: [{ delta: { reasoning: "more " } }] }, true),
        chunk({ choices: [{ delta: { content: "Hello, " } }] }, true),
        chunk({ choices: [{ delta: { content: "world." } }] }, true),
        usage,
        rawFrame("[DONE]", true),
      ];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
      );
    },
  });

  // api.ts derives the backend port from window.location.port at import time.
  (globalThis as Record<string, unknown>).window = {
    location: { port: String(server.port + 1), hostname: "localhost", protocol: "http:" },
  };
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => (key === "api_key" ? "test-key" : null),
  };
  chat = (await import("../../dashboard/src/lib/model-studio")).streamModelStudioChat;
});

afterAll(() => {
  server.stop(true);
});

function deltaOf(overrides: Partial<Parameters<StudioClient>[1]> = {}): Parameters<StudioClient>[1] {
  return {
    onText: () => {},
    onReasoning: () => {},
    onUsage: () => {},
    onFirstToken: () => {},
    ...overrides,
  };
}

describe("model studio SSE client", () => {
  test("assembles text, reasoning and usage from CRLF frames", async () => {
    const text: string[] = [];
    const reasoning: string[] = [];
    let usage: Record<string, number> | undefined;

    await chat(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      deltaOf({
        onText: (c) => text.push(c),
        onReasoning: (c) => reasoning.push(c),
        onUsage: (u) => {
          usage = u as Record<string, number>;
        },
      }),
      new AbortController().signal
    );

    expect(text.join("")).toBe("Hello, world.");
    expect(reasoning.join("")).toBe("thinking more ");
    expect(usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      reasoningTokens: 5,
      cachedTokens: 3,
      totalTokens: 20,
      source: "provider",
    });
  });

  test("reassembles a frame split across reads", async () => {
    const text: string[] = [];
    await chat(
      { model: "split", messages: [{ role: "user", content: "hi" }] },
      deltaOf({ onText: (c) => text.push(c) }),
      new AbortController().signal
    );
    expect(text.join("")).toBe("hello world");
  });

  test("surfaces a JSON error body on a non-2xx response", async () => {
    await expect(
      chat(
        { model: "m", messages: [] },
        deltaOf(),
        new AbortController().signal
      )
    ).rejects.toThrow("no account available");
  });

  test("aborts mid-stream without throwing and keeps partial text", async () => {
    const controller = new AbortController();
    const text: string[] = [];
    // Abort on the real first-token event rather than after a guessed delay.
    const finished = chat(
      { model: "abort", messages: [{ role: "user", content: "hi" }] },
      deltaOf({
        onText: (c) => text.push(c),
        onFirstToken: () => controller.abort(),
      }),
      controller.signal
    );
    await expect(finished).resolves.toBeUndefined();
    expect(text.join("").trim().length).toBeGreaterThan(0);
  });
});
