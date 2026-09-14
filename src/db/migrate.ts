import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db, client } from "./index";
import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";

/**
 * Idempotent column-add migrations.
 * The drizzle/ folder is gitignored in this repo — fresh deploys would never
 * see file-based migrations for new columns. Each entry below adds a column
 * if it doesn't already exist; safe to run on every boot.
 *
 * Order: from oldest schema additions to newest. Add to the END of the list
 * when you add a new column to schema.ts.
 */
const IDEMPOTENT_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  // 2026-06-13 — compression_stats (token-saver telemetry, see src/proxy/compression/)
  { table: "request_logs", column: "compression_stats", ddl: "ALTER TABLE request_logs ADD COLUMN compression_stats TEXT" },
  // 2026-06-14 — legacy free-credit columns (formerly Qoder free counter).
  // Retained for DB compatibility; no live provider writes them.
  { table: "accounts", column: "free_limit",     ddl: "ALTER TABLE accounts ADD COLUMN free_limit REAL DEFAULT 0" },
  { table: "accounts", column: "free_remaining", ddl: "ALTER TABLE accounts ADD COLUMN free_remaining REAL DEFAULT 0" },
  { table: "accounts", column: "free_reset_at",  ddl: "ALTER TABLE accounts ADD COLUMN free_reset_at INTEGER" },
  // 2026-09-09 — proxy pool priority (higher = preferred by weighted selection).
  { table: "proxy_pool", column: "priority",     ddl: "ALTER TABLE proxy_pool ADD COLUMN priority INTEGER DEFAULT 0" },
  // 2026-09-10 — per-proxy usage scope (all | model | auth).
  { table: "proxy_pool", column: "usage",        ddl: "ALTER TABLE proxy_pool ADD COLUMN usage TEXT DEFAULT 'all'" },
];

// Indexes that must exist for upserts (CREATE INDEX IF NOT EXISTS is idempotent).
const IDEMPOTENT_INDEXES: Array<{ name: string; ddl: string }> = [
  {
    name: "api_key_usage_key_period_idx",
    ddl: "CREATE UNIQUE INDEX IF NOT EXISTS api_key_usage_key_period_idx ON api_key_usage(api_key_id, period)",
  },
];
// Tables that may not exist on fresh deploys (drizzle/ folder is gitignored).
// CREATE TABLE IF NOT EXISTS must stay in sync with schema.ts.
const IDEMPOTENT_TABLES: Array<{ table: string; ddl: string }> = [
  {
    table: "api_keys",
    ddl: `CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      key_hash TEXT NOT NULL UNIQUE,
      key_enc TEXT NOT NULL DEFAULT '',
      key_prefix TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      revoked_at INTEGER,
      last_used_at INTEGER,
      expires_at INTEGER,
      monthly_token_budget INTEGER NOT NULL DEFAULT 0,
      one_time_token_budget INTEGER NOT NULL DEFAULT 0,
      rpm_limit INTEGER NOT NULL DEFAULT 0,
      max_concurrent INTEGER NOT NULL DEFAULT 0,
      allowed_providers TEXT NOT NULL DEFAULT '[]',
      denied_providers TEXT NOT NULL DEFAULT '[]',
      allowed_models TEXT NOT NULL DEFAULT '[]',
      denied_models TEXT NOT NULL DEFAULT '[]',
      share_enabled INTEGER NOT NULL DEFAULT 0,
      share_slug TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    )`,
  },
  {
    table: "api_key_usage",
    ddl: `CREATE TABLE IF NOT EXISTS api_key_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER NOT NULL REFERENCES api_keys(id),
      period TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    )`,
  },
];

function tableHasColumn(table: string, column: string): boolean {
  try {
    const rows = client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

async function runIdempotentColumns() {
  for (const m of IDEMPOTENT_COLUMNS) {
    if (tableHasColumn(m.table, m.column)) continue;
    try {
      await db.run(sql.raw(m.ddl));
      console.log(`[DB] Added column ${m.table}.${m.column}`);
    } catch (err) {
      // Re-check: another process may have added it concurrently.
      if (!tableHasColumn(m.table, m.column)) {
        console.error(`[DB] Failed to add ${m.table}.${m.column}:`, err);
      }
    }
  }
}

async function runIdempotentTables() {
  for (const { table, ddl } of IDEMPOTENT_TABLES) {
    try {
      await db.run(sql.raw(ddl));
    } catch (err) {
      console.error(`[DB] Failed to ensure table ${table}:`, err);
    }
  }
  for (const { name, ddl } of IDEMPOTENT_INDEXES) {
    try {
      await db.run(sql.raw(ddl));
    } catch (err) {
      console.error(`[DB] Failed to ensure index ${name}:`, err);
    }
  }
}

export async function runMigrations() {
  const migrationsFolder = "./drizzle";

  // Only run file-based migrations if the folder exists
  if (existsSync(`${migrationsFolder}/meta/_journal.json`)) {
    console.log("[DB] Running migrations...");
    await migrate(db, { migrationsFolder });
    console.log("[DB] Migrations complete.");
  } else {
    console.log("[DB] No migrations found, skipping. Use 'bun run db:push' to sync schema.");
  }

  // Always run idempotent column-add migrations (works on fresh deploys without drizzle/).
  await runIdempotentColumns();
  // Always ensure new tables exist (same gitignored-drizzle rationale).
  await runIdempotentTables();
}

// Run if called directly
if (import.meta.main) {
  await runMigrations();
  console.log("[DB] Database migrated successfully");
  process.exit(0);
}
