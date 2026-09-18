/**
 * Helpers shared by the Responses-API providers (Codex, Grok CLI).
 *
 * Both speak the same wire format: a flat `{type, name, description, parameters}`
 * tool shape plus the `response.*` SSE event stream. Anything that genuinely
 * differs between the two hosts belongs in the provider file, not here.
 */

/** The flat tool shape the Responses API expects. */
export interface ResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
}

/**
 * Normalise Anthropic- or OpenAI-shaped tools into the flat Responses shape.
 *
 * `emptySchema` is the fallback applied when a tool declares no parameters —
 * Codex sends a valid empty object schema, Grok CLI sends `{}`.
 */
export function normalizeResponsesTools(
  tools: unknown[] | undefined,
  emptySchema: unknown
): ResponsesTool[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];

  const out: ResponsesTool[] = [];
  for (const tool of tools) {
    const entry = tool as Record<string, any>;
    if (entry?.type === "function" && entry.function?.name) {
      out.push({
        type: "function",
        name: entry.function.name,
        description: entry.function.description || "",
        parameters: entry.function.parameters || emptySchema,
      });
      continue;
    }
    if (entry?.name) {
      out.push({
        type: "function",
        name: entry.name,
        description: entry.description || "",
        parameters: entry.input_schema || entry.parameters || emptySchema,
      });
    }
  }
  return out;
}

/**
 * Normalise `tool_choice` into the flat Responses shape. Shared by Codex and
 * Grok CLI, which accept the same `{type: "function", name}` form.
 */
export function normalizeResponsesToolChoice(toolChoice: unknown): unknown {
  if (toolChoice == null) return "auto";
  if (typeof toolChoice === "string") return toolChoice;

  const choice = toolChoice as Record<string, any>;
  if (choice.type === "function" && choice.function?.name) {
    return { type: "function", name: choice.function.name };
  }
  if (choice.type === "tool" && choice.name) {
    return { type: "function", name: choice.name };
  }
  return toolChoice;
}

/** A tool call accumulated from `response.function_call_arguments.*` events. */
export interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/**
 * Read completed `function_call` items out of a `response.completed` payload,
 * keyed by their output index.
 */
export function collectCompletedToolCalls(
  response: any,
  byIndex: Map<number, PendingToolCall>
): void {
  for (const [index, item] of (response?.output || []).entries()) {
    if (item?.type !== "function_call") continue;
    byIndex.set(index, {
      index,
      id: item.call_id || item.id || `call_${index}`,
      name: item.name || "",
      arguments: item.arguments || "",
    });
  }
}

/** Convert accumulated tool calls into the OpenAI `tool_calls` array shape. */
export function toolCallsFromMap(byIndex: Map<number, PendingToolCall>) {
  return [...byIndex.values()]
    .filter((call) => call.name)
    .sort((a, b) => a.index - b.index)
    .map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments || "{}" },
    }));
}
