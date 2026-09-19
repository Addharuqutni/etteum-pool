import { Hono } from "hono";
import { accountsRouter } from "./accounts";
import { proxySettingsRouter } from "./proxy-settings";
import { statsRouter } from "./stats";
import { keysRouter } from "./keys";
import { vccRouter } from "./vcc";
import { proxyPoolRouter } from "./proxy-pool";
import { imageStudioRouter } from "./image-studio";
import { modelStudioRouter } from "./model-studio";
import { filtersRouter } from "./filters";
import { binApi } from "./bin";
import { integrationRouter } from "./integration";
import { oauthRouter } from "./oauth";
import { alertsRouter } from "./alerts";
import { combosRouter } from "./combos";
import { publicRouter } from "./public";

export const apiRouter = new Hono();

apiRouter.route("/accounts", accountsRouter);
apiRouter.route("/settings", proxySettingsRouter);
apiRouter.route("/stats", statsRouter);
apiRouter.route("/keys", keysRouter);
apiRouter.route("/vcc", vccRouter);
apiRouter.route("/proxy-pool", proxyPoolRouter);
apiRouter.route("/image-studio", imageStudioRouter);
apiRouter.route("/model-studio", modelStudioRouter);
apiRouter.route("/filters", filtersRouter);
apiRouter.route("/bin", binApi);
apiRouter.route("/integration", integrationRouter);
apiRouter.route("/combos", combosRouter);
apiRouter.route("/oauth", oauthRouter);
apiRouter.route("/alerts", alertsRouter);
apiRouter.route("/public", publicRouter);

apiRouter.get("/providers", (c) => {
  return c.json({ data: ["codebuddy", "codebuddy-china", "canva", "codex", "grok-cli", "claude", "byok", "antigravity"] });
});

// Health check
apiRouter.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
