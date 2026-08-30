import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { settings } from "../db/schema";
import {
  getAlertSettings,
  sendTestAlert,
  getBurnRate,
  validateNumericSetting,
  validateWebhookUrl,
} from "../services/alerts";

export const alertsRouter = new Hono();

/**
 * GET /api/alerts/settings — all alert settings, defaults filled in.
 */
alertsRouter.get("/settings", async (c) => {
  const data = await getAlertSettings();
  return c.json({ data });
});

/**
 * PUT /api/alerts/settings — upsert alert settings (partial or full map).
 * Numeric settings must parse > 0 when present; webhook URL must be http(s).
 */
alertsRouter.put("/settings", async (c) => {
  const body = await c.req.json<Record<string, string>>();

  const numericKeys = new Set([
    "alert_credit_threshold",
    "alert_error_rate_percent",
    "alert_error_rate_window_min",
    "alert_cooldown_min",
  ]);

  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") {
      return c.json({ error: `value for "${key}" must be a string` }, 400);
    }
    if (numericKeys.has(key) && !validateNumericSetting(value)) {
      return c.json({ error: `"${key}" must be a number greater than 0` }, 400);
    }
    if (key === "alert_webhook_url" && value !== "" && !validateWebhookUrl(value)) {
      return c.json({ error: `"alert_webhook_url" must start with http:// or https://` }, 400);
    }
  }

  for (const [key, value] of Object.entries(body)) {
    const existing = await db.select().from(settings).where(eq(settings.key, key));
    if (existing.length > 0) {
      await db
        .update(settings)
        .set({ value, updatedAt: new Date() })
        .where(eq(settings.key, key));
    } else {
      await db.insert(settings).values({ key, value });
    }
  }

  const data = await getAlertSettings();
  return c.json({ data });
});

/**
 * POST /api/alerts/test — send a test alert to every configured channel,
 * bypassing the cooldown, and report per-channel results.
 */
alertsRouter.post("/test", async (c) => {
  const results = await sendTestAlert();
  const channels = [results.webhook, results.telegram].filter(Boolean);
  const ok = channels.length === 0 || channels.every((r) => r?.ok);
  return c.json({ data: { ok, results } });
});

/**
 * GET /api/alerts/burn-rate — per-provider quota + burn-rate metrics.
 */
alertsRouter.get("/burn-rate", async (c) => {
  const data = await getBurnRate();
  return c.json({ data });
});
