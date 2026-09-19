import { Hono } from "hono";
import { routeRequest, getAllModels, providers } from "./router";
import { db } from "../db/index";
import { requestLogs, usageSummary, accounts, type NewRequestLog } from "../db/schema";
import { pool } from "./pool";
import { broadcast } from "../ws/index";
import type { ChatCompletionRequest, CreditSource } from "./providers/base";
import {
  anthropicToOpenAI,
  openAIStreamToAnthropic,
  openAIToAnthropic,
  type AnthropicMessagesRequest,
} from "./transforms/anthropic";
import { getSseError, getSseErrorFromParsed, isBadUpstreamRequest, isContentModerationError, isInvalidModelError } from "./errors";
import { buildStreamLogSummary, prepareLogBody, getCachedRequestLogRetentionConfig } from "./logging";
import { checkAcl, recordUsage, releaseApiKey, type ApiKeyRow } from "../services/api-keys";
import { resolveModelAlias } from "./model-mapping";
import { resolveCombo, resolveComboByTarget, getCombosCached } from "./combos";
import { eq, sql } from "drizzle-orm";
import { providerList, ensureByokModelsFresh } from "./providers/registry";
import { config } from "../config";

export const proxyRouter = new Hono<{ Variables: { apiKey?: ApiKeyRow; apiKeyId?: number; apiKeyInflightToken?: number } }>();

/**
 * Prune request_logs according to the runtime `request_log_*` settings.
 *
 * `request_log_max_records` (0 = unlimited) keeps only the newest N rows;
 * `request_log_retention_days` (0 = keep forever) drops rows older than N days.
 * `created_at` is an INTEGER unix-seconds column (see db/schema.ts), while the
 * sibling usage_summary.bucket is ISO text — compare seconds here.
 */
export async function pruneRequestLogs() {
  const { maxRecords, retentionDays } = getCachedRequestLogRetentionConfig();
  try {
    if (retentionDays > 0) {
      const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86_400;
      await db.run(sql`DELETE FROM request_logs WHERE created_at < ${cutoff}`);
    }
    if (maxRecords > 0) {
      await db.run(sql`
        DELETE FROM request_logs WHERE id NOT IN (
          SELECT id FROM request_logs ORDER BY created_at DESC LIMIT ${maxRecords}
        )
      `);
    }
  } catch (err) {
    console.error("[Proxy] Failed to prune request_logs:", err);
  }
}

/** Upsert a request's stats into the usage_summary table (hourly bucket) */
async function upsertUsageSummary(entry: {
  provider: string;
  model: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  creditsUsed: number;
  durationMs: number;
}) {
  try {
    const bucket = new Date();
    bucket.setMinutes(0, 0, 0); // truncate to hour

    await db.run(sql`
      INSERT INTO usage_summary (bucket, provider, model, total_requests, success_requests, error_requests, prompt_tokens, completion_tokens, total_tokens, credits_used, total_duration_ms)
      VALUES (${bucket.toISOString()}, ${entry.provider || "unknown"}, ${entry.model || "unknown"}, 1,
        ${entry.status === "success" ? 1 : 0}, ${entry.status === "error" ? 1 : 0},
        ${entry.promptTokens || 0}, ${entry.completionTokens || 0}, ${entry.totalTokens || 0},
        ${entry.creditsUsed || 0}, ${entry.durationMs || 0})
      ON CONFLICT (bucket, provider, model) DO UPDATE SET
        total_requests = usage_summary.total_requests + excluded.total_requests,
        success_requests = usage_summary.success_requests + excluded.success_requests,
        error_requests = usage_summary.error_requests + excluded.error_requests,
        prompt_tokens = usage_summary.prompt_tokens + excluded.prompt_tokens,
        completion_tokens = usage_summary.completion_tokens + excluded.completion_tokens,
        total_tokens = usage_summary.total_tokens + excluded.total_tokens,
        credits_used = usage_summary.credits_used + excluded.credits_used,
        total_duration_ms = usage_summary.total_duration_ms + excluded.total_duration_ms
    `);
  } catch (err) {
    console.error("[Proxy] Failed to upsert usage_summary:", err);
  }
}

// Prune every 10 requests to avoid running DELETE on every single insert
let requestCounter = 0;

export async function recordRequest(entry: NewRequestLog) {
  try {
    await db.insert(requestLogs).values(entry);
    void upsertUsageSummary({
      provider: entry.provider || "unknown",
      model: entry.model || "unknown",
      status: entry.status,
      promptTokens: entry.promptTokens || 0,
      completionTokens: entry.completionTokens || 0,
      totalTokens: entry.totalTokens || 0,
      creditsUsed: entry.creditsUsed || 0,
      durationMs: entry.durationMs || 0,
    });
    if (++requestCounter % 10 === 0) void pruneRequestLogs();
    broadcast({
      type: "request_log",
      data: { ...entry, email: entry.accountEmail, createdAt: new Date().toISOString() },
    });
  } catch (err) {
    console.error("[Proxy] Failed to record request:", err);
  }
}

const NORMALIZE_ETTEUM_PREFIX = /^etteum\//i;
const NORMALIZE_CONTEXT_TAG = /\[[\d.]+[kKmM]\]$/;
const NORMALIZE_SONET_TYPO = /claude-sonet/gi;
/** Strip the assistant context tags + common typos before routing. */
export function normalizeModelId(model: string): string {
  // the assistant appends context-window tags (e.g. "[1m]", "[200k]") for auto-mode
  // classifier / long-context picks. Upstream BYOK providers (Grok, etc.) reject them.
  // Common typo: "sonet" -> "sonnet".
  return model
    .replace(NORMALIZE_ETTEUM_PREFIX, "") // integration configs prefix "etteum/"; combo names + pool ids are unprefixed
     .replace(NORMALIZE_CONTEXT_TAG, "")
     .replace(NORMALIZE_SONET_TYPO, "claude-sonnet");
 }


function computeCredits(
  provider: keyof typeof providers,
  model: string,
  totalTokens: number,
  resultCredits?: number,
  resultCreditSource?: CreditSource
) {
  // BYOK keys are user-paid — never charge internal credit or decrement quota.
  // Tokens still recorded; only the credit figure is zeroed.
  if (provider === "byok") {
    return { creditsUsed: 0, creditSource: "exempt" as CreditSource };
  }
  if (resultCredits !== undefined && resultCredits > 0) {
    return {
      creditsUsed: Math.max(0.01, resultCredits),
      creditSource: resultCreditSource || "upstream" as CreditSource,
    };
  }

  if (totalTokens > 0) {
    return {
      creditsUsed: Math.max(0.01, totalTokens * providers[provider].getProviderCreditRate(model)),
      creditSource: "estimated" as CreditSource,
    };
  }

  return {
    creditsUsed: 0,
    creditSource: resultCreditSource || "estimated" as CreditSource,
  };
}

/** Parse an SSE `data:` payload once; null when empty/[DONE]/not JSON. */
function parseSsePayload(payload: string): any | null {
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function extractUsageFromParsed(parsed: any) {
  const usage = parsed?.usage;
  return {
    promptTokens: Number(usage?.prompt_tokens || usage?.input_tokens || 0),
    completionTokens: Number(usage?.completion_tokens || usage?.output_tokens || 0),
    totalTokens: Number(usage?.total_tokens || 0),
    creditsUsed: Number(usage?.credits_used || usage?.creditsUsed || usage?.credit || parsed?.credits_used || parsed?.creditsUsed || 0),
  };
}

/**
 * Race a promise against a deadline, rejecting with `message` on timeout. The
 * abandoned read is left to settle on its own; the caller cancels its reader.
 * Real timers here are unavoidable: this bounds a genuinely pending upstream
 * read, so there is nothing to fake without also faking the network.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Extract streamed text content from an already-parsed SSE payload */
function extractContentFromParsed(parsed: any): string {
  const choice = parsed?.choices?.[0];
  return String(
    choice?.delta?.content ??
    choice?.message?.content ??
    choice?.text ??
    parsed?.delta?.content ??
    parsed?.content ??
    parsed?.text ??
    ""
  );
}
/** True when a parsed SSE payload carries tool calls (a real answer, no text). */
function hasToolCallsInParsed(parsed: any): boolean {
  const choice = parsed?.choices?.[0];
  const toolCalls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls ?? parsed?.tool_calls;
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateMessagesTokens(messages: ChatCompletionRequest["messages"]): number {
  return (messages || []).reduce((total, msg) => {
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = (msg.content as any[])
        .map((block) => {
          if (block?.type === "text" && typeof block.text === "string") return block.text;
          if (block?.type === "tool_result") {
            if (typeof block.content === "string") return block.content;
            if (Array.isArray(block.content)) {
              return block.content.map((b: any) => b?.text || "").join("");
            }
          }
          return JSON.stringify(block || "");
        })
        .join("");
    } else {
      content = JSON.stringify(msg.content || "");
    }
    return total + estimateTokensFromText(content) + 4;
  }, 0);
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError ||
    (error instanceof Error && /json|parse|unexpected end|unexpected token/i.test(error.message));
}

export function openAIErrorResponse(message: string, status: 400 | 503) {
  return {
    error: {
      message,
      type: status === 400 ? "invalid_request_error" : "server_error",
      code: status === 400 ? "invalid_json" : "proxy_error",
    },
  };
}

async function logProxyError(entry: NewRequestLog, label: string) {
  try {
    await db.insert(requestLogs).values(entry);
    // Also track errors in usage_summary
    void upsertUsageSummary({
      provider: entry.provider || "unknown", model: entry.model || "unknown", status: "error",
      promptTokens: 0, completionTokens: 0, totalTokens: 0, creditsUsed: 0, durationMs: entry.durationMs || 0,
    });
    if (++requestCounter % 10 === 0) void pruneRequestLogs();
  } catch (logError) {
    console.error(`[Proxy] Failed to log ${label}:`, logError);
  }
}

/**
 * Log an intermediate combo fallback failure (target failed, next target
 * attempted). The final failure of a combo is logged by the route's error
 * handler (last target wins), so every distinct failure lands exactly once.
 */
async function logComboFallbackError(
  body: ChatCompletionRequest,
  error: unknown,
  comboName: string,
  targetIndex: number,
  targetCount: number
) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const provider = pool.getProviderForModel(body.model) || "unknown";
  await logProxyError({
    provider,
    model: body.model,
    status: "error",
    errorMessage,
    requestBody: prepareLogBody({
      ...body,
      // body.model is the already-rewritten TARGET here, so it must not be used
      // as the combo identity. Record the combo name + the slot that failed so
      // intermediate fallback failures are attributable to the right chain.
      _poolprox: {
        originalModel: comboName,
        combo: comboName,
        comboFallbackFrom: body.model,
        comboFallbackIndex: targetIndex,
        comboFallbackRemaining: targetCount - targetIndex - 1,
      },
    }),
    responseBody: prepareLogBody({ error: errorMessage }),
    durationMs: 0,
  }, "combo fallback error");
}

/** Verdict for a 200 stream that delivered neither content nor tool calls. */
export const EMPTY_STREAM_MESSAGE = "Upstream stream delivered no data";

/**
 * Read the head of an upstream SSE stream to decide whether the request is
 * already a failure, so combo fallback can still fire. Returns the verdict plus
 * a replay stream that re-emits everything read here before continuing.
 *
 * The peek ends as soon as the upstream delivers content or a tool call, so a
 * healthy stream is only ever buffered by its preamble.
 */
export async function peekStreamForError(
  stream: ReadableStream<Uint8Array>
): Promise<{ error?: string; stream: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let buffer = "";
  let error: string | undefined;
  // Set once the upstream sends content OR tool calls, i.e. a real answer
  // began. A role-only delta is NOT an answer: providers synthesize one at EOF
  // for an upstream that delivered nothing, and counting it as success is
  // exactly what stalled the combo chain on a dead target.
  let answerStarted = false;
  // True only when the reader reported `done`, i.e. the body really ended.
  // Distinguishes "upstream delivered nothing" from "we stopped peeking early"
  // (byte cap), where the rest of the body is still unread.
  let streamEnded = false;
  // How long to wait for the FIRST byte before abandoning this target. Bounds
  // silent upstreams so the combo chain can move on; later reads are uncapped
  // because a stream that already started is delivering.
  const PEEK_FIRST_BYTE_MS = 20_000;
  // Cap peek accumulation: a slow/hostile upstream that never sends a
  // parseable content event could otherwise buffer megabytes of preview
  // bytes per concurrent request. 1 MB is plenty for real error/content
  // preambles; past that we assume no error and stream through.
  const PEEK_MAX_BYTES = 1 * 1024 * 1024;
  let peekedBytes = 0;

  try {
    while (!error && !answerStarted) {
      // First byte only: a silent upstream must not hold the request open
      // forever, since the combo chain cannot advance until this returns.
      const first = chunks.length === 0
        ? await withDeadline(reader.read(), PEEK_FIRST_BYTE_MS, "Upstream stream timed out before sending data")
        : await reader.read();
      const { done, value } = first;
      if (done) {
        streamEnded = true;
        break;
      }
      chunks.push(value);
      peekedBytes += value.byteLength;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);
        const trimmedPayload = payload.trim();
        // [DONE]/empty carry nothing: never count as an answer, never an error.
        if (!trimmedPayload || trimmedPayload === "[DONE]") continue;
        // First decision in event order wins: an error seen before content
        // enables fallback; once content starts, never fall back.
        const parsed = parseSsePayload(trimmedPayload);
        if (parsed) {
          if (!error) error = getSseErrorFromParsed(parsed) ?? undefined;
          if (extractContentFromParsed(parsed) || hasToolCallsInParsed(parsed)) answerStarted = true;
        }
        if (error || answerStarted) break;
      }
      if (peekedBytes > PEEK_MAX_BYTES) break;
    }
  } catch (readError) {
    // Upstream connection dropped mid-peek — an upstream failure, not a
    // content error. Propagate so the caller's combo fallback can run.
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
    throw readError;
  }

  // A 200 response that ends having delivered no content and no tool calls is
  // a FAILED target, not a successful empty answer. Treating it as success is
  // what made fallback order look broken: the chain stopped on the dead first
  // target while a healthy backup sat unused. Only claim emptiness at real EOF
  // — the byte cap is an early stop with bytes still unread.
  if (streamEnded && !answerStarted) error = EMPTY_STREAM_MESSAGE;

  if (error) {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
    return { error, stream };
  }

  // No pre-content error — replay the peeked chunks, then continue reading.
  let i = 0;
  return {
    stream: new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // `i` MUST advance: without the increment this loop re-enqueued the
          // same chunk forever — a synchronous loop with no await, so the event
          // loop never got a turn, the ReadableStream queue grew unbounded and
          // the process died (OOM / VM fault) on every stream that had peeked
          // at least one chunk.
          while (i < chunks.length) controller.enqueue(chunks[i++]!);
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (enqueueError) {
          controller.error(enqueueError);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } catch {
          // upstream already closed
        }
      },
    }),
  };
}

function wrapStreamWithUsageFinalizer(
  stream: ReadableStream<Uint8Array>,
  context: {
    logId?: number;
    accountId: number;
    accountEmail: string;
    provider: keyof typeof providers;
    model: string;
    quotaBefore: number;
    startedAt: number;
    apiKeyId?: number;
    apiKeyInflightToken?: number;
    fallbackPromptTokens: number;
    fallbackCompletionTokens: number;
    fallbackTotalTokens: number;
    fallbackCreditsUsed: number;
    fallbackCreditSource: CreditSource;
  }
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let reader: ReturnType<ReadableStream<Uint8Array>["getReader"]> | undefined;
  let buffer = "";
  const contentChunks: string[] = [];
  let retainedChars = 0;
  let streamedBytes = 0;
  let deliveredBytes = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let upstreamCredits = 0;
  let finalized = false;
  let streamError = false;

  const observe = (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);

      const trimmedPayload = payload.trim();
      const parsed = parseSsePayload(trimmedPayload);
      if (!parsed) continue;

      // Detect upstream errors in SSE stream (upstream_error body, OpenAI error format)
      if (getSseErrorFromParsed(parsed)) streamError = true;

      // Always extract content for estimation, even if no usage field.
      // Cap the retained text at 256KB: it is only used for token estimation,
      // and appending unbounded chunks would let one big stream eat unbounded
      // memory. Exact length still tracked via streamedBytes for the estimate.
      const content = extractContentFromParsed(parsed);
      if (content) {
        // streamedBytes accumulates wire bytes (raw chunk byteLength in the
        // reader loop below); do NOT add content.length here or the total
        // is roughly doubled and completion-token estimates are inflated.
        if (retainedChars < 256 * 1024) {
          contentChunks.push(content);
          retainedChars += content.length;
        }
      }

      const usage = extractUsageFromParsed(parsed);
      promptTokens = usage.promptTokens || promptTokens;
      completionTokens = usage.completionTokens || completionTokens;
      totalTokens = usage.totalTokens || totalTokens;
      upstreamCredits = usage.creditsUsed || upstreamCredits;
    }
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;

    const finalPromptTokens = promptTokens || context.fallbackPromptTokens;
    // Join once — used up to 3 times below, each join re-allocates the full
    // retained text (up to 256KB) and encoding again doubles the transient
    // allocation.
    const retainedText = contentChunks.join("");
    // When the 256KB retention cap was hit, retained chunks understate the
    // stream; fall back to the exact accumulated length for the estimate.
    const streamedEstimate = streamedBytes > retainedChars
      ? Math.max(1, Math.ceil(streamedBytes / 4))
      : estimateTokensFromText(retainedText);
    const finalCompletionTokens = completionTokens || streamedEstimate || context.fallbackCompletionTokens;
    const finalTotalTokens = totalTokens || finalPromptTokens + finalCompletionTokens || context.fallbackTotalTokens;
    const { creditsUsed, creditSource } = computeCredits(
      context.provider,
      context.model,
      finalTotalTokens,
      upstreamCredits || context.fallbackCreditsUsed,
      upstreamCredits > 0 ? "upstream" : context.fallbackCreditSource
    );
    const durationMs = Math.max(0, Date.now() - context.startedAt);

    void (async () => {
      try {
        // If stream had upstream error (403 rate limit, etc) or delivered zero
        // bytes (client saw a blank response), log error — don't decrement quota.
        const emptyStream = !streamError && deliveredBytes === 0;
        if (streamError || emptyStream) {
          // Still update request log with error status
          if (context.logId) {
            const streamErrorMessage = emptyStream
              ? "Upstream stream delivered no data"
              : "Upstream rate limit or quota exceeded";
            await db
              .update(requestLogs)
              .set({
                status: "error",
                errorMessage: streamErrorMessage,
                responseBody: prepareLogBody({ error: streamErrorMessage }),
                durationMs,
              })
              .where(eq(requestLogs.id, context.logId));
          }
          return;
        }

        // Decrement at stream finalization (token-based).
        let quotaAfter = context.quotaBefore;
        if (context.quotaBefore > 0) {
          quotaAfter = await pool.decrementQuota(context.accountId, creditsUsed);
        }

        if (context.logId) {
          await db
            .update(requestLogs)
            .set({
              promptTokens: finalPromptTokens,
              completionTokens: finalCompletionTokens,
              totalTokens: finalTotalTokens,
              creditsUsed,
              durationMs,
              accountQuotaAfter: quotaAfter,
              responseBody: prepareLogBody(buildStreamLogSummary({
                model: context.model,
                content: retainedText,
                contentBytes: new TextEncoder().encode(retainedText).byteLength,
                promptTokens: finalPromptTokens,
                completionTokens: finalCompletionTokens,
                totalTokens: finalTotalTokens,
                creditSource,
              })),
            })
            .where(eq(requestLogs.id, context.logId));
        }

        broadcast({
          type: "request_log",
          data: {
            id: context.logId,
            accountId: context.accountId,
            accountEmail: context.accountEmail,
            email: context.accountEmail,
            provider: context.provider,
            model: context.model,
            promptTokens: finalPromptTokens,
            completionTokens: finalCompletionTokens,
            totalTokens: finalTotalTokens,
            creditsUsed,
            status: "success",
            durationMs,
            accountQuotaBefore: context.quotaBefore,
            accountQuotaAfter: quotaAfter,
            createdAt: new Date(context.startedAt).toISOString(),
            requestBody: prepareLogBody({
              model: context.model,
              stream: true,
              _poolprox: {
                creditSource,
                creditUnit: providers[context.provider].getProviderCreditUnit(context.model),
                creditRate: providers[context.provider].getProviderCreditRate(context.model),
              },
            }),
          },
        });

        // Upsert to usage_summary + periodic prune
        void upsertUsageSummary({
          provider: context.provider, model: context.model, status: "success",
          promptTokens: finalPromptTokens, completionTokens: finalCompletionTokens,
          totalTokens: finalTotalTokens, creditsUsed, durationMs,
        });
        // Per-API-key usage recording (monthly + lifetime counters)
        if (context.apiKeyId) void recordUsage(context.apiKeyId, finalTotalTokens);
        if (++requestCounter % 10 === 0) void pruneRequestLogs();
      } catch (error) {
        console.error("[Proxy] Failed to finalize stream usage:", error);
      } finally {
        pool.trackRequestEnd(context.accountId);
        // Release the API-key inflight slot the middleware skipped for SSE.
        // Without this, every streaming request leaks an entry in the
        // `inflight` Map forever — the middleware's comment promised the
        // finalizer would release it, but the call was missing.
        if (context.apiKeyId !== undefined) {
          releaseApiKey(context.apiKeyId, context.apiKeyInflightToken);
        }
      }
    })();
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const streamReader = stream.getReader();
      reader = streamReader;
      try {
        while (true) {
          const { done, value } = await streamReader.read();
          if (done) break;
          observe(value);
          // Stream byte cap — abort oversized upstream streams (memory guard).
          streamedBytes += value.byteLength;
          if (streamedBytes > config.maxStreamBytes) {
            controller.error(new Error("Upstream stream exceeded size limit"));
            return;
          }
          controller.enqueue(value);
          deliveredBytes += value.byteLength;
        }
      } catch (error) {
        controller.error(error);
        return;
      } finally {
        try {
          controller.close();
        } catch {
          // The stream may already be closed/cancelled by the client.
        }
        finalize();
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        finalize();
      }
    },
  });
}

/**
 * Record WHICH combo target was actually attempted on the error the route
 * re-throws, so error logs and the WS broadcast name the failed target rather
 * than the last configured one.
 *
 * `attempted` is a 1-based count of targets that reached the provider, so the
 * offending target is combo[attempted - 1]; 0 means every target was skipped
 * (no provider owned any), in which case the legacy
 * "last configured target" choice is kept.
 */
function attachAttemptedTarget(error: unknown, comboName: unknown, attempted: number): unknown {
  if (!error || typeof error !== "object") return error;
  if (typeof comboName !== "string" || !Number.isInteger(attempted) || attempted < 1) return error;
  (error as { comboAttempted?: number; comboName?: string }).comboAttempted = attempted;
  (error as { comboAttempted?: number; comboName?: string }).comboName = comboName;
  return error;
}

/** Read back the attempted-target metadata attached by attachAttemptedTarget. */
function readAttemptedTarget(error: unknown): { comboName: string; attempted: number } | null {
  if (!error || typeof error !== "object") return null;
  const meta = error as { comboAttempted?: unknown; comboName?: unknown };
  if (typeof meta.comboName !== "string" || !Number.isInteger(meta.comboAttempted)) return null;
  return { comboName: meta.comboName, attempted: meta.comboAttempted as number };
}

/**
 * Combo identity for error logging. Mirrors the precedence in
 * handleChatCompletion — exact/alias combo NAME first, then a raw target id
 * promoted off the reverse index — because this runs in the route's error
 * handler against the ORIGINAL body.model, which may be either.
 *
 * Without the reverse-index leg, a promoted raw id resolved to null here and
 * the failure logged with no combo metadata at all (and mapped to the raw
 * model rather than the target that actually failed).
 */
function resolveComboForLog(
  model: string
): { targets: string[]; comboName: string } | null {
  const byName = resolveCombo(model);
  if (byName) return { targets: byName, comboName: model };
  const byTarget = resolveComboByTarget(normalizeModelId(model));
  if (byTarget) return { targets: byTarget.targets, comboName: byTarget.name };
  return null;
}

export async function handleChatCompletion(body: ChatCompletionRequest, apiKey?: ApiKeyRow, apiKeyInflightToken?: number) {
  // Resolve combos FIRST: an exact combo name wins over model aliasing. The
  // combo loop tries each target in order, falling back to the next on failure.
  // (routeRequest still retries accounts within a provider; this adds the
  // cross-model fallback on top. router.ts is untouched.)
  //
  // ALIAS -> COMBO hop: an exact combo name still wins, but a mapping whose
  // targetModel is a COMBO NAME must reach that combo. resolveCombo() ran on
  // the raw id, so such a mapping fell through to the single-model path and
  // the router threw `No provider found for model: <comboName>`. Bounded to 2
  // hops: resolveModelAlias() is single-pass and non-recursive, so a rule that
  // maps back to its own source is a fixed point (and the combo name is not a
  // real model, so a longer chain cannot form).
  let comboName = resolveCombo(body.model);
  // Name of the combo the chain came from, when the client sent a RAW target
  // id instead. Differs from body.model only in that case, and is what every
  // log/error must attribute to so the promotion is visible.
  let promotedCombo: string | null = null;
  // Index into targets[] where the chain starts. 0 unless a raw id matched a
  // DEEP slot, in which case earlier targets are deliberately skipped.
  let startIndex = 0;
  if (!comboName) {
    let candidate = body.model;
    for (let hop = 0; hop < 2; hop++) {
      const aliased = resolveModelAlias(normalizeModelId(candidate));
      if (aliased === candidate) break;
      candidate = aliased;
      comboName = resolveCombo(candidate);
      if (comboName) break;
    }
  }
  // RAW TARGET ID -> COMBO: clients often send a concrete upstream id
  // ("bansos-glm-5.3") instead of the combo NAME that advertises it. That id
  // is not a combo name, so both checks above miss and the request fell
  // through to the single-attempt path below with no fallback at all — the
  // "fallback order still fails" bug. Promote it onto its owning combo and
  // start at the slot it occupies. A combo NAME always wins: this only runs
  // when no name matched.
  if (!comboName) {
    const byTarget = resolveComboByTarget(normalizeModelId(body.model));
    if (byTarget) {
      comboName = byTarget.targets;
      promotedCombo = byTarget.name;
      startIndex = byTarget.startIndex;
    }
  }
  if (comboName) {
    // Attribution identity: the combo NAME. For a promoted raw id that is the
    // owning combo, not body.model, so logs show which chain actually ran.
    // Identical to body.model in every other case.
    const comboLabel = promotedCombo ?? body.model;
    // BYOK prefixes are claimed synchronously from a TTL'd cache. Refresh it
    // (cheap when warm) before the loop so ownsModel() can resolve BYOK targets
    // from the first attempt instead of routing them to "No provider found".
    await ensureByokModelsFresh();

    let lastError: unknown = null;
    // Skip reason for a target no provider owns. Kept SEPARATE from lastError:
    // assigning it to lastError let a later skip clobber the real upstream
    // error from an earlier attempted target, so a 429 surfaced as
    // "No provider found for model: <mistyyped entry>".
    let skipReason: unknown = null;
    let attempted = 0;
    // 1-based index into the FULL targets[] of the last target actually
    // attempted. Distinct from `attempted` (a COUNT) because a promoted deep
    // slot starts mid-array: count 1 must map back to targets[startIndex],
    // or the route would log the failure against the wrong target.
    let lastAttemptIndex = 0;
    // Begin AT the promoted slot; configured order is preserved for the rest.
    for (let i = startIndex; i < comboName.length; i++) {
      // Expand an alias SOURCE before the provider gate. A combo whose target
      // is an alias source ("haiku-alias") matched no provider, so the gate
      // logged "matches no provider — skipping" and silently dropped the
      // configured primary. resolveModelAlias() is single-pass and
      // non-recursive, so a fixed point leaves the id unchanged — one hop is
      // enough here, and a genuinely bogus id still hits the skip path below.
      const target = resolveModelAlias(normalizeModelId(comboName[i]!));
      const attemptBody: ChatCompletionRequest = { ...body, model: target };

      // A target no provider owns can never succeed, and its failure says
      // nothing about upstream health. Skip it without spending a fallback slot
      // so a stale/mistyped entry doesn't mask a healthy target behind it.
      if (!pool.getProviderForModel(target)) {
        console.warn(
          `[Combo] "${comboLabel}" target [${i}] "${target}" matches no provider — skipping`
        );
        skipReason ??= new Error(`No provider found for model: ${target}`);
        continue;
      }

      attempted++;
      lastAttemptIndex = i + 1;
      try {
        return await handleChatCompletionSingle(attemptBody, { originalModel: body.model, combo: comboLabel }, apiKey, apiKeyInflightToken);
      } catch (error) {
        // Deciding whether to abort the chain on a "permanent" error depends on
        // WHAT the verdict describes, because each combo target is a different
        // model id sent to a (usually) different account/upstream.
        //
        // Moderation and malformed-request verdicts describe the REQUEST BODY,
        // which is byte-identical for every target — they will recur, so stop.
        // A model verdict describes ONE target's model id instead: an upstream
        // rejecting "alpha-glm-5.3" says nothing about whether "beta-glm-5.3"
        // exists, and upstreams routinely embed that phrase in a 400 body for
        // unrelated reasons. Classifying it chain-wide aborted the chain on
        // target 1 and never reached the healthy targets behind it.
        const message = error instanceof Error ? error.message : String(error);
        if (isContentModerationError(message) || isBadUpstreamRequest(message)) {
          throw attachAttemptedTarget(error, comboLabel, i + 1);
        }
        if (i < comboName.length - 1) {
          await logComboFallbackError(attemptBody, error, comboLabel, i, comboName.length);
        }
        lastError = error;
      }
    }
    // Surface a routing-shaped error when no target was even attemptable, so
    // the route maps it to 400 rather than a misleading 503 upstream failure.
    // The common cause is a target whose BYOK prefix is gone/disabled, or a
    // model id that no provider catalog contains.
    if (attempted === 0) {
      // Nothing was attempted, so lastError can only hold a skip reason.
      const detail = skipReason instanceof Error ? skipReason.message : String(skipReason ?? "no targets");
      // Phrase includes "model not supported" so isInvalidModelError() maps this
      // to a 400 invalid_request_error: a combo whose targets are all
      // unresolvable is a configuration fault, not an upstream failure.
      throw new Error(
        `Combo "${comboLabel}" has no resolvable target models — model not supported: ${detail}`
      );
    }
    // Attach which target was ACTUALLY attempted. The route re-resolves the
    // combo on failure and used only comboFailed[length-1], so aborting on
    // target 1 of 3 was logged and broadcast as the LAST CONFIGURED target
    // (gamma) instead of the one that failed (alpha).
    //
    // The INDEX is into the full targets[], not the count of attempts: a chain
    // promoted at slot 2 attempts targets[2] first, so that failure belongs to
    // index 3, not 1.
    throw attachAttemptedTarget(lastError, comboLabel, lastAttemptIndex);
  }

  // No combo: existing alias rewrite + single route path, unchanged.
  body = { ...body, model: resolveModelAlias(normalizeModelId(body.model)) };
  return handleChatCompletionSingle(body, undefined, apiKey, apiKeyInflightToken);
}

async function handleChatCompletionSingle(
  body: ChatCompletionRequest,
  comboMeta: { originalModel: string; combo: string } | undefined,
  apiKey?: ApiKeyRow,
  apiKeyInflightToken?: number
) {
  // ACL: provider/model allow/deny per API key — uses the row resolved by the
  // auth middleware, no re-fetch.
  if (apiKey) {
    const providerForAcl = pool.getProviderForModel(body.model);
    const acl = await checkAcl(apiKey, { provider: providerForAcl ?? undefined, model: body.model });
    if (!acl.allowed) {
      throw new Error(acl.reason || "Not allowed");
    }
  }
  const apiKeyId = apiKey?.id;
  const isStream = body.stream === true;
  const { result, account, provider, durationMs, compressionStats } = await routeRequest(body, isStream);
  let shouldReleaseTracking = true;

  try {
    // Detect upstream errors BEFORE returning the stream so combo fallback can
    // still fire. Once valid content has started, pass through untouched.
    // BYOK is included: its failures arrive as HTTP status codes, but a BYOK
    // stream can still deliver nothing at all, which must not read as success.
    if (isStream && result.stream) {
      const peek = await peekStreamForError(result.stream);
      if (peek.error) throw new Error(peek.error);
      result.stream = peek.stream;
    }

    const promptTokens = result.promptTokens || result.response?.usage?.prompt_tokens || estimateMessagesTokens(body.messages);
    const completionTokens = result.completionTokens || result.response?.usage?.completion_tokens || 0;
    const totalTokens = result.tokensUsed || result.response?.usage?.total_tokens || promptTokens + completionTokens;

    const { creditsUsed, creditSource } = computeCredits(
      provider,
      body.model,
      totalTokens,
      result.creditsUsed,
      result.creditSource
    );

    const quotaBefore = Number(account.quotaRemaining || 0);

    // For non-stream paths, decrement immediately. Stream paths decrement at
    // finalization (in wrapStreamWithUsageFinalizer).
    let quotaAfter = quotaBefore;
    if (!isStream && quotaBefore > 0) {
      quotaAfter = await pool.decrementQuota(account.id, creditsUsed);
    }

  const logEntry = {
    accountId: account.id,
    accountEmail: account.email,
    provider,
    model: body.model,
    promptTokens,
    completionTokens,
    totalTokens,
    creditsUsed,
    status: "success" as const,
    durationMs,
    requestBody: prepareLogBody({
      ...body,
      _poolprox: {
        creditSource,
        creditUnit: providers[provider].getProviderCreditUnit(body.model),
        creditRate: providers[provider].getProviderCreditRate(body.model),
        ...(comboMeta ? { originalModel: comboMeta.originalModel, combo: comboMeta.combo } : {}),
      },
    }),
    responseBody: prepareLogBody(result.response),
    accountQuotaBefore: quotaBefore,
    accountQuotaAfter: quotaAfter,
    compressionStats: compressionStats ?? null,
  };

    if (isStream && result.stream) {
      const [created] = await db.insert(requestLogs).values(logEntry).returning();
      const createdAt = created?.createdAt?.toISOString?.() || new Date().toISOString();

    broadcast({
      type: "request_started",
      data: { ...logEntry, id: created?.id, email: account.email, createdAt },
    });

    result.stream = wrapStreamWithUsageFinalizer(result.stream, {
      logId: created?.id,
      accountId: account.id,
      accountEmail: account.email,
      apiKeyId,
      apiKeyInflightToken,
      provider,
      model: body.model,
      quotaBefore,
      startedAt: Date.now() - durationMs,
      fallbackPromptTokens: promptTokens,
      fallbackCompletionTokens: completionTokens,
      fallbackTotalTokens: totalTokens,
      fallbackCreditsUsed: creditsUsed,
      fallbackCreditSource: creditSource,
    });

      shouldReleaseTracking = false;
      return { result, isStream };
    }

  await db.insert(requestLogs).values(logEntry);

  // Per-API-key usage recording (monthly + lifetime counters)
  if (apiKeyId) void recordUsage(apiKeyId, totalTokens);

  // Upsert to usage_summary + periodic prune
  void upsertUsageSummary({
    provider, model: body.model, status: "success",
    promptTokens, completionTokens, totalTokens, creditsUsed, durationMs,
  });
  if (++requestCounter % 10 === 0) void pruneRequestLogs();

  broadcast({
    type: "request_log",
    data: { ...logEntry, email: account.email, createdAt: new Date().toISOString() },
  });

    return { result, isStream };
  } finally {
    if (shouldReleaseTracking) pool.trackRequestEnd(account.id);
  }
}

/**
 * GET /v1/models - List available models
 */
proxyRouter.get("/v1/models", async (c) => {
  // Ensure BYOK cache is fresh before listing models (stale check only, no
  // forced reload — CRUD paths force-refresh via refreshByokModels()).
  await ensureByokModelsFresh();
  const models = getAllModels();
  // Merge combos as synthetic model entries after the real models so clients
  // can discover and request the virtual combo names.
  const comboEntries = getCombosCached().map((combo) => ({
    id: combo.name,
    object: "model" as const,
    created: Math.floor(new Date(combo.createdAt).getTime() / 1000),
    owned_by: "combo",
  }));
  return c.json({
    object: "list",
    data: [...models, ...comboEntries],
  });
});

/**
 * POST /v1/chat/completions - Chat completion (streaming + non-streaming)
 */
proxyRouter.post("/v1/chat/completions", async (c) => {
  let body: ChatCompletionRequest;
  try {
    body = await c.req.json<ChatCompletionRequest>();
  } catch (error) {
    if (isJsonParseError(error)) {
      return c.json(openAIErrorResponse("Invalid JSON request body", 400), 400);
    }
    throw error;
  }

  // Validate request
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json(
      {
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      },
      400
    );
  }

  if (!body.model) {
    return c.json(
      {
        error: {
          message: "model is required",
          type: "invalid_request_error",
          code: "invalid_model",
        },
      },
      400
    );
  }

  body.model = normalizeModelId(body.model);
  const isStream = body.stream === true;
  const apiKey = c.get("apiKey") as ApiKeyRow | undefined;
  const apiKeyInflightToken = c.get("apiKeyInflightToken") as number | undefined;

  try {
    const { result } = await handleChatCompletion(body, apiKey, apiKeyInflightToken);

    if (isStream && result.stream) {
      // Return SSE stream
      return new Response(result.stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // Return JSON response
    return c.json(result.response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // When body.model was a combo, attribute the failure to the target that
    const attemptedMeta = readAttemptedTarget(error);
    const comboFailed = resolveComboForLog(body.model);
    const mappedModel = comboFailed
      ? (attemptedMeta && attemptedMeta.attempted >= 1
          ? comboFailed.targets[attemptedMeta.attempted - 1] ??
            comboFailed.targets[comboFailed.targets.length - 1]!
          : comboFailed.targets[comboFailed.targets.length - 1]!)
      : resolveModelAlias(normalizeModelId(body.model));

    // Log the error without masking the original proxy failure.
    const provider = pool.getProviderForModel(mappedModel) || "unknown";
    await logProxyError({
      provider,
      model: mappedModel,
      status: "error",
      errorMessage,
      requestBody: prepareLogBody({
        ...body,
        model: mappedModel,
        _poolprox: { originalModel: body.model, ...(comboFailed ? { combo: comboFailed.comboName } : {}) },
      }),
      responseBody: prepareLogBody({ error: errorMessage }),
      durationMs: 0,
    }, "chat completion error");

    broadcast({
      type: "request_error",
      data: { model: mappedModel, error: errorMessage },
    });

    const invalidModel = isInvalidModelError(errorMessage);
    const badUpstreamRequest = isBadUpstreamRequest(errorMessage);

    return c.json(
      {
        error: {
          message: errorMessage,
          type: invalidModel || badUpstreamRequest ? "invalid_request_error" : "server_error",
          code: invalidModel ? "invalid_model" : badUpstreamRequest ? "invalid_request" : "proxy_error",
        },
      },
      invalidModel || badUpstreamRequest ? 400 : 503
    );
  }
});

/**
 * POST /v1/messages - Anthropic Messages-compatible endpoint
 */
proxyRouter.post("/v1/messages", async (c) => {
  let body: AnthropicMessagesRequest;
  try {
    body = await c.req.json<AnthropicMessagesRequest>();
  } catch (error) {
    if (isJsonParseError(error)) {
      return c.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON request body" } }, 400);
    }
    throw error;
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "messages is required and must be a non-empty array" } }, 400);
  }

  if (!body.model) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "model is required" } }, 400);
  }

  body.model = normalizeModelId(body.model);
  const openAIRequest = anthropicToOpenAI(body);
  const apiKey = c.get("apiKey") as ApiKeyRow | undefined;
  const apiKeyInflightToken = c.get("apiKeyInflightToken") as number | undefined;

  try {
    const { result } = await handleChatCompletion(openAIRequest, apiKey, apiKeyInflightToken);

    if (body.stream === true && result.stream) {
      return new Response(openAIStreamToAnthropic(result.stream, body), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    return c.json(openAIToAnthropic(result.response, body));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Same attribution rule as /v1/chat/completions: name the ATTEMPTED
    // target, not the last configured one.
    const attemptedMeta = readAttemptedTarget(error);
    const comboFailed = resolveComboForLog(body.model);
    const mappedModel = comboFailed
      ? (attemptedMeta && attemptedMeta.attempted >= 1
          ? comboFailed.targets[attemptedMeta.attempted - 1] ??
            comboFailed.targets[comboFailed.targets.length - 1]!
          : comboFailed.targets[comboFailed.targets.length - 1]!)
      : resolveModelAlias(normalizeModelId(body.model));
    const provider = pool.getProviderForModel(mappedModel) || "unknown";
    await logProxyError({
      provider,
      model: mappedModel,
      status: "error",
      errorMessage,
      requestBody: prepareLogBody({
        ...body,
        model: mappedModel,
        _poolprox: { originalModel: body.model, ...(comboFailed ? { combo: comboFailed.comboName } : {}) },
      }),
      responseBody: prepareLogBody({ error: errorMessage }),
      durationMs: 0,
    }, "messages error");

    broadcast({ type: "request_error", data: { model: mappedModel, error: errorMessage } });

    const invalidModel = isInvalidModelError(errorMessage);
    const badUpstreamRequest = isBadUpstreamRequest(errorMessage);
    return c.json({
      type: "error",
      error: {
        type: invalidModel || badUpstreamRequest ? "invalid_request_error" : "api_error",
        message: errorMessage,
      },
    }, invalidModel || badUpstreamRequest ? 400 : 503);
  }
});
