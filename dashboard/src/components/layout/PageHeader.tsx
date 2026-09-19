import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  /** Page name. Rendered mono + uppercase — this console speaks terminal. */
  title: string;
  /** Short operational meta: counts, source, scope. Sits inline, not stacked. */
  meta?: ReactNode;
  /** Buttons / filters aligned right. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Every page opens the same way: a thin primary rule, the page name in mono
 * caps, live counts inline beside it, actions right. No hero, no 2xl bold
 * title with a marketing subtitle under it — the operator already knows where
 * they are, so the header spends its space on numbers instead.
 *
 * ── Fixed header height ──────────────────────────────────────────────────
 * The title row is a fixed-height track (`h-8`) and the title is centred
 * inside it, so the page name lands at the SAME y on every screen no matter
 * how tall the actions block is. Without this the header measured anywhere
 * from 29px to 69px depending on the page, which made the title appear to
 * "float" at a different offset every time you navigated.
 *
 * Actions get `max-h-8` and are allowed to scroll horizontally rather than
 * wrap, so a busy toolbar can never grow the header vertically. Actions that
 * genuinely need two rows belong in a filter bar below the header, not here.
 *
 * ── Rhythm ───────────────────────────────────────────────────────────────
 * Title row (32px) → 12px padding → hairline. The page's first block then sits
 * 16px below that (space-y-4 on the page), so the header reads as attached to
 * the page rather than floating above a gap.
 */
export default function PageHeader({ title, meta, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        /* Mobile may wrap (meta drops to its own line); from sm up the header
           is a single fixed-height track so the title never shifts.
           `sm:min-h-11` = 44px = the 32px title row + 12px bottom padding.
           Using a fixed `h-8` here would be a border-box height that also has
           to contain pb-3, squeezing the padding down to 6px. */
        "flex flex-wrap items-center justify-between gap-x-4 border-b border-[var(--border)] pb-3 sm:min-h-11 sm:flex-nowrap",
        className
      )}
    >
      <div className="flex h-8 min-w-0 items-center gap-2.5">
        {/* Marker matches the cap height of the title so the two align as one
            mark, not a pill parked next to some text. */}
        <span aria-hidden className="h-3.5 w-[2px] shrink-0 rounded-sm bg-[var(--primary)]" />
        <h1 className="truncate font-mono text-title font-semibold uppercase leading-none tracking-caps text-[var(--foreground)]">
          {title}
        </h1>
        {meta ? (
          <span className="hidden min-w-0 items-center gap-2 truncate font-mono text-meta tabular-nums text-[var(--muted-foreground)] sm:flex">
            <span aria-hidden className="text-[var(--border)]">│</span>
            {meta}
          </span>
        ) : null}
      </div>

      {actions ? (
        /* One row, never wrapping upward. `overflow-x-auto` keeps a long
           toolbar usable on a narrow screen without changing the header's
           height, which is what makes the title offset stable. */
        <div className="flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto">
          {actions}
        </div>
      ) : null}

      {/* Below sm the meta has no room inline, so it moves to its own line.
          `h-4` reserves the track only when meta exists — an empty span would
          otherwise add a stray zero-height flex item on pages without meta. */}
      {meta ? (
        <span className="hidden h-4 w-full items-center truncate font-mono text-meta tabular-nums text-[var(--muted-foreground)] max-sm:flex">
          {meta}
        </span>
      ) : null}
    </header>
  );
}
