import { useEffect, useState, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PageHeader from "@/components/layout/PageHeader";
import {
  Copy, Eye, EyeOff, RefreshCw, Check, Save, ShieldCheck, Plus, Trash2, Ban,
  Power, Share2, Link2, Lock,
} from "lucide-react";
import {
  fetchApiKeys,
  createApiKey,
  updateApiKey,
  setApiKeyEnabled,
  revokeApiKey,
  deleteApiKeyPermanent,
  regenerateApiKeyById,
  revealApiKeySecret,
  enableShare,
  disableShare,
  type ApiKeyDTO,
} from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { API_BASE } from "@/lib/api";

type Draft = {
  name: string;
  description: string;
  monthlyTokenBudget: string;
  oneTimeTokenBudget: string;
  rpmLimit: string;
  maxConcurrent: string;
  allowedProviders: string;
  deniedProviders: string;
  allowedModels: string;
  deniedModels: string;
};

const emptyDraft: Draft = {
  name: "",
  description: "",
  monthlyTokenBudget: "0",
  oneTimeTokenBudget: "0",
  rpmLimit: "0",
  maxConcurrent: "0",
  allowedProviders: "",
  deniedProviders: "",
  allowedModels: "",
  deniedModels: "",
};

function draftToNumbers(d: Draft) {
  return {
    monthlyTokenBudget: Math.max(0, Number(d.monthlyTokenBudget) || 0),
    oneTimeTokenBudget: Math.max(0, Number(d.oneTimeTokenBudget) || 0),
    rpmLimit: Math.max(0, Number(d.rpmLimit) || 0),
    maxConcurrent: Math.max(0, Number(d.maxConcurrent) || 0),
  };
}

function splitList(s: string): string[] {
  return s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

export default function ApiKey() {
  const [keys, setKeys] = useState<ApiKeyDTO[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [legacySource, setLegacySource] = useState("env");
  const [fromEnv, setFromEnv] = useState(false);
  const [showActiveKey, setShowActiveKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [showSecrets, setShowSecrets] = useState<Record<number, string>>({});
  const [revealInFlight, setRevealInFlight] = useState<Record<number, boolean>>({});
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const { message, setMessage: setTimedMessage, clearMessage } = useTimedMessage<string>(null, 4000);
  const { message: copiedId, setMessage: setCopiedId } = useTimedMessage<number | null>(null, 2000);
  const [filters, setFilters] = useState({ providers: "", models: "" });

  function notify(text: string) {
    setTimedMessage(text);
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchApiKeys();
      setKeys(res.keys);
      setActiveKey(res.legacy.activeKey || "");
      setLegacySource(res.legacy.source);
      setFromEnv(res.legacy.fromEnv);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function setField<K extends keyof Draft>(k: K, v: string) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  async function handleCreate() {
    if (!draft.name.trim()) {
      notify("Name is required");
      return;
    }
    try {
      const res = await createApiKey({
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        ...draftToNumbers(draft),
        allowedProviders: splitList(draft.allowedProviders),
        deniedProviders: splitList(draft.deniedProviders),
        allowedModels: splitList(draft.allowedModels),
        deniedModels: splitList(draft.deniedModels),
      });
      setDraft(emptyDraft);
      setShowSecrets((s) => ({ ...s, [res.id]: res.key }));
      await load();
      notify(`Key created — copy now: sk-${res.keyPrefix.slice(7)}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggle(key: ApiKeyDTO) {
    try {
      await setApiKeyEnabled(key.id, !key.enabled);
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRevoke(key: ApiKeyDTO) {
    if (!confirm(`Revoke "${key.name}"? Existing requests with this key stop immediately.`)) return;
    try {
      await revokeApiKey(key.id);
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(key: ApiKeyDTO) {
    if (!confirm(`DELETE "${key.name}" permanently? Usage history ikut hilang. Tak bisa undo.`)) return;
    try {
      await deleteApiKeyPermanent(key.id);
      await load();
      notify(`Key "${key.name}" dihapus.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }
  async function handleRegenerate(key: ApiKeyDTO) {
    if (!confirm(`Regenerate "${key.name}"? Old secret stops working.`)) return;
    try {
      const res = await regenerateApiKeyById(key.id);
      setShowSecrets((s) => ({ ...s, [res.id]: res.key }));
      await load();
      notify("New secret generated — copy now.");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleReveal(key: ApiKeyDTO) {
    if (showSecrets[key.id]) return;
    setRevealInFlight((r) => ({ ...r, [key.id]: true }));
    try {
      const res = await revealApiKeySecret(key.id);
      setShowSecrets((s) => ({ ...s, [key.id]: res.key }));
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setRevealInFlight((r) => ({ ...r, [key.id]: false }));
    }
  }

  function handleCopy(key: ApiKeyDTO) {
    const secret = showSecrets[key.id];
    if (!secret) return;
    navigator.clipboard.writeText(secret);
    setCopiedId(key.id);
  }

  async function handleSaveSlug(key: ApiKeyDTO) {
    try {
      const slugInput = showSecrets[key.id] ? undefined : undefined;
      void slugInput;
      await updateApiKey(key.id, {});
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleShareToggle(key: ApiKeyDTO) {
    try {
      if (key.shareEnabled) {
        await disableShare(key.id);
        setShareUrl(null);
      } else {
        const res = await enableShare(key.id);
        const slug = (res.shareUrl || "").split("/").pop() || key.shareSlug;
        setShareUrl(`${window.location.origin}/s/${slug}`);
        setShowSecrets((s) => {
          const next = { ...s };
          delete next[key.id];
          return next;
        });
      }
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }

  function copyShareUrl() {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    setCopiedId(-1);
  }

  const filteredKeys = keys.filter((k) => {
    const p = filters.providers.trim().toLowerCase();
    const m = filters.models.trim().toLowerCase();
    if (p && !k.allowedProviders.some((x) => x.toLowerCase().includes(p)) &&
        !k.deniedProviders.some((x) => x.toLowerCase().includes(p))) return false;
    if (m && !k.allowedModels.some((x) => x.toLowerCase().includes(m)) &&
        !k.deniedModels.some((x) => x.toLowerCase().includes(m))) return false;
    return true;
  });

  const budgetCell = (k: ApiKeyDTO, budget: number, used: number) => (
    <span className="tabular-nums">
      {budget > 0 ? `${used.toLocaleString()} / ${budget.toLocaleString()}` : "unlimited"}
    </span>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="API Keys"
        meta={
          <>
            <span>{keys.length} key{keys.length === 1 ? "" : "s"}</span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span>legacy source {legacySource}</span>
          </>
        }
        actions={<Button size="sm" onClick={load}>Refresh</Button>}
      />

      {(message || shareUrl) && (
        <div className="space-y-2">
          {message && (
            <p className="border-l-2 border-[var(--info)] bg-[var(--info)]/8 px-3 py-2 font-mono text-[11px] text-[var(--foreground)]">
              {message}
            </p>
          )}
          {shareUrl && (
            <div className="flex items-center gap-2 border-l-2 border-[var(--primary)] bg-[var(--primary)]/8 px-3 py-2 font-mono text-[11px]">
              <Link2 className="w-3.5 h-3.5" />
              <span className="truncate text-[var(--muted-foreground)]">{shareUrl}</span>
              <Button size="sm" variant="outline" onClick={copyShareUrl}>
                {copiedId === -1 ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Copy
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Active (legacy .env / saved) key — what requests actually use */}
      <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
        <div className="border-b border-[var(--border)] px-4 py-3">
          <h2 className="eyebrow flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" /> Active key
            <span className="ml-1 rounded-sm bg-[var(--sunken)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
              {fromEnv ? "from .env" : `saved in DB (${legacySource})`}
            </span>
          </h2>
        </div>
        <div className="px-4 py-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showActiveKey ? "text" : "password"}
                value={activeKey}
                readOnly
                className="pr-9 font-mono"
                aria-label="Active proxy API key"
              />
              <button
                onClick={() => setShowActiveKey((s) => !s)}
                className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-sm text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:text-[var(--foreground)]"
                aria-label={showActiveKey ? "Hide key" : "Show key"}
              >
                {showActiveKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                navigator.clipboard.writeText(activeKey);
                setCopiedId(-2);
              }}
              title="Copy key"
              aria-label="Copy key"
            >
              {copiedId === -2 ? <Check className="w-4 h-4 text-[var(--success)]" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
          <p className="mt-2.5 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
            This is the key the pool accepts from API_KEY (.env) or the saved setting — the "primary" credential
            for /v1 proxy requests. Other encrypted keys (sk-etteum-*) are listed below with their own limits and ACL.
          </p>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* Create */}
        <Card className="overflow-hidden shadow-[var(--shadow-raised)] self-start">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <h2 className="eyebrow flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" /> New key
            </h2>
          </div>
          <div className="space-y-2.5 px-4 py-4">
            <div>
              <label className="eyebrow mb-1 block" htmlFor="n-name">Name</label>
              <Input id="n-name" value={draft.name} onChange={(e) => setField("name", e.target.value)} placeholder="e.g. production-cli" />
            </div>
            <div>
              <label className="eyebrow mb-1 block" htmlFor="n-desc">Description</label>
              <Input id="n-desc" value={draft.description} onChange={(e) => setField("description", e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="eyebrow mb-1 block" htmlFor="n-monthly">Monthly token budget</label>
                <Input id="n-monthly" type="number" min={0} value={draft.monthlyTokenBudget} onChange={(e) => setField("monthlyTokenBudget", e.target.value)} />
              </div>
              <div>
                <label className="eyebrow mb-1 block" htmlFor="n-once">One-time budget</label>
                <Input id="n-once" type="number" min={0} value={draft.oneTimeTokenBudget} onChange={(e) => setField("oneTimeTokenBudget", e.target.value)} />
              </div>
              <div>
                <label className="eyebrow mb-1 block" htmlFor="n-rpm">RPM limit</label>
                <Input id="n-rpm" type="number" min={0} value={draft.rpmLimit} onChange={(e) => setField("rpmLimit", e.target.value)} />
              </div>
              <div>
                <label className="eyebrow mb-1 block" htmlFor="n-conc">Max concurrent</label>
                <Input id="n-conc" type="number" min={0} value={draft.maxConcurrent} onChange={(e) => setField("maxConcurrent", e.target.value)} />
              </div>
            </div>
            <div>
              <label className="eyebrow mb-1 block" htmlFor="n-allow-p">Allowed providers (comma/space)</label>
              <Input id="n-allow-p" className="font-mono text-[11px]" value={draft.allowedProviders} onChange={(e) => setField("allowedProviders", e.target.value)} placeholder="codebuddy claude byok" />
            </div>
            <div>
              <label className="eyebrow mb-1 block" htmlFor="n-deny-p">Denied providers</label>
              <Input id="n-deny-p" className="font-mono text-[11px]" value={draft.deniedProviders} onChange={(e) => setField("deniedProviders", e.target.value)} placeholder="antigravity" />
            </div>
            <div>
              <label className="eyebrow mb-1 block" htmlFor="n-allow-m">Allowed models (substring)</label>
              <Input id="n-allow-m" className="font-mono text-[11px]" value={draft.allowedModels} onChange={(e) => setField("allowedModels", e.target.value)} placeholder="claude-sonnet-4" />
            </div>
            <div>
              <label className="eyebrow mb-1 block" htmlFor="n-deny-m">Denied models</label>
              <Input id="n-deny-m" className="font-mono text-[11px]" value={draft.deniedModels} onChange={(e) => setField("deniedModels", e.target.value)} placeholder="grok-3" />
            </div>
            <Button onClick={handleCreate} size="sm" className="w-full">
              <Plus className="w-3.5 h-3.5" /> Create key
            </Button>
            <p className="font-mono text-[10px] leading-relaxed text-[var(--muted-foreground)]">
              0 = unlimited. New key secret shows once after create — copy before leaving the page.
            </p>
          </div>
        </Card>

        {/* List */}
        <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="eyebrow flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" /> Keys
              </h2>
              <div className="flex gap-2">
                <Input
                  className="w-40 font-mono text-[11px]"
                  placeholder="filter provider"
                  value={filters.providers}
                  onChange={(e) => setFilters((f) => ({ ...f, providers: e.target.value }))}
                />
                <Input
                  className="w-40 font-mono text-[11px]"
                  placeholder="filter model"
                  value={filters.models}
                  onChange={(e) => setFilters((f) => ({ ...f, models: e.target.value }))}
                />
              </div>
            </div>
          </div>
          {loading ? (
            <p className="px-4 py-3 font-mono text-[12px] text-[var(--muted-foreground)]">Loading...</p>
          ) : filteredKeys.length === 0 ? (
            <p className="px-4 py-3 font-mono text-[12px] text-[var(--muted-foreground)]">No keys yet — create one on the left.</p>
          ) : (
            <div className="max-h-[calc(100vh-16rem)] overflow-auto divide-y divide-[var(--border)]">
              {filteredKeys.map((k) => (
                <div key={k.id} className={`px-4 py-3 ${!k.enabled ? "opacity-60" : ""}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-[12px] font-medium text-[var(--foreground)]">{k.name}</span>
                        {k.revokedAt && <span className="rounded-sm bg-[var(--error)]/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--error)]">revoked</span>}
                        {!k.enabled && !k.revokedAt && <span className="rounded-sm bg-[var(--warning)]/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--warning)]">disabled</span>}
                        {k.shareEnabled && <span className="rounded-sm bg-[var(--primary)]/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--primary)]">shared</span>}
                      </div>
                      {k.description && <p className="mt-0.5 truncate text-[11px] text-[var(--muted-foreground)]">{k.description}</p>}
                      <div className="mt-1 flex items-center gap-1.5">
                        <code className="font-mono text-[11px] text-[var(--muted-foreground)]">{k.keyPrefix}</code>
                        {showSecrets[k.id] ? (
                          <span className="flex items-center gap-1 font-mono text-[11px] text-[var(--success)]">
                            <Lock className="w-3 h-3" />
                            revealed
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-[var(--muted-foreground)]">
                        <span>monthly {budgetCell(k, k.monthlyTokenBudget, 0)}</span>
                        <span>once {budgetCell(k, k.oneTimeTokenBudget, 0)}</span>
                        <span>rpm {k.rpmLimit > 0 ? k.rpmLimit : "∞"}</span>
                        <span>concurrent {k.maxConcurrent > 0 ? k.maxConcurrent : "∞"}</span>
                        <span>{k.allowedProviders.length ? `providers: +${k.allowedProviders.join(",")}` : "all providers"}</span>
                        <span>{k.allowedModels.length ? `models: ${k.allowedModels.join(",")}` : "all models"}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {showSecrets[k.id] && (
                        <Button variant="outline" size="icon" title="Copy secret" onClick={() => handleCopy(k)}>
                          {copiedId === k.id ? <Check className="w-3.5 h-3.5 text-[var(--success)]" /> : <Copy className="w-3.5 h-3.5" />}
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" title="Reveal secret (explicit credential endpoint)" onClick={() => handleReveal(k)} disabled={revealInFlight[k.id]}>
                        <Eye className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" title="Regenerate secret" onClick={() => handleRegenerate(k)}>
                        <RefreshCw className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={k.enabled ? "Disable (stops new requests)" : "Enable"}
                        onClick={() => handleToggle(k)}
                      >
                        <Power className={`w-3.5 h-3.5 ${k.enabled ? "text-[var(--success)]" : "text-[var(--muted-foreground)]"}`} />
                      </Button>
                      <Button variant="ghost" size="icon" title={k.shareEnabled ? "Disable public share page" : "Enable public share page"} onClick={() => handleShareToggle(k)}>
                        <Share2 className={`w-3.5 h-3.5 ${k.shareEnabled ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]"}`} />
                      </Button>
                      <Button variant="ghost" size="icon" title="Revoke key (stops working, row kept)" onClick={() => handleRevoke(k)}>
                        <Ban className="w-3.5 h-3.5 text-[var(--warning)]" />
                      </Button>
                      <Button variant="ghost" size="icon" title="Delete key permanently" onClick={() => handleDelete(k)}>
                        <Trash2 className="w-3.5 h-3.5 text-[var(--error)]" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Request example */}
      <Card>
        <div className="border-b border-[var(--border)] px-4 py-3">
          <h2 className="eyebrow">Usage</h2>
        </div>
        <pre className="overflow-x-auto bg-[var(--sunken)] px-4 py-3 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
{`curl ${API_BASE}/v1/chat/completions \\
  -H "Authorization: Bearer sk-etteum-***" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "ping"}]
  }'`}
        </pre>
      </Card>
    </div>
  );
}