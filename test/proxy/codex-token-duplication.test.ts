import { describe, expect, test } from "bun:test";
import type { Account } from "../../src/db/schema";
import { CodexProvider } from "../../src/proxy/providers/codex";

class TestCodexProvider extends CodexProvider {
  lastRequestBody: any;
  constructor() { super(); }
  protected override async fetchWithTimeout(_url: string, init: RequestInit): Promise<Response> {
    this.lastRequestBody = JSON.parse(String(init.body || "{}"));
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.completed", response: { output: [], usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
}

const account = { id: 1, provider: "codex", email: "x@y", tokens: { access_token: "t", account_id: "a" } } as Account;

function inputChars(provider: TestCodexProvider) {
  return JSON.stringify(provider.lastRequestBody.input).length;
}

describe("CodexProvider token-duplication regression", () => {
  test("Anthropic multi-turn: tool result is sent exactly once (not as both message and function_call_output)", async () => {
    const bigToolResult = "x".repeat(2000); // 2KB of tool output
    const provider = new TestCodexProvider();
    await provider.chatCompletion(account, {
      model: "codex-gpt-5.6",
      messages: [
        { role: "user", content: "List files recursively" },
        { role: "assistant", content: [
          { type: "text", text: "Sure." },
          { type: "tool_use", id: "call_1", name: "list", input: { path: "." } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: bigToolResult }] },
        { role: "assistant", content: "Here are the files." },
      ],
    });

    const input = provider.lastRequestBody.input as any[];
    // tool result should appear exactly once, as function_call_output
    const fnOutputs = input.filter((i) => i.type === "function_call_output");
    expect(fnOutputs.length).toBe(1);
    expect(fnOutputs[0].output).toBe(bigToolResult);

    // it must NOT also be present as a user message
    const userMessages = input.filter((i) => i.type === "message" && i.role === "user");
    const leaked = userMessages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.text === bigToolResult));
    expect(leaked).toBe(false);

    // Sanity: total input size is roughly user(30) + assistant("Sure." + fn_call) + fn_output(2000) + assistant("Here are the files.")
    // If duplicated, we'd see ~2000 extra chars beyond the single fn_output.
    const size = inputChars(provider);
    expect(size).toBeLessThan(2800); // single copy + JSON overhead only
    // The key check: tool result text appears exactly once across the whole input payload
    const occurrences = (JSON.stringify(input).split(bigToolResult).length - 1);
    expect(occurrences).toBe(1);
  });

  test("OpenAI multi-turn: tool role content is sent exactly once", async () => {
    const bigToolResult = "y".repeat(2000);
    const provider = new TestCodexProvider();
    await provider.chatCompletion(account, {
      model: "codex-gpt-5.6",
      messages: [
        { role: "user", content: "List files" },
        { role: "assistant", content: null as any, tool_calls: [{ id: "c1", type: "function", function: { name: "list", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: bigToolResult },
        { role: "assistant", content: "Done." },
      ],
    });

    const input = provider.lastRequestBody.input as any[];
    const fnOutputs = input.filter((i) => i.type === "function_call_output");
    expect(fnOutputs.length).toBe(1);
    expect(fnOutputs[0].output).toBe(bigToolResult);
    // tool output should not leak into any message item
    const messages = input.filter((i) => i.type === "message");
    const leaked = messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.text === bigToolResult));
    expect(leaked).toBe(false);
    const occurrences = (JSON.stringify(input).split(bigToolResult).length - 1);
    expect(occurrences).toBe(1);
  });
});
