import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import PageHeader from "@/components/layout/PageHeader";
import {
  ArrowRight,
  Copy,
  Check,
  Terminal,
  Zap,
  RefreshCw,
  Code,
  Box,
  Hammer,
  PawPrint,
} from "lucide-react";
import ModelCombobox from "@/components/ModelCombobox";
import {
  fetchIntegration,
  saveIntegration,
  fetchApiKey,
  applyIntegrationConfig,
  fetchIntegrationClients,
  applyClientConfig,
  applyAllClients,
  restoreClientConfig,
  saveClientSelectedModels,
  API_BASE,
  type ModelMappingDTO,
  type ClientMetaDTO,
  type IntegrationModelDTO,
} from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useWsEvent } from "@/hooks/useWebSocket";
import { ClientCard } from "@/components/integration/ClientCard";

// Claude Code only ever calls these three model classes.
const CLAUDE_CODE_SLOTS = [
  { source: "haiku", title: "Haiku", desc: "small / fast / background tasks" },
  { source: "sonnet", title: "Sonnet", desc: "main coding model" },
  { source: "opus", title: "Opus", desc: "heavy reasoning" },
] as const;

export default function Integration() {
  const [enabled, setEnabled] = useState(true);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [models, setModels] = useState<
    { id: string; owned_by: string }[]
  >([]);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [clients, setClients] = useState<ClientMetaDTO[]>([]);
  const [integrationModels, setIntegrationModels] = useState<
    IntegrationModelDTO[]
  >([]);
  const [activeTab, setActiveTab] = useState("claude");
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const baseUrl = API_BASE;
  const defaultModel = "cb-sonnet-4.6";

  // Per-client model selection
  const [clientModels, setClientModels] = useState<Record<string, string>>({
    opencode: "cb-sonnet-4.6",
    codex: "codex-auto",
    hermes: "cb-sonnet-4.6",
    openclaw: "cb-sonnet-4.6",
    kilo: "cb-sonnet-4.6",
  });

  // Per-client subset of models to include in the generated config.
  // Default: all models selected (null from server → all model IDs).
  const [clientSelectedModels, setClientSelectedModels] = useState<
    Record<string, string[]>
  >({});

  const load = useCallback(async () => {
    try {
      const [data, keyRes] = await Promise.all([
        fetchIntegration(),
        fetchApiKey().catch(() => null),
      ]);
      setEnabled(data.enabled);
      setModels(data.models || []);

      const next: Record<string, string> = {};
      for (const slot of CLAUDE_CODE_SLOTS) {
        const found = (data.mappings || []).find(
          (m) => m.sourcePattern.toLowerCase() === slot.source
        );
        next[slot.source] = found?.targetModel || "";
      }
      setTargets(next);
      if (keyRes?.key) setApiKey(keyRes.key);
    } catch (e: any) {
      setMessage(e.message || "Failed to load integration settings");
    } finally {
      setLoading(false);
    }
  }, [setMessage]);

  const loadClients = useCallback(async () => {
    try {
      const data = await fetchIntegrationClients();
      setClients(data.clients || []);
      setIntegrationModels(data.models || []);
      // Initialise per-client selected models. `null` (not yet saved) → all models.
      const allModelIds = (data.models || []).map((m) => m.id);
      const init: Record<string, string[]> = {};
      for (const c of data.clients || []) {
        const sel = data.clientModelSelections?.[c.id];
        init[c.id] = sel ?? allModelIds;
      }
      setClientSelectedModels(init);
    } catch (e: any) {
      console.error("Failed to load clients:", e);
    }
  }, []);

  useEffect(() => {
    load();
    loadClients();
  }, [load, loadClients]);
  useWsEvent(["model_mappings_updated"], load);

  const handleSave = async () => {
    setSaving(true);
    try {
      const mappings: ModelMappingDTO[] = CLAUDE_CODE_SLOTS.map((slot, i) => ({
        sourcePattern: slot.source,
        matchType: "contains",
        targetModel: targets[slot.source] || "",
        enabled: Boolean(targets[slot.source]),
        priority: i,
        label: `Claude Code · ${slot.title}`,
      }));
      await saveIntegration({ enabled, mappings });
      setMessage("Saved");
    } catch (e: any) {
      setMessage(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleApplyConfig = async () => {
    setApplying(true);
    try {
      await applyIntegrationConfig(baseUrl);
      setMessage("Applied configuration to ~/.claude/settings.json");
    } catch (e: any) {
      setMessage(e.message || "Failed to apply configuration");
    } finally {
      setApplying(false);
    }
  };

  const handleApplyClient = async (clientId: string, model: string) => {
    await applyClientConfig(clientId, baseUrl, model, clientSelectedModels[clientId]);
    await loadClients();
  };

  const handleRestoreClient = async (clientId: string) => {
    await restoreClientConfig(clientId);
    await loadClients();
  };

  /** Toggle a model in a client's subset selection. */
  const handleToggleModel = (clientId: string, modelId: string) => {
    setClientSelectedModels((prev) => {
      const cur = prev[clientId] ?? [];
      const next = cur.includes(modelId)
        ? cur.filter((m) => m !== modelId)
        : [...cur, modelId];
      return { ...prev, [clientId]: next };
    });
  };

  /** Persist the subset selection for a client to the database. */
  const handleSaveSelectedModels = async (clientId: string) => {
    try {
      await saveClientSelectedModels(clientId, clientSelectedModels[clientId] ?? []);
      setMessage(`Model selection saved for ${clientId}`);
    } catch (e: any) {
      setMessage(e.message || "Failed to save model selection");
    }
  };

  /** Apply config to all detected clients, each with its own subset. */
  const handleApplyAllClients = async () => {
    setApplying(true);
    try {
      await applyAllClients(baseUrl, undefined, clientSelectedModels);
      setMessage("Applied configuration to all detected clients");
      await loadClients();
    } catch (e: any) {
      setMessage(e.message || "Failed to apply all configurations");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Integration"
        meta={
          clients.length > 0 ? (
            <>
              <span className={clients.some((c) => c.detected) ? "text-[var(--success-text)]" : undefined}>
                {clients.filter((c) => c.detected).length} detected
              </span>
              <span aria-hidden className="text-[var(--border)]">·</span>
              <span>{clients.length} clients</span>
            </>
          ) : (
            <span>no clients scanned</span>
          )
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={handleApplyAllClients}
            disabled={applying || clients.length === 0}
          >
            {applying ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Zap className="w-3.5 h-3.5" />
            )}
            Apply all
          </Button>
        }
      />

      {message && (
        <p
          role="status"
          className="border-l-2 border-[var(--primary)] bg-[var(--secondary)]/50 px-3 py-2 font-mono text-meta text-[var(--foreground)]"
        >
          {message}
        </p>
      )}

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="claude" className="gap-1.5">
            <Terminal className="w-3.5 h-3.5" /> Claude
          </TabsTrigger>
          <TabsTrigger value="opencode" className="gap-1.5">
            <Code className="w-3.5 h-3.5" /> OpenCode
          </TabsTrigger>
          <TabsTrigger value="codex" className="gap-1.5">
            <Box className="w-3.5 h-3.5" /> Codex
          </TabsTrigger>
          <TabsTrigger value="hermes" className="gap-1.5">
            <Hammer className="w-3.5 h-3.5" /> Hermes
          </TabsTrigger>
          <TabsTrigger value="openclaw" className="gap-1.5">
            <PawPrint className="w-3.5 h-3.5" /> OpenClaw
          </TabsTrigger>
          <TabsTrigger value="kilo" className="gap-1.5">
            <Zap className="w-3.5 h-3.5" /> Kilo
          </TabsTrigger>
        </TabsList>

        {/* ── Claude Tab ──────────────────────────────────────── */}
        <TabsContent value="claude" className="space-y-4">
          <Card>
            <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-4 py-3">
              <Terminal className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
              <h2 className="eyebrow">the assistant Setup</h2>
            </div>
            <div className="space-y-3 px-4 py-3">
              <p className="font-mono text-body leading-relaxed text-[var(--muted-foreground)]">
                Point the assistant at this proxy. Sets{" "}
                <span className="text-[var(--foreground)]">ANTHROPIC_BASE_URL</span> and{" "}
                <span className="text-[var(--foreground)]">ANTHROPIC_AUTH_TOKEN</span> in{" "}
                <span className="text-[var(--foreground)]">~/.claude/settings.json</span>.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <CodeRow label="ANTHROPIC_BASE_URL" value={baseUrl} />
                <CodeRow label="ANTHROPIC_AUTH_TOKEN" value={apiKey || "<YOUR_API_KEY>"} />
              </div>
              <Button onClick={handleApplyConfig} disabled={applying}>
                {applying ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                Apply Config
              </Button>
            </div>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
              <h2 className="eyebrow flex items-center gap-1.5">
                <ArrowRight className="h-3.5 w-3.5" /> Model Mapping
              </h2>
              <div className="flex items-center gap-3">
                <label className="flex cursor-pointer select-none items-center gap-2 font-mono text-meta text-[var(--muted-foreground)]">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                    className="h-3.5 w-3.5 cursor-pointer accent-[var(--primary)]"
                  />
                  Enable mapping
                </label>
                <Button variant="outline" size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
            {loading ? (
              <p className="px-4 py-3 font-mono text-body text-[var(--muted-foreground)]">Loading…</p>
            ) : (
              <div>
                {CLAUDE_CODE_SLOTS.map((slot) => (
                  <div key={slot.source} className="flex flex-col gap-2 border-t border-[var(--hairline)] px-4 py-2.5 first:border-t-0 sm:flex-row sm:items-center">
                    <div className="shrink-0 sm:w-48">
                      <div className="font-mono text-body text-[var(--foreground)]">{slot.title}</div>
                      <div className="font-mono text-meta text-[var(--muted-foreground)]">{slot.desc}</div>
                    </div>
                    <ArrowRight className="hidden h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)] sm:block" />
                    <ModelCombobox
                      value={targets[slot.source] || ""}
                      options={models}
                      onChange={(id) => setTargets((t) => ({ ...t, [slot.source]: id }))}
                    />
                  </div>
                ))}
              </div>
            )}
            <p className="border-t border-[var(--border)] px-4 py-2.5 font-mono text-meta text-[var(--muted-foreground)]">
              Leave "pass through" to keep original behavior. Changes apply after Save.
            </p>
          </Card>
        </TabsContent>

        {/* ── OpenCode Tab ────────────────────────────────────── */}
        <TabsContent value="opencode" className="space-y-4">
          {clients.filter((c) => c.id === "opencode").map((c) => (
            <ClientCard key={c.id} client={c} baseUrl={baseUrl} apiKey={apiKey}
              model={clientModels.opencode || defaultModel} models={integrationModels}
              showPreview
              selectedModels={clientSelectedModels.opencode ?? []}
              onToggleModel={(mid) => handleToggleModel("opencode", mid)}
              onSaveModels={() => handleSaveSelectedModels("opencode")}
              onModelChange={(m) => setClientModels((p) => ({ ...p, opencode: m }))}
              onApply={handleApplyClient} onRestore={handleRestoreClient} />
          ))}
        </TabsContent>

        {/* ── Codex Tab ───────────────────────────────────────── */}
        <TabsContent value="codex" className="space-y-4">
          {clients.filter((c) => c.id === "codex").map((c) => (
            <ClientCard key={c.id} client={c} baseUrl={baseUrl} apiKey={apiKey}
              model={clientModels.codex || "codex-auto"} models={integrationModels}
              showPreview={false}
              selectedModels={clientSelectedModels.codex ?? []}
              onToggleModel={(mid) => handleToggleModel("codex", mid)}
              onSaveModels={() => handleSaveSelectedModels("codex")}
              onModelChange={(m) => setClientModels((p) => ({ ...p, codex: m }))}
              onApply={handleApplyClient} onRestore={handleRestoreClient} />
          ))}
        </TabsContent>

        {/* ── Hermes Tab ──────────────────────────────────────── */}
        <TabsContent value="hermes" className="space-y-4">
          {clients.filter((c) => c.id === "hermes").map((c) => (
            <ClientCard key={c.id} client={c} baseUrl={baseUrl} apiKey={apiKey}
              model={clientModels.hermes || defaultModel} models={integrationModels}
              showPreview={false}
              selectedModels={clientSelectedModels.hermes ?? []}
              onToggleModel={(mid) => handleToggleModel("hermes", mid)}
              onSaveModels={() => handleSaveSelectedModels("hermes")}
              onModelChange={(m) => setClientModels((p) => ({ ...p, hermes: m }))}
              onApply={handleApplyClient} onRestore={handleRestoreClient} />
          ))}
        </TabsContent>

        {/* ── OpenClaw Tab ────────────────────────────────────── */}
        <TabsContent value="openclaw" className="space-y-4">
          {clients.filter((c) => c.id === "openclaw").map((c) => (
            <ClientCard key={c.id} client={c} baseUrl={baseUrl} apiKey={apiKey}
              model={clientModels.openclaw || defaultModel} models={integrationModels}
              showPreview
              selectedModels={clientSelectedModels.openclaw ?? []}
              onToggleModel={(mid) => handleToggleModel("openclaw", mid)}
              onSaveModels={() => handleSaveSelectedModels("openclaw")}
              onModelChange={(m) => setClientModels((p) => ({ ...p, openclaw: m }))}
              onApply={handleApplyClient} onRestore={handleRestoreClient} />
          ))}
        </TabsContent>

        {/* ── Kilo Tab ────────────────────────────────────────── */}
        <TabsContent value="kilo" className="space-y-4">
          {clients.filter((c) => c.id === "kilo").map((c) => (
            <ClientCard key={c.id} client={c} baseUrl={baseUrl} apiKey={apiKey}
              model={clientModels.kilo || defaultModel} models={integrationModels}
              showPreview
              selectedModels={clientSelectedModels.kilo ?? []}
              onToggleModel={(mid) => handleToggleModel("kilo", mid)}
              onSaveModels={() => handleSaveSelectedModels("kilo")}
              onModelChange={(m) => setClientModels((p) => ({ ...p, kilo: m }))}
              onApply={handleApplyClient} onRestore={handleRestoreClient} />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Inline copyable code row */
function CodeRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <label className="eyebrow mb-1 block">
        {label}
      </label>
      <div className="flex items-center gap-2 rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2">
        <code className="flex-1 truncate font-mono text-body text-[var(--foreground)]">
          {value}
        </code>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard unavailable */
            }
          }}
          className="p-1.5 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)] transition-colors shrink-0 cursor-pointer"
          title="Copy"
          aria-label={`Copy ${label}`}
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-[var(--success-text)]" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
