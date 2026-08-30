import StatsCards from "@/components/dashboard/StatsCards";
import TokenUsage from "@/components/dashboard/TokenUsage";
import { Card } from "@/components/ui/card";
import PageHeader from "@/components/layout/PageHeader";
import { useEffect, useRef, useState } from "react";
import { fetchDashboardStats, fetchModelUsage, fetchBurnRate, type BurnRateItem } from "@/lib/api";
import { modelColor } from "@/lib/utils";
import { useApi } from "@/hooks/useApi";
import { useWsEvent } from "@/hooks/useWebSocket";

function providerLabel(provider: string): string {
  return provider
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toString();
}

function BurnRateStrip({ items }: { items: BurnRateItem[] }) {
  if (!items || items.length === 0) return null;
  const visible = items.slice(0, 10);
  const hidden = items.length - visible.length;

  return (
    <Card
      aria-label="Provider burn rate"
      className="grid grid-cols-2 divide-x divide-y divide-[var(--border)] overflow-hidden sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-5"
    >
      {visible.map((p) => {
        let tone = "var(--muted-foreground)";
        let value = "—";
        if (p.quotaRemaining === 0) {
          tone = "var(--error)";
          value = "0d";
        } else if (p.daysLeft !== null) {
          value = `${p.daysLeft.toFixed(1)}d`;
          tone =
            p.daysLeft < 2 ? "var(--error)" : p.daysLeft < 7 ? "var(--warning)" : "var(--success)";
        }
        return (
          <div key={p.provider} className="px-4 py-4">
            <div className="eyebrow">{providerLabel(p.provider)}</div>
            <div
              className="mt-1.5 font-mono text-xl font-semibold leading-none tabular-nums"
              style={{ color: tone }}
            >
              {value}
            </div>
            <div className="mt-1.5 truncate font-mono text-[10px] text-[var(--muted-foreground)]">
              {compactNumber(p.creditsPerDay)}/day · {compactNumber(p.quotaRemaining)} left
            </div>
          </div>
        );
      })}
      {hidden > 0 && (
        <div className="flex items-end justify-end px-4 py-4">
          <div className="font-mono text-[10px] text-[var(--muted-foreground)]">+{hidden} more</div>
        </div>
      )}
    </Card>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<any>(null);
  const [modelStats, setModelStats] = useState<any[]>([]);
  const burnRateApi = useApi<{ data: BurnRateItem[] }>(fetchBurnRate, []);

  async function load() {
    await Promise.all([
      fetchDashboardStats(undefined, "all").then(setStats).catch(() => setStats(null)),
      fetchModelUsage(undefined, "all").then((res: { data: any[] }) => setModelStats(res.data || [])).catch(() => setModelStats([])),
    ]);
  }

  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => { load(); burnRateApi.refetch(); }, 500);
  };

  useEffect(() => {
    load();
    return () => { if (reloadRef.current) clearTimeout(reloadRef.current); };
  }, []);

  useWsEvent(
    [
      "request_log",
      "request_error",
      "account_status",
      "account_updated",
      "account_created",
      "account_deleted",
      "accounts_updated",
      "accounts_bulk_created",
      "provider_toggled",
    ],
    scheduleReload,
  );

  const totalRequests = Number(stats?.requests?.total || 0);
  const successRequests = Number(stats?.requests?.success || 0);
  const dashboardStats = {
    accounts: {
      active: Number(stats?.pool?.active || 0),
      total: Number(stats?.pool?.total || 0),
    },
    requests: totalRequests,
    successRate: totalRequests > 0 ? Number(((successRequests / totalRequests) * 100).toFixed(1)) : 0,
    totalTokens: Number(stats?.tokens?.total || 0),
  };

  const tokenStats = {
    total: Number(stats?.tokens?.total || 0),
    prompt: Number(stats?.tokens?.prompt || 0),
    completion: Number(stats?.tokens?.completion || 0),
    credits: Number(stats?.tokens?.credits || 0),
  };

  const modelUsage = modelStats.filter((m) => Number(m.totalTokens || 0) > 0 || Number(m.credits || 0) > 0).slice(0, 8).map((m, idx) => ({
    provider: m.provider || "unknown",
    model: m.model || "unknown",
    tokens: Number(m.totalTokens || 0),
    promptTokens: Number(m.promptTokens || 0),
    completionTokens: Number(m.completionTokens || 0),
    credits: Number(m.credits || 0),
    requests: Number(m.totalRequests || 0),
    creditSource: m.creditSource || "estimated",
    color: modelColor(`${m.provider || "unknown"}/${m.model || "unknown"}`, idx),
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard"
        meta={
          <>
            <span>{dashboardStats.accounts.active} active</span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span>{dashboardStats.requests.toLocaleString()} req</span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span>all time</span>
          </>
        }
      />

      <StatsCards data={dashboardStats} />

      <BurnRateStrip items={burnRateApi.data?.data || []} />

      <TokenUsage stats={tokenStats} modelUsage={modelUsage} />
    </div>
  );
}
