import { API_BASE, fetchApi, getApiKey } from "./api";

/**
 * Model Studio client: session CRUD + SSE chat streaming.
 *
 * The chat endpoint dispatches through the same `handleChatCompletion` as
 * POST /v1/chat/completions, so a playground turn is real pool traffic — same
 * sanitization, compression, sticky routing, retry and logging.
 */

export interface StudioUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  source: "provider" | "estimated";
}

export interface StudioMessage {
  role: "system" | "user" | "assistant";
  content: string;
  ts: string;
  reasoning?: string;
  usage?: StudioUsage;
}

export interface StudioSession {
  id: string;
  title: string;
  model: string;
  systemPrompt: string;
  messages: StudioMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface StudioSessionSummary {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudioModelOption {
  id: string;
  owned_by: string;
  thinking: boolean;
  vision: boolean;
}

// ---- sessions ---------------------------------------------------------------
export function listStudioSessions(): Promise<{ data: StudioSessionSummary[] }> {
  return fetchApi("/api/model-studio/sessions");
}

export function getStudioSession(id: string): Promise<{ data: StudioSession }> {
  return fetchApi(`/api/model-studio/sessions/${encodeURIComponent(id)}`);
}

export function createStudioSession(input: {
  title?: string;
  model?: string;
  systemPrompt?: string;
}): Promise<{ data: StudioSession }> {
  return fetchApi("/api/model-studio/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateStudioSession(
  id: string,
  input: { title?: string; model?: string; systemPrompt?: string; messages?: StudioMessage[] }
): Promise<{ data: StudioSession }> {
  return fetchApi(`/api/model-studio/sessions/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function deleteStudioSession(id: string): Promise<{ ok: boolean }> {
  return fetchApi(`/api/model-studio/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fetchStudioModels(): Promise<{ data: StudioModelOption[] }> {
  return fetchApi("/api/model-studio/models");
}

// ---- streaming chat ---------------------------------------------------------
export interface ChatStreamDelta {
  onText: (chunk: string) => void;
  onReasoning: (chunk: string) => void;
  onUsage: (usage: StudioUsage) => void;
  onFirstToken: (ms: number) => void;
}

interface ChatUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function studioUsageFromChatUsage(usage: ChatUsagePayload): StudioUsage {
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
    source: "provider",
  };
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string; text?: string; reasoning_content?: string; reasoning?: string };
  }>;
  output_text?: string;
  usage?: ChatUsagePayload;
}

/**
 * Frames are separated by blank lines and may carry CRLF terminators (the codex
 * provider emits both). Splitting on /\r?\n\r?\n/ handles either, and the
 * trailing partial frame is held back in `buffer` until the next read.
 */
export async function streamModelStudioChat(
  payload: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string;
    reasoningSummary?: string;
  },
  delta: ChatStreamDelta,
  signal: AbortSignal
): Promise<void> {
  const startTime = performance.now();
  let firstTokenRecorded = false;
  const recordFirstToken = () => {
    if (firstTokenRecorded) return;
    firstTokenRecorded = true;
    delta.onFirstToken(performance.now() - startTime);
  };

  function processFrame(frame: string): void {
    const dataLines = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) return;
    const data = dataLines.map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return;

    let parsed: StreamChunk;
    try {
      parsed = JSON.parse(data) as StreamChunk;
    } catch {
      // A partial/malformed frame is not fatal; the next frame completes it.
      return;
    }

    const choiceDelta = parsed.choices?.[0]?.delta;
    const text = choiceDelta?.content ?? choiceDelta?.text ?? parsed.output_text;
    const reasoning = choiceDelta?.reasoning_content ?? choiceDelta?.reasoning;

    if (text) {
      recordFirstToken();
      delta.onText(text);
    }
    if (reasoning) {
      recordFirstToken();
      delta.onReasoning(reasoning);
    }
    if (parsed.usage) delta.onUsage(studioUsageFromChatUsage(parsed.usage));
  }

  const res = await fetch(`${API_BASE}/api/model-studio/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = `request failed (${res.status})`;
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      if (errBody.error?.message) message = errBody.error.message;
    } catch {
      // Keep the generic HTTP failure when the response is not JSON.
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) processFrame(frame);
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) processFrame(buffer);
  } catch (err) {
    // An abort is the caller stopping the turn; whatever streamed so far was
    // already delivered through the callbacks, so resolve quietly.
    if (signal.aborted || (err as Error).name === "AbortError") return;
    throw err;
  }
}
