import { randomBytes } from "crypto";
import { createSessionStore, type SessionBase } from "./oauth-session-store";

export interface AntigravityOAuthSession extends SessionBase {
  status:
    | "pending"
    | "waiting_authorization"
    | "exchanging"
    | "done"
    | "error"
    | "cancelled"
    | "expired";
  codeVerifier?: string;
  authUrl?: string;
  expiresAt: number;
  connection?: {
    id: number | string;
    provider: "antigravity";
    email: string;
    displayName?: string;
    projectId: string;
  };
}

interface AntigravityCreateInput {
  state: string;
  authUrl: string;
  codeVerifier?: string;
}

const SESSION_TIMEOUT_MS = 300 * 1000; // 5 minutes

const store = createSessionStore<AntigravityOAuthSession, AntigravityCreateInput>({
  // Read paths prune on the same 5-minute expiry that bounds the handshake;
  // `expiresAt` is what the /antigravity/status check reads.
  ttlMs: SESSION_TIMEOUT_MS,
  init: (input) => ({
    codeVerifier: input.codeVerifier,
    authUrl: input.authUrl,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  }),
});

export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Create a session with a freshly generated state, matching the original
 * call shape: `createAntigravityOAuthSession(authUrl, codeVerifier)`.
 */
export function createAntigravityOAuthSession(authUrl: string, codeVerifier?: string) {
  return store.create({ state: generateState(), authUrl, codeVerifier });
}

export const getAntigravityOAuthSession = store.get;
export const updateAntigravityOAuthSession = store.update;
export const consumeAntigravityOAuthSession = store.consume;
export const deleteAntigravityOAuthSession = store.delete;
