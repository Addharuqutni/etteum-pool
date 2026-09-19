import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import PageHeader from "@/components/layout/PageHeader";
import { ArrowLeft, Search, Trash2, RefreshCw, RotateCcw, ArrowUpDown, ArrowUp, ArrowDown, CheckCircle2, XCircle } from "lucide-react";
import { formatDateTimeID } from "@/lib/utils";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useWsEvent } from "@/hooks/useWebSocket";
import {
  bulkDeleteAccounts,
  deleteAccount,
  fetchAccounts,
  loginAccount,
  loginAccounts,
  toggleAccountEnabled,
  toggleAllAccounts,
  warmupAccount,
  warmupAllAccounts,
} from "@/lib/api";

type Provider = "codebuddy" | "codebuddy-china" | "canva" | "codex" | "grok-cli" | "claude";
type Status = "active" | "exhausted" | "error" | "pending" | "disabled";

interface CodexQuotaWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_at: string | null;
  reset_after_seconds: number;
}

interface CodexQuotaMetadata {
  plan_type?: string;
  primary?: CodexQuotaWindow;
  secondary?: CodexQuotaWindow;
  rate_limited?: boolean;
}

interface Account {
  id: number;
  email: string;
  provider: Provider;
  status: Status;
  enabled?: boolean;
  quotaLimit?: number;
  quotaRemaining?: number;
  freeLimit?: number;
  freeRemaining?: number;
  freeResetAt?: string | null;
  lastUsedAt?: string | null;
  lastLoginAt?: string | null;
  errorMessage?: string | null;
  metadata?: {
    codex_quota?: CodexQuotaMetadata;
    overage?: { enabled: boolean; capable: boolean; used: number; cap: number; remaining: number } | null;
    inferenceProbe?: string;
  } | null;
}

const statusVariants: Record<string, "success" | "warning" | "error" | "secondary"> = {
  active: "success",
  exhausted: "warning",
  error: "error",
  pending: "secondary",
  disabled: "secondary",
};

function labelProvider(provider: string) {
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "codebuddy-china") return "CodeBuddy CN";
  if (provider === "grok-cli") return "Grok CLI";
  if (provider === "claude") return "Claude";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function formatCredit(value?: number | null) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toFixed(1) : "0.0";
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return formatDateTimeID(value);
}

function formatWindow(seconds: number) {
  if (!seconds || seconds <= 0) return "?";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

function formatResetIn(seconds: number) {
  if (!seconds || seconds <= 0) return "now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function CodexQuotaCell({ codex, fallbackRemaining, fallbackLimit }: { codex?: CodexQuotaMetadata; fallbackRemaining?: number; fallbackLimit?: number }) {
  if (!codex || (!codex.primary && !codex.secondary)) {
    return <span className="text-xs text-[var(--muted-foreground)]">{formatCredit(fallbackRemaining)}/{formatCredit(fallbackLimit)}</span>;
  }
  const renderBar = (label: string, w?: CodexQuotaWindow) => {
    if (!w) return null;
    const used = Math.max(0, Math.min(100, w.used_percent || 0));
    const remaining = 100 - used;
    const tone = remaining <= 10 ? "bg-[var(--error)]" : remaining <= 40 ? "bg-[var(--warning)]" : "bg-[var(--success)]";
    return (
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-micro text-[var(--muted-foreground)]">
          <span className="font-medium">{label} ({formatWindow(w.limit_window_seconds)})</span>
          <span>{remaining.toFixed(1)}% left · reset {formatResetIn(w.reset_after_seconds)}</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-[var(--secondary)] overflow-hidden">
          <div className={`h-full ${tone}`} style={{ width: `${remaining}%` }} />
        </div>
      </div>
    );
  };
  return (
    <div className="space-y-1.5 min-w-[200px]">
      {codex.plan_type && <div className="text-micro uppercase tracking-wide text-[var(--muted-foreground)]">Plan: {codex.plan_type}{codex.rate_limited && <span className="ml-2 text-[var(--error-text)]">RATE LIMITED</span>}</div>}
      {renderBar("Session", codex.primary)}
      {renderBar("Weekly", codex.secondary)}
    </div>
  );
}

type SortKey = "email" | "status" | "enabled" | "credit" | "lastLogin";
type SortDir = "asc" | "desc";

export default function AccountList() {
  const { provider } = useParams<{ provider: string }>();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const perPage = 25;
  const { message, setMessage: setTimedMessage, clearMessage } = useTimedMessage<string>(null, 4000);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("email");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function SortIcon({ column }: { column: SortKey }) {
    if (sortKey !== column) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-40" />;
    return sortDir === "asc"
      ? <ArrowUp className="w-3 h-3 ml-1" />
      : <ArrowDown className="w-3 h-3 ml-1" />;
  }

  async function load() {
    setLoading(true);
    try {
      const res = await fetchAccounts() as { data: Account[] };
      setAccounts((res.data || []).filter((a) => a.provider === provider));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [provider]);

  function showSuccess(text: string) { setTimedMessage(text); setError(null); }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); clearMessage(); }

  async function handleWarmup(id: number) {
    try { await warmupAccount(id); showSuccess(`WarmUp queued #${id}`); await load(); } catch (err) { showError(err); }
  }

  async function handleWarmupAll() {
    try {
      const res = await warmupAllAccounts({ providers: [provider!], statuses: ["active", "exhausted", "error"] }) as any;
      showSuccess(res.message || "WarmUp All queued.");
      await load();
    } catch (err) { showError(err); }
  }

  async function handleLogin(id: number) {
    try { await loginAccount(id); showSuccess(`Login queued #${id}`); await load(); } catch (err) { showError(err); }
  }

  async function handleRetryErrors() {
    const ids = accounts.filter((a) => a.status === "error").map((a) => a.id);
    if (ids.length === 0) return;
    await loginAccounts(ids);
    showSuccess(`Queued ${ids.length} error accounts for retry.`);
    await load();
  }

  async function handleDelete(id: number) {
    if (!confirm(`Delete account #${id}?`)) return;
    try {
      await deleteAccount(id);
      showSuccess(`Deleted #${id}`);
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await load();
    } catch (err) { showError(err); }
  }

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected ${labelProvider(provider || "")} account(s)? This cannot be undone.`)) return;
    setBulkDeleting(true);
    try {
      const res = await bulkDeleteAccounts(ids);
      showSuccess(`Deleted ${res.deleted} account(s)${res.notFound.length ? ` · ${res.notFound.length} not found` : ""}`);
      setSelectedIds(new Set());
      await load();
    } catch (err) {
      showError(err);
    } finally {
      setBulkDeleting(false);
    }
  }

  async function handleToggle(id: number, currentEnabled: boolean) {
    const next = !currentEnabled;
    setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, enabled: next } : a)));
    try {
      await toggleAccountEnabled(id, next);
      showSuccess(next ? `Aktifkan #${id}` : `Non-aktifkan #${id}`);
    } catch (err) {
      setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, enabled: currentEnabled } : a)));
      showError(err);
    }
  }

  async function handleToggleAll(enabled: boolean) {
    if (!provider) return;
    const prev = accounts.map((a) => ({ id: a.id, enabled: a.enabled !== false }));
    setAccounts((prev) => prev.map((a) => ({ ...a, enabled })));
    try {
      const res = await toggleAllAccounts(provider, enabled);
      showSuccess(enabled ? `Aktifkan ${res.count} akun ${labelProvider(provider)}` : `Non-aktifkan ${res.count} akun ${labelProvider(provider)}`);
    } catch (err) {
      setAccounts((list) => list.map((a) => {
        const orig = prev.find((p) => p.id === a.id);
        return orig ? { ...a, enabled: orig.enabled } : a;
      }));
      showError(err);
    }
  }

  const filtered = useMemo(() => {
    let result = accounts.filter((a) => a.email.toLowerCase().includes(search.toLowerCase()));
    if (statusFilter !== "all") {
      result = result.filter((a) => a.status === statusFilter);
    }
    result.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "email":
          cmp = a.email.localeCompare(b.email);
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "enabled":
          cmp = (a.enabled === false ? 0 : 1) - (b.enabled === false ? 0 : 1);
          break;
        case "credit":
          cmp = (a.quotaRemaining ?? 0) - (b.quotaRemaining ?? 0);
          break;
        case "lastLogin": {
          const da = new Date(a.lastLoginAt || a.lastUsedAt || 0).getTime();
          const db = new Date(b.lastLoginAt || b.lastUsedAt || 0).getTime();
          cmp = da - db;
          break;
        }
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return result;
  }, [accounts, search, statusFilter, sortKey, sortDir]);

  useEffect(() => { setPage(1); }, [search, provider, statusFilter]);

  // Drop selections for rows that no longer exist (after reload/delete).
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(accounts.map((a) => a.id));
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [accounts]);

  // Clear selection entirely when switching provider.
  useEffect(() => { setSelectedIds(new Set()); }, [provider]);

  const filteredIds = useMemo(() => filtered.map((a) => a.id), [filtered]);
  const selectedVisibleCount = useMemo(
    () => filteredIds.reduce((n, id) => (selectedIds.has(id) ? n + 1 : n), 0),
    [filteredIds, selectedIds],
  );
  const allVisibleSelected = filteredIds.length > 0 && selectedVisibleCount === filteredIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  function toggleSelectAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of filteredIds) next.delete(id);
      } else {
        for (const id of filteredIds) next.add(id);
      }
      return next;
    });
  }

  const errorCount = accounts.filter((a) => a.status === "error").length;
  const enabledCount = accounts.filter((a) => a.enabled !== false).length;
  const disabledCount = accounts.filter((a) => a.enabled === false).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title={labelProvider(provider || "")}
        meta={
          <>
            <span>{accounts.length} accounts</span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span className={enabledCount > 0 ? "text-[var(--success-text)]" : undefined}>{enabledCount} enabled</span>
            {errorCount > 0 && (
              <>
                <span aria-hidden className="text-[var(--border)]">·</span>
                <span className="text-[var(--error-text)]">{errorCount} error</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <Button variant="ghost" size="icon" onClick={() => navigate("/accounts")} aria-label="Back to providers">
              <ArrowLeft className="w-3.5 h-3.5" />
            </Button>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleWarmupAll}>
              <RefreshCw className="w-3.5 h-3.5" /> Warmup all
            </Button>
            <Button variant="outline" size="sm" onClick={handleRetryErrors} disabled={errorCount === 0}>
              <RotateCcw className="w-3.5 h-3.5" /> Retry errors ({errorCount})
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleToggleAll(true)} disabled={disabledCount === 0}>
              <CheckCircle2 className="w-3.5 h-3.5 text-[var(--success-text)]" /> Enable ({disabledCount})
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleToggleAll(false)} disabled={enabledCount === 0}>
              <XCircle className="w-3.5 h-3.5 text-[var(--error-text)]" /> Disable ({enabledCount})
            </Button>
          </>
        }
      />

      {(message || error) && (
        <p className={`border-l-2 px-3 py-2 font-mono text-meta ${message ? "border-[var(--success)] bg-[var(--success)]/8 text-[var(--success-text)]" : "border-[var(--error)] bg-[var(--error)]/8 text-[var(--error-text)]"}`}>
          {message || error}
        </p>
      )}

      {/* Search & Filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
          <Input placeholder="Search accounts..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {(["all", "active", "exhausted", "error", "pending", "disabled"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                statusFilter === s
                  ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                  : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
              }`}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-[var(--primary)]/40 bg-[var(--primary)]/[0.06] p-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-body text-[var(--foreground)]">
            {selectedIds.size} selected
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set())} disabled={bulkDeleting}>
              Clear
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-[var(--error)]/40 text-[var(--error-text)] hover:bg-[var(--error)]/10 hover:text-[var(--error-text)]"
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
            >
              <Trash2 className="w-4 h-4 mr-2" /> {bulkDeleting ? "Deleting..." : `Delete (${selectedIds.size})`}
            </Button>
          </div>
        </div>
      )}

      {/* Primary surface: the account table */}
      <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-body">
            <thead className="sticky-head">
              <tr>
                <th className="w-10 px-4 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all visible accounts"
                    className="h-4 w-4 rounded border-[var(--border)] cursor-pointer accent-[var(--primary)]"
                    checked={allVisibleSelected}
                    ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                    onChange={toggleSelectAllVisible}
                  />
                </th>
                <th className="eyebrow px-4 py-2 text-left cursor-pointer select-none hover:text-[var(--foreground)]" onClick={() => handleSort("email")}>
                  <span className="inline-flex items-center">Email<SortIcon column="email" /></span>
                </th>
                <th className="eyebrow px-4 py-2 text-left cursor-pointer select-none hover:text-[var(--foreground)]" onClick={() => handleSort("status")}>
                  <span className="inline-flex items-center">Status<SortIcon column="status" /></span>
                </th>
                <th className="eyebrow px-4 py-2 text-left cursor-pointer select-none hover:text-[var(--foreground)]" onClick={() => handleSort("enabled")}>
                  <span className="inline-flex items-center">Enabled<SortIcon column="enabled" /></span>
                </th>
                <th className="eyebrow px-4 py-2 text-left cursor-pointer select-none hover:text-[var(--foreground)] hidden sm:table-cell" onClick={() => handleSort("credit")}>
                  <span className="inline-flex items-center">Credit<SortIcon column="credit" /></span>
                </th>
                <th className="eyebrow px-4 py-2 text-left cursor-pointer select-none hover:text-[var(--foreground)] hidden md:table-cell" onClick={() => handleSort("lastLogin")}>
                  <span className="inline-flex items-center">Last Login<SortIcon column="lastLogin" /></span>
                </th>
                <th className="eyebrow px-4 py-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice((page - 1) * perPage, page * perPage).map((account) => {
                const isEnabled = account.enabled !== false;
                return (
                <tr key={account.id} className={`border-t border-[var(--hairline)] hover:bg-[var(--secondary)]/50 transition-colors duration-150 ${selectedIds.has(account.id) ? "bg-[var(--primary)]/[0.04]" : ""} ${isEnabled ? "" : "opacity-50"}`}>
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${account.email}`}
                      className="h-4 w-4 rounded border-[var(--border)] cursor-pointer accent-[var(--primary)]"
                      checked={selectedIds.has(account.id)}
                      onChange={() => toggleSelect(account.id)}
                    />
                  </td>
                  <td className="px-4 py-2 text-[var(--foreground)]">
                    <div>{account.email}</div>
                    {account.errorMessage && <div className="mt-1 line-clamp-1 text-meta text-[var(--error-text)]" title={account.errorMessage}>{account.errorMessage}</div>}
                  </td>
                  <td className="px-4 py-2"><Badge variant={statusVariants[account.status]}>{account.status}</Badge></td>
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isEnabled}
                      onClick={() => handleToggle(account.id, isEnabled)}
                      title={isEnabled ? "Klik untuk non-aktifkan" : "Klik untuk aktifkan"}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-1 focus:ring-offset-[var(--background)] ${isEnabled ? "bg-[var(--success)]" : "bg-[var(--secondary)]"}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isEnabled ? "translate-x-4" : "translate-x-0.5"}`} />
                    </button>
                  </td>
                  <td className="hidden px-4 py-2 tabular-nums text-[var(--muted-foreground)] sm:table-cell">
                    {account.provider === "codex"
                      ? <CodexQuotaCell codex={account.metadata?.codex_quota} fallbackRemaining={account.quotaRemaining} fallbackLimit={account.quotaLimit} />
                      : <span className="flex items-center gap-1.5">
                          {formatCredit(account.quotaRemaining)}/{formatCredit(account.quotaLimit)}
                          {account.metadata?.overage?.enabled && account.metadata.overage.remaining > 0 && (
                            <Badge variant="success" className="text-micro px-1 py-0">
                              PAYG: {Math.round(account.metadata.overage.used)}
                            </Badge>
                          )}
                        </span>}
                  </td>
                  <td className="hidden px-4 py-2 text-meta tabular-nums text-[var(--muted-foreground)] md:table-cell">{formatDate(account.lastLoginAt || account.lastUsedAt)}</td>
                  <td className="px-4 py-2">
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => handleWarmup(account.id)} title="WarmUp">
                        <RefreshCw className="w-3.5 h-3.5 text-[var(--warning-text)]" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleLogin(account.id)} title="Queue login" disabled={account.status !== "pending" && account.status !== "error"}>
                        <RotateCcw className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(account.id)} title="Delete" className="hover:text-[var(--destructive-text)]">
                        <Trash2 className="w-3.5 h-3.5 text-[var(--error-text)]" />
                      </Button>
                    </div>
                  </td>
                </tr>
                );
              })}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12">
                    <div className="flex flex-col items-center justify-center gap-1.5 text-center text-[var(--muted-foreground)]">
                      <Search className="h-6 w-6 opacity-40" />
                      <p className="font-mono text-body">No accounts found</p>
                      <p className="font-mono text-meta">Try adjusting your search or status filter.</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > perPage && (
          <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3">
            <p className="font-mono text-meta tabular-nums text-[var(--muted-foreground)]">
              {(page - 1) * perPage + 1}–{Math.min(page * perPage, filtered.length)} of {filtered.length}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button>
              <span className="font-mono text-meta tabular-nums text-[var(--muted-foreground)]">{page}/{Math.ceil(filtered.length / perPage)}</span>
              <Button variant="outline" size="sm" disabled={page >= Math.ceil(filtered.length / perPage)} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
