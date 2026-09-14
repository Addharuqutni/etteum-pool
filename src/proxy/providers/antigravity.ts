import { BaseProvider, type ChatCompletionRequest, type ChatCompletionResponse, type ModelInfo, type ProviderResult } from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import { getNextProxy, markProxySuccess, markProxyFail } from "../../services/proxy-pool";
import { safeFetch } from "../../utils/ssrf";

/**
 * Antigravity — Google Cloud Code Assist agentic backend (Gemini 3, Claude,
 * GPT-OSS) via OAuth access token + provisioned project id.
 *
 * Ported from Cartethyia/9router: transport is the internal
 * `v1internal:streamGenerateContent?alt=sse` SSE endpoint on
 * `daily-cloudcode-pa.googleapis.com` with a sandbox fallback on 429/5xx.
 * Credential stored on the account as JSON `{accessToken,projectId,...}`.
 */
export const ANTIGRAVITY_OAUTH = {
  // Public installed-app OAuth client (Google Cloud Code Assist). These are not
  // confidential secrets (Google treats installed-app client secrets as
  // non-secret), so they are kept in source intentionally.
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userinfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  dailyEndpoint: "https://daily-cloudcode-pa.googleapis.com",
  sandboxEndpoint: "https://daily-cloudcode-pa.sandbox.googleapis.com",
  action: "v1internal:streamGenerateContent?alt=sse",
  loadCodeAssistUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  onboardUserUrl: "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
  userAgent: "antigravity/hub/2.1.4 windows/amd64",
} as const;

interface AntigravityTokens {
  accessToken: string;
  projectId: string;
  email?: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
}

const LOAD_CODE_ASSIST_METADATA: Readonly<Record<string, string>> = Object.freeze({
  ideType: "ANTIGRAVITY",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
});

// Model catalog — wire ids per Cartethyia reference.
interface WireModel {
  id: string; // local ag- id
  name: string;
  wire: string; // upstream model id
  modelEnum?: string; // model_enum label for gemini-3 wire models
  maxOutput: number;
  thinking: boolean;
  vision: boolean;
  image?: boolean; // image-generation model
}

const WIRE_MODELS: WireModel[] = [
  { id: "ag-gemini-3-8-flash-high", name: "Gemini 3.8 Flash (High)", wire: "gemini-3.8-flash-high(high)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-8-flash-medium", name: "Gemini 3.8 Flash (Medium)", wire: "gemini-3.8-flash-medium(medium)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-8-flash-low", name: "Gemini 3.8 Flash (Low)", wire: "gemini-3.8-flash-low(low)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-8-flash", name: "Gemini 3.8 Flash", wire: "gemini-3.8-flash-medium(medium)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-7-flash-high", name: "Gemini 3.7 Flash (High)", wire: "gemini-3.7-flash-tiered(high)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-7-flash-medium", name: "Gemini 3.7 Flash (Medium)", wire: "gemini-3.7-flash-tiered(medium)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-7-flash-low", name: "Gemini 3.7 Flash (Low)", wire: "gemini-3.7-flash-tiered(low)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-6-flash-high", name: "Gemini 3.6 Flash (High)", wire: "gemini-3.6-flash-tiered(high)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-6-flash-medium", name: "Gemini 3.6 Flash (Medium)", wire: "gemini-3.6-flash-tiered(medium)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-6-flash-low", name: "Gemini 3.6 Flash (Low)", wire: "gemini-3.6-flash-tiered(low)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-5-flash-high", name: "Gemini 3.5 Flash (High)", wire: "gemini-3.5-flash-high", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-flash-agent", name: "Gemini 3.5 Flash (High)", wire: "gemini-3-flash-agent", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-5-flash-low", name: "Gemini 3.5 Flash (Medium)", wire: "gemini-3.5-flash-low", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-5-flash-extra-low", name: "Gemini 3.5 Flash (Low)", wire: "gemini-3.5-flash-extra-low", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-pro-agent", name: "Gemini 3.1 Pro (High)", wire: "gemini-pro-agent", maxOutput: 65535, thinking: true, vision: true },
  { id: "ag-gemini-3-1-pro-low", name: "Gemini 3.1 Pro (Low)", wire: "gemini-3.1-pro-low", maxOutput: 65535, thinking: true, vision: true },
  { id: "ag-claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", wire: "claude-sonnet-4-6", maxOutput: 64000, thinking: true, vision: true },
  { id: "ag-claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", wire: "claude-opus-4-6-thinking", maxOutput: 64000, thinking: true, vision: true },
  { id: "ag-gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", wire: "gpt-oss-120b-medium", maxOutput: 65536, thinking: false, vision: false },
  { id: "ag-gemini-3-flash", name: "Gemini 3 Flash", wire: "gemini-3-flash", maxOutput: 65536, thinking: false, vision: true },
  { id: "ag-gemini-3-1-flash-image", name: "Gemini 3.1 Flash (Image)", wire: "gemini-3.1-flash-image", maxOutput: 65536, thinking: false, vision: true, image: true },
];

const AG_CONTEXT_WINDOW = 1_000_000;

/**
 * Outbound fetch for antigravity calls. Mirrors BaseProvider.fetchWithTimeout:
 * routes through the proxy pool ("model" purpose) and the safeFetch SSRF guard
 * (DNS + per-redirect re-check) — consistent with every other provider.
 */
async function antigravityFetch(url: string, init: RequestInit, timeoutMs = config.providerRequestTimeoutMs): Promise<Response> {
  const proxy = await getNextProxy("model");
  // `proxy` is a Bun-only RequestInit field (not in lib.dom types); safeFetch
  // spreads it through to the runtime fetch, so annotate via named const.
  const proxyInit = proxy ? ({ ...init, proxy: proxy.url } as unknown as RequestInit) : init;
  try {
    const response = await safeFetch(url, proxyInit, { timeoutMs });
    if (proxy) void markProxySuccess(proxy.id);
    return response;
  } catch (err) {
    if (proxy) void markProxyFail(proxy.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

function findWireModel(model: string): WireModel | undefined {
  const normalized = model.toLowerCase().replace(/^ag-/, "");
  return WIRE_MODELS.find((m) => m.id.replace(/^ag-/, "") === normalized || m.wire === model);
}

function parseAntigravityCredential(tokens: any): AntigravityTokens {
  if (typeof tokens === "string") {
    return JSON.parse(tokens) as AntigravityTokens;
  }
  return tokens as AntigravityTokens;
}

function encodeAntigravityCredential(cred: AntigravityTokens): string {
  return JSON.stringify({
    accessToken: cred.accessToken,
    projectId: cred.projectId,
    email: cred.email,
    refreshToken: cred.refreshToken,
    expiresAt: cred.expiresAt,
    scope: cred.scope,
  });
}

function readProjectId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
    if (id) return id;

    const cloudai = record.cloudaicompanionProject;
    if (cloudai && typeof cloudai === "object") {
      if (typeof cloudai === "string") return cloudai;
      const cloudaiRecord = cloudai as Record<string, unknown>;
      return typeof cloudaiRecord.id === "string" && cloudaiRecord.id.length > 0
        ? cloudaiRecord.id
        : undefined;
    }
  }
  return undefined;
}

/** Discover (or provision) the Cloud Code Assist project id.
 *
 * Ported from Cartethyia's AntigravityOAuthDriver.discoverProject: after token
 * exchange, loadCodeAssist may report no project yet; we then onboard the user
 * with the account's actual default tier (from allowedTiers, falling back to
 * legacy-tier), poll the long-running operation by name, and re-check
 * loadCodeAssist. Failures surface Google's ineligible-tier reasons so a stuck
 * "exchanging" login shows an actionable message instead of hanging.
 */
export async function discoverOrProvisionProject(accessToken: string): Promise<string> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "user-agent": ANTIGRAVITY_OAUTH.userAgent,
  };

  const loadAssist = async (): Promise<Record<string, unknown>> => {
    const response = await antigravityFetch(ANTIGRAVITY_OAUTH.loadCodeAssistUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata: LOAD_CODE_ASSIST_METADATA }),
    });
    return ((await response.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
  };

  // Project id may sit in the top-level object or nested under response for LROs.
  const projectIdOf = (value: unknown): string | undefined => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const direct = readProjectId(record);
    if (direct) return direct;
    const response = record.response;
    return response !== null && typeof response === "object"
      ? readProjectId(response as Record<string, unknown>)
      : undefined;
  };

  let loaded = await loadAssist();
  const existing = projectIdOf(loaded);
  if (existing) {
    console.log(`[Antigravity OAuth] found existing project: ${existing}`);
    return existing;
  }

  // Select the default tier Google declares for this account; fall back to legacy.
  const allowedTiers = Array.isArray(loaded.allowedTiers)
    ? (loaded.allowedTiers as unknown[]).filter(
        (t): t is Record<string, unknown> => t !== null && typeof t === "object" && !Array.isArray(t),
      )
    : [];
  const defaultTier = allowedTiers.find((t) => t.isDefault === true && typeof t.id === "string" && t.id.length > 0);
  const tierId = (typeof defaultTier?.id === "string" ? defaultTier.id : "legacy-tier") || "legacy-tier";
  console.log(`[Antigravity OAuth] no project yet; allowedTiers=[${allowedTiers.map((t) => String(t.id)).join(", ")}], onboarding tier=${tierId}`);

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const submitOnboard = async (): Promise<Record<string, unknown>> => {
    const response = await antigravityFetch(ANTIGRAVITY_OAUTH.onboardUserUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ tierId, metadata: LOAD_CODE_ASSIST_METADATA }),
    });
    return ((await response.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
  };

  // Long-running operation returned by onboardUser; poll it by name.
  const cloudcodeBase = new URL(ANTIGRAVITY_OAUTH.loadCodeAssistUrl).origin;
  const pollOperation = async (operationName: string): Promise<Record<string, unknown>> => {
    const response = await antigravityFetch(`${cloudcodeBase}/v1internal/${operationName}`, {
      method: "POST",
      headers,
    });
    return ((await response.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
  };

  let operation = await submitOnboard();
  const operationName = typeof operation.name === "string" ? operation.name.trim() : "";
  console.log(`[Antigravity OAuth] onboard submitted, operation=${operationName || "<none>"}, done=${operation.done ?? false}`);

  // Poll the provisioning operation up to ~2 minutes (24 × 5s).
  for (let attempt = 1; attempt < 24; attempt++) {
    await wait(5000);

    const projectId = projectIdOf(operation);
    if (projectId) return projectId;

    operation = operationName.length > 0
      ? await pollOperation(operationName)
      : await submitOnboard();

    const nextProject = projectIdOf(operation);
    if (nextProject) return nextProject;
    if (operation.done === true && !nextProject) break;
  }

  // Final re-check of loadCodeAssist once onboarding settles.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await wait(5000);
    loaded = await loadAssist();
    const pid = projectIdOf(loaded);
    if (pid) return pid;
  }

  const ineligibleReasons = Array.isArray(loaded.ineligibleTiers)
    ? (loaded.ineligibleTiers as unknown[])
        .map((t) => (t !== null && typeof t === "object" ? (t as Record<string, unknown>).reasonMessage : undefined))
        .filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
    : [];
  const detail = ineligibleReasons.length > 0
    ? ` Google reported: ${ineligibleReasons.join("; ")}`
    : allowedTiers.length > 0
      ? ` Available tiers: ${allowedTiers.map((t) => String(t.id)).join(", ")}.`
      : "";

  throw new Error(`Google did not expose a provisioned project id after onboarding.${detail}`);
}

// ============================================================================
// Session state + Gemini agent envelope (Cartethyia reference)
// ============================================================================

interface SessionState {
  agentId: string;
  trajectoryId: string;
  sessionId: string;
  stepIndex: number;
  /** Upstream execution id of the most recent step (relay back via labels). */
  lastExecutionId?: string;
}

/**
 * Identity prompt prepended as the first user content for Claude / Gemini-3
 * agent models (Cartethyia reference) so the agent reasons with its system
 * personality even without a systemInstruction slot.
 */
const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";

/** Thinking budget per effort tier (Cartethyia reference): low/medium get a
 * small/moderate budget, high/pro threads a large one. */
export function antigravityThinkingBudget(tier: "low" | "medium" | "high" | "pro"): number {
  switch (tier) {
    case "low": return 1000;
    case "medium": return 4000;
    case "pro": return 10001;
    default: return 10000;
  }
}

/** Resolve the effort tier for a wire model, honoring any request override. */
export function antigravityWireTier(
  wireModel: string,
  request: { reasoning_effort?: string; thinking?: { effort?: string } },
): "low" | "medium" | "high" | "pro" {
  const override = request.reasoning_effort ?? request.thinking?.effort;
  const norm = (typeof override === "string" ? override : "").toLowerCase();
  if (norm === "low" || norm === "medium" || norm === "high") return norm;
  if (norm === "pro" || norm === "max" || norm === "high_min" || norm === "high_max") return "pro";

  const w = wireModel.toLowerCase();
  if (w.includes("pro") || w.includes("-agent")) return "pro";
  if (/\((?:high)\)$/.test(w) || w.endsWith("-high")) return "high";
  if (/\((?:medium)\)$/.test(w) || w.endsWith("-medium")) return "medium";
  if (/\((?:low)\)$/.test(w) || w.endsWith("-low") || w.endsWith("-extra-low")) return "low";
  // Non-tiered thinking models (e.g. claude-*) use the default high budget.
  return "high";
}

/** Whether the request asks for live web search — maps to googleSearch tool. */
export function wantsWebSearch(request: { tools?: unknown[] }): boolean {
  if (!Array.isArray(request.tools)) return false;
  return request.tools.some((tool) => {
    if (tool === null || typeof tool !== "object") return false;
    const t = tool as Record<string, unknown>;
    const type = typeof t.type === "string" ? t.type : "";
    if (type === "web_search" || type === "web_search_preview") return true;
    const fn = t.function;
    return !!fn && typeof fn === "object" && (fn as Record<string, unknown>).name === "web_search";
  });
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response?: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface AntigravityRequestEnvelope {
  project: string;
  requestId: string;
  model: string;
  userAgent: string;
  requestType: "agent";
  labels: Record<string, string>;
  request: {
    contents: GeminiContent[];
    generationConfig: Record<string, unknown>;
    sessionId: string;
    systemInstruction?: { parts: GeminiPart[] };
    tools?: unknown[];
    toolConfig?: Record<string, unknown>;
  };
}

function numericSessionId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return String(Math.abs(hash) % 9007199254740991);
}

function convertOpenAIToGemini(messages: ChatCompletionRequest["messages"]): { contents: GeminiContent[]; systemTexts: string[] } {
  const contents: GeminiContent[] = [];
  const systemTexts: string[] = [];
  let currentRole: "user" | "model" = "user";
  let currentParts: GeminiPart[] = [];

  const flush = () => {
    if (currentParts.length > 0) {
      contents.push({ role: currentRole, parts: currentParts });
      currentParts = [];
    }
  };

  for (const msg of messages) {
    // Tool results arrive as role:"tool" — render as a user functionResponse part.
    if (msg.role === "tool") {
      flush();
      currentRole = "user";
      let parsed: Record<string, unknown> | undefined;
      try { parsed = typeof msg.content === "string" ? JSON.parse(msg.content) : undefined; } catch { /* raw string */ }
      currentParts.push({
        functionResponse: {
          name: msg.tool_call_id || "tool",
          response: parsed ?? { result: String(msg.content ?? "") },
        },
      });
      continue;
    }

    if (msg.role === "system") {
      if (typeof msg.content === "string") systemTexts.push(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const item of msg.content as { type?: string; text?: string }[]) {
          if (item.type === "text" && item.text) systemTexts.push(item.text);
        }
      }
      continue;
    }

    const role: "user" | "model" = msg.role === "assistant" ? "model" : "user";
    if (role !== currentRole) flush();
    currentRole = role;

    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls as { function?: { name?: string; arguments?: string } }[]) {
        let args: Record<string, unknown> | undefined;
        try { args = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments) : undefined; } catch { /* raw */ }
        currentParts.push({ functionCall: { name: call.function?.name || "", args } });
      }
    }

    if (Array.isArray(msg.content)) {
      for (const item of msg.content as { type?: string; text?: string; image_url?: { url?: string } }[]) {
        if (item.type === "text") {
          currentParts.push({ text: item.text });
        } else if (item.type === "image_url") {
          const url: string = item.image_url?.url || "";
          const base64 = url.includes(",") ? url.split(",")[1] || "" : url;
          const mimeType = url.startsWith("data:") ? (url.match(/data:([^;]+);/)?.[1] || "image/jpeg") : "image/jpeg";
          currentParts.push({ inlineData: { mimeType, data: base64 } });
        }
      }
    } else if (typeof msg.content === "string" && msg.content) {
      currentParts.push({ text: msg.content });
    }
  }

  flush();
  return { contents, systemTexts };
}

function buildAntigravityRequest(
  request: ChatCompletionRequest,
  credential: AntigravityTokens,
  state: SessionState,
): AntigravityRequestEnvelope {
  const wm = findWireModel(request.model);
  const wireModel = wm?.wire || request.model.replace(/^ag-/, "");
  state.stepIndex += 1;

  let { contents, systemTexts } = convertOpenAIToGemini(request.messages);

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: Math.min(request.max_tokens ?? wm?.maxOutput ?? 8192, wm?.maxOutput ?? 65536),
  };
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.top_p !== undefined) generationConfig.topP = request.top_p;
  if (wm?.thinking) {
    // Effort-tier thinking budget (Cartethyria reference): low/medium/high/pro.
    const tier = antigravityWireTier(wireModel, request);
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: antigravityThinkingBudget(tier) };
  }

  const labels: Record<string, string> = {
    ...(state.lastExecutionId ? { last_execution_id: state.lastExecutionId } : {}),
    trajectory_id: state.trajectoryId,
    last_step_index: String(state.stepIndex - 1),
    used_claude: String(wireModel.startsWith("claude")),
    used_claude_conservative: String(wireModel.startsWith("claude")),
  };
  if (wm?.modelEnum) labels.model_enum = wm.modelEnum;

  // Identity prompt for Claude / Gemini-3 agent models (Cartethyia reference).
  const isAgentModel = wireModel.startsWith("claude") || wireModel.includes("gemini-3");
  const hasIdentity = contents.some(
    (c) => Array.isArray(c.parts) && c.parts.some((p) => p.text === ANTIGRAVITY_SYSTEM_INSTRUCTION),
  );
  if (isAgentModel && !hasIdentity && contents.length > 0) {
    contents = [{ role: "user", parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }] }, ...contents];
  }

  const payload: AntigravityRequestEnvelope["request"] = {
    contents: contents.length > 0 ? contents : [{ role: "user", parts: [{ text: "" }] }],
    generationConfig,
    sessionId: state.sessionId,
  };
  if (systemTexts.length > 0) {
    payload.systemInstruction = { parts: [{ text: systemTexts.join("\n\n") }] };
  }
  // Live web search → googleSearch tool.
  if (wantsWebSearch(request)) {
    payload.tools = [...(Array.isArray(payload.tools) ? payload.tools : []), { googleSearch: {} }];
  }
  // Claude requires validated function calling.
  if (wireModel.startsWith("claude") && !payload.toolConfig) {
    payload.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }

  return {
    project: credential.projectId,
    requestId: `agent/${state.agentId}/${Date.now()}/${state.trajectoryId}/${state.stepIndex}`,
    model: wireModel,
    userAgent: "antigravity",
    requestType: "agent",
    labels,
    request: payload,
  };
}

async function fetchAntigravitySse(env: AntigravityRequestEnvelope, credential: AntigravityTokens): Promise<Response> {
  const headers = {
    "Authorization": `Bearer ${credential.accessToken}`,
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "User-Agent": ANTIGRAVITY_OAUTH.userAgent,
  };
  const body = JSON.stringify(env);

  const primary = await antigravityFetch(`${ANTIGRAVITY_OAUTH.dailyEndpoint}/${ANTIGRAVITY_OAUTH.action}`, {
    method: "POST",
    headers,
    body,
  });
  if (primary.ok || (primary.status !== 429 && primary.status < 500)) return primary;

  // Sandbox fallback on 429/5xx (Cartethyia pattern).
  const fallback = await antigravityFetch(`${ANTIGRAVITY_OAUTH.sandboxEndpoint}/${ANTIGRAVITY_OAUTH.action}`, {
    method: "POST",
    headers,
    body,
  });
  return fallback.ok ? fallback : primary;
}

interface GeminiFrame {
  responseId?: string;
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  response?: GeminiFrame;
}

/** Parse an SSE body into Gemini frames, hoisting the nested `response` object. */
async function* parseGeminiSse(response: Response): AsyncGenerator<GeminiFrame> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as GeminiFrame;
          const frame = parsed.response ?? parsed;
          // Cloud Code Assist nests usageMetadata inside the response object;
          // hoist it to the top level (Cartethyia reference) so token
          // accounting and quota tracking see the real usage.
          if (parsed.response && !frame.usageMetadata && parsed.response.usageMetadata) {
            yield { ...frame, usageMetadata: parsed.response.usageMetadata };
          } else {
            yield frame;
          }
        } catch { /* skip malformed frame */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

function mapFinishReason(reason?: string): string {
  if (reason === "MAX_TOKENS") return "length";
  return "stop";
}

export class AntigravityProvider extends BaseProvider {
  readonly name = "antigravity" as const;

  supportedModels: ModelInfo[] = WIRE_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: 1700000000,
    owned_by: "antigravity",
    context_window: AG_CONTEXT_WINDOW,
    max_output: m.maxOutput,
    thinking: m.thinking,
    vision: m.vision,
    creditUnit: "token" as const,
    creditRate: 1 / 1000,
    creditSource: "estimated" as const,
  }));

  private sessionStates = new Map<string, SessionState>();

  private getState(accountId: string): SessionState {
    let state = this.sessionStates.get(accountId);
    if (!state) {
      state = {
        agentId: crypto.randomUUID(),
        trajectoryId: crypto.randomUUID(),
        sessionId: numericSessionId(accountId),
        stepIndex: 0,
      };
      this.sessionStates.set(accountId, state);
    }
    return state;
  }

  override ownsModel(model: string): boolean {
    return model.startsWith("ag-");
  }

  private buildRequest(account: Account, request: ChatCompletionRequest) {
    const credential = parseAntigravityCredential(account.tokens);
    if (!credential.accessToken || !credential.projectId) {
      throw new Error("Missing accessToken/projectId in antigravity credentials");
    }
    const state = this.getState(String(account.id));
    const env = buildAntigravityRequest(request, credential, state);
    return { credential, state, env };
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const { credential, state, env } = this.buildRequest(account, request);
      const response = await fetchAntigravitySse(env, credential);
      if (!response.ok) {
        const errorText = (await response.text().catch(() => "")).slice(0, 500);
        return {
          success: false,
          error: `Antigravity API error (${response.status}): ${errorText}`,
          rateLimited: response.status === 429,
          quotaExhausted: response.status === 429,
        };
      }

      // Fold the SSE stream into one non-stream Gemini response.
      let text = "";
      const toolCalls: { id: string; name: string; arguments: string }[] = [];
      let finishReason: string | null = null;
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      for await (const frame of parseGeminiSse(response)) {
        if (frame.responseId) state.lastExecutionId = frame.responseId;
        const parts = frame.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (typeof part.text === "string" && part.text) text += part.text;
          if (part.functionCall?.name) {
            toolCalls.push({
              id: `call_${toolCalls.length}`,
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            });
          }
        }
        if (frame.candidates?.[0]?.finishReason) finishReason = frame.candidates[0].finishReason;
        if (frame.usageMetadata) {
          usage = {
            prompt_tokens: frame.usageMetadata.promptTokenCount || usage.prompt_tokens,
            completion_tokens: frame.usageMetadata.candidatesTokenCount || usage.completion_tokens,
            total_tokens: frame.usageMetadata.totalTokenCount || usage.total_tokens,
          };
        }
      }

      const message: Record<string, unknown> = { role: "assistant", content: text };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }

      const body: ChatCompletionResponse = {
        id: this.generateId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [
          {
            index: 0,
            message: message as unknown as ChatCompletionResponse["choices"][0]["message"],
            finish_reason: toolCalls.length > 0 ? "tool_calls" : mapFinishReason(finishReason ?? undefined),
          },
        ],
        usage,
      };
      return {
        success: true,
        response: body,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        tokensUsed: usage.total_tokens,
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const { credential, state, env } = this.buildRequest(account, request);
      const response = await fetchAntigravitySse(env, credential);
      if (!response.ok) {
        const errorText = (await response.text().catch(() => "")).slice(0, 500);
        return {
          success: false,
          error: `Antigravity API error (${response.status}): ${errorText}`,
          rateLimited: response.status === 429,
          quotaExhausted: response.status === 429,
        };
      }

      const encoder = new TextEncoder();
      const self = this;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = (
            delta: Record<string, unknown>,
            finish: string | null = null,
            usage?: Record<string, unknown>,
          ) => {
            const chunk = {
              id: self.generateId(),
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{ index: 0, delta, finish_reason: finish }],
              ...(usage ? { usage } : {}),
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          };

          let started = false;
          let usageOut: Record<string, unknown> | undefined;
          let sawToolCalls = false;
          let toolIndex = 0;

          try {
            for await (const frame of parseGeminiSse(response)) {
              if (frame.responseId) state.lastExecutionId = frame.responseId;
              const parts = frame.candidates?.[0]?.content?.parts || [];
              for (const part of parts) {
                if (typeof part.text === "string" && part.text) {
                  if (!started) {
                    started = true;
                    emit({ role: "assistant", content: "" });
                  }
                  emit({ content: part.text });
                }
                if (part.functionCall?.name) {
                  sawToolCalls = true;
                  emit({
                    tool_calls: [{
                      index: toolIndex,
                      id: `call_${toolIndex}`,
                      type: "function",
                      function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
                    }],
                  });
                  toolIndex += 1;
                }
              }
              if (frame.usageMetadata) {
                const usage = frame.usageMetadata;
                usageOut = {
                  prompt_tokens: usage.promptTokenCount || 0,
                  completion_tokens: usage.candidatesTokenCount || 0,
                  total_tokens: usage.totalTokenCount || 0,
                };
              }
              if (frame.candidates?.[0]?.finishReason) {
                emit({}, sawToolCalls ? "tool_calls" : mapFinishReason(frame.candidates[0].finishReason));
              }
            }
            if (usageOut) emit({}, null, usageOut);
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      });

      return { success: true, stream };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const credential = parseAntigravityCredential(account.tokens);
    if (!credential.refreshToken) {
      return { success: false, error: "No refresh token" };
    }

    try {
      const response = await antigravityFetch(ANTIGRAVITY_OAUTH.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          client_id: ANTIGRAVITY_OAUTH.clientId,
          client_secret: ANTIGRAVITY_OAUTH.clientSecret,
        }),
      }, config.providerRequestTimeoutMs);

      if (!response.ok) {
        const text = (await response.text().catch(() => "")).slice(0, 200);
        return { success: false, error: `Refresh failed: HTTP ${response.status}: ${text}` };
      }

      const tokens = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!tokens.access_token) return { success: false, error: "No access_token in refresh response" };

      const updated: AntigravityTokens = {
        ...credential,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || credential.refreshToken,
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : credential.expiresAt,
      };
      account.tokens = encodeAntigravityCredential(updated);
      return { success: true, tokens: JSON.stringify(updated) };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    try {
      const credential = parseAntigravityCredential(account.tokens);
      if (!credential.accessToken || !credential.projectId) return false;

      const response = await antigravityFetch(ANTIGRAVITY_OAUTH.loadCodeAssistUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          "content-type": "application/json",
          "user-agent": ANTIGRAVITY_OAUTH.userAgent,
        },
        body: JSON.stringify({ metadata: LOAD_CODE_ASSIST_METADATA }),
      }, config.providerRequestTimeoutMs);
      return response.ok;
    } catch {
      return false;
    }
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    // Antigravity exposes model quotas via the internal fetchAvailableModels RPC
    // (Cartethyia reference). Each model reports a remainingFraction + resetTime
    // for daily/weekly quota windows; we aggregate to the worst-case remaining.
    const credential = parseAntigravityCredential(account.tokens);
    if (!credential.accessToken) return { success: true };

    try {
      const response = await this.fetchWithTimeout(
        "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.accessToken}`,
            "content-type": "application/json",
            "user-agent": ANTIGRAVITY_OAUTH.userAgent,
            "x-client-name": "antigravity",
            "x-client-version": "1.0.0",
          },
          body: JSON.stringify({ project: credential.projectId || "" }),
        },
        config.providerQuotaTimeoutMs,
      );

      if (!response.ok) {
        const text = (await response.text().catch(() => "")).slice(0, 200);
        // 401/403 = token invalid, not quota — surface as unsupported so health
        // stays non-exhausted (token validity is checked separately).
        return { success: false, error: `not support: quota endpoint ${response.status}: ${text}` };
      }

      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return { success: true };

      // Group quota windows by model family (google / claude / model:<id>) so a
      // drained window in one family doesn't falsely exhaust unrelated models —
      // Cartethyia reference groups windows per family before reporting.
      const familyOf = (modelId: string): string =>
        /^(?:gemini[-_]|tab_)/i.test(modelId) ? "google"
        : /^(?:claude[-_]|gpt-oss[-_])/i.test(modelId) ? "claude"
        : `model:${modelId}`;

      const families = new Map<string, { remaining: number; reset?: string }>();
      const models = (body.models ?? body.modelQuotas ?? body.quota ?? {}) as Record<string, unknown>;
      for (const [modelId, raw] of Object.entries(models)) {
        const model = raw as Record<string, unknown>;
        if (!model || model.isInternal === true) continue;
        const family = familyOf(modelId);
        let current = families.get(family) ?? { remaining: 1, reset: undefined };
        for (const slot of ["quotaInfo", "dailyQuotaInfo", "weeklyQuotaInfo", "quotaInfos", "dailyQuotaInfos", "weeklyQuotaInfos"] as const) {
          const value = model[slot];
          const entries = Array.isArray(value) ? value : [value];
          for (const infoRaw of entries) {
            const info = infoRaw as Record<string, unknown>;
            if (!info || typeof info !== "object") continue;
            const fraction = typeof info.remainingFraction === "number" ? info.remainingFraction : parseFloat(String(info.remainingFraction));
            if (!Number.isFinite(fraction)) continue;
            const reset = typeof info.resetTime === "string" ? info.resetTime : undefined;
            const remaining = Math.max(0, Math.min(1, fraction));
            current = {
              remaining: Math.min(current.remaining, remaining),
              reset: (reset !== undefined && (current.reset === undefined || Date.parse(reset) < Date.parse(current.reset)))
                ? reset
                : current.reset,
            };
          }
        }
        families.set(family, current);
      }

      if (families.size === 0) return { success: true };

      // Worst-case across families serves as the overall utilization signal.
      const familyEntries = [...families.values()];
      const minRemaining = Math.min(...familyEntries.map((f) => f.remaining));
      const resetAt = familyEntries.filter((f) => f.reset).map((f) => f.reset!)
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0];

      const remaining = Math.round(Math.max(0, minRemaining) * 100);
      return {
        success: true,
        quota: {
          limit: 100,
          remaining,
          used: 100 - remaining,
          resetAt,
        },
      };
    } catch {
      // Transient failure — keep health optimistic (non-exhausted).
      return { success: true };
    }
  }
}

export const antigravityProvider = new AntigravityProvider();
