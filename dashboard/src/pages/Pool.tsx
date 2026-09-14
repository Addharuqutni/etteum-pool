import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, Check, RefreshCw } from "lucide-react";
import { API_BASE } from "@/lib/api";

const STORE_KEY = "etteum_pool_key";

interface PubModel { id: string; owned_by: string }
interface MuRow { model: string; totalRequests: number; totalTokens: number }
interface LogRow {
  id: number; provider: string; model: string | null;
  promptTokens: number; completionTokens: number; totalTokens: number;
  status: string; durationMs: number | null; createdAt: string;
}
interface Quota {
  name: string; monthlyUsed: number; monthlyBudget: number;
  lifetimeUsed: number; lifetimeBudget: number;
}

const fmt = (n: number) => (n || 0).toLocaleString("en-US");
const compact = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2).replace(/\.00$/, "") + "B"
  : n >= 1e6 ? (n / 1e6).toFixed(2).replace(/\.00$/, "") + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K"
  : fmt(n);

export default function Pool() {
  const [models, setModels] = useState<PubModel[]>([]);
  const [usage, setUsage] = useState<MuRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [key, setKey] = useState(() => localStorage.getItem(STORE_KEY) || "");
  const [quota, setQuota] = useState<Quota | null>(null);
  const [paste, setPaste] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [flash, setFlash] = useState("");

  function showFlash(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash(""), 1600);
  }
  function copy(id: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    showFlash("Copied to clipboard");
    setTimeout(() => setCopied(null), 1500);
  }

  const loadStatic = useCallback(async () => {
    try {
      const [m, u, l] = await Promise.all([
        fetch(`${API_BASE}/api/public/models`).then((r) => r.json()),
        fetch(`${API_BASE}/api/public/usage`).then((r) => r.json()),
        fetch(`${API_BASE}/api/public/requests?limit=40`).then((r) => r.json()),
      ]);
      setModels(m.data || []);
      setUsage(u.data || []);
      setLogs(l.data || []);
    } catch { /* keep stale */ }
  }, []);

  const loadQuota = useCallback(async (k: string) => {
    if (!k) { setQuota(null); return; }
    try {
      const r = await fetch(`${API_BASE}/api/public/quota`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: k }),
      });
      if (!r.ok) { setQuota(null); return; }
      setQuota(await r.json());
    } catch { setQuota(null); }
  }, []);

  useEffect(() => {
    loadStatic();
    loadQuota(key);
    const t = setInterval(() => { loadStatic(); if (key) loadQuota(key); }, 15000);
    return () => clearInterval(t);
  }, [loadStatic, loadQuota, key]);

  async function savePaste() {
    const k = paste.trim();
    setErr("");
    if (!k) { setErr("paste a key first"); return; }
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/public/quota`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: k }),
      });
      if (r.status === 401) throw new Error("key is not valid or has been revoked");
      if (!r.ok) throw new Error("validation failed (" + r.status + ")");
      const q = await r.json();
      localStorage.setItem(STORE_KEY, k);
      setKey(k);
      setQuota(q);
      setPaste("");
      showFlash("Key activated — quota card updated");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function resetKey() {
    localStorage.removeItem(STORE_KEY);
    setKey("");
    setQuota(null);
    showFlash("Key removed from this browser");
  }

  const pct = quota && quota.monthlyBudget > 0
    ? Math.min(100, (quota.monthlyUsed / quota.monthlyBudget) * 100) : 0;
  const activeKey = key || "YOUR_API_KEY";
  const baseUrl = `${API_BASE}/v1`;
  const curl = `curl ${baseUrl}/chat/completions \\\n  -H "Authorization: Bearer ${activeKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${models[0]?.id || "MODEL"}", "messages": [{"role": "user", "content": "Hello!"}]}'`;
  const max = usage[0]?.totalTokens || 1;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <div className="rise">
        <p className="eyebrow">etteum pool</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Shared models, ready to use.</h1>
      </div>

      <Card className="rise shadow-[var(--shadow-raised)]" style={{ ["--d" as string]: "40ms" }}>
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="eyebrow">{quota ? quota.name : "Your quota"}</p>
              <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
                {quota ? <>{compact(quota.monthlyUsed)} <span className="text-[var(--muted-foreground)]">/ {quota.monthlyBudget > 0 ? compact(quota.monthlyBudget) : "unlimited"}</span></> : <><span className="text-[var(--muted-foreground)]">— / —</span></>}
              </p>
              <p className="mt-1 font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
                {quota ? `lifetime ${compact(quota.lifetimeUsed)}${quota.lifetimeBudget > 0 ? ` / ${compact(quota.lifetimeBudget)}` : ""}` : "paste your API key to see your quota"}
              </p>
            </div>
            <span className="rounded-full bg-[var(--secondary)] px-3 py-1 font-mono text-[12px] tabular-nums text-[var(--primary)]">
              {quota && quota.monthlyBudget > 0 ? pct.toFixed(1) + "%" : "—"}
            </span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--muted)]">
            <div className="h-full rounded-full bg-[var(--primary)] transition-all" style={{ width: pct + "%" }} />
          </div>
          <div className="mt-2 flex flex-wrap justify-between gap-2 font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
            <span>{quota ? `${fmt(quota.monthlyUsed)} used this month` : "0 used"}</span>
            <span>{quota?.monthlyBudget ? "monthly cap" : "ask admin for a key"}</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card className="rise lg:col-span-3 lg:row-span-2" style={{ ["--d" as string]: "80ms" }}>
          <CardHeader>
            <CardTitle>Available models</CardTitle>
            <CardDescription>{models.length} models</CardDescription>
          </CardHeader>
          <CardContent className="max-h-[480px] space-y-0.5 overflow-y-auto">
            <p className="eyebrow mb-1">Chat / completions</p>
            {models.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-[var(--muted)]">
                <code className="font-mono text-[12px]">{m.id}</code>
                <span className="shrink-0 font-mono text-[10.5px] text-[var(--muted-foreground)]">{m.owned_by}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="rise lg:col-span-4" style={{ ["--d" as string]: "120ms" }}>
          <CardHeader>
            <CardTitle>API key</CardTitle>
            <CardDescription>{quota ? quota.name : "no key saved"}</CardDescription>
          </CardHeader>
          <CardContent>
            {key ? (
              <>
                <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--sunken)] px-3 py-2">
                  <span className="truncate font-mono text-[12px] text-[var(--primary)]">{key.slice(0, 24)}…</span>
                  <Button size="sm" variant="outline" onClick={() => copy("tok", key)}>
                    {copied === "tok" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Copy
                  </Button>
                </div>
                <Button size="sm" variant="ghost" onClick={resetKey} className="mt-2">remove key</Button>
              </>
            ) : (
              <>
                <div className="flex gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 font-mono text-[12px] placeholder:text-[var(--muted-foreground)]"
                    type="password" value={paste} onChange={(e) => setPaste(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && savePaste()}
                    placeholder="paste key given by admin" spellCheck={false} autoComplete="off"
                  />
                  <Button size="sm" variant="outline" onClick={savePaste} disabled={busy}>use this key</Button>
                </div>
                {err && <p className="mt-2 font-mono text-[12px] text-[var(--error)]">{err}</p>}
              </>
            )}
            <div className="mt-3 border-t border-[var(--border)] pt-3">
              <p className="eyebrow mb-2">Quick start</p>
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[11px] text-[var(--muted-foreground)]">Base URL</span>
                <code className="flex-1 truncate font-mono text-[12px]">{baseUrl}</code>
                <Button size="sm" variant="ghost" onClick={() => copy("base", baseUrl)}>
                  {copied === "base" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
              <pre className="max-h-48 overflow-auto rounded-md border border-[var(--border)] bg-[var(--sunken)] p-2.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">{curl}</pre>
              <Button size="sm" variant="outline" onClick={() => copy("curl", curl)} className="mt-2">
                {copied === "curl" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Copy example
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="rise lg:col-span-5 lg:row-span-2" style={{ ["--d" as string]: "160ms" }}>
          <CardHeader className="flex-row items-center justify-between">
            <div><CardTitle>Usage logs</CardTitle></div>
            <Button size="sm" variant="ghost" onClick={() => { loadStatic(); }}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </CardHeader>
          <CardContent className="px-2">
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full table-fixed text-[12px]">
                <thead className="sticky-head">
                  <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                    <th className="px-3 py-2 text-left">time</th>
                    <th className="px-3 py-2 text-left">model</th>
                    <th className="px-3 py-2 text-right">in/out</th>
                    <th className="px-3 py-2 text-right">total</th>
                    <th className="px-3 py-2 text-right">status</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0 && <tr><td colSpan={5} className="px-3 py-2 font-mono text-[11px] text-[var(--muted-foreground)]">no requests yet</td></tr>}
                  {logs.map((l) => (
                    <tr key={l.id} className="border-t border-[var(--hairline)]">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">{l.createdAt ? new Date(l.createdAt).toLocaleTimeString() : ""}</td>
                      <td className="truncate px-3 py-2 font-mono text-[11px]">{l.model ? l.model.split("/").pop() : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">{fmt(l.promptTokens)}↑ {fmt(l.completionTokens)}↓</td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums">{fmt(l.totalTokens)}</td>
                      <td className={`px-3 py-2 text-right font-mono text-[11px] font-semibold ${l.status === "success" ? "text-[var(--success)]" : "text-[var(--error)]"}`}>{l.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card className="rise lg:col-span-4" style={{ ["--d" as string]: "200ms" }}>
          <CardHeader className="flex-row items-center justify-between">
            <div><CardTitle>Usage by model</CardTitle></div>
            <Button size="sm" variant="ghost" onClick={() => { loadStatic(); }}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </CardHeader>
          <CardContent className="max-h-[300px] space-y-2 overflow-y-auto">
            {usage.length === 0 && <p className="font-mono text-[11px] text-[var(--muted-foreground)]">no usage recorded yet</p>}
            {usage.map((u) => (
              <div key={u.model}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-[12px]">{u.model}</span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">{fmt(u.totalTokens)} · {u.totalRequests} req</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--muted)]">
                  <div className="h-full rounded-full bg-[var(--primary)]" style={{ width: Math.max(2, (u.totalTokens / max) * 100) + "%" }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      {flash && (
        <div className="fixed bottom-7 left-1/2 -translate-x-1/2 rounded-full bg-[var(--foreground)] px-4 py-2 font-mono text-[12px] text-[var(--background)]">
          {flash}
        </div>
      )}
    </div>
  );
}
