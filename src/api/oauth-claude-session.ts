type ClaudeOAuthStatus = "pending" | "waiting_code" | "exchanging" | "done" | "error" | "cancelled";

export interface ClaudeOAuthSession {
  state: string;
  codeVerifier: string;
  authUrl: string;
  status: ClaudeOAuthStatus;
  createdAt: number;
  updatedAt: number;
  consumedAt?: number;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
    plan?: string | null;
  };
  error?: string;
}

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map<string, ClaudeOAuthSession>();

function now() {
  return Date.now();
}

function pruneExpiredSessions() {
  const cutoff = now() - SESSION_TTL_MS;
  for (const [state, session] of sessions) {
    if (session.updatedAt < cutoff || session.createdAt < cutoff) {
      sessions.delete(state);
    }
  }
}

export function createClaudeOAuthSession(input: {
  state: string;
  codeVerifier: string;
  authUrl: string;
}) {
  pruneExpiredSessions();
  const ts = now();
  const session: ClaudeOAuthSession = {
    state: input.state,
    codeVerifier: input.codeVerifier,
    authUrl: input.authUrl,
    status: "pending",
    createdAt: ts,
    updatedAt: ts,
  };
  sessions.set(input.state, session);
  return session;
}

export function getClaudeOAuthSession(state: string) {
  pruneExpiredSessions();
  return sessions.get(state) || null;
}

export function updateClaudeOAuthSession(state: string, patch: Partial<ClaudeOAuthSession>) {
  const current = getClaudeOAuthSession(state);
  if (!current) return null;
  const next: ClaudeOAuthSession = {
    ...current,
    ...patch,
    updatedAt: now(),
  };
  sessions.set(state, next);
  return next;
}

export function consumeClaudeOAuthSession(state: string) {
  const session = getClaudeOAuthSession(state);
  if (!session) return null;
  const consumedAt = now();
  if (["done", "error", "cancelled"].includes(session.status)) {
    sessions.delete(state);
    return { ...session, consumedAt };
  }
  return { ...session, consumedAt };
}

export function deleteClaudeOAuthSession(state: string) {
  return sessions.delete(state);
}
