/**
 * Model mapping for CLI integration (Claude Code, etc.).
 *
 * Popular CLIs (notably Claude Code) hardcode their own model ids — e.g.
 * "claude-3-5-haiku-20241022", "claude-sonnet-4-20250514". The user only sets a
 * base URL + API key; the CLI keeps calling those Anthropic model ids. This
 * module rewrites the incoming model id at the proxy edge to a target model
 * actually available in the pool, configured from the dashboard.
 *
 * Rules are read from an in-memory cache (DB-backed), mirroring filter-cache.ts.
 * resolveModelAlias() runs on the request hot path so it must stay synchronous.
 */
import { db, client } from "../db/index";
import { modelMappings, settings, type ModelMapping } from "../db/schema";
import { asc, eq } from "drizzle-orm";
import { getByokProvider } from "./providers/registry";

const MAPPING_ENABLED_SETTING = "model_mapping_enabled";

let cache: ModelMapping[] = [];
/**
 * Precomputed match structures, rebuilt by loadModelMappingCache().
 * Hot path (resolveModelAlias) must not lowercase per rule or construct
 * RegExp per request — both allocate and regex compile is expensive.
 */
interface CompiledMapping {
   rule: ModelMapping;
   sourceLower: string;
   regex: RegExp | null;
 }
let compiled: CompiledMapping[] = [];
let masterEnabled = true;
/**
 * Default mappings seeded on first boot. Templates for Claude Code's three
 * model classes (haiku / sonnet / opus). They start disabled with an empty
 * target so nothing changes until the user wires them up in the dashboard.
 */
export const DEFAULT_MODEL_MAPPINGS: Array<{
  sourcePattern: string;
  matchType: string;
  targetModel: string;
  enabled: boolean;
  priority: number;
  label: string;
}> = [
  { sourcePattern: "haiku", matchType: "contains", targetModel: "", enabled: false, priority: 0, label: "Claude Code · Haiku (small/fast)" },
  { sourcePattern: "sonnet", matchType: "contains", targetModel: "", enabled: false, priority: 1, label: "Claude Code · Sonnet (main)" },
  { sourcePattern: "opus", matchType: "contains", targetModel: "", enabled: false, priority: 2, label: "Claude Code · Opus (heavy)" },
];

/**
 * Create the table out-of-band. The drizzle file-migration journal in this repo
 * is inconsistent (only 0000 is registered), so we guarantee the table exists at
 * runtime with an idempotent CREATE rather than relying on the migrator alone.
 */
export function ensureModelMappingTable(): void {
  client.exec(`
    CREATE TABLE IF NOT EXISTS model_mappings (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      source_pattern text NOT NULL,
      match_type text DEFAULT 'contains' NOT NULL,
      target_model text DEFAULT '' NOT NULL,
      enabled integer DEFAULT 1 NOT NULL,
      priority integer DEFAULT 0 NOT NULL,
      label text,
      created_at integer NOT NULL,
      updated_at integer
    );
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS model_mappings_priority_idx ON model_mappings (priority);`
  );
}

/** Seed default mappings if the table is empty (first boot only). */
export async function seedModelMappings(): Promise<void> {
  const [row] = await db
    .select({ count: modelMappings.id })
    .from(modelMappings)
    .limit(1);
  if (row) return; // already has rows
  await db.insert(modelMappings).values(
    DEFAULT_MODEL_MAPPINGS.map((m) => ({
      sourcePattern: m.sourcePattern,
      matchType: m.matchType,
      targetModel: m.targetModel,
      enabled: m.enabled,
      priority: m.priority,
      label: m.label,
    }))
  );
}

/** Load mappings + master toggle into the in-memory cache. */
export async function loadModelMappingCache(): Promise<void> {
  cache = await db.select().from(modelMappings).orderBy(asc(modelMappings.priority));
  compiled = cache.map((rule) => {
     const sourceLower = rule.sourcePattern.toLowerCase();
     let regex: RegExp | null = null;
     if (rule.matchType === "regex" && rule.sourcePattern) {
       try {
         regex = new RegExp(rule.sourcePattern, "i");
       } catch (e) {
         console.error(`[ModelMapping] invalid regex "${rule.sourcePattern}":`, e);
       }
     }
     return { rule, sourceLower, regex };
   });
  const [setting] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, MAPPING_ENABLED_SETTING));
   // Default ON when the setting was never written.
  masterEnabled = setting?.value == null ? true : setting.value !== "false";
 }

export function invalidateModelMappingCache(): void {
  loadModelMappingCache().catch((e) => console.error("[ModelMapping] reload failed", e));
}

export function getModelMappingsCached(): ModelMapping[] {
  return cache;
}

export function isModelMappingEnabled(): boolean {
  return masterEnabled;
}

function matchesCompiled(modelLower: string, c: CompiledMapping): boolean {
  if (!c.sourceLower) return false;
  switch (c.rule.matchType) {
    case "exact":
       return modelLower === c.sourceLower;
    case "regex":
       if (!c.regex) return false;
       try {
         return c.regex.test(modelLower);
       } catch {
         return false;
       }
    case "contains":
    default:
       return modelLower.includes(c.sourceLower);
  }
 }

/**
 * Model ids that are native to a specific in-pool provider (not the assistant's
 * generic anthropic ids) should bypass mapping entirely — otherwise calling
 * `claude_sonnet_4_6_vertex` directly gets rewritten by the "sonnet" template.
 *
 * the assistant only ever sends DASHED ids ("claude-3-5-sonnet-..."), so using
 * underscore presence as the discriminator is a safe and zero-config rule.
 */
function isNativeProviderId(model: string): boolean {
   // Underscore-style identifiers: claude_sonnet_4_6, gpt_5_codex, gemini_3_5_flash, …
   // (startsWith trio — cheaper than a regex test on every request).
  if (model.startsWith("claude_") || model.startsWith("gpt_") || model.startsWith("gemini_")) return true;
  // Explicit alias prefixes used by routed providers:
  if (model.startsWith("qd-")) return true;          // Qoder (legacy, kept for id stability)
  if (model.startsWith("cb-")) return true;          // CodeBuddy
  if (model.startsWith("ym-")) return true;          // YouMind (legacy, kept for id stability)
  // BYOK account ids ("prefix-model", e.g. "genspark-claude-opus-5") are valid
  // in-pool ids — the generic "opus"/"sonnet"/"haiku" templates must never
  // rewrite them (same rationale as the underscore rule above).
  if (getByokProvider().ownsModel(model)) return true;
  return false;
}

/**
 * Rewrite an incoming model id to its mapped target, if any. Single pass (no
 * recursive remapping). Returns the original model when mapping is disabled,
 * no rule matches, the target is empty/identical, or the id is a native
 * in-pool provider id (which is never the target of a generic the assistant
 * mapping).
 */
export function resolveModelAlias(model: string): string {
  if (!model || !masterEnabled) return model;
  if (isNativeProviderId(model)) return model;
  const modelLower = model.toLowerCase();
  for (const c of compiled) {
    if (!c.rule.enabled) continue;
    if (!c.rule.targetModel) continue;
    if (matchesCompiled(modelLower, c)) {
      return c.rule.targetModel === model ? model : c.rule.targetModel;
     }
   }
  return model;
 }
