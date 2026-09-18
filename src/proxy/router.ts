import type { ChatCompletionRequest, ProviderResult } from "./providers/base";
import { providers, getAllModels, type ProviderName } from "./providers/registry";
import { isNonAccountRequestError, isTransientError } from "./errors";
import { applyPudidilFilters } from "./filters";
import { pool } from "./pool";
import type { Account } from "../db/schema";
import {
  compressRequest,
  getCompressionConfig,
  type CompressionStats,
} from "./compression";
import { scanPonytailMarkers } from "./compression/ponytail";
import { stickyStore, computeStickyKey } from "./sticky";

export interface RouteResult {
  result: ProviderResult;
  account: Account;
  provider: ProviderName;
  durationMs: number;
  compressionStats?: CompressionStats;
}

/** Check if a request contains image content blocks */
function requestHasImages(request: ChatCompletionRequest): boolean {
  return request.messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return (msg.content as any[]).some(
      (block) => block?.type === "image_url" || block?.type === "image"
    );
  });
}

/**
 * Sanitize request by applying pudidil filters to all text content.
 * Strips Claude Code identity, billing headers, and other patterns
 * that trigger content moderation on upstream providers.
 */
function sanitizeRequest(request: ChatCompletionRequest): ChatCompletionRequest {
  const sanitized = { ...request };

  sanitized.messages = request.messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { ...msg, content: applyPudidilFilters(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: (msg.content as any[]).map((block) => {
          if (block?.type === "text" && typeof block.text === "string") {
            return { ...block, text: applyPudidilFilters(block.text) };
          }
          if (block?.type === "tool_result") {
            if (typeof block.content === "string") {
              return { ...block, content: applyPudidilFilters(block.content) };
            }
            if (Array.isArray(block.content)) {
              return {
                ...block,
                content: block.content.map((inner: any) =>
                  inner?.type === "text" && typeof inner.text === "string"
                    ? { ...inner, text: applyPudidilFilters(inner.text) }
                    : inner
                ),
              };
            }
          }
          return block;
        }),
      };
    }
    return msg;
  });

  if (sanitized.tools) {
    sanitized.tools = request.tools!.map((tool: any) => {
      if (tool?.function?.description) {
        return {
          ...tool,
          function: {
            ...tool.function,
            description: applyPudidilFilters(tool.function.description),
          },
        };
      }
      return tool;
    });
  }

  return sanitized;
}

/**
 * Route a chat completion request to the appropriate provider/account.
 * Implements retry logic with fallback to next account.
 */
export async function routeRequest(
  request: ChatCompletionRequest,
  stream: boolean
): Promise<RouteResult> {
  // Apply content filters to strip Claude Code identity, billing headers, etc.
  const sanitizedRequest = sanitizeRequest(request);

  const hasImages = requestHasImages(sanitizedRequest);
  const providerName = pool.getProviderForModel(sanitizedRequest.model);
  if (!providerName) {
    throw new Error(`No provider found for model: ${sanitizedRequest.model}`);
  }

  // Apply compression pipeline (RTK + DCP + Caveman + image dedupe + cache markers).
  // Failures here are non-fatal — fall back to the sanitized request and move on.
  let compressedRequest = sanitizedRequest;
  let compressionStats: CompressionStats | undefined;
  // Whether to strip `ponytail:` markers from the response we return. Read from
  // the same config as the pipeline; stays false if compression fails to load.
  let stripMarkersFromOutput = false;
  try {
    const cfg = await getCompressionConfig();
    const out = compressRequest(sanitizedRequest, cfg, providerName);
    compressedRequest = out.request;
    compressionStats = out.stats;
    stripMarkersFromOutput = cfg.ponytail?.stripMarkersFromOutput ?? false;
  } catch (err) {
    console.error("[Compression] Failed, passing request through unchanged:", err);
  }

  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Provider not configured: ${providerName}`);
  }

  // Reject image requests for models that don't support vision
  if (hasImages) {
    const modelInfo = provider.getModelInfo(sanitizedRequest.model);
    if (modelInfo && !modelInfo.vision) {
      throw new Error(
        `Model "${sanitizedRequest.model}" does not support image/vision inputs. Use a vision-capable model instead.`
      );
    }
  }

  let lastError = "";
  const attemptedAccountIds = new Set<number>();

  // Cache-affine sticky routing: when the request carries a stable session
  // anchor (model + user/first-message), prefer the account that served the
  // previous turn so provider prompt caches hit. BYOK uses prefix-based
  // lookup and is deliberately excluded.
  const stickyKey =
    providerName !== "byok" ? computeStickyKey(sanitizedRequest.model, sanitizedRequest) : null;

  for (let attempt = 0; ; attempt++) {
    let account: Account | null = null;
    if (attempt === 0 && stickyKey) {
      const stickyAccountId = stickyStore.get(stickyKey, providerName);
      if (stickyAccountId !== null && !attemptedAccountIds.has(stickyAccountId)) {
        account = await pool.getStickyAccount(providerName, stickyAccountId);
      }
    }
    if (!account) {
      // BYOK uses prefix-based account lookup (not the generic pool),
      // so it can also find error-status accounts and retry them.
      account = providerName === "byok"
        ? (await pool.getAccountForModel(compressedRequest.model, {
             excludeAccountIds: attemptedAccountIds,
           }))?.account ?? null
        : await pool.getNextAccount(providerName, attemptedAccountIds);
    }
    if (!account) {
      if (attemptedAccountIds.size > 0) break;
      // Build a descriptive reason so the client knows WHY no account is
      // available (no accounts vs all exhausted vs all disabled vs all error).
      let reason = "no active account available";
      try {
        const stats = await pool.getStatsByProvider(providerName);
        if (stats.total === 0) {
          reason = "no accounts configured for this provider";
        } else if (stats.active === 0) {
          const parts: string[] = [];
          if (stats.exhausted > 0) parts.push(`${stats.exhausted} exhausted`);
          if (stats.error > 0) parts.push(`${stats.error} in error state`);
          if (stats.disabled > 0) parts.push(`${stats.disabled} disabled`);
          if (stats.pending > 0) parts.push(`${stats.pending} pending`);
          reason = parts.length > 0
            ? `all accounts unavailable (${parts.join(", ")})`
            : `no active account available (total: ${stats.total})`;
        } else {
          reason = `no active account available (total: ${stats.total}, active: ${stats.active})`;
        }
      } catch {
        // Stats query failed — fall back to generic message.
      }
      throw new Error(
        `No active accounts available for provider "${providerName}": ${reason}`
      );
    }
    attemptedAccountIds.add(account.id);

    const startTime = Date.now();
    let tracked = false;

    try {
      pool.trackRequestStart(account.id);
      tracked = true;
      const result = stream
        ? await provider.chatCompletionStream(account, compressedRequest)
        : await provider.chatCompletion(account, compressedRequest);

      const durationMs = Date.now() - startTime;

      if (result.success) {
        // If provider refreshed tokens internally, persist them to database
        if (result.tokens) {
          await pool.updateTokens(account.id, result.tokens);
        }
        await pool.markUsed(account.id);
        // Success clears any 429 cooldown and (re)pins this account to the
        // conversation so follow-up turns hit the same provider prompt cache.
        pool.clearRateLimitCooldown(account.id);
        if (stickyKey) stickyStore.set(stickyKey, account.id, providerName);
        // Scan response for ponytail: markers (output compression telemetry).
        // `stripMarkersFromOutput` decides whether the markers are also removed
        // from the body we return to the client (they always stay in telemetry).
        const ponytailScan = scanPonytailMarkers(
          result.response,
          stripMarkersFromOutput
        );
        if (compressionStats && ponytailScan.markers.length > 0) {
          compressionStats.ponytail = {
            inputOverhead: compressionStats.byTechnique.ponytail ?? 0,
            outputMarkers: ponytailScan.markers.length,
            markerHits: ponytailScan.markers,
          };
          if (ponytailScan.strippedResponse) {
            result.response = ponytailScan.strippedResponse as ProviderResult["response"];
          }
        }
        return { result, account, provider: providerName, durationMs, compressionStats };
      }

      pool.trackRequestEnd(account.id);
      tracked = false;

      // Client-side model errors should not poison accounts. A wrong model ID
      // is a bad request, not an account/session failure, so stop retrying and
      // let the API layer return an invalid_model response.
      if (isNonAccountRequestError(result.error)) {
        throw new Error(result.error || `Invalid model: ${compressedRequest.model}`);
      }

      // Handle rate limiting (429) — temporary, don't mark exhausted. The
      // graduated in-memory cooldown (30s→5min ladder) applies so repeated
      // 429s back off instead of hammering the same account.
      if (result.rateLimited) {
        pool.markRateLimited(account.id);
        if (stickyKey) stickyStore.delete(stickyKey);
        lastError = result.error || "Rate limited";
        continue; // Try next account without poisoning this one
      }

      // Handle quota exhaustion (402 / 403 without PAYG).
      //
      // Trust upstream: if the provider reports quota exhausted, mark it
      // and move on; the next warmup tick re-checks and flips the account
      // back to active if the provider reports remaining > 0 again. We
      // accept the occasional false-exhaust (lifted within one warmup
      // cycle) in exchange for never serving a known-bad account on retry.
      if (result.quotaExhausted) {
        await pool.markExhausted(account.id);
        if (stickyKey) stickyStore.delete(stickyKey);
        lastError = result.error || "Quota exhausted";
        continue; // Try next account
      }

      // Handle token refresh
      if (
        result.error?.includes("expired") ||
        result.error?.includes("401")
      ) {
        const refreshResult = await provider.refreshToken(account);
        if (refreshResult.success && refreshResult.tokens) {
          // Parse tokens string to store as jsonb
          let parsedTokens: unknown;
          try {
            parsedTokens = JSON.parse(refreshResult.tokens);
          } catch {
            parsedTokens = refreshResult.tokens;
          }
          await pool.updateTokens(account.id, parsedTokens);
          // Retry with same account after refresh
          pool.trackRequestStart(account.id);
          tracked = true;
          const retryResult = stream
            ? await provider.chatCompletionStream(account, compressedRequest)
            : await provider.chatCompletion(account, compressedRequest);

          if (retryResult.success) {
        void pool.markUsed(account.id);
            pool.clearRateLimitCooldown(account.id);
            if (stickyKey) stickyStore.set(stickyKey, account.id, providerName);
            // Scan retry response for ponytail: markers.
            const ponytailScan = scanPonytailMarkers(
              retryResult.response,
              stripMarkersFromOutput
            );
            if (compressionStats && ponytailScan.markers.length > 0) {
              compressionStats.ponytail = {
                inputOverhead: compressionStats.byTechnique.ponytail ?? 0,
                outputMarkers: ponytailScan.markers.length,
                markerHits: ponytailScan.markers,
              };
              if (ponytailScan.strippedResponse) {
                retryResult.response = ponytailScan.strippedResponse as ProviderResult["response"];
              }
            }
            return {
              result: retryResult,
              account,
              provider: providerName,
              durationMs: Date.now() - startTime,
              compressionStats,
            };
          }
          pool.trackRequestEnd(account.id);
          tracked = false;
        }
        await pool.markTransientFailure(account.id, result.error || "Auth failed");
        lastError = result.error || "Auth failed";
        continue;
      }

      // Generic error - check if transient (network/timeout) or permanent
      if (isTransientError(result.error || "")) {
        await pool.markTransientFailure(account.id, result.error || "Transient error");
      } else {
        await pool.markError(account.id, result.error || "Unknown error");
      }
      lastError = result.error || "Unknown error";
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      if (tracked) {
        pool.trackRequestEnd(account.id);
        tracked = false;
      }
      if (isNonAccountRequestError(errMsg)) {
        throw error;
      }
      if (errMsg.includes("expired") || errMsg.includes("401")) {
        await pool.markTransientFailure(account.id, errMsg);
      } else if (isTransientError(errMsg)) {
        await pool.markTransientFailure(account.id, errMsg);
      } else {
        await pool.markError(account.id, errMsg);
        if (stickyKey) stickyStore.delete(stickyKey);
      }
      lastError = errMsg;
    }
  }

  throw new Error(
    `All account attempt(s) failed for provider "${providerName}". Last error: ${lastError}`
  );
}

// Re-exported from the provider registry (single source of truth). Kept as
// named exports here so existing import sites (proxy/index.ts, api/stats.ts,
// auth/runner.ts, api/image-studio.ts, auth/warmup-runner.ts) stay unchanged.
export { providers, getAllModels, type ProviderName };
