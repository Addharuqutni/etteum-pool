# Ponytail Debt Ledger

Deliberate shortcuts in this repo are tagged with `ponytail:` comments naming
their **ceiling** (what was traded away) and **upgrade path** (the trigger to
revisit). This file collects them so a deferral can't quietly become permanent.

> **Snapshot, not a live view.** Regenerate after touching anything below:
> `grep -rnE '(#|//) ?ponytail:' .` (skipping `node_modules`, `.git`, build output).
> Last harvested: 2026-09-18.

A `no-trigger` tag marks a marker that names no upgrade path or condition — the
rows that rot silently, because nothing will ever flag them as stale.

---

## `etteum.ps1`

| Line | Simplified | Ceiling | Upgrade |
| ---- | ---------- | ------- | ------- |
| 78 | Log rotation keeps the current boot plus one `.prev` | One generation of history | Rotate to N-generations if operators need history |

## `scripts/auth/app/providers/antigravity.py`

| Line | Simplified | Ceiling | Upgrade |
| ---- | ---------- | ------- | ------- |
| 246 | Provisioning poll is a fixed 30×2s loop | ~60 s of waiting | Switch to server-suggested backoff if provisioning starts exceeding 60 s |
| 385 | Minimal chromium branch duplicating the camoufox launch path | Divergent manager/browser/page keys | Share manager/browser/page keys with the camoufox branch |
| 646 | Hardcoded `{limit: 1, remaining: 1}` sentinel instead of a real credit counter | No per-account credit tracking for antigravity; the sentinel is shaped to dodge codebuddy's mandatory-quota branch (`runner.ts:519`, `:533`) | `no-trigger` — names the mechanism, not a condition |

## `src/api/oauth-antigravity-session.ts`

| Line | Simplified | Ceiling | Upgrade |
| ---- | ---------- | ------- | ------- |
| 64 | Expired antigravity sessions reaped opportunistically by the expiry check in `/antigravity/status` | No background sweeper; the map grows with abandoned sessions | Revisit at higher traffic levels (threshold undefined — borderline) |

## `src/api/oauth.ts`

| Line | Simplified | Ceiling | Upgrade |
| ---- | ---------- | ------- | ------- |
| 3 | One in-process `Map` holds PKCE state for every provider during the auth flow | Single-process only; state lost on restart, not shared across instances | `no-trigger` — design note, no revisit condition |

## `src/api/proxy-pool.ts`

| Line | Simplified | Ceiling | Upgrade |
| ---- | ---------- | ------- | ------- |
| 135 | `/pool/check-all` includes errored proxies so they can recover; disabled stay manual-only | Disabled entries never auto-revive | `no-trigger` — states current policy |
| 143 | Check-all runs a fixed pool of 10 workers | 10 concurrent; unbounded spawn plus parallel SQLite writes causes `SQLITE_BUSY` | `no-trigger` — cites the reason for the bound, not a signal to raise it |

## `src/proxy/filters.ts`

| Line | Simplified | Ceiling | Upgrade |
| ---- | ---------- | ------- | ------- |
| 181 | `FILTER_MAX_INPUT_BYTES = 256 * 1024` is a flat cap (motivated by a Bun <1.4 VM segfault under memory pressure) | Content above 256 KiB is refused wholesale, with no partial matching | Add pattern-aware whitelisting if any rule ever needs to match genuinely large content |

## `src/proxy/providers/codebuddy-china.ts`

| Line | Simplified | Ceiling | Upgrade |
| ---- | ---------- | ------- | ------- |
| 186 | `cbc-minimax-m2.7` specs copied from m3, vision disabled | Unverified specs, no vision on the M2.7 tier | Confirm against CN docs when the MiniMax-M2.7 page ships |

## `src/proxy/providers/codebuddy.ts`

| Line | Simplified | Ceiling | Upgrade |
| ---- | ---------- | ------- | ------- |
| 50 | `cleanAuthToken` strips trailing CR/LF from imported tokens (undici rejects them as invalid header values) | Works around malformed stored tokens on every read instead of at import | `no-trigger` — explains why the strip is needed, not when to remove it |

## `src/services/alerts.ts`

| Line | Simplified | Ceiling | Upgrade |
| ---- | ---------- | ------- | ------- |
| 48 | Alert cooldown lives in an in-memory `Map`; all other alert state is in the DB | Cooldown resets on restart — only spam-prevention is lost, accepted as harmless | `no-trigger` — explicitly accepted as-is |

## `src/services/proxy-pool.ts`

| Line | Simplified | Ceiling | Upgrade |
| ---- | ---------- | ------- | ------- |
| 104 | Per-proxy scope is ANDed with global scope | No OR / override semantics | `no-trigger` — describes current semantics |
| 191 | `/dev/null` swapped for `NUL` on win32 (curl has no `/dev/null` there) | Platform branch covers only the two known cases | `no-trigger` — portability fix with rationale; nothing marks it for removal |

---

**13 markers, 7 with no trigger.**

The `no-trigger` rows cluster in `src/api/proxy-pool.ts`, `src/services/proxy-pool.ts`,
`src/services/alerts.ts`, `src/api/oauth.ts`, `src/proxy/providers/codebuddy.ts`, and
`antigravity.py:646`. They read as explanations of current behaviour rather than
deferrals — either give them a real trigger, or downgrade the comment to a plain
`//` note so the ledger stays a list of genuine debt.

## Not debt

- `docs/compression.md` — example strings illustrating the marker format.
- `src/proxy/compression/compression.test.ts` — fixtures for the output marker
  scanner (`scanPonytailMarkers`). These are test data, not deferrals.

## Related

- [`compression.md`](compression.md) — the Ponytail technique, marker format, and
  the `scanPonytailMarkers()` telemetry that surfaces these markers at runtime.
