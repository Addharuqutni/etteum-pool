import { createSessionStore, type SessionBase } from "./oauth-session-store";

type ClaudeOAuthStatus = "pending" | "waiting_code" | "exchanging" | "done" | "error" | "cancelled";

export interface ClaudeOAuthSession extends SessionBase {
  status: ClaudeOAuthStatus;
  codeVerifier: string;
  authUrl: string;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
    plan?: string | null;
  };
}

interface ClaudeCreateInput {
  state: string;
  codeVerifier: string;
  authUrl: string;
}

const store = createSessionStore<ClaudeOAuthSession, ClaudeCreateInput>({
  ttlMs: 15 * 60 * 1000,
  init: (input) => ({
    codeVerifier: input.codeVerifier,
    authUrl: input.authUrl,
  }),
});

export const createClaudeOAuthSession = store.create;
export const getClaudeOAuthSession = store.get;
export const updateClaudeOAuthSession = store.update;
export const consumeClaudeOAuthSession = store.consume;
export const deleteClaudeOAuthSession = store.delete;
