/**
 * Sticky cache-affine sessions: pin a conversation to the account that
 * served it, so provider prompt caches (Anthropic cache_control, OpenAI
 * cache breakpoints) actually hit on follow-up turns.
 *
 * Key is derived from what stays constant across turns: model + client
 * `user` field (or first message content) — NOT the full body, which
 * changes every turn.
 *
 * ponytail: in-memory Map only — a restart loses stickiness until the next
 * turn (acceptable, same trade as alerts cooldown). Multi-instance scale-out
 * would need a shared store; add when a second proxy process appears.
 */

const STICKY_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 2048;
const PREFIX_SAMPLE = 256;

export interface StickyEntry {
  accountId: number;
  provider: string;
  expiresAt: number;
}

export class StickyStore {
  private map = new Map<string, StickyEntry>();

  get(key: string, provider: string): number | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (entry.expiresAt <= now || entry.provider !== provider) {
      this.map.delete(key);
      return null;
    }
    return entry.accountId;
  }

  set(key: string, accountId: number, provider: string): void {
    const now = Date.now();
    // Keep the map bounded: evict oldest (first inserted) entry at capacity.
    if (this.map.size >= MAX_ENTRIES && !this.map.has(key)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { accountId, provider, expiresAt: now + STICKY_TTL_MS });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Remove expired entries. Returns number of entries removed. */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.map.size;
  }
}

export const stickyStore = new StickyStore();

/** Small deterministic 32-bit string hash (FNV-1a) — cheap, good enough. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Derive a sticky key from what is stable across conversation turns:
 * the client `user` field when present, else the first non-empty text
 * message content (system prompt typically). Returns null when the request
 * carries no usable session anchor (then routing stays purely load-balanced).
 */
export function computeStickyKey(
  model: string,
  body: { user?: unknown; messages?: unknown[] } | undefined | null
): string | null {
  if (!body) return null;
  if (typeof model !== "string" || !model) return null;

  let base: string | undefined;
  if (typeof body.user === "string" && body.user.trim()) {
    base = body.user.trim();
  } else if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const content = (msg as { content?: unknown })?.content;
      if (typeof content === "string" && content.trim()) {
        base = content.trim().slice(0, PREFIX_SAMPLE);
        break;
      }
    }
  }

  if (!base) return null;
  return `${model}::${hashString(base)}`;
}