import { db } from "../db/index";
import { accounts, requestLogs, settings, usageSummary, proxyPool } from "../db/schema";
import { eq, gte, sql } from "drizzle-orm";
import { broadcast } from "../ws/index";
import type { Account } from "../db/schema";

export const ALERT_SETTING_DEFAULTS: Record<string, string> = {
  alert_enabled: "false",
  alert_webhook_url: "",
  alert_telegram_token: "",
  alert_telegram_chat: "",
  alert_event_account_error: "true",
  alert_event_low_credits: "true",
  alert_credit_threshold: "20",
  alert_event_error_rate: "true",
  alert_error_rate_percent: "50",
  alert_error_rate_window_min: "15",
  alert_event_proxy_pool_empty: "true",
  alert_cooldown_min: "30",
};

const ALERT_COOLDOWN_DEFAULT_MIN = 30;
const ERROR_RATE_MIN_REQUESTS = 5;

export type AlertSeverity = "info" | "warning" | "error";

interface AlertResults {
  webhook?: { ok: boolean; error?: string };
  telegram?: { ok: boolean; error?: string };
}

export interface BurnRateEntry {
  provider: string;
  quotaLimit: number;
  quotaRemaining: number;
  credits7d: number;
  creditsPerDay: number;
  daysLeft: number | null;
}

// 60-second push cadence for the /api/alerts/burn-rate endpoint (kept cheap
// with a cached 7d usage read + in-memory provider sums). The time-series
// data source (usage_summary) is written by the proxy on bucket rollover, so
// sub-minute freshness adds nothing.
const BURN_RATE_CACHE_TTL_MS = 60_000;
let burnRateCache: { data: BurnRateEntry[]; expiresAt: number } | null = null;

// ponytail: in-memory cooldown — relevant on restart only, acceptable. DB persists
// every other alert state (params, events); this map only remembers when an alert
// was last sent to prevent spam, and losing that on restart is harmless.
const lastSentAt = new Map<string, number>();

// Truncate alert payloads so they stay far below the WS/HTTP limits even if
// an errorMessage is pathological.
const MAX_FIRE_MESSAGE_LENGTH = 10_000;

export function computeDaysLeft(quotaRemaining: number, credits7d: number): number | null {
  const perDay = credits7d / 7;
  if (perDay <= 0 || quotaRemaining <= 0) return null;
  return Math.ceil(quotaRemaining / perDay);
}

export function shouldFire(
  key: string,
  nowMs: number,
  cooldownMin: number,
  lastSent: Map<string, number>
): boolean {
  const last = lastSent.get(key);
  return last === undefined || nowMs - last >= cooldownMin * 60_000;
}

export function buildAlertPayload(text: string): Record<string, string> {
  return { content: text, text };
}

function getAlertSettingsFromRows(rows: { key: string; value: string | null }[]): Record<string, string> {
  const merged: Record<string, string> = { ...ALERT_SETTING_DEFAULTS };
  for (const row of rows) {
    if (row.value !== null) merged[row.key] = row.value;
  }
  return merged;
}

/**
 * Read alert settings from the KV table, merged with defaults (all keys always
 * present). `settings` holds every subsystem's KV pairs in one table, so only
 * keys in ALERT_SETTING_DEFAULTS are picked up here.
 */
export async function getAlertSettings(): Promise<Record<string, string>> {
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings);
  return getAlertSettingsFromRows(rows);
}

function toNumberSettings(settingsMap: Record<string, string>): {
  enabled: boolean;
  accountError: boolean;
  lowCredits: boolean;
  creditThreshold: number;
  errorRate: boolean;
  errorRatePercent: number;
  errorRateWindowMin: number;
  proxyPoolEmpty: boolean;
  cooldownMin: number;
  webhookUrl: string;
  telegramToken: string;
  telegramChat: string;
} {
  const num = (key: string, fallback: number): number => {
    const parsed = Number(settingsMap[key]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    enabled: settingsMap.alert_enabled === "true",
    accountError: settingsMap.alert_event_account_error === "true",
    lowCredits: settingsMap.alert_event_low_credits === "true",
    creditThreshold: num("alert_credit_threshold", 20),
    errorRate: settingsMap.alert_event_error_rate === "true",
    errorRatePercent: num("alert_error_rate_percent", 50),
    errorRateWindowMin: num("alert_error_rate_window_min", 15),
    proxyPoolEmpty: settingsMap.alert_event_proxy_pool_empty === "true",
    cooldownMin: num("alert_cooldown_min", ALERT_COOLDOWN_DEFAULT_MIN),
    webhookUrl: settingsMap.alert_webhook_url || "",
    telegramToken: settingsMap.alert_telegram_token || "",
    telegramChat: settingsMap.alert_telegram_chat || "",
  };
}

async function sendWebhook(url: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { safeFetch } = await import("../utils/ssrf");
    const res = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildAlertPayload(text)),
    }, { timeoutMs: 10_000 });
    if (!res.ok) {
      return { ok: false, error: `webhook responded ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendTelegram(
  token: string,
  chat: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    if (!res.ok) {
      return { ok: false, error: `telegram responded ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function notifyChannels(
  settingsMap: Record<string, string>,
  text: string
): Promise<AlertResults> {
  const clean = toNumberSettings(settingsMap);
  const [webhook, telegram] = await Promise.all([
    clean.webhookUrl ? sendWebhook(clean.webhookUrl, text) : Promise.resolve(undefined),
    clean.telegramToken && clean.telegramChat
      ? sendTelegram(clean.telegramToken, clean.telegramChat, text)
      : Promise.resolve(undefined),
  ]);
  if (webhook && !webhook.ok) console.error("[Alerts] Webhook send failed:", webhook.error);
  if (telegram && !telegram.ok) console.error("[Alerts] Telegram send failed:", telegram.error);
  return { webhook, telegram };
}

/**
 * Fire an alert after the in-memory cooldown check: notify the configured
 * channels and broadcast to WebSocket clients. Failures are logged, never
 * thrown. Also used for the manual test path with bypassCooldown=true.
 */
export async function fire(
  key: string,
  severity: AlertSeverity,
  message: string,
  settingsMap: Record<string, string>,
  opts: { bypassCooldown?: boolean; sendToChannels?: boolean } = {}
): Promise<AlertResults> {
  const { bypassCooldown = false, sendToChannels = true } = opts;
  const clean = toNumberSettings(settingsMap);
  const result: AlertResults = {};

  if (!bypassCooldown && !shouldFire(key, Date.now(), clean.cooldownMin, lastSentAt)) {
    return result;
  }

  lastSentAt.set(key, Date.now());

  if (sendToChannels) {
    const text = message.slice(0, MAX_FIRE_MESSAGE_LENGTH);
    Object.assign(result, await notifyChannels(settingsMap, text));
  }

  broadcast({ type: "alert_fired", data: { key, message, severity } });

  return result;
}

/**
 * An account just transitioned into "error" or "exhausted". Fire the
 * account-error alert if the event is enabled. Called from pool.ts after
 * markExhausted / markError (NOT markTransientFailure).
 */
export async function notifyAccountStatus(account: Account): Promise<void> {
  if (account.status !== "error" && account.status !== "exhausted") return;

  const settingsMap = await getAlertSettings();
  if (!settingsMap.alert_enabled) return;

  const clean = toNumberSettings(settingsMap);
  if (!clean.accountError) return;

  const severity: AlertSeverity = account.status === "exhausted" ? "warning" : "error";
  const message =
    `Account status: ${account.status === "exhausted" ? "quota exhausted" : "error"} ` +
    `(provider: ${account.provider}, email: ${account.email}` +
    (account.errorMessage ? `, error: ${account.errorMessage}` : "") +
    `)`;

  await fire(`account_error:${account.id}`, severity, message, settingsMap);
}

interface LowCreditsCheck {
  provider: string;
  usedPercent: number;
  remaining: number;
  limit: number;
}

async function checkLowCredits(
  clean: ReturnType<typeof toNumberSettings>
): Promise<LowCreditsCheck[]> {
  if (!clean.lowCredits) return [];

  // Per-provider quota aggregates over enabled accounts only.
  const rows = await db
    .select({
      provider: accounts.provider,
      limit: sql<number>`COALESCE(SUM(${accounts.quotaLimit}), 0)`,
      remaining: sql<number>`COALESCE(SUM(${accounts.quotaRemaining}), 0)`,
    })
    .from(accounts)
    .where(eq(accounts.enabled, true))
    .groupBy(accounts.provider);

  const fired: LowCreditsCheck[] = [];
  for (const row of rows) {
    if (!row.limit || row.limit <= 0) continue;
    const remaining = Math.max(0, row.remaining);
    const usedPercent = ((row.limit - remaining) / row.limit) * 100;
    if (usedPercent >= clean.creditThreshold) {
      fired.push({ provider: row.provider, usedPercent, remaining, limit: row.limit });
    }
  }
  return fired;
}

interface ErrorRateCheck {
  provider: string;
  errors: number;
  total: number;
  errorPercent: number;
}

async function checkErrorRate(
  clean: ReturnType<typeof toNumberSettings>
): Promise<ErrorRateCheck[]> {
  if (clean.errorRate) return [];

  const sinceMs = Date.now() - clean.errorRateWindowMin * 60_000;
  const since = new Date(sinceMs);

  const rows = await db
    .select({
      provider: requestLogs.provider,
      total: sql<number>`COUNT(*)`,
      errors: sql<number>`SUM(CASE WHEN ${requestLogs.status} = 'error' THEN 1 ELSE 0 END)`,
    })
    .from(requestLogs)
    .where(gte(requestLogs.createdAt, since))
    .groupBy(requestLogs.provider);

  const fired: ErrorRateCheck[] = [];
  for (const row of rows) {
    const total = row.total || 0;
    if (total < ERROR_RATE_MIN_REQUESTS) continue; // too little traffic — noisy
    const errors = row.errors || 0;
    const errorPercent = (errors / total) * 100;
    if (errorPercent >= clean.errorRatePercent) {
      fired.push({ provider: row.provider, errors, total, errorPercent });
    }
  }
  return fired;
}

/**
 * Background job, runs on a 60s timer from src/index.ts. Safe to run
 * repeatedly — each event fires at most once per cooldown window.
 */
export async function runPeriodicChecks(): Promise<void> {
  try {
    const settingsMap = await getAlertSettings();
    if (settingsMap.alert_enabled !== "true") return;

    const clean = toNumberSettings(settingsMap);
    const checks = await Promise.all([
      checkLowCredits(clean),
      checkErrorRate(clean),
    ]);
    const [lowCredits, errorRates] = checks;

    for (const row of lowCredits) {
      const message =
        `Low credits: ${row.provider} at ${row.usedPercent.toFixed(1)}% used ` +
        `(${Math.max(0, row.remaining)} / ${row.limit} remaining)`;
      await fire(`low_credits:${row.provider}`, "warning", message, settingsMap);
    }

    for (const row of errorRates) {
      const message =
        `High error rate: ${row.provider} at ${row.errorPercent.toFixed(1)}% ` +
        `(${row.errors}/${row.total} requests, last ${clean.errorRateWindowMin} min)`;
      await fire(`error_rate:${row.provider}`, "error", message, settingsMap);
    }

    const [poolRow] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(proxyPool)
      .where(eq(proxyPool.status, "active"));
    if ((poolRow?.count || 0) === 0) {
      await fire("proxy_pool_empty", "error", "Proxy pool is empty — no active proxies available", settingsMap);
    }
  } catch (err) {
    console.error("[Alerts] Periodic check failed:", err);
  }
}

/**
 * Send a manual test alert (cooldown bypassed). Results per configured channel
 * come back so the API can report them per the contract.
 */
export async function sendTestAlert(): Promise<AlertResults> {
  const settingsMap = await getAlertSettings();
  const message = "Test alert from etteum-pool — everything looks good 👍";
  // Bypass the cooldown and send to channels regardless of alert_enabled so
  // the test always reports real per-channel results (contract).
  return fire("test_alert", "info", message, settingsMap, { bypassCooldown: true });
}

/**
 * Burn-rate metrics for the dashboard: per-provider quota + 7d credit burn.
 * `creditsPerDay` is credits7d / 7 calendar days (simple average — includes
 * idle days, which is the point: it answers "how long until the quota dies").
 * `daysLeft` is null when there is no measured burn.
 */
export async function getBurnRate(
  maxAgeMs = BURN_RATE_CACHE_TTL_MS
): Promise<BurnRateEntry[]> {
  if (burnRateCache && burnRateCache.expiresAt > Date.now()) {
    return burnRateCache.data;
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [usageRows, quotaRows] = await Promise.all([
    db
      .select({
        provider: usageSummary.provider,
        credits: sql<number>`COALESCE(SUM(${usageSummary.creditsUsed}), 0)`,
      })
      .from(usageSummary)
      .where(gte(usageSummary.bucket, sevenDaysAgo))
      .groupBy(usageSummary.provider),
    db
      .select({
        provider: accounts.provider,
        limit: sql<number>`COALESCE(SUM(${accounts.quotaLimit}), 0)`,
        remaining: sql<number>`COALESCE(SUM(${accounts.quotaRemaining}), 0)`,
      })
      .from(accounts)
      .where(eq(accounts.enabled, true))
      .groupBy(accounts.provider),
  ]);

  const usageByProvider = new Map(usageRows.map((r) => [r.provider, r.credits || 0]));
  const data: BurnRateEntry[] = quotaRows.map((row) => {
    const credits7d = usageByProvider.get(row.provider) || 0;
    const creditsPerDay = credits7d / 7;
    return {
      provider: row.provider,
      quotaLimit: row.limit || 0,
      quotaRemaining: Math.max(0, row.remaining || 0),
      credits7d,
      creditsPerDay,
      daysLeft: computeDaysLeft(Math.max(0, row.remaining || 0), credits7d),
    };
  });

  // Include providers burning credits with no quota row (active burn without
  // quota tracking — daysLeft will be null, still worth seeing).
  for (const [provider, credits] of usageByProvider) {
    if (!data.some((d) => d.provider === provider)) {
      data.push({
        provider,
        quotaLimit: 0,
        quotaRemaining: 0,
        credits7d: credits,
        creditsPerDay: credits / 7,
        daysLeft: null,
      });
    }
  }

  data.sort((a, b) => a.provider.localeCompare(b.provider));
  burnRateCache = { data, expiresAt: Date.now() + maxAgeMs };
  return data;
}

export function validateNumericSetting(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

export function validateWebhookUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}