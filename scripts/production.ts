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

// Start backend — below normal priority (background task), low CPU impact
const backend = Bun.spawn(["bun", "src/index.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    PORT: port,
    NODE_ENV: "production",
  },
});

// Set below-normal priority for background processes via PowerShell
const backendPriorityCmd = `Get-Process -Id ${backend.pid} | ForEach-Object { $_.PriorityClass = 'BelowNormal' }`;
await Bun.spawn(["powershell", "-Command", backendPriorityCmd], {
  cwd: root,
  stdout: "ignore",
  stderr: "ignore",
});

try {
  const backendAffinityCmd = `$proc = Get-CimInstance Win32_Process -Filter "ProcessId=${backend.pid}"` + "; if($proc) { $null = $proc.SetAffinityMask(6) }";
  await Bun.spawn(["powershell", "-Command", backendAffinityCmd], {
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
  });
} catch {}

// Start dashboard static server — below normal priority (background task), low CPU impact
const dashboard = Bun.spawn(["bun", "run", "scripts/serve-dashboard.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    DASHBOARD_PORT: dashboardPort,
    NODE_ENV: "production",
  },
});

const priorityCmd = `Get-Process -Id ${dashboard.pid} | ForEach-Object { $_.PriorityClass = 'BelowNormal' }`;
await Bun.spawn(["powershell", "-Command", priorityCmd], {
  cwd: root,
  stdout: "ignore",
  stderr: "ignore",
});

try {
  const affinityCmd = `$proc = Get-CimInstance Win32_Process -Filter "ProcessId=${dashboard.pid}"` + "; if($proc) { $null = $proc.SetAffinityMask(6) }";
  await Bun.spawn(["powershell", "-Command", affinityCmd], {
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
  });
} catch {}

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  backend.kill();
  dashboard.kill();
  setTimeout(() => process.exit(code), 300).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// If either process dies, shut down both
backend.exited.then((code) => {
  if (!shuttingDown) {
    console.error(`[production] Backend exited with code ${code}`);
    shutdown(code || 1);
  }
});

dashboard.exited.then((code) => {
  if (!shuttingDown) {
    console.error(`[production] Dashboard exited with code ${code}`);
    shutdown(code || 1);
  }
});

await new Promise(() => {});
