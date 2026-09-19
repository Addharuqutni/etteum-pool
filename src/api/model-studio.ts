/**
 *
 * The chat endpoint dispatches through `handleChatCompletion`, the *same*
 * function POST /v1/chat/completions uses. That means a playground request
 * gets the identical treatment as real client traffic: model-alias + combo
 * resolution, pudidil sanitization, the compression pipeline, sticky routing,
 * account retry/cooldown, request logging, quota decrement and usage summary.
 * No second dispatch path exists — the playground cannot drift from /v1/*.
 *
 * Sessions are in-memory and bounded (count, per-field and total-byte caps,
 * 24h TTL, oldest-first eviction). Single-instance state, reset on restart —
 * same tradeoff as cooldown/sticky/alert stores elsewhere in this repo.
 *   ponytail: in-memory sessions, persist to a table if multi-instance arrives
 */
import { Hono, type Context } from "hono";
import { handleChatCompletion, normalizeModelId, openAIErrorResponse } from "../proxy/index";
import { isBadUpstreamRequest, isInvalidModelError } from "../proxy/errors";
import { getAllModels, providers } from "../proxy/router";
import { getCombosCached } from "../proxy/combos";
import { ensureByokModelsFresh } from "../proxy/providers/registry";
import { pool } from "../proxy/pool";
import type { ChatCompletionRequest } from "../proxy/providers/base";

export const modelStudioRouter = new Hono();

export type StudioRole = "system" | "user" | "assistant";

export interface StudioUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  source: "provider" | "estimated";
}

export interface StudioMessage {
  role: StudioRole;
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

// ---- bounds -----------------------------------------------------------------
const MAX_SESSIONS = 64;
const MAX_MESSAGES = 200;
const MAX_TITLE_CHARS = 200;
const MAX_MODEL_CHARS = 200;
const MAX_SYSTEM_PROMPT_CHARS = 32_000;
const MAX_CONTENT_CHARS = 128_000;
const MAX_REASONING_CHARS = 128_000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
// Ceiling for the whole studio store. A runaway loop that appends to a
// session forever is bounded by MAX_MESSAGES, so this is a backstop for the
// 64-session envelope, not the expected steady state.
//   ponytail: 96MB flat cap, shard by console user if the store ever contends
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;

const encoder = new TextEncoder();

function now(): string {
  return new Date().toISOString();
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function boundedText(value: string, maximum: number): string {
  return value.length > maximum ? value.slice(0, maximum) : value;
}

function isStudioRole(value: unknown): value is StudioRole {
  return value === "system" || value === "user" || value === "assistant";
}

/** Validates + bounds a message coming off the wire. */
function boundStudioMessage(value: unknown): StudioMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (!isStudioRole(message.role) || typeof message.content !== "string") return null;
  const ts = typeof message.ts === "string" ? message.ts : now();
  const out: StudioMessage = { role: message.role, content: boundedText(message.content, MAX_CONTENT_CHARS), ts };
  if (typeof message.reasoning === "string" && message.reasoning.length > 0) {
    out.reasoning = boundedText(message.reasoning, MAX_REASONING_CHARS);
  }
  if (typeof message.usage === "object" && message.usage !== null) {
    const usage = message.usage as Record<string, unknown>;
    const inputTokens = Number(usage.inputTokens) || 0;
    const outputTokens = Number(usage.outputTokens) || 0;
    out.usage = {
      inputTokens,
      outputTokens,
      reasoningTokens: Number(usage.reasoningTokens) || 0,
      cachedTokens: Number(usage.cachedTokens) || 0,
      totalTokens: Number(usage.totalTokens) || inputTokens + outputTokens,
      source: usage.source === "estimated" ? "estimated" : "provider",
    };
  }
  return out;
}

/** Normalizes a persisted/inline message array; rejects malformed input. */
function normalizeStudioMessages(value: unknown): StudioMessage[] | null {
  if (!Array.isArray(value)) return null;
  const out: StudioMessage[] = [];
  for (const item of value) {
    const message = boundStudioMessage(item);
    if (message === null) return null;
    out.push(message);
  }
  return out.slice(-MAX_MESSAGES);
}

// ---- session store ----------------------------------------------------------
const sessions = new Map<string, StudioSession>();
const sessionBytes = new Map<string, number>();
let totalSessionBytes = 0;

function measureSession(session: StudioSession): number {
  let total = utf8Bytes(session.id) + utf8Bytes(session.title) + utf8Bytes(session.model) + utf8Bytes(session.systemPrompt);
  for (const message of session.messages) {
    total += utf8Bytes(message.content) + utf8Bytes(message.reasoning ?? "");
  }
  return total;
}

function removeSession(id: string): void {
  const existing = sessions.get(id);
  if (existing === undefined) return;
  sessions.delete(id);
  const bytes = sessionBytes.get(id) ?? 0;
  sessionBytes.delete(id);
  totalSessionBytes -= bytes;
}

function evictExpired(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (Date.parse(session.updatedAt) < cutoff) removeSession(id);
  }
}

function oldestSessionId(): string | null {
  let oldest: string | null = null;
  let oldestAt = Infinity;
  for (const [id, session] of sessions) {
    const at = Date.parse(session.updatedAt);
    if (at < oldestAt) {
      oldestAt = at;
      oldest = id;
    }
  }
  return oldest;
}

/** Returns false when the store is full and nothing could be freed. */
function storeSession(session: StudioSession): boolean {
  evictExpired();
  const bytes = measureSession(session);
  const previous = sessionBytes.get(session.id) ?? 0;
  // Evict oldest sessions until both the count and the byte cap hold. The
  // incoming session is measured against the cap *minus* its own previous
  // footprint so a growing session can't evict itself in a loop.
  while (
    (sessions.size >= MAX_SESSIONS || totalSessionBytes - previous + bytes > MAX_TOTAL_BYTES) &&
    sessions.size > 0
  ) {
    const victim = oldestSessionId();
    if (victim === null || victim === session.id) break;
    removeSession(victim);
  }
  if (sessions.size >= MAX_SESSIONS) return false;
  sessions.set(session.id, session);
  sessionBytes.set(session.id, bytes);
  totalSessionBytes += bytes - previous;
  return true;
}

function summary(session: StudioSession): StudioSessionSummary {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/** Lists studio sessions, newest update first. */
export function listStudioSessions(): StudioSessionSummary[] {
  evictExpired();
  return [...sessions.values()].map(summary).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** Reads one studio session. */
export function getStudioSession(id: string): StudioSession | null {
  const session = sessions.get(id);
  return session === undefined ? null : session;
}

/** Creates a studio session without contacting a provider. */
export function createStudioSession(input: {
  title?: string;
  model?: string;
  systemPrompt?: string;
}): StudioSession {
  evictExpired();
  const session: StudioSession = {
    id: crypto.randomUUID(),
    title: boundedText((input.title ?? "").trim() || "New chat", MAX_TITLE_CHARS),
    model: boundedText((input.model ?? "").trim(), MAX_MODEL_CHARS),
    systemPrompt: boundedText(input.systemPrompt ?? "", MAX_SYSTEM_PROMPT_CHARS),
    messages: [],
    createdAt: now(),
    updatedAt: now(),
  };
  storeSession(session);
  return session;
}

/** Updates session metadata and/or messages. */
export function patchStudioSession(
  id: string,
  input: { title?: string; model?: string; systemPrompt?: string; messages?: StudioMessage[] }
): StudioSession | null {
  evictExpired();
  const existing = sessions.get(id);
  if (existing === undefined) return null;
  const updated: StudioSession = {
    ...existing,
    title: boundedText((input.title ?? "").trim() || existing.title, MAX_TITLE_CHARS),
    model: boundedText((input.model ?? existing.model).trim(), MAX_MODEL_CHARS),
    systemPrompt: boundedText(input.systemPrompt ?? existing.systemPrompt, MAX_SYSTEM_PROMPT_CHARS),
    messages: input.messages === undefined ? existing.messages : input.messages.slice(-MAX_MESSAGES),
    updatedAt: now(),
  };
  // Store under the previous footprint so a growing session measures correctly.
  if (!storeSession(updated)) return existing;
  return updated;
}

/** Deletes one studio session. */
export function deleteStudioSession(id: string): boolean {
  if (!sessions.has(id)) return false;
  removeSession(id);
  return true;
}

// ---- models -----------------------------------------------------------------
modelStudioRouter.get("/models", async (c) => {
  // BYOK prefixes are claimed from a TTL'd cache; refresh (cheap when warm) so
  // the picker lists a BYOK model from the first load instead of next tick.
  await ensureByokModelsFresh();
  const models = getAllModels().map((m) => ({
    id: m.id,
    owned_by: m.owned_by,
    thinking: Boolean(m.thinking),
    vision: Boolean(m.vision),
  }));
  const combos = getCombosCached().map((combo) => ({
    id: combo.name,
    owned_by: "combo",
    thinking: false,
    vision: false,
  }));
  return c.json({ data: [...models, ...combos] });
});

// ---- sessions ---------------------------------------------------------------
modelStudioRouter.get("/sessions", (c) => {
  return c.json({ data: listStudioSessions() });
});

modelStudioRouter.get("/sessions/:id", (c) => {
  const session = getStudioSession(c.req.param("id"));
  if (session === null) return c.json({ error: { message: "session not found" } }, 404);
  return c.json({ data: session });
});

modelStudioRouter.post("/sessions", async (c) => {
  const value = await readJsonObject(c);
  const session = createStudioSession({
    title: typeof value.title === "string" ? value.title : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : undefined,
  });
  return c.json({ data: session }, 201);
});

modelStudioRouter.put("/sessions/:id", async (c) => {
  const value = await readJsonObject(c);
  const messages = value.messages === undefined ? undefined : normalizeStudioMessages(value.messages);
  if (value.messages !== undefined && messages === null) {
    return c.json({ error: { message: "messages must be a valid array" } }, 400);
  }
  const session = patchStudioSession(c.req.param("id"), {
    title: typeof value.title === "string" ? value.title : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : undefined,
    messages: messages ?? undefined,
  });
  if (session === null) return c.json({ error: { message: "session not found" } }, 404);
  return c.json({ data: session });
});

modelStudioRouter.delete("/sessions/:id", (c) => {
  if (!deleteStudioSession(c.req.param("id"))) {
    return c.json({ error: { message: "session not found" } }, 404);
  }
  return c.json({ ok: true });
});

modelStudioRouter.delete("/sessions", (c) => {
  for (const id of [...sessions.keys()]) removeSession(id);
  return c.json({ ok: true });
});

// ---- chat -------------------------------------------------------------------
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const REASONING_SUMMARIES = new Set(["auto", "detailed", "none"]);
// ponytail: fixed effort→budget ladder, expose per-model tuning if a model rejects a tier
const EFFORT_BUDGET: Record<string, number> = {
  minimal: 1024,
  low: 4096,
  medium: 10000,
  high: 24000,
  xhigh: 28672,
  max: 32000,
};
const DEFAULT_MAX_TOKENS = 8192;
const MAX_MAX_TOKENS = 65536;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clampMaxTokens(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(1, Math.floor(n)));
}

function clampTemperature(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(2, Math.max(0, n));
}

/**
 * Shapes reasoning fields for the provider that will ultimately serve the
 * model. Resolved here (not in the provider) because the studio request is
 * built before routing picks an account.
 *
 * Every reasoning-capable provider reads `reasoning_effort` from the request
 * (codex also derives its visible-summary flag from it), so that field alone
 * is enough — the generic branch deliberately does NOT synthesize a `thinking`
 * object, since forcing `thinking: {type:"enabled"}` on a model that does not
 * reason can make the upstream reject the request. Claude is the exception:
 * claude.ts passes `thinking` through verbatim, so it needs a wire-valid
 * object with budget_tokens < max_tokens.
 * Unknown ids (e.g. a combo, whose target is resolved later in routing) are
 * treated as capable so an effort choice still reaches the resolved provider.
 */
function buildReasoning(
  model: string,
  effort: string | undefined,
  summary: string | undefined,
  maxTokens: number
): Pick<ChatCompletionRequest, "reasoning_effort" | "thinking"> | undefined {
  if (!effort) return undefined;
  const info = getAllModels().find((m) => m.id === model);
  if (info && !info.thinking) return undefined;
  if (pool.getProviderForModel(model) === "claude") {
    // Anthropic rejects budget_tokens >= max_tokens; clamp with a 1k floor.
    const thinking: ChatCompletionRequest["thinking"] = { type: "enabled", budget_tokens: Math.max(1024, Math.min(EFFORT_BUDGET[effort] ?? 10000, maxTokens - 1024)) };
    if (summary) thinking.summary = summary;
    return { reasoning_effort: effort, thinking };
  }
  return { reasoning_effort: effort };
}

modelStudioRouter.post("/chat", async (c) => {
  let value: Record<string, unknown>;
  try {
    const body = await c.req.json();
    value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && /json|parse/i.test(error.message))) {
      return c.json(openAIErrorResponse("Invalid JSON request body", 400), 400);
    }
    throw error;
  }

  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!model) {
    return c.json(
      { error: { message: "model is required", type: "invalid_request_error", code: "invalid_model" } },
      400
    );
  }

  if (value.messages === undefined || !Array.isArray(value.messages) || value.messages.length === 0) {
    return c.json(
      { error: { message: "messages is required and must be a non-empty array", type: "invalid_request_error", code: "invalid_messages" } },
      400
    );
  }
  const messages = normalizeStudioMessages(value.messages);
  if (messages === null) {
    return c.json(
      { error: { message: "messages must be a valid array", type: "invalid_request_error", code: "invalid_messages" } },
      400
    );
  }

  const systemPrompt = typeof value.systemPrompt === "string" ? boundedText(value.systemPrompt, MAX_SYSTEM_PROMPT_CHARS) : "";
  const stream = value.stream !== false;
  const maxTokens = clampMaxTokens(value.maxTokens);
  const temperature = clampTemperature(value.temperature);
  const effort = typeof value.reasoningEffort === "string" && REASONING_EFFORTS.has(value.reasoningEffort) ? value.reasoningEffort : undefined;
  const reasoningSummary = typeof value.reasoningSummary === "string" && REASONING_SUMMARIES.has(value.reasoningSummary) ? value.reasoningSummary : undefined;

  const normalizedModel = normalizeModelId(model);
  const reasoning = buildReasoning(normalizedModel, effort, reasoningSummary, maxTokens);

  // Identical input shape to POST /v1/chat/completions: the system prompt is
  // folded into messages here, and any system role inside `messages` is
  // dropped so a resumed session can't smuggle a second system turn in.
  const request: ChatCompletionRequest = {
    model: normalizedModel,
    messages: [
      ...(systemPrompt.trim() ? [{ role: "system" as const, content: systemPrompt }] : []),
      ...messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content })),
    ],
    stream,
    max_tokens: maxTokens,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(reasoning ?? {}),
  };

  try {
    // Same dispatch function as /v1/chat/completions — no parallel pipeline.
    const { result } = await handleChatCompletion(request, undefined, undefined);

    if (stream && result.stream) {
      return new Response(result.stream, { headers: SSE_HEADERS });
    }
    return c.json(result.response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const invalid = isInvalidModelError(errorMessage);
    const badUpstream = isBadUpstreamRequest(errorMessage);
    const status = invalid || badUpstream ? 400 : 503;
    return c.json(
      {
        error: {
          type: invalid || badUpstream ? "invalid_request_error" : "api_error",
          message: errorMessage,
        },
      },
      status
    );
  }
});

// Re-exported so the studio module is the only import surface the dashboard
// API needs; matches how router.ts re-exports the provider registry.
export { providers };
