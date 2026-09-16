/**
 * Virtual "combo" models: a client-facing model name that resolves to an
 * ordered list of real models. The proxy tries each target in order and
 * falls back to the next on failure.
 *
 * Storage mirrors model-mapping.ts: the table is created at runtime with an
 * idempotent CREATE (the drizzle migration journal is unreliable here) and
 * backed by an in-memory cache. resolveCombo() runs on the request hot path
 * so it stays synchronous.
 */
import { db, client } from "../db/index";
import { combos } from "../db/schema";
import { eq } from "drizzle-orm";

export interface ComboRow {
  id: number;
  name: string;
  targets: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

let cache: ComboRow[] = [];

/**
 * Reverse index: raw target id -> every ENABLED combo containing it, with the
 * slot it occupies. Rebuilt in loadCombos() so the hot path is a map lookup,
 * never a scan over all combos. Each bucket is ordered by combo id ascending,
 * so bucket[0] is always the lowest-id (earliest created) combo.
 */
let targetIndex = new Map<string, { combo: ComboRow; startIndex: number }[]>();

/**
 * Targets already reported as ambiguous. A raw id common to several combos is
 * resolved on every request, so warn once per process instead of per request.
 */
const warnedAmbiguousTargets = new Set<string>();

/**
 * Create the combos table out-of-band, same convention as model_mappings.
 * created_at/updated_at are ISO-8601 strings (contract requirement).
 */
export function ensureCombosTable(): void {
  client.exec(`
    CREATE TABLE IF NOT EXISTS combos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      targets TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

/**
 * Validate + normalize an array of combo targets. Throws Error with a
 * human-readable message on any violation:
 *   - must be an array of 1..10 strings
 *   - each string non-empty (after trim) and unique
 * Returns the trimmed unique list.
 */
export function parseTargets(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error("targets must be an array");
  }
  if (raw.length < 1 || raw.length > 10) {
    throw new Error("targets must contain between 1 and 10 models");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") {
      throw new Error("targets must be an array of non-empty strings");
    }
    const trimmed = t.trim();
    if (!trimmed) {
      throw new Error("targets must be an array of non-empty strings");
    }
    if (seen.has(trimmed)) {
      throw new Error(`duplicate target "${trimmed}"`);
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**

 * PURE resolver: combo NAME match against enabled combos only. Returns the
 * ordered targets, or null when no enabled combo matches.
 *
 * Names are compared case-insensitively so a client that lowercases the id
 * advertised by /v1/models ("glm-5.3" for combo "Glm-5.3") still reaches its
 * chain instead of silently falling through to the single-attempt path.
 * createCombo/updateCombo reject names that differ only by case, so this can
 * never match two combos. Targets are NOT lowercased.
 */
export function comboMatches(
  model: string,
  combos: { name: string; targets: string[]; enabled: boolean }[]
): string[] | null {
  const combo = combos.find((c) => c.enabled && c.name.toLowerCase() === model.toLowerCase());
  return combo ? combo.targets : null;
}

/** Sync hot-path lookup against the in-memory cache. */
export function resolveCombo(model: string): string[] | null {
  return comboMatches(model, cache);
}

/**
 * Reverse lookup: a RAW target id (e.g. "bansos-glm-5.3") promoted onto the
 * combo chain that contains it, starting AT that slot.
 *
 * Clients frequently send a raw upstream id instead of the combo name. That
 * id is not a combo NAME, so resolveCombo() returns null and the request takes
 * the single-attempt path with no fallback at all. This finds the owning combo
 * so the same chain can run from the requested slot onward.
 *
 * Callers MUST try resolveCombo() FIRST: a combo name always wins over a
 * raw-id match, so a combo legitimately named like another combo's target is
 * never stolen by that target.
 *
 * Ambiguity (the id sits in several enabled combos) resolves to the LOWEST
 * combo id — creation order — and warns once per process.
 */
export function resolveComboByTarget(
  model: string
): { name: string; targets: string[]; startIndex: number } | null {
  const bucket = targetIndex.get(model);
  if (!bucket || bucket.length === 0) return null;

  if (bucket.length > 1 && !warnedAmbiguousTargets.has(model)) {
    warnedAmbiguousTargets.add(model);
    console.warn(
      `[Combos] target "${model}" belongs to ${bucket.length} enabled combos ` +
        `(${bucket.map((b) => `#${b.combo.id} "${b.combo.name}"`).join(", ")}); ` +
        `resolving to #${bucket[0]!.combo.id} "${bucket[0]!.combo.name}" (lowest id)`
    );
  }

  const { combo, startIndex } = bucket[0]!;
  return { name: combo.name, targets: combo.targets, startIndex };
}

function rowToCombo(row: {
  id: number;
  name: string;
  targets: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}): ComboRow {
  return {
    id: row.id,
    name: row.name,
    targets: JSON.parse(row.targets) as string[],
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadCombos(): Promise<void> {
  // Ordered by id so bucket[0] is always the lowest-id combo (see bucket building).
  const rows = await db.select().from(combos).orderBy(combos.id);
  cache = [];
  targetIndex = new Map();
  for (const r of rows) {
    let combo: ComboRow;
    try {
      combo = rowToCombo(r);
    } catch {
      console.error(`[Combos] skipping combo "${r.name}" with unparseable targets`);
      continue;
    }
    cache.push(combo);

    // Reverse index shares the skip rule above and indexes ENABLED combos
    // only, so disabling a combo removes it from raw-id promotion too.
    if (!combo.enabled) continue;
    combo.targets.forEach((target, startIndex) => {
      const bucket = targetIndex.get(target);
      // Rows are ordered by id, so appending keeps each bucket sorted by
      // combo id ascending and bucket[0] the lowest id.
      if (bucket) bucket.push({ combo, startIndex });
      else targetIndex.set(target, [{ combo, startIndex }]);
    });
  }
}

/**
 * Reload the in-memory cache. Returns the load promise so callers CAN await
 * it — previously fire-and-forget, so `await updateCombo(...)` resolved before
 * the cache refreshed and a request racing an update saw the OLD order.
 */
export function invalidateComboCache(): Promise<void> {
  return loadCombos();
}

/** Ordered by id (creation order) so GET returns a stable, deterministic list. */
export async function listCombos(): Promise<ComboRow[]> {
  const rows = await db.select().from(combos).orderBy(combos.id);
  return rows.map(rowToCombo);
}

/**
 * Find a combo whose name collides with `name` case-insensitively. Matching is
 * case-insensitive (see comboMatches), so "Glm-5.3" and "glm-5.3" would both
 * resolve to one of them and the other would be unreachable by name. Reject
 * that at write time; the DB UNIQUE constraint cannot see it.
 */
async function findCaseInsensitiveClash(
  name: string,
  excludeId?: number
): Promise<{ id: number; name: string } | null> {
  const all = await db.select({ id: combos.id, name: combos.name }).from(combos);
  const lower = name.toLowerCase();
  return (
    all.find((c) => c.name.toLowerCase() === lower && c.id !== excludeId) ?? null
  );
}

export async function createCombo(input: {
  name: string;
  targets: string[];
  enabled?: boolean;
}): Promise<ComboRow> {
  const name = input.name.trim();
  if (!name) throw new Error("name must be a non-empty string");
  const targets = parseTargets(input.targets);
  const now = new Date().toISOString();

  const [existing] = await db.select().from(combos).where(eq(combos.name, name));
  if (existing) throw new Error(`combo name "${name}" already exists`);
  // Same name differing only in case would be unreachable: name matching is
  // case-insensitive, so reject it too. The DB UNIQUE constraint cannot.
  const clash = await findCaseInsensitiveClash(name);
  if (clash) {
    throw new Error(
      `combo name "${name}" already exists (case-insensitive clash with "${clash.name}")`
    );
  }

  const [row] = await db
    .insert(combos)
    // Absent means "on": the column default is true and updateCombo already
    // treats undefined as "leave alone", so a POST that omits `enabled` must
    // still produce a usable (enabled) combo.
    .values({
      name,
      targets: JSON.stringify(targets),
      enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("failed to create combo");

  await invalidateComboCache();
  return rowToCombo(row);
}

export async function updateCombo(
  id: number,
  input: { name?: string; targets?: string[]; enabled?: boolean }
): Promise<ComboRow | null> {
  const updates: Partial<{ name: string; targets: string; enabled: boolean; updatedAt: string }> = {
    updatedAt: new Date().toISOString(),
  };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("name must be a non-empty string");
    const [existing] = await db.select().from(combos).where(eq(combos.name, name));
    if (existing && existing.id !== id) throw new Error(`combo name "${name}" already exists`);
    // Renaming onto a name that differs only in case from ANOTHER combo would
    // make one of the two unreachable by name.
    const clash = await findCaseInsensitiveClash(name, id);
    if (clash) {
      throw new Error(
        `combo name "${name}" already exists (case-insensitive clash with "${clash.name}")`
      );
    }
    updates.name = name;
  }
  if (input.targets !== undefined) {
    updates.targets = JSON.stringify(parseTargets(input.targets));
  }
  if (input.enabled !== undefined) {
    updates.enabled = Boolean(input.enabled);
  }

  const [row] = await db.update(combos).set(updates).where(eq(combos.id, id)).returning();
  if (!row) return null;

  await invalidateComboCache();
  return rowToCombo(row);
}

export async function deleteCombo(id: number): Promise<boolean> {
  const [row] = await db.delete(combos).where(eq(combos.id, id)).returning();
  if (!row) return false;
  await invalidateComboCache();
  return true;
}

export function getCombosCached(): ComboRow[] {
  return cache;
}
