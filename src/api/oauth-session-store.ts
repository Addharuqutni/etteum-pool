/**
 * Generic in-memory store for OAuth flow sessions.
 *
 * Every provider's flow needs the same five operations over a `Map<state, session>`:
 * create, get, update, consume, delete — with a TTL prune on the read paths. This
 * is that shape once, so provider modules only declare their session type.
 *
 * Sessions are intentionally process-local: an OAuth handshake lives for minutes
 * and is always served by the process that started it.
 */

/** Terminal states — `consume()` removes sessions in any of these. */
const TERMINAL_STATUSES: Record<string, true> = {
  done: true,
  error: true,
  cancelled: true,
  expired: true,
};

export interface SessionBase {
  state: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  consumedAt?: number;
  connection?: unknown;
  error?: string;
}

/** Provider-specific fields materialised by `init()`. */
type SessionFields<T extends SessionBase> = Omit<
  T,
  "state" | "status" | "createdAt" | "updatedAt"
>;

export interface SessionStoreOptions<T extends SessionBase, TCreate extends { state: string }> {
  /** How long an untouched session survives, in ms. */
  ttlMs: number;
  /** Stamp `status: "expired"` on non-terminal sessions past `expiresAt`. */
  markExpired?: boolean;
  /** Build the provider-specific fields from `create()`'s input. */
  init: (input: TCreate) => SessionFields<T>;
}

export interface SessionStore<T extends SessionBase, TCreate extends { state: string }> {
  create(input: TCreate): T;
  get(state: string): T | null;
  update(state: string, patch: Partial<T>): T | null;
  consume(state: string): (T & { consumedAt: number }) | null;
  delete(state: string): boolean;
}

export function createSessionStore<T extends SessionBase, TCreate extends { state: string }>(
  opts: SessionStoreOptions<T, TCreate>
): SessionStore<T, TCreate> {
  const sessions = new Map<string, T>();

  function prune(): void {
    const currentTime = Date.now();
    const cutoff = currentTime - opts.ttlMs;
    for (const [state, session] of sessions) {
      // View as SessionBase so the "expired" write is legal even when the
      // provider's status union does not name it. Same object, wider type.
      const base: SessionBase = session;
      const expired = base.expiresAt !== undefined && base.expiresAt < currentTime;
      if (expired && opts.markExpired && !TERMINAL_STATUSES[base.status]) {
        base.status = "expired";
      }
      if (base.updatedAt < cutoff || base.createdAt < cutoff) {
        sessions.delete(state);
      }
    }
  }

  function get(state: string): T | null {
    prune();
    return sessions.get(state) ?? null;
  }

  return {
    create(input: TCreate): T {
      prune();
      const ts = Date.now();
      const session = {
        ...opts.init(input),
        state: input.state,
        status: "pending",
        createdAt: ts,
        updatedAt: ts,
      } as T;
      sessions.set(session.state, session);
      return session;
    },

    get,

    update(state: string, patch: Partial<T>): T | null {
      const current = get(state);
      if (!current) return null;
      const next: T = { ...current, ...patch, updatedAt: Date.now() };
      sessions.set(state, next);
      return next;
    },

    consume(state: string) {
      const session = get(state);
      if (!session) return null;
      const consumedAt = Date.now();
      if (TERMINAL_STATUSES[session.status]) sessions.delete(state);
      return { ...session, consumedAt };
    },

    delete(state: string): boolean {
      return sessions.delete(state);
    },
  };
}
