import { createSessionStore, type SessionBase } from "./oauth-session-store";

type CodexOAuthStatus = "pending" | "waiting_callback" | "exchanging" | "done" | "error" | "cancelled";

export interface CodexOAuthSession extends SessionBase {
  status: CodexOAuthStatus;
  codeVerifier: string;
  redirectUri: string;
  appPort?: string;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
    workspace?: string | null;
    plan?: string | null;
  };
}

interface CodexCreateInput {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  appPort?: string;
}

const store = createSessionStore<CodexOAuthSession, CodexCreateInput>({
  ttlMs: 10 * 60 * 1000,
  init: (input) => ({
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
    appPort: input.appPort,
  }),
});

export const createCodexOAuthSession = store.create;
export const getCodexOAuthSession = store.get;
export const updateCodexOAuthSession = store.update;
export const consumeCodexOAuthSession = store.consume;
export const deleteCodexOAuthSession = store.delete;
