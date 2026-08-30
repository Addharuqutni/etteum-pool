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
 * Rhythm: the hairline sits 12px under the title row and the page's first card
 * sits 16px under that (space-y-4 on the page), so the header reads as attached
 * to the page rather than floating above a gap.
 */
export default function PageHeader({ title, meta, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--border)] pb-3",
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {/* Marker matches the cap height of the title so the two align as one
            mark, not a pill parked next to some text. */}
        <span aria-hidden className="h-3.5 w-[2px] shrink-0 rounded-sm bg-[var(--primary)]" />
        <h1 className="truncate font-mono text-[15px] font-semibold uppercase leading-none tracking-[0.08em] text-[var(--foreground)]">
          {title}
        </h1>
        {meta ? (
          <span className="hidden min-w-0 items-center gap-2 truncate font-mono text-[11px] tabular-nums text-[var(--muted-foreground)] sm:flex">
            <span aria-hidden className="text-[var(--border)]">│</span>
            {meta}
          </span>
        ) : null}
      </div>

      {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}

      {meta ? (
        <span className="w-full font-mono text-[11px] tabular-nums text-[var(--muted-foreground)] sm:hidden">
          {meta}
        </span>
      ) : null}
    </header>
  );
}
