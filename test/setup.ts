import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate tests off the production DB. Bun loads .env BEFORE preload runs,
// and .env sets DATABASE_PATH to the prod file — so this MUST be an
// unconditional assignment (`??=` is a no-op here and leaves tests pointed
// at production, where DB-touching tests delete REAL account rows:
// request_logs.account_id → accounts.id is ON DELETE NO ACTION).
process.env.DATABASE_PATH = join(tmpdir(), `etteum-test-${process.pid}.db`);

const { runMigrations } = await import("../src/db/migrate");
await runMigrations();

const { ensureModelMappingTable } = await import("../src/proxy/model-mapping");
ensureModelMappingTable();

const { ensureCombosTable } = await import("../src/proxy/combos");
ensureCombosTable();
