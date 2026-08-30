import { useEffect, useState, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import UsageChart from "./UsageChart";
import { formatNumber, parseUtcDate, modelColor } from "@/lib/utils";
import { fetchUsage } from "@/lib/api";
import { useWsEvent } from "@/hooks/useWebSocket";

interface TokenStats {
  total: number;
  prompt: number;
  completion: number;
  credits?: number;
}

interface ModelUsage {
  provider?: string;
  model: string;
  tokens: number;
  promptTokens?: number;
  completionTokens?: number;
  credits?: number;
  requests?: number;
  creditSource?: string;
  color: string;
}

interface TokenUsageProps {
  stats?: TokenStats;
  modelUsage?: ModelUsage[];
}

const defaultStats: TokenStats = {
  total: 0,
  prompt: 0,
  completion: 0,
  credits: 0,
};

const defaultModelUsage: ModelUsage[] = [];

/**
 * How many hours of data to request from the backend.
 *
 * We intentionally over-fetch so that the current local-timezone period is
 * fully covered regardless of the user's UTC offset.  The extra rows are
 * discarded during local-bucket mapping — only rows that land inside the
 * visible buckets contribute to the chart AND the summary cards.
 */
function getChartHours(period: string): number | null {
  if (period === "1d") return 48;
  if (period === "7d") return 24 * 8;
  if (period === "30d") return 24 * 31;
  return null; // "all"
}

function modelKey(row: { provider?: string; model?: string }) {
  return `${row.provider || "unknown"}/${row.model || "unknown"}`;
}

// ─── Local-timezone bucket helpers ──────────────────────────────────────────

/** Truncate a Date to the start of its hour in the user's local timezone */
function truncHourLocal(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
}

/** Truncate a Date to the start of its day in the user's local timezone */
function truncDayLocal(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Truncate a Date to the start of its month in the user's local timezone */
function truncMonthLocal(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/**
 * Snap a UTC epoch (from the backend bucket key) to the corresponding
 * local-timezone bucket epoch.
 */
function snapToLocalBucket(utcEpoch: number, period: string): number {
  const d = new Date(utcEpoch);
  if (period === "1d") return truncHourLocal(d);
  if (period === "7d" || period === "30d") return truncDayLocal(d);
  return truncMonthLocal(d);
}

/** Convert a backend hour key (ISO UTC) to a numeric epoch (ms) */
function parseBucketKey(isoKey: string): number {
  return parseUtcDate(isoKey).getTime();
}

/** Format a bucket epoch to a display label in user's local timezone */
function formatLabel(epoch: number, period: string): string {
  const d = new Date(epoch);
  if (period === "1d") {
    return `${String(d.getHours()).padStart(2, "0")}:00`;
  }
  if (period === "7d" || period === "30d") {
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Generate ordered bucket epochs for the chart, all in the user's local
 * timezone so labels read naturally.
 *
 * - **1d** — 25 hourly buckets as a rolling 24h window (now-24h → now).
 * - **7d** — 7 daily buckets ending today.
 * - **30d** — 30 daily buckets ending today.
 * - **all** — last 12 monthly buckets.
 */
function generateBuckets(period: string): number[] {
  const now = new Date();
  const buckets: number[] = [];

  if (period === "1d") {
    // Full calendar day: 00:00 → 00:00 (today)
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    for (let i = 0; i <= 24; i++) {
      buckets.push(todayStart + i * 3600_000);
    }
    return buckets;
  }

  if (period === "7d" || period === "30d") {
    const days = period === "7d" ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      buckets.push(d.getTime());
    }
    return buckets;
  }

  // "all" — last 12 months
  for (let i = 11; i >= 0; i--) {
    buckets.push(new Date(now.getFullYear(), now.getMonth() - i, 1).getTime());
  }
  return buckets;
}

/** A single backend usage row */
interface UsageRow {
  hour: string;
  provider?: string;
  model?: string;
  tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  credits?: number;
  count?: number;
}

/**
 * Filter backend rows to only those that fall inside the visible buckets,
 * then build chart data, stats totals, and per-model breakdown — all from
 * the **same** filtered dataset so the numbers always match the chart.
 */
function processUsageData(rows: UsageRow[], period: string) {
  const bucketEpochs = generateBuckets(period);
  const bucketSet = new Set(bucketEpochs);

  // ── 1. Identify which rows land inside visible buckets ────────────
  const visibleRows: Array<UsageRow & { localEpoch: number }> = [];
  for (const row of rows) {
    const utcEpoch = parseBucketKey(row.hour);
    const localEpoch = snapToLocalBucket(utcEpoch, period);
    if (bucketSet.has(localEpoch)) {
      visibleRows.push({ ...row, localEpoch });
    }
  }

  // ── 2. Build chart data (model × bucket) ──────────────────────────
  const models = Array.from(new Set(visibleRows.map(modelKey)));
  const byEpoch = new Map<number, Record<string, number | string>>();
  for (const epoch of bucketEpochs) {
    const entry: Record<string, number | string> = {
      hour: String(epoch),
      label: formatLabel(epoch, period),
    };
    for (const model of models) entry[model] = 0;
    byEpoch.set(epoch, entry);
  }
  for (const row of visibleRows) {
    const model = modelKey(row);
    const bucket = byEpoch.get(row.localEpoch)!;
    bucket[model] = Number(bucket[model] || 0) + Number(row.tokens || 0);
  }
  const chartData = bucketEpochs.map((epoch) => byEpoch.get(epoch)!);

  // ── 3. Compute stats totals from visible rows only ────────────────
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let credits = 0;
  for (const row of visibleRows) {
    totalTokens += Number(row.tokens || 0);
    promptTokens += Number(row.promptTokens || 0);
    completionTokens += Number(row.completionTokens || 0);
    credits += Number(row.credits || 0);
  }
  const stats: TokenStats = {
    total: totalTokens,
    prompt: promptTokens,
    completion: completionTokens,
    credits,
  };

  // ── 4. Compute per-model breakdown from visible rows only ─────────
  const modelMap = new Map<string, {
    provider: string;
    model: string;
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    credits: number;
    requests: number;
  }>();
  for (const row of visibleRows) {
    const key = modelKey(row);
    const existing = modelMap.get(key);
    if (existing) {
      existing.tokens += Number(row.tokens || 0);
      existing.promptTokens += Number(row.promptTokens || 0);
      existing.completionTokens += Number(row.completionTokens || 0);
      existing.credits += Number(row.credits || 0);
      existing.requests += Number(row.count || 0);
    } else {
      modelMap.set(key, {
        provider: row.provider || "unknown",
        model: row.model || "unknown",
        tokens: Number(row.tokens || 0),
        promptTokens: Number(row.promptTokens || 0),
        completionTokens: Number(row.completionTokens || 0),
        credits: Number(row.credits || 0),
        requests: Number(row.count || 0),
      });
    }
  }
  const modelUsage: ModelUsage[] = Array.from(modelMap.values())
    .filter((m) => m.tokens > 0 || m.credits > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 8)
    .map((m, idx) => ({
      ...m,
      creditSource: "estimated",
      color: modelColor(`${m.provider}/${m.model}`, idx),
    }));

  return { chartData, stats, modelUsage };
}

export default function TokenUsage({
  stats: externalStats = defaultStats,
  modelUsage: externalModelUsage = defaultModelUsage,
}: TokenUsageProps) {
  const [period, setPeriod] = useState("1d");
  const [chartData, setChartData] = useState<any[]>([]);
  const [filteredStats, setFilteredStats] = useState<TokenStats>(defaultStats);
  const [filteredModelUsage, setFilteredModelUsage] = useState<ModelUsage[]>([]);

  const stats = filteredStats;
  const modelUsage = filteredModelUsage;

  const maxTokens = Math.max(1, ...modelUsage.map((m) => Number(m.tokens || 0)));
  const colorsByModel = Object.fromEntries(
    modelUsage.map((model) => [`${model.provider || "unknown"}/${model.model || "unknown"}`, model.color]),
  );

  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadData() {
    const hours = getChartHours(period);
    const range = period === "all" ? "all" : undefined;
    try {
      const usageRes = await fetchUsage(hours, range) as { data: UsageRow[] };
      const { chartData: chart, stats: s, modelUsage: m } = processUsageData(usageRes.data || [], period);
      setChartData(chart);
      setFilteredStats(s);
      setFilteredModelUsage(m);
    } catch {
      setChartData([]);
      setFilteredStats(defaultStats);
      setFilteredModelUsage([]);
    }
  }

  const scheduleReload = () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => { loadData(); }, 500);
  };

  useEffect(() => {
    loadData();
    return () => { if (reloadRef.current) clearTimeout(reloadRef.current); };
  }, [period]);

  useWsEvent(["request_log", "request_error"], scheduleReload);

  return (
    /* The chart is the primary surface of this view, so it — and only it —
       carries elevation. Everything nested inside stays flat and is separated
       by hairlines. */
    <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
      {/* Header doubles as the readout: the three totals live inline with the
          title instead of in three identical boxes below it. */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div>
            <div className="eyebrow">Tokens {period === "all" ? "all time" : period}</div>
            <div className="mt-1 font-mono text-[26px] font-semibold leading-none tabular-nums text-[var(--foreground)]">
              {formatNumber(stats.total)}
            </div>
          </div>
          <dl className="flex items-end gap-5 pb-0.5">
            <div>
              <dt className="eyebrow">Prompt</dt>
              <dd className="mt-1 font-mono text-sm tabular-nums text-[var(--foreground)]">
                {formatNumber(stats.prompt)}
              </dd>
            </div>
            <div>
              <dt className="eyebrow">Completion</dt>
              <dd className="mt-1 font-mono text-sm tabular-nums text-[var(--foreground)]">
                {formatNumber(stats.completion)}
              </dd>
            </div>
          </dl>
        </div>
        <Tabs value={period} onValueChange={setPeriod}>
          <TabsList>
            <TabsTrigger value="1d">1d</TabsTrigger>
            <TabsTrigger value="7d">7d</TabsTrigger>
            <TabsTrigger value="30d">30d</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="px-2 py-3 sm:px-3">
        <UsageChart data={chartData} period={period} colorsByModel={colorsByModel} />
      </div>

      {/* By model — a ledger, not eight stacked progress bars. The bar is a
          hairline under each row so the numbers stay the loudest thing. */}
      <div className="border-t border-[var(--border)]">
        <div className="flex items-baseline justify-between px-4 pb-1 pt-3">
          <h4 className="eyebrow">By model</h4>
          <span className="eyebrow">Tokens · req</span>
        </div>
        <div>
          {modelUsage.map((model) => (
            <div
              key={`${model.provider || "unknown"}/${model.model}`}
              className="group relative flex items-center justify-between gap-3 border-t border-[var(--hairline)] px-4 py-2 transition-colors duration-150 ease-out hover:bg-[var(--secondary)]/40"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden
                  className="h-2.5 w-[3px] shrink-0 rounded-full"
                  style={{ backgroundColor: model.color }}
                />
                <span className="truncate font-mono text-[12px] text-[var(--foreground)]">
                  {model.provider ? `${model.provider}/` : ""}{model.model}
                </span>
                <span className="eyebrow hidden shrink-0 sm:inline">
                  {model.creditSource || "estimated"}
                </span>
              </div>
              <span className="shrink-0 font-mono text-[12px] tabular-nums text-[var(--muted-foreground)]">
                <span className="text-[var(--foreground)]">{formatNumber(model.tokens)}</span>
                {" · "}
                {model.requests || 0}
              </span>
              {/* share-of-total rule, pinned to the row's bottom edge */}
              <span
                aria-hidden
                className="absolute bottom-0 left-0 h-px"
                style={{
                  width: `${(Number(model.tokens || 0) / maxTokens) * 100}%`,
                  backgroundColor: model.color,
                  opacity: 0.55,
                }}
              />
            </div>
          ))}
          {modelUsage.length === 0 && (
            <p className="border-t border-[var(--hairline)] px-4 py-3 font-mono text-[12px] text-[var(--muted-foreground)]">
              No token usage in this range.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
