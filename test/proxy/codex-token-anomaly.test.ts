import { describe, expect, test } from "bun:test";
import type { Account } from "../../src/db/schema";
import { CodexProvider } from "../../src/proxy/providers/codex";

class TestCodexProvider extends CodexProvider {
  lastRequestBody: any;
  constructor(private readonly responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
    super();
  }
  protected override async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    this.lastRequestBody = JSON.parse(String(init.body || "{}"));
    return this.responder(url, init);
  }
}

const account = {
  id: 1, provider: "codex", email: "codex@test.local",
  tokens: { access_token: "access-token", account_id: "acct_1" },
} as Account;

function emptyStreamResponse() {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.completed", response: { output: [], usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function countInputChars(items: any[]): number {
  return JSON.stringify(items).length;
}

describe("CodexProvider request body token anomaly", () => {
  test("assistant tool-call turn: content null should not emit empty message item", async () => {
    const provider = new TestCodexProvider(() => emptyStreamResponse());
    await provider.chatCompletion(account, {
      model: "codex-gpt-5.6",
      messages: [
        { role: "user", content: "List files" },
        { role: "assistant", content: null as any, tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "file_a\nfile_b" },
      ],
    });

    const input = provider.lastRequestBody.input as any[];
    // Should NOT contain an empty output_text message item for the assistant turn
    const emptyMessages = input.filter((i) => i.type === "message" && Array.isArray(i.content) && i.content.length === 1 && i.content[0].text === "");
    expect(emptyMessages.length).toBe(0);
  });

  test("OpenAI assistant message with content + tool_calls: content is sent exactly once", async () => {
    const provider = new TestCodexProvider(() => emptyStreamResponse());
    const assistantText = "I will list files for you.";
    await provider.chatCompletion(account, {
      model: "codex-gpt-5.6",
      messages: [
        { role: "user", content: "List files" },
        { role: "assistant", content: assistantText, tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "file_a\nfile_b" },
      ],
    });

    const input = provider.lastRequestBody.input as any[];
    const messages = input.filter((i) => i.type === "message");
    const fnCalls = input.filter((i) => i.type === "function_call");
    const fnOutputs = input.filter((i) => i.type === "function_call_output");
    expect(messages.length).toBe(2); // user + assistant text, tool result is function_call_output
    expect(fnCalls.length).toBe(1);
    expect(fnOutputs.length).toBe(1);
    // assistant text appears exactly once
    const assistantMsgs = messages.filter((m: any) => m.role === "assistant");
    expect(assistantMsgs.length).toBe(1);
    expect(assistantMsgs[0].content[0].text).toBe(assistantText);
  });

  test("Anthropic-style assistant tool_use: tool_use block should not be double-counted as text", async () => {
    const provider = new TestCodexProvider(() => emptyStreamResponse());
    await provider.chatCompletion(account, {
      model: "codex-gpt-5.6",
      messages: [
        { role: "user", content: "List files" },
        { role: "assistant", content: [
          { type: "text", text: "Sure, listing files." },
          { type: "tool_use", id: "call_1", name: "ls", input: { path: "." } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file_a\nfile_b" }] },
      ],
    });

    const input = provider.lastRequestBody.input as any[];
    const messages = input.filter((i) => i.type === "message");
    const fnCalls = input.filter((i) => i.type === "function_call");
    const fnOutputs = input.filter((i) => i.type === "function_call_output");

    // Assistant message should be exactly one message item (text) + one function_call
    const assistantMsgs = messages.filter((m: any) => m.role === "assistant");
    expect(assistantMsgs.length).toBe(1);
    expect(assistantMsgs[0].content[0].text).toBe("Sure, listing files.");
    expect(fnCalls.length).toBe(1);
    expect(fnOutputs.length).toBe(1);

    // tool_use_id content should not leak as a duplicate text message
    const toolResultTexts = messages.filter((m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((c: any) => c.text === "file_a\nfile_b"));
    expect(toolResultTexts.length).toBe(0);
  });

  test("tool_result with structured content: not duplicated", async () => {
    const provider = new TestCodexProvider(() => emptyStreamResponse());
    const baseline = await (async () => {
      await provider.chatCompletion(account, {
        model: "codex-gpt-5.6",
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: null as any, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "c1", content: "result" },
        ],
      });
      return countInputChars(provider.lastRequestBody.input);
    })();
    // baseline = expected size; sanity check it's reasonable (not exploding)
    expect(baseline).toBeLessThan(500);
    console.log("baseline input chars:", baseline, JSON.stringify(provider.lastRequestBody.input));
  });
});
