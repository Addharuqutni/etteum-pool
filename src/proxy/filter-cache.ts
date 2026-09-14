import { db } from "../db/index";
import { filterRules } from "../db/schema";
import { asc } from "drizzle-orm";

/** Filter rule with regex precompiled at cache load (not per request). */
export interface CompiledFilter {
  regex?: RegExp;
  pattern: string;
  replacement: string;
}

export function compileFilter(pattern: string, replacement: string, isRegex: boolean): CompiledFilter {
  if (!isRegex) return { pattern, replacement };
  try {
    return { regex: new RegExp(pattern, "gi"), pattern, replacement };
  } catch (error) {
    console.error(`[Filter] Invalid regex pattern: ${pattern}`, error);
    return { pattern: "", replacement: "" }; // no-op, error logged once at load
  }
}

let cache: CompiledFilter[] = [];

export async function loadFilterCache(): Promise<void> {
  const rows = await db.select().from(filterRules).orderBy(asc(filterRules.sortOrder));
  cache = rows
    .filter((r) => r.isActive)
    .map((r) => compileFilter(r.pattern, r.replacement, r.isRegex));
}

export function getCompiledFilters(): CompiledFilter[] {
  return cache;
}

export function invalidateFilterCache(): void {
  loadFilterCache().catch((e) => console.error("[FilterCache] reload failed", e));
}
