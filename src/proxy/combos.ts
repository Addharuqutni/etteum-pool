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
 * PURE resolver: exact name match against enabled combos only. Returns the
 * ordered targets, or null when no enabled combo matches.
 */
export function comboMatches(
  model: string,
  combos: { name: string; targets: string[]; enabled: boolean }[]
): string[] | null {
  const combo = combos.find((c) => c.enabled && c.name === model);
  return combo ? combo.targets : null;
}

/** Sync hot-path lookup against the in-memory cache. */
export function resolveCombo(model: string): string[] | null {
  return comboMatches(model, cache);
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

/** Load all combos into the in-memory cache. Unparseable targets are skipped. */
export async function loadCombos(): Promise<void> {
  const rows = await db.select().from(combos);
  cache = [];
  for (const r of rows) {
    try {
      cache.push(rowToCombo(r));
    } catch {
      console.error(`[Combos] skipping combo "${r.name}" with unparseable targets`);
    }
  }
}

export function invalidateComboCache(): void {
  loadCombos().catch((e) => console.error("[Combos] reload failed", e));
}

/** Ordered by id (creation order) so GET returns a stable, deterministic list. */
export async function listCombos(): Promise<ComboRow[]> {
  const rows = await db.select().from(combos).orderBy(combos.id);
  return rows.map(rowToCombo);
}

export async function createCombo(input: {
  name: string;
  targets: string[];
}): Promise<ComboRow> {
  const name = input.name.trim();
  if (!name) throw new Error("name must be a non-empty string");
  const targets = parseTargets(input.targets);
  const now = new Date().toISOString();

  const [existing] = await db.select().from(combos).where(eq(combos.name, name));
  if (existing) throw new Error(`combo name "${name}" already exists`);

  const [row] = await db
    .insert(combos)
    .values({ name, targets: JSON.stringify(targets), createdAt: now, updatedAt: now })
    .returning();
  if (!row) throw new Error("failed to create combo");

  invalidateComboCache();
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

  invalidateComboCache();
  return rowToCombo(row);
}

export async function deleteCombo(id: number): Promise<boolean> {
  const [row] = await db.delete(combos).where(eq(combos.id, id)).returning();
  if (!row) return false;
  invalidateComboCache();
  return true;
}

export function getCombosCached(): ComboRow[] {
  return cache;
}
