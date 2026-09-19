import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/layout/PageHeader";
import { Filter, Plus, Trash2, Power, PowerOff, Pencil, X } from "lucide-react";
import { fetchApi } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useWsEvent } from "@/hooks/useWebSocket";

interface FilterRule {
  id: number;
  ruleId: string;
  pattern: string;
  replacement: string;
  isActive: boolean;
  isRegex: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string | null;
}

interface FilterListResponse {
  count: number;
  activeCount: number;
  rules: FilterRule[];
}

interface RuleFormState {
  id: number | null;
  pattern: string;
  replacement: string;
  isRegex: boolean;
  isActive: boolean;
}

const emptyForm: RuleFormState = { id: null, pattern: "", replacement: "", isRegex: true, isActive: true };

export default function FilterRules() {
  const [data, setData] = useState<FilterListResponse>({ count: 0, activeCount: 0, rules: [] });
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<RuleFormState | null>(null);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const load = useCallback(async () => {
    try {
      const result = await fetchApi<FilterListResponse>("/api/filters");
      setData(result);
    } catch {
      setData({ count: 0, activeCount: 0, rules: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useWsEvent(["filter_rules_updated"], load);

  const handleToggle = async (rule: FilterRule) => {
    try {
      await fetchApi(`/api/filters/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      load();
    } catch (e: any) {
      setMessage(e.message || "Failed to toggle rule");
    }
  };

  const handleDelete = async (rule: FilterRule) => {
    if (!confirm(`Delete rule "${rule.ruleId}"?`)) return;
    try {
      await fetchApi(`/api/filters/${rule.id}`, { method: "DELETE" });
      setMessage("Rule deleted");
      load();
    } catch (e: any) {
      setMessage(e.message || "Failed to delete rule");
    }
  };

  const handleSave = async () => {
    if (!form) return;
    if (!form.pattern.trim()) {
      setMessage("Pattern is required");
      return;
    }
    try {
      if (form.id == null) {
        await fetchApi("/api/filters", {
          method: "POST",
          body: JSON.stringify({
            pattern: form.pattern,
            replacement: form.replacement,
            isRegex: form.isRegex,
            isActive: form.isActive,
          }),
        });
        setMessage("Rule created");
      } else {
        await fetchApi(`/api/filters/${form.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            pattern: form.pattern,
            replacement: form.replacement,
            isRegex: form.isRegex,
            isActive: form.isActive,
          }),
        });
        setMessage("Rule updated");
      }
      setForm(null);
      load();
    } catch (e: any) {
      setMessage(e.message || "Save failed");
    }
  };

  const truncate = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Filter Rules"
        meta={`${data.activeCount} of ${data.count} active · pre-request sanitizer`}
        actions={
          <Button size="sm" onClick={() => setForm({ ...emptyForm })}>
            <Plus className="w-3.5 h-3.5" /> New rule
          </Button>
        }
      />

      {message && (
        <p className="border-l-2 border-[var(--border)] bg-[var(--secondary)]/50 px-3 py-2 font-mono text-meta text-[var(--foreground)]">
          {message}
        </p>
      )}

      {form && (
        <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <h2 className="eyebrow flex items-center gap-1.5">
              <Filter className="w-3.5 h-3.5" />
              {form.id == null ? "New rule" : `Edit rule`}
            </h2>
            <button
              onClick={() => setForm(null)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
              aria-label="Discard"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-3 px-4 py-3">
            <div>
              <label htmlFor="rule-pattern" className="eyebrow mb-1.5 block">Pattern</label>
              <textarea
                id="rule-pattern"
                className="h-[76px] w-full resize-none rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-body text-[var(--foreground)] transition-colors duration-150 ease-out placeholder:text-[var(--muted-faint)] hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                placeholder={form.isRegex ? "regex, case-insensitive" : "exact string to match"}
                value={form.pattern}
                onChange={(e) => setForm({ ...form, pattern: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="rule-replacement" className="eyebrow mb-1.5 block">Replacement</label>
              <textarea
                id="rule-replacement"
                className="h-[56px] w-full resize-none rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-body text-[var(--foreground)] transition-colors duration-150 ease-out placeholder:text-[var(--muted-faint)] hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                placeholder="empty removes the match"
                value={form.replacement}
                onChange={(e) => setForm({ ...form, replacement: e.target.value })}
              />
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex cursor-pointer items-center gap-2 font-mono text-body text-[var(--foreground)]">
                <input
                  type="checkbox"
                  className="accent-[var(--primary)]"
                  checked={form.isRegex}
                  onChange={(e) => setForm({ ...form, isRegex: e.target.checked })}
                />
                Regex
              </label>
              <label className="flex cursor-pointer items-center gap-2 font-mono text-body text-[var(--foreground)]">
                <input
                  type="checkbox"
                  className="accent-[var(--primary)]"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                Active
              </label>
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setForm(null)}>Cancel</Button>
                <Button size="sm" onClick={handleSave}>Save</Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Rules read as an ordered pipeline, so they're a numbered list with
          hairlines — not a stack of individually boxed cards. */}
      <Card className="overflow-hidden">
        {loading ? (
          <p className="px-4 py-3 font-mono text-body text-[var(--muted-foreground)]">Loading…</p>
        ) : data.rules.length === 0 ? (
          <p className="px-4 py-3 font-mono text-body text-[var(--muted-foreground)]">
            No rules yet — add one to strip patterns before they reach the provider.
          </p>
        ) : (
          <div>
            {data.rules.map((rule) => (
              <div
                key={rule.id}
                className={`flex items-center justify-between gap-3 border-t border-[var(--hairline)] px-3 py-2 transition-colors duration-150 ease-out first:border-t-0 hover:bg-[var(--secondary)]/40 ${rule.isActive ? "" : "opacity-55"}`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2.5 font-mono text-body">
                  <span className="w-7 shrink-0 tabular-nums text-[var(--muted-foreground)]">{rule.sortOrder}</span>
                  <span
                    aria-hidden
                    className="h-3 w-[2px] shrink-0 rounded-full"
                    style={{ backgroundColor: rule.isActive ? "var(--success)" : "var(--border)" }}
                    title={rule.isActive ? "active" : "disabled"}
                  />
                  <span className="hidden w-28 shrink-0 truncate text-[var(--muted-foreground)] lg:inline">{rule.ruleId}</span>
                  <Badge variant={rule.isRegex ? "info" : "secondary"}>{rule.isRegex ? "regex" : "string"}</Badge>
                  <span className="min-w-0 flex-1 truncate text-[var(--foreground)]" title={rule.pattern}>
                    {truncate(rule.pattern)}
                  </span>
                  {rule.replacement && (
                    <span className="hidden shrink-0 truncate text-[var(--muted-foreground)] sm:inline" title={rule.replacement}>
                      → {truncate(rule.replacement, 24)}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleToggle(rule)}
                    title={rule.isActive ? "Disable" : "Enable"}
                    aria-label={rule.isActive ? "Disable rule" : "Enable rule"}
                  >
                    {rule.isActive ? <PowerOff className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      setForm({
                        id: rule.id,
                        pattern: rule.pattern,
                        replacement: rule.replacement,
                        isRegex: rule.isRegex,
                        isActive: rule.isActive,
                      })
                    }
                    title="Edit"
                    aria-label="Edit rule"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDelete(rule)}
                    title="Delete"
                    aria-label="Delete rule"
                    className="hover:text-[var(--destructive-text)]"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
