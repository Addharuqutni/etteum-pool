import { Copy, Check, ChevronDown, FileJson } from "lucide-react";
import { useState } from "react";

interface ConfigPreviewProps {
  config: Record<string, unknown> | string;
  label?: string;
}

export function ConfigPreview({ config, label = "Generated configuration" }: ConfigPreviewProps) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(true);
  const content = typeof config === "string" ? config : JSON.stringify(config, null, 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-[var(--secondary)]/60">
        <button type="button" onClick={() => setOpen((value) => !value)} className="flex min-w-0 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded">
          <FileJson className="w-3.5 h-3.5 text-[var(--info)] shrink-0" />
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--foreground)] truncate">{label}</span>
          <ChevronDown className={`w-3.5 h-3.5 text-[var(--muted-foreground)] transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
        <button type="button" onClick={handleCopy} className="p-1.5 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]" title="Copy generated configuration" aria-label="Copy generated configuration">
          {copied ? <Check className="w-3.5 h-3.5 text-[var(--success)]" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
      {open && <pre className="px-3 py-3 text-[11px] leading-relaxed font-mono text-[var(--foreground)] overflow-x-auto whitespace-pre max-h-64 overflow-y-auto">{content}</pre>}
    </div>
  );
}
