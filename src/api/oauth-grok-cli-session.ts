type GrokCliOAuthStatus = "pending" | "polling" | "done" | "error" | "cancelled" | "expired";

export interface GrokCliOAuthSession {
  state: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSec: number;
  expiresAt: number;
  status: GrokCliOAuthStatus;
  createdAt: number;
  updatedAt: number;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
  };
  error?: string;
}

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map<string, GrokCliOAuthSession>();

function now() {
  return Date.now();
}

function pruneExpiredSessions() {
  const cutoff = now() - SESSION_TTL_MS;
  for (const [state, session] of sessions) {
    if (session.updatedAt < cutoff || session.createdAt < cutoff || session.expiresAt < now()) {
      if (session.status === "pending" || session.status === "polling") {
        session.status = "expired";
      }
      if (session.updatedAt < cutoff || session.createdAt < cutoff) {
        sessions.delete(state);
      }
    }
  }
}

export function createGrokCliOAuthSession(input: {
  state: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSec: number;
  expiresInSec: number;
}) {
  pruneExpiredSessions();
  const ts = now();
  const session: GrokCliOAuthSession = {
    state: input.state,
    deviceCode: input.deviceCode,
    userCode: input.userCode,
    verificationUri: input.verificationUri,
    verificationUriComplete: input.verificationUriComplete,
    intervalSec: Math.max(1, input.intervalSec || 5),
    expiresAt: ts + Math.max(30, input.expiresInSec || 900) * 1000,
    status: "pending",
    createdAt: ts,
    updatedAt: ts,
  };
  sessions.set(input.state, session);
  return session;
}

export function getGrokCliOAuthSession(state: string) {
  pruneExpiredSessions();
  return sessions.get(state) || null;
}

export function updateGrokCliOAuthSession(state: string, patch: Partial<GrokCliOAuthSession>) {
  const current = getGrokCliOAuthSession(state);
  if (!current) return null;
  const next: GrokCliOAuthSession = {
    ...current,
    ...patch,
    updatedAt: now(),
  };
  sessions.set(state, next);
  return next;
}

export function consumeGrokCliOAuthSession(state: string) {
  const session = getGrokCliOAuthSession(state);
  if (!session) return null;
  if (["done", "error", "cancelled", "expired"].includes(session.status)) {
    sessions.delete(state);
  }
  return session;
}

export function deleteGrokCliOAuthSession(state: string) {
  return sessions.delete(state);
}
