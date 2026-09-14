import { Hono } from "hono";
import { createHash, randomBytes } from "crypto";
// ponytail: Shared OAuth session storage across providers during auth flow
const oauthSessions = new Map<string, { codeVerifier: string }>();
import {
  completeClaudeOAuthLogin,
  completeCodebuddyOAuthLogin,
  completeGrokCliDeviceLogin,
  exchangeCodexAuthorizationCode,
  exchangeCodexRefreshTokens,
  importCodexAccessToken,
  completeAntigravityOAuthLogin,
} from "./accounts";
import {
  consumeCodexOAuthSession,
  createCodexOAuthSession,
  deleteCodexOAuthSession,
  getCodexOAuthSession,
  updateCodexOAuthSession,
} from "./oauth-codex-session";
import {
  consumeGrokCliOAuthSession,
  createGrokCliOAuthSession,
  deleteGrokCliOAuthSession,
  getGrokCliOAuthSession,
  updateGrokCliOAuthSession,
} from "./oauth-grok-cli-session";
import {
  consumeClaudeOAuthSession,
  createClaudeOAuthSession,
  deleteClaudeOAuthSession,
  getClaudeOAuthSession,
  updateClaudeOAuthSession,
} from "./oauth-claude-session";
import {
  consumeCodebuddyOAuthSession,
  createCodebuddyOAuthSession,
  deleteCodebuddyOAuthSession,
  getCodebuddyOAuthSession,
  updateCodebuddyOAuthSession,
} from "./oauth-codebuddy-session";
import {
  consumeAntigravityOAuthSession,
  createAntigravityOAuthSession,
  deleteAntigravityOAuthSession,
  getAntigravityOAuthSession,
  updateAntigravityOAuthSession,
} from "./oauth-antigravity-session";
import { fetchGrokCliUser, GROK_CLI_OAUTH } from "../proxy/providers/grok-cli";
import { buildClaudeAuthorizeUrl } from "../proxy/providers/claude";
import { CODEBUDDY_OAUTH, pollCodebuddyToken, requestCodebuddyDeviceCode } from "../proxy/providers/codebuddy";
import { ANTIGRAVITY_OAUTH } from "../proxy/providers/antigravity";
import { config } from "../config";

const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_FIXED_PORT = 1455;
const CODEX_CALLBACK_PATH = "/auth/callback";
const CODEX_SCOPE = "openid profile email offline_access";
const CODEX_PROXY_TIMEOUT_MS = 300000;

let codexLoopbackServer: Bun.Server<unknown> | null = null;
let codexLoopbackTimeout: ReturnType<typeof setTimeout> | null = null;

function generateCodeVerifier(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function generateCodeChallenge(codeVerifier: string) {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function generateState() {
  return randomBytes(32).toString("base64url");
}

export const oauthRouter = new Hono();

async function completeCodexOAuth(code: string, state: string) {
  const session = getCodexOAuthSession(state);
  if (!session) {
    throw new Error("OAuth session expired or not found");
  }

  updateCodexOAuthSession(state, { status: "exchanging", error: undefined });

  try {
    const connection = await exchangeCodexAuthorizationCode({
      code,
      codeVerifier: session.codeVerifier,
      redirectUri: session.redirectUri,
    });

    updateCodexOAuthSession(state, {
      status: "done",
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.name,
        workspace: connection.workspace,
        plan: connection.plan,
      },
    });

    return {
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.name,
        workspace: connection.workspace,
        plan: connection.plan,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateCodexOAuthSession(state, { status: "error", error: message });
    throw error;
  }
}

function buildCodexAuthorizeUrl(redirectUri: string, codeChallenge: string, state: string) {
  const params = {
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CODEX_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
    state,
  };
  const queryString = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${CODEX_ISSUER}/oauth/authorize?${queryString}`;
}

function callbackHtml(title: string, message: string, closeWindow = false) {
  const closeScript = closeWindow
    ? `<script>setTimeout(() => window.close(), 1200)</script>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8" /><title>${title}</title></head><body style="font-family:system-ui,sans-serif;padding:24px;background:#0b0f14;color:#e5e7eb"><div style="max-width:520px;margin:40px auto;padding:24px;border:1px solid #334155;border-radius:12px;background:#111827"><h1 style="margin:0 0 12px;font-size:20px">${title}</h1><p style="margin:0;color:#cbd5e1">${message}</p></div>${closeScript}</body></html>`;
}

function scheduleCodexLoopbackStop() {
  setTimeout(() => stopCodexLoopbackServer(), 0);
}

async function handleCodexLoopbackCallback(url: URL) {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error") || "";
  const errorDescription = url.searchParams.get("error_description") || error;

  if (!state) {
    scheduleCodexLoopbackStop();
    return new Response(callbackHtml("Codex login failed", "Missing OAuth state."), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (error) {
    updateCodexOAuthSession(state, { status: "error", error: errorDescription || error });
    scheduleCodexLoopbackStop();
    return new Response(callbackHtml("Codex login failed", errorDescription || error, true), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (!code) {
    updateCodexOAuthSession(state, { status: "error", error: "Missing authorization code" });
    scheduleCodexLoopbackStop();
    return new Response(callbackHtml("Codex login failed", "Missing authorization code.", true), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  try {
    await completeCodexOAuth(code, state);
    scheduleCodexLoopbackStop();
    return new Response(callbackHtml("Codex connected", "You can close this window and return to the dashboard.", true), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (oauthError) {
    const message = oauthError instanceof Error ? oauthError.message : String(oauthError);
    scheduleCodexLoopbackStop();
    return new Response(callbackHtml("Codex login failed", message, true), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

function ensureCodexLoopbackServer() {
  if (codexLoopbackServer) return codexLoopbackServer;

  codexLoopbackServer = Bun.serve({
    hostname: "127.0.0.1",
    port: CODEX_FIXED_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === CODEX_CALLBACK_PATH || url.pathname === "/callback") {
        return handleCodexLoopbackCallback(url);
      }

      return new Response("Not Found", { status: 404 });
    },
    error(error) {
      return new Response(
        callbackHtml("Codex login failed", error instanceof Error ? error.message : String(error), true),
        {
          status: 500,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    },
  });

  codexLoopbackTimeout = setTimeout(() => stopCodexLoopbackServer(), CODEX_PROXY_TIMEOUT_MS);

  return codexLoopbackServer;
}

function stopCodexLoopbackServer() {
  if (codexLoopbackTimeout) {
    clearTimeout(codexLoopbackTimeout);
    codexLoopbackTimeout = null;
  }
  if (codexLoopbackServer) {
    codexLoopbackServer.stop(true);
    codexLoopbackServer = null;
  }
}

oauthRouter.get("/codex/callback", async (c) => {
  const response = await handleCodexLoopbackCallback(new URL(c.req.url));
  return new Response(response.body, response);
});

oauthRouter.post("/codex/callback", async (c) => {
  try {
    const body = await c.req.json<{ code?: string; state?: string }>();
    if (!body.code || !body.state) {
      return c.json({ error: "Missing code or state" }, 400);
    }
    const result = await completeCodexOAuth(body.code, body.state);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

oauthRouter.post("/codex/complete", async (c) => {
  try {
    const body = await c.req.json<{ code?: string; state?: string }>();
    if (!body.code || !body.state) {
      return c.json({ error: "Missing code or state" }, 400);
    }
    const result = await completeCodexOAuth(body.code, body.state);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

oauthRouter.post("/codex/import-token", async (c) => {
  try {
    const body = await c.req.json<{ accessToken?: string; name?: string }>();

    if (!body.accessToken || typeof body.accessToken !== "string") {
      return c.json({ error: "Access token is required" }, 400);
    }

    const connection = await importCodexAccessToken(body.accessToken, body.name);
    return c.json({ success: true, connection });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

oauthRouter.post("/codex/exchange", async (c) => {
  try {
    const body = await c.req.json<{
      code?: string;
      refreshToken?: string;
      tokens?: string[];
      redirectUri?: string;
      codeVerifier?: string;
      state?: string;
      meta?: Record<string, unknown>;
    }>();

    if (body.code && body.code.startsWith("eyJ") && body.code.includes(".")) {
      const connection = await importCodexAccessToken(body.code);
      return c.json({
        success: true,
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.name,
        },
      });
    }

    if (body.code && body.redirectUri && body.codeVerifier) {
      const connection = await exchangeCodexAuthorizationCode({
        code: body.code,
        redirectUri: body.redirectUri,
        codeVerifier: body.codeVerifier,
      });
      return c.json({
        success: true,
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.name,
        },
      });
    }

    if (body.code && body.state) {
      const result = await completeCodexOAuth(body.code, body.state);
      return c.json(result);
    }

    const refreshTokens = Array.isArray(body.tokens)
      ? body.tokens
      : [body.refreshToken || body.code || ""].filter(Boolean);

    if (refreshTokens.length === 0) {
      return c.json({ error: "Missing token/code/refreshToken" }, 400);
    }

    const result = await exchangeCodexRefreshTokens(refreshTokens);
    if (result.success > 0) {
      return c.json({
        success: true,
        connection: {
          provider: "codex",
          displayName: "Codex",
        },
        imported: result.success,
        failed: result.failed,
        errors: result.errors,
      });
    }

    return c.json(result, 400);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

oauthRouter.get("/codex/authorize", async (c) => {
  const redirectUri = c.req.query("redirect_uri") || `http://localhost:${CODEX_FIXED_PORT}${CODEX_CALLBACK_PATH}`;
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const authUrl = buildCodexAuthorizeUrl(redirectUri, codeChallenge, state);
  return c.json({
    authUrl,
    state,
    codeVerifier,
    codeChallenge,
    redirectUri,
    flowType: "authorization_code_pkce",
    fixedPort: CODEX_FIXED_PORT,
    callbackPath: CODEX_CALLBACK_PATH,
  });
});

oauthRouter.get("/codex/start-proxy", (c) => {
  const appPort = c.req.query("app_port") || "";
  const state = c.req.query("state") || "";
  const codeVerifier = c.req.query("code_verifier") || "";
  const redirectUri = c.req.query("redirect_uri") || `http://localhost:${CODEX_FIXED_PORT}${CODEX_CALLBACK_PATH}`;

  if (!appPort) return c.json({ error: "Missing app_port" }, 400);
  if (!state || !codeVerifier) return c.json({ error: "Missing state or code_verifier" }, 400);

  try {
    ensureCodexLoopbackServer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = message.includes("EADDRINUSE") || message.includes("Address already in use")
      ? "port_busy"
      : message;
    return c.json({ success: false, reason, serverSide: false });
  }

  createCodexOAuthSession({ state, codeVerifier, redirectUri, appPort });
  updateCodexOAuthSession(state, { status: "waiting_callback" });

  return c.json({
    success: true,
    serverSide: true,
  });
});

oauthRouter.get("/codex/poll-status", (c) => {
  const state = c.req.query("state") || "";
  if (!state) return c.json({ error: "Missing state" }, 400);

  const session = getCodexOAuthSession(state);
  if (!session) {
    return c.json({ status: "unknown" });
  }

  if (session.status === "done" || session.status === "error" || session.status === "cancelled") {
    const consumed = consumeCodexOAuthSession(state);
    return c.json({
      status: consumed?.status,
      connection: consumed?.connection,
      error: consumed?.error,
    });
  }

  return c.json({ status: session.status });
});

oauthRouter.get("/codex/stop-proxy", (c) => {
  const state = c.req.query("state") || "";
  if (state) {
    updateCodexOAuthSession(state, { status: "cancelled", error: "Cancelled by user" });
    deleteCodexOAuthSession(state);
  }
  stopCodexLoopbackServer();
  return c.json({ success: true });
});

// 9router supports device-code on other providers; Codex does not use it here.
oauthRouter.get("/codex/device-code", (c) => {
  return c.json({ error: "Provider does not support device code flow" }, 400);
});

/**
 * Grok CLI (Grok Build) — device_code OAuth (no PKCE), ported from 9router.
 * GET  /api/oauth/grok-cli/device-code
 * POST /api/oauth/grok-cli/poll   body: { state }
 * POST /api/oauth/grok-cli/cancel body: { state }
 */
oauthRouter.get("/grok-cli/device-code", async (c) => {
  try {
    const body = new URLSearchParams({
      client_id: GROK_CLI_OAUTH.clientId,
      scope: GROK_CLI_OAUTH.scope,
      referrer: GROK_CLI_OAUTH.referrer,
    });

    const response = await fetch(GROK_CLI_OAUTH.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": GROK_CLI_OAUTH.userAgent,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return c.json(
        { error: `Grok CLI device code request failed (${response.status}): ${text.slice(0, 200)}` },
        400,
      );
    }

    const data = (await response.json()) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      verification_uri_complete?: string;
      interval?: number;
      expires_in?: number;
    };

    if (!data.device_code || !data.user_code || !data.verification_uri) {
      return c.json({ error: "Invalid device code response from xAI" }, 502);
    }

    const state = generateState();
    createGrokCliOAuthSession({
      state,
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      intervalSec: Number(data.interval) || 5,
      expiresInSec: Number(data.expires_in) || 900,
    });

    return c.json({
      state,
      flowType: "device_code",
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete || null,
      interval: Number(data.interval) || 5,
      expiresIn: Number(data.expires_in) || 900,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

oauthRouter.post("/grok-cli/poll", async (c) => {
  try {
    const body = await c.req.json<{ state?: string }>().catch(() => ({} as { state?: string }));
    const state = body.state || c.req.query("state") || "";
    if (!state) return c.json({ error: "Missing state" }, 400);

    const session = getGrokCliOAuthSession(state);
    if (!session) return c.json({ status: "unknown" });

    if (session.status === "done" || session.status === "error" || session.status === "cancelled" || session.status === "expired") {
      const consumed = consumeGrokCliOAuthSession(state);
      return c.json({
        status: consumed?.status,
        connection: consumed?.connection,
        error: consumed?.error,
      });
    }

    if (session.expiresAt < Date.now()) {
      updateGrokCliOAuthSession(state, { status: "expired", error: "Device code expired" });
      const consumed = consumeGrokCliOAuthSession(state);
      return c.json({ status: "expired", error: consumed?.error || "Device code expired" });
    }

    updateGrokCliOAuthSession(state, { status: "polling" });

    const response = await fetch(GROK_CLI_OAUTH.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": GROK_CLI_OAUTH.userAgent,
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: session.deviceCode,
        client_id: GROK_CLI_OAUTH.clientId,
      }),
    });

    let data: any;
    try {
      data = await response.json();
    } catch {
      const text = await response.text().catch(() => "");
      data = { error: "invalid_response", error_description: text };
    }

    if (data?.access_token) {
      const user = await fetchGrokCliUser(data.access_token);
      const connection = await completeGrokCliDeviceLogin({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        idToken: data.id_token,
        expiresIn: data.expires_in,
        scope: data.scope,
        user,
      });
      updateGrokCliOAuthSession(state, {
        status: "done",
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.name,
        },
      });
      const consumed = consumeGrokCliOAuthSession(state);
      return c.json({
        status: "done",
        connection: consumed?.connection,
      });
    }

    const err = String(data?.error || "");
    if (err === "authorization_pending" || err === "slow_down") {
      return c.json({
        status: "pending",
        error: err,
        interval: err === "slow_down" ? Math.max(session.intervalSec + 5, 10) : session.intervalSec,
        userCode: session.userCode,
        verificationUri: session.verificationUri,
      });
    }

    if (err === "expired_token" || err === "access_denied") {
      updateGrokCliOAuthSession(state, {
        status: err === "expired_token" ? "expired" : "error",
        error: data?.error_description || err,
      });
      const consumed = consumeGrokCliOAuthSession(state);
      return c.json({ status: consumed?.status, error: consumed?.error });
    }

    // unexpected error — keep session for a retry unless HTTP hard-fail
    if (!response.ok && !err) {
      updateGrokCliOAuthSession(state, {
        status: "error",
        error: `Token poll failed (${response.status})`,
      });
      const consumed = consumeGrokCliOAuthSession(state);
      return c.json({ status: "error", error: consumed?.error });
    }

    updateGrokCliOAuthSession(state, {
      status: "error",
      error: data?.error_description || err || "No access token",
    });
    const consumed = consumeGrokCliOAuthSession(state);
    return c.json({ status: "error", error: consumed?.error });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

oauthRouter.post("/grok-cli/cancel", async (c) => {
  const body = await c.req.json<{ state?: string }>().catch(() => ({} as { state?: string }));
  const state = body.state || c.req.query("state") || "";
  if (state) {
    updateGrokCliOAuthSession(state, { status: "cancelled", error: "Cancelled by user" });
    deleteGrokCliOAuthSession(state);
  }
  return c.json({ success: true });
});

/**
 * CodeBuddy global (www.codebuddy.ai) — device_code OAuth, ported from 9router codebuddy-intl.
 * GET  /api/oauth/codebuddy/device-code
 * POST /api/oauth/codebuddy/poll   body: { state }
 * POST /api/oauth/codebuddy/cancel body: { state }
 */
oauthRouter.get("/codebuddy/device-code", async (c) => {
  try {
    const { state, authUrl } = await requestCodebuddyDeviceCode();
    createCodebuddyOAuthSession({ state, authUrl });
    return c.json({
      state,
      flowType: "device_code",
      authUrl,
      interval: Math.max(3, Math.round(CODEBUDDY_OAUTH.pollIntervalMs / 1000)),
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

oauthRouter.post("/codebuddy/poll", async (c) => {
  try {
    const body = await c.req.json<{ state?: string }>().catch(() => ({} as { state?: string }));
    const state = body.state || c.req.query("state") || "";
    if (!state) return c.json({ error: "Missing state" }, 400);

    const session = getCodebuddyOAuthSession(state);
    if (!session) return c.json({ status: "unknown" });

    if (session.status === "done" || session.status === "error" || session.status === "cancelled" || session.status === "expired") {
      const consumed = consumeCodebuddyOAuthSession(state);
      return c.json({
        status: consumed?.status,
        connection: consumed?.connection,
        error: consumed?.error,
      });
    }

    if (session.expiresAt < Date.now()) {
      updateCodebuddyOAuthSession(state, { status: "expired", error: "Login expired" });
      const consumed = consumeCodebuddyOAuthSession(state);
      return c.json({ status: "expired", error: consumed?.error || "Login expired" });
    }

    updateCodebuddyOAuthSession(state, { status: "polling" });

    const result = await pollCodebuddyToken(state);

    if (result.status === "done" && result.accessToken) {
      const connection = await completeCodebuddyOAuthLogin({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? null,
        expiresIn: result.expiresIn ?? null,
        uid: result.uid ?? null,
      });
      updateCodebuddyOAuthSession(state, {
        status: "done",
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.name,
        },
      });
      const consumed = consumeCodebuddyOAuthSession(state);
      return c.json({ status: "done", connection: consumed?.connection });
    }

    if (result.status === "pending") {
      return c.json({ status: "pending" });
    }

    updateCodebuddyOAuthSession(state, { status: "error", error: result.error });
    const consumed = consumeCodebuddyOAuthSession(state);
    return c.json({ status: "error", error: consumed?.error });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

oauthRouter.post("/codebuddy/cancel", async (c) => {
  const body = await c.req.json<{ state?: string }>().catch(() => ({} as { state?: string }));
  const state = body.state || c.req.query("state") || "";
  if (state) {
    updateCodebuddyOAuthSession(state, { status: "cancelled", error: "Cancelled by user" });
    deleteCodebuddyOAuthSession(state);
  }
  return c.json({ success: true });
});

/**
 * Claude (Claude.ai / Claude Code) — authorization_code + PKCE, copy/paste flow.
 * GET  /api/oauth/claude/authorize
 * POST /api/oauth/claude/complete  body: { state, code }  // code may be CODE#STATE
 * GET  /api/oauth/claude/poll-status?state=
 * POST /api/oauth/claude/cancel    body: { state }
 */
oauthRouter.get("/claude/authorize", (c) => {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const authUrl = buildClaudeAuthorizeUrl(codeChallenge, state);

  createClaudeOAuthSession({ state, codeVerifier, authUrl });
  updateClaudeOAuthSession(state, { status: "waiting_code" });

  return c.json({
    authUrl,
    state,
    codeVerifier,
    codeChallenge,
    flowType: "authorization_code_pkce",
    pasteHint: "After login, paste the code (or full CODE#STATE) from the success page.",
  });
});

oauthRouter.post("/claude/complete", async (c) => {
  let state = "";
  try {
    const body = await c.req.json<{ state?: string; code?: string; codeVerifier?: string }>();
    state = (body.state || "").trim();
    const code = (body.code || "").trim();
    if (!code) return c.json({ error: "Missing authorization code" }, 400);

    let codeVerifier = (body.codeVerifier || "").trim();
    if (state) {
      const session = getClaudeOAuthSession(state);
      if (!session) return c.json({ error: "OAuth session expired or not found" }, 400);
      codeVerifier = codeVerifier || session.codeVerifier;
      updateClaudeOAuthSession(state, { status: "exchanging", error: undefined });
    }
    if (!codeVerifier) return c.json({ error: "Missing code_verifier / state" }, 400);

    const connection = await completeClaudeOAuthLogin({
      code,
      codeVerifier,
      state: state || undefined,
    });

    if (state) {
      updateClaudeOAuthSession(state, {
        status: "done",
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.name,
          plan: connection.plan,
        },
      });
    }

    return c.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.name,
        plan: connection.plan,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (state) updateClaudeOAuthSession(state, { status: "error", error: message });
    return c.json({ error: message }, 400);
  }
});

oauthRouter.get("/claude/poll-status", (c) => {
  const state = c.req.query("state") || "";
  if (!state) return c.json({ status: "unknown", error: "Missing state" });
  const session = getClaudeOAuthSession(state);
  if (!session) return c.json({ status: "not_found" });

  if (session.status === "done" || session.status === "error" || session.status === "cancelled") {
    const consumed = consumeClaudeOAuthSession(state);
    return c.json({
      status: consumed?.status,
      connection: consumed?.connection,
      error: consumed?.error,
    });
  }

  return c.json({ status: session.status, authUrl: session.authUrl });
});

oauthRouter.post("/claude/cancel", async (c) => {
  const body = await c.req.json<{ state?: string }>().catch(() => ({} as { state?: string }));
  const state = body.state || c.req.query("state") || "";
  if (state) {
    updateClaudeOAuthSession(state, { status: "cancelled", error: "Cancelled by user" });
    deleteClaudeOAuthSession(state);
  }
  return c.json({ success: true });
});

// ============================================================================
// Antigravity OAuth - Exact Cartethyia/9router implementation with loopback server
// ============================================================================

oauthRouter.post("/antigravity/authorize", async (c) => {
  try {
    // 9router pattern: public installed-app OAuth client (no PKCE, no env setup).
    const body = await c.req.json<{ redirectUri?: string }>().catch(() => ({}) as { redirectUri?: string });
    const redirectUri =
      body.redirectUri && /^https?:\/\/localhost:\d+\/oauth\/antigravity\/callback$/.test(body.redirectUri)
        ? body.redirectUri
        : `http://localhost:${config.dashboardPort}/oauth/antigravity/callback`;

    const googleClientId = ANTIGRAVITY_OAUTH.clientId;
    const googleClientSecret = ANTIGRAVITY_OAUTH.clientSecret;
    
    console.log(`[Antigravity] Authorize: client ${googleClientId.substring(0, 25)}... -> ${redirectUri}`);

    // NO PKCE - simple authorization code flow (matches 9router antigravity).
    // Create session WITHOUT code verifier; the session owns the state value.
    const session = createAntigravityOAuthSession("", undefined);
    
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", googleClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email", 
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ].join(" "));
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", session.state);

    // Store the real authUrl so /complete can recover the exact redirect_uri.
    updateAntigravityOAuthSession(session.state, { authUrl: authUrl.toString() });

    return c.json({
      authUrl: authUrl.toString(),
      state: session.state,
      redirectUri,
    });
  } catch (error) {
    console.error("[Antigravity OAuth] authorize error:", error);
    return c.json(
      { 
        error: "Failed to initialize OAuth",
        details: error instanceof Error ? error.message : String(error)
      },
      500
    );
  }
});

oauthRouter.get("/antigravity/status", async (c) => {
  const state = c.req.query("state") || "";
  const session = getAntigravityOAuthSession(state);
  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 404);
  }

  if (session.status === "done" && session.connection) {
    const consumed = consumeAntigravityOAuthSession(state);
    return c.json({
      status: consumed?.status,
      connection: consumed?.connection,
      error: consumed?.error,
    });
  }

  return c.json({ status: session.status, authUrl: session.authUrl });
});

oauthRouter.post("/antigravity/cancel", async (c) => {
  const body = await c.req.json<{ state?: string }>().catch(() => ({} as { state?: string }));
  const state = body.state || c.req.query("state") || "";
  if (state) {
    updateAntigravityOAuthSession(state, { status: "cancelled", error: "Cancelled by user" });
    deleteAntigravityOAuthSession(state);
  }
  return c.json({ success: true });
});

// ============================================================================
// Backend OAuth Callback Handler - This receives Google's redirect after auth
// ============================================================================

oauthRouter.get("/antigravity/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  
  if (!code || !state) {
    console.error("[Antigravity OAuth] Callback missing code or state");
    return c.html(`
      <html>
        <head><title>OAuth Error</title></head>
        <body style="font-family:sans-serif;padding:50px;text-align:center;">
          <h1 style="color:red;">❌ Authentication Failed</h1>
          <p>Missing authorization code or state parameter.</p>
          <a href="http://localhost:1931">Go to dashboard</a>
        </body>
      </html>
    `, 400);
  }

  try {
    // Update session status
    updateAntigravityOAuthSession(state, { status: "exchanging" });
    
    const session = getAntigravityOAuthSession(state);
    if (!session) {
      throw new Error("OAuth session not found or expired");
    }

    // Exchange code for tokens & provision project (redirect_uri must match authorize).
    const redirectUri = session.authUrl
      ? new URL(session.authUrl).searchParams.get("redirect_uri") || `http://localhost:${config.dashboardPort}/oauth/antigravity/callback`
      : `http://localhost:${config.dashboardPort}/oauth/antigravity/callback`;
    const connection = await completeAntigravityOAuthLogin(code, redirectUri, state);
    
    updateAntigravityOAuthSession(state, {
      status: "done",
      connection,
      error: undefined,
    });

    // Return HTML page with postMessage to opener window
    return c.html(`
      <html>
        <head><title>Authentication Successful!</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:50px;background:#f5f5f5;">
          <h1 style="color:#22c55e;font-size:3em;">✓</h1>
          <h1>Authentication Successful!</h1>
          <p>Email: ${connection.email || "Google User"}</p>
          <p>Project ID: ${connection.projectId || "Provisioning..."}</p>
        </body>
        <script>
          setTimeout(function() {
            window.opener.postMessage({ 
              type: "oauth_callback", 
              data: { code: "${code}", state: "${state}", success: true } 
            }, "*");
            alert("Success! Click OK to close window.");
            window.close();
          }, 1000);
        </script>
      </html>
    `);
  } catch (err) {
    console.error("[Antigravity OAuth Callback] Error:", err);
    const errorMsg = err instanceof Error ? err.message : String(err);
    updateAntigravityOAuthSession(state, { status: "error", error: errorMsg });
    return c.html(`<html><body><h1 style="color:red;">Error: ${errorMsg}</h1><a href="http://localhost:1931">Back to Dashboard</a></body></html>`, 400);
  }
});

oauthRouter.post("/antigravity/complete", async (c) => {
  const body = await c.req.json<{ code?: string; state?: string; callbackUrl?: string }>().catch(() => ({} as any));
  const code = body.code || new URLSearchParams(c.req.url.split("?")[1]).get("code");
  const state = body.state || new URLSearchParams(c.req.url.split("?")[1]).get("state");
  const callbackUrl = body.callbackUrl;
  const startMs = Date.now();

  if (!code || !state) {
    throw new Error("Missing code or state parameter");
  }

  try {
    updateAntigravityOAuthSession(state, { status: "exchanging", error: undefined });

    const session = getAntigravityOAuthSession(state);
    if (!session) {
      throw new Error("OAuth session not found or expired");
    }

    // Parse callback URL if provided
    const redirectUri = callbackUrl ? callbackUrl : new URL(session.authUrl!).searchParams.get("redirect_uri")!;

    const connection = await completeAntigravityOAuthLogin(code, redirectUri, state);
    
    updateAntigravityOAuthSession(state, {
      status: "done",
      connection,
      error: undefined,
    });

    const consumed = consumeAntigravityOAuthSession(state);
    return c.json({
      success: true,
      connection: consumed?.connection,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[Antigravity OAuth] /complete failed (${Date.now() - startMs}ms):`, errorMessage);
    updateAntigravityOAuthSession(state, { 
      status: "error", 
      error: errorMessage 
    });
    return c.json({ success: false, error: errorMessage }, 400);
  }
});

// Catch-all routes for unsupported providers/actions (MUST BE LAST)
oauthRouter.post("/:provider/poll", (c) => {
  return c.json({ error: "Unsupported provider/action" }, 400);
});

oauthRouter.all("/:provider/:action", (c) => {
  return c.json({ error: "Unsupported provider/action" }, 400);
});

export default oauthRouter;

