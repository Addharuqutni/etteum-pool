/**
 * Compression module — shared types.
 *
 * The compression pipeline takes a (sanitized) ChatCompletionRequest and
 * returns a smaller equivalent request plus a CompressionStats record that
 * is attached to request_logs.compression_stats for telemetry.
 *
 * Pipeline order is intentional:
 *   1. DCP          — lossless dedup (cheapest savings, must run first so
 *                     subsequent steps don't compress already-removable text)
 *   2. RTK          — lossy tool-result truncation
 *   3. Caveman      — lossy system-prompt compaction (off by default)
 *   4. Image dedupe — lossless image block dedup
 *   5. Cache markers — final pass: insert cache_control on stable prefix
 */

export type CavemanLevel = "lite" | "full" | "ultra";

export interface RTKConfig {
  enabled: boolean;
  /** Cap (in chars) per tool_result block in older turns. */
  maxToolChars: number;
  /** How many trailing turns to leave fully untouched. */
  keepLastNTurnsFull: number;
  /** When true, recognise common command shapes (git diff, tree, ls -R, …). */
  smartTruncate: boolean;
}

export interface DCPConfig {
  enabled: boolean;
  /** Tool names whose outputs are safe to dedup (idempotent / read-only). */
  whitelist: string[];
}

export interface CavemanConfig {
  enabled: boolean;
  level: CavemanLevel;
}

export interface CacheMarkerConfig {
  enabled: boolean;
  /** Per-provider override, e.g. { codex: false } skips cache markers for codex. */
  providerOverrides: Record<string, boolean>;
}

export interface ImageDedupeConfig {
  enabled: boolean;
}

export type PonytailMode = "lite" | "full" | "ultra";

/**
 * Ponytail — Lazy-dev ruleset injection.
 *
 * Injects a "lazy senior dev" ruleset (adapted from
 * https://github.com/DietrichGebert/ponytail, MIT) into the system prompt.
 * Unlike other techniques this is ADDITIVE: it adds ~300-1400 tokens to the
 * input. The payoff is fewer output tokens (shorter code, fewer tool calls)
 * and corner-cutting markers the model leaves in its output for audit.
 */
export interface PonytailConfig {
  enabled: boolean;
  /** Ruleset intensity — lite/full/ultra trade overhead vs behavior change. */
  mode: PonytailMode;
  /** Per-provider override, e.g. { codex: false } skips injection for codex. */
  providerOverrides: Record<string, boolean>;
  /** Strip `ponytail:` markers from the stored response body. */
  stripMarkersFromOutput: boolean;
}

export interface PonytailMarkerHit {
  /** The ceiling/shortcut name, e.g. "O(n²) scan". */
  ceiling: string;
  /** Upgrade path text from the marker. */
  upgradePath: string;
  /** Where in the response the marker was found. */
  location: "content" | "tool_input" | "tool_result";
}

export interface TSCConfig {
  enabled: boolean;
  /** Strip whitespace from tool JSON-schema (lossless). */
  stripSchemaWhitespace: boolean;
  /** Trim repeated whitespace from tool descriptions (>= 2 spaces / blank lines). */
  trimDescriptions: boolean;
  /**
   * Drop $schema, $id, additionalProperties:false noise from tool input_schema.
   * Lossless w.r.t. tool semantics (model never reads these fields).
   */
  dropSchemaMeta: boolean;
}

export interface CompressionConfig {
  rtk: RTKConfig;
  dcp: DCPConfig;
  caveman: CavemanConfig;
  cacheMarkers: CacheMarkerConfig;
  imageDedupe: ImageDedupeConfig;
  tsc: TSCConfig;
}

export type CompressionTechnique =
  | "rtk"
  | "dcp"
  | "caveman"
  | "imageDedupe"
  | "cacheMarkers"
  | "tsc";

export interface CompressionStats {
  /** Estimated tokens before compression. */
  tokensBefore: number;
  /** Estimated tokens after compression. */
  tokensAfter: number;
  /** tokensBefore - tokensAfter (>= 0). */
  saved: number;
  /** Percentage saved, 0-100, rounded to 2 decimals. */
  savedPct: number;
  /** Per-technique tokens saved (only includes techniques that ran). */
  byTechnique: Partial<Record<CompressionTechnique, number>>;
  /**
   * Per-shape-filter savings inside RTK (e.g. "git-diff", "dedup-log",
   * "read-numbered", "generic"). Aggregated across all tool_result blocks
   * touched in this request.
   */
  rtkFilters?: Record<string, number>;
  /** Wall-clock duration of the pipeline in ms. */
  durationMs: number;
}

export const DEFAULT_DCP_WHITELIST = ["Read", "Glob", "Grep", "LS", "WebFetch"];

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  rtk: {
    enabled: true,
    maxToolChars: 4000,
    keepLastNTurnsFull: 2,
    smartTruncate: true,
  },
  dcp: {
    enabled: false,
    whitelist: [...DEFAULT_DCP_WHITELIST],
  },
  caveman: {
    enabled: false,
    level: "lite",
  },
  cacheMarkers: {
    enabled: true,
    providerOverrides: { codex: false },
  },
  imageDedupe: {
    enabled: true,
  },
  tsc: {
    enabled: true,
    stripSchemaWhitespace: true,
    trimDescriptions: true,
    dropSchemaMeta: true,
  },
};

/** Empty stats — used when compression is fully disabled or as initial value. */
export function emptyStats(): CompressionStats {
  return {
    tokensBefore: 0,
    tokensAfter: 0,
    saved: 0,
    savedPct: 0,
    byTechnique: {},
    durationMs: 0,
  };
}
