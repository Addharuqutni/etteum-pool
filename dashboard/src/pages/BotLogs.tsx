import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/layout/PageHeader";
import { clearAuthLogs, fetchAuthLogs, fetchAuthQueue, fetchWarmupQueue, loginAccount, loginAccounts, stopAllAccounts } from "@/lib/api";
import { useWsEvent, useWsStatus } from "@/hooks/useWebSocket";
import { AlertTriangle, CheckCircle, ChevronDown, RefreshCw, RotateCcw, Trash2, Radio, StopCircle } from "lucide-react";
import { formatTimeID } from "@/lib/utils";

interface AuthLog {
  id: number;
  timestamp: string;
  type: string;
  accountId?: number;
  email?: string;
  provider?: string;
  step?: string;
  message?: string;
  error?: string;
  data?: unknown;
}

interface ProcessLog {
  key: string;
  operation: string;
  latest: AuthLog;
  events: AuthLog[];
  startedAt: string;
  updatedAt: string;
}

const liveTypes: string[] = [
  "queue_added", "queue_processing", "login_progress", "login_success", "login_failed", "queue_complete", "queue_cleared",
];
// Note: warmup_* events are explicitly filtered out - Login Logs only shows login operations

function statusVariant(type: string): "success" | "warning" | "error" | "secondary" {
  if (type.includes("success") || type === "queue_complete" || type === "warmup_complete") return "success";
  if (type.includes("failed") || type.includes("auth_error")) return "error";
  if (type.includes("processing") || type.includes("progress") || type.includes("exhausted") || type.includes("transient") || type.includes("unsupported")) return "warning";
  return "secondary";
}

function processStatusVariant(process: ProcessLog): "success" | "warning" | "error" | "secondary" {
  if (process.events.some((log) => log.type === "login_success" || log.type === "warmup_success")) return "success";
  if (process.events.some((log) => log.type === "login_failed" || log.type === "warmup_auth_error")) return "error";
  return statusVariant(process.latest.type);
}

function processStatusLabel(process: ProcessLog) {
  if (process.events.some((log) => log.type === "login_success" || log.type === "warmup_success")) return "success";
  if (process.events.some((log) => log.type === "login_failed" || log.type === "warmup_auth_error")) return "error";
  return statusLabel(process.latest.type);
}

function providerLabel(provider?: string) {
  if (!provider) return "-";
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "codebuddy-china") return "CodeBuddy CN";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function operationFor(type: string) {
  return type.startsWith("warmup_") ? "WarmUp" : "Login";
}

function processKey(log: AuthLog) {
  const account = log.accountId || log.email || log.id;
  return `${operationFor(log.type)}-${account}`;
}

function statusLabel(type: string) {
  return type.replace(/^login_/, "").replace(/^warmup_/, "").replace(/^queue_/, "").replace(/_/g, " ");
}

function mergeLogs(current: AuthLog[], incoming: AuthLog[]) {
  const map = new Map<string, AuthLog>();
  for (const log of [...current, ...incoming]) {
    const key = `${log.id}-${log.timestamp}-${log.type}-${log.accountId || ""}-${log.step || ""}`;
    map.set(key, log);
  }
  return [...map.values()]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function logsToProcesses(logs: AuthLog[]): ProcessLog[] {
  const groups = new Map<string, ProcessLog>();
  const oldestFirst = [...logs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  for (const log of oldestFirst) {
    const key = processKey(log);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        operation: operationFor(log.type),
        latest: log,
        events: [log],
        startedAt: log.timestamp,
        updatedAt: log.timestamp,
      });
      continue;
    }

    existing.events.push(log);
    existing.latest = { ...log, email: log.email || existing.latest.email, provider: log.provider || existing.latest.provider };
    existing.updatedAt = log.timestamp;
  }

  // Sort by queue order (startedAt) — position stays stable as new logs arrive
  return [...groups.values()].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

export default function BotLogs() {
  const [logs, setLogs] = useState<AuthLog[]>([]);
  const [queue, setQueue] = useState<any>(null);
  const [warmupQueue, setWarmupQueue] = useState<any>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const perPage = 25;
  const queueRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsStatus = useWsStatus();
  const connected = wsStatus === "open";

  async function load() {
    const [logRes, queueRes] = await Promise.all([
      fetchAuthLogs(300) as Promise<{ data: AuthLog[] }>,
      fetchAuthQueue().catch(() => null),
    ]);
    // Filter out all warmup logs - Login Logs only shows login operations
    setLogs((current) => mergeLogs(current, (logRes.data || []).filter((log) => !log.type.startsWith("warmup_"))));
    setQueue(queueRes);
  }

  const refreshQueues = useCallback(async () => {
    const queueRes = await fetchAuthQueue().catch(() => null);
    setQueue(queueRes);
  }, []);

  const scheduleQueueRefresh = useCallback(() => {
    if (queueRefreshTimerRef.current) return;
    queueRefreshTimerRef.current = setTimeout(() => {
      queueRefreshTimerRef.current = null;
      refreshQueues();
    }, 300);
  }, [refreshQueues]);

  useEffect(() => {
    load().catch(() => {});
    return () => {
      if (queueRefreshTimerRef.current) {
        clearTimeout(queueRefreshTimerRef.current);
        queueRefreshTimerRef.current = null;
      }
    };
  }, []);

  useWsEvent(liveTypes, (msg) => {
    // Skip all warmup events - Login Logs only shows login operations
    if (msg.type.startsWith("warmup_")) return;

    if (msg.type === "queue_complete") {
      setQueue((current: any) => ({ ...(current || {}), ...(msg.data || {}), queued: 0, active: 0, processing: false }));
    }
    if (msg.type === "queue_cleared") {
      setQueue((current: any) => ({ ...(current || {}), queued: 0, active: 0, processing: false }));
    }
    const data = msg.data || {};
    const log: AuthLog = {
      id: data.logId || data.id || Date.now(),
      timestamp: data.timestamp || new Date().toISOString(),
      type: msg.type,
      accountId: data.accountId || data.id,
      email: data.email,
      provider: data.provider,
      step: data.step,
      message: data.message || data.error || msg.type,
      error: data.error,
      data,
    };
    setLogs((current) => mergeLogs(current, [log]));
    scheduleQueueRefresh();
  });

  const failed = useMemo(() => logs.filter((log) => log.type === "login_failed"), [logs]);
  const failedAccounts = useMemo(() => {
    const map = new Map<string, AuthLog>();
    for (const log of failed) {
      const key = `${log.accountId || log.email || log.id}-${log.provider || "unknown"}`;
      if (!map.has(key) || new Date(log.timestamp).getTime() > new Date(map.get(key)!.timestamp).getTime()) {
        map.set(key, log);
      }
    }
    return [...map.values()];
  }, [failed]);
  const processes = useMemo(() => {
    return logsToProcesses(logs).filter((process) => {
      // Exclude pending items that haven't started processing yet
      if (process.events.length === 1) {
        const type = process.events[0].type;
        if (type === "queue_added" || type === "warmup_queue_added") return false;
      }
      return true;
    });
  }, [logs]);
  const running = Number(queue?.active || 0);
  const queued = Number(queue?.queued || 0);
  const warmupRunning = Number(warmupQueue?.active || 0);
  const warmupQueued = Number(warmupQueue?.queued || 0);

  // Use backend queue stats for accurate counts (lightweight, no frontend recalculation)
  const totalProgress = running + warmupRunning;
  const totalSuccess = Number(queue?.totalSuccess || 0) + Number(warmupQueue?.totalSuccess || 0);
  const totalFailed = Number(queue?.totalFailed || 0) + Number(warmupQueue?.totalFailed || 0);
  const totalQueued = queued + warmupQueued;

  async function handleClear() {
    await clearAuthLogs();
    setLogs([]);
  }

  async function handleStopAll() {
    await stopAllAccounts();
    await load().catch(() => {});
  }

  async function handleRetry(accountId?: number) {
    if (!accountId) return;
    await loginAccount(accountId);
    await load().catch(() => {});
  }

  async function handleRetryAll() {
    const ids = Array.from(new Set(failedAccounts.map((log) => log.accountId).filter((id): id is number => Boolean(id))));
    if (ids.length === 0) return;
    await loginAccounts(ids);
    await load().catch(() => {});
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Login Logs"
        meta={
          <>
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`h-1 w-1 rounded-full ${connected ? "live-dot bg-[var(--success)]" : "bg-[var(--muted-foreground)]"}`}
              />
              {connected ? "live" : "offline"}
            </span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span>{processes.length} operations</span>
          </>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={load}><RefreshCw className="w-3.5 h-3.5" />Reload</Button>
            <Button variant="ghost" size="sm" onClick={handleClear}><Trash2 className="w-3.5 h-3.5" />Clear</Button>
            <Button variant="destructive" size="sm" onClick={handleStopAll}><StopCircle className="w-3.5 h-3.5" />Stop all</Button>
          </>
        }
      />

      {/* Queue readout: one divided strip, largest number = what's in flight */}
      <Card className="grid grid-cols-2 divide-x divide-y divide-[var(--border)] sm:grid-cols-4 sm:divide-y-0">
        <Stat label="Queued" value={totalQueued} />
        <Stat label="In progress" value={totalProgress} tone={totalProgress > 0 ? "var(--warning)" : undefined} />
        <Stat label="Success" value={totalSuccess} tone={totalSuccess > 0 ? "var(--success)" : undefined} />
        <Stat label="Failed" value={totalFailed} tone={totalFailed > 0 ? "var(--error)" : undefined} />
      </Card>

      {(totalProgress > 0 || totalQueued > 0) && (
        <p className="flex items-center gap-2 border-l-2 border-[var(--warning)] bg-[var(--warning)]/6 px-3 py-2 font-mono text-meta text-[var(--warning-text)]">
          <Radio className="w-3.5 h-3.5 shrink-0" />
          {totalProgress} processing · {totalQueued} queued · streaming
        </p>
      )}

      {failedAccounts.length > 0 && (
        <Card className="overflow-hidden border-[var(--error)]/30">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--error)]/25 bg-[var(--error)]/6 px-3 py-2">
            <span className="eyebrow flex items-center gap-1.5 text-[var(--error-text)]">
              <AlertTriangle className="w-3.5 h-3.5" /> Failed · {failedAccounts.length}
            </span>
            <Button variant="outline" size="sm" onClick={handleRetryAll}>
              <RotateCcw className="h-3 w-3" /> Retry all
            </Button>
          </div>
          <div>
            {failedAccounts.map((log) => (
              <div
                key={`failed-${log.accountId || log.id}-${log.provider || "unknown"}`}
                className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 border-t border-[var(--hairline)] px-4 py-2 font-mono text-body first:border-t-0 md:grid-cols-[220px_120px_1fr_auto]"
              >
                <div className="truncate text-[var(--foreground)]">{log.email || `#${log.accountId}`}</div>
                <div className="text-[var(--muted-foreground)]">{providerLabel(log.provider)}</div>
                <div className="col-span-2 truncate text-[var(--error-text)] md:col-span-1" title={log.error || log.message}>
                  {log.error || log.message}
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleRetry(log.accountId)} disabled={!log.accountId}>
                  <RotateCcw className="h-3 w-3" /> Retry
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Primary surface: the operation log */}
      <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
        <div className="max-h-[calc(100vh-22rem)] overflow-auto">
          <table className="w-full border-collapse font-mono text-body">
            <thead className="sticky-head">
              <tr>
                <th className="eyebrow px-4 py-2 text-left">Time</th>
                <th className="eyebrow px-4 py-2 text-left">Status</th>
                <th className="eyebrow px-4 py-2 text-left hidden md:table-cell">Account</th>
                <th className="eyebrow px-4 py-2 text-left hidden md:table-cell">Provider</th>
                <th className="eyebrow px-4 py-2 text-left hidden lg:table-cell">Step</th>
                <th className="eyebrow px-4 py-2 text-left">Message</th>
              </tr>
            </thead>
            <tbody>
              {processes.slice((page - 1) * perPage, page * perPage).map((process) => (
                <Fragment key={process.key}>
                  <tr
                    className="cursor-pointer border-t border-[var(--hairline)] transition-colors duration-150 ease-out hover:bg-[var(--secondary)]/50"
                    onClick={() => setExpanded((current) => current === process.key ? null : process.key)}
                  >
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-[var(--muted-foreground)]">{formatTimeID(process.updatedAt)}</td>
                    <td className="px-4 py-2"><Badge variant={processStatusVariant(process)}>{processStatusLabel(process)}</Badge></td>
                    <td className="max-w-[200px] truncate px-4 py-2 text-[var(--foreground)] hidden md:table-cell">{process.latest.email || (process.latest.accountId ? `#${process.latest.accountId}` : "—")}</td>
                    <td className="px-4 py-2 text-[var(--muted-foreground)] hidden md:table-cell">{providerLabel(process.latest.provider)}</td>
                    <td className="px-4 py-2 text-[var(--muted-foreground)] hidden lg:table-cell">{process.latest.step || process.operation}</td>
                    <td className="px-4 py-2 text-[var(--muted-foreground)]">
                      <div className="flex items-center gap-2">
                        {processStatusLabel(process) === "success" && <CheckCircle className="w-3.5 h-3.5 shrink-0 text-[var(--success-text)]" />}
                        {processStatusLabel(process) === "error" && <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-[var(--error-text)]" />}
                        {processStatusLabel(process) !== "success" && processStatusLabel(process) !== "error" && (process.latest.type === "login_progress" || process.latest.type === "queue_processing" || process.latest.type === "warmup_processing") && <span className="live-dot h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warning)]" />}
                        <span className="min-w-0 flex-1 truncate">{process.latest.error || process.latest.message || "—"}</span>
                        <span className="shrink-0 tabular-nums text-[var(--muted-foreground)]">{process.events.length} steps</span>
                        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ease-out ${expanded === process.key ? "rotate-180" : ""}`} />
                      </div>
                    </td>
                  </tr>
                  {expanded === process.key && (
                    <tr className="border-t border-[var(--hairline)] bg-[var(--sunken)]">
                      <td colSpan={6} className="px-3 py-2">
                        <div className="border-l border-[var(--border)] pl-2.5">
                          {process.events.map((log) => (
                            <div
                              key={`${log.id}-${log.timestamp}`}
                              className="grid grid-cols-[68px_112px_1fr] gap-3 py-0.5 text-meta"
                            >
                              <span className="tabular-nums text-[var(--muted-foreground)]">{formatTimeID(log.timestamp)}</span>
                              <span className="truncate text-[var(--muted-foreground)]">{log.step || statusLabel(log.type)}</span>
                              <span className={log.error ? "text-[var(--error-text)]" : "text-[var(--foreground)]"}>{log.error || log.message || "—"}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {processes.length === 0 && (
                <tr>
                  <td colSpan={6} className="border-t border-[var(--hairline)] px-4 py-3 text-[var(--muted-foreground)]">
                    No login activity yet — start a login from Accounts and progress streams here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {processes.length > perPage && (
          <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2">
            <p className="font-mono text-meta tabular-nums text-[var(--muted-foreground)]">
              {(page - 1) * perPage + 1}–{Math.min(page * perPage, processes.length)} of {processes.length}
            </p>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button>
              <span className="font-mono text-meta tabular-nums text-[var(--muted-foreground)]">{page}/{Math.ceil(processes.length / perPage)}</span>
              <Button variant="ghost" size="sm" disabled={page >= Math.ceil(processes.length / perPage)} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="px-3 py-3">
      <div className="eyebrow">{label}</div>
      <div
        className="mt-1.5 font-mono text-stat-sm font-semibold tabular-nums"
        style={{ color: tone || "var(--foreground)" }}
      >
        {value}
      </div>
    </div>
  );
}
