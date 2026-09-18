import { createSessionStore, type SessionBase } from "./oauth-session-store";

type GrokCliOAuthStatus = "pending" | "polling" | "done" | "error" | "cancelled" | "expired";

export interface GrokCliOAuthSession extends SessionBase {
  status: GrokCliOAuthStatus;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSec: number;
  expiresAt: number;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
  };
}

interface GrokCliCreateInput {
  state: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSec: number;
  expiresInSec: number;
}

const store = createSessionStore<GrokCliOAuthSession, GrokCliCreateInput>({
  ttlMs: 15 * 60 * 1000,
  init: (input) => ({
    deviceCode: input.deviceCode,
    userCode: input.userCode,
    verificationUri: input.verificationUri,
    verificationUriComplete: input.verificationUriComplete,
    intervalSec: Math.max(1, input.intervalSec || 5),
    expiresAt: Date.now() + Math.max(30, input.expiresInSec || 900) * 1000,
  }),
});

export const createGrokCliOAuthSession = store.create;
export const getGrokCliOAuthSession = store.get;
export const updateGrokCliOAuthSession = store.update;
export const consumeGrokCliOAuthSession = store.consume;
export const deleteGrokCliOAuthSession = store.delete;
