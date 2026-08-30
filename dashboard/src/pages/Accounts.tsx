import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle as DTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import PageHeader from "@/components/layout/PageHeader";
import { Plus, Upload, RefreshCw, Play, RotateCcw, Flame, ChevronDown, Loader2, Key, Pencil, Trash2, Zap, Lock, Shield, Eye, EyeOff, Download } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useWsEvent } from "@/hooks/useWebSocket";
import {
  cancelClaudeOAuth,
  cancelCodebuddyOAuth,
  cancelGrokCliOAuth,
  completeClaudeOAuth,
  completeCodexOAuthCallbackUrl,
  createAccount,
  createByokProvider,
  deleteByokProvider,
  fetchAccounts,
  fetchApi,
  fetchAuthQueue,
  fetchAutoWarmupStatus,
  fetchByokModels,
  fetchByokProviders,
  fetchSettings,
  fetchWarmupQueue,
  getCodexAuthorize,
  importAccounts,
  loginAccounts,
  loginAllAccounts,
  pollCodexOAuthStatus,
  pollCodebuddyOAuth,
  pollGrokCliOAuth,
  revealByokKey,
  startClaudeOAuth,
  startCodebuddyDeviceCode,
  startCodexOAuthProxy,
  startGrokCliDeviceCode,
  stopCodexOAuth,
  testByokProvider,
  updateByokProvider,
  updateSettings,
  warmupAllAccounts,
  type AutoWarmupStatus,
  type ByokProvider,
} from "@/lib/api";

type Provider = "codebuddy" | "codebuddy-china" | "canva" | "codex" | "grok-cli" | "claude";

type ByokFormKey = {
  id?: number;
  label: string;
  key: string;
  enabled: boolean;
  status?: string;
  errorMessage?: string | null;
};

interface Account {
  id: number;
  email: string;
  provider: Provider;
  status: string;
  quotaLimit?: number;
  quotaRemaining?: number;
}

const providers: Provider[] = ["codebuddy", "codebuddy-china", "canva", "codex", "grok-cli", "claude"];

/** Configured models first, then models discovered via /models (deduped). */
function byokChipModels(provider: ByokProvider): string[] {
  return [...new Set([...(provider.models || []), ...(provider.available_models || [])])];
}

function labelProvider(provider: string) {
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "codebuddy-china") return "CodeBuddy CN";
  if (provider === "codex") return "Codex";
  if (provider === "grok-cli") return "Grok CLI";
  if (provider === "claude") return "Claude";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export default function Accounts() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<any>(null);
  const [warmupQueue, setWarmupQueue] = useState<any>(null);
  const [warmupProgress, setWarmupProgress] = useState<Record<string, { total: number; completed: number; active: number }>>({});
  const [autoWarmup, setAutoWarmup] = useState<AutoWarmupStatus | null>(null);
  const [settingsMap, setSettingsMap] = useState<Record<string, string>>({});
  const [now, setNow] = useState<number>(Date.now());

  const [addForm, setAddForm] = useState({ email: "", password: "", provider: "codebuddy" as Provider, browserEngine: "camoufox", headless: false });
  const [addDialogProvider, setAddDialogProvider] = useState<Provider | null>(null);
  const [instantTokens, setInstantTokens] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [addMode, setAddMode] = useState<"single" | "bulk" | "instant" | "pat" | "apikey" | "oauth" | "token">("bulk");
  const [bulkBrowserEngine, setBulkBrowserEngine] = useState("camoufox");
  const [bulkHeadless, setBulkHeadless] = useState(true);
  const [bulkConcurrency, setBulkConcurrency] = useState(3);
  const [codexOauthBusy, setCodexOauthBusy] = useState(false);
  const [codexOauthAuthUrl, setCodexOauthAuthUrl] = useState("");
  const [codexOauthCallbackUrl, setCodexOauthCallbackUrl] = useState("");
  const [grokCliBusy, setGrokCliBusy] = useState(false);
  const [grokCliUserCode, setGrokCliUserCode] = useState("");
  const [grokCliVerifyUri, setGrokCliVerifyUri] = useState("");
  const [grokCliState, setGrokCliState] = useState<string | null>(null);
  const grokCliPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [claudeOauthBusy, setClaudeOauthBusy] = useState(false);
  const [claudeOauthAuthUrl, setClaudeOauthAuthUrl] = useState("");
  const [claudeOauthCode, setClaudeOauthCode] = useState("");
  const claudeOauthStateRef = useRef<string | null>(null);
  const [codebuddyChinaApiKey, setCodebuddyChinaApiKey] = useState("");
  const [codebuddyChinaBulkApiKeys, setCodebuddyChinaBulkApiKeys] = useState("");
  const [codebuddyChinaBusy, setCodebuddyChinaBusy] = useState(false);
  const [codebuddyChinaAccessToken, setCodebuddyChinaAccessToken] = useState("");
  const [codebuddyChinaUid, setCodebuddyChinaUid] = useState("");
  const [codebuddyChinaRefreshToken, setCodebuddyChinaRefreshToken] = useState("");
  const [codebuddyChinaTokenBusy, setCodebuddyChinaTokenBusy] = useState(false);
  const [codebuddyBulkApiKeys, setCodebuddyBulkApiKeys] = useState("");
  const [codebuddyBusy, setCodebuddyBusy] = useState(false);
  const [codebuddyOauthBusy, setCodebuddyOauthBusy] = useState(false);
  const [codebuddyOauthAuthUrl, setCodebuddyOauthAuthUrl] = useState("");
  const [codebuddyOauthState, setCodebuddyOauthState] = useState<string | null>(null);
  const codebuddyOauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [codebuddyAccessToken, setCodebuddyAccessToken] = useState("");
  const [codebuddyRefreshToken, setCodebuddyRefreshToken] = useState("");
  const [codebuddyTokenBusy, setCodebuddyTokenBusy] = useState(false);
  const [loginPendingDialog, setLoginPendingDialog] = useState(false);
  const [loginPendingConcurrency, setLoginPendingConcurrency] = useState(2);
  const [byokProviders, setByokProviders] = useState<ByokProvider[]>([]);
  const [byokDialogOpen, setByokDialogOpen] = useState(false);
  const [byokEditId, setByokEditId] = useState<number | null>(null);
  const [byokForm, setByokForm] = useState({
    label: "",
    base_url: "",
    api_key: "",
    format: "auto" as "openai" | "anthropic" | "auto",
    models: "",
    load_balancing_method: "round_robin" as "round_robin" | "sequential" | "least_inflight",
    keys: [{ label: "default", key: "", enabled: true }] as ByokFormKey[],
  });
  const [visibleByokSecrets, setVisibleByokSecrets] = useState<Set<string>>(new Set());
  const [revealingByokSecret, setRevealingByokSecret] = useState<string | null>(null);
  /** Per-provider test summary, keyed by provider id. */
  const [byokTest, setByokTest] = useState<
    Record<number, { state: "testing" | "ok" | "error"; progress?: string; okCount?: number; total?: number; avgLatency?: number; error?: string }>
  >({});
  /** Per-model test result, keyed by `${providerId}:${model}`. */
  const [byokModelTest, setByokModelTest] = useState<
    Record<string, { state: "testing" | "ok" | "error"; latency?: number; error?: string }>
  >({});
  const [byokFetchingModels, setByokFetchingModels] = useState(false);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codexOauthPopupRef = useRef<Window | null>(null);
  const codexOauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const codexOauthStateRef = useRef<string | null>(null);
  const loadingRef = useRef(false);

  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const [accountsRes, queueRes, warmupQueueRes, autoWarmupRes, settingsRes] = await Promise.all([
        fetchAccounts() as Promise<{ data: Account[] }>,
        fetchAuthQueue().catch(() => null),
        fetchWarmupQueue().catch(() => null),
        fetchAutoWarmupStatus().catch(() => null),
        fetchSettings().catch(() => null) as Promise<{ data: Record<string, string> } | null>,
      ]);
      setAccounts(accountsRes.data || []);
      setQueue(queueRes);
      setWarmupQueue(warmupQueueRes);
      setAutoWarmup(autoWarmupRes);
      setSettingsMap(settingsRes?.data || {});
      updateWarmupQueue(warmupQueueRes);

      // Load BYOK providers
      const byokRes = await fetchByokProviders();
      setByokProviders(byokRes.providers || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => {
      if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!autoWarmup?.nextRunAt) return;
    const targetMs = new Date(autoWarmup.nextRunAt).getTime();
    let refetched = false;
    const tick = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (!refetched && current >= targetMs) {
        refetched = true;
        setTimeout(() => {
          fetchAutoWarmupStatus().then(setAutoWarmup).catch(() => {});
          load();
        }, 1500);
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [autoWarmup?.nextRunAt]);

  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warmupReloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleReload = () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => { load(); }, 800);
  };

  function updateWarmupQueue(res: any) {
    if (!res?.data || typeof res.data !== "object") {
      setWarmupProgress({});
      return;
    }
    const next: Record<string, { total: number; completed: number; active: number }> = {};
    for (const [provider, val] of Object.entries(res.data)) {
      const info = val as any;
      const total = Number(info.total || 0);
      const completed = Number(info.completed || 0);
      const active = Number(info.active || 0);
      if (total > 0) {
        next[provider] = { total, completed, active };
      }
    }
    setWarmupProgress(next);
  }

  const warmupThrottleRef = useRef(false);
  const scheduleWarmupReload = () => {
    // Throttle: fire at most once per 800ms (not debounce which starves on rapid events)
    if (warmupThrottleRef.current) return;
    warmupThrottleRef.current = true;
    setTimeout(async () => {
      warmupThrottleRef.current = false;
      try {
        const res = await fetchWarmupQueue();
        updateWarmupQueue(res);
      } catch {}
    }, 800);
  };

  useEffect(() => () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    if (warmupReloadRef.current) clearTimeout(warmupReloadRef.current);
    if (codexOauthPollRef.current) clearInterval(codexOauthPollRef.current);
    if (codexOauthStateRef.current) {
      stopCodexOAuth(codexOauthStateRef.current).catch(() => {});
    }
    codexOauthPopupRef.current?.close();
  }, []);

  useEffect(() => {
    const pollId = codexOauthPollRef.current;
    return () => {
      if (pollId) clearInterval(pollId);
    };
  }, []);

  useWsEvent(["auto_warmup_status"], (msg) => {
    setAutoWarmup(msg.data);
  });

  useWsEvent([
    "warmup_queue_added", "warmup_processing",
    "warmup_success", "warmup_exhausted",
    "warmup_auth_error", "warmup_transient_error",
  ], scheduleWarmupReload);

  useWsEvent(["warmup_complete"], (msg) => {
    const provider = msg.data?.provider;
    if (provider) {
      // Show 100% briefly before clearing
      setWarmupProgress((prev) => {
        const existing = prev[provider];
        if (existing) return { ...prev, [provider]: { ...existing, completed: existing.total, active: 0 } };
        return prev;
      });
      // Clear after 2s so user sees completion
      setTimeout(() => {
        setWarmupProgress((prev) => {
          const next = { ...prev };
          delete next[provider];
          return next;
        });
      }, 2000);
    }
    scheduleReload();
  });

  useWsEvent(["warmup_queue_cleared"], () => {
    setWarmupProgress({});
  });

  useWsEvent(["account_status"], scheduleReload);

  useWsEvent(["byok_created", "byok_updated", "byok_deleted"], async () => {
    const byokRes = await fetchByokProviders();
    setByokProviders(byokRes.providers || []);
  });

  async function handleToggleAutoWarmup(provider: Provider) {
    const key = `auto_warmup_provider_${provider}`;
    const next = settingsMap[key] === "true" ? "false" : "true";
    setSettingsMap((current) => ({ ...current, [key]: next }));
    try {
      await updateSettings({ [key]: next });
      const status = await fetchAutoWarmupStatus();
      setAutoWarmup(status);
      showSuccess(`Auto WarmUp ${next === "true" ? "enabled" : "disabled"} for ${labelProvider(provider)}`);
    } catch (err) {
      setSettingsMap((current) => ({ ...current, [key]: next === "true" ? "false" : "true" }));
      showError(err);
    }
  }

  function autoWarmupEnabledFor(provider: Provider): boolean {
    return settingsMap[`auto_warmup_provider_${provider}`] === "true";
  }

  function countdownLabel(): string {
    if (!autoWarmup?.nextRunAt) return "—";
    const remaining = Math.max(0, new Date(autoWarmup.nextRunAt).getTime() - now);
    const totalSeconds = Math.floor(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  function showSuccess(text: string) {
    setMessage(text);
    setError(null);
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    messageTimerRef.current = setTimeout(() => setMessage(null), 4000);
  }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); setMessage(null); }

  async function handleAdd() {
    if (!addDialogProvider) return;
    try {
      const payload: any = { email: addForm.email, password: addForm.password, provider: addDialogProvider, headless: addForm.headless, browserEngine: addForm.browserEngine };
      await createAccount(payload);
      showSuccess("Account added and bot login started.");
      setAddForm({ email: "", password: "", provider: "codebuddy", browserEngine: "camoufox", headless: false });
      setAddDialogProvider(null);
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  async function handleInstantLogin() {
    if (!instantTokens.trim()) { showError(new Error("Paste refresh tokens (one per line)")); return; }
    const tokens = instantTokens.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (tokens.length === 0) { showError(new Error("No valid tokens found")); return; }

    try {
      const res = await fetchApi<{ success: number; failed: number; errors?: string[] }>("/api/accounts/instant-login", {
        method: "POST",
        body: JSON.stringify({ tokens, provider: addDialogProvider }),
      });
      showSuccess(`Instant login: ${res.success} success, ${res.failed} failed`);
      setInstantTokens("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
  }

  async function handleCodebuddyChinaApiKeyLogin() {
    const apiKey = codebuddyChinaApiKey.trim();
    if (!apiKey) { showError(new Error("Paste CodeBuddy China API key")); return; }
    if (!apiKey.startsWith("ck_")) {
      showError(new Error("CodeBuddy China API key must start with ck_"));
      return;
    }
    setCodebuddyChinaBusy(true);
    try {
      const res = await fetchApi<any>("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider: "codebuddy-china",
          apiKey,
        }),
      });
      const labelText = res?.email || "account";
      showSuccess(res?.updated
        ? `CodeBuddy CN key updated (${labelText})`
        : `CodeBuddy CN ${labelText} added successfully`);
      setCodebuddyChinaApiKey("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
    finally { setCodebuddyChinaBusy(false); }
  }

  async function handleCodeBuddyChinaBulkApiKey() {
    const keysText = codebuddyChinaBulkApiKeys.trim();
    if (!keysText) { showError(new Error("Paste CodeBuddy China API keys")); return; }
    
    const keys = keysText.split("\n").map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) { showError(new Error("No valid API keys found")); return; }
    
    for (const key of keys) {
      if (!key.startsWith("ck_")) {
        showError(new Error(`Invalid API key format: ${key} (must start with ck_)`));
        return;
      }
    }

    setCodebuddyChinaBusy(true);
    try {
      const res = await fetchApi<any>("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider: "codebuddy-china",
          apiKeys: keysText,
        }),
      });
      showSuccess(`Added ${res.count} CodeBuddy CN account(s) successfully`);
      setCodebuddyChinaBulkApiKeys("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
    finally { setCodebuddyChinaBusy(false); }
  }

  async function handleCodebuddyChinaAccessTokenImport() {
    const accessToken = codebuddyChinaAccessToken.trim();
    if (!accessToken) { showError(new Error("Paste CodeBuddy CN access_token")); return; }
    const uid = codebuddyChinaUid.trim();
    const refreshToken = codebuddyChinaRefreshToken.trim();
    setCodebuddyChinaTokenBusy(true);
    try {
      const res = await fetchApi<any>("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider: "codebuddy-china",
          accessToken,
          uid: uid || undefined,
          tokens: refreshToken ? { refresh_token: refreshToken } : undefined,
        }),
      });
      const labelText = res?.email || "account";
      showSuccess(res?.updated
        ? `CodeBuddy CN token updated (${labelText})`
        : `CodeBuddy CN ${labelText} added successfully`);
      setCodebuddyChinaAccessToken("");
      setCodebuddyChinaUid("");
      setCodebuddyChinaRefreshToken("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
    finally { setCodebuddyChinaTokenBusy(false); }
  }

  async function handleCodebuddyBulkApiKey() {
    const keysText = codebuddyBulkApiKeys.trim();
    if (!keysText) { showError(new Error("Paste CodeBuddy API keys")); return; }

    const keys = keysText.split("\n").map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) { showError(new Error("No valid API keys found")); return; }

    for (const key of keys) {
      if (!key.startsWith("ck_")) {
        showError(new Error(`Invalid API key format: ${key} (must start with ck_)`));
        return;
      }
    }

    setCodebuddyBusy(true);
    try {
      const res = await fetchApi<any>("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider: "codebuddy",
          apiKeys: keysText,
        }),
      });
      showSuccess(`Added ${res.count} CodeBuddy account(s) successfully`);
      setCodebuddyBulkApiKeys("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
    finally { setCodebuddyBusy(false); }
  }

  function clearCodebuddyOAuthPolling() {
    if (codebuddyOauthPollRef.current) {
      clearInterval(codebuddyOauthPollRef.current);
      codebuddyOauthPollRef.current = null;
    }
  }

  function resetCodebuddyOAuthFlow() {
    clearCodebuddyOAuthPolling();
    setCodebuddyOauthBusy(false);
    setCodebuddyOauthAuthUrl("");
    setCodebuddyOauthState(null);
  }

  async function handleCodebuddyOAuthLogin() {
    if (codebuddyOauthBusy) return;
    setCodebuddyOauthBusy(true);
    setError(null);
    clearCodebuddyOAuthPolling();

    try {
      const device = await startCodebuddyDeviceCode();
      setCodebuddyOauthState(device.state);
      setCodebuddyOauthAuthUrl(device.authUrl);
      window.open(device.authUrl, "_blank", "noopener,noreferrer");

      const intervalMs = Math.max(3, device.interval || 5) * 1000;
      codebuddyOauthPollRef.current = setInterval(async () => {
        try {
          const status = await pollCodebuddyOAuth(device.state);
          if (status.status === "done") {
            resetCodebuddyOAuthFlow();
            showSuccess(`CodeBuddy connected: ${status.connection?.displayName || status.connection?.email || "account added"}`);
            setAddDialogProvider(null);
            await load();
            return;
          }
          if (status.status === "error" || status.status === "expired" || status.status === "cancelled" || status.status === "unknown") {
            resetCodebuddyOAuthFlow();
            showError(new Error(status.error || "CodeBuddy OAuth failed"));
          }
        } catch (pollError) {
          resetCodebuddyOAuthFlow();
          showError(pollError);
        }
      }, intervalMs);
    } catch (err) {
      resetCodebuddyOAuthFlow();
      showError(err);
    }
  }

  async function handleCodebuddyOAuthCancel() {
    const state = codebuddyOauthState;
    resetCodebuddyOAuthFlow();
    if (state) {
      try { await cancelCodebuddyOAuth(state); } catch { /* ignore */ }
    }
  }

  async function handleCodebuddyAccessTokenImport() {
    const accessToken = codebuddyAccessToken.trim();
    if (!accessToken) { showError(new Error("Paste CodeBuddy access_token")); return; }
    const refreshToken = codebuddyRefreshToken.trim();
    setCodebuddyTokenBusy(true);
    try {
      const res = await fetchApi<any>("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider: "codebuddy",
          accessToken,
          tokens: refreshToken ? { refresh_token: refreshToken } : undefined,
        }),
      });
      const labelText = res?.email || "account";
      showSuccess(res?.updated
        ? `CodeBuddy token updated (${labelText})`
        : `CodeBuddy ${labelText} added successfully`);
      setCodebuddyAccessToken("");
      setCodebuddyRefreshToken("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
    finally { setCodebuddyTokenBusy(false); }
  }

  async function handleBulkImport() {
    if (!addDialogProvider || !bulkText.trim()) { showError(new Error("Paste email|password lines")); return; }
    try {
      const opts: any = { headless: bulkHeadless, browserEngine: bulkBrowserEngine, concurrency: bulkConcurrency };
      const res = await importAccounts(bulkText, [addDialogProvider], opts) as any;
      showSuccess(res.message || "Bulk import queued.");
      setBulkText("");
      setAddDialogProvider(null);
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  function clearCodexOAuthPolling() {
    if (codexOauthPollRef.current) {
      clearInterval(codexOauthPollRef.current);
      codexOauthPollRef.current = null;
    }
  }

  function resetCodexOAuthFlow() {
    clearCodexOAuthPolling();
    codexOauthPopupRef.current?.close();
    codexOauthPopupRef.current = null;
    codexOauthStateRef.current = null;
    setCodexOauthBusy(false);
    setCodexOauthAuthUrl("");
    setCodexOauthCallbackUrl("");
  }

  async function safeCopyText(text: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      showSuccess(successMessage);
    } catch (err) {
      showError(err);
    }
  }

  function isCodexCallbackUrlValid(value: string) {
    try {
      const url = new URL(value.trim());
      return !!url.searchParams.get("code") && !!url.searchParams.get("state");
    } catch {
      return false;
    }
  }

  const hasPreparedCodexOAuth = !!codexOauthStateRef.current && !!codexOauthAuthUrl;
  const codexCallbackReady = isCodexCallbackUrlValid(codexOauthCallbackUrl);
  const codexCallbackExample = "http://localhost:1455/auth/callback?code=...&state=...";
  const codexLoopbackUrl = "http://localhost:1455/auth/callback";

  async function startCodexOAuthSession() {
    const redirectUri = codexLoopbackUrl;
    const appPort = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
    const auth = await getCodexAuthorize(redirectUri);
    await startCodexOAuthProxy({
      appPort,
      state: auth.state,
      codeVerifier: auth.codeVerifier,
      redirectUri: auth.redirectUri,
    });
    codexOauthStateRef.current = auth.state;
    setCodexOauthAuthUrl(auth.authUrl);
    setCodexOauthCallbackUrl("");
    return auth;
  }

  function finishCodexOAuthSuccess(status: Awaited<ReturnType<typeof pollCodexOAuthStatus>>) {
    resetCodexOAuthFlow();
    showSuccess(`Codex connected: ${status.connection?.displayName || status.connection?.email || "account added"}`);
    setAddDialogProvider(null);
    load();
  }

  function beginCodexOAuthPolling() {
    clearCodexOAuthPolling();
    codexOauthPollRef.current = setInterval(async () => {
      const state = codexOauthStateRef.current;
      if (!state) return;

      try {
        const status = await pollCodexOAuthStatus(state);
        if (status.status === "done") {
          finishCodexOAuthSuccess(status);
          return;
        }

        if (status.status === "error" || status.status === "cancelled" || status.status === "not_found" || status.status === "unknown") {
          resetCodexOAuthFlow();
          showError(new Error(status.error || "Codex OAuth failed"));
        }
      } catch (pollError) {
        resetCodexOAuthFlow();
        showError(pollError);
      }
    }, 1500);
  }

  async function handleCodexOAuthLogin() {
    if (codexOauthBusy) return;
    setCodexOauthBusy(true);
    setError(null);

    try {
      const auth = await startCodexOAuthSession();
      codexOauthPopupRef.current = window.open(auth.authUrl, "codex_oauth_popup", "width=640,height=800");
      if (!codexOauthPopupRef.current) {
        window.open(auth.authUrl, "_blank", "noopener,noreferrer");
      }
      beginCodexOAuthPolling();
    } catch (err) {
      resetCodexOAuthFlow();
      showError(err);
    }
  }

  async function handleCodexOAuthPrepareManual() {
    if (codexOauthBusy || hasPreparedCodexOAuth) return;
    setCodexOauthBusy(true);
    setError(null);

    try {
      await startCodexOAuthSession();
      beginCodexOAuthPolling();
      setCodexOauthBusy(false);
      showSuccess("Auth URL ready. Open it, login, lalu paste callback URL di bawah.");
    } catch (err) {
      resetCodexOAuthFlow();
      showError(err);
    }
  }

  async function handleCodexOAuthSubmitManual() {
    if (codexOauthBusy || !codexCallbackReady) return;
    setCodexOauthBusy(true);
    setError(null);

    try {
      await completeCodexOAuthCallbackUrl(codexOauthCallbackUrl);
      const state = codexOauthStateRef.current;
      if (!state) {
        resetCodexOAuthFlow();
        showSuccess("Codex connected");
        setAddDialogProvider(null);
        await load();
        return;
      }
      const status = await pollCodexOAuthStatus(state);
      finishCodexOAuthSuccess(status);
    } catch (err) {
      setCodexOauthBusy(false);
      showError(err);
    }
  }

  function clearGrokCliPolling() {
    if (grokCliPollRef.current) {
      clearInterval(grokCliPollRef.current);
      grokCliPollRef.current = null;
    }
  }

  function resetGrokCliOAuthFlow() {
    clearGrokCliPolling();
    setGrokCliBusy(false);
    setGrokCliUserCode("");
    setGrokCliVerifyUri("");
    setGrokCliState(null);
  }

  async function handleGrokCliDeviceLogin() {
    if (grokCliBusy) return;
    setGrokCliBusy(true);
    setError(null);
    clearGrokCliPolling();

    try {
      const device = await startGrokCliDeviceCode();
      setGrokCliState(device.state);
      setGrokCliUserCode(device.userCode);
      setGrokCliVerifyUri(device.verificationUriComplete || device.verificationUri);

      const uri = device.verificationUriComplete || device.verificationUri;
      if (uri) window.open(uri, "_blank", "noopener,noreferrer");

      let intervalMs = Math.max(3, device.interval || 5) * 1000;
      grokCliPollRef.current = setInterval(async () => {
        const state = device.state;
        try {
          const status = await pollGrokCliOAuth(state);
          if (status.status === "done") {
            clearGrokCliPolling();
            setGrokCliBusy(false);
            setGrokCliUserCode("");
            setGrokCliVerifyUri("");
            setGrokCliState(null);
            showSuccess(`Grok CLI connected: ${status.connection?.displayName || status.connection?.email || "account added"}`);
            setAddDialogProvider(null);
            await load();
            return;
          }
          if (status.status === "pending") {
            if (status.interval && status.interval * 1000 !== intervalMs) {
              intervalMs = Math.max(3, status.interval) * 1000;
              clearGrokCliPolling();
              // re-arm with slower interval (slow_down)
              grokCliPollRef.current = setInterval(async () => {
                try {
                  const s2 = await pollGrokCliOAuth(state);
                  if (s2.status === "done") {
                    clearGrokCliPolling();
                    setGrokCliBusy(false);
                    setGrokCliUserCode("");
                    setGrokCliVerifyUri("");
                    setGrokCliState(null);
                    showSuccess(`Grok CLI connected: ${s2.connection?.displayName || s2.connection?.email || "account added"}`);
                    setAddDialogProvider(null);
                    await load();
                  } else if (s2.status === "error" || s2.status === "expired" || s2.status === "cancelled" || s2.status === "unknown") {
                    resetGrokCliOAuthFlow();
                    showError(new Error(s2.error || "Grok CLI OAuth failed"));
                  }
                } catch (e) {
                  resetGrokCliOAuthFlow();
                  showError(e);
                }
              }, intervalMs);
            }
            return;
          }
          if (status.status === "error" || status.status === "expired" || status.status === "cancelled" || status.status === "unknown") {
            resetGrokCliOAuthFlow();
            showError(new Error(status.error || "Grok CLI OAuth failed"));
          }
        } catch (pollError) {
          resetGrokCliOAuthFlow();
          showError(pollError);
        }
      }, intervalMs);
    } catch (err) {
      resetGrokCliOAuthFlow();
      showError(err);
    }
  }

  async function handleGrokCliCancel() {
    const state = grokCliState;
    resetGrokCliOAuthFlow();
    if (state) {
      try { await cancelGrokCliOAuth(state); } catch { /* ignore */ }
    }
  }

  async function handleCodexOAuthCopyAuthUrl() {
    if (!codexOauthAuthUrl) return;
    await safeCopyText(codexOauthAuthUrl, "Auth URL copied");
  }

  function handleCodexOAuthOpenManual() {
    if (!codexOauthAuthUrl) return;
    window.open(codexOauthAuthUrl, "_blank", "noopener,noreferrer");
  }

  async function handleCodexOAuthPasteCallback() {
    try {
      const text = await navigator.clipboard.readText();
      setCodexOauthCallbackUrl(text);
    } catch (err) {
      showError(err);
    }
  }

  function resetClaudeOAuthFlow() {
    claudeOauthStateRef.current = null;
    setClaudeOauthBusy(false);
    setClaudeOauthAuthUrl("");
    setClaudeOauthCode("");
  }

  async function handleClaudeOAuthStart() {
    if (claudeOauthBusy) return;
    setClaudeOauthBusy(true);
    setError(null);
    try {
      const auth = await startClaudeOAuth();
      claudeOauthStateRef.current = auth.state;
      setClaudeOauthAuthUrl(auth.authUrl);
      setClaudeOauthCode("");
      window.open(auth.authUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      showError(err);
      resetClaudeOAuthFlow();
    } finally {
      setClaudeOauthBusy(false);
    }
  }

  async function handleClaudeOAuthCopyAuthUrl() {
    if (!claudeOauthAuthUrl) return;
    await safeCopyText(claudeOauthAuthUrl, "Auth URL copied");
  }

  async function handleClaudeOAuthSubmitCode() {
    const state = claudeOauthStateRef.current;
    const code = claudeOauthCode.trim();
    if (!state) {
      showError(new Error("Start OAuth first"));
      return;
    }
    if (!code) {
      showError(new Error("Paste authorization code (or CODE#STATE)"));
      return;
    }
    setClaudeOauthBusy(true);
    try {
      const result = await completeClaudeOAuth({ state, code });
      resetClaudeOAuthFlow();
      showSuccess(`Claude connected: ${result.connection?.displayName || result.connection?.email || "account added"}`);
      setAddDialogProvider(null);
      await load();
    } catch (err) {
      setClaudeOauthBusy(false);
      showError(err);
    }
  }

  function handleOpenAddDialog(provider: Provider) {
    resetCodexOAuthFlow();
    resetGrokCliOAuthFlow();
    resetClaudeOAuthFlow();
    if (provider === "codex") {
      setAddMode("pat");
    }
    if (provider === "grok-cli") {
      setAddMode("pat");
    }
    if (provider === "claude") {
      setAddMode("pat");
    }
    if (provider === "codebuddy") {
      setAddMode("oauth");
    }
    if (provider === "codebuddy-china") {
      setAddMode("apikey");
    }
    setAddDialogProvider(provider);
  }

  function handleCloseAddDialog() {
    const state = codexOauthStateRef.current;
    resetCodexOAuthFlow();
    if (state) {
      stopCodexOAuth(state).catch(() => {});
    }
    const claudeState = claudeOauthStateRef.current;
    resetClaudeOAuthFlow();
    if (claudeState) {
      cancelClaudeOAuth(claudeState).catch(() => {});
    }
    handleGrokCliCancel();
    setCodebuddyChinaBulkApiKeys("");
    setCodebuddyBulkApiKeys("");
    setCodebuddyAccessToken("");
    setCodebuddyRefreshToken("");
    resetCodebuddyOAuthFlow();
    setAddDialogProvider(null);
  }

  function handleSetCodexMode(mode: typeof addMode) {
    if (mode === addMode) return;
    const state = codexOauthStateRef.current;
    resetCodexOAuthFlow();
    if (state) {
      stopCodexOAuth(state).catch(() => {});
    }
    setAddMode(mode);
  }

  async function handleLoginAll() {
    setLoginPendingDialog(true);
  }

  async function confirmLoginAll() {
    setLoginPendingDialog(false);
    try {
      const res = await loginAllAccounts({ concurrency: loginPendingConcurrency }) as any;
      showSuccess(res.message || "Login all queued.");
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  async function handleWarmupProvider(provider: Provider) {
    try {
      const res = await warmupAllAccounts({ providers: [provider], statuses: ["active", "exhausted", "error"] }) as any;
      showSuccess(res.message || `${labelProvider(provider)} WarmUp queued.`);
      // Immediately set progress to show the bar (don't wait for WS event / fetch)
      const count = res.count || 0;
      if (count > 0) {
        setWarmupProgress((prev) => ({ ...prev, [provider]: { total: count, completed: 0, active: 0 } }));
      }
      // Delay load slightly to let server finish enqueueing before we fetch progress
      setTimeout(() => { load(); }, 300);
    } catch (err) { showError(err); }
  }

  async function handleRetryErrors(provider: Provider) {
    const ids = accounts.filter((a) => a.provider === provider && a.status === "error").map((a) => a.id);
    if (ids.length === 0) return;
    await loginAccounts(ids);
    showSuccess(`Queued ${ids.length} ${labelProvider(provider)} error accounts for retry.`);
    await load();
  }

  const BYOK_KEY_PLACEHOLDER = "••••••••";

  const emptyByokForm = () => ({
    label: "",
    base_url: "",
    api_key: "",
    format: "auto" as "openai" | "anthropic" | "auto",
    models: "",
    load_balancing_method: "round_robin" as "round_robin" | "sequential" | "least_inflight",
    keys: [{ label: "default", key: "", enabled: true }] as ByokFormKey[],
  });

  function byokSecretVisibilityId(key: ByokFormKey, index: number) {
    return key.id ? `id-${key.id}` : `new-${index}`;
  }

  async function toggleByokSecretVisibility(key: ByokFormKey, index: number) {
    const visibilityId = byokSecretVisibilityId(key, index);
    const isVisible = visibleByokSecrets.has(visibilityId);

    if (isVisible) {
      setVisibleByokSecrets((current) => {
        const next = new Set(current);
        next.delete(visibilityId);
        return next;
      });
      return;
    }

    if (key.id && key.key === BYOK_KEY_PLACEHOLDER) {
      setRevealingByokSecret(visibilityId);
      try {
        const revealed = await revealByokKey(key.id);
        updateByokKeyRow(index, { key: revealed.key });
      } catch (err) {
        showError(err);
        setRevealingByokSecret(null);
        return;
      }
      setRevealingByokSecret(null);
    }

    setVisibleByokSecrets((current) => {
      const next = new Set(current);
      next.add(visibilityId);
      return next;
    });
  }

  function addByokKeyRow() {
    setByokForm((form) => ({
      ...form,
      keys: [...form.keys, { label: `key-${form.keys.length + 1}`, key: "", enabled: true }],
    }));
  }

  function updateByokKeyRow(index: number, patch: Partial<ByokFormKey>) {
    setByokForm((form) => ({
      ...form,
      keys: form.keys.map((key, i) => i === index ? { ...key, ...patch } : key),
    }));
  }

  function removeByokKeyRow(index: number) {
    setByokForm((form) => ({
      ...form,
      keys: form.keys.length <= 1
        ? [{ label: "default", key: "", enabled: true }]
        : form.keys.filter((_, i) => i !== index),
    }));
  }

  function buildByokKeyPayload(isEdit: boolean) {
    return byokForm.keys.map((key, index) => ({
      id: key.id,
      label: key.label.trim().toLowerCase() || `key-${index + 1}`,
      key: key.key && key.key !== BYOK_KEY_PLACEHOLDER ? key.key.trim() : undefined,
      enabled: key.enabled,
      priority: index,
    })).filter((key) => isEdit || Boolean(key.key));
  }

  async function handleFetchByokModels() {
    if (!byokForm.base_url.trim()) {
      showError(new Error("Base URL is required"));
      return;
    }
    let apiKey = byokForm.api_key.trim();
    if (!apiKey) {
      for (const key of byokForm.keys) {
        if (key.key && key.key !== BYOK_KEY_PLACEHOLDER) { apiKey = key.key.trim(); break; }
        if (key.id && key.key === BYOK_KEY_PLACEHOLDER) {
          try {
            const revealed = await revealByokKey(key.id);
            if (revealed.key) { apiKey = revealed.key.trim(); break; }
          } catch (err) { /* try next key */ }
        }
      }
    }
    if (!apiKey) {
      showError(new Error("At least one API key is required"));
      return;
    }
    setByokFetchingModels(true);
    try {
      const res = await fetchByokModels({
        base_url: byokForm.base_url.trim(),
        api_key: apiKey,
        format: byokForm.format,
      });
      if (res.error) { showError(new Error(res.error)); return; }
      const existing = new Set(byokForm.models.split(",").map((m) => m.trim()).filter(Boolean));
      const added = (res.models || []).filter((m) => !existing.has(m));
      setByokForm((f) => ({
        ...f,
        models: [...new Set([...existing, ...added])].join(", "),
      }));
      showSuccess(`Fetched ${res.models.length} models — added ${added.length} new`);
    } catch (err) {
      showError(err);
    } finally {
      setByokFetchingModels(false);
    }
  }

  async function handleAddByok() {
    if (!byokForm.label || !byokForm.base_url || !byokForm.models) {
      showError(new Error("Provider name, base URL, and models are required"));
      return;
    }

    const models = byokForm.models.split(",").map(m => m.trim()).filter(Boolean);
    const apiKeys = buildByokKeyPayload(false);
    if (models.length === 0) {
      showError(new Error("At least one model is required"));
      return;
    }
    if (apiKeys.length === 0) {
      showError(new Error("Add at least one API key"));
      return;
    }

    try {
      const created = await createByokProvider({
        label: byokForm.label.trim().toLowerCase(),
        base_url: byokForm.base_url.trim(),
        api_keys: apiKeys,
        format: byokForm.format,
        load_balancing_method: byokForm.load_balancing_method,
        models,
      });
      showSuccess(`BYOK provider "${created.label}" created with ${created.key_count || apiKeys.length} key(s)`);
      setByokForm(emptyByokForm());
      setByokEditId(null);
      setByokDialogOpen(false);
      await load();
    } catch (err) {
      showError(err);
    }
  }

  async function handleUpdateByok() {
    if (byokEditId === null) return;
    if (!byokForm.base_url || !byokForm.models) {
      showError(new Error("Base URL and models are required"));
      return;
    }

    const models = byokForm.models.split(",").map(m => m.trim()).filter(Boolean);
    const apiKeys = buildByokKeyPayload(true);
    if (models.length === 0) {
      showError(new Error("At least one model is required"));
      return;
    }
    if (apiKeys.length === 0) {
      showError(new Error("At least one key row is required"));
      return;
    }

    try {
      await updateByokProvider(byokEditId, {
        base_url: byokForm.base_url.trim(),
        format: byokForm.format,
        load_balancing_method: byokForm.load_balancing_method,
        models,
        api_keys: apiKeys,
      });
      showSuccess(`BYOK provider "${byokForm.label}" updated successfully`);
      setByokForm(emptyByokForm());
      setByokEditId(null);
      setByokDialogOpen(false);
      await load();
    } catch (err) {
      showError(err);
    }
  }

  function copyByokModel(model: string) {
    navigator.clipboard?.writeText(model).then(() => {
      showSuccess(`Copied ${model}`);
    }).catch(() => showError(new Error("Clipboard not available")));
  }

  function handleEditByok(provider: ByokProvider) {
    setByokEditId(provider.id);
    setByokForm({
      label: provider.label,
      base_url: provider.base_url,
      api_key: BYOK_KEY_PLACEHOLDER,
      format: provider.format,
      models: provider.models.join(", "),
      load_balancing_method: provider.load_balancing_method || "round_robin",
      keys: (provider.keys && provider.keys.length > 0
        ? provider.keys.map((key, index) => ({
            id: key.id,
            label: key.label,
            key: BYOK_KEY_PLACEHOLDER,
            enabled: key.enabled !== false,
            status: key.status,
            errorMessage: key.errorMessage,
          }))
        : [{ id: provider.id, label: "default", key: BYOK_KEY_PLACEHOLDER, enabled: true }]) as ByokFormKey[],
    });
    setByokDialogOpen(true);
  }

  function handleCloseByokDialog() {
    setByokForm(emptyByokForm());
    setByokEditId(null);
    setByokDialogOpen(false);
  }

  /** Test every configured model of a provider, sequentially, one request each. */
  async function handleTestByok(provider: ByokProvider) {    const models = provider.models?.length ? provider.models : provider.available_models || [];
    if (!models.length) {
      setByokTest((m) => ({ ...m, [provider.id]: { state: "error", error: "No models configured" } }));
      return;
    }

    const results: { ok: boolean; latency?: number; error?: string }[] = [];
    let autoFixed = false;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      setByokTest((m) => ({ ...m, [provider.id]: { state: "testing", progress: `${i + 1}/${models.length}` } }));
      setByokModelTest((m) => ({ ...m, [`${provider.id}:${model}`]: { state: "testing" } }));
      try {
        const result = await testByokProvider(provider.id, model);
        if (result.success) {
          results.push({ ok: true, latency: result.latency_ms });
          setByokModelTest((m) => ({ ...m, [`${provider.id}:${model}`]: { state: "ok", latency: result.latency_ms } }));
          if (result.auto_fixed) autoFixed = true;
        } else {
          results.push({ ok: false, error: result.error || "Test failed" });
          setByokModelTest((m) => ({ ...m, [`${provider.id}:${model}`]: { state: "error", error: result.error || "Test failed" } }));
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : "Test failed";
        results.push({ ok: false, error });
        setByokModelTest((m) => ({ ...m, [`${provider.id}:${model}`]: { state: "error", error } }));
      }
    }

    if (autoFixed) await load();

    const okCount = results.filter((r) => r.ok).length;
    const latencies = results.filter((r) => r.ok && r.latency != null).map((r) => r.latency!);
    const avgLatency = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : undefined;
    const firstError = results.find((r) => !r.ok)?.error;
    setByokTest((m) => ({
      ...m,
      [provider.id]: {
        state: okCount === models.length ? "ok" : "error",
        okCount,
        total: models.length,
        avgLatency,
        error: okCount < models.length ? firstError : undefined,
      },
    }));
  }

  async function handleDeleteByok(id: number, label: string) {
    if (!confirm(`Delete BYOK provider "${label}"? This cannot be undone.`)) return;

    try {
      await deleteByokProvider(id);
      showSuccess(`BYOK provider "${label}" deleted`);
      await load();
    } catch (err) {
      showError(err);
    }
  }

  const providerStats = useMemo(() => {
    return providers.map((provider) => {
      const rows = accounts.filter((a) => a.provider === provider);
      const quotaLimit = rows.reduce((sum, a) => sum + (a.quotaLimit || 0), 0);
      const quotaRemaining = rows.reduce((sum, a) => sum + (a.quotaRemaining || 0), 0);
      return {
        provider,
        total: rows.length,
        active: rows.filter((a) => a.status === "active").length,
        exhausted: rows.filter((a) => a.status === "exhausted").length,
        pending: rows.filter((a) => a.status === "pending").length,
        error: rows.filter((a) => a.status === "error").length,
        credits: { used: Math.max(0, quotaLimit - quotaRemaining), total: quotaLimit, remaining: quotaRemaining },
      };
    });
  }, [accounts]);

  const totals = useMemo(
    () => ({
      accounts: accounts.length,
      active: accounts.filter((a) => a.status === "active").length,
      pending: accounts.filter((a) => a.status === "pending").length,
      error: accounts.filter((a) => a.status === "error").length,
    }),
    [accounts]
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Accounts"
        meta={
          <>
            <span>{totals.accounts} accounts</span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span className={totals.active > 0 ? "text-[var(--success)]" : undefined}>{totals.active} active</span>
            {totals.pending > 0 && (
              <>
                <span aria-hidden className="text-[var(--border)]">·</span>
                <span className="text-[var(--warning)]">{totals.pending} pending</span>
              </>
            )}
            {totals.error > 0 && (
              <>
                <span aria-hidden className="text-[var(--border)]">·</span>
                <span className="text-[var(--error)]">{totals.error} error</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleLoginAll}>
              <Play className="w-3.5 h-3.5" /> Login pending
            </Button>
          </>
        }
      />

      {(message || error) && (
        <p className={`border-l-2 px-3 py-2 font-mono text-[11px] ${message ? "border-[var(--success)] bg-[var(--success)]/8 text-[var(--success)]" : "border-[var(--error)] bg-[var(--error)]/8 text-[var(--error)]"}`}>
          {message || error}
        </p>
      )}

      {/* Queue status - Login only */}
      {(Number(queue?.active || 0) > 0 || Number(queue?.queued || 0) > 0) && (
        <p className="border-l-2 border-[var(--warning)] bg-[var(--warning)]/8 px-3 py-2 font-mono text-[11px] text-[var(--warning)]">
          Login: {Number(queue?.active || 0)} running · {Number(queue?.queued || 0)} queued
        </p>
      )}

      {/* Provider cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {providerStats.map((stat) => (
          <Card
            key={stat.provider}
            className="overflow-hidden border-[var(--border)] cursor-pointer hover:border-[var(--primary)]/50 transition-colors"
            onClick={() => navigate(`/accounts/${stat.provider}`)}
          >
            <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
              <h2 className="eyebrow truncate text-[var(--foreground)]">{labelProvider(stat.provider)}</h2>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
                {stat.total} accounts
              </span>
            </div>

            {/* Status readout: one divided strip, same as VccPool / BotLogs */}
            <div className="grid grid-cols-4 divide-x divide-[var(--border)] border-b border-[var(--border)]">
              <Stat label="Active" value={stat.active} tone={stat.active > 0 ? "var(--success)" : undefined} />
              <Stat label="Exhausted" value={stat.exhausted} tone={stat.exhausted > 0 ? "var(--warning)" : undefined} />
              <Stat label="Pending" value={stat.pending} tone={stat.pending > 0 ? "var(--warning)" : undefined} />
              <Stat label="Error" value={stat.error} tone={stat.error > 0 ? "var(--error)" : undefined} />
            </div>

            <div className="space-y-3 px-4 py-3">
              {/* Credits remaining */}
              <div className="space-y-1.5">
                <div className="flex justify-between font-mono text-[11px]">
                  <span className="eyebrow">Credits</span>
                  <span className="tabular-nums text-[var(--foreground)]">
                    {stat.credits.remaining.toFixed(1)} / {stat.credits.total.toFixed(1)}
                  </span>
                </div>
                <Progress
                  value={stat.credits.total > 0 ? Math.round((stat.credits.remaining / stat.credits.total) * 100) : 0}
                  className="h-1.5"
                />
              </div>

              {/* WarmUp progress - shown while warmup is active */}
              {warmupProgress[stat.provider] && warmupProgress[stat.provider].total > 0 && (
                <div className="space-y-1.5">
                  <div className="flex justify-between font-mono text-[11px]">
                    <span className="eyebrow">WarmUp</span>
                    <span className="tabular-nums text-[var(--foreground)]">
                      {warmupProgress[stat.provider].completed} / {warmupProgress[stat.provider].total}
                    </span>
                  </div>
                  <Progress
                    value={warmupProgress[stat.provider].total > 0 ? Math.round((warmupProgress[stat.provider].completed / warmupProgress[stat.provider].total) * 100) : 0}
                    className="h-1.5"
                  />
                </div>
              )}

              {/* Auto WarmUp toggle + countdown */}
              <div
                className="flex items-center justify-between gap-2 border-t border-[var(--hairline)] pt-3"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Flame className={`h-3.5 w-3.5 shrink-0 ${autoWarmupEnabledFor(stat.provider) ? "text-[var(--warning)]" : "text-[var(--muted-foreground)]"}`} />
                  <div className="min-w-0">
                    <p className="eyebrow">Auto WarmUp</p>
                    <p className="font-mono text-[10px] leading-tight text-[var(--muted-foreground)]">
                      {autoWarmupEnabledFor(stat.provider)
                        ? autoWarmup?.nextRunAt
                          ? `next in ${countdownLabel()} · every ${autoWarmup.intervalMinutes}m`
                          : `every ${autoWarmup?.intervalMinutes ?? 15}m`
                        : "disabled"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleAutoWarmup(stat.provider)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    autoWarmupEnabledFor(stat.provider) ? "bg-[var(--primary)]" : "bg-[var(--border)]"
                  }`}
                  aria-label={`Toggle auto warmup for ${labelProvider(stat.provider)}`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      autoWarmupEnabledFor(stat.provider) ? "translate-x-5" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>

              {/* Buttons */}
              <div className="grid grid-cols-3 gap-2" onClick={(e) => e.stopPropagation()}>
                <Button className="w-full" variant="default" size="sm" onClick={() => handleOpenAddDialog(stat.provider)}>
                  <Plus className="h-3.5 w-3.5" /> Add
                </Button>
                <Button className="w-full" variant="outline" size="sm" onClick={() => handleWarmupProvider(stat.provider)} disabled={Boolean(warmupProgress[stat.provider])}>
                  <RefreshCw className="h-3.5 w-3.5" /> Warmup
                </Button>
                <Button className="w-full" variant="outline" size="sm" onClick={() => handleRetryErrors(stat.provider)} disabled={stat.error === 0}>
                  <RotateCcw className="h-3.5 w-3.5" /> Retry
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* BYOK Providers Section — a section rule, not a hero block */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <Key className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
            <h2 className="eyebrow text-[var(--foreground)]">Custom Providers (BYOK)</h2>
            <span className="hidden font-mono text-[11px] tabular-nums text-[var(--muted-foreground)] sm:inline">
              <span aria-hidden className="text-[var(--border)]">│</span> {byokProviders.length} configured
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={() => setByokDialogOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Add Provider
          </Button>
        </div>

        {byokProviders.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--border)] px-4 py-8 text-center">
            <Shield className="mx-auto h-6 w-6 text-[var(--muted-foreground)]/40" />
            <p className="mt-2 font-mono text-[12px] text-[var(--foreground)]">No custom providers configured</p>
            <p className="mt-1 font-mono text-[11px] text-[var(--muted-foreground)]">Bring your own key — route custom models through your own API keys.</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => setByokDialogOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Add Your First Provider
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {byokProviders.map((provider) => (
              <Card
                key={provider.id}
                className="cursor-pointer overflow-hidden transition-colors duration-150 hover:border-[var(--primary)]/50"
                onClick={() => navigate(`/accounts/byok/${provider.label}`)}
              >
                <div className="border-b border-[var(--border)] px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="eyebrow truncate text-[var(--foreground)]">{provider.label}</h3>
                        <span className={`font-mono text-[10px] uppercase tracking-[0.08em] ${(provider.active_key_count || 0) > 0 ? "text-[var(--success)]" : "text-[var(--warning)]"}`}>
                          {(provider.active_key_count || 0) > 0 ? "● ready" : "○ no active key"}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-[11px] text-[var(--muted-foreground)]">{provider.base_url}</p>
                    </div>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 -rotate-90 text-[var(--muted-foreground)]" />
                  </div>
                </div>

                {/* Readout strip — same divided pattern as the OAuth cards above */}
                <div className="grid grid-cols-3 divide-x divide-[var(--border)] border-b border-[var(--border)]">
                  <Stat label="Format" value={provider.format} />
                  <Stat label="Models" value={provider.models.length} />
                  <Stat
                    label="Keys"
                    value={`${provider.active_key_count ?? 0}/${provider.key_count ?? provider.keys?.length ?? 1}`}
                    tone={(provider.active_key_count || 0) > 0 ? "var(--success)" : "var(--warning)"}
                  />
                </div>

                <div className="space-y-3 px-4 py-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="eyebrow">Models</p>
                      <p className="font-mono text-[10px] text-[var(--muted-foreground)]/70">click id to copy · ⚡ to test</p>
                    </div>
                    <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto">
                      {byokChipModels(provider).slice(0, 10).map((model) => {
                        const mt = byokModelTest[`${provider.id}:${model}`];
                        const configured = provider.models?.includes(model);
                        return (
                          <span
                            key={model}
                            className={`inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pl-2 pr-1 font-mono text-[11px] ${
                              mt?.state === "error"
                                ? "border-[var(--error)]/30 bg-[var(--error)]/10 text-[var(--error)]"
                                : mt?.state === "ok"
                                  ? "border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]"
                                  : configured
                                    ? "border-[var(--primary)]/20 bg-[var(--primary)]/[0.05] text-[var(--primary)]/80"
                                    : "border-dashed border-[var(--border)] bg-transparent text-[var(--muted-foreground)]"
                            }`}
                            title={mt?.error || (configured ? model : `${model} (discovered, not in routing list)`)}
                          >
                            <span
                              className="cursor-copy truncate"
                              onClick={(e) => { e.stopPropagation(); copyByokModel(model); }}
                              title="Click to copy model id"
                            >
                              {model}
                            </span>
                            {mt?.state === "ok" && mt.latency != null && (
                              <span className="shrink-0 tabular-nums opacity-80">{mt.latency}ms</span>
                            )}
                            <button
                              type="button"
                              className="shrink-0 cursor-pointer rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
                              aria-label={`Test ${model}`}
                              title={`Test ${model}`}
                              disabled={mt?.state === "testing"}
                              onClick={(e) => {
                                e.stopPropagation();
                                setByokModelTest((m) => ({ ...m, [`${provider.id}:${model}`]: { state: "testing" } }));
                                testByokProvider(provider.id, model)
                                  .then((result) => {
                                    setByokModelTest((m) => ({
                                      ...m,
                                      [`${provider.id}:${model}`]: result.success
                                        ? { state: "ok", latency: result.latency_ms }
                                        : { state: "error", error: result.error || "Test failed" },
                                    }));
                                    if (result.auto_fixed) load();
                                  })
                                  .catch((err) => {
                                    setByokModelTest((m) => ({
                                      ...m,
                                      [`${provider.id}:${model}`]: { state: "error", error: err instanceof Error ? err.message : "Test failed" },
                                    }));
                                  });
                              }}
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
                      {byokChipModels(provider).length > 10 && (
                        <span className="inline-flex items-center rounded-full border border-[var(--border)] px-2 py-0.5 font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
                          +{byokChipModels(provider).length - 10} more
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 border-t border-[var(--hairline)] pt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); navigate(`/accounts/byok/${provider.label}`); }}
                    >
                      <Pencil className="h-3.5 w-3.5" /> Manage
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-[var(--info)]/30 text-[var(--info)] hover:bg-[var(--info)]/10 hover:text-[var(--info)]"
                      onClick={(e) => { e.stopPropagation(); handleTestByok(provider); }}
                    >
                      {byokTest[provider.id]?.state === "testing" ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Zap className="h-3.5 w-3.5" />
                      )}
                      Test
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-[var(--error)]/30 text-[var(--error)] hover:bg-[var(--error)]/10 hover:text-[var(--error)]"
                      onClick={(e) => { e.stopPropagation(); handleDeleteByok(provider.id, provider.label); }}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  </div>
                  {byokTest[provider.id] && (
                    <div
                      role="status"
                      className={`border-l-2 px-3 py-2 font-mono text-[11px] ${
                        byokTest[provider.id].state === "testing"
                          ? "border-[var(--border)] bg-[var(--secondary)]/50 text-[var(--muted-foreground)]"
                          : byokTest[provider.id].state === "ok"
                            ? "border-[var(--success)] bg-[var(--success)]/8 text-[var(--success)]"
                            : "border-[var(--error)] bg-[var(--error)]/8 text-[var(--error)]"
                      }`}
                    >
                      {byokTest[provider.id].state === "testing" &&
                        `Testing models ${byokTest[provider.id].progress || ""}...`}
                      {byokTest[provider.id].state === "ok" &&
                        `✓ ${byokTest[provider.id].okCount}/${byokTest[provider.id].total} models OK${byokTest[provider.id].avgLatency ? ` · avg ${byokTest[provider.id].avgLatency}ms` : ""}`}
                      {byokTest[provider.id].state === "error" &&
                        `✗ ${byokTest[provider.id].okCount ?? 0}/${byokTest[provider.id].total} OK · ${byokTest[provider.id].error}`}
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* BYOK Add/Edit Dialog */}
      <Dialog open={byokDialogOpen} onOpenChange={(open) => !open && handleCloseByokDialog()}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--primary)]/10 text-[var(--primary)]">
                <Key className="h-4.5 w-4.5" />
              </div>
              <div>
                <DTitle>{byokEditId ? 'Edit Custom Provider' : 'Add Custom Provider'}</DTitle>
                <DialogDescription className="mt-0.5">
                  {byokEditId ? 'Update your AI provider configuration' : 'Configure your own AI provider with your API key'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="space-y-4 pt-3">
            {/* Connection Settings */}
            <div className="space-y-2.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
              <p className="eyebrow">Connection</p>

              <div className="space-y-1.5">
                <label className="eyebrow">Provider Name</label>
                <Input
                  value={byokForm.label}
                  onChange={(e) => setByokForm({ ...byokForm, label: e.target.value })}
                  placeholder="e.g., openrouter, myprovider"
                  readOnly={byokEditId !== null}
                  className={`focus:ring-1 focus:ring-[var(--ring)] ${byokEditId ? 'bg-[var(--muted)] opacity-60' : ''}`}
                />
                <p className="font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                  {byokEditId ? 'Prefix cannot be changed after creation' : 'Used as model prefix (e.g., "openrouter-gpt-4")'}
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="eyebrow">Base URL</label>
                <Input
                  value={byokForm.base_url}
                  onChange={(e) => setByokForm({ ...byokForm, base_url: e.target.value })}
                  placeholder="https://api.provider.com/v1"
                  className="focus:ring-1 focus:ring-[var(--ring)]"
                />
              </div>
            </div>

            {/* Authentication */}
            <div className="space-y-2.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
                  <p className="eyebrow">API Key Pool</p>
                </div>
                <Button type="button" variant="outline" size="sm" className="h-7" onClick={addByokKeyRow}>
                  <Plus className="h-3 w-3" /> Add Key
                </Button>
              </div>
              <p className="font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                Multiple keys under the same provider prefix are load-balanced automatically. Existing keys are masked; leave them masked to keep the stored secret.
              </p>

              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {byokForm.keys.map((keyRow, index) => (
                  <div key={`${keyRow.id || "new"}-${index}`} className="rounded-md border border-[var(--border)] bg-[var(--card)] p-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={keyRow.label}
                        onChange={(e) => updateByokKeyRow(index, { label: e.target.value })}
                        placeholder="key label e.g. main"
                        className="h-8 flex-1 font-mono text-[11px]"
                      />
                      <button
                        type="button"
                        role="switch"
                        aria-checked={keyRow.enabled}
                        aria-label={`${keyRow.enabled ? "Disable" : "Enable"} key ${keyRow.label || index + 1}`}
                        onClick={() => updateByokKeyRow(index, { enabled: !keyRow.enabled })}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer ${keyRow.enabled ? "bg-[var(--primary)]" : "bg-[var(--border)]"}`}
                        title={keyRow.enabled ? "Enabled" : "Disabled"}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${keyRow.enabled ? "translate-x-5" : "translate-x-1"}`} />
                      </button>
                      <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-[var(--error)]" onClick={() => removeByokKeyRow(index)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      {(() => {
                        const visibilityId = byokSecretVisibilityId(keyRow, index);
                        const secretVisible = visibleByokSecrets.has(visibilityId);
                        return (
                          <div className="flex flex-1 items-center gap-1">
                            <Input
                              type={secretVisible ? "text" : "password"}
                              value={keyRow.key}
                              onChange={(e) => updateByokKeyRow(index, { key: e.target.value })}
                              onFocus={() => {
                                if (keyRow.key === BYOK_KEY_PLACEHOLDER) updateByokKeyRow(index, { key: "" });
                              }}
                              placeholder={byokEditId ? "Paste new key to replace, or keep masked" : "sk-..."}
                              className="h-8 flex-1 font-mono text-[11px]"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 shrink-0"
                              onClick={() => toggleByokSecretVisibility(keyRow, index)}
                              disabled={revealingByokSecret === visibilityId}
                              title={secretVisible ? "Hide key" : "Show key"}
                            >
                              {revealingByokSecret === visibilityId ? <Loader2 className="h-4 w-4 animate-spin" /> : secretVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </Button>
                          </div>
                        );
                      })()}
                      {keyRow.status && (
                        <Badge variant="outline" className={keyRow.status === "active" && keyRow.enabled ? "border-[var(--success)]/30 text-[var(--success)]" : "border-[var(--warning)]/30 text-[var(--warning)]"}>
                          {keyRow.enabled ? keyRow.status : "disabled"}
                        </Badge>
                      )}
                    </div>
                    {keyRow.errorMessage && <p className="text-[10px] text-[var(--error)] truncate">{keyRow.errorMessage}</p>}
                  </div>
                ))}
              </div>
            </div>

            {/* Model Configuration */}
            <div className="space-y-2.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Configuration</p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="eyebrow">API Format</label>
                  <Select
                    value={byokForm.format}
                    onChange={(e) => setByokForm({ ...byokForm, format: e.target.value as any })}
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="openai">OpenAI-compatible</option>
                    <option value="anthropic">Anthropic</option>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <label className="eyebrow">Load Balancing</label>
                  <Select
                    value={byokForm.load_balancing_method}
                    onChange={(e) => setByokForm({ ...byokForm, load_balancing_method: e.target.value as any })}
                  >
                    <option value="round_robin">Round Robin</option>
                    <option value="sequential">Sequential</option>
                  </Select>
                  <p className="text-[10px] text-[var(--muted-foreground)]">
                    Per-provider BYOK setting. Round Robin distributes requests; Sequential prefers the first healthy key.
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="eyebrow">Models</label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleFetchByokModels}
                    disabled={byokFetchingModels}
                    title="Fetch model list from this base URL + API key"
                  >
                    {byokFetchingModels ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1.5" />}
                    {byokFetchingModels ? "Fetching..." : "Fetch Models"}
                  </Button>
                </div>
                <textarea
                  value={byokForm.models}
                  onChange={(e) => setByokForm({ ...byokForm, models: e.target.value })}
                  placeholder="gpt-4, claude-3-opus, llama-3"
                  className="h-20 w-full resize-none rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-[12px] text-[var(--foreground)] transition-colors duration-150 placeholder:text-[var(--muted-foreground)]/70 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                />
                <p className="font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">Comma-separated list of model IDs</p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={handleCloseByokDialog} className="text-[var(--muted-foreground)]">
                Cancel
              </Button>
              <Button onClick={byokEditId ? handleUpdateByok : handleAddByok} >
                {byokEditId ? (
                  <><Pencil className="h-4 w-4" /> Update Provider</>
                ) : (
                  <><Plus className="h-4 w-4" /> Add Provider</>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Login Pending Dialog */}
      <Dialog open={loginPendingDialog} onOpenChange={setLoginPendingDialog}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DTitle>Login Pending Accounts</DTitle>
            <DialogDescription>Choose how many accounts to login concurrently.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="flex items-center gap-3">
              <label className="eyebrow">Concurrent:</label>
              <Select value={loginPendingConcurrency} onChange={(e) => setLoginPendingConcurrency(Number(e.target.value))} className="w-20" aria-label="Concurrent logins">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setLoginPendingDialog(false)}>Cancel</Button>
              <Button size="sm" onClick={confirmLoginAll}>
                <Play className="w-4 h-4 mr-2" /> Start Login
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Account Dialog (per-provider) */}
      <Dialog open={addDialogProvider !== null} onOpenChange={(open) => {
        if (open) return;
        handleCloseAddDialog();
      }}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader className="space-y-2 text-left">
            <DTitle className="pr-8">Add {addDialogProvider ? labelProvider(addDialogProvider) : ""} Account</DTitle>
            <DialogDescription>
              {addDialogProvider === "codex"
                ? "Add via browser login or instant login with API key/token."
                : addDialogProvider === "codebuddy"
                ? "Login CodeBuddy global (www.codebuddy.ai) via OAuth access_token, atau paste API keys (ck_...)."
                : addDialogProvider === "codebuddy-china"
                ? "Paste CodeBuddy China access_token (JWT) atau API keys (ck_...). Satu key per baris untuk bulk import."
                : addDialogProvider === "grok-cli"
                ? "Sign in with xAI / Grok Build via device code. Uses cli-chat-proxy.grok.com subscription credits."
                : addDialogProvider === "claude"
                ? "Sign in with Claude Pro/Max via Claude Code OAuth (PKCE). Models use cc- prefix (cc-claude-sonnet-4-6, …)."
                : `Add account for ${addDialogProvider ? labelProvider(addDialogProvider) : "this provider"}.`}
            </DialogDescription>
          </DialogHeader>

          {/* Mode tabs */}
          {addDialogProvider === "codex" ? (
            <div className="grid grid-cols-2 gap-1 rounded-md border border-[var(--border)] bg-[var(--secondary)]/50 p-1 sm:flex">
              <button onClick={() => setAddMode("instant")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "instant" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >Instant Login (Token)</button>
              {addDialogProvider === "codex" && <button onClick={() => handleSetCodexMode("pat")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >OAuth Login</button>}
              <button onClick={() => addDialogProvider === "codex" ? handleSetCodexMode("bulk") : setAddMode("bulk")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >Bulk (Email|Pass)</button>
              <button onClick={() => addDialogProvider === "codex" ? handleSetCodexMode("single") : setAddMode("single")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >Single</button>
            </div>
          ) : addDialogProvider === "codebuddy" ? (
            <div className="grid grid-cols-1 gap-1 rounded-md border border-[var(--border)] bg-[var(--secondary)]/50 p-1 sm:grid-cols-3">
              <button onClick={() => setAddMode("oauth")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "oauth" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >OAuth (access_token)</button>
              <button onClick={() => setAddMode("token")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "token" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >Access Token</button>
              <button onClick={() => setAddMode("apikey")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "apikey" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >API Key (ck_...)</button>
            </div>
          ) : addDialogProvider === "codebuddy-china" ? (
            <div className="grid grid-cols-1 gap-1 rounded-md border border-[var(--border)] bg-[var(--secondary)]/50 p-1 sm:grid-cols-2">
              <button onClick={() => setAddMode("token")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "token" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >Access Token</button>
              <button onClick={() => setAddMode("apikey")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "apikey" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >Bulk API Key (ck_...)</button>
            </div>
          ) : addDialogProvider === "grok-cli" ? (
            <div className="grid grid-cols-1 gap-1 rounded-md border border-[var(--border)] bg-[var(--secondary)]/50 p-1 sm:flex">
              <button onClick={() => setAddMode("pat")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >Device Code OAuth</button>
            </div>
          ) : addDialogProvider === "claude" ? (
            <div className="grid grid-cols-1 gap-1 rounded-md border border-[var(--border)] bg-[var(--secondary)]/50 p-1 sm:flex">
              <button onClick={() => setAddMode("pat")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >Claude Code OAuth</button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-1 rounded-md border border-[var(--border)] bg-[var(--secondary)]/50 p-1 sm:flex">
              <button onClick={() => setAddMode("bulk")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >Bulk (Email|Pass)</button>
              <button onClick={() => setAddMode("single")}
                className={`min-w-0 flex-1 rounded-[4px] px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150 sm:px-3 ${addMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--border)]" : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"}`}
              >Single</button>
            </div>
          )}

          {/* Token / OAuth mode */}
          {addMode === "apikey" && addDialogProvider === "codebuddy-china" && (
            <div className="space-y-4">
              <div>
                <label className="eyebrow">API Keys (satu per baris, prefix ck_)</label>
                <textarea
                  value={codebuddyChinaBulkApiKeys}
                  onChange={(e) => setCodebuddyChinaBulkApiKeys(e.target.value)}
                  className="mt-2 min-h-32 w-full resize-y rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--foreground)] transition-colors duration-150 placeholder:text-[var(--muted-foreground)]/70 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                  placeholder="ck_fpigz68zr75s...
ck_abc123def456...
ck_xyz789ghi012..."
                  disabled={codebuddyChinaBusy}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Paste satu atau lebih CodeBuddy China API key (prefix <code>ck_</code>), satu per baris. 
                  Model tersedia: <code>cbc-deepseek-v3</code>, <code>cbc-claude-haiku-4.5</code>, <code>cbc-kimi-k2.5</code>, dll.
                </p>
              </div>
              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)} disabled={codebuddyChinaBusy}>Cancel</Button>
                <Button onClick={handleCodeBuddyChinaBulkApiKey} disabled={codebuddyChinaBusy || !codebuddyChinaBulkApiKeys.trim()}>
                  {codebuddyChinaBusy ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing...</>) : "Add Accounts"}
                </Button>
              </div>
            </div>
          )}

          {addMode === "token" && addDialogProvider === "codebuddy-china" && (
            <div className="space-y-4">
              <div className="rounded-md border border-[var(--hairline)] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                Paste <code>access_token</code> (JWT) dari CodeBuddy CN (<code>www.codebuddy.cn</code>). User id dibaca
                otomatis dari klaim JWT. <code>refresh_token</code> opsional untuk rotasi token.
              </div>
              <div>
                <label className="eyebrow">Access Token</label>
                <textarea
                  value={codebuddyChinaAccessToken}
                  onChange={(e) => setCodebuddyChinaAccessToken(e.target.value)}
                  className="mt-2 min-h-28 w-full resize-y rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--foreground)] transition-colors duration-150 placeholder:text-[var(--muted-foreground)]/70 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                  placeholder="eyJhbGciOiJSUzI1NiIs..."
                  disabled={codebuddyChinaTokenBusy}
                />
              </div>
              <div>
                <label className="eyebrow">UID (opsional)</label>
                <Input
                  value={codebuddyChinaUid}
                  onChange={(e) => setCodebuddyChinaUid(e.target.value)}
                  placeholder="1a23b0d7-e40b-4011-bbd7-..."
                  disabled={codebuddyChinaTokenBusy}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Kosongkan jika tidak tahu — user id dibaca dari JWT.</p>
              </div>
              <div>
                <label className="eyebrow">Refresh Token (opsional)</label>
                <textarea
                  value={codebuddyChinaRefreshToken}
                  onChange={(e) => setCodebuddyChinaRefreshToken(e.target.value)}
                  className="mt-2 min-h-20 w-full resize-y rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--foreground)] transition-colors duration-150 placeholder:text-[var(--muted-foreground)]/70 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                  placeholder="eyJhbGciOiJIUzUxMiIs..."
                  disabled={codebuddyChinaTokenBusy}
                />
              </div>
              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)} disabled={codebuddyChinaTokenBusy}>Cancel</Button>
                <Button onClick={handleCodebuddyChinaAccessTokenImport} disabled={codebuddyChinaTokenBusy || !codebuddyChinaAccessToken.trim()}>
                  {codebuddyChinaTokenBusy ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing...</>) : "Add Account"}
                </Button>
              </div>
            </div>
          )}

          {addMode === "oauth" && addDialogProvider === "codebuddy" && (
            <div className="space-y-4">
              <div className="rounded-md border border-[var(--hairline)] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                Login CodeBuddy global (<code>www.codebuddy.ai</code>) via OAuth device flow. Browser akan terbuka —
                login pakai akun CodeBuddy, lalu <code>access_token</code> otomatis diambil dan akun ditambahkan.
              </div>
              {codebuddyOauthAuthUrl ? (
                <div className="space-y-2.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
                  <div>
                    <label className="eyebrow">Auth URL</label>
                    <div className="mt-1 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                      <code className="flex-1 break-all rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs font-mono text-[var(--foreground)]">
                        {codebuddyOauthAuthUrl}
                      </code>
                      <Button size="sm" variant="outline" onClick={() => window.open(codebuddyOauthAuthUrl, "_blank", "noopener,noreferrer")}>Open</Button>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                {codebuddyOauthBusy ? (
                  <Button variant="outline" onClick={handleCodebuddyOAuthCancel}>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Waiting for login... (Stop)
                  </Button>
                ) : (
                  <Button onClick={handleCodebuddyOAuthLogin}>Start OAuth Login</Button>
                )}
              </div>
            </div>
          )}

          {addMode === "token" && addDialogProvider === "codebuddy" && (
            <div className="space-y-4">
              <div className="rounded-md border border-[var(--hairline)] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                Paste <code>access_token</code> (JWT) dari CodeBuddy. Email &amp; user id dibaca otomatis dari klaim JWT.
                <code className="ml-1">refresh_token</code> opsional untuk rotasi token.
              </div>
              <div>
                <label className="eyebrow">Access Token</label>
                <textarea
                  value={codebuddyAccessToken}
                  onChange={(e) => setCodebuddyAccessToken(e.target.value)}
                  className="mt-2 min-h-28 w-full resize-y rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--foreground)] transition-colors duration-150 placeholder:text-[var(--muted-foreground)]/70 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                  placeholder="eyJhbGciOiJSUzI1NiIs..."
                  disabled={codebuddyTokenBusy}
                />
              </div>
              <div>
                <label className="eyebrow">Refresh Token (opsional)</label>
                <textarea
                  value={codebuddyRefreshToken}
                  onChange={(e) => setCodebuddyRefreshToken(e.target.value)}
                  className="mt-2 min-h-20 w-full resize-y rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--foreground)] transition-colors duration-150 placeholder:text-[var(--muted-foreground)]/70 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                  placeholder="eyJhbGciOiJIUzUxMiIs..."
                  disabled={codebuddyTokenBusy}
                />
              </div>
              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)} disabled={codebuddyTokenBusy}>Cancel</Button>
                <Button onClick={handleCodebuddyAccessTokenImport} disabled={codebuddyTokenBusy || !codebuddyAccessToken.trim()}>
                  {codebuddyTokenBusy ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing...</>) : "Add Account"}
                </Button>
              </div>
            </div>
          )}

          {addMode === "apikey" && addDialogProvider === "codebuddy" && (
            <div className="space-y-4">
              <div>
                <label className="eyebrow">API Keys (satu per baris, prefix ck_)</label>
                <textarea
                  value={codebuddyBulkApiKeys}
                  onChange={(e) => setCodebuddyBulkApiKeys(e.target.value)}
                  className="mt-2 min-h-32 w-full resize-y rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--foreground)] transition-colors duration-150 placeholder:text-[var(--muted-foreground)]/70 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                  placeholder={"ck_frxegm1rvitc...\nck_abc123def456...\nck_xyz789ghi012..."}
                  disabled={codebuddyBusy}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Paste satu atau lebih CodeBuddy global API key (prefix <code>ck_</code>), satu per baris. Host <code>www.codebuddy.ai</code>.
                  Model tersedia: <code>cb-opus-4.7-1m</code>, <code>cb-sonnet-4.6</code>, <code>cb-haiku-4.5</code>, dll.
                </p>
              </div>
              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)} disabled={codebuddyBusy}>Cancel</Button>
                <Button onClick={handleCodebuddyBulkApiKey} disabled={codebuddyBusy || !codebuddyBulkApiKeys.trim()}>
                  {codebuddyBusy ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing...</>) : "Add Accounts"}
                </Button>
              </div>
            </div>
          )}

          {addMode === "pat" && addDialogProvider === "claude" && (
            <div className="space-y-4">
              <div className="rounded-md border border-[var(--hairline)] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                Claude Code OAuth (PKCE). Login di browser Claude Pro/Max, lalu paste code dari success page
                (<code className="mx-1">CODE</code> atau <code>CODE#STATE</code>.
                Models: <code>cc-claude-opus-4-8</code>, <code>cc-claude-sonnet-4-6</code>, <code>cc-claude-haiku-4-5</code>.
              </div>
              {claudeOauthAuthUrl ? (
                <div className="space-y-2.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
                  <div>
                    <label className="eyebrow">Auth URL</label>
                    <div className="mt-1 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                      <code className="flex-1 break-all rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs font-mono text-[var(--foreground)]">
                        {claudeOauthAuthUrl}
                      </code>
                      <Button size="sm" variant="outline" onClick={handleClaudeOAuthCopyAuthUrl}>Copy</Button>
                      <Button size="sm" variant="outline" onClick={() => window.open(claudeOauthAuthUrl, "_blank", "noopener,noreferrer")}>Open</Button>
                    </div>
                  </div>
                  <div>
                    <label className="eyebrow">Authorization code</label>
                    <Input
                      value={claudeOauthCode}
                      onChange={(e) => setClaudeOauthCode(e.target.value)}
                      placeholder="paste code or CODE#STATE"
                      className="mt-1.5 font-mono text-[12px]"
                      disabled={claudeOauthBusy}
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button size="sm" onClick={handleClaudeOAuthSubmitCode} disabled={claudeOauthBusy || !claudeOauthCode.trim()}>
                      {claudeOauthBusy ? (<><Loader2 className="h-4 w-4 animate-spin" /> Completing...</>) : "Submit Code"}
                    </Button>
                  </div>
                </div>
              ) : null}
              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={handleCloseAddDialog} disabled={claudeOauthBusy}>Cancel</Button>
                <Button onClick={handleClaudeOAuthStart} disabled={claudeOauthBusy}>
                  {claudeOauthBusy ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Starting...</>) : "Start OAuth Login"}
                </Button>
              </div>
            </div>
          )}

          {addMode === "pat" && addDialogProvider === "grok-cli" && (
            <div className="space-y-4">
              <div className="rounded-md border border-[var(--hairline)] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                Device code flow (no browser password bot). Open verification URL, enter the code, wait until account becomes active.
                Models: <code>grok-4.5</code>, <code>grok-4.5-high/medium/low</code>.
              </div>
              {grokCliUserCode ? (
                <div className="space-y-2.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
                  <div>
                    <label className="eyebrow">User code</label>
                    <div className="mt-1 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                      <code className="flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-[16px] tracking-[0.3em] tabular-nums text-[var(--foreground)]">
                        {grokCliUserCode}
                      </code>
                      <Button size="sm" variant="outline" onClick={() => safeCopyText(grokCliUserCode, "User code copied")}>Copy</Button>
                    </div>
                  </div>
                  {grokCliVerifyUri && (
                    <div>
                      <label className="eyebrow">Verification URL</label>
                      <div className="mt-1 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                        <code className="flex-1 break-all rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs font-mono text-[var(--foreground)]">
                          {grokCliVerifyUri}
                        </code>
                        <Button size="sm" variant="outline" onClick={() => window.open(grokCliVerifyUri, "_blank", "noopener,noreferrer")}>Open</Button>
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-[var(--muted-foreground)] flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Waiting for authorization…
                  </p>
                </div>
              ) : null}
              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={handleCloseAddDialog} disabled={false}>Cancel</Button>
                {grokCliBusy ? (
                  <Button variant="outline" onClick={handleGrokCliCancel}><Loader2 className="h-4 w-4 animate-spin" /> Waiting for authorization</Button>
                ) : (
                  <Button onClick={handleGrokCliDeviceLogin}>Start Device Login</Button>
                )}
              </div>
            </div>
          )}

          {addMode === "pat" && addDialogProvider === "codex" && (
            <div className="space-y-3">
              <div className="rounded-md border border-[var(--hairline)] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                Login Codex bisa via popup OpenAI atau mode manual: generate auth URL, buka, lalu paste callback URL.
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" size="sm" onClick={handleCodexOAuthPrepareManual} disabled={codexOauthBusy || hasPreparedCodexOAuth}>
                  {hasPreparedCodexOAuth ? "Manual Ready" : codexOauthBusy ? (<><Loader2 className="h-4 w-4 animate-spin" /> Preparing...</>) : "Prepare Manual"}
                </Button>
                <Button size="sm" onClick={handleCodexOAuthLogin} disabled={codexOauthBusy || hasPreparedCodexOAuth}>
                  {codexOauthBusy ? (<><Loader2 className="h-4 w-4 animate-spin" /> Waiting for OAuth...</>) : "Start OAuth Login"}
                </Button>
              </div>

              {hasPreparedCodexOAuth && (
                <div className="space-y-2.5 rounded-md border border-[var(--hairline)] px-3 py-2.5">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="eyebrow">Auth URL</label>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={handleCodexOAuthCopyAuthUrl}>Copy</Button>
                        <Button size="sm" variant="outline" onClick={handleCodexOAuthOpenManual}>Open</Button>
                      </div>
                    </div>
                    <textarea
                      value={codexOauthAuthUrl}
                      readOnly
                      className="w-full h-20 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-mono text-[var(--foreground)] focus:outline-none resize-none"
                    />
                  </div>

                  <div className="space-y-1.5 rounded-md border border-[var(--hairline)] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                    <p><span className="text-[var(--foreground)]">Callback:</span> <code className="break-all">{codexLoopbackUrl}</code></p>
                    <p><span className="text-[var(--foreground)]">Contoh:</span> <code className="break-all">{codexCallbackExample}</code></p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="eyebrow">Callback URL</label>
                      <Button size="sm" variant="outline" onClick={handleCodexOAuthPasteCallback} disabled={codexOauthBusy}>Paste</Button>
                    </div>
                    <textarea
                      value={codexOauthCallbackUrl}
                      onChange={(e) => setCodexOauthCallbackUrl(e.target.value)}
                      className="w-full h-20 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                      placeholder={codexCallbackExample}
                    />
                    <div className="flex justify-end">
                      <Button size="sm" onClick={handleCodexOAuthSubmitManual} disabled={codexOauthBusy || !codexCallbackReady}>
                        {codexOauthBusy ? (<><Loader2 className="h-4 w-4 animate-spin" /> Completing OAuth...</>) : "Submit Callback URL"}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={handleCloseAddDialog} disabled={codexOauthBusy && !hasPreparedCodexOAuth}>Cancel</Button>
              </div>
            </div>
          )}

          {/* Instant Login mode (Kiro Pro only) */}
          {addMode === "instant" && addDialogProvider === "codex" && (
            <div className="space-y-4">
              <div>
                <label className="eyebrow">Refresh Tokens (satu per baris)</label>
                <textarea
                  value={instantTokens}
                  onChange={(e) => setInstantTokens(e.target.value)}
                  className="mt-2 min-h-32 w-full resize-y rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--foreground)] transition-colors duration-150 placeholder:text-[var(--muted-foreground)]/70 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                  placeholder={"eyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs..."}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Paste refresh token per baris. Email otomatis di-extract dari token.</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleInstantLogin}>Login Instant</Button>
              </div>
            </div>
          )}

          {/* Bulk mode (all providers) */}
          {addMode === "bulk" && (
            <div className="space-y-4">
              <div>
                <label className="eyebrow">Accounts (email|password per baris)</label>
                <textarea
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  className="mt-2 min-h-32 w-full resize-y rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--foreground)] transition-colors duration-150 placeholder:text-[var(--muted-foreground)]/70 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                  placeholder={"email@example.com|password123\nanother@example.com|pass456"}
                />
              </div>
              <div>
                <label className="eyebrow">Browser Engine</label>
                <Select value={bulkBrowserEngine} onChange={(e) => setBulkBrowserEngine(e.target.value)} className="mt-1">
                  <option value="camoufox">Camoufox (Anti-detect, default)</option>
                  <option value="chromium">Chromium (Playwright)</option>
                </Select>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 font-mono text-[12px] text-[var(--foreground)]">
                  <input type="checkbox" checked={bulkHeadless} onChange={(e) => setBulkHeadless(e.target.checked)} className="h-4 w-4 rounded border-[var(--border)]" />
                  Run browser headless
                </label>
                <div className="flex items-center gap-2">
                  <label className="eyebrow">Concurrent:</label>
                  <Select value={bulkConcurrency} onChange={(e) => setBulkConcurrency(Number(e.target.value))} className="w-16" aria-label="Concurrent logins">
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={5}>5</option>
                    <option value={10}>10</option>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleBulkImport}>Import & Login</Button>
              </div>
            </div>
          )}

          {/* Single mode (all providers) */}
          {addMode === "single" && (
            <div className="space-y-4">
              <div>
                <label className="eyebrow">Email</label>
                <Input value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} placeholder="email@example.com" className="mt-1" />
              </div>
              <div>
                <label className="eyebrow">Password</label>
                <Input value={addForm.password} onChange={(e) => setAddForm({ ...addForm, password: e.target.value })} type="password" placeholder="********" className="mt-1" />
              </div>
              <div>
                <label className="eyebrow">Browser Engine</label>
                <Select value={addForm.browserEngine} onChange={(e) => setAddForm({ ...addForm, browserEngine: e.target.value })} className="mt-1">
                  <option value="camoufox">Camoufox (Anti-detect, default)</option>
                  <option value="chromium">Chromium (Playwright)</option>
                </Select>
              </div>
              <label className="flex items-center gap-2 font-mono text-[12px] text-[var(--foreground)]">
                <input type="checkbox" checked={addForm.headless} onChange={(e) => setAddForm({ ...addForm, headless: e.target.checked })} className="h-4 w-4 rounded border-[var(--border)]" />
                Run browser headless
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleAdd}>Add Account</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  // Numbers get the big readout; word values (a format name) would look absurd at 20px.
  const isWord = typeof value === "string" && !/^[\d./]+$/.test(value);
  return (
    <div className="px-3 py-3">
      <div className="eyebrow">{label}</div>
      <div
        className={`mt-1.5 truncate font-mono font-semibold leading-none tabular-nums ${isWord ? "text-[13px]" : "text-xl"}`}
        style={{ color: tone || "var(--foreground)" }}
      >
        {value}
      </div>
    </div>
  );
}
