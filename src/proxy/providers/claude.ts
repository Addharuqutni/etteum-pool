import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";

// ============================================================================
// Claude (Claude.ai / Claude Code OAuth) Provider
//
// Pools Claude Pro/Max subscription sessions via the Claude Code OAuth client.
// Proxy-facing model ids use the `cc-` prefix so they never collide with kiro's
// bare `claude-*` catalog. Upstream ids are the real Anthropic model names.
//
// Auth: Authorization: Bearer <oauth access_token>
// Beta:  anthropic-beta: oauth-2025-04-20
// ============================================================================

export const CLAUDE_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  tokenUrlAlt: "https://platform.claude.com/v1/oauth/token",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scopes: "org:create_api_key user:profile user:inference",
  apiBase: "https://api.anthropic.com",
  anthropicVersion: "2023-06-01",
  anthropicBeta: "oauth-2025-04-20",
} as const;

interface ClaudeModelDef {
  id: string;
  upstream: string;
  context_window: number;
  max_output: number;
  thinking: boolean;
  vision: boolean;
  creditRate: number;
}

const CC_MODELS: ClaudeModelDef[] = [
  {
    id: "cc-claude-opus-4-8",
    upstream: "claude-opus-4-8",
    context_window: 200000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.045 / 1000,
  },
  {
    id: "cc-claude-opus-4-7",
    upstream: "claude-opus-4-7",
    context_window: 200000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.045 / 1000,
  },
  {
    id: "cc-claude-opus-4-6",
    upstream: "claude-opus-4-6",
    context_window: 200000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.045 / 1000,
  },
  {
    id: "cc-claude-sonnet-4-6",
    upstream: "claude-sonnet-4-6",
    context_window: 200000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.009 / 1000,
  },
  {
    id: "cc-claude-sonnet-4-5",
    upstream: "claude-sonnet-4-5-20250929",
    context_window: 200000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.009 / 1000,
  },
  {
    id: "cc-claude-haiku-4-5",
    upstream: "claude-haiku-4-5-20251001",
    context_window: 200000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.003 / 1000,
  },
];

const MODEL_BY_ID: Record<string, ClaudeModelDef> = Object.fromEntries(
  CC_MODELS.map((m) => [m.id.toLowerCase(), m]),
);

export interface ClaudeTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number | string;
  email?: string;
  account_id?: string;
  subscription_type?: string;
  method?: string;
}

export function buildClaudeAuthorizeUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_OAUTH.clientId,
    response_type: "code",
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    scope: CLAUDE_OAUTH.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${CLAUDE_OAUTH.authUrl}?${params.toString()}`;
}

export async function exchangeClaudeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  state?: string;
}): Promise<ClaudeTokens> {
  // Paste format from Claude OAuth success page: CODE#STATE
  const raw = input.code.trim();
  const [authCode, pastedState] = raw.includes("#") ? raw.split("#", 2) : [raw, undefined];
  const state = pastedState || input.state;

  const payload = {
    code: authCode,
    grant_type: "authorization_code",
    client_id: CLAUDE_OAUTH.clientId,
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    code_verifier: input.codeVerifier,
    ...(state ? { state } : {}),
  };

  const data = await postClaudeToken(payload);
  return normalizeClaudeTokenResponse(data);
}

export async function refreshClaudeAccessToken(refreshToken: string): Promise<ClaudeTokens> {
  const data = await postClaudeToken({
    grant_type: "refresh_token",
    client_id: CLAUDE_OAUTH.clientId,
    refresh_token: refreshToken,
  });
  return normalizeClaudeTokenResponse(data, refreshToken);
}

async function postClaudeToken(payload: Record<string, string>): Promise<any> {
  const urls = [CLAUDE_OAUTH.tokenUrl, CLAUDE_OAUTH.tokenUrlAlt];
  let lastError = "Token exchange failed";

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      const text = await response.text().catch(() => "");
      let data: any = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (!response.ok) {
        lastError = data?.error_description || data?.error || data?.message || `HTTP ${response.status}: ${text.slice(0, 200)}`;
        continue;
      }
      if (!data.access_token) {
        lastError = "No access_token in token response";
        continue;
      }
      return data;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(lastError);
}

function normalizeClaudeTokenResponse(data: any, fallbackRefresh?: string): ClaudeTokens {
  const expiresIn = Number(data.expires_in) || 3600;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || fallbackRefresh,
    expires_at: expiresAt,
    email: data.account?.email || data.email,
    account_id: data.account?.uuid || data.account?.id || data.account_id,
    subscription_type: data.account?.subscription_type || data.subscription_type,
    method: "oauth_pkce",
  };
}

export async function fetchClaudeProfile(accessToken: string): Promise<{
  email?: string;
  accountId?: string;
  displayName?: string;
  subscriptionType?: string;
}> {
  try {
    const response = await fetch(`${CLAUDE_OAUTH.apiBase}/api/oauth/claude_cli/roles`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": CLAUDE_OAUTH.anthropicVersion,
        "anthropic-beta": CLAUDE_OAUTH.anthropicBeta,
      },
    });
    if (!response.ok) return {};
    const data = (await response.json().catch(() => ({}))) as any;
    const account = data?.account || data?.organizations?.[0] || data;
    return {
      email: account?.email || data?.email,
      accountId: account?.uuid || account?.id || data?.account_uuid,
      displayName: account?.name || account?.display_name,
      subscriptionType: account?.subscription_type || data?.subscription_type,
    };
  } catch {
    return {};
  }
}

export class ClaudeProvider extends BaseProvider {
  name = "claude";
  override nativeFormat: "openai" | "anthropic" = "openai";

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("cc-");
  }

  supportedModels: ModelInfo[] = CC_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: Date.now(),
    owned_by: "claude",
    context_window: m.context_window,
    max_output: m.max_output,
    thinking: m.thinking,
    vision: m.vision,
    creditUnit: "token" as const,
    creditRate: m.creditRate,
    creditSource: "estimated" as const,
  }));

  private resolveModel(model: string): ClaudeModelDef | null {
    return MODEL_BY_ID[model.toLowerCase()] ?? null;
  }

  private getTokens(account: Account): ClaudeTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as ClaudeTokens;
    } catch {
      return null;
    }
  }

  private isExpired(tokens: ClaudeTokens): boolean {
    if (!tokens.expires_at) return false;
    const exp = Number(tokens.expires_at);
    if (!Number.isFinite(exp)) return false;
    // treat as expired 60s early
    return Date.now() / 1000 >= exp - 60;
  }

  private authHeaders(accessToken: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "anthropic-version": CLAUDE_OAUTH.anthropicVersion,
      "anthropic-beta": CLAUDE_OAUTH.anthropicBeta,
    };
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown Claude model: ${request.model}` };

    const tokens = this.getTokens(account);
    if (!tokens?.access_token) return { success: false, error: "No Claude OAuth tokens" };

    const body = this.toAnthropicRequest(request, def, false);
    try {
      const response = await this.fetchWithTimeout(`${CLAUDE_OAUTH.apiBase}/v1/messages`, {
        method: "POST",
        headers: this.authHeaders(tokens.access_token),
        body: JSON.stringify(body),
      });

      const errResult = await this.handleErrorResponse(response);
      if (errResult) return errResult;

      const data = await response.json();
      const mapped = this.fromAnthropicResponse(data, request.model);
      const promptTokens = mapped.usage.prompt_tokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = mapped.usage.completion_tokens || 0;
      return {
        success: true,
        response: mapped,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown Claude model: ${request.model}` };

    const tokens = this.getTokens(account);
    if (!tokens?.access_token) return { success: false, error: "No Claude OAuth tokens" };

    const body = this.toAnthropicRequest(request, def, true);
    try {
      const response = await this.fetchWithTimeout(`${CLAUDE_OAUTH.apiBase}/v1/messages`, {
        method: "POST",
        headers: { ...this.authHeaders(tokens.access_token), Accept: "text/event-stream" },
        body: JSON.stringify(body),
      });

      const errResult = await this.handleErrorResponse(response);
      if (errResult) return errResult;
      if (!response.body) return { success: false, error: "Claude response missing body" };

      return {
        success: true,
        stream: this.transformAnthropicStream(response.body, request.model),
        promptTokens: 0,
        completionTokens: 0,
        tokensUsed: 0,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.refresh_token) return { success: false, error: "No refresh token" };

    try {
      const next = await refreshClaudeAccessToken(tokens.refresh_token);
      return {
        success: true,
        tokens: JSON.stringify({
          ...tokens,
          ...next,
          email: next.email || tokens.email,
          account_id: next.account_id || tokens.account_id,
          subscription_type: next.subscription_type || tokens.subscription_type,
          method: "oauth_pkce",
        }),
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) return false;
    if (this.isExpired(tokens) && !tokens.refresh_token) return false;
    return true;
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) return { success: false, error: "No Claude OAuth tokens" };

    // OAuth Pro/Max has no stable public quota API — probe auth with a tiny call surface.
    try {
      const response = await this.fetchWithTimeout(`${CLAUDE_OAUTH.apiBase}/v1/messages`, {
        method: "POST",
        headers: this.authHeaders(tokens.access_token),
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      }, 15000);

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        return {
          success: true,
          quota: { limit: 100, remaining: 0, used: 100, resetAt: null },
        };
      }
      // drain body
      await response.text().catch(() => "");
      return {
        success: true,
        quota: { limit: -1, remaining: -1, used: 0, resetAt: null },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async handleErrorResponse(response: Response): Promise<ProviderResult | null> {
    if (response.ok) return null;
    if (response.status === 401 || response.status === 403) {
      return { success: false, error: `expired: HTTP ${response.status}` };
    }
    if (response.status === 429) {
      const text = await response.text().catch(() => "");
      return { success: false, error: text || "Rate limited", rateLimited: true };
    }
    const text = await response.text().catch(() => "");
    return { success: false, error: `Claude HTTP ${response.status}: ${text.slice(0, 200)}` };
  }

  private toAnthropicRequest(
    request: ChatCompletionRequest,
    def: ClaudeModelDef,
    stream: boolean,
  ): Record<string, unknown> {
    const systemParts: string[] = [];
    const messages: Array<{ role: string; content: unknown }> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        if (text) systemParts.push(text);
        continue;
      }

      if (msg.role === "tool") {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? (msg.content as any[]).map((b) => (b?.type === "text" ? b.text : JSON.stringify(b))).join("\n")
              : "";
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: (msg as any).tool_call_id,
              content,
            },
          ],
        });
        continue;
      }

      if (msg.role === "assistant" && (msg as any).tool_calls?.length) {
        const blocks: any[] = [];
        if (typeof msg.content === "string" && msg.content) {
          blocks.push({ type: "text", text: msg.content });
        }
        for (const tc of (msg as any).tool_calls as any[]) {
          let input: any = {};
          try {
            input = typeof tc.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments || {};
          } catch {
            input = { _raw: tc.function?.arguments };
          }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name,
            input,
          });
        }
        messages.push({ role: "assistant", content: blocks });
        continue;
      }

      messages.push({
        role: msg.role === "tool" ? "user" : msg.role,
        content: msg.content,
      });
    }

    const body: Record<string, unknown> = {
      model: def.upstream,
      messages,
      max_tokens: Math.min(request.max_tokens || 4096, def.max_output),
      stream,
    };
    if (systemParts.length > 0) body.system = systemParts.join("\n\n");
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools
        .map((t: any) => {
          if (t?.name && t?.input_schema) return t;
          const fn = t?.function;
          if (!fn?.name) return null;
          return {
            name: fn.name,
            description: fn.description || "",
            input_schema: fn.parameters || { type: "object", properties: {} },
          };
        })
        .filter(Boolean);
    }
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    if (request.thinking) body.thinking = request.thinking;

    return body;
  }

  private fromAnthropicResponse(data: any, originalModel: string): ChatCompletionResponse {
    const content: any[] = Array.isArray(data?.content) ? data.content : [];
    const textContent = content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text || "")
      .join("");

    const toolCalls = content
      .filter((c: any) => c?.type === "tool_use")
      .map((c: any, i: number) => ({
        id: c.id || `call_${i}`,
        type: "function" as const,
        function: { name: c.name || "", arguments: JSON.stringify(c.input || {}) },
      }));

    const inputTokens = Number(data?.usage?.input_tokens) || 0;
    const outputTokens = Number(data?.usage?.output_tokens) || 0;
    const finishReason =
      data?.stop_reason === "tool_use"
        ? "tool_calls"
        : data?.stop_reason === "max_tokens"
          ? "length"
          : "stop";

    return {
      id: data?.id || this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: textContent,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          } as any,
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
  }

  private transformAnthropicStream(
    anthropicStream: ReadableStream<Uint8Array>,
    originalModel: string,
  ): ReadableStream<Uint8Array> {
    const reader = anthropicStream.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const id = this.generateId();
    let buffer = "";
    let started = false;

    const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: originalModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";

            for (const part of parts) {
              const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;

              const payload = dataLine.slice(6).trim();
              if (payload === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              try {
                const event = JSON.parse(payload);

                if (event.type === "message_start" && !started) {
                  started = true;
                  controller.enqueue(makeChunk({ role: "assistant" }));
                }

                if (event.type === "content_block_delta") {
                  const text = event.delta?.text || "";
                  if (text) controller.enqueue(makeChunk({ content: text }));
                }

                if (event.type === "message_stop") {
                  controller.enqueue(makeChunk({}, "stop"));
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                  return;
                }
              } catch {
                /* skip malformed */
              }
            }
          }

          if (!started) controller.enqueue(makeChunk({ role: "assistant", content: "" }));
          controller.enqueue(makeChunk({}, "stop"));
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
  }
}
