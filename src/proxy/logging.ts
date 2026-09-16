import { config } from "../config";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { like } from "drizzle-orm";

export interface TruncatedLogBody {
  truncated: true;
  originalBytes: number;
  maxBytes: number;
  preview: string;
}

export interface UnserializableLogBody {
  unserializable: true;
  reason: string;
  preview: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Keys whose values carry raw prompt/response text. Redacted before storage so
// request_logs never persists (and can never replay) client prompts/conversation.
const REDACT_KEYS = new Set([
  "content", "text", "system", "arguments",
  "reasoning_content", "thinking", "input", "partial_json", "description",
]);

function redactLogBody(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(redactLogBody);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(key)) {
        if (typeof val === "string") {
          out[key] = `[redacted ${val.length} chars]`;
        } else if (val == null) {
          out[key] = val;
        } else {
          const len = JSON.stringify(val)?.length ?? 0;
          out[key] = `[redacted ${len} chars]`;
        }
      } else {
        out[key] = redactLogBody(val);
      }
    }
    return out;
  }
  return value;
}

export interface StreamLogSummary {
  stream: true;
  model: string;
  contentPreview: string;
  contentBytes: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  _poolprox: { creditSource: string };
}

// Ringkasan minimal body stream: teks terkumpul + usage. prepareLogBody tetap
// yang menangani redact/truncate agar tak ada logika potong ganda di sini.
export function buildStreamLogSummary(args: {
  model: string;
  content: string;
  contentBytes: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  creditSource: string;
}): StreamLogSummary {
  return {
    stream: true,
    model: args.model,
    contentPreview: args.content,
    contentBytes: args.contentBytes,
    usage: {
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      totalTokens: args.totalTokens,
    },
    _poolprox: { creditSource: args.creditSource },
  };
}

export interface LogBodyConfig {
  logBodyEnabled: boolean;
  logBodyRedact: boolean;
  logBodyFull: boolean;
  logBodyMaxBytes: number;
}

export interface RequestLogRetentionConfig {
  maxRecords: number;
  retentionDays: number;
}

const LOG_SETTINGS_TTL_MS = 10_000;

interface LogSettings {
  logBody: LogBodyConfig;
  retention: RequestLogRetentionConfig;
}

let logSettingsCache: (LogSettings & { loadedAt: number }) | null = null;
let logSettingsInflight: Promise<LogSettings> | null = null;

function parseBoolSetting(v: string | null | undefined, dflt: boolean): boolean {
  if (v == null) return dflt;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return dflt;
}

function parseIntSetting(v: string | null | undefined, dflt: number, min: number, max: number): number {
  if (v == null) return dflt;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export function getDefaultLogBodyConfig(): LogBodyConfig {
  return {
    logBodyEnabled: config.logBodyEnabled,
    logBodyRedact: config.logBodyRedact,
    logBodyFull: config.logBodyFull,
    logBodyMaxBytes: config.logBodyMaxBytes,
  };
}

export function getDefaultRequestLogRetentionConfig(): RequestLogRetentionConfig {
  return { maxRecords: 500, retentionDays: 0 };
}

/** Read every `request_log_*` key in one query and coerce to typed config. */
async function loadLogSettingsFromDb(): Promise<LogSettings> {
  const rows = await db.select().from(settings).where(like(settings.key, "request_log_%"));
  const map = new Map<string, string | null>();
  for (const r of rows) map.set(r.key, r.value);

  const dfltBody = getDefaultLogBodyConfig();
  const dfltRetention = getDefaultRequestLogRetentionConfig();

  return {
    logBody: {
      logBodyEnabled: parseBoolSetting(map.get("request_log_body_enabled"), dfltBody.logBodyEnabled),
      logBodyRedact: parseBoolSetting(map.get("request_log_body_redact"), dfltBody.logBodyRedact),
      logBodyFull: parseBoolSetting(map.get("request_log_body_full"), dfltBody.logBodyFull),
      logBodyMaxBytes: parseIntSetting(
        map.get("request_log_body_max_bytes"),
        dfltBody.logBodyMaxBytes,
        0,
        10 * 1024 * 1024
      ),
    },
    retention: {
      maxRecords: parseIntSetting(map.get("request_log_max_records"), dfltRetention.maxRecords, 0, 1_000_000),
      retentionDays: parseIntSetting(map.get("request_log_retention_days"), dfltRetention.retentionDays, 0, 3650),
    },
  };
}

function lastKnownOrDefaults(): LogSettings {
  return {
    logBody: logSettingsCache?.logBody ?? getDefaultLogBodyConfig(),
    retention: logSettingsCache?.retention ?? getDefaultRequestLogRetentionConfig(),
  };
}

/**
 * Kick off a refresh when the cache is cold or stale. Synchronous on purpose:
 * prepareLogBody() runs on the request path and must not await, so it reads
 * whatever the cache holds and the next call observes the fresh values.
 */
function ensureLogSettingsCache(): void {
  const now = Date.now();
  if (logSettingsCache && now - logSettingsCache.loadedAt < LOG_SETTINGS_TTL_MS) return;
  if (logSettingsInflight) return;

  logSettingsInflight = loadLogSettingsFromDb()
    .then((res) => {
      logSettingsCache = { ...res, loadedAt: Date.now() };
      return res;
    })
    .catch((err) => {
      console.error("[Logging] Failed to load request log settings:", err);
      return lastKnownOrDefaults();
    })
    .finally(() => {
      logSettingsInflight = null;
    });
}

export function getCachedLogBodyConfig(): LogBodyConfig {
  ensureLogSettingsCache();
  return logSettingsCache?.logBody ?? getDefaultLogBodyConfig();
}

export function getCachedRequestLogRetentionConfig(): RequestLogRetentionConfig {
  ensureLogSettingsCache();
  return logSettingsCache?.retention ?? getDefaultRequestLogRetentionConfig();
}

export async function getLogBodyConfig(): Promise<LogBodyConfig> {
  const now = Date.now();
  if (logSettingsCache && now - logSettingsCache.loadedAt < LOG_SETTINGS_TTL_MS) {
    return logSettingsCache.logBody;
  }
  try {
    const res = await loadLogSettingsFromDb();
    logSettingsCache = { ...res, loadedAt: now };
    return res.logBody;
  } catch (err) {
    console.error("[Logging] Failed to load request log settings:", err);
    return lastKnownOrDefaults().logBody;
  }
}

export async function getRequestLogRetentionConfig(): Promise<RequestLogRetentionConfig> {
  const now = Date.now();
  if (logSettingsCache && now - logSettingsCache.loadedAt < LOG_SETTINGS_TTL_MS) {
    return logSettingsCache.retention;
  }
  try {
    const res = await loadLogSettingsFromDb();
    logSettingsCache = { ...res, loadedAt: now };
    return res.retention;
  } catch (err) {
    console.error("[Logging] Failed to load retention settings:", err);
    return lastKnownOrDefaults().retention;
  }
}

export function invalidateLoggingCache(): void {
  logSettingsCache = null;
  logSettingsInflight = null;
}

/**
 * Re-read the settings table and publish the result before returning, so a
 * caller that just saved a `request_log_*` key cannot serve one request with
 * the previous values. Logs and keeps the last-known values on failure.
 */
export async function reloadLoggingCache(): Promise<void> {
  try {
    logSettingsCache = { ...(await loadLogSettingsFromDb()), loadedAt: Date.now() };
  } catch (err) {
    console.error("[Logging] Failed to load request log settings:", err);
  }
}

export function isRequestLogSettingKey(key: string): boolean {
  return key.startsWith("request_log_");
}

export function prepareLogBody(value: unknown): unknown {
  const { logBodyEnabled, logBodyFull, logBodyRedact, logBodyMaxBytes } = getCachedLogBodyConfig();
  if (!logBodyEnabled) return null;
  if (logBodyFull) return value;

  const redacted = logBodyRedact ? redactLogBody(value) : value;

  const maxBytes = Math.max(0, logBodyMaxBytes);
  const serialized = serializeForLog(redacted);
  const bytes = encoder.encode(serialized).byteLength;

  if (bytes <= maxBytes) return redacted;

  return {
    truncated: true,
    originalBytes: bytes,
    maxBytes,
    preview: truncateUtf8(serialized, maxBytes),
  } satisfies TruncatedLogBody;
}

function serializeForLog(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      unserializable: true,
      reason,
      preview: String(value),
    } satisfies UnserializableLogBody);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return decoder.decode(bytes.slice(0, maxBytes));
}
