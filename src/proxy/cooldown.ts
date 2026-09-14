/**
 * Graduated 429 backoff per account (Cartethyia-inspired T1 cooldown).
 *
 * Each rate-limit strike escalates the cooldown window: 30s, 60s, 120s,
 * 240s, capped at 300s. A successful request clears the strikes (and thus
 * the cooldown). Accounts in cooldown are excluded from pool selection; the
 * window expires naturally once `now` passes `until`.
 *
 * ponytail: in-memory only — a restart resets all cooldowns (acceptable:
 * a fresh process never hammered the provider yet). Persisting to DB only
 * matters for multi-instance setups; add when scaling out.
 */

const BASE_MS = 30_000;
const MAX_MS = 300_000;

interface CooldownState {
  until: number;
  strikes: number;
}

export class CooldownTracker {
  private map = new Map<number, CooldownState>();

  /**
   * Register a rate-limit strike. Escalates from the previous strike count
   * even if the previous window already expired (a provider still 429ing
   * after its window is not a fresh start).
   */
  mark(accountId: number, now: number = Date.now()): void {
    const prev = this.map.get(accountId);
    const strikes = (prev?.strikes ?? 0) + 1;
    const backoffMs = Math.min(BASE_MS * 2 ** (strikes - 1), MAX_MS);
    this.map.set(accountId, { until: now + backoffMs, strikes });
  }

  isCooldown(accountId: number, now: number = Date.now()): boolean {
    const state = this.map.get(accountId);
    if (!state) return false;
    // Pure check — do NOT delete here. Deletion would erase the strike count
    // and break cascade on the next mark(); sweep()/clear() own cleanup.
    return state.until > now;
  }

  activeIds(now: number = Date.now()): number[] {
    const out: number[] = [];
    for (const [id, state] of this.map) {
      if (state.until > now) out.push(id);
    }
    return out;
  }

  strikes(accountId: number): number {
    return this.map.get(accountId)?.strikes ?? 0;
  }

  clear(accountId: number): void {
    this.map.delete(accountId);
  }

  /** Remove expired entries. Returns number of entries removed. */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [id, state] of this.map) {
      if (state.until <= now) {
        this.map.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.map.size;
  }
}

export const cooldowns = new CooldownTracker();