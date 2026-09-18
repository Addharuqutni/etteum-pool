import { createSessionStore, type SessionBase } from "./oauth-session-store";

type CodebuddyOAuthStatus = "pending" | "polling" | "done" | "error" | "cancelled" | "expired";

export interface CodebuddyOAuthSession extends SessionBase {
  status: CodebuddyOAuthStatus;
  authUrl: string;
  expiresAt: number;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
  };
}

interface CodebuddyCreateInput {
  state: string;
  authUrl: string;
  expiresInSec?: number;
}

const store = createSessionStore<CodebuddyOAuthSession, CodebuddyCreateInput>({
  ttlMs: 15 * 60 * 1000,
  // Past `expiresAt`, pending/polling sessions flip to "expired" rather than
  // vanishing, so the polling client gets a definitive answer.
  markExpired: true,
  init: (input) => ({
    authUrl: input.authUrl,
    expiresAt: Date.now() + Math.max(60, input.expiresInSec || 600) * 1000,
  }),
});

export const createCodebuddyOAuthSession = store.create;
export const getCodebuddyOAuthSession = store.get;
export const updateCodebuddyOAuthSession = store.update;
export const consumeCodebuddyOAuthSession = store.consume;
export const deleteCodebuddyOAuthSession = store.delete;
