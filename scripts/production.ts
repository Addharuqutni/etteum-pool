#!/usr/bin/env bun
/**
 * Production start script.
 *
 * 1. Builds dashboard (if needed)
 * 2. Starts backend (API + proxy on PORT)
 * 3. Starts dashboard static server (on DASHBOARD_PORT)
 *
 * Both are lightweight Bun processes. No Vite dev server.
 *
 * Usage:
 *   bun run production
 *   bun run scripts/production.ts
 *   bun run scripts/production.ts --skip-build
 */

import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dashboardDir = `${root}/dashboard`;
const dashboardDist = `${dashboardDir}/dist/index.html`;
const skipBuild = process.argv.includes("--skip-build");

const port = process.env.PORT || "1930";
const dashboardPort = process.env.DASHBOARD_PORT || "1931";

async function buildDashboard() {
  const distExists = await Bun.file(dashboardDist).exists();

  if (skipBuild && distExists) {
    console.log("[production] Skipping dashboard build (--skip-build)");
    return;
  }

  if (!skipBuild || !distExists) {
    console.log("[production] Building dashboard...");
    const proc = Bun.spawn(["bun", "run", "build"], {
      cwd: dashboardDir,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        VITE_BACKEND_PORT: port,
      },
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.error("[production] Dashboard build failed!");
      process.exit(1);
    }
    console.log("[production] Dashboard built successfully.\n");
  }
}

await buildDashboard();

console.log(`╔══════════════════════════════════════╗`);
console.log(`║   Pool Proxy — Production Mode       ║`);
console.log(`╠══════════════════════════════════════╣`);
console.log(`║  Backend:   http://localhost:${port}    ║`);
console.log(`║  Dashboard: http://localhost:${dashboardPort}    ║`);
console.log(`╚══════════════════════════════════════╝\n`);

let shuttingDown = false;
let backendProc: { kill: () => void } | null = null;
let dashboardProc: { kill: () => void } | null = null;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { backendProc?.kill(); } catch {}
  try { dashboardProc?.kill(); } catch {}
  setTimeout(() => process.exit(code), 300).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Auto-restart the backend when it dies (it owns the proxy + API). A Bun VM
// segfault / OOM-kill (exit 3/9 on Windows) is transient — treat a loop that
// crashes within seconds of boot as fatal, but otherwise bring the proxy back
// up with backoff so one bad stream can't take the whole service down.
let backendRestarts = 0;
const MAX_BACKEND_RESTARTS = 5;
const restartDelay = (n: number) => Math.min(30_000, 1000 * 2 ** n);

/**
 * Run a spawned process below normal priority and pinned to two CPUs
 * (affinity mask 6 = cores 1-2), so a busy proxy does not starve the rest of
 * the machine. Best-effort: the PowerShell calls are fire-and-forget and a
 * failure here must not stop startup.
 */
function lowerPriorityAndPin(pid: number) {
  const priorityCmd = `Get-Process -Id ${pid} | ForEach-Object { $_.PriorityClass = 'BelowNormal' }`;
  void Bun.spawn(["powershell", "-Command", priorityCmd], { cwd: root, stdout: "ignore", stderr: "ignore" });
  try {
    const affinityCmd = `$proc = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"` + "; if($proc) { $null = $proc.SetAffinityMask(6) }";
    void Bun.spawn(["powershell", "-Command", affinityCmd], { cwd: root, stdout: "ignore", stderr: "ignore" });
  } catch {}
}

async function startBackend() {
  const p = Bun.spawn(["bun", "src/index.ts"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, PORT: port, NODE_ENV: "production" },
  });
  backendProc = p;
  lowerPriorityAndPin(p.pid);

  const bootTime = Date.now();
  p.exited.then((code) => {
    if (shuttingDown) return;
    const upMs = Date.now() - bootTime;
    // Crash within the first 15s is likely deterministic (config/boot bug),
    // not a transient — give up quickly rather than hot-looping.
    if (upMs < 15_000 || backendRestarts >= MAX_BACKEND_RESTARTS) {
      console.error(`[production] Backend exited with code ${code} after ${upMs}ms; giving up after ${backendRestarts} restart(s)`);
      shutdown(code || 1);
      return;
    }
    backendRestarts++;
    const delay = restartDelay(backendRestarts);
    console.error(`[production] Backend exited with code ${code} after ${upMs}ms; restarting in ${delay}ms (attempt ${backendRestarts}/${MAX_BACKEND_RESTARTS})`);
    setTimeout(startBackend, delay).unref();
  });
}

void startBackend();

async function startDashboard() {
  const p = Bun.spawn(["bun", "run", "scripts/serve-dashboard.ts"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, DASHBOARD_PORT: dashboardPort, NODE_ENV: "production" },
  });
  dashboardProc = p;
  lowerPriorityAndPin(p.pid);

  p.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`[production] Dashboard exited with code ${code}; restarting`);
      setTimeout(startDashboard, 2000).unref();
    }
  });
}

void startDashboard();

await new Promise(() => {});
