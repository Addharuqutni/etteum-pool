import { BaseProvider, type ChatCompletionRequest, type ChatCompletionResponse, type ModelInfo, type ProviderHealthResult, type ProviderResult } from "./base";
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
  // Public installed-app OAuth client (Google Cloud Code Assist), same values
  // as decolua/9router. Not confidential, but kept out of committed source —
  // loaded from env config (see .env.example).
  clientId: config.antigravityOAuthClientId,
  clientSecret: config.antigravityOAuthClientSecret,
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
  maxOutput: number;
  thinking: boolean;
  vision: boolean;
  image?: boolean; // image-generation model
}

export const WIRE_MODELS: WireModel[] = [
  { id: "ag-gemini-3-8-flash-high", name: "Gemini 3.8 Flash (High)", wire: "gemini-3.8-flash-tiered(high)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-8-flash-medium", name: "Gemini 3.8 Flash (Medium)", wire: "gemini-3.8-flash-tiered(medium)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-8-flash-low", name: "Gemini 3.8 Flash (Low)", wire: "gemini-3.8-flash-tiered(low)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-8-flash", name: "Gemini 3.8 Flash", wire: "gemini-3.8-flash-tiered(medium)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-7-flash-high", name: "Gemini 3.7 Flash (High)", wire: "gemini-3.7-flash-tiered(high)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-7-flash-medium", name: "Gemini 3.7 Flash (Medium)", wire: "gemini-3.7-flash-tiered(medium)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-7-flash-low", name: "Gemini 3.7 Flash (Low)", wire: "gemini-3.7-flash-tiered(low)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-6-flash-high", name: "Gemini 3.6 Flash (High)", wire: "gemini-3.6-flash-tiered(high)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-6-flash-medium", name: "Gemini 3.6 Flash (Medium)", wire: "gemini-3.6-flash-tiered(medium)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-6-flash-low", name: "Gemini 3.6 Flash (Low)", wire: "gemini-3.6-flash-tiered(low)", maxOutput: 65536, thinking: true, vision: true },
  // Upstream retired the gemini-3.5-flash family: `gemini-3.5-flash-*` and
  // `gemini-3-flash-agent` still answer 200, but the body is a hard-coded
  // deprecation notice ("Gemini 3.5 Flash is no longer available. Please switch
  // to Gemini 3.7 Flash...") instead of an answer — a poisoned success that
  // reaches the user as the assistant's reply. They are routed to the tiered
  // 3.7 family that the upstream notice itself points at, keeping the
  // client-facing ids stable.
  { id: "ag-gemini-3-5-flash-high", name: "Gemini 3.5 Flash (High)", wire: "gemini-3.7-flash-tiered(high)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-flash-agent", name: "Gemini 3.5 Flash (High)", wire: "gemini-3.7-flash-tiered(high)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-5-flash-low", name: "Gemini 3.5 Flash (Medium)", wire: "gemini-3.7-flash-tiered(medium)", maxOutput: 65536, thinking: true, vision: true },
  { id: "ag-gemini-3-5-flash-extra-low", name: "Gemini 3.5 Flash (Low)", wire: "gemini-3.7-flash-tiered(low)", maxOutput: 65536, thinking: true, vision: true },
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
 * Per-wire-id request constants captured from the real Antigravity client
 * (Cartethyia `ANTIGRAVITY_WIRE_PROFILES`): the `model_enum` label the backend
 * expects in `labels`, and the maxOutputTokens ceiling per family. Claude on
 * `daily-cloudcode-pa` rejects maxOutputTokens > 64000 with a 400, and
 * gpt-oss-120b-medium rejects anything above 32768 with a bare
 * "Request contains an invalid argument.", so the cap must be applied per wire
 * id rather than per catalog entry.
 */
const ANTIGRAVITY_WIRE_PROFILES: Readonly<Record<string, { modelEnum?: string; maxOutputTokens: number }>> = Object.freeze({
  "gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65_536 },
  "gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65_536 },
  "gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65_536 },
  "gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65_535 },
  "gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65_535 },
  "claude-sonnet-4-6": { maxOutputTokens: 64_000 },
  "claude-opus-4-6-thinking": { maxOutputTokens: 64_000 },
  // OpenAI-family model on the same backend: 32768 is accepted, 40000 is not.
  "gpt-oss-120b-medium": { maxOutputTokens: 32_768 },
});

/** Hard ceiling Cloud Code Assist accepts for any model. */
const AG_MAX_OUTPUT_TOKENS = 64_000;

/**
 * Gemini requires function names to match `[a-zA-Z_][a-zA-Z0-9_.:\-]{0,63}`.
 * Client tool names routinely carry slashes/spaces (MCP servers, namespaced
 * tools), and one invalid name rejects the whole request — so sanitize and
 * remember the mapping to restore the original name in the response.
 */
function sanitizeFunctionName(name: string): string {
  if (!name) return "_unknown";
  let sanitized = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(sanitized)) sanitized = `_${sanitized}`;
  return sanitized.substring(0, 64);
}

/**
 * Keys the Gemini schema proto actually understands (Cartethyia
 * `GEMINI_SCHEMA_KEYS`). Everything else — `$schema`, `$defs`, `additionalProperties`,
 * `default`, `format` variants, UI styling keys injected by some clients — is
 * rejected with "Unknown name ...: Cannot find field", so it is dropped rather
 * than forwarded.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "propertyOrdering",
  "minProperties",
  "maxProperties",
  "items",
  "anyOf",
]);

/** The scalar type names the Gemini `Type` proto enum accepts. */
const GEMINI_SCALAR_TYPES: Readonly<Record<string, true>> = Object.freeze({
  string: true,
  number: true,
  integer: true,
  boolean: true,
  array: true,
  object: true,
});

/** Maps JSON Schema type spellings onto the Gemini enum. */
const GEMINI_TYPE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  float: "number",
  double: "number",
  int: "integer",
  int32: "integer",
  int64: "integer",
  long: "integer",
  bool: "boolean",
  dict: "object",
  list: "array",
});

/**
 * Normalize a JSON Schema `type` into one scalar Gemini enum value.
 *
 * Gemini's `Type` field is a non-repeated enum, so an array of types — the
 * standard JSON Schema spelling for a nullable/union value, emitted by most
 * agentic clients — is rejected outright:
 *
 *   Invalid JSON payload received. Unknown name "type" at
 *   '...parameters.properties[4].value': Proto field is not repeating,
 *   cannot start list. (INVALID_ARGUMENT)
 *
 * Union members are reduced to the first concrete scalar (preferring the
 * non-`null` alternative, since `null` has no Gemini equivalent) and the
 * remaining ones are carried as `anyOf` so the schema keeps its meaning.
 */
function normalizeGeminiType(value: unknown): { type?: string; anyOf?: Record<string, unknown>[] } {
  if (typeof value === "string") {
    const mapped = GEMINI_TYPE_ALIASES[value.toLowerCase()] ?? value.toLowerCase();
    return GEMINI_SCALAR_TYPES[mapped] ? { type: mapped } : {};
  }
  if (!Array.isArray(value)) return {};

  const names = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => GEMINI_TYPE_ALIASES[entry.toLowerCase()] ?? entry.toLowerCase());

  // A nullable type is the common case: `["string","null"]` is just a string
  // that may be absent, so the `null` arm carries no extra information.
  const concrete = names.filter((name) => name !== "null" && name !== "undefined" && GEMINI_SCALAR_TYPES[name]);
  const [first] = concrete;
  if (!first) return {};
  if (concrete.length === 1) return { type: first };

  // A genuine union: keep the first scalar as `type` (Gemini requires one) and
  // express the rest through `anyOf`.
  const rest = concrete.slice(1).map((name) => ({ type: name }));
  return { type: first, anyOf: rest };
}

/** Keys that carry a schema's structure only for local resolution. */
const JSON_SCHEMA_DEFS_KEYS: readonly string[] = ["$defs", "definitions"];

/**
 * Recursively reduce a JSON Schema to the subset Cloud Code Assist accepts.
 *
 * `defs` carries any in-scope `$defs`/`definitions` map so `$ref` pointers can
 * be inlined instead of dropped — a dropped `$ref` leaves an empty schema, and
 * Gemini then rejects the declaration for having no type.
 *
 * `depth` bounds the recursion. `$ref` inlining is recursive and tool schemas
 * are routinely self-referential (`#/$defs/Node` containing itself), so an
 * unbounded walk overflows the stack — a `RangeError` here would be classified
 * as an account failure and sideline otherwise healthy accounts.
 */
const GEMINI_SCHEMA_MAX_DEPTH = 16;

function cleanGeminiSchema(
  value: unknown,
  defs?: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  if (depth >= GEMINI_SCHEMA_MAX_DEPTH) return {};
  const source = value as Record<string, unknown>;
  const nextDepth = depth + 1;

  // Adopt any definitions declared at this level for descendant `$ref`s.
  let scope = defs;
  for (const key of JSON_SCHEMA_DEFS_KEYS) {
    const local = source[key];
    if (local !== null && typeof local === "object" && !Array.isArray(local)) {
      scope = { ...(scope ?? {}), ...(local as Record<string, unknown>) };
    }
  }

  // Inline a local `#/$defs/Name` or `#/definitions/Name` pointer. External
  // refs cannot be resolved here, so they degrade to an empty schema.
  if (typeof source.$ref === "string") {
    const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(source.$ref);
    const target = match?.[1] ? scope?.[match[1]] : undefined;
    if (target !== undefined) {
      const resolved = cleanGeminiSchema(target, scope, nextDepth);
      // Sibling keys in a `$ref` object win over the referenced definition.
      const siblings: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(source)) {
        if (key === "$ref" || JSON_SCHEMA_DEFS_KEYS.includes(key)) continue;
        Object.assign(siblings, cleanGeminiSchema({ [key]: child }, scope, nextDepth));
      }
      return { ...resolved, ...siblings };
    }
    return {};
  }

  const schema: Record<string, unknown> = {};

  // `const` is the single-value form of `enum`; Gemini has no `const`. Its
  // `enum` is a repeated *string* field, so the literal is stringified — a raw
  // number/boolean in `enum` is rejected upstream.
  if (source.const !== undefined && source.enum === undefined) {
    const literal = source.const;
    Object.assign(
      schema,
      cleanGeminiSchema({ type: literalTypeOf(literal), enum: [String(literal)] }, scope, nextDepth),
    );
  }

  for (const [key, child] of Object.entries(source)) {
    if (key === "const") continue;
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && child !== null && typeof child === "object" && !Array.isArray(child)) {
      schema.properties = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(([name, property]) => [
          name,
          cleanGeminiSchema(property, scope, nextDepth),
        ]),
      );
    } else if (key === "items") {
      // Tuple validation (`items` as an array) has no Gemini equivalent; an
      // empty schema is the safe widening.
      schema.items = Array.isArray(child) ? {} : cleanGeminiSchema(child, scope, nextDepth);
    } else if (key === "anyOf" && Array.isArray(child)) {
      const branches = child.map((branch) => cleanGeminiSchema(branch, scope, nextDepth));
      // A branch that reduces to nothing (`{"type":"null"}`) is dropped rather
      // than sent as an empty, unvalidatable alternative.
      const kept = branches.filter((branch) => Object.keys(branch).length > 0);
      if (kept.length > 0) schema.anyOf = kept;
    } else if (key === "required" && Array.isArray(child)) {
      schema.required = child.filter((entry): entry is string => typeof entry === "string");
    } else if (key === "type") {
      Object.assign(schema, normalizeGeminiType(child));
    } else {
      schema[key] = child;
    }
  }

  // `oneOf` is translated to `anyOf`: Gemini has no exclusivity guarantee to
  // express, and an untranslated `oneOf` was previously dropped wholesale.
  if (Array.isArray(source.oneOf)) {
    const branches = source.oneOf
      .map((branch) => cleanGeminiSchema(branch, scope, nextDepth))
      .filter((branch) => Object.keys(branch).length > 0);
    if (branches.length > 0) {
      const existing = Array.isArray(schema.anyOf) ? (schema.anyOf as Record<string, unknown>[]) : [];
      const merged = [...existing, ...branches];
      schema.anyOf = merged;
      // Gemini wants one scalar `type` alongside the branches; borrow it from
      // the first branch that declares one.
      if (schema.type === undefined) {
        const [firstWithType] = merged.filter((branch) => typeof branch.type === "string");
        if (typeof firstWithType?.type === "string") schema.type = firstWithType.type;
      }
    }
  }

  // Gemini requires an explicit type when properties exist.
  if (schema.properties && schema.type === undefined) schema.type = "object";
  return schema;
}

/** JSON Schema `type` for a literal value used to build a `const` enum. */
function literalTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "string";
  }
}

interface AntigravityToolBuild {
  /** Merged declarations for the single `functionDeclarations` group. */
  declarations: { name: string; description: string; parameters: Record<string, unknown> }[];
  /** sanitized upstream name -> original client name (for response restoration). */
  nameMap: Map<string, string>;
}

/**
 * Build the upstream tool declarations from OpenAI/Anthropic-shaped request
 * tools. Gemini expects exactly one `functionDeclarations` group, so every
 * group is merged and deduplicated by sanitized name (9router
 * `transformRequest`).
 */
function buildAntigravityTools(tools: unknown[] | undefined): AntigravityToolBuild {
  const nameMap = new Map<string, string>();
  const declarations: { name: string; description: string; parameters: Record<string, unknown> }[] = [];
  if (!Array.isArray(tools)) return { declarations, nameMap };

  const seen = new Set<string>();

  for (const raw of tools) {
    if (raw === null || typeof raw !== "object") continue;
    const tool = raw as Record<string, unknown>;
    const fn = (tool.function && typeof tool.function === "object" ? tool.function : tool) as Record<string, unknown>;
    const originalName = typeof fn.name === "string" ? fn.name : "";
    if (!originalName) continue;

    const name = sanitizeFunctionName(originalName);
    if (seen.has(name)) continue;
    seen.add(name);
    if (name !== originalName) nameMap.set(name, originalName);

    const parameters = fn.parameters ?? fn.input_schema;
    declarations.push({
      name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: parameters ? cleanGeminiSchema(parameters) : { type: "object", properties: {} },
    });
  }

  return { declarations, nameMap };
}

/**
 * Translate an OpenAI `tool_choice` into Gemini's `functionCallingConfig`.
 * `required`/`any` force a call, `none` disables them; an explicit tool name
 * restricts the call to that function.
 */
function buildToolConfig(toolChoice: unknown): Record<string, unknown> | undefined {
  const config = (mode: string, allowedNames?: string[]): Record<string, unknown> => ({
    functionCallingConfig: {
      mode,
      ...(allowedNames && allowedNames.length > 0 ? { allowedFunctionNames: allowedNames } : {}),
    },
  });

  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (typeof toolChoice === "string") {
    if (toolChoice === "required" || toolChoice === "any") return config("ANY");
    if (toolChoice === "none") return config("NONE");
    return undefined; // "auto" is the upstream default
  }
  if (typeof toolChoice !== "object") return undefined;

  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === "none") return config("NONE");
  if (choice.type === "any" || choice.type === "required") return config("ANY");
  if (choice.type === "function") {
    const fn = choice.function as Record<string, unknown> | undefined;
    const name = typeof fn?.name === "string" ? fn.name : undefined;
    if (name) return config("ANY", [sanitizeFunctionName(name)]);
  }
  if (choice.type === "tool" && typeof choice.name === "string") {
    return config("ANY", [sanitizeFunctionName(choice.name)]);
  }
  return undefined;
}

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

/**
 * The trailing `(high)` / `(medium)` / `(low)` on a wire id is a *thinking-tier
 * annotation*, not part of the upstream model name (9router `parseSuffix` +
 * `getModelUpstreamId`). Google rejects the annotated form with
 * `404 NOT_FOUND: Requested entity was not found.`, which is the whole reason
 * this helper exists: the tier is re-read locally by `antigravityWireTier`
 * (which inspects the annotated string) and converted into
 * `generationConfig.thinkingConfig.thinkingBudget`, while the model that goes
 * on the wire is the bare id.
 */
export function stripAntigravityTierSuffix(wireModel: string): string {
  return wireModel.replace(/\([^()]+\)\s*$/, "").trim();
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

    // loadCodeAssist/onboardUser report the project either as a bare id or as
    // `{ id }` under cloudaicompanionProject.
    const cloudai = record.cloudaicompanionProject;
    if (typeof cloudai === "string" && cloudai.length > 0) return cloudai;
    if (cloudai !== null && typeof cloudai === "object" && !Array.isArray(cloudai)) {
      const nested = (cloudai as Record<string, unknown>).id;
      return typeof nested === "string" && nested.length > 0 ? nested : undefined;
    }
  }
  return undefined;
}

/** Await `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Whether the stored access token is expired or close enough to it that a
 * request would likely fail. Antigravity access tokens live ~1h, so the lead
 * time (5 min, matching the 9router registry `refreshLeadMs`) both avoids a
 * wasted 401 round-trip and lets the scheduled warmup repair an idle account
 * before it is reported as having no valid tokens.
 */
export const ANTIGRAVITY_REFRESH_LEAD_MS = 5 * 60_000;

export function isAntigravityTokenExpiring(
  credential: { expiresAt?: string },
  nowMs: number = Date.now(),
): boolean {
  if (!credential.expiresAt) return false; // unknown expiry — let the request find out
  const expiresAtMs = Date.parse(credential.expiresAt);
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs - nowMs < ANTIGRAVITY_REFRESH_LEAD_MS;
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

  const submitOnboard = async (): Promise<Record<string, unknown>> => {
    const response = await antigravityFetch(ANTIGRAVITY_OAUTH.onboardUserUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ tierId, metadata: LOAD_CODE_ASSIST_METADATA }),
    });
    return ((await response.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
  };

  // Long-running operation returned by onboardUser; poll it by name. Google
  // exposes LRO polling as a GET on the operation resource — a POST here
  // returns 404/405 and the login hangs until the poll budget runs out.
  const cloudcodeBase = new URL(ANTIGRAVITY_OAUTH.loadCodeAssistUrl).origin;
  const pollOperation = async (operationName: string): Promise<Record<string, unknown>> => {
    const response = await antigravityFetch(`${cloudcodeBase}/v1internal/${operationName}`, {
      method: "GET",
      headers,
    });
    return ((await response.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
  };

  let operation = await submitOnboard();
  const operationName = typeof operation.name === "string" ? operation.name.trim() : "";
  console.log(`[Antigravity OAuth] onboard submitted, operation=${operationName || "<none>"}, done=${operation.done ?? false}`);

  // Poll the provisioning operation up to ~2 minutes (24 × 5s).
  for (let attempt = 1; attempt < 24; attempt++) {
    await sleep(5000);

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
    if (attempt > 0) await sleep(5000);
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
  /**
   * Signatures Gemini issued for tool calls we returned, keyed by a hash of
   * the tool name + arguments. Gemini rejects a replayed `functionCall` that
   * carries no signature, but most OpenAI-shaped clients drop the
   * non-standard `tool_calls[].thoughtSignature` field. Stashing them here
   * lets the replay be repaired even when the client echoes nothing.
   * Insertion-ordered, oldest evicted first.
   */
  issuedSignatures: Map<string, string>;
  /** Last time this entry was read or written (idle-eviction clock). */
  touchedAt: number;
}

/**
 * Bounded conversation-state store, keyed by account + wire model.
 *
 * The upstream expects a monotonically increasing `stepIndex` within one
 * trajectory, and a *fresh* trajectory when a new conversation starts —
 * carrying the counter across conversations makes the backend reject the turn.
 * Entries are therefore reset when the request does not continue a
 * conversation (no assistant turn yet), when the wire model changes for the
 * same account, and evicted after an idle TTL so a long-lived process does not
 * accumulate state for every account/model pair ever used (Cartethyia
 * `RouteSessionStateStore`).
 */
const AG_SESSION_MAX_ENTRIES = 256;
const AG_SESSION_IDLE_TTL_MS = 30 * 60_000;

export class AntigravitySessionStore {
  private states = new Map<string, SessionState>();

  /** Drop entries idle past the TTL. */
  private evictIdle(now: number): void {
    for (const [key, state] of this.states) {
      if (now - state.touchedAt > AG_SESSION_IDLE_TTL_MS) this.states.delete(key);
    }
  }

  /** Drop the oldest entries (Map preserves insertion order) past the cap. */
  private evictOverflow(): void {
    while (this.states.size > AG_SESSION_MAX_ENTRIES) {
      const oldest = this.states.keys().next();
      if (oldest.done) return;
      this.states.delete(oldest.value);
    }
  }

  /**
   * Fetch the state for an account + wire model, creating a fresh trajectory
   * when none exists or when `reset` is set. Resetting drops every entry for
   * the account, so a new conversation (or a model switch) starts clean
   * instead of reusing a stale step counter.
   */
  acquire(accountId: string, wireModel: string, reset: boolean): SessionState {
    const now = Date.now();
    const key = `${accountId}:${wireModel}`;
    this.evictIdle(now);
    if (reset) {
      for (const existing of [...this.states.keys()]) {
        if (existing.startsWith(`${accountId}:`)) this.states.delete(existing);
      }
    }
    let state = this.states.get(key);
    if (!state) {
      state = {
        agentId: crypto.randomUUID(),
        trajectoryId: crypto.randomUUID(),
        sessionId: numericSessionId(accountId),
        stepIndex: 0,
        issuedSignatures: new Map(),
        touchedAt: now,
      };
      this.states.set(key, state);
      this.evictOverflow();
    }
    state.touchedAt = now;
    return state;
  }

  get size(): number {
    return this.states.size;
  }
}

/**
 * Identity prompt prepended as the first user content for Claude / Gemini-3
 * agent models (Cartethyia reference) so the agent reasons with its system
 * personality even without a systemInstruction slot.
 */
const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";

/**
 * Rewrite competing-client branding out of the system prompt. The backend
 * fingerprints other agents' identities (the Claude Agent SDK banner, OpenCode)
 * and answers 429 "Quota Exhausted" for the whole request rather than serving
 * it — so the branding is neutralised before the request goes out (9router
 * `ANTIGRAVITY_PROMPT_REWRITES`).
 */
function applyAntigravityPromptRewrites(text: string): string {
  if (!text) return text;
  return text
    .replaceAll("You are a Claude agent, built on Anthropic's Claude Agent SDK.", "")
    .replace(/opencode/gi, (match) =>
      match === "OpenCode" ? "Antigravity" : match === "OPENCODE" ? "ANTIGRAVITY" : "antigravity",
    );
}

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

/**
 * Name of the synthesized function declaration that carries a client's
 * `web_search` tool. The built-in `googleSearch` tool is unusable alongside
 * function declarations on this backend (see `buildAntigravityRequest`), so
 * web search is modelled as an ordinary callable function.
 */
const WEB_SEARCH_FUNCTION_NAME = "web_search";

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
  /** Marks a part as model reasoning (Gemini "thought" summary). */
  thought?: boolean;
  /** Opaque signature Gemini 3+ requires on replayed functionCall parts. */
  thoughtSignature?: string;
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
  requestType: "agent" | "image_gen";
  request: {
    contents: GeminiContent[];
    generationConfig: Record<string, unknown>;
    sessionId: string;
    labels: Record<string, string>;
    systemInstruction?: { parts: GeminiPart[] };
    tools?: unknown[];
    toolConfig?: Record<string, unknown>;
  };
  /**
   * sanitized upstream function name -> original client name. Not part of the
   * wire body; used to restore names in the response.
   */
  toolNameMap: Map<string, string>;
}

/**
 * Key for the issued-signature stash: a given tool call is identified by its
 * name and arguments, which are what the client echoes back on replay. The
 * arguments are hashed so a long payload does not bloat the key.
 */
function signatureStashKey(name: string, args: unknown): string {
  const serialized = typeof args === "string" ? args : JSON.stringify(args ?? {});
  let hash = 0;
  for (let i = 0; i < serialized.length; i++) {
    hash = ((hash << 5) - hash + serialized.charCodeAt(i)) | 0;
  }
  return `${name}:${(hash >>> 0).toString(36)}`;
}

function numericSessionId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return String(Math.abs(hash) % 9007199254740991);
}

function convertOpenAIToGemini(
  messages: ChatCompletionRequest["messages"],
  signatureStash?: Map<string, string>,
): { contents: GeminiContent[]; systemTexts: string[] } {
  const contents: GeminiContent[] = [];
  const systemTexts: string[] = [];
  let currentRole: "user" | "model" = "user";
  let currentParts: GeminiPart[] = [];

  // Gemini's functionResponse must carry the function NAME, while OpenAI tool
  // messages only carry the call id — so map ids to names from the assistant
  // turns before rendering any tool result.
  const callIdToName = new Map<string, string>();
  for (const msg of messages) {
    for (const call of (msg.tool_calls ?? []) as { id?: string; function?: { name?: string } }[]) {
      if (call.id && call.function?.name) callIdToName.set(call.id, call.function.name);
    }
  }

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
      const name = (msg.tool_call_id ? callIdToName.get(msg.tool_call_id) : undefined) ?? msg.tool_call_id ?? "tool";
      currentParts.push({
        functionResponse: {
          name: sanitizeFunctionName(name),
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
      for (const call of msg.tool_calls as {
        function?: { name?: string; arguments?: string };
        thoughtSignature?: string;
        thought_signature?: string;
      }[]) {
        let args: Record<string, unknown> | undefined;
        try { args = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments) : undefined; } catch { /* raw */ }
        const name = sanitizeFunctionName(call.function?.name || "");
        // Gemini 3+ cryptographically validates the signature on a replayed
        // functionCall, so only a signature that Gemini itself issued is
        // usable — a fabricated constant is rejected either as invalid base64
        // or as "Corrupted thought signature."
        //
        // Most OpenAI-shaped clients drop the non-standard
        // `tool_calls[].thoughtSignature` field, and an unsigned replay is
        // rejected outright ("Function call is missing a thought_signature").
        // The signature we issued for this same call is therefore recovered
        // from the per-conversation stash, keyed by tool name + arguments —
        // which is exactly what the client echoes back.
        const echoed = call.thoughtSignature ?? call.thought_signature;
        const thoughtSignature = echoed
          ?? (name ? signatureStash?.get(signatureStashKey(name, call.function?.arguments)) : undefined);
        currentParts.push({ functionCall: { name, args }, ...(thoughtSignature ? { thoughtSignature } : {}) });
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

/**
 * Aspect ratio from an image model's suffix — `…-image-16x9` → `16:9`,
 * `…-image-1024x768` → `4:3` (9router `parseImageConfig`). Defaults to square.
 */
function parseImageAspectRatio(model: string): string {
  const match = model.match(/(\d+)x(\d+)$/);
  if (!match) return "1:1";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return "1:1";
  if (width <= 16 && height <= 16) return `${width}:${height}`;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/**
 * Image generation uses a different envelope than chat: `requestType` is
 * `image_gen`, `generateContent` (never the SSE action), a flat text-only
 * contents list, and an `imageConfig` aspect ratio — with no tools,
 * systemInstruction, or thinking config, all of which the image backend
 * rejects (Cartethyia/9router `buildAntigravityImageRequest`).
 */
function buildAntigravityImageRequest(
  request: ChatCompletionRequest,
  credential: AntigravityTokens,
  state: SessionState,
  wireModel: string,
): AntigravityRequestEnvelope {
  state.stepIndex += 1;

  const { contents } = convertOpenAIToGemini(request.messages);
  const textContents = contents
    .map((content) => ({
      role: content.role,
      parts: content.parts.filter((part) => typeof part.text === "string" && part.text.length > 0)
        .map((part) => ({ text: part.text as string })),
    }))
    .filter((content) => content.parts.length > 0);

  return {
    project: credential.projectId,
    requestId: `agent/${state.agentId}/${Date.now()}/${state.trajectoryId}/${state.stepIndex}`,
    model: stripAntigravityTierSuffix(wireModel).replace(/-(\d+)x(\d+)$/, ""),
    userAgent: "antigravity",
    requestType: "image_gen",
    request: {
      contents: textContents.length > 0 ? textContents : [{ role: "user", parts: [{ text: "" }] }],
      generationConfig: {
        temperature: 1,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192,
        imageConfig: { aspectRatio: parseImageAspectRatio(wireModel) },
      },
      sessionId: state.sessionId,
      labels: {},
    },
    toolNameMap: new Map(),
  };
}

function buildAntigravityRequest(
  request: ChatCompletionRequest,
  credential: AntigravityTokens,
  state: SessionState,
): AntigravityRequestEnvelope {
  const wm = findWireModel(request.model);
  const wireModel = wm?.wire || request.model.replace(/^ag-/, "");
  const wireProfile = ANTIGRAVITY_WIRE_PROFILES[wireModel];
  state.stepIndex += 1;

  let { contents, systemTexts } = convertOpenAIToGemini(request.messages, state.issuedSignatures);

  // Per-wire cap: Claude on daily-cloudcode-pa rejects maxOutputTokens > 64000
  // with a 400, and every model has its own ceiling (Cartethyia wire profiles).
  const maxOutputCeiling = Math.min(wireProfile?.maxOutputTokens ?? wm?.maxOutput ?? AG_MAX_OUTPUT_TOKENS, AG_MAX_OUTPUT_TOKENS);
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: Math.min(request.max_tokens ?? wm?.maxOutput ?? 8192, maxOutputCeiling),
  };
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.top_p !== undefined) generationConfig.topP = request.top_p;
  if (wm?.thinking) {
    // Effort-tier thinking budget (Cartethyia reference): low/medium/high/pro.
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
  if (wireProfile?.modelEnum) labels.model_enum = wireProfile.modelEnum;

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
    labels,
  };
  if (systemTexts.length > 0) {
    payload.systemInstruction = { parts: [{ text: applyAntigravityPromptRewrites(systemTexts.join("\n\n")) }] };
  }

  // Client tools → one merged functionDeclarations group. Without this the
  // request goes out with no tool spec at all and the model answers text-only,
  // which surfaces in agents as "the model ignored my tools".
  const { declarations, nameMap } = buildAntigravityTools(request.tools);
  const wantsSearch = wantsWebSearch(request);
  const upstreamTools: unknown[] = [];

  if (declarations.length > 0) {
    // A `web_search` tool is modelled as an ordinary function declaration so
    // the model can call it like any other tool.
    //
    // The built-in `googleSearch` tool cannot travel alongside function
    // declarations on this backend — the combination is refused with
    //
    //   400 Please enable tool_config.include_server_side_tool_invocations to
    //   use Built-in tools with Function calling. (INVALID_ARGUMENT)
    //
    // and the flag is not accepted in any request-body position (verified
    // against the live API: neither `request.tool_config` in either casing, nor
    // the envelope top level). The Cartethyia/9router reference never hits this
    // because its gemini translator overwrites `tools` with the declarations
    // whenever any client tools exist, which drops the built-in tool exactly
    // this way. `googleSearch` on its own does work (200), so it is kept for
    // the tools-only case below.
    if (wantsSearch) {
      const name = sanitizeFunctionName(WEB_SEARCH_FUNCTION_NAME);
      if (!declarations.some((declaration) => declaration.name === name)) {
        declarations.push({
          name,
          description: "Search the web for current information. Use this when the answer depends on recent or real-time facts.",
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "The search query." } },
            required: ["query"],
          },
        });
      }
    }
    upstreamTools.push({ functionDeclarations: declarations });
  } else if (wantsSearch) {
    // No client function tools, so the built-in search tool is safe.
    upstreamTools.push({ googleSearch: {} });
  }

  if (upstreamTools.length > 0) payload.tools = upstreamTools;

  // toolConfig: Claude requires VALIDATED mode; an explicit tool_choice forces
  // ANY/NONE regardless of model family.
  const requestedToolConfig = buildToolConfig(request.tool_choice);
  if (requestedToolConfig) {
    payload.toolConfig = requestedToolConfig;
  } else if (wireModel.startsWith("claude") && declarations.length > 0) {
    payload.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }

  return {
    project: credential.projectId,
    requestId: `agent/${state.agentId}/${Date.now()}/${state.trajectoryId}/${state.stepIndex}`,
    // The tier annotation is local-only: Google 404s on `...(high)` ids.
    model: stripAntigravityTierSuffix(wireModel),
    userAgent: "antigravity",
    requestType: "agent",
    request: payload,
    toolNameMap: nameMap,
  };
}

/**
 * Cap on a single in-provider retry wait. Antigravity frequently answers 429
 * with "Your quota will reset after 2h7m23s" — retrying that here would hold
 * the request open for hours, so anything above the cap is left to the router
 * (which fails over to the next account instead).
 */
const AG_MAX_RETRY_AFTER_MS = 10_000;
const AG_TRANSIENT_RETRY_MAX_MS = 15_000;
const AG_TRANSIENT_ATTEMPTS = 3;

/**
 * Upstream bodies that mean "try again", not "this account is broken". The
 * agent backend emits these with a 200 or 5xx status depending on where it
 * fails, so they are matched on text as well as status (9router
 * `ANTIGRAVITY_TRANSIENT_ERROR_PATTERNS`).
 */
const AG_TRANSIENT_ERROR_PATTERNS = [
  /high\s+traffic/i,
  /agent\s+(?:execution\s+)?terminated\s+due\s+to\s+error/i,
  /capacity/i,
  /temporarily\s+unavailable/i,
  /timeout/i,
  /stream\s+(?:ended|closed|terminated|interrupted)/i,
  /empty\s+response/i,
];

/** `Retry-After` / `X-RateLimit-Reset*` in ms, or the delay embedded in the error text. */
export function parseAntigravityRetryDelay(headers: Headers, message: string): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    // Either a delay in seconds or an HTTP date.
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at) && at > Date.now()) return at - Date.now();
  }

  // reset-after is a duration in seconds…
  const resetAfter = Number.parseInt(headers.get("x-ratelimit-reset-after") ?? "", 10);
  if (Number.isFinite(resetAfter) && resetAfter > 0) return resetAfter * 1000;
  // …while reset is an absolute epoch timestamp.
  const resetAt = Number.parseInt(headers.get("x-ratelimit-reset") ?? "", 10);
  if (Number.isFinite(resetAt) && resetAt > 0) {
    const ms = resetAt * 1000 - Date.now();
    if (ms > 0) return ms;
  }

  // "Your quota will reset after 2h7m23s" / "1h30m" / "45m" / "30s"
  const match = message.match(/reset after (?:(?<h>\d+)h)?(?:(?<m>\d+)m)?(?:(?<s>\d+)s)?/i);
  if (match?.groups) {
    const total =
      Number(match.groups.h ?? 0) * 3_600_000 +
      Number(match.groups.m ?? 0) * 60_000 +
      Number(match.groups.s ?? 0) * 1000;
    if (total > 0) return total;
  }
  return null;
}

function isTransientAntigravityFailure(status: number, message: string): boolean {
  if (status === 429 || status >= 500) return true;
  return AG_TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Serialize only the wire fields — `toolNameMap` is local bookkeeping and must
 * not be sent upstream. Exported as the single definition of "what goes on the
 * wire" so the contract is directly assertable.
 *
 * Accepts any envelope-shaped object (the real `AntigravityRequestEnvelope`,
 * or a test's structural mirror) and strips `toolNameMap` by destructuring.
 */
export function serializeAntigravityEnvelope<T extends { toolNameMap?: Map<string, string> }>(env: T): string {
  const { toolNameMap: _toolNameMap, ...wire } = env;
  return JSON.stringify(wire);
}

/** POST the envelope to one Cloud Code host. */
async function postAntigravityEnvelope(
  endpoint: string,
  env: AntigravityRequestEnvelope,
  credential: AntigravityTokens,
): Promise<Response> {
  // Image generation must use the plain generateContent action: the image
  // backend rejects streamGenerateContent outright (9router buildUrl).
  const action = env.requestType === "image_gen"
    ? "v1internal:generateContent"
    : ANTIGRAVITY_OAUTH.action;
  return antigravityFetch(`${endpoint}/${action}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${credential.accessToken}`,
      "Content-Type": "application/json",
      "Accept": env.requestType === "image_gen" ? "application/json" : "text/event-stream",
      "User-Agent": ANTIGRAVITY_OAUTH.userAgent,
    },
    body: serializeAntigravityEnvelope(env),
  });
}

/**
 * POST to the daily host with bounded transient retries, then fall back to the
 * sandbox host (Cartethyia/9router pattern). Retries only cover transient
 * upstream failures; a 400/401/403 is returned immediately so the router can
 * classify it.
 */
async function fetchAntigravitySse(env: AntigravityRequestEnvelope, credential: AntigravityTokens): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < AG_TRANSIENT_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const retryAfter = lastResponse ? parseAntigravityRetryDelay(lastResponse.headers, "") : null;
      const backoff = Math.min(1000 * 2 ** attempt, AG_TRANSIENT_RETRY_MAX_MS);
      await sleep(retryAfter ?? backoff);
    }

    const response = await postAntigravityEnvelope(ANTIGRAVITY_OAUTH.dailyEndpoint, env, credential);
    if (response.ok) return response;

    const bodyText = await response.clone().text().catch(() => "");
    const retryDelay = parseAntigravityRetryDelay(response.headers, bodyText);
    // A Retry-After beyond the cap means "come back much later" — do not spin
    // here; hand the response to the router so it can fail over.
    const waitTooLong = retryDelay !== null && retryDelay > AG_MAX_RETRY_AFTER_MS;
    if (!waitTooLong && !isTransientAntigravityFailure(response.status, bodyText)) return response;

    lastResponse = response;
    if (waitTooLong) break;
  }

  // Sandbox fallback: the daily host 429s/5xxs under load while sandbox serves
  // the same models. Only reached after a transient failure.
  const fallback = await postAntigravityEnvelope(ANTIGRAVITY_OAUTH.sandboxEndpoint, env, credential);
  return fallback.ok ? fallback : (lastResponse ?? fallback);
}

interface GeminiFrame {
  responseId?: string;
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  response?: GeminiFrame;
  /** Upstream error carried inside an otherwise-200 SSE stream. */
  error?: { code?: number; message?: string; status?: string } | string;
}

/**
 * Parse an SSE body into Gemini frames, hoisting the nested `response` object.
 * An error payload inside a 200 stream is surfaced as an Error so callers do
 * not silently treat a failed turn as an empty success.
 */
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
        let parsed: GeminiFrame;
        try {
          parsed = JSON.parse(data) as GeminiFrame;
        } catch {
          continue; // skip malformed frame
        }

        const frame = parsed.response ?? parsed;
        // Cloud Code Assist nests usageMetadata inside `response`; hoist it to
        // the top level so token accounting sees the real usage.
        const nestedUsage = parsed.response?.usageMetadata;
        const normalized = frame.usageMetadata === undefined && nestedUsage !== undefined
          ? { ...frame, usageMetadata: nestedUsage }
          : frame;

        const error = parsed.error ?? parsed.response?.error;
        if (error) {
          throw new Error(typeof error === "string" ? error : error.message || error.status || "Antigravity stream error");
        }

        yield normalized;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * Render a Gemini image-generation body as assistant content: the image as a
 * markdown data URI, plus any accompanying text.
 */
function imageCompletionContent(body: GeminiFrame | null): string {
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const segments: string[] = [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      const mimeType = part.inlineData.mimeType || "image/png";
      segments.push(`![Generated Image](data:${mimeType};base64,${part.inlineData.data})`);
    } else if (typeof part.text === "string" && part.text.trim()) {
      segments.push(part.text.trim());
    }
  }
  return segments.join("\n\n") || "Image generation completed but no image was returned.";
}

/** Gemini finish reasons → OpenAI finish reasons. */
function mapFinishReason(reason?: string): string {
  switch (reason) {
    case "MAX_TOKENS": return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII": return "content_filter";
    default: return "stop";
  }
}

/**
 * Signals that a 429 is a drained quota window rather than momentary rate
 * limiting. Deliberately specific: Google's generic rate-limit body is
 * "Resource has been exhausted (e.g. check quota).", which mentions "quota"
 * but is retryable — matching a bare "quota" here would wrongly flip healthy
 * accounts to `exhausted`.
 */
const AG_QUOTA_EXHAUSTED_PATTERNS = [
  /reset after/i,
  /exhausted your/i,
  /exceeded your current/i,
  /quota has been exhausted/i,
  /daily quota|weekly quota/i,
];

/**
 * Classify a non-OK Cloud Code response into a ProviderResult failure.
 *
 * A 429 is ambiguous: it is either a momentary rate limit or a drained quota
 * window. Only a body that names the quota/reset is treated as exhaustion —
 * everything else becomes a rate limit, which the router handles with a
 * graduated, self-healing cooldown instead of flipping the account to
 * `exhausted` (Cartethyia/9router both retry transient 429s first).
 */
function antigravityFailure(status: number, bodyText: string): ProviderResult {
  const message = extractUpstreamError(bodyText) || bodyText.slice(0, 500);
  const quotaExhausted = status === 429 && AG_QUOTA_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(message));
  return {
    success: false,
    error: `Antigravity API error (${status}): ${message}`,
    rateLimited: status === 429 && !quotaExhausted,
    quotaExhausted,
  };
}

/** Pull the human-readable message out of a Google API error envelope. */
function extractUpstreamError(bodyText: string): string {
  if (!bodyText) return "";
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string; status?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string" && message.length > 0) {
      // Google tags the machine-readable reason separately (e.g.
      // RESOURCE_EXHAUSTED); keep it so classification can use it.
      const status = typeof parsed.error === "object" ? parsed.error.status : undefined;
      return status ? `${message} (${status})` : message;
    }
  } catch {
    // not JSON — fall through to the raw text
  }
  return bodyText.slice(0, 500);
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

  /**
   * Conversation state. Injectable so a test can drive two turns through
   * separate provider instances while sharing one conversation's state, which
   * is what a real multi-request conversation does.
   */
  private sessionStates: AntigravitySessionStore;

  constructor(sessionStates?: AntigravitySessionStore) {
    super();
    this.sessionStates = sessionStates ?? new AntigravitySessionStore();
  }

  /** Number of live conversation states. */
  sessionStateSize(): number {
    return this.sessionStates.size;
  }

  override ownsModel(model: string): boolean {
    return model.startsWith("ag-");
  }

  private async buildRequest(account: Account, request: ChatCompletionRequest) {
    // Refresh ahead of expiry so the common case never spends a round-trip on a
    // 401. The router's post-hoc refresh still covers tokens that lapse mid-flight.
    const { credential, refreshedTokens } = await this.freshCredential(account);
    if (!credential?.accessToken || !credential.projectId) {
      throw new Error("Missing accessToken/projectId in antigravity credentials");
    }
    const accountId = String(account.id);
    const wireModel = findWireModel(request.model);
    const wireModelId = wireModel?.wire ?? request.model.replace(/^ag-/, "");
    // A conversation continues only when the client replays a prior assistant
    // turn; a bare user turn starts a new trajectory (fresh stepIndex).
    const continuesConversation = request.messages.some((msg) => msg.role === "assistant");
    const state = this.sessionStates.acquire(accountId, wireModelId, !continuesConversation);
    // Image generation takes an entirely different envelope; chat-shaped
    // fields (tools, thinkingConfig) are rejected by the image backend.
    const env = wireModel?.image
      ? buildAntigravityImageRequest(request, credential, state, wireModelId)
      : buildAntigravityRequest(request, credential, state);
    return { credential, state, env, refreshedTokens };
  }

  /**
   * Transport seam: subclasses (tests) override this to serve canned
   * responses without touching the network, mirroring the codex provider's
   * `fetchWithTimeout` override.
   */
  protected async sendAntigravityRequest(
    env: AntigravityRequestEnvelope,
    credential: AntigravityTokens,
  ): Promise<Response> {
    return fetchAntigravitySse(env, credential);
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const { credential, state, env, refreshedTokens } = await this.buildRequest(account, request);
      const response = await this.sendAntigravityRequest(env, credential);
      if (!response.ok) {
        return antigravityFailure(response.status, await response.text().catch(() => ""));
      }

      // Image generation answers with one plain JSON body (no SSE frames).
      if (env.requestType === "image_gen") {
        const body = (await response.json().catch(() => null)) as GeminiFrame | null;
        return {
          success: true,
          response: {
            id: this.generateId(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [{ index: 0, message: { role: "assistant", content: imageCompletionContent(body) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 1 },
          },
          tokensUsed: 1,
          tokens: refreshedTokens,
        };
      }

      // Fold the SSE stream into one non-stream Gemini response.
      let text = "";
      let reasoning = "";
      const toolCalls: { id: string; name: string; arguments: string; thoughtSignature?: string }[] = [];
      let finishReason: string | null = null;
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      for await (const frame of parseGeminiSse(response)) {
        if (frame.responseId) state.lastExecutionId = frame.responseId;
        const parts = frame.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (typeof part.text === "string" && part.text) {
            // Gemini emits reasoning as a text part flagged `thought`. Folding
            // it into the answer text leaks the model's scratchpad to clients
            // and breaks the Anthropic thinking block mapping.
            if (part.thought) reasoning += part.text;
            else text += part.text;
          }
          if (part.functionCall?.name) {
            const callName = env.toolNameMap.get(part.functionCall.name) ?? part.functionCall.name;
            toolCalls.push({
              id: `call_${toolCalls.length}`,
              name: callName,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
              // Surfaced to the client so it can echo it back when replaying
              // this call — Gemini validates it cryptographically on the next
              // turn and there is no way to synthesize a valid one.
              thoughtSignature: part.thoughtSignature,
            });
            // Also stash it server-side: OpenAI-shaped clients routinely drop
            // the non-standard field, and an unsigned replay is rejected.
            if (part.thoughtSignature) {
              state.issuedSignatures.set(signatureStashKey(callName, part.functionCall.args), part.thoughtSignature);
            }
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
      if (reasoning) message.reasoning_content = reasoning;
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
          ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
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
        tokens: refreshedTokens,
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    // Image generation has no streaming endpoint — serve it as a single
    // non-stream completion (same convention as the canva provider).
    if (findWireModel(request.model)?.image) return this.chatCompletion(account, request);
    try {
      const { credential, state, env, refreshedTokens } = await this.buildRequest(account, request);
      const response = await this.sendAntigravityRequest(env, credential);
      if (!response.ok) {
        return antigravityFailure(response.status, await response.text().catch(() => ""));
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
          let finished = false;

          /** Emit the opening role chunk once, before any delta. */
          const begin = () => {
            if (started) return;
            started = true;
            emit({ role: "assistant", content: "" });
          };
          /** Emit exactly one terminal chunk for the turn. */
          const finish = (reason: string) => {
            if (finished) return;
            finished = true;
            emit({}, reason);
          };

          try {
            for await (const frame of parseGeminiSse(response)) {
              if (frame.responseId) state.lastExecutionId = frame.responseId;
              const parts = frame.candidates?.[0]?.content?.parts || [];
              for (const part of parts) {
                if (typeof part.text === "string" && part.text) {
                  begin();
                  // Thinking summaries ride the same `text` field flagged
                  // `thought`; route them to reasoning_content so clients that
                  // render thinking (Claude Code, Anthropic transforms) see
                  // them as reasoning instead of answer text.
                  emit(part.thought ? { reasoning_content: part.text } : { content: part.text });
                }
                if (part.functionCall?.name) {
                  sawToolCalls = true;
                  const callName = env.toolNameMap.get(part.functionCall.name) ?? part.functionCall.name;
                  // Stashed for the same reason as the non-streaming path: a
                  // client that drops the non-standard field must still be able
                  // to replay this call on the next turn.
                  if (part.thoughtSignature) {
                    state.issuedSignatures.set(signatureStashKey(callName, part.functionCall.args), part.thoughtSignature);
                  }
                  emit({
                    tool_calls: [{
                      index: toolIndex,
                      id: `call_${toolIndex}`,
                      type: "function",
                      function: {
                        name: callName,
                        arguments: JSON.stringify(part.functionCall.args ?? {}),
                      },
                      // Echoed so the client can replay it; Gemini validates the
                      // signature cryptographically on the following turn.
                      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
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
                finish(sawToolCalls ? "tool_calls" : mapFinishReason(frame.candidates[0].finishReason));
              }
            }
            // The stream can end without a finishReason (truncated upstream).
            // Always close with exactly one terminal chunk so clients and the
            // SSE accounting in proxy/index.ts see a completed turn instead of
            // a blank response.
            if (!finished) {
              begin();
              finish(sawToolCalls ? "tool_calls" : "stop");
            }
            if (usageOut) emit({}, null, usageOut);
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Nothing reached the client yet — fail the stream so the proxy's
            // combo/account fallback can try the next target instead of
            // returning a silently-empty 200 (codebuddy convention).
            if (!started) {
              try { controller.error(new Error(message)); } catch { /* already closed */ }
              return;
            }
            // Mid-stream failure: surface the upstream message and terminate
            // the turn cleanly rather than truncating silently.
            try {
              emit({ content: `\n\n[Stream error: ${message}]` }, "stop");
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch {
              try { controller.error(err); } catch { /* already closed */ }
            }
          }
        },
      });

      return { success: true, stream, tokens: refreshedTokens };
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
      // Deliberately no `account.tokens` mutation: the caller decides whether to
      // persist (the router writes to the DB, healthCheck returns them to the
      // warmup runner). A silent in-place write here is how a refreshed token
      // could be computed and then dropped without ever reaching the DB.
      return { success: true, tokens: JSON.stringify(updated) };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    try {
      const { credential } = await this.freshCredential(account);
      if (!credential?.accessToken) return false;

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

  /**
   * The credential to use for an outbound call, refreshed first when the access
   * token is at or near expiry. Returns `undefined` when the account carries no
   * usable credential.
   *
   * Access tokens live ~1h (Google `expires_in: 3599`). Without a proactive
   * refresh an idle account would be reported `missing_tokens` → "No valid
   * tokens available" about an hour after login, even though its refresh token
   * was still perfectly good.
   */
  private async freshCredential(
    account: Account,
  ): Promise<{ credential: AntigravityTokens | undefined; refreshedTokens?: string }> {
    const credential = parseAntigravityCredential(account.tokens);
    if (!credential.accessToken) return { credential: undefined };
    if (!credential.refreshToken || !isAntigravityTokenExpiring(credential)) return { credential };

    const refreshed = await this.refreshToken(account);
    if (!refreshed.success || !refreshed.tokens) return { credential };
    // Hand the encoded tokens back so the caller can propagate them to the
    // router, which is what actually persists the refreshed credential.
    return { credential: parseAntigravityCredential(refreshed.tokens), refreshedTokens: refreshed.tokens };
  }

  /**
   * Refresh an expiring credential *before* the base health check validates it,
   * and hand the new tokens back through `health.tokens` so the scheduled
   * warmup persists them.
   *
   * The persistence matters as much as the refresh: the warmup runner only
   * writes `dbUpdate.tokens` when `health.tokens` is set, so a refresh that
   * does not return them here is discarded and the account stays broken.
   */
  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const credential = parseAntigravityCredential(account.tokens);
    if (credential.accessToken && credential.refreshToken && isAntigravityTokenExpiring(credential)) {
      const refreshed = await this.refreshToken(account);
      if (refreshed.success && refreshed.tokens) {
        // Validate against the refreshed credential the caller will persist.
        const repaired = { ...account, tokens: refreshed.tokens } as Account;
        const health = await super.healthCheck(repaired);
        return { ...health, tokens: JSON.parse(refreshed.tokens) as unknown };
      }
      // Refresh failed: fall through and let the base check classify the
      // (still-expired) credential so a genuine auth failure is reported.
    }
    return super.healthCheck(account);
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

      // Only models this pool can actually route matter. The RPC also reports
      // internal/experimental entries whose quota is not ours to spend;
      // counting them would drag the aggregate to 0 and mark a healthy account
      // exhausted (Cartethyia `IMPORTANT_MODELS`).
      const routableModels = new Set(WIRE_MODELS.flatMap((m) => [m.id, m.id.replace(/^ag-/, ""), m.wire]));

      const families = new Map<string, { remaining: number; reset?: string }>();
      const models = (body.models ?? body.modelQuotas ?? body.quota ?? {}) as Record<string, unknown>;
      for (const [modelId, raw] of Object.entries(models)) {
        const model = raw as Record<string, unknown>;
        if (!model || model.isInternal === true || !routableModels.has(modelId)) continue;
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
