import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import { SSE_DONE_SENTINEL, releaseReader } from "../stream-utils";

/**
 * Grok CLI / Grok Build — port of 9router `grok-cli` (device-code OAuth).
 * Upstream: cli-chat-proxy.grok.com OpenAI Responses API.
 * Auth: xAI device code → Bearer on cli-chat-proxy with x-xai-token-auth.
 */

const GROK_CLI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_CLI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const GROK_CLI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const GROK_CLI_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const GROK_CLI_REFERRER = "grok-build";
const GROK_CLI_RESPONSES_URL = "https://cli-chat-proxy.grok.com/v1/responses";
const GROK_CLI_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
const GROK_CLI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_CLI_UA = "grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)";
const GROK_CLI_VERSION = "0.2.93";

export const GROK_CLI_OAUTH = {
  clientId: GROK_CLI_CLIENT_ID,
  deviceCodeUrl: GROK_CLI_DEVICE_URL,
  tokenUrl: GROK_CLI_TOKEN_URL,
  scope: GROK_CLI_SCOPE,
  referrer: GROK_CLI_REFERRER,
  userAgent: GROK_CLI_UA,
} as const;

interface GrokCliTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: string | number;
  email?: string;
  user_id?: string | null;
  method?: string;
  subscription_tier?: string | null;
  has_grok_code_access?: boolean | null;
}

interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

const MODEL_EFFORT: Record<string, string | undefined> = {
  "grok-4.5": undefined,
  "grok-4.5-high": "high",
  "grok-4.5-medium": "medium",
  "grok-4.5-low": "low",
};

// Fallback only when Responses usage has no credit field. Prefer upstream.
const GROK_CLI_FALLBACK_CREDIT_RATE = 0.02 / 1000;

/** Real credit from Grok Build Responses API usage (if present). */
export function extractGrokCliCredits(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const raw =
    u.credit ??
    u.credits ??
    u.credits_used ??
    u.creditsUsed ??
    u.num_credits ??
    u.cost_in_credits ??
    (u.cost as Record<string, unknown> | undefined)?.credits ??
    (u.billing as Record<string, unknown> | undefined)?.credits;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function extractGrokCliTokenUsage(usage: unknown): { inputTokens: number; outputTokens: number } {
  if (!usage || typeof usage !== "object") return { inputTokens: 0, outputTokens: 0 };
  const u = usage as Record<string, unknown>;
  const inputTokens = Number(u.input_tokens ?? u.prompt_tokens ?? u.inputTokens ?? 0) || 0;
  const outputTokens = Number(u.output_tokens ?? u.completion_tokens ?? u.outputTokens ?? 0) || 0;
  return { inputTokens, outputTokens };
}

export class GrokCliProvider extends BaseProvider {
  name = "grok-cli";

  override ownsModel(model: string): boolean {
    return model.toLowerCase() in MODEL_EFFORT;
  }

  supportedModels: ModelInfo[] = [
    { id: "grok-4.5", object: "model", created: Date.now(), owned_by: "grok-cli", context_window: 256000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: GROK_CLI_FALLBACK_CREDIT_RATE, creditSource: "estimated" },
    { id: "grok-4.5-high", object: "model", created: Date.now(), owned_by: "grok-cli", context_window: 256000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: GROK_CLI_FALLBACK_CREDIT_RATE, creditSource: "estimated" },
    { id: "grok-4.5-medium", object: "model", created: Date.now(), owned_by: "grok-cli", context_window: 256000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: GROK_CLI_FALLBACK_CREDIT_RATE, creditSource: "estimated" },
    { id: "grok-4.5-low", object: "model", created: Date.now(), owned_by: "grok-cli", context_window: 256000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: GROK_CLI_FALLBACK_CREDIT_RATE, creditSource: "estimated" },
  ];

  private getTokens(account: Account): GrokCliTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as GrokCliTokens;
    } catch {
      return null;
    }
  }

  private resolveModel(model: string): string {
    // effort variants share upstream id grok-4.5
    return "grok-4.5";
  }

  private resolveEffort(request: ChatCompletionRequest): string | undefined {
    const fromModel = MODEL_EFFORT[request.model.toLowerCase()];
    if (fromModel) return fromModel;
    if (request.reasoning_effort) return request.reasoning_effort;
    if (request.thinking?.effort) return request.thinking.effort;
    return undefined;
  }

  private async classifyErrorResponse(response: Response): Promise<ProviderResult> {
    const text = await response.text().catch(() => "");
    const detail = text.slice(0, 500);
    // Free-tier exhaustion is authorization-shaped upstream, but account is
    // still valid. Mark quota exhausted so router can fail over, not re-login.
    if (/free[-_ ]usage[-_ ]exhausted|usage[-_ ]exhausted|credits? exhausted/i.test(text)) {
      return { success: false, error: detail || "Grok credits exhausted", quotaExhausted: true };
    }
    if (response.status === 401 || response.status === 403) {
      return { success: false, error: `expired: HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
    }
    if (response.status === 402) {
      return { success: false, error: detail || "Grok credits exhausted", quotaExhausted: true };
    }
    if (response.status === 429) {
      return { success: false, error: detail || "Rate limited", rateLimited: true };
    }
    return { success: false, error: `HTTP ${response.status}: ${detail}` };
  }

  private contentToText(content: unknown): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block?.type === "text" || block?.type === "input_text" || block?.type === "output_text") return block.text || "";
        if (block?.type === "tool_result") return this.contentToText(block.content) || String(block.content || "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private stringifyToolInput(input: unknown): string {
    if (typeof input === "string") return input;
    try {
      return JSON.stringify(input ?? {});
    } catch {
      return "{}";
    }
  }

  private normalizeTools(tools: any[] | undefined): any[] {
    if (!Array.isArray(tools) || tools.length === 0) return [];
    return tools
      .map((tool) => {
        if (tool?.type === "function" && tool.function?.name) {
          return {
            type: "function",
            name: tool.function.name,
            description: tool.function.description || "",
            parameters: tool.function.parameters || {},
          };
        }
        if (tool?.name) {
          return {
            type: "function",
            name: tool.name,
            description: tool.description || "",
            parameters: tool.input_schema || tool.parameters || {},
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  private buildPayload(request: ChatCompletionRequest): { instructions: string; input: unknown[] } {
    const systemParts: string[] = [];
    const items: unknown[] = [];
    for (const msg of request.messages) {
      const rawRole = msg.role as string;
      const text = this.contentToText(msg.content);
      if (rawRole === "system") {
        if (text) systemParts.push(text);
        continue;
      }
      if (rawRole === "tool") {
        items.push({
          type: "function_call_output",
          call_id: msg.tool_call_id || crypto.randomUUID(),
          output: text,
        });
        continue;
      }
      const role = rawRole === "tool" ? "user" : rawRole;
      if (text) {
        items.push({
          type: "message",
          role,
          content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
        });
      }
      for (const call of msg.tool_calls || []) {
        const name = call?.function?.name;
        if (!name) continue;
        items.push({
          type: "function_call",
          call_id: call.id || crypto.randomUUID(),
          name,
          arguments: this.stringifyToolInput(call.function?.arguments),
        });
      }
    }
    return { instructions: systemParts.join("\n\n"), input: items };
  }

  private proxyHeaders(accessToken: string, email?: string | null, userId?: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": GROK_CLI_UA,
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-identifier": "grok-pager",
      "x-grok-client-version": GROK_CLI_VERSION,
      "x-authenticateresponse": "authenticate-response",
    };
    if (email) headers["x-email"] = email;
    if (userId) headers["x-userid"] = String(userId);
    return headers;
  }

  private async makeRequest(account: Account, request: ChatCompletionRequest): Promise<Response> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) throw new Error("expired: no access_token");

    const { instructions, input } = this.buildPayload(request);
    const tools = this.normalizeTools(request.tools);
    const effort = this.resolveEffort(request);
    const body: Record<string, unknown> = {
      model: this.resolveModel(request.model),
      instructions: instructions || undefined,
      input,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined,
      stream: true,
      store: false,
    };
    if (effort) {
      body.reasoning = { effort };
    }

    return this.fetchWithTimeout(GROK_CLI_RESPONSES_URL, {
      method: "POST",
      headers: this.proxyHeaders(tokens.access_token, tokens.email, tokens.user_id),
      body: JSON.stringify(body),
    });
  }

  private toolCallsFromMap(byIndex: Map<number, PendingToolCall>) {
    return [...byIndex.values()]
      .filter((call) => call.name)
      .sort((a, b) => a.index - b.index)
      .map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));
  }

  private collectCompletedToolCalls(response: any, byIndex: Map<number, PendingToolCall>) {
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

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const response = await this.makeRequest(account, request);
      if (!response.ok || !response.body) {
        return this.classifyErrorResponse(response);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let upstreamCredits: number | null = null;
      const toolCallsByIndex = new Map<number, PendingToolCall>();
      let reachedDone = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let dataLine = "";
          for (const line of event.split("\n")) {
            if (line.startsWith("data: ")) dataLine += line.slice(6);
            else if (line.startsWith("data:")) dataLine += line.slice(5);
          }
          if (!dataLine) continue;
          if (dataLine === SSE_DONE_SENTINEL) {
            // Payload complete — stop reading rather than wait for the upstream
            // to close a socket it may hold open indefinitely.
            reachedDone = true;
            break;
          }
          try {
            const obj = JSON.parse(dataLine);
            const t = obj.type || "";
            if (t === "response.output_text.delta") {
              text += obj.delta || "";
            } else if (t === "response.output_item.added" || t === "response.output_item.done") {
              const item = obj.item || {};
              if (item.type === "function_call") {
                const index = Number(obj.output_index ?? toolCallsByIndex.size);
                toolCallsByIndex.set(index, {
                  index,
                  id: item.call_id || item.id || `call_${index}`,
                  name: item.name || "",
                  arguments: item.arguments || toolCallsByIndex.get(index)?.arguments || "",
                });
              }
            } else if (t === "response.function_call_arguments.delta") {
              const index = Number(obj.output_index ?? 0);
              const current = toolCallsByIndex.get(index) || {
                index,
                id: obj.call_id || `call_${index}`,
                name: obj.name || "",
                arguments: "",
              };
              current.arguments += obj.delta || "";
              toolCallsByIndex.set(index, current);
            } else if (t === "response.function_call_arguments.done") {
              const index = Number(obj.output_index ?? 0);
              const current = toolCallsByIndex.get(index) || {
                index,
                id: obj.call_id || `call_${index}`,
                name: obj.name || "",
                arguments: "",
              };
              current.arguments = obj.arguments || current.arguments;
              toolCallsByIndex.set(index, current);
            } else if (t === "response.completed") {
              this.collectCompletedToolCalls(obj.response, toolCallsByIndex);
              const usage = obj.response?.usage;
              if (usage) {
                const tokens = extractGrokCliTokenUsage(usage);
                inputTokens = tokens.inputTokens;
                outputTokens = tokens.outputTokens;
                upstreamCredits = extractGrokCliCredits(usage);
              }
            }
          } catch {
            /* skip */
          }
        }
        if (reachedDone) break;
      }

      if (reachedDone) await releaseReader(reader);

      const promptTokens = inputTokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = outputTokens || this.estimateTokens(text);
      const totalTokens = promptTokens + completionTokens;
      const toolCalls = this.toolCallsFromMap(toolCallsByIndex);
      const creditsUsed =
        upstreamCredits != null
          ? upstreamCredits
          : totalTokens > 0
            ? totalTokens * this.getProviderCreditRate(request.model)
            : 0;
      const creditSource = upstreamCredits != null ? ("upstream" as const) : ("estimated" as const);
      const resp: ChatCompletionResponse = {
        id: this.generateId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            } as any,
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
          ...(upstreamCredits != null ? { credits_used: upstreamCredits, credit: upstreamCredits } : {}),
        } as any,
      };
      return {
        success: true,
        response: resp,
        promptTokens,
        completionTokens,
        tokensUsed: totalTokens,
        creditsUsed,
        creditSource,
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const response = await this.makeRequest(account, request);
      if (!response.ok || !response.body) {
        return this.classifyErrorResponse(response);
      }

      const id = this.generateId();
      const model = request.model;
      const encoder = new TextEncoder();
      const upstream = response.body;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let started = false;
          let hasToolCalls = false;
          const toolCallsByIndex = new Map<number, PendingToolCall>();

          const emit = (delta: any, finish_reason: string | null = null, extra?: Record<string, unknown>) => {
            const chunk = {
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta, finish_reason }],
              ...extra,
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          };

          const emitUsageAndDone = (usage: unknown) => {
            if (!started) emit({ role: "assistant", content: "" });
            emit({}, hasToolCalls ? "tool_calls" : "stop");
            const tokens = extractGrokCliTokenUsage(usage);
            const credits = extractGrokCliCredits(usage);
            if (tokens.inputTokens > 0 || tokens.outputTokens > 0 || credits != null) {
              const total = tokens.inputTokens + tokens.outputTokens;
              emit(
                {},
                null,
                {
                  usage: {
                    prompt_tokens: tokens.inputTokens,
                    completion_tokens: tokens.outputTokens,
                    total_tokens: total,
                    ...(credits != null ? { credits_used: credits, credit: credits } : {}),
                  },
                },
              );
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          };

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let idx;
              while ((idx = buffer.indexOf("\n\n")) !== -1) {
                const event = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                let dataLine = "";
                for (const line of event.split("\n")) {
                  if (line.startsWith("data: ")) dataLine += line.slice(6);
                  else if (line.startsWith("data:")) dataLine += line.slice(5);
                }
                if (!dataLine) continue;
                if (dataLine === SSE_DONE_SENTINEL) {
                  // Terminal: the payload is complete. The upstream may hold the
                  // socket open, so stop reading and finish the response.
                  if (!started) emit({ role: "assistant" });
                  emit({}, hasToolCalls ? "tool_calls" : "stop");
                  controller.enqueue(encoder.encode(`data: ${SSE_DONE_SENTINEL}\n\n`));
                  controller.close();
                  await releaseReader(reader);
                  return;
                }
                try {
                  const obj = JSON.parse(dataLine);
                  const t = obj.type || "";
                  if (t === "response.output_text.delta") {
                    if (!started) {
                      started = true;
                      emit({ role: "assistant" });
                    }
                    emit({ content: obj.delta || "" });
                  } else if (t === "response.output_item.added" || t === "response.output_item.done") {
                    const item = obj.item || {};
                    if (item.type === "function_call") {
                      hasToolCalls = true;
                      const index = Number(obj.output_index ?? toolCallsByIndex.size);
                      const call = {
                        index,
                        id: item.call_id || item.id || `call_${index}`,
                        name: item.name || "",
                        arguments: item.arguments || toolCallsByIndex.get(index)?.arguments || "",
                      };
                      toolCallsByIndex.set(index, call);
                      if (!started) {
                        started = true;
                        emit({ role: "assistant" });
                      }
                      if (item.name) {
                        emit({
                          tool_calls: [
                            {
                              index,
                              id: call.id,
                              type: "function",
                              function: { name: call.name, arguments: "" },
                            },
                          ],
                        });
                      }
                    }
                  } else if (t === "response.function_call_arguments.delta") {
                    hasToolCalls = true;
                    const index = Number(obj.output_index ?? 0);
                    if (!started) {
                      started = true;
                      emit({ role: "assistant" });
                    }
                    emit({
                      tool_calls: [
                        {
                          index,
                          function: { arguments: obj.delta || "" },
                        },
                      ],
                    });
                  } else if (t === "response.completed") {
                    emitUsageAndDone(obj.response?.usage);
                    return;
                  } else if (t === "response.failed" || t === "error") {
                    if (!started) emit({ role: "assistant", content: "" });
                    emit({}, hasToolCalls ? "tool_calls" : "stop");
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    return;
                  }
                } catch {
                  /* skip */
                }
              }
            }
            if (!started) emit({ role: "assistant", content: "" });
            emit({}, hasToolCalls ? "tool_calls" : "stop");
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            try {
              controller.error(err);
            } catch {
              /* already errored */
            }
          }
        },
      });

      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.refresh_token) return { success: false, error: "No refresh token" };

    try {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: GROK_CLI_CLIENT_ID,
      });

      const response = await this.fetchWithTimeout(
        GROK_CLI_TOKEN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": GROK_CLI_UA,
          },
          body: form.toString(),
        },
        15000,
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `Refresh failed: HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const data = (await response.json()) as any;
      if (!data.access_token) return { success: false, error: "No access_token in refresh response" };

      const expiresIn = Number(data.expires_in) || 3600;
      const expiresAt = String(Math.floor(Date.now() / 1000) + expiresIn);

      return {
        success: true,
        tokens: JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token || tokens.refresh_token,
          id_token: data.id_token || tokens.id_token,
          expires_at: expiresAt,
          email: tokens.email,
          user_id: tokens.user_id,
          method: tokens.method || "device_code",
          subscription_tier: tokens.subscription_tier,
          has_grok_code_access: tokens.has_grok_code_access,
        }),
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!tokens?.access_token;
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) return { success: false, error: "No access_token" };

    try {
      const response = await this.fetchWithTimeout(
        GROK_CLI_BILLING_URL,
        {
          method: "GET",
          headers: this.proxyHeaders(tokens.access_token, tokens.email, tokens.user_id),
        },
        config.providerQuotaTimeoutMs,
      );

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      // 402 = out of credits but auth OK — surface as exhausted quota
      if (response.status === 402) {
        return { success: true, quota: { limit: 1, remaining: 0, used: 1 } };
      }
      if (!response.ok) {
        // unknown quota shape — don't kill account
        return { success: true, quota: { limit: -1, remaining: -1, used: 0 } };
      }

      const data = (await response.json()) as any;

      // Grok Build / cli-chat-proxy billing shapes (probed 2026-07-xx):
      //   format=credits → {config:{currentPeriod:{start,end,type}, onDemandCap:{val}, onDemandUsed:{val}, prepaidBalance:{val}, ...}}
      //   format=json    → {config:{monthlyLimit:{val}, used:{val}, onDemandCap:{val}, billingPeriodStart, billingPeriodEnd, history:[...]}}
      // Also tolerate legacy flat {limit, remaining, used} just in case.
      const cfg = data?.config ?? data ?? {};

      const numVal = (v: unknown): number => {
        if (v == null) return NaN;
        if (typeof v === "number") return v;
        if (typeof v === "object" && v !== null && "val" in (v as any)) {
          return Number((v as any).val);
        }
        return Number(v);
      };

      const limit = numVal(cfg.monthlyLimit ?? cfg.limit ?? cfg.credits_limit ?? cfg.total);
      const usedRaw = numVal(cfg.used ?? cfg.onDemandUsed ?? cfg.used_credits ?? cfg.credits_used);
      const prepaid = numVal(cfg.prepaidBalance);
      const onDemandCap = numVal(cfg.onDemandCap);
      const onDemandUsed = numVal(cfg.onDemandUsed);

      // Reset date from currentPeriod.end (credits) or billingPeriodEnd (json).
      const periodEnd =
        cfg.currentPeriod?.end || cfg.billingPeriodEnd || cfg.reset_at || cfg.resetAt || null;

      // Unknown shape → preserve account, report sentinel.
      if (
        !Number.isFinite(limit) &&
        !Number.isFinite(usedRaw) &&
        !Number.isFinite(prepaid) &&
        !Number.isFinite(onDemandCap)
      ) {
        return { success: true, quota: { limit: -1, remaining: -1, used: 0 } };
      }

      // Effective cap = monthly limit + onDemand cap (pay-as-you-go ceiling).
      // Effective remaining = cap - used (onDemand used counts against cap).
      const cap = (Number.isFinite(limit) ? limit : 0) + (Number.isFinite(onDemandCap) ? onDemandCap : 0);
      const used =
        (Number.isFinite(usedRaw) ? usedRaw : 0) +
        (Number.isFinite(onDemandUsed) && !Number.isFinite(usedRaw) ? onDemandUsed : 0);
      const remaining = Number.isFinite(cap) && cap > 0 ? Math.max(0, cap - used) : -1;

      return {
        success: true,
        quota: {
          limit: Number.isFinite(cap) && cap >= 0 ? cap : -1,
          remaining,
          used: Number.isFinite(used) ? used : 0,
          resetAt: periodEnd || null,
        },
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export async function fetchGrokCliUser(accessToken: string): Promise<any | null> {
  try {
    const res = await fetch(GROK_CLI_USER_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": GROK_CLI_UA,
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": GROK_CLI_VERSION,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
