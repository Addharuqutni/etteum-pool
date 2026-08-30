import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Search, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/layout/PageHeader";
import { fetchRequests, fetchRequestDetail } from "@/lib/api";
import { formatDateTimeID } from "@/lib/utils";
import { useWsEvent } from "@/hooks/useWebSocket";

interface RequestLog {
  id: number;
  createdAt: string;
  provider: string;
  model: string | null;
  status: "success" | "error";
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  creditsUsed?: number | null;
  accountId: number | null;
  accountEmail?: string | null;
  accountQuotaBefore?: number | null;
  accountQuotaAfter?: number | null;
  errorMessage: string | null;
  requestBody?: unknown;
  responseBody?: unknown;
  compressionStats?: CompressionStats | null;
}

interface PonytailMarkerHit {
  ceiling: string;
  upgradePath: string;
  location: string;
}

interface PonytailStats {
  /** Tokens ADDED by ruleset injection (negative savings, displayed as overhead). */
  inputOverhead: number;
  /** Number of ponytail: markers found in output. */
  outputMarkers: number;
  /** Marker details. */
  markerHits: PonytailMarkerHit[];
}

interface CompressionStats {
  tokensBefore: number;
  tokensAfter: number;
  saved: number;
  savedPct: number;
  byTechnique?: {
    tsc?: number;
    rtk?: number;
    dcp?: number;
    caveman?: number;
    imageDedupe?: number;
    cacheMarkers?: number;
    ponytail?: number;
  };
  /** Per-shape-filter savings inside RTK (only present when RTK fired). */
  rtkFilters?: Record<string, number>;
  /** Ponytail-specific stats (only present when Ponytail is enabled). */
  ponytail?: PonytailStats;
  durationMs: number;
}

function getCreditMeta(req: RequestLog) {
  const body = req.requestBody as { _poolprox?: { creditSource?: string; creditUnit?: string; creditRate?: number } } | null | undefined;
  return body?._poolprox || {};
}

function getStatusColor(status: string): "success" | "warning" | "error" {
  if (status === "success") return "success";
  if (status.includes("429")) return "warning";
  return "error";
}

function labelProvider(provider: string) {
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "codebuddy-china") return "CodeBuddy CN";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export default function Requests() {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<RequestLog | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage] = useState(1);
  const perPage = 25;

  /**
   * Open the detail drawer for a row. The list endpoint omits the heavy
   * requestBody / responseBody columns to keep the page snappy, so we lazily
   * fetch the full record here. We immediately show what we already have so
   * the drawer feels instant, then fill in the bodies once they arrive.
   */
  async function openDetail(req: RequestLog) {
    setSelected(req);
    if (req.requestBody !== undefined && req.responseBody !== undefined) return;
    setDetailLoading(true);
    try {
      const res = (await fetchRequestDetail(req.id)) as { data: RequestLog };
      if (res?.data) {
        setSelected((current) => (current?.id === req.id ? { ...current, ...res.data } : current));
      }
    } catch {
      // best-effort; leave bodies undefined and let the UI render empty blocks
    } finally {
      setDetailLoading(false);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const res = await fetchRequests(1, 100, provider) as { data: RequestLog[] };
      setLogs(res.data || []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    setPage(1);
  }, [provider]);

  useEffect(() => {
    setPage(1);
  }, [search]);

  useWsEvent(["request_log"], (msg) => {
    if (msg.type === "request_log") {
      setLogs((current) => [msg.data as RequestLog, ...current].slice(0, 100));
    }
  });

  const filtered = logs.filter((req) => {
    const q = search.toLowerCase();
    return (
      req.model?.toLowerCase().includes(q) ||
      req.provider.toLowerCase().includes(q) ||
      req.errorMessage?.toLowerCase().includes(q) ||
      String(req.accountId || "").includes(q)
    );
  });

  const errCount = filtered.filter((req) => req.status !== "success").length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Requests"
        meta={`${filtered.length} of ${logs.length} loaded${errCount > 0 ? ` · ${errCount} error` : ""}`}
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted-foreground)]" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="model, account, error…"
                className="w-full pl-8 font-mono sm:w-64"
                aria-label="Filter requests"
              />
            </div>
            <Select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-auto font-mono text-[12px]"
              aria-label="Filter by provider"
            >
              <option value="all">all providers</option>
              <option value="codebuddy">codebuddy</option>
              <option value="canva">canva</option>
            </Select>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Reload
            </Button>
          </>
        }
      />

      {/* The log table is the whole point of this view, so it's the one
          elevated surface. Sticky header, mono body, numerals right-aligned. */}
      <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
        <div className="max-h-[calc(100vh-13rem)] overflow-auto">
          <table className="w-full border-collapse font-mono text-[12px]">
            <thead className="sticky-head">
              <tr>
                <th className="eyebrow px-4 py-2 text-left">Time</th>
                <th className="eyebrow px-4 py-2 text-left">Provider</th>
                <th className="eyebrow px-4 py-2 text-left hidden md:table-cell">Model</th>
                <th className="eyebrow px-4 py-2 text-left">Status</th>
                <th className="eyebrow px-4 py-2 text-right hidden md:table-cell">Dur</th>
                <th className="eyebrow px-4 py-2 text-right hidden lg:table-cell">Tokens</th>
                <th className="eyebrow px-4 py-2 text-right hidden lg:table-cell">Credits</th>
                <th className="eyebrow px-4 py-2 text-left hidden lg:table-cell">Account</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice((page - 1) * perPage, page * perPage).map((req) => (
                <tr
                  key={req.id}
                  onClick={() => openDetail(req)}
                  className="cursor-pointer border-t border-[var(--hairline)] transition-colors duration-150 ease-out hover:bg-[var(--secondary)]/50"
                >
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-[var(--muted-foreground)]">{formatDateTimeID(req.createdAt)}</td>
                  <td className="px-4 py-2 text-[var(--foreground)]">{labelProvider(req.provider)}</td>
                  <td className="max-w-[220px] truncate px-4 py-2 text-[var(--foreground)] hidden md:table-cell">{req.model || "—"}</td>
                  <td className="px-4 py-2"><Badge variant={getStatusColor(req.status)}>{req.status}</Badge></td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--muted-foreground)] hidden md:table-cell">{((req.durationMs ?? 0) / 1000).toFixed(1)}s</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--foreground)] hidden lg:table-cell">{(req.totalTokens || 0).toLocaleString()}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--muted-foreground)] hidden lg:table-cell">{Number(req.creditsUsed || 0).toFixed(2)}</td>
                  <td className="max-w-[200px] truncate px-4 py-2 text-[var(--muted-foreground)] hidden lg:table-cell">{req.accountEmail || (req.accountId ? `#${req.accountId}` : "—")}</td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="border-t border-[var(--hairline)] px-4 py-3 text-[var(--muted-foreground)]">
                    {logs.length === 0 ? "No requests logged yet — traffic appears here as it is proxied." : "No rows match this filter."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > perPage && (
          <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2">
            <p className="font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
              {(page - 1) * perPage + 1}–{Math.min(page * perPage, filtered.length)} of {filtered.length}
            </p>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button>
              <span className="font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">{page}/{Math.ceil(filtered.length / perPage)}</span>
              <Button variant="ghost" size="sm" disabled={page >= Math.ceil(filtered.length / perPage)} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        )}
      </Card>

      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/55" onClick={() => setSelected(null)}>
          <aside
            className="h-full w-full max-w-[520px] overflow-y-auto border-l border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-raised)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[var(--border)] bg-[var(--card)] px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate font-mono text-[13px] font-semibold text-[var(--foreground)]">
                  {selected.model || "Request"}
                </h2>
                <p className="mt-1 font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
                  #{selected.id} · {formatDateTimeID(selected.createdAt)}
                </p>
              </div>
              <button
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                onClick={() => setSelected(null)}
                aria-label="Close detail"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-[var(--muted-foreground)]">
                <Badge variant={getStatusColor(selected.status)}>{selected.status}</Badge>
                <span>HTTP {selected.status === "success" ? 200 : 503}</span>
                <span aria-hidden className="text-[var(--border)]">·</span>
                <span className="tabular-nums">{((selected.durationMs || 0) / 1000).toFixed(1)}s</span>
                <span aria-hidden className="text-[var(--border)]">·</span>
                <span>{labelProvider(selected.provider)}</span>
              </div>

              <div className="mt-3 grid grid-cols-2 divide-x divide-y divide-[var(--hairline)] border border-[var(--border)] sm:grid-cols-4 sm:divide-y-0">
                <Metric label="Total" value={(selected.totalTokens || 0).toLocaleString()} />
                <Metric label="Prompt" value={(selected.promptTokens || 0).toLocaleString()} />
                <Metric label="Completion" value={(selected.completionTokens || 0).toLocaleString()} />
                <Metric label="Credit" value={(selected.creditsUsed || 0).toFixed(2)} tone="var(--warning)" />
              </div>

              <dl className="mt-3 space-y-1 border-l-2 border-[var(--border)] pl-2.5 font-mono text-[11px] text-[var(--muted-foreground)]">
                <div>
                  Credit source <span className="text-[var(--foreground)]">{getCreditMeta(selected).creditSource || "unknown"}</span>
                  {getCreditMeta(selected).creditUnit && <> · unit <span className="text-[var(--foreground)]">{getCreditMeta(selected).creditUnit}</span></>}
                  {typeof getCreditMeta(selected).creditRate === "number" && <> · rate <span className="text-[var(--foreground)]">{getCreditMeta(selected).creditRate}</span></>}
                </div>
              </dl>

              {selected.compressionStats && (
                <CompressionPanel
                  stats={selected.compressionStats}
                  promptTokens={selected.promptTokens}
                />
              )}

              <div className="mt-4">
                <p className="eyebrow">Account</p>
                <p className="mt-1 font-mono text-[12px] text-[var(--foreground)]">{selected.accountEmail || `#${selected.accountId}`}</p>
                <p className="mt-0.5 font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
                  credit {selected.accountQuotaBefore ?? 0} → {selected.accountQuotaAfter ?? 0}
                </p>
              </div>

              {selected.errorMessage && (
                <p className="mt-4 border-l-2 border-[var(--error)] bg-[var(--error)]/8 px-3 py-2 font-mono text-[11px] text-[var(--error)]">
                  {selected.errorMessage}
                </p>
              )}

              {detailLoading && selected.requestBody === undefined ? (
                <div className="mt-4 flex items-center gap-2 font-mono text-[11px] text-[var(--muted-foreground)]">
                  <RefreshCw className="w-3 h-3 animate-spin" /> loading bodies…
                </div>
              ) : (
                <>
                  <JsonBlock title="Request body" value={selected.requestBody} />
                  <JsonBlock title="Response body" value={selected.responseBody} />
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="px-2.5 py-2">
      <p className="eyebrow">{label}</p>
      <p
        className="mt-1 font-mono text-[13px] font-semibold tabular-nums"
        style={{ color: tone || "var(--foreground)" }}
      >
        {value}
      </p>
    </div>
  );
}

const TECHNIQUE_LABELS: Record<keyof NonNullable<CompressionStats["byTechnique"]>, string> = {
  tsc: "TSC (tool schema)",
  rtk: "RTK (tool truncation)",
  dcp: "DCP (dedup)",
  caveman: "Caveman (system prompt)",
  imageDedupe: "Image dedup",
  cacheMarkers: "Cache markers",
  ponytail: "Ponytail (lazy-dev ruleset)",
};

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

const RTK_FILTER_LABELS: Record<string, string> = {
  "git-diff": "git diff (hunks)",
  "git-status": "git status",
  tree: "tree (depth ≤ 1)",
  "read-numbered": "Read (line-numbered)",
  grep: "grep (per-file)",
  "dedup-log": "dedup-log",
  generic: "generic head + tail",
};

function CompressionPanel({
  stats,
  promptTokens,
}: {
  stats: CompressionStats;
  promptTokens: number | null;
}) {
  const { tokensBefore, tokensAfter, saved, byTechnique = {}, rtkFilters, durationMs, ponytail } = stats;
  const techEntries = Object.entries(byTechnique).filter(
    ([k, v]) => typeof v === "number" && v > 0 && k !== "ponytail"
  ) as Array<[keyof typeof TECHNIQUE_LABELS, number]>;
  const ponytailOverhead = typeof byTechnique.ponytail === "number" ? byTechnique.ponytail : 0;
  const filterEntries: Array<[string, number]> = rtkFilters
    ? Object.entries(rtkFilters).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    : [];

  // Best practice: anchor the displayed before/after to provider-reported
  // prompt_tokens (ground truth) instead of our char/4 heuristic. Our internal
  // estimate is only used to allocate per-technique attribution; for the
  // headline numbers we trust the upstream usage.prompt_tokens.
  //
  // Formula:
  //   actualBefore = promptTokens + saved   (what would have been billed without compression)
  //   actualAfter  = promptTokens           (what was actually billed)
  //   actualPct    = saved / actualBefore   (real savings ratio)
  //
  // If promptTokens is missing/0 (e.g. error response), fall back to our estimate.
  const hasProviderTruth = typeof promptTokens === "number" && promptTokens > 0;
  const displayAfter = hasProviderTruth ? promptTokens : tokensAfter;
  const displayBefore = hasProviderTruth ? promptTokens + saved : tokensBefore;
  const displayPct = displayBefore > 0 ? (saved / displayBefore) * 100 : 0;

  // No real savings on this request — show a muted "ran but no-op" line.
  if (saved <= 0) {
    return (
      <p className="mt-3 border-l-2 border-[var(--border)] pl-2.5 font-mono text-[11px] text-[var(--muted-foreground)]">
        Compression ran in {durationMs}ms — nothing compressible this turn.
      </p>
    );
  }

  return (
    <div className="mt-3 border-l-2 border-[var(--success)] bg-[var(--success)]/5 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="eyebrow text-[var(--success)]">Compression</p>
        <p className="font-mono text-[10px] tabular-nums text-[var(--muted-foreground)]">{durationMs}ms</p>
      </div>

      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="font-mono text-xl font-semibold tabular-nums text-[var(--success)]">−{formatNum(saved)}</span>
        <span className="font-mono text-[11px] text-[var(--muted-foreground)]">tokens</span>
        <span className="ml-auto font-mono text-[13px] font-semibold tabular-nums text-[var(--success)]">{displayPct.toFixed(2)}%</span>
      </div>

      <div
        className="mt-1 font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]"
        title={
          hasProviderTruth
            ? `Anchored to provider-reported prompt_tokens (${formatNum(promptTokens!)}). Internal estimate was ${formatNum(tokensBefore)} → ${formatNum(tokensAfter)}.`
            : "Internal char/4 estimate (provider usage not available)"
        }
      >
        {formatNum(displayBefore)} <span className="opacity-50">→</span> {formatNum(displayAfter)}
        {hasProviderTruth && <span className="ml-1 opacity-50">· actual</span>}
      </div>

      {techEntries.length > 0 && (
        <div className="mt-2.5 border-t border-[var(--hairline)] pt-2">
          <p className="eyebrow">By technique</p>
          {techEntries.map(([key, value]) => {
            const pct = saved > 0 ? (value / saved) * 100 : 0;
            return (
              <div key={key} className="mt-1 flex items-center gap-2 font-mono text-[11px]">
                <span className="flex-1 truncate text-[var(--foreground)]">{TECHNIQUE_LABELS[key]}</span>
                <div className="h-px w-16 bg-[var(--border)]">
                  <div className="h-full bg-[var(--success)]" style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
                <span className="w-14 text-right tabular-nums text-[var(--muted-foreground)]">−{formatNum(value)}</span>
              </div>
            );
          })}
        </div>
      )}

      {filterEntries.length > 0 && (
        <details className="mt-2 group">
          <summary className="eyebrow cursor-pointer hover:text-[var(--foreground)]">
            RTK filters ({filterEntries.length}) <span className="opacity-50 group-open:hidden">▸</span><span className="opacity-50 hidden group-open:inline">▾</span>
          </summary>
          <div className="mt-1">
            {filterEntries.map(([name, value]) => {
              const rtkTotal = byTechnique.rtk ?? 0;
              const pct = rtkTotal > 0 ? (value / rtkTotal) * 100 : 0;
              return (
                <div key={name} className="mt-1 flex items-center gap-2 font-mono text-[11px]">
                  <span className="flex-1 truncate pl-2 text-[var(--muted-foreground)]">{RTK_FILTER_LABELS[name] ?? name}</span>
                  <div className="h-px w-16 bg-[var(--border)]">
                    <div className="h-full bg-[var(--success)]/60" style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                  <span className="w-14 text-right tabular-nums text-[var(--muted-foreground)]">−{formatNum(value)}</span>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {ponytail && <PonytailPanel ponytail={ponytail} />}
    </div>
  );
}

function PonytailPanel({
  ponytail,
}: {
  ponytail: NonNullable<CompressionStats["ponytail"]>;
}) {
  const overhead = ponytail.inputOverhead ?? 0;
  const markerCount = ponytail.outputMarkers ?? 0;
  const hits = ponytail.markerHits ?? [];
  const netPositive = markerCount > 0 && overhead < 0;

  return (
    <div className="mt-2.5 border-t border-[var(--hairline)] pt-2">
      <p className="eyebrow">Ponytail (lazy-dev ruleset)</p>
      <div className="mt-1 flex items-center gap-2 font-mono text-[11px]">
        <span className="flex-1 text-[var(--foreground)]">Input overhead</span>
        <span
          className={`w-14 text-right tabular-nums ${
            overhead < 0 ? "text-[var(--error)]" : "text-[var(--muted-foreground)]"
          }`}
        >
          {overhead < 0 ? "+" : ""}
          {formatNum(overhead)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[11px]">
        <span className="flex-1 text-[var(--foreground)]">Output markers</span>
        <span
          className={`w-14 text-right tabular-nums ${
            markerCount > 0 ? "text-[var(--success)]" : "text-[var(--muted-foreground)]"
          }`}
        >
          {markerCount}
        </span>
      </div>
      {netPositive && (
        <p className="mt-1 font-mono text-[10px] leading-relaxed text-[var(--muted-foreground)]">
          Ruleset injected (+{formatNum(Math.abs(overhead))} tokens overhead) → model emitted{" "}
          {markerCount} deliberate corner-cut marker{markerCount !== 1 ? "s" : ""}.
        </p>
      )}
      {hits.length > 0 && (
        <details className="mt-1 group">
          <summary className="eyebrow cursor-pointer hover:text-[var(--foreground)]">
            Marker details ({hits.length}){" "}
            <span className="opacity-50 group-open:hidden">▸</span>
            <span className="opacity-50 hidden group-open:inline">▾</span>
          </summary>
          <div className="mt-1 space-y-1">
            {hits.map((hit, i) => (
              <div
                key={i}
                className="border-l border-[var(--border)] bg-[var(--secondary)]/40 px-2 py-1 font-mono text-[11px]"
              >
                <div className="flex items-center gap-1">
                  <span className="text-[var(--primary)]">ponytail:</span>
                  <span className="text-[var(--foreground)]">{hit.ceiling}</span>
                </div>
                <div className="text-[var(--muted-foreground)]">
                  → {hit.upgradePath}
                </div>
                <div className="text-[10px] text-[var(--muted-foreground)]/70">
                  @ {hit.location}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const text = JSON.stringify(value || {}, null, 2);
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="eyebrow">{title}</p>
        <button
          className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:text-[var(--primary)]"
          onClick={() => navigator.clipboard.writeText(text)}
        >
          Copy
        </button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-md border border-[var(--border)] bg-[var(--sunken)] p-2.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">{text}</pre>
    </div>
  );
}
