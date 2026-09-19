import { Card } from "@/components/ui/card";

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

interface StatsData {
  accounts: { active: number; total: number };
  requests: number;
  successRate: number;
  totalTokens: number;
}

interface StatsCardsProps {
  data?: StatsData;
}

const defaultData: StatsData = {
  accounts: { active: 0, total: 0 },
  requests: 0,
  successRate: 0,
  totalTokens: 0,
};

export default function StatsCards({ data = defaultData }: StatsCardsProps) {
  const errorRate = data.successRate > 0 ? Number((100 - data.successRate).toFixed(1)) : 0;
  const idle = data.accounts.total - data.accounts.active;

  // Error rate is the number an operator scans for first, so it gets the
  // largest type and the only color. The rest are supporting readouts.
  const errorTone =
    errorRate === 0
      ? "var(--muted-foreground)"
      : errorRate < 2
        ? "var(--warning)"
        : "var(--error)";

  const secondary = [
    {
      label: "Requests",
      value: data.requests.toLocaleString(),
      note: "all time",
    },
    {
      label: "Tokens",
      value: formatTokens(data.totalTokens),
      note: "all time",
    },
    {
      label: "Keys live",
      value: `${data.accounts.active}`,
      note: `${idle > 0 ? `${idle} idle · ` : ""}${data.accounts.total} total`,
      tone: data.accounts.active > 0 ? "var(--success)" : "var(--muted-foreground)",
    },
  ];

  return (
    /* One strip, not four equal cards. The pool health readout is wide and
       loud; the three supporting metrics share a divided rail beside it. */
    <Card className="grid grid-cols-1 divide-y divide-[var(--border)] overflow-hidden lg:grid-cols-[minmax(0,1.15fr)_minmax(0,2fr)] lg:divide-x lg:divide-y-0">
      {/* Primary: error rate + success as the fine print under it */}
      <div className="flex items-end justify-between gap-4 px-4 py-4">
        <div>
          <div className="eyebrow">Error rate</div>
          <div
            className="mt-1.5 font-mono text-hero font-semibold tabular-nums"
            style={{ color: errorTone }}
          >
            {errorRate}
            {/* The "%" is emphasis-deferring chrome, not data. Opacity on text
                breaks contrast in light mode (2.5:1), so it uses the muted
                token instead — dimmer-looking, still compliant. */}
            <span className="ml-0.5 text-display font-medium text-[var(--muted-foreground)]">%</span>
          </div>
          <div className="mt-2 font-mono text-meta text-[var(--muted-foreground)]">
            {data.successRate}% success · {data.requests.toLocaleString()} req
          </div>
        </div>

        {/* Pool occupancy as a compact bar of live vs idle keys */}
        <div className="hidden w-28 shrink-0 sm:block">
          <div className="eyebrow text-right">Pool</div>
          <div className="mt-2 flex h-6 gap-px overflow-hidden rounded-sm bg-[var(--secondary)]">
            {data.accounts.total > 0 ? (
              <>
                <div
                  className="h-full bg-[var(--success)]/70 transition-[width] duration-200 ease-out"
                  style={{ width: `${(data.accounts.active / data.accounts.total) * 100}%` }}
                />
                <div className="h-full flex-1" />
              </>
            ) : null}
          </div>
          <div className="mt-1.5 text-right font-mono text-meta tabular-nums text-[var(--muted-foreground)]">
            {data.accounts.active}/{data.accounts.total}
          </div>
        </div>
      </div>

      {/* Secondary rail: denser, flatter, numbers first */}
      <div className="grid grid-cols-3 divide-x divide-[var(--border)]">
        {secondary.map((stat) => (
          <div key={stat.label} className="px-3 py-4 sm:px-4">
            <div className="eyebrow">{stat.label}</div>
            <div
              className="mt-1.5 font-mono text-stat-sm font-semibold tabular-nums"
              style={{ color: stat.tone || "var(--foreground)" }}
            >
              {stat.value}
            </div>
            <div className="mt-1.5 truncate font-mono text-micro text-[var(--muted-foreground)]">
              {stat.note}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
