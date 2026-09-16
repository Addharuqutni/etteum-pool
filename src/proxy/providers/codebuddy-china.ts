import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
  type StreamChunk,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import { runSseStreamLoop } from "../stream-utils";
import { codebuddyDomain } from "./codebuddy";

interface CodeBuddyChinaTokens {
  api_key?: string;
  access_token?: string;
  session_token?: string;
  refresh_token?: string;
  expires_at?: string;
}

/**
 * CodeBuddy China OAuth refresh — same contract as global codebuddy (workbuddy.ai)
 * (POST /v2/plugin/auth/token/refresh, refresh token in X-Refresh-Token header,
 * body "{}") but against www.codebuddy.cn with its own X-Domain.
 * 401/403 on refresh → refresh token dead → re-login.
 */
export async function refreshCodebuddyChinaToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: string;
}> {
  const response = await fetch("https://www.codebuddy.cn/v2/plugin/auth/token/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "CLI/2.148.0 CodeBuddy/2.148.0",
      "X-Requested-With": "XMLHttpRequest",
      "X-Domain": "www.codebuddy.cn",
      "X-Refresh-Token": refreshToken,
      "X-Auth-Refresh-Source": "plugin",
      "X-Product": "SaaS",
    },
    body: "{}",
    // Same gap as the global provider's refresh: bare fetch with no deadline.
    // Reuse the quota-probe budget (15s) — a short control-plane POST.
    signal: AbortSignal.timeout(config.providerQuotaTimeoutMs),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("Refresh token expired or revoked — re-login required");
  }
  if (!response.ok) {
    throw new Error(`CodeBuddy China token refresh failed (HTTP ${response.status})`);
  }

  const data = (await response.json()) as any;
  if (data?.code !== 0 || !data?.data?.accessToken) {
    throw new Error(`CodeBuddy China token refresh error: ${data?.msg || data?.message || "unknown"}`);
  }

  const d = data.data;
  const expiresIn = Number(d.expiresIn) || 86400;
  return {
    access_token: d.accessToken,
    refresh_token: d.refreshToken || refreshToken,
    expires_at: String(Math.floor(Date.now() / 1000) + expiresIn),
  };
}

// Live-verified 2026-09-14 (chat stream, system-first): everything here answers
// 200 on www.codebuddy.cn. Removed: cbc-haiku-4.5, cbc-kimi-k2.7-code,
// cbc-glm-4.7 (never listed), cbc-glm-5.0 (all 11102 "service info not found").
const CBC_MODEL_MAP: Record<string, string> = {
  // DeepSeek
  "cbc-deepseek-r1": "deepseek-r1",
  "cbc-deepseek-v3": "deepseek-v3",
  "cbc-deepseek-v3-2-volc": "deepseek-v3-2-volc",
  "cbc-deepseek-v4-flash": "deepseek-v4-flash",
  "cbc-deepseek-v4.1-flash": "deepseek-v4.1-flash",
  "cbc-deepseek-v4-pro": "deepseek-v4-pro",
  // Kimi (Moonshot)
  "cbc-kimi-k2.5": "kimi-k2.5",
  "cbc-kimi-k2.6": "kimi-k2.6",
  "cbc-kimi-k2.7": "kimi-k2.7",
  "cbc-kimi-k3": "kimi-k3",
  "cbc-kimi-k3-1": "kimi-k3-1",
  // GLM (Zhipu)
  "cbc-glm-5.0-turbo": "glm-5.0-turbo",
  "cbc-glm-5.1": "glm-5.1",
  "cbc-glm-5.2": "glm-5.2",
  "cbc-glm-5.3": "glm-5.3",
  "cbc-glm-5.3-flash": "glm-5.3-flash",
  "cbc-glm-5v-turbo": "glm-5v-turbo",
  // MiniMax
  "cbc-minimax-m2.7": "minimax-m2.7",
  "cbc-minimax-m3": "minimax-m3",
  // Hunyuan (Tencent)
  "cbc-hy3": "hy3",
  "cbc-hy3-preview": "hy3-preview",
  "cbc-hy4-preview": "hy4-preview",
};


/**
 * Candidate API hosts in failover order. Both serve the identical /v2 API with
 * the same credentials, so a host-level outage (DNS/TLS/5xx) is recoverable by
 * replaying the request against the other one. Order matters: index 0 is the CN
 * host the account was provisioned against, and is what every non-failover path
 * (token refresh, billing) must keep using.
 */
export const CODEBUDDY_CHINA_BASE_URLS = [
  "https://www.codebuddy.cn",
  "https://www.workbuddy.ai",
] as const;

export const CODEBUDDY_CHINA_PRIMARY_BASE_URL: string = CODEBUDDY_CHINA_BASE_URLS[0];

/** Host-scoped upstream failures: the peer host may still serve this account fine. */
export function shouldFailoverStatus(status: number): boolean {
  return status >= 500 || status === 404 || status === 405;
}

/**
 * CodeBuddy China Provider — www.codebuddy.cn (CN) region
 *
 * Same API format as CodeBuddy global (workbuddy.ai) but:
 * - Base URL: https://www.codebuddy.cn
 * - Auth: Bearer API key (ck_* prefix)
 * - Streaming only (non-stream returns error 11101)
 * - China-specific models (GLM, Kimi, DeepSeek V4, Hunyuan, MiniMax)
 * - Credit tracking via usage.credit in stream chunks
 */
export class CodeBuddyChinaProvider extends BaseProvider {
  name = "codebuddy-china";

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("cbc-");
  }

  private resolveModel(model: string): string {
    const base = model.toLowerCase();
    return CBC_MODEL_MAP[base] || base;
  }

  private isKimiK3(resolved: string): boolean {
    return resolved === "kimi-k3";
  }

  /** Kimi K3 rejects public http(s) image URLs — only data: and ms://. */
  private isAllowedKimiVisionUrl(url: string): boolean {
    return url.startsWith("data:") || url.startsWith("ms://");
  }

  private readonly baseUrls: readonly string[] = CODEBUDDY_CHINA_BASE_URLS;

  // Live-verified 2026-09-14 (chat stream, system-first, max_tokens>=100 on
  // www.codebuddy.cn): everything here answers 200. Specs (context/max_output)
  // from 9router open-sse/providers/capabilities.js "codebuddy-cn" table
  // (server product-config payload); models absent there keep prior values.
  supportedModels: ModelInfo[] = [
    // DeepSeek — r1 / v3 text-only; v3-2-volc / v4-flash / v4.1-flash / v4-pro vision
    { id: "cbc-deepseek-r1", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 64000, max_output: 8192, thinking: true, vision: false, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v3", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 64000, max_output: 8192, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v3-2-volc", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 64000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v4-flash", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v4.1-flash", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 128000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v4-pro", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 50000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.03, creditSource: "upstream" },
    // Kimi
    { id: "cbc-kimi-k2.5", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 164000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.05, creditSource: "upstream" },
    { id: "cbc-kimi-k2.6", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 256000, max_output: 32000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.09, creditSource: "upstream" },
    { id: "cbc-kimi-k2.7", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 256000, max_output: 32000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.07, creditSource: "upstream" },
    // K3: thinking always on; max_completion_tokens up to 1_048_576; vision = base64/ms:// only
    { id: "cbc-kimi-k3", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 256000, max_output: 1048576, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.07, creditSource: "upstream" },
    { id: "cbc-kimi-k3-1", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 32000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.07, creditSource: "upstream" },
    // GLM
    { id: "cbc-glm-5.0-turbo", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 200000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.02, creditSource: "upstream" },
    { id: "cbc-glm-5.1", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 200000, max_output: 48000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.02, creditSource: "upstream" },
    { id: "cbc-glm-5.2", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 48000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.02, creditSource: "upstream" },
    { id: "cbc-glm-5.3", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 48000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.02, creditSource: "upstream" },
    { id: "cbc-glm-5.3-flash", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 32000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.02, creditSource: "upstream" },
    { id: "cbc-glm-5v-turbo", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.03, creditSource: "upstream" },
    // MiniMax — vision support is flaky upstream (model often replies "I don't see"), kept enabled for parity
    // ponytail: m2.7 specs copied from m3, vision disabled (below M3 tier). Upgrade path: confirm against CN docs when MiniMax-M2.7 page ships.
    { id: "cbc-minimax-m2.7", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 512000, max_output: 8192, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.05, creditSource: "estimated" },
    { id: "cbc-minimax-m3", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 512000, max_output: 128000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.10, creditSource: "upstream" },
    // Hunyuan
    { id: "cbc-hy3", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 192000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-hy3-preview", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 192000, max_output: 8192, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-hy4-preview", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
  ];

  /** Cache for resolved tool schemas — the assistant sends the same tools every request */
  private schemaCache = new Map<string, any>();
  private static readonly SCHEMA_CACHE_MAX = 200;

  private getTokens(account: Account): CodeBuddyChinaTokens | null {
    if (!account.tokens) return null;
    try {
      let t = typeof account.tokens === "string"
        ? JSON.parse(account.tokens)
        : account.tokens;
      t = { ...t } as CodeBuddyChinaTokens;
      // Same double-encoding as global accounts: access_token persisted as a
      // nested JSON string ({"access_token":"<jwt>",...}). Sending it verbatim
      // yields `Bearer {json}` → false 401/403 from billing. Unwrap (parity
      // with CodeBuddyProvider.getTokens; live-proven billing 200 on CN JWT).
      let nested = t.access_token;
      for (let depth = 0; depth < 3 && typeof nested === "string" && /^[{[]/.test(nested.trim()); depth++) {
        try {
          const parsed = JSON.parse(nested);
          if (parsed && typeof parsed === "object") {
            nested = parsed.access_token ?? parsed.token;
            if (!t.refresh_token && typeof parsed.refresh_token === "string") t.refresh_token = parsed.refresh_token;
            if (!t.api_key && typeof parsed.api_key === "string") t.api_key = parsed.api_key;
          }
        } catch {
          break;
        }
      }
      if (typeof nested === "string" && !nested.startsWith("{")) t.access_token = nested;
      return t;
    } catch {
      return null;
    }
  }

  private getApiKey(tokens: CodeBuddyChinaTokens): string | null {
    return tokens.api_key || tokens.access_token || tokens.session_token || null;
  }

  /**
   * `baseUrl` must be the host actually being called: X-Domain is what upstream
   * uses to pick the tenant/region, so a mismatch with the request host yields
   * auth or routing errors even with a valid key.
   */
  private buildHeaders(apiKey: string, baseUrl: string, stream = false): Record<string, string> {
    return {
      "Accept": stream ? "text/event-stream, application/json, */*" : "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Conversation-ID": crypto.randomUUID(),
      "X-Request-ID": crypto.randomUUID().replace(/-/g, ""),
      "X-Domain": codebuddyDomain(baseUrl),
      "X-Product": "SaaS",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "CLI/2.148.0 CodeBuddy/2.148.0",
    };
  }

  /**
   * Clean messages: convert Anthropic-format content blocks (tool_use, tool_result)
   * to OpenAI-format (tool_calls, tool messages). Also handle agent system prompt
   * detection and replacement.
   *
   * CodeBuddy China vision: images in content blocks are extracted and sent as
  /**
   * Convert request messages from Anthropic format to OpenAI format compatible with
   * CodeBuddy China's `/v2/chat/completions` upstream.
   *
   * Vision images use the STANDARD OpenAI format: `image_url` blocks INSIDE the
   * `content` array (NOT hoisted to top-level fields). This was confirmed by
   * reverse-engineering zxyblzcat/uniview-codebuddy-proxy and verified by direct
   * upstream testing — models glm-4.6v, glm-5v-turbo, and deepseek-v3-2-volc
   * return accurate, non-hallucinated descriptions with this format.
   *
   * The PREVIOUS approach (top-level `files` + `image_url` + `images` + `vision: true`
   * flag with text-flattened content) produced 100% hallucinated/blind responses
   * because the upstream silently dropped the image data — see commit history.
   */
  private cleanMessages(
    request: ChatCompletionRequest,
    opts?: { strictKimiVision?: boolean },
  ): { messages: any[]; hasVision: boolean } {
    const cleanedMessages: any[] = [];
    let hasVision = false;
    const strictVision = !!opts?.strictKimiVision;


    for (const msg of request.messages) {
      let content = msg.content;

      // String content
      if (typeof content === "string") {
        // Detect and replace agent system prompts
        if (msg.role === "system" && this.isAgentSystemPrompt(content)) {
          cleanedMessages.push({
            role: "system",
            content: "You are a helpful AI assistant that helps with software engineering tasks.",
          });
          continue;
        }
        // Preserve OpenAI-native assistant tool_calls on string content
        if (msg.role === "assistant" && (msg as any).tool_calls) {
          cleanedMessages.push({
            role: "assistant",
            content,
            tool_calls: (msg as any).tool_calls,
          });
          continue;
        }
        // Preserve OpenAI-native tool messages' tool_call_id — dropping it
        // makes the upstream reject the whole history (HTTP 400 code 11148).
        const flatMsg: any = { role: msg.role, content };
        if ((msg as any).tool_call_id) flatMsg.tool_call_id = (msg as any).tool_call_id;
        cleanedMessages.push(flatMsg);
        continue;
      }

      // Array content — need conversion from Anthropic to OpenAI format
      if (Array.isArray(content)) {
        const hasToolUse = content.some((block: any) => block.type === "tool_use");
        const hasToolResult = content.some((block: any) => block.type === "tool_result");

        // Assistant messages with tool_use → convert to OpenAI tool_calls
        if (msg.role === "assistant" && hasToolUse) {
          const textBlocks = content.filter((block: any) => block.type === "text");
          const toolUseBlocks = content.filter((block: any) => block.type === "tool_use");

          const textContent = textBlocks
            .map((block: any) => block.text || "")
            .filter(Boolean)
            .join("\n");

          const tool_calls = toolUseBlocks.map((block: any) => ({
            id: block.id || crypto.randomUUID(),
            type: "function",
            function: {
              name: block.name || "",
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}),
            },
          }));

          cleanedMessages.push({
            role: "assistant",
            content: textContent || "",
            tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
          });
          continue;
        }

        // User messages with tool_result → convert to OpenAI tool messages
        if (msg.role === "user" && hasToolResult) {
          const toolResults = content.filter((block: any) => block.type === "tool_result");
          const textBlocks = content.filter((block: any) => block.type === "text");

          // Add each tool result as a separate tool message
          for (const toolResult of toolResults) {
            const resultContent = typeof toolResult.content === "string"
              ? toolResult.content
              : Array.isArray(toolResult.content)
                ? toolResult.content.map((c: any) => c.text || "").join("\n")
                : JSON.stringify(toolResult.content || "");

            cleanedMessages.push({
              role: "tool",
              tool_call_id: toolResult.tool_use_id || crypto.randomUUID(),
              content: resultContent,
            });
          }

          // Add text content after tool results if present
          const textContent = textBlocks
            .map((block: any) => block.text || "")
            .filter(Boolean)
            .join("\n");

          if (textContent) {
            cleanedMessages.push({
              role: "user",
              content: textContent,
            });
          }
          continue;
        }

        // Default: build OpenAI-format content array preserving image_url blocks inline.
        // CodeBuddy China expects: content: [ {type:"image_url", image_url:{url:"..."}}, {type:"text", text:"..."} ]
        // This is the STANDARD OpenAI vision format — confirmed working with glm-4.6v,
        // glm-5v-turbo, deepseek-v3-2-volc via direct upstream testing.
        // Kimi K3: public http(s) URLs unsupported — keep data: / ms:// only.
        const outputContent: any[] = [];

        for (const block of content) {
          if (block.type === "text") {
            outputContent.push({ type: "text", text: block.text || "" });
          } else if (block.type === "image_url" && block.image_url) {
            const url = typeof block.image_url === "string" ? block.image_url : block.image_url.url;
            if (url && (!strictVision || this.isAllowedKimiVisionUrl(url))) {
              outputContent.push({ type: "image_url", image_url: { url } });
              hasVision = true;
            }
          } else if (block.type === "image" && block.source) {
            const base64 = block.source.type === "base64"
              ? `data:${block.source.media_type || "image/png"};base64,${block.source.data}`
              : block.source.url || "";
            if (base64 && (!strictVision || this.isAllowedKimiVisionUrl(base64))) {
              outputContent.push({ type: "image_url", image_url: { url: base64 } });
              hasVision = true;
            }
          }
        }

        // If only text blocks (no images), collapse to plain string for backwards-compat
        // with non-vision models that may reject array content.
        const hasOnlyText = outputContent.every((b) => b.type === "text");
        if (hasOnlyText) {
          const flatText = outputContent.map((b: any) => b.text).join("\n");
          cleanedMessages.push({ role: msg.role, content: flatText });
        } else {
          cleanedMessages.push({ role: msg.role, content: outputContent });
        }
        continue;
      }

      // Fallback: pass through; keep assistant tool_calls if present
      if (msg.role === "assistant" && (msg as any).tool_calls) {
        cleanedMessages.push({
          role: "assistant",
          content: content || "",
          tool_calls: (msg as any).tool_calls,
        });
      } else {
        const fallbackMsg: any = { role: msg.role, content: content || "" };
        if ((msg as any).tool_call_id) fallbackMsg.tool_call_id = (msg as any).tool_call_id;
        cleanedMessages.push(fallbackMsg);
      }
    }

    // CodeBuddy China rejects requests where tool calls and tool results don't
    // pair up (HTTP 400 code 11148). Normalize so every `tool` message has a
    // `tool_call_id` that matches a preceding assistant `tool_calls[].id` —
    // otherwise the upstream returns "tool calls and tool results do not match".
    return { messages: this.pairToolMessages(cleanedMessages), hasVision };
  }

  /**
   * Pair tool results with their tool calls.
   *
   * Upstream (codebuddy.cn) returns 400 code 11148 "tool calls and tool results
   * do not match" when:
   *  - a `tool` message has a `tool_call_id` that no assistant `tool_calls[].id`
   *    references (e.g. after message truncation/compression), or
   *  - a `tool` message lost its `tool_call_id` during conversion, or
   *  - Anthropic `tool_use`/`tool_result` blocks lacked ids, so random UUIDs were
   *    generated independently on each side and don't line up.
   *
   * Fix strategy: track emitted assistant tool_call ids in order; a `tool`
   * message whose id is unknown gets the next unmatched tool call id. Orphaned
   * tool results (no tool call anywhere) are dropped rather than sent upstream.
   */
  private pairToolMessages(messages: any[]): any[] {
    const pendingIds: string[] = [];
    const cleaned: any[] = [];

    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc?.id) pendingIds.push(tc.id);
        }
        cleaned.push(msg);
        continue;
      }

      if (msg.role === "tool") {
        if (msg.tool_call_id && pendingIds.includes(msg.tool_call_id)) {
          pendingIds.splice(pendingIds.indexOf(msg.tool_call_id), 1);
          cleaned.push(msg);
        } else if (pendingIds.length > 0) {
          // Unknown/missing id — bind to the next unmatched tool call.
          msg.tool_call_id = pendingIds.shift();
          cleaned.push(msg);
        } else {
          // Orphaned tool result with no matching tool call — drop it.
          console.warn("[CodeBuddy China] Dropping orphaned tool result (no matching tool call)");
        }
        continue;
      }

      cleaned.push(msg);
    }

    return cleaned;
  }

  private isAgentSystemPrompt(content: string): boolean {
    if (content.length > 2000) return true;
    // Broad detection for AI agent/CLI tool system prompts
    const patterns = [
      /claude.*official.*cli/i,
      /code.*official.*cli/i,
      /you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)/i,
      /you are an? (?:ai )?(?:coding |code )?agent/i,
      /cc_entrypoint/i,
      /OhMyOpenCode/i,
      /<agent-identity>/i,
    ];
    return patterns.some((p) => p.test(content));
  }

  /**
   * Normalize tools from Anthropic/Claude format to OpenAI function-calling format.
   * Also sanitize schemas (resolve $ref, strip unsupported fields).
   */
  private normalizeTools(tools: any[] | undefined): any[] {
    if (!tools || tools.length === 0) return [];

    return tools.map((tool) => {
      if (tool.type === "function" && tool.function) {
        return {
          type: "function",
          function: {
            name: tool.function.name,
            description: tool.function.description || "",
            parameters: this.sanitizeToolSchema(tool.function.parameters),
          },
        };
      }

      // Convert Anthropic/Claude format to OpenAI format
      const fn = tool.function || tool;
      const name = fn?.name || tool?.name;
      const description = fn?.description || tool?.description || "";
      const parameters = fn?.parameters || fn?.input_schema || { type: "object", properties: {} };

      return {
        type: "function",
        function: {
          name,
          description,
          parameters: this.sanitizeToolSchema(parameters),
        },
      };
    }).filter((t: any) => t.function?.name);
  }

  private sanitizeToolSchema(schema: any): any {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return { type: "object", properties: {} };
    }

    const cacheKey = JSON.stringify(schema);
    const cached = this.schemaCache.get(cacheKey);
    if (cached) return cached;

    const defs = { ...(schema.$defs || {}), ...(schema.definitions || {}) };
    let resolved = Object.keys(defs).length > 0 || this.hasRefs(schema)
      ? this.resolveSchemaRefs(schema, defs)
      : { ...schema };

    for (const key of ["$schema", "$id", "$comment", "$defs", "definitions"]) {
      delete resolved[key];
    }

    if (!resolved.type) resolved.type = "object";
    if (resolved.type === "object" && !resolved.properties) {
      resolved.properties = {};
    }
    if (resolved.required && !Array.isArray(resolved.required)) {
      delete resolved.required;
    }

    if (this.schemaCache.size >= CodeBuddyChinaProvider.SCHEMA_CACHE_MAX) {
      this.schemaCache.clear();
    }
    this.schemaCache.set(cacheKey, resolved);

    return resolved;
  }

  private resolveSchemaRefs(schema: any, defs: Record<string, any>, seen = new Set<string>()): any {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema.map((item: any) => this.resolveSchemaRefs(item, defs, seen));

    if (schema.$ref && typeof schema.$ref === "string") {
      const refPath = schema.$ref.replace(/^#\/\$defs\//, "").replace(/^#\/definitions\//, "");
      if (seen.has(refPath)) return { type: "object", description: `(circular ref: ${refPath})` };
      const resolved = defs[refPath];
      if (resolved) {
        seen.add(refPath);
        const result = this.resolveSchemaRefs({ ...resolved }, defs, seen);
        seen.delete(refPath);
        return result;
      }
      return { type: "object" };
    }

    const clone: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$defs" || key === "definitions") continue;
      clone[key] = this.resolveSchemaRefs(value, defs, seen);
    }
    return clone;
  }

  private hasRefs(obj: any): boolean {
    if (!obj || typeof obj !== "object") return false;
    if (Array.isArray(obj)) return obj.some((item: any) => this.hasRefs(item));
    if ("$ref" in obj) return true;
    return Object.values(obj).some((value: any) => this.hasRefs(value));
  }

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "No tokens available" };

    const apiKey = this.getApiKey(tokens);
    if (!apiKey) return { success: false, error: "No API key available" };

    try {
      // Always stream — CodeBuddy China doesn't support non-stream
      const { response } = await this.requestWithFailover(apiKey, request, true);

      if (response.status === 401 || response.status === 403) {
        const refreshResult = await this.refreshToken(account);
        if (!refreshResult.success || !refreshResult.tokens) {
          // Propagate the refresh failure's own reason: a hung/unreachable auth
          // endpoint must not be relabelled as a revoked session.
          return { success: false, error: refreshResult.error ?? "Session expired, re-login required" };
        }
        const newTokens = JSON.parse(refreshResult.tokens) as CodeBuddyChinaTokens;
        const newApiKey = this.getApiKey(newTokens);
        if (!newApiKey) return { success: false, error: "Session expired, re-login required" };
        const { response: retryResponse } = await this.requestWithFailover(newApiKey, request, true);
        if (retryResponse.status === 401 || retryResponse.status === 403) {
          return { success: false, error: "Session expired, re-login required" };
        }
        if (retryResponse.ok) {
          const retryData = await this.aggregateStreamResponse(retryResponse, request.model);
          const totalTokens = retryData.usage.total_tokens || 0;
          const realCredit = (retryData as any)._realCredit;
          const creditsUsed = realCredit != null ? realCredit : (totalTokens > 0 ? totalTokens * this.getProviderCreditRate(request.model) : 0);
          const creditSource: "upstream" | "estimated" = realCredit != null ? "upstream" : "estimated";
          delete (retryData as any)._realCredit;
          const result: ProviderResult = {
            success: true,
            response: retryData,
            tokensUsed: totalTokens,
            promptTokens: retryData.usage.prompt_tokens || 0,
            completionTokens: retryData.usage.completion_tokens || 0,
            creditsUsed,
            creditSource,
          };
          result.tokens = newTokens;
          return result;
        }
        const errText = await retryResponse.text();
        return { success: false, error: `CodeBuddy China API error (${retryResponse.status}): ${errText}` };
      }
      if (response.status === 429) {
        return { success: false, error: "Rate limited / quota exhausted", quotaExhausted: true };
      }
      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `CodeBuddy China API error (${response.status}): ${errText}` };
      }

      const data = await this.aggregateStreamResponse(response, request.model);
      const totalTokens = data.usage.total_tokens || 0;
      const realCredit = (data as any)._realCredit;
      const creditsUsed = realCredit != null ? realCredit : (totalTokens > 0 ? totalTokens * this.getProviderCreditRate(request.model) : 0);
      const creditSource: "upstream" | "estimated" = realCredit != null ? "upstream" : "estimated";
      delete (data as any)._realCredit;

      return {
        success: true,
        response: data,
        tokensUsed: totalTokens,
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
        creditsUsed,
        creditSource,
      };
    } catch (error) {
      return { success: false, error: `CodeBuddy China request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "No tokens available" };

    const apiKey = this.getApiKey(tokens);
    if (!apiKey) return { success: false, error: "No API key available" };

    try {
      const { response } = await this.requestWithFailover(apiKey, request, true);

      if (response.status === 401 || response.status === 403) {
        const refreshResult = await this.refreshToken(account);
        if (!refreshResult.success || !refreshResult.tokens) {
          return { success: false, error: refreshResult.error ?? "Session expired, re-login required" };
        }
        const newTokens = JSON.parse(refreshResult.tokens) as CodeBuddyChinaTokens;
        const newApiKey = this.getApiKey(newTokens);
        if (!newApiKey) return { success: false, error: "Session expired, re-login required" };
        const { response: retryResponse } = await this.requestWithFailover(newApiKey, request, true);
        if (retryResponse.status === 401 || retryResponse.status === 403) {
          return { success: false, error: "Session expired, re-login required" };
        }
        if (retryResponse.ok) {
          const result = this.createStreamResponse(retryResponse, request.model);
          if (result.success) {
            result.tokens = newTokens;
          }
          return result;
        }
        const errText = await retryResponse.text();
        return { success: false, error: `CodeBuddy China API error (${retryResponse.status}): ${errText}` };
      }
      if (response.status === 429) {
        return { success: false, error: "Rate limited", quotaExhausted: true };
      }
      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `CodeBuddy China API error (${response.status}): ${errText}` };
      }

      return this.createStreamResponse(response, request.model);
    } catch (error) {
      return { success: false, error: `CodeBuddy China stream failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async refreshToken(
    account: Account
  ): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.refresh_token) {
      return { success: false, error: "No refresh token — re-login required" };
    }
    try {
      const next = await refreshCodebuddyChinaToken(tokens.refresh_token);
      const merged = {
        ...tokens,
        access_token: next.access_token,
        refresh_token: next.refresh_token,
        expires_at: next.expires_at,
      };
      return { success: true, tokens: JSON.stringify(merged) };
    } catch (error) {
      // AbortSignal.timeout rejects with a TimeoutError DOMException whose text
      // is not useful to an operator; name-check it so a dead auth endpoint
      // reads as a transport failure and never as "re-login required".
      const errName = (error as { name?: string } | null)?.name;
      if (errName === "TimeoutError" || errName === "AbortError") {
        return {
          success: false,
          error: `CodeBuddy China token refresh timed out after ${config.providerQuotaTimeoutMs}ms — auth endpoint unreachable (session NOT revoked)`,
        };
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!this.getApiKey(tokens || {} as CodeBuddyChinaTokens);
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "No tokens available" };

    const apiKey = this.getApiKey(tokens);
    if (!apiKey) return { success: false, error: "No API key" };

    try {
      const response = await this.fetchUserResource(tokens);

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      if (data.code !== 0) {
        return { success: false, error: `API error code ${data.code}` };
      }

      return { success: true, quota: this.parseResourceQuota(data) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const tokens = this.getTokens(account);
    const apiKey = this.getApiKey(tokens || {} as CodeBuddyChinaTokens);
    if (!apiKey) {
      return { kind: "missing_tokens", success: false, error: "No API key available" };
    }

    // Primary check: fetch real billing data via /v2/billing/meter/get-user-resource
    // This endpoint works with API key and gives us both auth validation AND real credit data.
    const quota = await this.fetchQuota(account);
    if (quota.success && quota.quota) {
      return {
        kind: quota.quota.remaining <= 0 ? "exhausted" : "healthy",
        success: true,
        quota: { ...quota.quota, source: "codebuddy-china.get-user-resource" },
        metadata: {
          credit_total_dosage: quota.quota.limit,
          credit_capacity_remain: quota.quota.remaining,
          credit_capacity_used: quota.quota.used,
          credit_capacity_size: quota.quota.limit,
          lastRealBillingSync: new Date().toISOString(),
        },
      };
    }

    // Billing API failed — check if it's an auth issue or transient error
    if (quota.error?.includes("401") || quota.error?.includes("403")) {
      return {
        kind: "session_expired",
        success: false,
        error: "CodeBuddy China API key expired or revoked (billing returned 401/403)",
      };
    }

    // Fallback: validate via chat completions endpoint
    const apiStatus = await this.validateApiKey(tokens || {} as CodeBuddyChinaTokens);

    if (apiStatus === "ok") {
      // API works but billing failed (transient) — report as healthy with stored quota
      const storedQuota = Number(account.quotaRemaining || 0);
      const storedLimit = Number(account.quotaLimit || 0);
      return {
        kind: "healthy",
        success: true,
        quota: storedLimit > 0
          ? { limit: storedLimit, remaining: storedQuota, used: storedLimit - storedQuota, source: "tracked" }
          : undefined,
        message: `Billing API transient error (${quota.error}). Using tracked credit: ${storedQuota.toFixed(1)}/${storedLimit.toFixed(1)}`,
      };
    }

    if (apiStatus === "quota_exhausted") {
      return { kind: "exhausted", success: true, error: "Provider returned 429 - quota exhausted" };
    }

    // API returned 401/403 - truly expired
    return {
      kind: "session_expired",
      success: false,
      error: "CodeBuddy China API returned 401/403 - session expired, re-login required",
    };
  }

  /**
   * Check if the api_key can make actual requests to the provider.
   * Uses the billing API endpoint which validates the API key without consuming credits.
   * Falls back to chat completions endpoint if billing check fails.
   * Returns: "ok" | "quota_exhausted" | "expired"
   */
  private async validateApiKey(tokens: CodeBuddyChinaTokens): Promise<"ok" | "quota_exhausted" | "expired"> {
    const apiKey = this.getApiKey(tokens);
    if (!apiKey) return "expired";

    // Primary: use billing API to validate — doesn't consume credits and gives definitive auth status
    try {
      const response = await this.fetchUserResource(tokens);
      if (response.status === 401 || response.status === 403) return "expired";
      if (response.status === 429) return "quota_exhausted";
      if (response.ok) {
        const data = await response.json() as any;
        if (data.code === 0) return "ok";
        // Non-zero code but HTTP 200 — API key is valid, just a business logic error
        return "ok";
      }
      // Other HTTP errors — fall through to chat endpoint check
    } catch {
      // Network error on billing — fall through to chat endpoint check
    }

    // Fallback: use chat completions endpoint (abort immediately after status).
    // Body must be system-first: upstream rejects user-first with 400-class
    // (global: code 11128), which would false-report a live key as expired.
    const controller = new AbortController();
    try {
      const response = await fetch(`${CODEBUDDY_CHINA_PRIMARY_BASE_URL}/v2/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: this.buildHeaders(apiKey, CODEBUDDY_CHINA_PRIMARY_BASE_URL),
        body: JSON.stringify({
          model: "deepseek-v3",
          messages: [
            { role: "system", content: "You are CodeBuddy Code." },
            { role: "user", content: "hi" },
          ],
          max_tokens: 5,
          stream: true,
        }),
      });

      // Got HTTP status - abort immediately to avoid consuming tokens
      controller.abort();

      if (response.status === 401 || response.status === 403) return "expired";
      if (response.status === 429) return "quota_exhausted";
      return "ok";
    } catch (err: any) {
      // AbortError is expected (we aborted on purpose after getting status)
      if (err?.name === "AbortError") return "ok";
      // Network error - assume ok to avoid false negatives
      return "ok";
    }
  }

  private async fetchUserResource(tokens: CodeBuddyChinaTokens): Promise<Response> {
    const now = new Date();
    const endDate = new Date(now.getTime() + 365 * 20 * 24 * 60 * 60 * 1000);
    const payload = {
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageEndTimeRangeBegin: now.toISOString().replace("T", " ").slice(0, 19),
      PackageEndTimeRangeEnd: endDate.toISOString().replace("T", " ").slice(0, 19),
    };

    // Use /v2/billing/meter/get-user-resource which works with API key (Bearer token).
    const apiKey = this.getApiKey(tokens);
    const headers: Record<string, string> = {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "CLI/2.148.0 CodeBuddy/2.148.0",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    return this.fetchWithTimeout(`${CODEBUDDY_CHINA_PRIMARY_BASE_URL}/v2/billing/meter/get-user-resource`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, config.providerQuotaTimeoutMs);
  }

  private parseResourceQuota(data: any): { limit: number; remaining: number; used: number } {
    const responseData = data.data?.Response?.Data || {};
    const totalDosage = Number(responseData.TotalDosage || 0);
    const resourceAccounts = Array.isArray(responseData.Accounts) ? responseData.Accounts : [];
    let totalRemain = 0;
    let totalUsed = 0;
    let totalSize = 0;

    for (const acct of resourceAccounts) {
      totalRemain += Number(acct.CapacityRemain || 0);
      totalUsed += Number(acct.CapacityUsed || 0);
      totalSize += Number(acct.CapacitySize || 0);
    }

    const limit = totalSize || totalDosage || totalRemain + totalUsed;
    const remaining = totalRemain;
    const used = totalUsed || Math.max(0, limit - remaining);
    return { limit, remaining, used };
  }

  private async makeRequest(
    apiKey: string,
    request: ChatCompletionRequest,
    stream: boolean,
    baseUrl: string
  ): Promise<Response> {
    const resolved = this.resolveModel(request.model);
    const headers = this.buildHeaders(apiKey, baseUrl, stream);
    const kimiK3 = this.isKimiK3(resolved);

    // Clean messages: convert Anthropic-format (tool_use, tool_result, array content)
    // to OpenAI format (tool_calls, tool messages). Vision images stay INLINE in
    // content array (standard OpenAI format) — NOT hoisted to top-level fields.
    const { messages, hasVision } = this.cleanMessages(request, {
      strictKimiVision: kimiK3,
    });

    // Upstream rejects calls whose first message is not system
    // (global: 400 code 11128; CN untested pre-fix). Force system-first —
    // parity with CodeBuddyProvider.makeRequest / Cartethyia globalModels.
    const systemIdx = messages.findIndex((m: any) => m?.role === "system");
    if (systemIdx > 0) {
      const [sys] = messages.splice(systemIdx, 1);
      messages.unshift(sys);
    } else if (systemIdx < 0) {
      messages.unshift({ role: "system", content: "You are CodeBuddy Code." });
    }

    const body: Record<string, unknown> = {
      model: resolved,
      messages,
      stream: true, // Always stream for China version
    };


    if (hasVision) {
      // Vision images are passed inline via the messages array (OpenAI standard format).
      // CodeBuddy China upstream auto-detects and routes them — no top-level flag needed.
      // Verified accurate with glm-4.6v, glm-5v-turbo, deepseek-v3-2-volc via direct
      // upstream testing on real screenshots.
    }

    if (kimiK3) {
      // Kimi K3: fixed sampling (temp/top_p/n/penalties) — omit; thinking always on.
      // max_completion_tokens default 131072, max 1048576. CBC may alias field.
      if (request.max_tokens && request.max_tokens > 0) {
        body.max_completion_tokens = Math.min(Math.max(1, request.max_tokens), 1_048_576);
      }
      if (request.reasoning_effort || request.thinking) {
        body.reasoning_effort = "max";
      }
    } else {
      if (request.max_tokens && request.max_tokens > 0) {
        body.max_tokens = request.max_tokens;
      }
      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }
    }

    // Normalize tools to OpenAI function-calling format
    const tools = this.normalizeTools(request.tools);
    if (tools.length > 0) {
      body.tools = tools;
    }
    if (request.tool_choice) {
      body.tool_choice = request.tool_choice;
    }

    const timeoutMs = stream ? 300_000 : config.providerRequestTimeoutMs;

    return this.fetchWithTimeout(`${baseUrl}/v2/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, timeoutMs);
  }

  /**
   * Retry the chat request across candidate hosts. Only transport-level failures
   * and host-scoped HTTP failures (5xx, 404, 405) justify a switch: those are the
   * signatures of one host being down or having moved the route, while the same
   * credentials remain valid on its peer.
   *
   * 401/403 deliberately do NOT fail over — auth state is account-wide, so the
   * peer host would answer identically and the switch would only mask the
   * refresh-then-retry path that actually recovers the session. Same for 400
   * (our own malformed body) and 429 (quota is per-account, not per-host).
   */
  private async requestWithFailover(
    apiKey: string,
    request: ChatCompletionRequest,
    stream: boolean
  ): Promise<{ response: Response; baseUrl: string }> {
    for (let i = 0; i < this.baseUrls.length; i++) {
      const baseUrl = this.baseUrls[i] as string;
      const nextBaseUrl = this.baseUrls[i + 1];
      const host = new URL(baseUrl).hostname;

      let response: Response;
      try {
        response = await this.makeRequest(apiKey, request, stream, baseUrl);
      } catch (error) {
        if (nextBaseUrl === undefined) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        console.log(
          `[CodeBuddy China] ${host} failed (${reason}), retrying via ${new URL(nextBaseUrl).hostname}`
        );
        continue;
      }

      if (nextBaseUrl !== undefined && shouldFailoverStatus(response.status)) {
        console.log(
          `[CodeBuddy China] ${host} failed (HTTP ${response.status}), retrying via ${new URL(nextBaseUrl).hostname}`
        );
        continue;
      }

      return { response, baseUrl };
    }

    throw new Error("CodeBuddy China: no candidate host available");
  }

  private async aggregateStreamResponse(response: Response, model: string): Promise<ChatCompletionResponse & { _realCredit?: number }> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let id = this.generateId();
    let finishReason: string | null = "stop";
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let realCredit: number | null = null;

    if (!reader) {
      return {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
        usage,
      };
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          id = chunk.id || id;
          const choice = chunk.choices?.[0];
          const delta = choice?.delta || {};

          if (delta.content) content += delta.content;

          if (choice?.finish_reason) finishReason = choice.finish_reason || "stop";

          if (chunk.usage) {
            usage = {
              prompt_tokens: Number(chunk.usage.prompt_tokens || 0),
              completion_tokens: Number(chunk.usage.completion_tokens || 0),
              total_tokens: Number(chunk.usage.total_tokens || 0),
            };
            if (chunk.usage.credit != null && Number(chunk.usage.credit) > 0) {
              realCredit = Number(chunk.usage.credit);
            }
          }
        } catch {
          // skip malformed chunk
        }
      }
    }

    if (!usage.completion_tokens) usage.completion_tokens = this.estimateTokens(content);
    if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason || "stop" }],
      usage,
      ...(realCredit != null ? { _realCredit: realCredit } : {}),
    };
  }

  private createStreamResponse(response: Response, model: string): ProviderResult {
    const id = this.generateId();

    const stream = runSseStreamLoop({
      response,
      id,
      model,
      logPrefix: "[CodeBuddy China]",
      // A transport error before any content is forwarded must reject the
      // stream, not end on a 200 carrying error text, so the proxy's combo
      // fallback can try the next target.
      rejectOnErrorBeforeContent: true,
      onEvent: (parsed) => {
        const choice = parsed.choices?.[0];
        const delta = choice?.delta || {};

        const chunk: StreamChunk = {
          id: parsed.id || id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: choice?.index ?? 0, delta, finish_reason: choice?.finish_reason || null }],
        };
        if (parsed.usage) chunk.usage = parsed.usage;

        return {
          chunks: [chunk],
          content: delta.content || "",
          toolCalls: Boolean(delta.tool_calls?.length),
        };
      },
      onPlainJson: (parsed) => {
        const choice = parsed.choices?.[0];
        const content = String(
          choice?.delta?.content ?? choice?.message?.content ?? parsed?.content ?? ""
        );
        if (!content) return {};
        return {
          chunks: [{
            id: parsed.id || id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: choice?.index ?? 0, delta: { content }, finish_reason: choice?.finish_reason || null }],
          }],
          content,
        };
      },
    });

    return {
      success: true,
      stream,
      // A streaming turn's usage is finalized from the SSE stream by the wrapper
      // in proxy/index.ts, so there is nothing to report here yet.
      tokensUsed: 0,
      promptTokens: 0,
      completionTokens: 0,
      creditsUsed: 0,
      creditSource: "estimated" as const,
    };
  }
}
