type CodebuddyOAuthStatus = "pending" | "polling" | "done" | "error" | "cancelled" | "expired";

export interface CodebuddyOAuthSession {
  state: string;
  authUrl: string;
  status: CodebuddyOAuthStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  consumedAt?: number;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
  };
  error?: string;
}

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map<string, CodebuddyOAuthSession>();

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

export function createCodebuddyOAuthSession(input: {
  state: string;
  authUrl: string;
  expiresInSec?: number;
}) {
  pruneExpiredSessions();
  const ts = now();
  const session: CodebuddyOAuthSession = {
    state: input.state,
    authUrl: input.authUrl,
    status: "pending",
    createdAt: ts,
    updatedAt: ts,
    expiresAt: ts + Math.max(60, input.expiresInSec || 600) * 1000,
  };
  sessions.set(input.state, session);
  return session;
}

export function getCodebuddyOAuthSession(state: string) {
  pruneExpiredSessions();
  return sessions.get(state) || null;
}

export function updateCodebuddyOAuthSession(state: string, patch: Partial<CodebuddyOAuthSession>) {
  const current = getCodebuddyOAuthSession(state);
  if (!current) return null;
  const next: CodebuddyOAuthSession = {
    ...current,
    ...patch,
    updatedAt: now(),
  };
  sessions.set(state, next);
  return next;
}

export function consumeCodebuddyOAuthSession(state: string) {
  const session = getCodebuddyOAuthSession(state);
  if (!session) return null;
  const consumedAt = now();
  if (["done", "error", "cancelled", "expired"].includes(session.status)) {
    sessions.delete(state);
    return { ...session, consumedAt };
  }
  return { ...session, consumedAt };
}

export function deleteCodebuddyOAuthSession(state: string) {
  return sessions.delete(state);
}
