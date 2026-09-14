import { randomBytes } from "crypto";

export interface AntigravityOAuthSession {
  state: string;
  codeVerifier?: string;
  status: "waiting_authorization" | "exchanging" | "done" | "error" | "cancelled" | "expired";
  authUrl?: string;
  connection?: {
    id: number | string;
    provider: "antigravity";
    email: string;
    displayName?: string;
    projectId: string;
  };
  error?: string;
  createdAt: number;
  expiresAt: number;
}

const antigravitySessions = new Map<string, AntigravityOAuthSession>();
const ANTIGRAVITY_SESSION_TIMEOUT_MS = 300 * 1000; // 5 minutes

export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

export function createAntigravityOAuthSession(authUrl: string, codeVerifier?: string): AntigravityOAuthSession {
  const state = generateState();
  const session: AntigravityOAuthSession = {
    state,
    codeVerifier,
    status: "waiting_authorization",
    authUrl,
    createdAt: Date.now(),
    expiresAt: Date.now() + ANTIGRAVITY_SESSION_TIMEOUT_MS,
  };
  antigravitySessions.set(state, session);
  return session;
}

export function getAntigravityOAuthSession(state: string): AntigravityOAuthSession | undefined {
  return antigravitySessions.get(state);
}

export function updateAntigravityOAuthSession(state: string, updates: Partial<Omit<AntigravityOAuthSession, "state" | "createdAt" | "expiresAt">>): void {
  const session = antigravitySessions.get(state);
  if (!session) return;

  Object.assign(session, updates);
}

export function consumeAntigravityOAuthSession(state: string): AntigravityOAuthSession | undefined {
  const session = antigravitySessions.get(state);
  if (!session) return undefined;

  antigravitySessions.delete(state);
  return session;
}

export function deleteAntigravityOAuthSession(state: string): void {
  antigravitySessions.delete(state);
}

// ponytail: sessions also die by expiry check in /antigravity/status; no sweeper needed at this traffic level
export function removeExpiredAntigravityOAuthSessions(): void {
  const now = Date.now();
  for (const [state, session] of antigravitySessions) {
    if (session.expiresAt < now) antigravitySessions.delete(state);
  }
}

export function orderAntigravityOAuthSessionsByUpdatedAt(): AntigravityOAuthSession[] {
  return [...antigravitySessions.values()].sort((a, b) => b.createdAt - a.createdAt);
}
