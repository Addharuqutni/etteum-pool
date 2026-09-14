import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import PageHeader from "@/components/layout/PageHeader";
import { Trash2, Upload, RefreshCw, Power, PowerOff, Download, Minus, Plus } from "lucide-react";
import {
  fetchApi,
  fetchProxyCountries,
  scrapeProxies,
  addProxies,
  updateProxy,
  type ProxyCountry,
  type ScrapeSourceResult,
} from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

const SCRAPE_SOURCES: { id: string; label: string }[] = [
  { id: "all", label: "All sources" },
  { id: "proxyscrape", label: "ProxyScrape" },
  { id: "geonode", label: "Geonode" },
  { id: "proxifly", label: "Proxifly" },
  { id: "thespeedx", label: "TheSpeedX" },
  { id: "jetkai", label: "Jetkai" },
  { id: "iplocate", label: "IPLocate" },
  { id: "vpslab", label: "VPSLab" },
  { id: "hproxy", label: "HProxy" },
];

interface ProxyEntry {
  id: number;
  url: string;
  type: string;
  label: string | null;
  status: string;
  usage: string;
  priority: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  successCount: number;
  failCount: number;
  createdAt: string;
}

interface ProxyPoolStatus {
  count: number;
  activeCount: number;
  proxies: ProxyEntry[];
}

export default function ProxyPool() {
  const [pool, setPool] = useState<ProxyPoolStatus>({ count: 0, activeCount: 0, proxies: [] });
  const [loading, setLoading] = useState(true);
  const [bulkText, setBulkText] = useState("");
  const [bulkPriority, setBulkPriority] = useState(0);
  const [checking, setChecking] = useState(false);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  // Scrape controls
  const [countries, setCountries] = useState<ProxyCountry[]>([]);
  const [scrapeSource, setScrapeSource] = useState("all");
  const [scrapeCountry, setScrapeCountry] = useState("all");
  const [scrapeProtocol, setScrapeProtocol] = useState<"all" | "http" | "socks5">("all");
  const [scrapeLimit, setScrapeLimit] = useState(50);
  const [scrapeVerify, setScrapeVerify] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [sourceResults, setSourceResults] = useState<ScrapeSourceResult[] | null>(null);

  const loadPool = useCallback(async () => {
    try {
      const data = await fetchApi<ProxyPoolStatus>("/api/proxy-pool/pool");
      setPool(data);
    } catch {
      setPool({ count: 0, activeCount: 0, proxies: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPool();
    fetchProxyCountries()
      .then((data) => setCountries(data.countries))
      .catch(() => setCountries([{ code: "all", name: "Any region" }]));
  }, [loadPool]);

  const handleScrape = async () => {
    setScraping(true);
    setSourceResults(null);
    try {
      const result = await scrapeProxies({
        source: scrapeSource as any,
        country: scrapeCountry,
        protocol: scrapeProtocol,
        limit: scrapeLimit,
        verify: scrapeVerify,
      });
      setSourceResults(result.sources ?? null);
      if (result.added > 0) {
        setMessage(
          `Scraped ${result.scraped}, ${result.added} added` +
            (scrapeVerify ? ` (${result.verified} alive)` : "") +
            (result.skipped > 0 ? `, ${result.skipped} duplicates skipped` : ""),
        );
      } else if (result.scraped === 0) {
        setMessage("No proxies found for that region/source");
      } else {
        setMessage(
          scrapeVerify && result.verified === 0
            ? `Scraped ${result.scraped} but none passed health check`
            : "All scraped proxies already in pool",
        );
      }
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Scrape failed");
    } finally {
      setScraping(false);
    }
  };

  const handleBulkAdd = async () => {
    if (!bulkText.trim()) {
      setMessage("Paste proxy list first");
      return;
    }

    const proxies = bulkText
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (proxies.length === 0) {
      setMessage("No valid proxies found");
      return;
    }

    try {
      const result = await addProxies(proxies, bulkPriority > 0 ? bulkPriority : undefined);
      setBulkText("");
      const parts = [`${result.added} added`];
      if (result.skipped > 0) parts.push(`${result.skipped} duplicate`);
      if (result.invalid > 0) parts.push(`${result.invalid} invalid`);
      setMessage(parts.join(", "));
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to add proxies");
    }
  };

  const handleToggle = async (id: number, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "disabled" : "active";
    try {
      await fetchApi(`/api/proxy-pool/pool/${id}`, {
        method: "PUT",
        body: JSON.stringify({ status: newStatus }),
      });
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to toggle proxy");
    }
  };

  const handlePriority = async (id: number, priority: number) => {
    try {
      await fetchApi(`/api/proxy-pool/pool/${id}`, {
        method: "PUT",
        body: JSON.stringify({ priority }),
      });
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to update priority");
    }
  };

  const handleUsage = async (id: number, usage: string) => {
    try {
      await fetchApi(`/api/proxy-pool/pool/${id}`, {
        method: "PUT",
        body: JSON.stringify({ usage }),
      });
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to update usage");
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await fetchApi(`/api/proxy-pool/pool/${id}`, { method: "DELETE" });
      setMessage("Proxy removed");
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to remove proxy");
    }
  };

  const handleClearAll = async () => {
    if (!confirm("Remove all proxies from pool?")) return;
    try {
      await fetchApi("/api/proxy-pool/pool", { method: "DELETE" });
      setMessage("Pool cleared");
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to clear pool");
    }
  };

  const handleCheckSingle = async (id: number) => {
    try {
      const result = await fetchApi<{ ok: boolean; latencyMs: number; error?: string }>(
        `/api/proxy-pool/pool/${id}/check`,
        { method: "POST" }
      );
      setMessage(result.ok ? `Healthy (${result.latencyMs}ms)` : `Failed: ${result.error}`);
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Health check failed");
    }
  };

  const handleCheckAll = async () => {
    setChecking(true);
    try {
      const result = await fetchApi<{ checked: number; ok: number; failed: number }>(
        "/api/proxy-pool/pool/check-all",
        { method: "POST", timeoutMs: 120_000 },
      );
      setMessage(`Checked ${result.checked} (${result.ok ?? 0} ok, ${result.failed ?? 0} fail)`);
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Check all failed");
    } finally {
      setChecking(false);
    }
  };

  const statusTone = (status: string) =>
    status === "active"
      ? "var(--success)"
      : status === "disabled"
        ? "var(--warning)"
        : status === "error"
          ? "var(--error)"
          : "var(--muted-foreground)";

  const latencyTone = (ms: number) =>
    ms < 1000 ? "var(--success)" : ms < 3000 ? "var(--warning)" : "var(--error)";

  const maskUrl = (url: string) => {
    try {
      const u = new URL(url);
      const masked = u.password ? `${u.protocol}//${u.username}:***@${u.host}` : `${u.protocol}//${u.host}`;
      return masked;
    } catch {
      return url;
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Proxy Pool"
        meta={
          <>
            <span className={pool.activeCount > 0 ? "text-[var(--success)]" : undefined}>
              {pool.activeCount} active
            </span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span>{pool.count} total</span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span>
              {pool.proxies.length > 0
                ? [...new Set(pool.proxies.map((p) => p.type))].sort().join(" / ")
                : "HTTP / SOCKS5"}
            </span>
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={handleCheckAll} disabled={checking}>
              <RefreshCw className={`w-3.5 h-3.5 ${checking ? "animate-spin" : ""}`} />
              {checking ? "Checking…" : "Check all"}
            </Button>
            {pool.count > 0 && (
              <Button variant="ghost" size="sm" onClick={handleClearAll} className="hover:text-[var(--destructive)]">
                <Trash2 className="w-3.5 h-3.5" /> Clear
              </Button>
            )}
          </>
        }
      />

      {message && (
        <p className="border-l-2 border-[var(--border)] bg-[var(--secondary)]/50 px-3 py-2 font-mono text-[11px] text-[var(--foreground)]">
          {message}
        </p>
      )}

      {/* Intake on a narrow rail, the pool itself gets the room. Asymmetric on
          purpose — the list is what an operator reads, the forms are tools. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] lg:items-start">
        <div className="space-y-4">
          <Card>
            <div className="border-b border-[var(--border)] px-4 py-3">
              <h2 className="eyebrow">Paste proxies</h2>
            </div>
            <div className="space-y-2 px-3 py-3">
              <textarea
                className="h-[104px] w-full resize-none rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--foreground)] transition-colors duration-150 ease-out placeholder:text-[var(--muted-foreground)]/70 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                placeholder={"one per line\nhttp://user:pass@host:port\nsocks5://host:port\nhost:8080"}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                aria-label="Proxy list"
              />
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <label htmlFor="bulk-priority" className="eyebrow mb-1 block">Default priority</label>
                  <Input
                    id="bulk-priority"
                    type="number"
                    min={0}
                    value={bulkPriority}
                    onChange={(e) => setBulkPriority(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                    className="font-mono tabular-nums"
                  />
                </div>
                <Button onClick={handleBulkAdd} size="sm" className="mt-4">
                  <Upload className="w-3.5 h-3.5" /> Add to pool
                </Button>
              </div>
            </div>
          </Card>

          <Card>
            <div className="border-b border-[var(--border)] px-4 py-3">
              <h2 className="eyebrow">Scrape public sources</h2>
            </div>
            <div className="space-y-2.5 px-3 py-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="scrape-source" className="eyebrow mb-1 block">Source</label>
                  <Select
                    id="scrape-source"
                    className="font-mono text-[11px]"
                    value={scrapeSource}
                    onChange={(e) => setScrapeSource(e.target.value)}
                  >
                    {SCRAPE_SOURCES.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label htmlFor="scrape-region" className="eyebrow mb-1 block">Region</label>
                  <Select
                    id="scrape-region"
                    className="font-mono text-[11px]"
                    value={scrapeCountry}
                    onChange={(e) => setScrapeCountry(e.target.value)}
                  >
                    {countries.map((c) => (
                      <option key={c.code} value={c.code}>{c.name}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label htmlFor="scrape-protocol" className="eyebrow mb-1 block">Protocol</label>
                  <Select
                    id="scrape-protocol"
                    className="font-mono text-[11px]"
                    value={scrapeProtocol}
                    onChange={(e) => setScrapeProtocol(e.target.value as typeof scrapeProtocol)}
                  >
                    <option value="all">http + socks5</option>
                    <option value="http">http</option>
                    <option value="socks5">socks5</option>
                  </Select>
                </div>
                <div>
                  <label htmlFor="scrape-limit" className="eyebrow mb-1 block">Max</label>
                  <Input
                    id="scrape-limit"
                    type="number"
                    min={1}
                    max={500}
                    className="font-mono tabular-nums"
                    value={scrapeLimit}
                    onChange={(e) => setScrapeLimit(Number(e.target.value))}
                  />
                </div>
              </div>
              <label className="flex cursor-pointer items-start gap-2 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--primary)]"
                  checked={scrapeVerify}
                  onChange={(e) => setScrapeVerify(e.target.checked)}
                />
                Health-check first — slower, keeps only working proxies
              </label>
<Button onClick={handleScrape} disabled={scraping} size="sm" variant="outline" className="w-full">
                <Download className="w-3.5 h-3.5" />
                {scraping ? "Scraping..." : "Scrape & add"}
              </Button>
              {sourceResults && (
                <div className="space-y-1 border-t border-[var(--hairline)] pt-2">
                  {sourceResults.map((s) => (
                    <div key={s.id} className="flex items-center justify-between gap-2 font-mono text-[10px]">
                      <span className="flex items-center gap-1.5 text-[var(--muted-foreground)]">
                        <span
                          aria-hidden
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: s.status === "fulfilled" ? "var(--success)" : s.status === "empty" ? "var(--warning)" : "var(--error)" }}
                        />
                        {s.label}
                      </span>
                      <span className="tabular-nums" style={{ color: s.status === "failed" ? "var(--error)" : "var(--foreground)" }}>
                        {s.status === "failed" ? "failed" : `${s.count}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Primary surface: the pool */}
        <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
          {loading ? (
            <p className="px-3 py-3 font-mono text-[12px] text-[var(--muted-foreground)]">Loading…</p>
          ) : pool.proxies.length === 0 ? (
            <p className="px-3 py-3 font-mono text-[12px] text-[var(--muted-foreground)]">
              Pool empty — paste or scrape proxies to enable IP rotation.
            </p>
          ) : (
            <div className="max-h-[calc(100vh-14rem)] overflow-auto">
              <table className="w-full border-collapse font-mono text-[12px]">
                <thead className="sticky-head">
                  <tr>
                    <th className="eyebrow px-4 py-2 text-left">Endpoint</th>
                    <th className="eyebrow px-4 py-2 text-left">Status</th>
                    <th className="eyebrow px-4 py-2 text-right">Latency</th>
                    <th className="eyebrow px-4 py-2 text-right hidden md:table-cell">Ok / Fail</th>
                    <th className="eyebrow px-4 py-2 text-left hidden md:table-cell">Usage</th>
                    <th className="eyebrow px-4 py-2 text-right hidden sm:table-cell">Priority</th>
                    <th className="eyebrow px-4 py-2 text-left hidden lg:table-cell">Last used</th>
                    <th className="eyebrow px-4 py-2 text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {pool.proxies.map((proxy) => (
                    <tr
                      key={proxy.id}
                      className={`border-t border-[var(--hairline)] transition-colors duration-150 ease-out hover:bg-[var(--secondary)]/40 ${proxy.status === "active" ? "" : "opacity-70"}`}
                    >
                      <td className="max-w-[260px] px-4 py-2">
                        <span className="block truncate text-[var(--foreground)]" title={maskUrl(proxy.url)}>
                          {maskUrl(proxy.url)}
                        </span>
                        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--muted-foreground)]">{proxy.type}</span>
                      </td>
                      <td className="px-4 py-2">
                        <span className="inline-flex items-center gap-1.5" style={{ color: statusTone(proxy.status) }} title={proxy.errorMessage ?? proxy.status}>
                          <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: statusTone(proxy.status) }} />
                          {proxy.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums" style={{ color: proxy.latencyMs == null ? "var(--muted-foreground)" : latencyTone(proxy.latencyMs) }}>
                        {proxy.latencyMs == null ? "—" : proxy.latencyMs < 1000 ? `${proxy.latencyMs}ms` : `${(proxy.latencyMs / 1000).toFixed(1)}s`}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-[var(--muted-foreground)] hidden md:table-cell">
                        <span className="text-[var(--success)]">{proxy.successCount}</span>
                        {" / "}
                        <span className={proxy.failCount > 0 ? "text-[var(--error)]" : ""}>{proxy.failCount}</span>
                      </td>
                      <td className="px-4 py-2 hidden md:table-cell">
                        <Select
                          aria-label="Proxy usage"
                          title="Usage scope: all = model + auth"
                          className="font-mono text-[11px]"
                          value={proxy.usage || "all"}
                          onChange={(e) => handleUsage(proxy.id, e.target.value)}
                        >
                          <option value="all">all</option>
                          <option value="model">model</option>
                          <option value="auth">auth</option>
                        </Select>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums hidden sm:table-cell">
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={() => handlePriority(proxy.id, Math.max(0, (proxy.priority || 0) - 1))}
                            disabled={!proxy.priority}
                            title="Lower priority"
                            aria-label="Lower priority"
                            className="grid h-5 w-5 place-items-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <span
                            className={`min-w-[1.5rem] text-center text-[11px] ${proxy.priority ? "text-[var(--primary)] font-semibold" : "text-[var(--muted-foreground)]"}`}
                            title={proxy.priority ? `Weight ${1 + proxy.priority}× vs priority 0` : "Default weight 1×"}
                          >
                            {proxy.priority || 0}
                          </span>
                          <button
                            onClick={() => handlePriority(proxy.id, (proxy.priority || 0) + 1)}
                            title="Raise priority"
                            aria-label="Raise priority"
                            className="grid h-5 w-5 place-items-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums text-[var(--muted-foreground)] hidden lg:table-cell">
                        {proxy.lastUsedAt ? new Date(proxy.lastUsedAt).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end">
                          <Button variant="ghost" size="icon" onClick={() => handleCheckSingle(proxy.id)} title="Health check" aria-label="Health check">
                            <RefreshCw className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleToggle(proxy.id, proxy.status)}
                            title={proxy.status === "active" ? "Disable" : "Enable"}
                            aria-label={proxy.status === "active" ? "Disable proxy" : "Enable proxy"}
                          >
                            {proxy.status === "active" ? <PowerOff className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(proxy.id)}
                            title="Delete"
                            aria-label="Delete proxy"
                            className="hover:text-[var(--destructive)]"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
