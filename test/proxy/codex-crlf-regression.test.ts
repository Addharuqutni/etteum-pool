import { describe, expect, test } from "bun:test";
import type { Account } from "../../src/db/schema";
import { CodexProvider } from "../../src/proxy/providers/codex";

class TestCodexProvider extends CodexProvider {
  constructor(private readonly responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
    super();
  }
  protected override async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    return this.responder(url, init);
  }
}

const account = {
  id: 1,
  provider: "codex",
  email: "codex@test.local",
  tokens: { access_token: "access-token", account_id: "acct_1" },
} as Account;

/** Build an SSE body using CRLF line endings, like chatgpt.com upstream often does. */
function crlfResponse(events: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        // CRLF between event field lines AND CRLF blank line terminator
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("CodexProvider CRLF regression", () => {
  test("stream should still terminate with [DONE] when upstream uses CRLF", async () => {
    const provider = new TestCodexProvider(() => crlfResponse([
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.completed", response: { output: [] } },
    ]));

    const result = await provider.chatCompletionStream(account, {
      model: "codex-gpt-5.6",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    expect(result.success).toBe(true);
    const text = await collectStream(result.stream!);
    expect(text).toContain("Hello");
    expect(text).toContain("[DONE]");
  });

  test("non-stream should collect text when upstream uses CRLF", async () => {
    const provider = new TestCodexProvider(() => crlfResponse([
      { type: "response.output_text.delta", delta: "World" },
      { type: "response.completed", response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]));

    const result = await provider.chatCompletion(account, {
      model: "codex-gpt-5.6",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.success).toBe(true);
    expect((result.response as any).choices[0].message.content).toBe("World");
  });
});
