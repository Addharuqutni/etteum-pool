import { describe, expect, test } from "bun:test";
import { CodeBuddyChinaProvider } from "../../src/proxy/providers/codebuddy-china";

// Access private methods via cast
const provider = new CodeBuddyChinaProvider() as any;

describe("CodeBuddyChina cleanMessages", () => {
  test("preserves tool_call_id on OpenAI-native tool messages", () => {
    const { messages } = provider.cleanMessages({
      model: "cbc-deepseek-v4-flash",
      messages: [
        { role: "user", content: "use tool" },
        {
          role: "assistant",
          content: "ok",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "file content" },
      ],
    });

    expect(messages).toHaveLength(3);
    const toolMsg = messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe("call_1");
  });

  test("strips orphaned tool messages (no matching tool_calls)", () => {
    const { messages } = provider.cleanMessages({
      model: "cbc-deepseek-v4-flash",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "tool", tool_call_id: "orphan_1", content: "lost result" },
      ],
    });

    const toolMsgs = messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs).toHaveLength(0);
  });

  test("remaps dangling tool_call_id to the next unmatched tool call", () => {
    const { messages } = provider.cleanMessages({
      model: "cbc-deepseek-v4-flash",
      messages: [
        { role: "user", content: "run tools" },
        {
          role: "assistant",
          content: "sure",
          tool_calls: [{ id: "call_a", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        // tool_call_id doesn't match any known id — gets remapped to "call_a"
        { role: "tool", tool_call_id: "mismatch", content: "result" },
      ],
    });

    const toolMsg = messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe("call_a");
  });

  test("converts Anthropic tool_use → tool_calls and pairs tool_result correctly", () => {
    const { messages } = provider.cleanMessages({
      model: "cbc-deepseek-v4-flash",
      messages: [
        { role: "user", content: "use read tool" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking..." },
            { type: "tool_use", id: "toolu_abc", name: "read", input: { path: "/x" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_abc", content: "file data" },
          ],
        },
      ],
    });

    const assistantMsg = messages.find((m: any) => m.role === "assistant" && m.tool_calls);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.tool_calls[0].id).toBe("toolu_abc");

    const toolMsg = messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe("toolu_abc");
  });

  test("parallel tool calls: pairs multiple results by id", () => {
    const { messages } = provider.cleanMessages({
      model: "cbc-deepseek-v4-flash",
      messages: [
        { role: "user", content: "run both" },
        {
          role: "assistant",
          content: "sure",
          tool_calls: [
            { id: "call_x", type: "function", function: { name: "read", arguments: '{"a":1}' } },
            { id: "call_y", type: "function", function: { name: "ls", arguments: '{"b":2}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_y", content: "dir listing" },
        { role: "tool", tool_call_id: "call_x", content: "file a" },
      ],
    });

    const toolMsgs = messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    // order doesn't matter, ids are preserved
    expect(toolMsgs.find((m: any) => m.tool_call_id === "call_x")!.content).toBe("file a");
    expect(toolMsgs.find((m: any) => m.tool_call_id === "call_y")!.content).toBe("dir listing");
  });
});

import { decodeJwtPayload } from "../../src/api/accounts";

describe("decodeJwtPayload (CodeBuddy CN Keycloak JWT)", () => {
  // Real JWT token from codebuddy.cn Keycloak — payload only (no signature check)
  const token = "eyJhbGciOiJSUzI1NiIsInR5cCIgOiAiSldUIiwia2lkIiA6ICJteWZFenA3ODNLaV9KQ3g4Vm5jM1hfaXg2alpyYjZDZjVPTWtHWk1QSTNzIn0.eyJleHAiOjE3OTE1NTg1NDksImlhdCI6MTc4NjM3NDU0OSwiYXV0aF90aW1lIjoxNzg2Mzc0NTQ1LCJqdGkiOiI1MWIyNzk4NC0zNzZhLTRiZGQtYWFhZi0yYzViZTEwMGNkMjciLCJpc3MiOiJodHRwczovL3d3dy5jb2RlYnVkZHkuY24vYXV0aC9yZWFsbXMvY29waWxvdCIsImF1ZCI6ImFjY291bnQiLCJzdWIiOiIxYTIzYjBkNy1lNDBiLTQwMTEtYmJkNy1mMzFiN2Y3NzA2MDciLCJ0eXAiOiJCZWFyZXIiLCJhenAiOiJjb25zb2xlIiwic2lkIjoiNmJhYjkzZjctZWQ2OC00NDJhLWI4OTktZDg4YmI3NjYyZjY1IiwiYWNyIjoiMCIsImFsbG93ZWQtb3JpZ2lucyI6WyIqIl0sInJlYWxtX2FjY2VzcyI6eyJyb2xlcyI6WyJkZWZhdWx0LXJvbGVzIiwib2ZmbGluZV9hY2Nlc3MiLCJ1bWFfYXV0aG9yaXphdGlvbiJdfSwicmVzb3VyY2VfYWNjZXNzIjp7ImFjY291bnQiOnsicm9sZXMiOlsibWFuYWdlLWFjY291bnQiLCJtYW5hZ2UtYWNjb3VudC1saW5rcyIsInZpZXctcHJvZmlsZSJdfX0sInNjb3BlIjoib3BlbmlkIHByb2ZpbGUgb2ZmbGluZV9hY2Nlc3MgZW1haWwiLCJlbWFpbF92ZXJpZmllZCI6ZmFsc2UsInByZWZlcnJlZF91c2VybmFtZSI6IjcwOTMwNjQ5In0.abc123";

  test("decodes Keycloak JWT payload", () => {
    const claims = decodeJwtPayload(token);
    expect(claims.sub).toBe("1a23b0d7-e40b-4011-bbd7-f31b7f770607");
    expect(claims.iss).toBe("https://www.codebuddy.cn/auth/realms/copilot");
    expect(claims.preferred_username).toBe("70930649");
    expect(claims.email_verified).toBe(false);
    expect(claims.aud).toBe("account");
    // No email in this JWT — email_verified:false, no "email" claim
    expect(claims.email).toBeUndefined();
  });
});