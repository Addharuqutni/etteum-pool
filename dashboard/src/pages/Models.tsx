import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import PageHeader from "@/components/layout/PageHeader";
import { Copy, Check, Search, ArrowDownAZ, ArrowUpAZ } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchAccounts, fetchModels } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

interface ModelData {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
}

// Provider accents come from the chart palette so they stay in sync with the
// theme (and with the same providers plotted on the usage chart).
// These render as TEXT, so they use the --chart-N-text variants: the plain
// fills are tuned for lines/bars and none of the six clears WCAG AA as text
// on the light card. The tint + border keep the fill token.
const providerColors: Record<string, string> = {
  codebuddy: "bg-[var(--chart-3)]/12 text-[var(--chart-3-text)] border-[var(--chart-3)]/30",
  "codebuddy-china": "bg-[var(--chart-5)]/12 text-[var(--chart-5-text)] border-[var(--chart-5)]/30",
  canva: "bg-[var(--chart-6)]/12 text-[var(--chart-6-text)] border-[var(--chart-6)]/30",
  codex: "bg-[var(--chart-1)]/12 text-[var(--chart-1-text)] border-[var(--chart-1)]/30",
  "grok-cli": "bg-[var(--chart-2)]/12 text-[var(--chart-2-text)] border-[var(--chart-2)]/30",
  claude: "bg-[var(--chart-4)]/12 text-[var(--chart-4-text)] border-[var(--chart-4)]/30",
  byok: "bg-[var(--chart-5)]/12 text-[var(--chart-5-text)] border-[var(--chart-5)]/30",
};

function providerKey(owner: string): string {
  return owner.toLowerCase().startsWith("byok") ? "byok" : owner;
}

function providerLabel(provider: string): string {
  if (provider === "byok") return "BYOK";
  return provider.split("-").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ");
}

function formatNumber(n: number | undefined): string {
  if (!n) return "-";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

export default function Models() {
  const [models, setModels] = useState<ModelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"owner" | "id">("owner");
  const [accountsByProvider, setAccountsByProvider] = useState<Record<string, number> | null>(null);
  const [accountsFailed, setAccountsFailed] = useState(false);
  const [usableOnly, setUsableOnly] = useState(() => localStorage.getItem("models-usable-only") === "true");
  const { message: copiedModel, setMessage: setCopiedModel } = useTimedMessage<string>(null, 1500);

  useEffect(() => {
    Promise.all([
      fetchModels().then((res: { data: ModelData[] }) => setModels(res.data || [])).catch(() => setModels([])),
      fetchAccounts().then((res: { data: Array<{ provider: string; status: string; enabled?: boolean }> }) => {
        const counts: Record<string, number> = {};
        (res.data || []).forEach((account) => {
          if (account.status === "active" && account.enabled !== false) {
            const key = providerKey(account.provider);
            counts[key] = (counts[key] || 0) + 1;
          }
        });
        setAccountsByProvider(counts);
      }).catch(() => setAccountsFailed(true)),
    ]).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    localStorage.setItem("models-usable-only", String(usableOnly));
  }, [usableOnly]);

  const usableProvider = (provider: string): boolean => accountsByProvider === null || (accountsByProvider[provider] ?? 0) > 0;

  const providers = useMemo(() => {
    const counts = new Map<string, number>();
    models.forEach((model) => {
      const key = providerKey(model.owned_by);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

  const usableModels = useMemo(() => models.filter((model) => usableProvider(providerKey(model.owned_by))).length, [models, accountsByProvider]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return models
      .filter((model) => filter === "all" || providerKey(model.owned_by) === filter)
      .filter((model) => !usableOnly || usableProvider(providerKey(model.owned_by)))
      .filter((model) => !query || model.id.toLowerCase().includes(query) || model.owned_by.toLowerCase().includes(query))
      .sort((a, b) => {
        const primary = sortBy === "owner" ? a.owned_by.localeCompare(b.owned_by) : a.id.localeCompare(b.id);
        return primary || a.id.localeCompare(b.id);
      });
  }, [filter, models, search, sortBy, usableOnly, accountsByProvider]);

  async function copyModelId(modelId: string) {
    try {
      await navigator.clipboard.writeText(modelId);
      setCopiedModel(modelId);
    } catch {
      /* clipboard unavailable */
    }
  }

  if (loading) {
    return (
      <p className="font-mono text-meta uppercase tracking-eyebrow text-[var(--muted-foreground)]">
        Loading models…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Models"
        meta={
          <>
            <span>{models.length} models</span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span>{providers.length} providers</span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span className={usableModels < models.length ? "text-[var(--warning-text)]" : undefined}>
              {usableModels} usable
            </span>
          </>
        }
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted-foreground)]" />
              <input
                type="text"
                placeholder="model or owner…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search models or owners"
                className="h-9 w-full rounded-md border border-[var(--input)] bg-[var(--background)] pl-8 pr-2.5 font-mono text-body text-[var(--foreground)] transition-colors duration-150 ease-out placeholder:text-[var(--muted-faint)] hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35 sm:w-56 md:h-8"
              />
            </div>
            <button
              type="button"
              onClick={() => setUsableOnly((value) => !value)}
              aria-pressed={usableOnly}
              title="Only show models from providers with active, enabled accounts"
              className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 font-mono text-micro uppercase tracking-eyebrow transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] md:h-8 ${usableOnly ? "border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary-text)]" : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${usableOnly ? "bg-[var(--primary)]" : "bg-[var(--muted-foreground)]"}`} /> Has accounts
            </button>
          </>
        }
      />

      {/* Provider filter rail — a row of terminal-style chips, no card wrapper.
          Filters are chrome; they don't deserve their own panel. */}
      <div className="flex flex-wrap items-center gap-1" aria-label="Filter by provider">
        <button
          type="button"
          onClick={() => setFilter("all")}
          aria-pressed={filter === "all"}
          className={`rounded-[4px] border px-2 py-1 font-mono text-micro uppercase tracking-caps transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${filter === "all" ? "border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary-text)]" : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
        >
          All <span className="t-num">{models.length}</span>
        </button>
        {providers.map(([provider, count]) => {
          const active = filter === provider;
          const accent = providerColors[provider];
          const accountCount = accountsByProvider?.[provider] ?? 0;
          const hasAccounts = accountsByProvider === null || accountCount > 0;
          return (
            <button
              key={provider}
              type="button"
              onClick={() => setFilter(provider)}
              aria-pressed={active}
              title={accountsByProvider && !hasAccounts ? "No active accounts for this provider" : `${accountCount} active account${accountCount === 1 ? "" : "s"}`}
              className={`rounded-[4px] border px-2 py-1 font-mono text-micro uppercase tracking-caps transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${active && accent ? accent : active ? "border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary-text)]" : !hasAccounts ? "border-dashed border-[var(--warning)]/35 text-[var(--muted-foreground)]" : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
            >
              {providerLabel(provider)} <span className="t-num">{count}</span>
              {accountsByProvider !== null && (
                <span className={hasAccounts ? "text-[var(--success-text)]" : "text-[var(--warning-text)]"}>
                  {" "}· {hasAccounts ? `${accountCount} keys` : "no keys"}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {accountsFailed && (
        <p className="font-mono text-meta text-[var(--warning-text)]">
          Account availability unavailable — showing all models.
        </p>
      )}

      {/* The inventory table is this page's primary surface. */}
      <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <span className="eyebrow">{filtered.length} shown</span>
          <button
            type="button"
            onClick={() => setSortBy((value) => value === "owner" ? "id" : "owner")}
            aria-label={`Sort by ${sortBy === "owner" ? "model ID" : "owner"}`}
            title={`Sort by ${sortBy === "owner" ? "model ID" : "owner"}`}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-micro uppercase tracking-eyebrow text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:text-[var(--primary-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            {sortBy === "owner" ? <ArrowDownAZ className="w-3.5 h-3.5" /> : <ArrowUpAZ className="w-3.5 h-3.5" />} {sortBy === "owner" ? "Owner" : "Model ID"}
          </button>
        </div>
        <div className="max-h-[min(66vh,44rem)] overflow-auto">
          <table className="w-full min-w-[680px] border-collapse font-mono text-body">
            <thead className="sticky-head">
              <tr>
                {(["Model", "Owner", "Context", "Output", "Thinking", ""] as const).map((heading, index) => (
                  <th
                    key={heading || index}
                    className={`eyebrow px-4 py-2 ${index === 2 || index === 3 ? "text-right" : "text-left"}`}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((model) => (
                <tr
                  key={model.id}
                  className="border-t border-[var(--hairline)] transition-colors duration-150 ease-out hover:bg-[var(--secondary)]/50"
                >
                  <td className="px-4 py-2"><span className="break-all text-[var(--foreground)]">{model.id}</span></td>
                  <td className="px-4 py-2">
                    <span
                      title={usableProvider(providerKey(model.owned_by)) ? undefined : "No active accounts for this provider"}
                      className={`inline-flex max-w-[180px] items-center truncate rounded-sm border px-1.5 py-0.5 text-micro uppercase tracking-caps ${usableProvider(providerKey(model.owned_by)) ? (providerColors[providerKey(model.owned_by)] || "border-[var(--border)] text-[var(--muted-foreground)]") : "border-dashed border-[var(--border)] text-[var(--muted-faint)]"}`}
                    >
                      {model.owned_by}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--foreground)]">{formatNumber(model.context_window)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--foreground)]">{formatNumber(model.max_output)}</td>
                  <td className="px-4 py-2">{model.thinking ? <Badge variant="info">Yes</Badge> : <span className="text-[var(--muted-foreground)]">—</span>}</td>
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      onClick={() => copyModelId(model.id)}
                      title={`Copy model ID: ${model.id}`}
                      aria-label={`Copy model ID: ${model.id}`}
                      className="rounded-md p-1 transition-colors duration-150 ease-out hover:bg-[var(--secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                      {copiedModel === model.id ? <Check className="w-3.5 h-3.5 text-[var(--success-text)]" /> : <Copy className="w-3.5 h-3.5 text-[var(--muted-foreground)]" />}
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="border-t border-[var(--hairline)] px-4 py-3 text-[var(--muted-foreground)]">
                    No models match this filter — clear the search or pick another provider.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
