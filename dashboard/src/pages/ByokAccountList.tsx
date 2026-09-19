import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import PageHeader from "@/components/layout/PageHeader";
import { ArrowLeft, Download, Eye, EyeOff, FlaskConical, Key, Plus, RefreshCw, Save, Trash2, Zap } from "lucide-react";
import {
  deleteAccount,
  fetchByokModels,
  fetchByokProviders,
  revealByokKey,
  testByokProvider,
  toggleAccountEnabled,
  updateByokProvider,
  type ByokKeyInfo,
  type ByokProvider,
} from "@/lib/api";
import { formatDateTimeID } from "@/lib/utils";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useWsEvent } from "@/hooks/useWebSocket";

type LbMethod = "round_robin" | "sequential" | "least_inflight";
type ApiFormat = "openai" | "anthropic" | "auto";

type KeyDraft = {
  id?: number;
  label: string;
  key: string;
  enabled: boolean;
  status?: string;
  errorMessage?: string | null;
};

const MASK = "••••••••";

function emptyKey(index = 0): KeyDraft {
  return { label: index === 0 ? "default" : `key-${index + 1}`, key: "", enabled: true };
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return formatDateTimeID(value);
}

function lbLabel(method?: string) {
  if (method === "sequential") return "Sequential";
  if (method === "least_inflight") return "Least in-flight";
  return "Round Robin";
}

export default function ByokAccountList() {
  const { prefix } = useParams<{ prefix: string }>();
  const navigate = useNavigate();
  const [provider, setProvider] = useState<ByokProvider | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingKey, setTestingKey] = useState<number | null>(null);
  /** Per-key inline test result, keyed by key id. */
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; latency?: number; error?: string }>>({});
  /** Per-model inline test result, keyed by model id. */
  const [modelTestResults, setModelTestResults] = useState<Record<string, { state: "testing" | "ok" | "error"; latency?: number; error?: string }>>({});
  const [fetchingModels, setFetchingModels] = useState(false);
  const [revealingKey, setRevealingKey] = useState<string | null>(null);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const { message, setMessage, clearMessage } = useTimedMessage<string>(null, 4000);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    base_url: "",
    format: "auto" as ApiFormat,
    load_balancing_method: "round_robin" as LbMethod,
    models: "",
    keys: [emptyKey()] as KeyDraft[],
  });

  function showSuccess(text: string) { setMessage(text); setError(null); }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); clearMessage(); }

  async function load() {
    if (!prefix) return;
    setLoading(true);
    try {
      const res = await fetchByokProviders();
      const found = (res.providers || []).find((p) => p.label === prefix);
      if (!found) {
        setProvider(null);
        setError(`BYOK provider "${prefix}" not found`);
        return;
      }
      setProvider(found);
      setForm({
        base_url: found.base_url || "",
        format: found.format || "auto",
        load_balancing_method: found.load_balancing_method || "round_robin",
        models: (found.models || []).join(", "),
        keys: (found.keys && found.keys.length > 0)
          ? found.keys.map((key) => ({
              id: key.id,
              label: key.label,
              key: MASK,
              enabled: key.enabled !== false,
              status: key.status,
              errorMessage: key.errorMessage,
            }))
          : [emptyKey()],
      });
    } catch (err) {
      showError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [prefix]);
  useWsEvent(["byok_created", "byok_updated", "byok_deleted", "account_status", "account_deleted"], load);

  const models = useMemo(() => form.models.split(",").map((m) => m.trim()).filter(Boolean), [form.models]);
  const activeKeyCount = form.keys.filter((k) => k.enabled && k.status !== "error").length;

  function secretVisibilityId(key: KeyDraft, index: number) {
    return key.id ? `id-${key.id}` : `new-${index}`;
  }

  async function toggleSecretVisibility(key: KeyDraft, index: number) {
    const visibilityId = secretVisibilityId(key, index);
    const isVisible = visibleSecrets.has(visibilityId);

    if (isVisible) {
      setVisibleSecrets((current) => {
        const next = new Set(current);
        next.delete(visibilityId);
        return next;
      });
      return;
    }

    if (key.id && key.key === MASK) {
      setRevealingKey(visibilityId);
      try {
        const revealed = await revealByokKey(key.id);
        updateKey(index, { key: revealed.key });
      } catch (err) {
        showError(err);
        setRevealingKey(null);
        return;
      }
      setRevealingKey(null);
    }

    setVisibleSecrets((current) => {
      const next = new Set(current);
      next.add(visibilityId);
      return next;
    });
  }

  function updateKey(index: number, patch: Partial<KeyDraft>) {
    setForm((current) => ({
      ...current,
      keys: current.keys.map((key, i) => i === index ? { ...key, ...patch } : key),
    }));
  }

  function addKey() {
    setForm((current) => ({ ...current, keys: [...current.keys, emptyKey(current.keys.length)] }));
  }

  async function removeKey(index: number) {
    const key = form.keys[index];
    if (!key) return;
    if (key.id) {
      if (!confirm(`Delete API key "${key.label}"?`)) return;
      try {
        await deleteAccount(key.id);
        showSuccess(`Deleted key ${key.label}`);
        await load();
      } catch (err) { showError(err); }
      return;
    }
    setForm((current) => ({
      ...current,
      keys: current.keys.length <= 1 ? [emptyKey()] : current.keys.filter((_, i) => i !== index),
    }));
  }

  function buildPayloadKeys() {
    return form.keys.map((key, index) => ({
      id: key.id,
      label: key.label.trim().toLowerCase() || `key-${index + 1}`,
      key: key.key && key.key !== MASK ? key.key.trim() : undefined,
      enabled: key.enabled,
      priority: index,
    })).filter((key) => key.id || key.key);
  }

  async function saveSettings() {
    if (!provider) return;
    if (!form.base_url.trim()) return showError(new Error("Base URL is required"));
    if (models.length === 0) return showError(new Error("At least one model is required"));
    const apiKeys = buildPayloadKeys();
    if (apiKeys.length === 0) return showError(new Error("At least one API key is required"));

    setSaving(true);
    try {
      await updateByokProvider(provider.id, {
        base_url: form.base_url.trim(),
        format: form.format,
        load_balancing_method: form.load_balancing_method,
        models,
        api_keys: apiKeys,
      });
      showSuccess("BYOK provider saved");
      await load();
    } catch (err) {
      showError(err);
    } finally {
      setSaving(false);
    }
  }

  async function toggleKey(key: KeyDraft, index: number) {
    const next = !key.enabled;
    updateKey(index, { enabled: next });
    if (!key.id) return;
    try {
      await toggleAccountEnabled(key.id, next);
      showSuccess(next ? `Enabled ${key.label}` : `Disabled ${key.label}`);
      await load();
    } catch (err) {
      updateKey(index, { enabled: key.enabled });
      showError(err);
    }
  }

  async function testKey(key: KeyDraft) {
    if (!key.id) return showError(new Error("Save this key before testing"));
    setTestingKey(key.id);
    try {
      const res = await testByokProvider(key.id);
      setTestResults((m) => ({
        ...m,
        [key.id!]: res.success
          ? { ok: true, latency: res.latency_ms }
          : { ok: false, error: res.error || "Connection test failed" },
      }));
      if (res.success) showSuccess(`✓ ${key.label} OK${res.latency_ms ? ` · ${res.latency_ms}ms` : ""}`);
      else showError(new Error(res.error || "Connection test failed"));
      await load();
    } catch (err) {
      if (key.id) setTestResults((m) => ({ ...m, [key.id!]: { ok: false, error: err instanceof Error ? err.message : "Connection test failed" } }));
      showError(err);
    } finally {
      setTestingKey(null);
    }
  }

  async function testAll() {
    for (const key of form.keys) {
      if (key.id) await testKey(key);
    }
  }

  async function testModel(model: string) {
    if (!provider) return;
    setModelTestResults((m) => ({ ...m, [model]: { state: "testing" } }));
    try {
      const res = await testByokProvider(provider.id, model);
      setModelTestResults((m) => ({
        ...m,
        [model]: res.success
          ? { state: "ok", latency: res.latency_ms }
          : { state: "error", error: res.error || "Test failed" },
      }));
      if (res.auto_fixed) load();
    } catch (err) {
      setModelTestResults((m) => ({
        ...m,
        [model]: { state: "error", error: err instanceof Error ? err.message : "Test failed" },
      }));
    }
  }

  /** Resolve a usable API key secret for fetch-models (reveals masked keys when needed). */
  async function firstUsableKey(): Promise<string | null> {
    for (const key of form.keys) {
      if (key.key && key.key !== MASK) return key.key.trim();
      if (key.id && key.key === MASK) {
        const revealed = await revealByokKey(key.id);
        if (revealed.key) return revealed.key.trim();
      }
    }
    return null;
  }

  async function fetchModels() {
    if (!form.base_url.trim()) return showError(new Error("Base URL is required"));
    const apiKey = await firstUsableKey();
    if (!apiKey) return showError(new Error("At least one API key is required"));
    setFetchingModels(true);
    setError(null);
    try {
      const res = await fetchByokModels({
        base_url: form.base_url.trim(),
        api_key: apiKey,
        format: form.format,
      });
      if (res.error) return showError(new Error(res.error));
      const existing = new Set(models);
      const added = (res.models || []).filter((m) => !existing.has(m));
      if (added.length > 0) {
        setForm((f) => ({ ...f, models: [...new Set([...models, ...added])].join(", ") }));
        showSuccess(`Fetched ${res.models.length} models — added ${added.length} new`);
      } else {
        showSuccess(`Fetched ${res.models.length} models — all already configured`);
      }
    } catch (err) {
      showError(err);
    } finally {
      setFetchingModels(false);
    }
  }

  if (loading && !provider) {
    return (
      <div>
        <p className="px-4 py-3 font-mono text-body text-[var(--muted-foreground)]">Loading BYOK provider...</p>
      </div>
    );
  }

  // Chips: models from the textarea (live) + models discovered via /models.
  const configuredModels = new Set(form.models.split(",").map((m) => m.trim()).filter(Boolean));
  const modelChips = provider
    ? [...new Set([...configuredModels, ...(provider.available_models || [])])]
    : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={`BYOK · ${prefix}`}
        meta={
          <>
            <span>{form.keys.length} keys</span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span className={activeKeyCount > 0 ? "text-[var(--success-text)]" : undefined}>{activeKeyCount} enabled</span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span>{models.length} models</span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span>{lbLabel(form.load_balancing_method)}</span>
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
            <Button variant="outline" size="sm" onClick={testAll} disabled={testingKey !== null || form.keys.every((k) => !k.id)}>
              <FlaskConical className="w-3.5 h-3.5" /> Test all
            </Button>
            <Button size="sm" onClick={saveSettings} disabled={saving}>
              <Save className="w-3.5 h-3.5" /> {saving ? "Saving…" : "Save"}
            </Button>
          </>
        }
      />

      {(message || error) && (
        <p
          role="status"
          className={`border-l-2 px-3 py-2 font-mono text-meta ${message ? "border-[var(--success)] bg-[var(--success)]/8 text-[var(--success-text)]" : "border-[var(--error)] bg-[var(--error)]/8 text-[var(--error-text)]"}`}
        >
          {message || error}
        </p>
      )}

      <Card>
        <div className="border-b border-[var(--border)] px-4 py-3">
          <h2 className="eyebrow">Provider Settings</h2>
        </div>
        <div className="space-y-3 px-4 py-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="eyebrow mb-1.5 block">Provider Prefix</label>
              <Input value={prefix || ""} readOnly className="font-mono bg-[var(--muted)] opacity-70" />
            </div>
            <div>
              <label className="eyebrow mb-1.5 block">Base URL</label>
              <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.provider.com/v1" className="font-mono" />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="eyebrow mb-1.5 block">API Format</label>
              <Select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value as ApiFormat })}>
                <option value="auto">Auto-detect</option>
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic</option>
              </Select>
            </div>
            <div>
              <label className="eyebrow mb-1.5 block">Load Balancing</label>
              <Select value={form.load_balancing_method} onChange={(e) => setForm({ ...form, load_balancing_method: e.target.value as LbMethod })}>
                <option value="round_robin">Round Robin</option>
                <option value="sequential">Sequential</option>
              </Select>
              <p className="mt-1.5 font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">Round Robin rotates keys. Sequential prioritizes the first healthy key in table order.</p>
            </div>
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label className="eyebrow">Models</label>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={fetchModels} disabled={fetchingModels} title="Fetch model list from this base URL + API key">
                  {fetchingModels ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  {fetchingModels ? "Fetching..." : "Fetch Models"}
                </Button>
                <p className="font-mono text-micro text-[var(--muted-foreground)]">⚡ to test</p>
              </div>
            </div>
            <textarea value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} className="h-24 w-full resize-none rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-body text-[var(--foreground)] transition-colors duration-150 ease-out placeholder:text-[var(--muted-faint)] hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35" placeholder="gpt-4o, claude-sonnet, llama-3" />
            <p className="mt-1.5 font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">Comma-separated model IDs. Public model IDs become <span className="text-[var(--foreground)]">{prefix || "prefix"}-model</span>.</p>
            {modelChips.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-2">
                {modelChips.map((model) => {
                  const mt = modelTestResults[model];
                  const configured = configuredModels.has(model);
                  return (
                    <span
                      key={model}
                      className={`inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pl-2 pr-1 font-mono text-xs ${
                        mt?.state === "error"
                          ? "border-[var(--error)]/30 bg-[var(--error)]/10 text-[var(--error-text)]"
                          : mt?.state === "ok"
                            ? "border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success-text)]"
                            : configured
                              ? "border-[var(--primary)]/20 bg-[var(--primary)]/[0.05] text-[var(--primary-text)]"
                              : "border-dashed border-[var(--border)] bg-transparent text-[var(--muted-foreground)]"
                      }`}
                      title={mt?.error || (configured ? model : `${model} (discovered, not in routing list)`)}
                    >
                      <span className="truncate">{model}</span>
                      {mt?.state === "ok" && mt.latency != null && (
                        <span className="t-num shrink-0">{mt.latency}ms</span>
                      )}
                      <button
                        type="button"
                        className="shrink-0 cursor-pointer rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
                        aria-label={`Test ${model}`}
                        title={`Test ${model}`}
                        disabled={mt?.state === "testing"}
                        onClick={() => testModel(model)}
                      >
                        {mt?.state === "testing" ? (
                          <RefreshCw className="h-3 w-3 animate-spin" />
                        ) : (
                          <Zap className="h-3 w-3" />
                        )}
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Primary surface: the key table */}
      <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
          <h2 className="eyebrow">API Keys</h2>
          <Button variant="outline" size="sm" onClick={addKey}>
            <Plus className="w-3.5 h-3.5" /> Add Key
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-body">
            <thead className="sticky-head">
              <tr>
                <th className="eyebrow px-4 py-2 text-left">Key Label</th>
                <th className="eyebrow px-4 py-2 text-left">Secret</th>
                <th className="eyebrow px-4 py-2 text-left">Status</th>
                <th className="eyebrow px-4 py-2 text-left">Enabled</th>
                <th className="eyebrow px-4 py-2 text-left">Last Used</th>
                <th className="eyebrow px-4 py-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {form.keys.map((key, index) => {
                const visibilityId = secretVisibilityId(key, index);
                const secretVisible = visibleSecrets.has(visibilityId);
                return (
                <tr key={`${key.id || "new"}-${index}`} className="border-t border-[var(--hairline)] hover:bg-[var(--secondary)]/50 transition-colors duration-150">
                  <td className="px-4 py-2">
                    <Input value={key.label} onChange={(e) => updateKey(index, { label: e.target.value })} className="h-8 min-w-[140px] font-mono text-xs" />
                    {form.load_balancing_method === "sequential" && <div className="mt-1 text-micro text-[var(--muted-foreground)]">Priority #{index + 1}</div>}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex min-w-[260px] items-center gap-1">
                      <Input
                        type={secretVisible ? "text" : "password"}
                        value={key.key}
                        onChange={(e) => updateKey(index, { key: e.target.value })}
                        onFocus={() => { if (key.key === MASK) updateKey(index, { key: "" }); }}
                        placeholder={key.id ? "Keep masked or paste new key" : "sk-..."}
                        className="h-8 font-mono text-xs"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => toggleSecretVisibility(key, index)}
                        disabled={revealingKey === visibilityId}
                        title={secretVisible ? "Hide key" : "Show key"}
                      >
                        {revealingKey === visibilityId ? <RefreshCw className="h-4 w-4 animate-spin" /> : secretVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={key.status === "error" ? "error" : key.status === "active" ? "success" : "secondary"}>{key.status || (key.id ? "active" : "new")}</Badge>
                    {key.errorMessage && <div className="mt-1 max-w-[220px] truncate text-meta text-[var(--error-text)]" title={key.errorMessage}>{key.errorMessage}</div>}
                    {key.id && testResults[key.id] && (
                      <div
                        className={`mt-1 font-mono text-micro tabular-nums ${testResults[key.id].ok ? "text-[var(--success-text)]" : "text-[var(--error-text)]"}`}
                        title={testResults[key.id].error || "Last test result"}
                      >
                        {testResults[key.id].ok
                          ? `✓ ${testResults[key.id].latency ? `${testResults[key.id].latency}ms` : "OK"}`
                          : `✗ ${testResults[key.id].error}`}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={key.enabled}
                      aria-label={`${key.enabled ? "Disable" : "Enable"} key ${key.label}`}
                      onClick={() => toggleKey(key, index)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer ${key.enabled ? "bg-[var(--success)]" : "bg-[var(--secondary)]"}`}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${key.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
                    </button>
                  </td>
                  <td className="px-4 py-2 text-meta tabular-nums text-[var(--muted-foreground)]">{formatDate((provider?.keys || []).find((k: ByokKeyInfo) => k.id === key.id)?.lastUsedAt)}</td>
                  <td className="px-4 py-2">
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => testKey(key)} disabled={testingKey === key.id || !key.id} title="Test key">
                        {testingKey === key.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--info-text)]" /> : <Zap className="w-3.5 h-3.5 text-[var(--info-text)]" />}
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => removeKey(index)} title="Delete key" className="hover:text-[var(--destructive-text)]">
                        <Trash2 className="w-3.5 h-3.5 text-[var(--error-text)]" />
                      </Button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
