import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import PageHeader from "@/components/layout/PageHeader";
import { Save, RefreshCw, Zap, Flame, Globe, Wand2, Bell, Send } from "lucide-react";
import {
  fetchSettings,
  updateSettings,
  fetchProviderList,
  fetchAlertSettings,
  updateAlertSettings,
  sendTestAlert,
  fetchAutoWarmupStatus,
  type AutoWarmupStatus,
} from "@/lib/api";
import { useApi } from "@/hooks/useApi";
import { useTimedMessage } from "@/hooks/useTimedMessage";

const PROVIDER_LABELS: Record<string, string> = {
  codebuddy: "CodeBuddy",
  "codebuddy-china": "CodeBuddy CN",
  canva: "Canva",
  codex: "Codex",
  "grok-cli": "Grok CLI",
  claude: "Claude",
};

function labelFor(provider: string): string {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider]!;
  return provider
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export default function Settings() {
  const [form, setForm] = useState<Record<string, string>>({
    load_balancing_method: "sequential",
    auto_warmup_interval_minutes: "15",
    proxy_pool_usage: "all",
    proxy_pool_rotation: "round_robin",
    // Compression defaults — keep in sync with DEFAULT_COMPRESSION_CONFIG.
    compression_rtk_enabled: "true",
    compression_rtk_max_tool_chars: "4000",
    compression_rtk_keep_last_n_turns_full: "2",
    compression_rtk_smart_truncate: "true",
    compression_dcp_enabled: "false",
    compression_caveman_enabled: "false",
    compression_caveman_level: "lite",
    compression_cache_markers_enabled: "true",
    compression_image_dedupe_enabled: "true",
    compression_tsc_enabled: "true",
    compression_tsc_strip_schema_whitespace: "true",
    compression_tsc_trim_descriptions: "true",
    compression_tsc_drop_schema_meta: "true",
    // Ponytail — lazy-dev ruleset injection (default OFF, changes model behavior).
    compression_ponytail_enabled: "false",
    compression_ponytail_mode: "lite",
    compression_ponytail_strip_markers: "false",
  });
  const [warmupStatus, setWarmupStatus] = useState<AutoWarmupStatus | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [testingAlert, setTestingAlert] = useState(false);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const providerListApi = useApi<{ data: string[] }>(fetchProviderList, []);

  const providers = useMemo(
    () => providerListApi.data?.data || [],
    [providerListApi.data]
  );

  async function load() {
    const [res, alertsRes] = await Promise.all([
      fetchSettings(),
      fetchAlertSettings().catch(() => ({ data: {} })),
    ]);
    setForm((current) => ({
      ...current,
      ...(res.data || {}),
      ...((alertsRes as any)?.data || {}),
    }));
    setDirty(false);
    fetchAutoWarmupStatus().then(setWarmupStatus).catch(() => {});
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  function setValue(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  function lbMethodFor(provider: string): string {
    return (
      form[`provider_${provider}_lb_method`] ||
      form.load_balancing_method ||
      "sequential"
    );
  }

  function isOverride(provider: string): boolean {
    return Boolean(form[`provider_${provider}_lb_method`]);
  }

  async function save() {
    setSaving(true);
    try {
      // Alert keys live on the dedicated /api/alerts/settings endpoint (it
      // validates numerics + webhook URL); everything else goes to /api/settings.
      const alertBody: Record<string, string> = {};
      const mainBody: Record<string, string> = {};
      for (const [key, value] of Object.entries(form)) {
        if (key.startsWith("alert_")) alertBody[key] = value;
        else mainBody[key] = value;
      }
      await Promise.all([
        updateSettings(mainBody),
        Object.keys(alertBody).length > 0 ? updateAlertSettings(alertBody) : Promise.resolve(),
      ]);
      setSavedAt(new Date());
      setDirty(false);
      setMessage("Settings saved.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestAlert() {
    setTestingAlert(true);
    try {
      const res = await sendTestAlert();
      const results = res?.data?.results || {};
      const parts: string[] = [];
      if (results.webhook) parts.push(results.webhook.ok ? "✓ webhook" : `webhook: ${results.webhook.error || "failed"}`);
      if (results.telegram) parts.push(results.telegram.ok ? "✓ telegram" : `telegram: ${results.telegram.error || "failed"}`);
      setMessage(parts.length > 0 ? parts.join(" · ") : "No channels configured");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Test alert failed");
    } finally {
      setTestingAlert(false);
    }
  }

  const globalMethod = form.load_balancing_method || "sequential";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Proxy Settings"
        meta={
          <>
            <span>load balancing · failover · warmup</span>
            {dirty && (
              <>
                <span aria-hidden className="text-[var(--border)]">·</span>
                <span className="text-[var(--warning-text)]">unsaved</span>
              </>
            )}
            {savedAt && !dirty && (
              <>
                <span aria-hidden className="text-[var(--border)]">·</span>
                <span>saved {savedAt.toLocaleTimeString()}</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="w-3.5 h-3.5" /> Reload
            </Button>
            <Button size="sm" onClick={save} disabled={saving || !dirty}>
              <Save className="w-3.5 h-3.5" /> {saving ? "Saving…" : "Save"}
            </Button>
          </>
        }
      />

      {message && (
        <p className="border-l-2 border-[var(--success)] bg-[var(--success)]/10 px-3 py-2 font-mono text-meta text-[var(--success-text)]">
          {message}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        {/* Load Balancing */}
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-[var(--primary-text)]" />
              Load Balancing
            </CardTitle>
            <CardDescription>
              Control how requests are distributed and failed over across accounts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
              <label className="eyebrow">
                Global Method
              </label>
              <Select
                value={form.load_balancing_method || "sequential"}
                onChange={(e) => setValue("load_balancing_method", e.target.value)}
              >
                <option value="sequential">Sequential failover</option>
                <option value="round_robin">Round Robin</option>
              </Select>
              <p className="font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
                {globalMethod === "sequential"
                  ? "Tries accounts by ID order (oldest first); on failure, continues to the next account until one succeeds or all are exhausted."
                  : "Distributes requests evenly across all active accounts. On failure, retries the next available account."}
              </p>
            </div>

            {providers.length > 0 && (
              <div className="space-y-1">
                <div className="eyebrow">
                  Per-Provider Override
                </div>
                <div>
                  {providers.map((provider) => {
                    const key = `provider_${provider}_lb_method`;
                    const effective = lbMethodFor(provider);
                    const overriden = isOverride(provider);
                    return (
                      <div
                        key={provider}
                        className="flex items-center justify-between gap-3 border-t border-[var(--hairline)] px-1 py-2 first:border-t-0"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 font-mono text-body text-[var(--foreground)]">
                            {labelFor(provider)}
                            {overriden && (
                              <span className="rounded-sm bg-[var(--primary)]/15 px-1.5 py-0.5 font-mono text-micro uppercase tracking-eyebrow text-[var(--primary-text)]">
                                override
                              </span>
                            )}
                          </p>
                          <p className="font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
                            {effective === "sequential" ? "Sequential failover" : "Round Robin"}
                            {!overriden && (
                              <span className="ml-1 text-[var(--muted-foreground)]">
                                (inherits global)
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Select
                            value={form[key] || ""}
                            onChange={(e) => setValue(key, e.target.value)}
                            className="w-auto font-mono text-meta"
                            aria-label={`Load balancing for ${labelFor(provider)}`}
                          >
                            <option value="">Inherit</option>
                            <option value="sequential">Sequential failover</option>
                            <option value="round_robin">Round Robin</option>
                          </Select>
                          {overriden && (
                            <button
                              type="button"
                              onClick={() => setValue(key, "")}
                              className="rounded px-2 py-1 font-mono text-meta text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                              title="Clear override"
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Auto WarmUp */}
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Flame className="w-4 h-4 text-[var(--primary-text)]" />
              Auto WarmUp
            </CardTitle>
            <CardDescription>
              Automatically warm up enabled providers on a schedule
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="eyebrow">Interval (minutes)</label>
              <Input
                type="number"
                min={1}
                max={1440}
                value={form.auto_warmup_interval_minutes || ""}
                onChange={(e) => setValue("auto_warmup_interval_minutes", e.target.value)}
                placeholder="15"
                className="mt-1.5 font-mono tabular-nums"
              />
              <p className="mt-1 font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
                Global interval for all providers with Auto WarmUp enabled
              </p>
            </div>

            <div className="space-y-1.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
              <p className="eyebrow">Status</p>
              <p className="font-mono text-body text-[var(--foreground)]">
                {warmupStatus && warmupStatus.enabledProviders.length > 0
                  ? `${warmupStatus.enabledProviders.length} provider${warmupStatus.enabledProviders.length === 1 ? "" : "s"} enabled`
                  : "No provider enabled"}
              </p>
              {warmupStatus?.enabledProviders && warmupStatus.enabledProviders.length > 0 && (
                <p className="truncate font-mono text-meta text-[var(--muted-foreground)]">
                  {warmupStatus.enabledProviders.map(labelFor).join(", ")}
                </p>
              )}
              {warmupStatus?.nextRunAt && (
                <p className="font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
                  Next run: {new Date(warmupStatus.nextRunAt).toLocaleTimeString()}
                </p>
              )}
              {savedAt && (
                <p className="font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
                  Last saved: {savedAt.toLocaleTimeString()}
                </p>
              )}
            </div>

            <p className="font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
              Auto WarmUp checks accounts with status active, exhausted, or error (skips pending). Enable/disable per provider on the Accounts page.
            </p>
          </CardContent>
        </Card>

        {/* Proxy Pool */}
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-[var(--primary-text)]" />
              Proxy Pool
            </CardTitle>
            <CardDescription>
              Configure how the proxy pool is used for outgoing requests
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
              <label className="eyebrow">
                Usage Scope
              </label>
              <Select
                value={form.proxy_pool_usage || "all"}
                onChange={(e) => setValue("proxy_pool_usage", e.target.value)}
              >
                <option value="all">All — Model + Auth</option>
                <option value="model">Model Only — API requests only</option>
                <option value="auth">Auth Only — Login automation only</option>
              </Select>
              <p className="font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
                {form.proxy_pool_usage === "model"
                  ? "Proxies are only used for upstream model API calls. Auth/login runs without proxy."
                  : form.proxy_pool_usage === "auth"
                    ? "Proxies are only used for login automation. Model API calls go direct."
                    : "Proxies are used for both model API calls and login automation."}
              </p>
            </div>

            <div className="space-y-1.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
              <label className="eyebrow">
                Rotation Strategy
              </label>
              <Select
                value={form.proxy_pool_rotation || "round_robin"}
                onChange={(e) => setValue("proxy_pool_rotation", e.target.value)}
              >
                <option value="round_robin">Round Robin</option>
                <option value="sequential">Sequential</option>
              </Select>
              <p className="font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
                {form.proxy_pool_rotation === "sequential"
                  ? "Uses one proxy until it fails, then moves to the next in the list."
                  : "Distributes requests evenly across all active proxies in rotation."}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Compression — token saver pipeline */}
        <Card className="border-[var(--border)] lg:col-span-2">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Wand2 className="w-4 h-4 text-[var(--primary-text)]" />
                  Compression
                </CardTitle>
                <CardDescription>
                  Reduce token usage by compressing tool outputs, deduplicating context, and shortening prompts. Pipeline runs in order: DCP → RTK → Caveman → Image Dedupe → Cache Markers.
                </CardDescription>
              </div>
              <a
                href="https://github.com/priyo000/etteum-pool/blob/main/docs/compression.md"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 shrink-0 font-mono text-meta text-[var(--primary-text)] hover:underline"
                title="Open the compression docs"
              >
                docs ↗
              </a>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* RTK */}
            <CompressionRow
              title="RTK"
              subtitle="Tool Result Compression"
              description="Compress large tool outputs — git diff, grep, ls, tree, file reads"
              enabled={form.compression_rtk_enabled === "true"}
              onToggle={(v) => setValue("compression_rtk_enabled", v ? "true" : "false")}
            >
              <div className="space-y-3 mt-3">
                {/* Quick presets — primary control */}
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { name: "Conservative", chars: "8000", turns: "3", smart: "true", hint: "Bigger budget, more context kept. ~3% saving." },
                      { name: "Balanced", chars: "4000", turns: "2", smart: "true", hint: "Recommended default. ~6% saving." },
                      { name: "Aggressive", chars: "2000", turns: "1", smart: "true", hint: "Smaller cap, only last turn protected. ~12% saving — model may miss older details." },
                    ] as const
                  ).map((preset) => {
                    const selected =
                      form.compression_rtk_max_tool_chars === preset.chars &&
                      form.compression_rtk_keep_last_n_turns_full === preset.turns;
                    return (
                      <button
                        key={preset.name}
                        type="button"
                        title={preset.hint}
                        onClick={() => {
                          setValue("compression_rtk_max_tool_chars", preset.chars);
                          setValue("compression_rtk_keep_last_n_turns_full", preset.turns);
                        }}
                        className={`rounded-md border px-3 py-2 text-left font-mono text-meta transition-colors duration-150 ${
                          selected
                            ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary-text)]"
                            : "border-[var(--border)] bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        }`}
                      >
                        <div>{preset.name}</div>
                        <div className="text-micro mt-0.5">
                          {preset.chars} chars · keep {preset.turns}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Advanced disclosure */}
                <Disclosure label="Advanced settings">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="eyebrow">Max chars per tool result</label>
                      <Input
                        type="number"
                        min={500}
                        max={50000}
                        step={500}
                        value={form.compression_rtk_max_tool_chars || "4000"}
                        onChange={(e) => setValue("compression_rtk_max_tool_chars", e.target.value)}
                        className="mt-1.5 font-mono tabular-nums"
                      />
                      <p className="mt-1 font-mono text-micro leading-relaxed text-[var(--muted-foreground)]">
                        ~4 chars = 1 token. Default: <code>4000</code> (≈1000 tokens).
                      </p>
                    </div>
                    <div>
                      <label className="eyebrow">Keep last N turns full</label>
                      <Input
                        type="number"
                        min={0}
                        max={20}
                        value={form.compression_rtk_keep_last_n_turns_full || "2"}
                        onChange={(e) => setValue("compression_rtk_keep_last_n_turns_full", e.target.value)}
                        className="mt-1.5 font-mono tabular-nums"
                      />
                      <p className="mt-1 font-mono text-micro leading-relaxed text-[var(--muted-foreground)]">
                        Recent turns left untouched. Default: <code>2</code>.
                      </p>
                    </div>
                    <div>
                      <label className="eyebrow">Smart truncate</label>
                      <label className="mt-1.5 flex h-9 cursor-pointer items-center gap-2 rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5">
                        <input
                          type="checkbox"
                          checked={form.compression_rtk_smart_truncate === "true"}
                          onChange={(e) => setValue("compression_rtk_smart_truncate", e.target.checked ? "true" : "false")}
                        />
                        <span className="font-mono text-meta text-[var(--foreground)]">Pattern-aware</span>
                      </label>
                      <p className="mt-1 font-mono text-micro leading-relaxed text-[var(--muted-foreground)]">
                        git diff / tree aware. Default: <code>on</code>.
                      </p>
                    </div>
                  </div>
                </Disclosure>
              </div>
            </CompressionRow>

            {/* DCP */}
            <CompressionRow
              title="DCP"
              subtitle="Context Deduplication"
              description="When the same read-only tool (Read, Glob, Grep, LS, WebFetch) is called twice with identical input, the older result is replaced with a short reference stub. Lossless from the model's perspective."
              enabled={form.compression_dcp_enabled === "true"}
              onToggle={(v) => setValue("compression_dcp_enabled", v ? "true" : "false")}
            />

            {/* Caveman */}
            <CompressionRow
              title="Caveman"
              subtitle="Terse System Prompt"
              description="Strips filler words and compacts the system prompt. ⚠️ Off by default — aggressive levels can change model behaviour. Test with your own prompts before enabling Full or Ultra."
              enabled={form.compression_caveman_enabled === "true"}
              onToggle={(v) => setValue("compression_caveman_enabled", v ? "true" : "false")}
              alwaysShowChildren
            >
              <div className="mt-3 space-y-2">
                <div className="text-meta uppercase tracking-wide text-[var(--muted-foreground)]">
                  Compression level
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { lvl: "lite", title: "Lite", subtitle: "Drop filler", hint: "~5–15% saving · safest" },
                      { lvl: "full", title: "Full", subtitle: "Bullet form", hint: "~30–50% saving · moderate risk" },
                      { lvl: "ultra", title: "Ultra", subtitle: "Telegraphic", hint: "~50–70% saving · may degrade output" },
                    ] as const
                  ).map(({ lvl, title, subtitle, hint }) => {
                    const selected = form.compression_caveman_level === lvl;
                    return (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => setValue("compression_caveman_level", lvl)}
                        title={hint}
                        className={`rounded-md border px-3 py-2 text-left font-mono text-meta transition-colors duration-150 ${
                          selected
                            ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary-text)]"
                            : "border-[var(--border)] bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        }`}
                      >
                        <div>{title}</div>
                        <div className="text-micro mt-0.5">{subtitle}</div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-meta text-[var(--muted-foreground)] leading-relaxed">
                  {form.compression_caveman_level === "lite" &&
                    "Lite: removes politeness fillers (\"please\", \"make sure to\") and verbose connectors. Sentence structure preserved. Saves ~5–15%."}
                  {form.compression_caveman_level === "full" &&
                    "Full: lite + collapses narrative connectors (\"furthermore\", \"that being said\"), drops \"the following\" lead-ins, simplifies if/when clauses. Saves ~30–50%. Test before deploying."}
                  {form.compression_caveman_level === "ultra" &&
                    "Ultra: full + drops articles (a/an/the), drops modal helpers (you can/may/might), forces imperative voice. Saves ~50–70% but may degrade model behaviour. Use only after benchmarking."}
                </p>
              </div>
            </CompressionRow>

            {/* Ponytail — Lazy Dev Ruleset Injection */}
            <CompressionRow
              title="Ponytail"
              subtitle="Lazy Dev Ruleset"
              description="Injects a 'lazy senior dev' ruleset (YAGNI ladder, shortest-diff, no over-engineering) into the system prompt. ⚠️ ADDS ~300–1,400 tokens (shown as negative savings) but the model writes less code and fewer tool calls. Scan response for ponytail: corner-cutting markers. Adapted from DietrichGebert/ponytail (MIT)."
              enabled={form.compression_ponytail_enabled === "true"}
              onToggle={(v) => setValue("compression_ponytail_enabled", v ? "true" : "false")}
              alwaysShowChildren
            >
              <div className="mt-3 space-y-2">
                <div className="text-meta uppercase tracking-wide text-[var(--muted-foreground)]">
                  Ruleset intensity
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { lvl: "lite", title: "Lite", subtitle: "YAGNI ladder", hint: "~300 tokens · safest · just the 7-rung ladder + 5 core rules" },
                      { lvl: "full", title: "Full", subtitle: "All rules", hint: "~800 tokens · moderate · full ruleset + marker instructions" },
                      { lvl: "ultra", title: "Ultra", subtitle: "Tag taxonomy", hint: "~1,400 tokens · aggressive · full + 5-tag review taxonomy + worked examples" },
                    ] as const
                  ).map(({ lvl, title, subtitle, hint }) => {
                    const selected = form.compression_ponytail_mode === lvl;
                    return (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => setValue("compression_ponytail_mode", lvl)}
                        title={hint}
                        className={`rounded-md border px-3 py-2 text-left font-mono text-meta transition-colors duration-150 ${
                          selected
                            ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary-text)]"
                            : "border-[var(--border)] bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        }`}
                      >
                        <div>{title}</div>
                        <div className="text-micro mt-0.5">{subtitle}</div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-meta text-[var(--muted-foreground)] leading-relaxed">
                  {form.compression_ponytail_mode === "lite" &&
                    "Lite: the 7-rung YAGNI ladder (does this need to be built? reuse existing? stdlib? one line?) plus 5 core rules (no abstractions, deletion over addition, shortest diff, fewest files, question complex requests). ~300 tokens added."}
                  {form.compression_ponytail_mode === "full" &&
                    "Full: lite + bug-fix=root-cause rule, explicit ponytail: marker instructions (mark deliberate corner-cuts with ceiling + upgrade path), and the 'not lazy about' guardrails (security, input validation, error handling). ~800 tokens added."}
                  {form.compression_ponytail_mode === "ultra" &&
                    "Ultra: full + 5-tag review taxonomy (delete/stdlib/native/yagni/shrink) with worked examples for each. Most aggressive behavior change — the model will push back on complex requests and default to deletion. ~1,400 tokens added."}
                </p>
                <Disclosure label="Advanced settings">
                  <div className="space-y-3">
                    <label className="flex cursor-pointer items-center gap-2 font-mono text-meta text-[var(--muted-foreground)]">
                      <input
                        type="checkbox"
                        checked={form.compression_ponytail_strip_markers === "true"}
                        onChange={(e) => setValue("compression_ponytail_strip_markers", e.target.checked ? "true" : "false")}
                        className="accent-[var(--primary)]"
                      />
                      <span>Strip <code>ponytail:</code> markers from response before storing (markers still counted in stats)</span>
                    </label>
                    <p className="text-micro text-[var(--muted-foreground)] leading-relaxed">
                      When enabled, <code>ponytail: ceiling, upgrade</code> comments are removed from the
                      response body stored in <code>request_logs</code>. The marker count and details are
                      still recorded in <code>compression_stats.ponytail</code> for telemetry. Disable to
                      keep markers visible in the stored response for audit purposes.
                    </p>
                  </div>
                </Disclosure>
              </div>
            </CompressionRow>

            {/* Cache Markers */}
            <CompressionRow
              title="Cache Markers"
              subtitle="Anthropic Prompt Caching"
              description="Tags the stable system-prompt prefix with cache_control:ephemeral so upstream providers can cache it. Auto-skips when prefix contains timestamps or UUIDs (would never cache anyway). Pays off as ~75% discount on repeat input tokens."
              enabled={form.compression_cache_markers_enabled === "true"}
              onToggle={(v) => setValue("compression_cache_markers_enabled", v ? "true" : "false")}
            />

            {/* Image Dedupe */}
            <CompressionRow
              title="Image Dedupe"
              subtitle="Duplicate Image Detection"
              description="When the same image is attached more than once in a request, later occurrences are replaced with a reference stub. Lossless — the image is still in earlier context."
              enabled={form.compression_image_dedupe_enabled === "true"}
              onToggle={(v) => setValue("compression_image_dedupe_enabled", v ? "true" : "false")}
            />

            {/* TSC — Tool Schema Compaction */}
            <CompressionRow
              title="TSC"
              subtitle="Tool Schema Compaction"
              description="Lossless compaction of the tools[] array — strips JSON-Schema metadata ($schema, $id, additionalProperties:false) and collapses whitespace runs in tool descriptions. Provider-agnostic; runs first in pipeline. Typical agent traffic: 5-15% saving."
              enabled={form.compression_tsc_enabled === "true"}
              onToggle={(v) => setValue("compression_tsc_enabled", v ? "true" : "false")}
            />
          </CardContent>
        </Card>

        {/* Alerts — webhook + telegram notifications */}
        <Card className="border-[var(--border)] lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-[var(--primary-text)]" />
              Alerts
            </CardTitle>
            <CardDescription>
              Webhook + Telegram notifications for pool events
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <CompressionRow
              title="Master toggle"
              subtitle="all channels"
              description="Off disables every alert below without losing their settings."
              enabled={form.alert_enabled === "true"}
              onToggle={(v) => setValue("alert_enabled", v ? "true" : "false")}
            />

            <div className="space-y-1.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
              <label className="eyebrow">Webhook URL</label>
              <Input
                type="url"
                placeholder="https://discord.com/api/webhooks/..."
                value={form.alert_webhook_url || ""}
                onChange={(e) => setValue("alert_webhook_url", e.target.value)}
              />
              <p className="font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
                Discord or Slack compatible — receives <code>{"{content}"}</code> JSON POST
              </p>
            </div>

            <div className="space-y-1.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
              <label className="eyebrow">Telegram</label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Input
                  type="text"
                  placeholder="Bot token"
                  value={form.alert_telegram_token || ""}
                  onChange={(e) => setValue("alert_telegram_token", e.target.value)}
                />
                <Input
                  type="text"
                  placeholder="Chat ID"
                  value={form.alert_telegram_chat || ""}
                  onChange={(e) => setValue("alert_telegram_chat", e.target.value)}
                />
              </div>
              <p className="font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
                Optional — sends via Telegram sendMessage API
              </p>
            </div>

            <CompressionRow
              title="Account error / exhausted"
              subtitle="account"
              description="Fires when an account hits an error or runs out of credits."
              enabled={form.alert_event_account_error === "true"}
              onToggle={(v) => setValue("alert_event_account_error", v ? "true" : "false")}
            />

            <CompressionRow
              title="Low credits"
              subtitle="credit threshold"
              description="Warns when remaining credits drop below the threshold."
              enabled={form.alert_event_low_credits === "true"}
              onToggle={(v) => setValue("alert_event_low_credits", v ? "true" : "false")}
            >
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div>
                  <label className="eyebrow">Threshold %</label>
                  <Input
                    type="number"
                    min={1}
                    value={form.alert_credit_threshold || ""}
                    onChange={(e) => setValue("alert_credit_threshold", e.target.value)}
                    className="mt-1.5 font-mono tabular-nums"
                  />
                </div>
              </div>
            </CompressionRow>

            <CompressionRow
              title="Error-rate spike"
              subtitle="threshold + window"
              description="Fires when the error rate exceeds the threshold over the window."
              enabled={form.alert_event_error_rate === "true"}
              onToggle={(v) => setValue("alert_event_error_rate", v ? "true" : "false")}
            >
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div>
                  <label className="eyebrow">Percent</label>
                  <Input
                    type="number"
                    min={1}
                    value={form.alert_error_rate_percent || ""}
                    onChange={(e) => setValue("alert_error_rate_percent", e.target.value)}
                    className="mt-1.5 font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="eyebrow">Window (min)</label>
                  <Input
                    type="number"
                    min={1}
                    value={form.alert_error_rate_window_min || ""}
                    onChange={(e) => setValue("alert_error_rate_window_min", e.target.value)}
                    className="mt-1.5 font-mono tabular-nums"
                  />
                </div>
              </div>
            </CompressionRow>

            <CompressionRow
              title="Proxy pool empty"
              subtitle="pool"
              description="Fires when no proxies remain in the pool."
              enabled={form.alert_event_proxy_pool_empty === "true"}
              onToggle={(v) => setValue("alert_event_proxy_pool_empty", v ? "true" : "false")}
            />

            <div className="flex items-end justify-between gap-4">
              <div className="max-w-[180px]">
                <label className="eyebrow">Cooldown (min)</label>
                <Input
                  type="number"
                  min={1}
                  value={form.alert_cooldown_min || ""}
                  onChange={(e) => setValue("alert_cooldown_min", e.target.value)}
                  className="mt-1.5 font-mono tabular-nums"
                />
              </div>
              <Button variant="outline" size="sm" onClick={handleTestAlert} disabled={testingAlert}>
                {testingAlert ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {testingAlert ? "Sending…" : "Send test alert"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * Native <details> disclosure with chevron. Used to hide power-user controls
 * inside a CompressionRow so the default view stays simple (mirroring the
 * router-style toggle UX while keeping advanced knobs reachable).
 */
function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-md border border-[var(--hairline)]">
      <summary className="flex cursor-pointer list-none select-none items-center justify-between px-3 py-2 font-mono text-micro uppercase tracking-eyebrow text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
        <span>{label}</span>
        <span className="transition-transform group-open:rotate-180" aria-hidden>▾</span>
      </summary>
      <div className="border-t border-[var(--hairline)] px-3 pb-3 pt-2">{children}</div>
    </details>
  );
}

function CompressionRow({
  title,
  subtitle,
  description,
  enabled,
  onToggle,
  children,
  alwaysShowChildren = false,
}: {
  title: string;
  subtitle: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
  /** When true, children render even when toggle is off (visually dimmed). */
  alwaysShowChildren?: boolean;
}) {
  return (
    <div className="rounded-md border border-[var(--hairline)] px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-body font-semibold uppercase tracking-caps text-[var(--foreground)]">{title}</span>
            <span className="font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">({subtitle})</span>
          </div>
          <p className="mt-1 font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">{description}</p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer shrink-0">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <div className="w-10 h-5 bg-[var(--border)] peer-checked:bg-[var(--primary)] rounded-full transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ring)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--card)] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform duration-200 peer-checked:after:translate-x-5"></div>
        </label>
      </div>
      {children && (alwaysShowChildren || enabled) && (
        <div className={alwaysShowChildren && !enabled ? "opacity-50 pointer-events-none" : ""}>
          {children}
        </div>
      )}
    </div>
  );
}
