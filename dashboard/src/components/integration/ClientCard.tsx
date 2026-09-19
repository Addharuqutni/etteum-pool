import { useState, useEffect, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  ExternalLink,
  RefreshCw,
  Search,
  Zap,
} from "lucide-react";
import type { ClientMetaDTO, IntegrationModelDTO } from "@/lib/api";
import { fetchClientConfigPreview } from "@/lib/api";
import { ConfigPreview } from "./ConfigPreview";

interface ClientCardProps {
  client: ClientMetaDTO;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: IntegrationModelDTO[];
  showPreview?: boolean;
  selectedModels: string[];
  onToggleModel: (modelId: string) => void;
  onSaveModels: () => void;
  onModelChange: (model: string) => void;
  onApply: (clientId: string, model: string) => Promise<void>;
  onRestore: (clientId: string) => Promise<void>;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ } }}
      className="p-1.5 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      title="Copy config path" aria-label="Copy config path">
      {copied ? <Check className="w-3.5 h-3.5 text-[var(--success-text)]" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function StepLabel({ number, title, hint, count }: { number: number; title: string; hint: string; count?: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--primary)]/60 text-micro font-mono font-bold text-[var(--primary-text)]">{number}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-micro font-medium uppercase tracking-eyebrow text-[var(--foreground)]">{title}</span>
          {count && <Badge variant="info" className="px-1.5 py-0 text-micro">{count}</Badge>}
        </div>
        <p className="mt-0.5 text-meta text-[var(--muted-foreground)]">{hint}</p>
      </div>
    </div>
  );
}

export function ClientCard({ client, baseUrl, apiKey: _apiKey, model, models, showPreview, selectedModels, onToggleModel, onSaveModels, onModelChange, onApply, onRestore }: ClientCardProps) {
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [savingModels, setSavingModels] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [previewData, setPreviewData] = useState<Record<string, unknown> | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(true);
  const [modelQuery, setModelQuery] = useState("");
  const [subsetQuery, setSubsetQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const selectedSet = new Set(selectedModels);

  useEffect(() => {
    if (showPreview !== false) {
      setPreviewLoading(true);
      fetchClientConfigPreview(client.id, baseUrl, model, selectedModels)
        .then((data) => { if (data.success && data.preview) setPreviewData(data.preview); })
        .catch(() => {})
        .finally(() => setPreviewLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id, baseUrl, model, showPreview, selectedModels.join(",")]);

  useEffect(() => {
    const close = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setModelOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setModelOpen(false); };
    if (modelOpen) { document.addEventListener("mousedown", close); document.addEventListener("keydown", escape); }
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [modelOpen]);

  const filteredModels = models.filter((m) => !modelQuery.trim() || m.id.toLowerCase().includes(modelQuery.trim().toLowerCase()));
  const filteredSubsetModels = models.filter((m) => !subsetQuery.trim() || m.id.toLowerCase().includes(subsetQuery.trim().toLowerCase()) || m.owned_by.toLowerCase().includes(subsetQuery.trim().toLowerCase()));
  const setStatusFor = (result: { ok: boolean; msg: string }) => { setStatus(result); setTimeout(() => setStatus(null), 3000); };

  const handleApply = async () => { setApplying(true); try { await onApply(client.id, model); setStatusFor({ ok: true, msg: "Configuration applied" }); } catch (e: any) { setStatusFor({ ok: false, msg: e.message || "Failed to apply" }); } finally { setApplying(false); } };
  const handleRestore = async () => { setRestoring(true); try { await onRestore(client.id); setStatusFor({ ok: true, msg: "Previous configuration restored" }); } catch (e: any) { setStatusFor({ ok: false, msg: e.message || "Failed to restore" }); } finally { setRestoring(false); } };
  const handleSaveModels = async () => { setSavingModels(true); try { await onSaveModels(); setStatusFor({ ok: true, msg: "Model selection saved" }); } catch (e: any) { setStatusFor({ ok: false, msg: e.message || "Failed to save models" }); } finally { setSavingModels(false); } };
  const configName = client.configPaths[0]?.split(/[\\/]/).pop() || `${client.id}.json`;

  return (
    <Card className={`overflow-hidden ${!client.detected ? "border-[var(--warning)]/40" : ""}`}>
      {/* Header strip: name, CLI, detection state — same shape as every other panel */}
      <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${client.detected ? "bg-[var(--success)]" : "bg-[var(--warning)]"}`} />
          <div className="min-w-0">
            <h3 className="eyebrow truncate text-[var(--foreground)]">{client.name}</h3>
            <p className="truncate font-mono text-meta text-[var(--muted-foreground)]">{client.cli}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={`font-mono text-micro uppercase tracking-caps ${client.detected ? "text-[var(--success-text)]" : "text-[var(--warning-text)]"}`}>
            {client.detected ? "● detected" : "○ not found"}
          </span>
          <a href={client.url} target="_blank" rel="noopener noreferrer" className="rounded p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]" title="Open documentation" aria-label={`Open ${client.name} documentation`}><ExternalLink className="w-3.5 h-3.5" /></a>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        <p className="font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">{client.description}</p>

        {!client.detected && <div className="flex items-start gap-2 border-l-2 border-[var(--warning)] bg-[var(--warning)]/8 px-3 py-2 font-mono text-meta leading-relaxed text-[var(--warning-text)]"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><p>Config file not found on this machine. Install {client.name}, then refresh detection. Apply and Restore stay disabled until a config path is available.</p></div>}

        <section className="space-y-2" aria-label="Default model step">
          <StepLabel number={1} title="Default model" hint="The model written as the client's default." />
          <div ref={ref} className="relative pl-[var(--indent-step)]">
            <button type="button" onClick={() => setModelOpen((value) => !value)} aria-expanded={modelOpen} className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-body transition-colors duration-150 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"><span className="truncate text-[var(--foreground)] font-mono">{model || "— select a model —"}</span><ChevronsUpDown className="w-4 h-4 text-[var(--muted-foreground)] shrink-0" /></button>
            {modelOpen && <div className="absolute left-[var(--indent-step)] right-0 z-overlay mt-1 rounded-md border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-raised)]"><div className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-2"><Search className="w-3.5 h-3.5 text-[var(--muted-foreground)]" /><input autoFocus value={modelQuery} onChange={(e) => setModelQuery(e.target.value)} placeholder="Search models..." aria-label="Search default models" className="w-full bg-transparent font-mono text-body text-[var(--foreground)] focus:outline-none" /></div><ul className="max-h-56 overflow-y-auto py-1">{filteredModels.map((m) => <li key={m.id}><button type="button" onClick={() => { onModelChange(m.id); setModelOpen(false); setModelQuery(""); }} className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-body transition-colors duration-150 hover:bg-[var(--secondary)] ${model === m.id ? "bg-[var(--secondary)]" : ""}`}><span className="truncate text-[var(--foreground)] font-mono">{m.id}</span><span className="text-micro text-[var(--muted-foreground)]">{m.owned_by}</span></button></li>)}{filteredModels.length === 0 && <li className="px-3 py-2 font-mono text-meta text-[var(--muted-foreground)]">No models match.</li>}</ul></div>}
          </div>
        </section>

        <section className="space-y-2" aria-label="Models in config step">
          <div className="flex items-start gap-2.5"><StepLabel number={2} title="Models in config" hint="Choose which models appear in the generated configuration." count={`${selectedModels.length}/${models.length}`} /></div>
          <div className="pl-[var(--indent-step)] space-y-2">
            <button type="button" onClick={() => setModelsOpen((value) => !value)} aria-expanded={modelsOpen} className="w-full flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--secondary)]/50 px-3 py-2 text-xs text-[var(--foreground)] hover:bg-[var(--secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"><span>{modelsOpen ? "Hide model list" : "Show model list"}</span>{modelsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</button>
            {modelsOpen && <div className="rounded-md border border-[var(--border)] overflow-hidden"><div className="flex flex-wrap items-center gap-2 p-2 border-b border-[var(--border)] bg-[var(--background)]"><div className="flex flex-1 min-w-[150px] items-center gap-2 rounded border border-[var(--border)] px-2 py-1.5"><Search className="w-3.5 h-3.5 text-[var(--muted-foreground)]" /><input value={subsetQuery} onChange={(e) => setSubsetQuery(e.target.value)} placeholder="Filter available models..." aria-label="Filter models in config" className="w-full bg-transparent text-xs focus:outline-none text-[var(--foreground)]" /></div><button type="button" onClick={() => filteredSubsetModels.forEach((m) => { if (!selectedSet.has(m.id)) onToggleModel(m.id); })} className="text-micro font-mono uppercase tracking-wide text-[var(--primary-text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">Select all</button><button type="button" onClick={() => filteredSubsetModels.forEach((m) => { if (selectedSet.has(m.id)) onToggleModel(m.id); })} className="text-micro font-mono uppercase tracking-wide text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">Clear</button></div><div className="max-h-56 overflow-y-auto divide-y divide-[var(--border)]">{filteredSubsetModels.map((m) => <label key={m.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--secondary)]"><input type="checkbox" checked={selectedSet.has(m.id)} onChange={() => onToggleModel(m.id)} className="w-3.5 h-3.5 accent-[var(--primary)] cursor-pointer shrink-0" /><span className="text-xs truncate text-[var(--foreground)] flex-1 font-mono">{m.id}</span><span className="text-micro text-[var(--muted-foreground)] shrink-0">{m.owned_by}</span></label>)}{filteredSubsetModels.length === 0 && <div className="px-3 py-3 text-xs text-[var(--muted-foreground)]">No models match this filter.</div>}</div></div>}
            <Button size="sm" variant="outline" onClick={handleSaveModels} disabled={savingModels} className="h-8 gap-1.5 text-xs">{savingModels ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save model selection</Button>
          </div>
        </section>

        <div className="pl-[var(--indent-step)] space-y-1"><span className="font-mono text-micro uppercase tracking-eyebrow text-[var(--muted-foreground)]">Config path</span><div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5"><code className="text-meta font-mono text-[var(--muted-foreground)] truncate flex-1" title={client.configPaths.join(", ")}>{client.configPaths.join(" · ") || "No config path reported"}</code>{client.configPaths[0] && <CopyButton value={client.configPaths[0]} />}</div></div>

        {showPreview !== false && <section className="pl-[var(--indent-step)] space-y-2" aria-label="Generated configuration"><StepLabel number={3} title={configName} hint="Review the file before applying it." />{previewLoading ? <div className="px-3 py-4 rounded-md border border-[var(--border)] bg-[var(--background)] text-xs text-[var(--muted-foreground)] flex items-center gap-2"><RefreshCw className="w-3 h-3 animate-spin" /> Loading preview...</div> : previewData ? <ConfigPreview config={previewData} label={`Generated ${configName}`} /> : null}</section>}

        <div className="flex flex-col gap-2 border-t border-[var(--hairline)] pt-3 sm:flex-row sm:items-center"><Button onClick={handleApply} disabled={applying || !client.detected} title={!client.detected ? "Apply is unavailable until the client config is detected" : "Apply generated configuration"} className="sm:min-w-32">{applying ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />} {applying ? "Applying..." : "Apply config"}</Button><Button size="sm" variant="outline" onClick={handleRestore} disabled={restoring || !client.detected} title={!client.detected ? "Restore is unavailable until the client config is detected" : "Restore previous configuration"}>{restoring ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null} Restore</Button>{status && <span role="status" className={`inline-flex items-center gap-1.5 font-mono text-meta sm:ml-auto ${status.ok ? "text-[var(--success-text)]" : "text-[var(--destructive-text)]"}`}>{status.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}{status.msg}</span>}</div>
      </div>
    </Card>
  );
}
