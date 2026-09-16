function resolveApiBase(): string {
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE;
  const port = window.location.port;
  if (!port || port === "443" || port === "80") {
    return window.location.origin;
  }
  const backendPort = import.meta.env.VITE_BACKEND_PORT || (Number(port) - 1) || "1930";
  return `http://${window.location.hostname}:${backendPort}`;
}

export const API_BASE = resolveApiBase();

export function getWsBase(): string {
  const configured = import.meta.env.VITE_WS_BASE;
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const port = window.location.port;
  if (!port || port === "443" || port === "80") {
    return `${protocol}://${window.location.hostname}`;
  }
  const backendPort = import.meta.env.VITE_BACKEND_PORT || (Number(port) - 1) || "1930";
  return `${protocol}://${window.location.hostname}:${backendPort}`;
}

function getApiKey(): string {
  return localStorage.getItem("api_key") || "pool-proxy-secret-key";
}

export async function validateApiKey(key: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/keys/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.valid === true;
  } catch {
    return false;
  }
}

export function isAuthenticated(): boolean {
  return !!localStorage.getItem("api_key");
}

export function logout() {
  localStorage.removeItem("api_key");
}

type FetchApiOptions = RequestInit & { timeoutMs?: number };

export async function fetchApi<T = any>(path: string, options?: FetchApiOptions): Promise<T> {
  const { timeoutMs = 30_000, signal, ...fetchOptions } = options || {};
  const controller = new AbortController();
  const abortOnSignal = () => controller.abort(signal?.reason);
  // Abort with a reason so a client timeout rejects with a clear TimeoutError
  // instead of the browser's cryptic "signal is aborted without reason".
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs)
    : null;

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", abortOnSignal, { once: true });
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getApiKey()}`,
        ...fetchOptions.headers,
      },
    });

    if (!res.ok) {
      let message = `API error: ${res.status}`;
      try {
        const body = await res.json();
        message = body.error || body.message || message;
      } catch {
        const text = await res.text().catch(() => "");
        if (text) message = text;
      }
      throw new Error(message);
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return text ? JSON.parse(text) : (undefined as T);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abortOnSignal);
  }
}

export function clampLimit(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPollingLoop(fn: () => Promise<void>, intervalMs: number, signal: AbortSignal) {
  while (!signal.aborted) {
    await fn().catch(() => {});
    await Promise.race([
      sleep(intervalMs),
      new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    ]);
  }
}

export async function fetchDashboardStats(hours?: number | null, range?: string) {
  const params = new URLSearchParams();
  if (hours !== null && hours !== undefined) params.set("hours", String(hours));
  if (range) params.set("range", range);
  const qs = params.toString();
  return fetchApi(`/api/stats${qs ? `?${qs}` : ""}`);
}

export async function fetchAccounts() {
  return fetchApi("/api/accounts");
}

export async function fetchProviders() {
  return fetchApi("/api/stats/providers");
}

export async function fetchUsage(hours: number | null = 24, range?: string) {
  const params = new URLSearchParams();
  if (hours !== null) params.set("hours", String(hours));
  if (range) params.set("range", range);
  params.set("timeZone", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  return fetchApi(`/api/stats/usage?${params.toString()}`);
}

export async function fetchModelUsage(hours?: number | null, range?: string) {
  const params = new URLSearchParams();
  if (hours !== null && hours !== undefined) params.set("hours", String(hours));
  if (range) params.set("range", range);
  const qs = params.toString();
  return fetchApi(`/api/stats/models${qs ? `?${qs}` : ""}`);
}

export async function refreshAccountQuota(accountId: number) {
  return fetchApi(`/api/accounts/${accountId}/refresh-quota`, {
    method: "POST",
  });
}

export async function warmupAccount(accountId: number) {
  return fetchApi(`/api/accounts/${accountId}/warmup`, {
    method: "POST",
  });
}

export async function warmupAccounts(accountIds: number[]) {
  return fetchApi("/api/auth/warmup-bulk", {
    method: "POST",
    body: JSON.stringify({ accountIds }),
  });
}

export async function warmupAllAccounts(options?: { providers?: string[]; statuses?: string[]; includePending?: boolean }) {
  return fetchApi("/api/auth/warmup-all", {
    method: "POST",
    body: JSON.stringify(options || {}),
  });
}

export async function fetchWarmupQueue() {
  return fetchApi("/api/accounts/warmup-queue");
}

export async function fetchWarmupEvents(limit: number = 300) {
  return fetchApi(`/api/auth/warmup-events?limit=${clampLimit(limit, 300, 1, 1000)}`);
}

export interface AutoWarmupStatus {
  running: boolean;
  intervalMinutes: number;
  enabledProviders: string[];
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export async function fetchAutoWarmupStatus(): Promise<AutoWarmupStatus> {
  return fetchApi<AutoWarmupStatus>("/api/auth/warmup-schedule");
}

export interface RequestLogListResponse {
  data: unknown[];
  total: number;
  limit: number;
  offset: number;
}

export async function fetchRequests(
  page: number = 1,
  limit: number = 50,
  provider?: string,
  status?: string,
  search?: string
): Promise<RequestLogListResponse> {
  const safeLimit = clampLimit(limit, 50, 1, 500);
  const safePage = clampLimit(page, 1, 1, 1000);
  const offset = (safePage - 1) * safeLimit;
  const params = new URLSearchParams({ limit: String(safeLimit), offset: String(offset) });
  if (provider && provider !== "all") params.set("provider", provider);
  // Only the two statuses the API understands; "all" means "no filter".
  if (status === "success" || status === "error") params.set("status", status);
  const trimmedSearch = search?.trim();
  if (trimmedSearch) params.set("search", trimmedSearch);
  return fetchApi(`/api/stats/requests?${params.toString()}`);
}

/**
 * Prune or purge stored request logs. At least one filter is required by the
 * API; `olderThanDays: "retention"` defers to the saved retention policy.
 */
export async function deleteRequestLogs(params: {
  all?: boolean;
  olderThanDays?: number | "retention";
  status?: string;
  provider?: string;
}): Promise<{ success: boolean; deletedCount: number }> {
  const query = new URLSearchParams();
  if (params.all) query.set("all", "true");
  if (params.olderThanDays !== undefined) query.set("olderThanDays", String(params.olderThanDays));
  if (params.status) query.set("status", params.status);
  if (params.provider && params.provider !== "all") query.set("provider", params.provider);
  return fetchApi(`/api/stats/requests?${query.toString()}`, { method: "DELETE" });
}

/**
 * Fetch full detail (including heavy requestBody / responseBody) for a single
 * request log. Used by the Requests page detail drawer so the list endpoint
 * can stay lightweight.
 */
export async function fetchRequestDetail(id: number) {
  return fetchApi<{ data: unknown }>(`/api/stats/requests/${id}`);
}

export async function fetchModels() {
  return fetchApi("/v1/models");
}

// ── Model Combos ────────────────────────────────────────────

export interface ComboDTO {
  id: number;
  name: string;
  targets: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function fetchCombos(): Promise<{ data: ComboDTO[] }> {
  return fetchApi("/api/combos");
}

export async function createCombo(payload: {
  name: string;
  targets: string[];
}): Promise<{ data: ComboDTO }> {
  return fetchApi("/api/combos", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateCombo(
  id: number,
  payload: { name?: string; targets?: string[]; enabled?: boolean }
): Promise<{ data: ComboDTO }> {
  return fetchApi(`/api/combos/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteCombo(
  id: number
): Promise<{ data: { ok: true } }> {
  return fetchApi(`/api/combos/${id}`, { method: "DELETE" });
}

export interface ModelMappingDTO {
  id?: number;
  sourcePattern: string;
  matchType: string;
  targetModel: string;
  enabled: boolean;
  priority: number;
  label?: string | null;
}

export interface IntegrationData {
  enabled: boolean;
  mappings: ModelMappingDTO[];
  models?: { id: string; owned_by: string }[];
}

export async function fetchIntegration(): Promise<IntegrationData> {
  return fetchApi("/api/integration");
}

export async function saveIntegration(payload: { enabled?: boolean; mappings?: ModelMappingDTO[] }) {
  return fetchApi("/api/integration", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export interface ApplyConfigResult {
  success: boolean;
  path: string;
  config: Record<string, unknown>;
}

export async function applyIntegrationConfig(baseUrl: string): Promise<ApplyConfigResult> {
  return fetchApi("/api/integration/apply-config", {
    method: "POST",
    body: JSON.stringify({ baseUrl }),
  });
}

// ── Multi-Client Integration ─────────────────────────────────────

export interface ClientMetaDTO {
  id: string;
  name: string;
  description: string;
  cli: string;
  url: string;
  detected: boolean;
  configPaths: string[];
}

export interface IntegrationModelDTO {
  id: string;
  owned_by: string;
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
  vision?: boolean;
}

export interface IntegrationClientsData {
  clients: ClientMetaDTO[];
  models: IntegrationModelDTO[];
  /** Per-client selected model subset. `null` means "not yet saved" (→ all models). */
  clientModelSelections: Record<string, string[] | null>;
}

export interface ClientConfigPreviewDTO {
  client: string;
  success: boolean;
  preview?: Record<string, unknown>;
  paths: string[];
  backupPaths: string[];
  error?: string;
}

export interface ApplyClientResult {
  client: string;
  success: boolean;
  paths: string[];
  backupPaths: string[];
  error?: string;
}

export interface ApplyAllResult {
  success: boolean;
  results: ApplyClientResult[];
}

export async function fetchIntegrationClients(): Promise<IntegrationClientsData> {
  return fetchApi("/api/integration/clients");
}

export async function fetchClientConfigPreview(
  clientId: string,
  baseUrl: string,
  modelId?: string,
  selectedModels?: string[]
): Promise<ClientConfigPreviewDTO> {
  return fetchApi(`/api/integration/clients/${clientId}/preview`, {
    method: "POST",
    body: JSON.stringify({ baseUrl, modelId, selectedModels }),
  });
}

export async function applyClientConfig(
  clientId: string,
  baseUrl: string,
  modelId?: string,
  selectedModels?: string[]
): Promise<ApplyClientResult> {
  return fetchApi(`/api/integration/clients/${clientId}/apply`, {
    method: "POST",
    body: JSON.stringify({ baseUrl, modelId, selectedModels }),
  });
}

export async function applyAllClients(
  baseUrl: string,
  modelId?: string,
  clientModelSelections?: Record<string, string[]>
): Promise<ApplyAllResult> {
  return fetchApi("/api/integration/apply-all", {
    method: "POST",
    body: JSON.stringify({ baseUrl, modelId, clientModelSelections }),
  });
}

export async function saveClientSelectedModels(
  clientId: string,
  models: string[]
): Promise<{ success: boolean; clientId: string; models: string[] }> {
  return fetchApi(`/api/integration/clients/${clientId}/models`, {
    method: "PUT",
    body: JSON.stringify({ models }),
  });
}

export async function restoreClientConfig(
  clientId: string
): Promise<{ success: boolean; path?: string; restoredFrom?: string; error?: string }> {
  return fetchApi(`/api/integration/clients/${clientId}/restore`, {
    method: "POST",
  });
}

export async function fetchSettings() {
  return fetchApi("/api/settings");
}

export async function updateSettings(settings: Record<string, string>) {
  return fetchApi("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function fetchAlertSettings() {
  return fetchApi("/api/alerts/settings");
}

export async function updateAlertSettings(settings: Record<string, string>) {
  return fetchApi("/api/alerts/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function sendTestAlert(): Promise<{
  data: {
    ok: boolean;
    results: {
      webhook?: { ok: boolean; error?: string };
      telegram?: { ok: boolean; error?: string };
    };
  };
}> {
  return fetchApi("/api/alerts/test", { method: "POST" });
}

export interface BurnRateItem {
  provider: string;
  quotaLimit: number;
  quotaRemaining: number;
  credits7d: number;
  creditsPerDay: number;
  daysLeft: number | null;
}

export async function fetchBurnRate(): Promise<{ data: BurnRateItem[] }> {
  return fetchApi("/api/alerts/burn-rate");
}

export async function fetchProviderList(): Promise<{ data: string[] }> {
  return fetchApi("/api/settings/providers");
}

export async function createAccount(account: { provider: string; email: string; password: string; browserEngine?: string; headless?: boolean }) {
  return fetchApi("/api/accounts", {
    method: "POST",
    body: JSON.stringify(account),
  });
}

export async function deleteAccount(id: number) {
  return fetchApi(`/api/accounts/${id}`, { method: "DELETE" });
}

export async function bulkDeleteAccounts(ids: number[]): Promise<{
  success: boolean;
  requested: number;
  deleted: number;
  deletedIds: number[];
  providers: string[];
  notFound: number[];
}> {
  return fetchApi("/api/accounts/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export async function toggleAccountEnabled(id: number, enabled?: boolean) {
  return fetchApi<{ id: number; enabled: boolean; status: string; provider: string }>(
    `/api/accounts/${id}/toggle`,
    {
      method: "POST",
      body: JSON.stringify(typeof enabled === "boolean" ? { enabled } : {}),
    },
  );
}

export async function toggleAllAccounts(provider: string, enabled: boolean) {
  return fetchApi<{ provider: string; enabled: boolean; count: number }>(
    "/api/accounts/toggle-all",
    {
      method: "POST",
      body: JSON.stringify({ provider, enabled }),
    },
  );
}

export async function loginAccount(id: number, options?: { headless?: boolean }) {
  return fetchApi(`/api/auth/login/${id}`, {
    method: "POST",
    body: JSON.stringify(options || {}),
  });
}

export async function loginAccounts(accountIds: number[], options?: { headless?: boolean }) {
  return fetchApi("/api/auth/login-bulk", {
    method: "POST",
    body: JSON.stringify({ accountIds, ...(options || {}) }),
  });
}

export async function loginAllAccounts(options?: { headless?: boolean; concurrency?: number }) {
  return fetchApi("/api/auth/login-all", {
    method: "POST",
    body: JSON.stringify(options || {}),
  });
}

export async function stopAccount(id: number) {
  return fetchApi(`/api/auth/stop/${id}`, { method: "POST" });
}

export async function stopAllAccounts() {
  return fetchApi("/api/auth/stop-all", { method: "POST" });
}

export async function importAccounts(text: string, providers: string[], options?: { headless?: boolean; concurrency?: number; browserEngine?: string }) {
  return fetchApi("/api/auth/import", {
    method: "POST",
    body: JSON.stringify({ text, providers, ...(options || {}) }),
  });
}

export async function fetchAuthQueue() {
  return fetchApi("/api/auth/queue");
}

export async function fetchAuthLogs(limit: number = 200) {
  return fetchApi(`/api/auth/logs?limit=${clampLimit(limit, 200, 1, 1000)}`);
}

export async function clearAuthLogs() {
  return fetchApi("/api/auth/logs", { method: "DELETE" });
}

export async function fetchApiKey() {
  return fetchApi("/api/keys");
}

export async function regenerateApiKey() {
  return fetchApi("/api/keys/regenerate", { method: "POST" });
}

export async function setApiKey(key: string) {
  return fetchApi("/api/keys/set", {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}

export async function testApiKey(key: string) {
  return fetchApi("/api/keys/test", {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}

// ---- Multi-key lifecycle (Cartethyia full lifecycle) ----------------------

export interface ApiKeyDTO {
  id: number;
  name: string;
  description: string | null;
  keyPrefix: string;
  enabled: boolean;
  revokedAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  monthlyTokenBudget: number;
  oneTimeTokenBudget: number;
  rpmLimit: number;
  maxConcurrent: number;
  allowedProviders: string[];
  deniedProviders: string[];
  allowedModels: string[];
  deniedModels: string[];
  shareEnabled: boolean;
  shareSlug: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface ApiKeyCreatePayload {
  name: string;
  description?: string;
  monthlyTokenBudget?: number;
  oneTimeTokenBudget?: number;
  rpmLimit?: number;
  maxConcurrent?: number;
  allowedProviders?: string[];
  deniedProviders?: string[];
  allowedModels?: string[];
  deniedModels?: string[];
  expiresAt?: string | null;
}

export async function fetchApiKeys(): Promise<{ keys: ApiKeyDTO[]; legacy: { activeKey: string; source: string; fromEnv: boolean; configured: boolean } }> {
  return fetchApi("/api/keys");
}

export async function createApiKey(payload: ApiKeyCreatePayload): Promise<ApiKeyDTO & { key: string }> {
  return fetchApi("/api/keys", { method: "POST", body: JSON.stringify(payload) });
}

export async function updateApiKey(id: number, patch: Partial<ApiKeyCreatePayload>): Promise<ApiKeyDTO> {
  return fetchApi(`/api/keys/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function setApiKeyEnabled(id: number, enabled: boolean): Promise<void> {
  return fetchApi(`/api/keys/${id}/${enabled ? "enable" : "disable"}`, { method: "POST" });
}

export async function revokeApiKey(id: number): Promise<void> {
  return fetchApi(`/api/keys/${id}`, { method: "DELETE" });
}

export async function deleteApiKeyPermanent(id: number): Promise<void> {
  return fetchApi(`/api/keys/${id}/permanent`, { method: "DELETE" });
}

export async function regenerateApiKeyById(id: number): Promise<ApiKeyDTO & { key: string }> {
  return fetchApi(`/api/keys/${id}/regenerate`, { method: "POST" });
}

export async function revealApiKeySecret(id: number): Promise<{ key: string }> {
  return fetchApi(`/api/keys/${id}/credential`);
}

export async function enableShare(id: number): Promise<{ shareUrl: string }> {
  return fetchApi(`/api/keys/${id}/share`, { method: "POST" });
}

export async function disableShare(id: number): Promise<void> {
  return fetchApi(`/api/keys/${id}/share`, { method: "DELETE" });
}

// Proxy Pool
export async function fetchProxyPool() {
  return fetchApi("/api/proxy-pool/pool");
}

export async function addProxies(proxies: string[], priority?: number) {
  return fetchApi("/api/proxy-pool/pool", {
    method: "POST",
    body: JSON.stringify({ proxies, ...(priority !== undefined ? { priority } : {}) }),
  });
}

export async function updateProxy(id: number, data: { status?: string; label?: string; priority?: number; usage?: string }) {
  return fetchApi(`/api/proxy-pool/pool/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteProxy(id: number) {
  return fetchApi(`/api/proxy-pool/pool/${id}`, { method: "DELETE" });
}

export async function clearProxyPool() {
  return fetchApi("/api/proxy-pool/pool", { method: "DELETE" });
}

export async function checkProxy(id: number) {
  return fetchApi(`/api/proxy-pool/pool/${id}/check`, { method: "POST" });
}

export async function checkAllProxies() {
  return fetchApi("/api/proxy-pool/pool/check-all", { method: "POST", timeoutMs: 120_000 });
}

export interface ProxyCountry {
  code: string;
  name: string;
}

export async function fetchProxyCountries(): Promise<{ countries: ProxyCountry[] }> {
  return fetchApi("/api/proxy-pool/scrape/countries");
}

export interface ScrapeSourceResult {
  id: string;
  label: string;
  status: "fulfilled" | "empty" | "failed";
  count: number;
  error?: string;
}

export interface ScrapeProxyResult {
  scraped: number;
  verified: number;
  added: number;
  skipped: number;
  sources?: ScrapeSourceResult[];
}

export async function scrapeProxies(options: {
  source?: "proxyscrape" | "geonode" | "proxifly" | "thespeedx" | "jetkai" | "iplocate" | "vpslab" | "hproxy" | "all";
  country?: string;
  protocol?: "http" | "socks5" | "all";
  limit?: number;
  verify?: boolean;
}): Promise<ScrapeProxyResult> {
  return fetchApi("/api/proxy-pool/scrape", {
    method: "POST",
    body: JSON.stringify(options),
    timeoutMs: 120_000,
  });
}

// Image Studio
export interface AssistModelInfo {
  id: string;
  provider: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function fetchAssistModels(): Promise<{ data: AssistModelInfo[] }> {
  return fetchApi("/api/image-studio/assist-models");
}

export async function assistPrompt(payload: {
  message: string;
  history?: ChatMessage[];
  model?: string;
}): Promise<{ reply: string; options: string[]; finalPrompt: string | null }> {
  return fetchApi("/api/image-studio/assist", {
    method: "POST",
    body: JSON.stringify(payload),
    timeoutMs: 90_000,
  });
}

export async function generateImage(payload: {
  prompt: string;
  type?: "image" | "video";
  aspectRatio?: string;
  n?: number;
  chatId?: number | null;
}): Promise<{
  id?: number;
  urls: string[];
  prompt: string;
  type: string;
  aspectRatio: string;
  n: number;
  creditsUsed: number;
  createdAt?: string;
  account: { id: number; email: string };
}> {
  return fetchApi("/api/image-studio/generate", {
    method: "POST",
    body: JSON.stringify(payload),
    timeoutMs: 420_000,
  });
}

export interface StoredChat {
  id: number;
  title: string | null;
  messages: ChatMessage[];
  finalPrompt: string | null;
  options: string[];
  assistModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredResult {
  id: number;
  chatId: number | null;
  prompt: string;
  type: "image" | "video";
  aspectRatio: string;
  n: number;
  urls: string[];
  creditsUsed: number;
  createdAt: string;
}

export async function fetchChats(): Promise<{ data: StoredChat[] }> {
  return fetchApi("/api/image-studio/chats");
}

export async function fetchChat(id: number): Promise<StoredChat> {
  return fetchApi(`/api/image-studio/chats/${id}`);
}

export async function createChat(payload: {
  title?: string | null;
  messages?: ChatMessage[];
  finalPrompt?: string | null;
  options?: string[];
  assistModel?: string | null;
}): Promise<StoredChat> {
  return fetchApi("/api/image-studio/chats", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateChat(
  id: number,
  payload: {
    title?: string | null;
    messages?: ChatMessage[];
    finalPrompt?: string | null;
    options?: string[];
    assistModel?: string | null;
  },
): Promise<StoredChat> {
  return fetchApi(`/api/image-studio/chats/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteChat(id: number): Promise<{ ok: boolean }> {
  return fetchApi(`/api/image-studio/chats/${id}`, { method: "DELETE" });
}

export async function fetchResults(params?: {
  chatId?: number;
  limit?: number;
}): Promise<{ data: StoredResult[] }> {
  const qs = new URLSearchParams();
  if (params?.chatId !== undefined) qs.set("chatId", String(params.chatId));
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return fetchApi(`/api/image-studio/results${suffix}`);
}

export async function deleteResult(id: number): Promise<{ ok: boolean }> {
  return fetchApi(`/api/image-studio/results/${id}`, { method: "DELETE" });
}

export async function clearResults(chatId?: number): Promise<{ ok: boolean }> {
  const suffix = chatId !== undefined ? `?chatId=${chatId}` : "";
  return fetchApi(`/api/image-studio/results${suffix}`, { method: "DELETE" });
}

export interface CodexAuthorizeResponse {
  authUrl: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
  flowType: string;
  fixedPort: number;
  callbackPath: string;
}

export interface CodexOAuthStatusResponse {
  status: string;
  error?: string;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
    workspace?: string | null;
    plan?: string | null;
  };
}

export async function getCodexAuthorize(redirectUri: string): Promise<CodexAuthorizeResponse> {
  return fetchApi(`/api/oauth/codex/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`);
}

export async function startCodexOAuthProxy(input: {
  appPort: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const params = new URLSearchParams({
    app_port: input.appPort,
    state: input.state,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
  });
  return fetchApi(`/api/oauth/codex/start-proxy?${params.toString()}`);
}

export async function pollCodexOAuthStatus(state: string): Promise<CodexOAuthStatusResponse> {
  return fetchApi(`/api/oauth/codex/poll-status?state=${encodeURIComponent(state)}`);
}

export async function stopCodexOAuth(state?: string) {
  const suffix = state ? `?state=${encodeURIComponent(state)}` : "";
  return fetchApi(`/api/oauth/codex/stop-proxy${suffix}`);
}

export async function completeCodexOAuth(input: { code: string; state: string }) {
  return fetchApi<{ success: boolean; connection?: CodexOAuthStatusResponse["connection"] }>("/api/oauth/codex/complete", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function completeCodexOAuthCallbackUrl(callbackUrl: string) {
  const url = new URL(callbackUrl.trim());
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error") || "";
  const errorDescription = url.searchParams.get("error_description") || error;

  if (error) {
    throw new Error(errorDescription || error);
  }

  if (!code || !state) {
    throw new Error("Callback URL must include code and state");
  }

  return completeCodexOAuth({ code, state });
}

export interface GrokCliDeviceCodeResponse {
  state: string;
  flowType: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string | null;
  interval: number;
  expiresIn: number;
}

export interface GrokCliOAuthStatusResponse {
  status: string;
  error?: string;
  interval?: number;
  userCode?: string;
  verificationUri?: string;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
  };
}

export async function startGrokCliDeviceCode(): Promise<GrokCliDeviceCodeResponse> {
  return fetchApi("/api/oauth/grok-cli/device-code");
}

export async function pollGrokCliOAuth(state: string): Promise<GrokCliOAuthStatusResponse> {
  return fetchApi("/api/oauth/grok-cli/poll", {
    method: "POST",
    body: JSON.stringify({ state }),
  });
}

export async function cancelGrokCliOAuth(state?: string) {
  return fetchApi("/api/oauth/grok-cli/cancel", {
    method: "POST",
    body: JSON.stringify(state ? { state } : {}),
  });
}

export interface CodebuddyDeviceCodeResponse {
  state: string;
  flowType: string;
  authUrl: string;
  interval: number;
}

export interface CodebuddyOAuthStatusResponse {
  status: string;
  error?: string;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
  };
}

export async function startCodebuddyDeviceCode(): Promise<CodebuddyDeviceCodeResponse> {
  return fetchApi("/api/oauth/codebuddy/device-code");
}

export async function pollCodebuddyOAuth(state: string): Promise<CodebuddyOAuthStatusResponse> {
  return fetchApi("/api/oauth/codebuddy/poll", {
    method: "POST",
    body: JSON.stringify({ state }),
  });
}

export async function cancelCodebuddyOAuth(state?: string) {
  return fetchApi("/api/oauth/codebuddy/cancel", {
    method: "POST",
    body: JSON.stringify(state ? { state } : {}),
  });
}

export interface ClaudeAuthorizeResponse {
  authUrl: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  flowType: string;
  pasteHint?: string;
}

export interface ClaudeOAuthStatusResponse {
  status: string;
  error?: string;
  authUrl?: string;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
    plan?: string | null;
  };
}

export async function startClaudeOAuth(): Promise<ClaudeAuthorizeResponse> {
  return fetchApi("/api/oauth/claude/authorize");
}

export async function completeClaudeOAuth(input: {
  state: string;
  code: string;
}): Promise<{ success: boolean; connection?: ClaudeOAuthStatusResponse["connection"] }> {
  return fetchApi("/api/oauth/claude/complete", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function pollClaudeOAuthStatus(state: string): Promise<ClaudeOAuthStatusResponse> {
  return fetchApi(`/api/oauth/claude/poll-status?state=${encodeURIComponent(state)}`);
}

export async function cancelClaudeOAuth(state?: string) {
  return fetchApi("/api/oauth/claude/cancel", {
    method: "POST",
    body: JSON.stringify(state ? { state } : {}),
  });
}

// BYOK (Bring Your Own Key) API functions
export interface ByokKeyInfo {
  id?: number;
  label: string;
  key?: string;
  status?: string;
  enabled?: boolean;
  weight?: number;
  priority?: number;
  lastUsedAt?: string | null;
  errorMessage?: string | null;
}

export interface ByokProvider {
  id: number;
  label: string;
  base_url: string;
  format: "openai" | "anthropic" | "auto";
  models: string[];
  model_prefix: string;
  headers?: Record<string, string>;
  status: string;
  enabled: boolean;
  available_models?: string[];
  load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
  key_count?: number;
  active_key_count?: number;
  keys?: ByokKeyInfo[];
}

export async function fetchByokProviders(): Promise<{ providers: ByokProvider[] }> {
  return fetchApi("/api/accounts/byok");
}

export async function createByokProvider(data: {
  label: string;
  base_url: string;
  api_key?: string;
  api_keys?: ByokKeyInfo[];
  format?: "openai" | "anthropic" | "auto";
  models: string[];
  headers?: Record<string, string>;
  load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
}): Promise<{ success: boolean; id: number; label: string; models: string[]; key_count?: number }> {
  return fetchApi("/api/accounts/byok", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateByokProvider(
  id: number,
  data: {
    base_url?: string;
    api_key?: string;
    api_keys?: ByokKeyInfo[];
    format?: "openai" | "anthropic" | "auto";
    models?: string[];
    headers?: Record<string, string>;
    load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
  }
): Promise<{ success: boolean; id: number; label: string; models: string[] }> {
  return fetchApi(`/api/accounts/byok/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteByokProvider(id: number): Promise<{ success: boolean; deleted: number }> {
  return fetchApi(`/api/accounts/byok/${id}`, { method: "DELETE" });
}

export async function revealByokKey(
  id: number
): Promise<{ success: boolean; id: number; label: string; key: string }> {
  return fetchApi(`/api/accounts/byok/${id}/reveal`, { method: "POST" });
}

export async function testByokProvider(
  id: number,
  model?: string
): Promise<{
  success: boolean;
  error?: string;
  warning?: string;
  model?: string;
  format?: string;
  latency_ms?: number;
  auto_fixed?: boolean;
}> {
  return fetchApi(`/api/accounts/byok/${id}/test`, {
    method: "POST",
    body: JSON.stringify(model ? { model } : {})
  });
}

export async function fetchByokModels(data: {
  base_url: string;
  api_key: string;
  format?: "openai" | "anthropic" | "auto";
  headers?: Record<string, string>;
}): Promise<{ models: string[]; error?: string }> {
  return fetchApi("/api/accounts/byok/fetch-models", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ============================================================================
// Antigravity (Google Cloud Code Assist) OAuth Functions
// ============================================================================

export interface AntigravityAuthorizeResponse {
  authUrl: string;
  state: string;
}

export interface AntigravityOAuthStatusResponse {
  success: boolean;
  connection?: {
    email: string;
    projectId: string;
    name?: string;
  };
  error?: string;
  status?: "waiting_authorization" | "exchanging" | "done" | "error" | "cancelled" | "expired";
}

export async function getAntigravityAuthorize(redirectUri: string): Promise<AntigravityAuthorizeResponse> {
  const res = await fetch(`${API_BASE}/api/oauth/antigravity/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirectUri }),
  });

  if (!res.ok) throw new Error(`Failed to authorize: ${await res.text()}`);

  return res.json();
}

export async function startAntigravityOAuthProxy(): Promise<AntigravityAuthorizeResponse> {
  const redirectUri = `${window.location.origin}/oauth/antigravity/callback`;
  return getAntigravityAuthorize(redirectUri);
}

export async function pollAntigravityOAuthStatus(state: string): Promise<AntigravityOAuthStatusResponse> {
  const res = await fetch(`${API_BASE}/api/oauth/antigravity/status?state=${encodeURIComponent(state)}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) throw new Error(`Polling failed: ${await res.text()}`);

  return res.json();
}

export async function stopAntigravityOAuth(state?: string): Promise<void> {
  if (!state) return;
  
  await fetch(`${API_BASE}/api/oauth/antigravity/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
}

export interface CompleteAntigravityOAuthInput {
  code: string;
  state: string;
}

export async function completeAntigravityOAuth(input: CompleteAntigravityOAuthInput): Promise<{
  success: boolean;
  connection?: AntigravityOAuthStatusResponse["connection"];
  error?: string;
}> {
  // Provisioning can exceed the 30s default fetchApi timeout (Google token
  // exchange + Cloud Code Assist project discovery/onboarding). Disable the
  // client deadline; the server completion is bounded internally by safeFetch.
  return fetchApi(`/api/oauth/antigravity/complete`, {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: 0,
  });
}

export async function completeAntigravityOAuthCallbackUrl(callbackUrl: string): Promise<{
  success: boolean;
  connection?: AntigravityOAuthStatusResponse["connection"];
  error?: string;
}> {
  return fetchApi(`/api/oauth/antigravity/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callbackUrl }),
  });
}

