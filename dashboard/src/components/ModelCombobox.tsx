import { useEffect, useMemo, useState } from "react";
import { Search, ChevronsUpDown, Check, X } from "lucide-react";

/**
 * Searchable model dropdown. Extracted from Integration.tsx so the Combos
 * editor can reuse the same picker.
 *
 * The list is long (190+ models across providers), so the popover works hard to
 * keep you oriented: provider headers that stick to the top edge while their
 * group is in view, matched text highlighted in brand green while filtering, a
 * pinned count footer, and a bottom fade that only shows while there is more
 * list below. Arrow keys rove focus across rows; the rows themselves stay plain
 * buttons, so Enter, Space and Tab keep their native behavior.
 */

// Same chart tokens Models.tsx uses, so a provider reads the same color here as
// it does in the model table and the usage chart. One map, one source of truth —
// the badge derives its tint/border from the accent instead of a parallel list
// of Tailwind classes that can drift out of sync.
const providerVar: Record<string, string> = {
  codebuddy: "--chart-3",
  "codebuddy-china": "--chart-5",
  canva: "--chart-6",
  codex: "--chart-1",
  "grok-cli": "--chart-2",
  claude: "--chart-4",
  byok: "--chart-5",
};

function providerKey(owner: string): string {
  return owner.toLowerCase().startsWith("byok") ? "byok" : owner;
}

function providerLabel(provider: string): string {
  if (provider === "byok") return "BYOK";
  return provider
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/**
 * Display name + accent colors for a model's owner. Exported so the Combos chain
 * rows can label a member with the same color the picker used when it was
 * chosen — two models with similar names from different providers never look
 * identical in the chain.
 *
 * Two roles, because one token can't do both: `accent` is the FILL (the rank
 * dot, chart lines, tints) and `accentText` is the readable TEXT variant. In
 * light mode the neon fills are near-invisible as type, so the label uses
 * --chart-N-text while the dot keeps the vivid fill.
 */
export function providerTag(owner: string): {
  label: string;
  accent: string;
  accentText: string;
} {
  const key = providerKey(owner);
  const base = providerVar[key] ?? "--muted-foreground";
  return {
    label: providerLabel(key),
    accent: `var(${base})`,
    accentText:
      base === "--muted-foreground" ? `var(${base})` : `var(${base}-text)`,
  };
}

/**
 * Matched substring in brand green. One `indexOf`, not a regex — the query is
 * user text and escaping it for a regex costs more than it buys, and the filter
 * itself is a plain `includes`, so highlighting the first hit matches exactly
 * what made the row appear.
 */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-medium text-[var(--primary-text)]">
        {text.slice(at, at + q.length)}
      </mark>
      {text.slice(at + q.length)}
    </>
  );
}

export default function ModelCombobox({
  value,
  options,
  onChange,
  allowClear = true,
  placeholder = "— pass through (no mapping) —",
  onToggle,
  selected,
}: {
  value: string;
  options: { id: string; owned_by: string }[];
  onChange?: (id: string) => void;
  allowClear?: boolean;
  placeholder?: string;
  /**
   * Passing onToggle switches the picker to multi-select: a click toggles the
   * model instead of picking-and-closing, and the popover stays open until
   * Escape, an outside click, or Done. Callers that don't pass it (Integration)
   * keep the original single-select behavior untouched.
   */
  onToggle?: (id: string) => void;
  /** Which ids read as checked in multi mode. */
  selected?: Set<string>;
}) {
  const multi = Boolean(onToggle);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
  const [triggerRef, setTriggerRef] = useState<HTMLButtonElement | null>(null);
  const [inputRef, setInputRef] = useState<HTMLInputElement | null>(null);
  const [listRef, setListRef] = useState<HTMLUListElement | null>(null);
  const [atBottom, setAtBottom] = useState(false);
  /** Which way the popover opens, and how much height it may take. Starts
   *  unconstrained so the first painted frame is never a shrunken list; the
   *  measuring effect below narrows it only where the viewport demands. */
  const [drop, setDrop] = useState({ up: false, maxH: 9999 });

  /** Close and hand focus back to the trigger — closing must never drop focus
   *  to the body, or the next Tab restarts from the top of the page. */
  const close = () => {
    setOpen(false);
    triggerRef?.focus();
  };

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      // Outside click: no focus restore. The click already moved focus wherever
      // the user aimed, and yanking it back to the trigger would fight them.
      if (containerRef && !containerRef.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef?.focus();
      }
    }
    if (open) {
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("keydown", onKey);
    }
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, containerRef, triggerRef]);

  // Reopening should start from the top of the list, fade showing again, and
  // drop downward until measured — otherwise a popover that flipped up last time
  // flashes upward for a frame. In multi mode this is also the only place the
  // query resets, so picking several models in a row doesn't wipe the search
  // between clicks.
  useEffect(() => {
    if (!open) {
      setAtBottom(false);
      setQuery("");
      setDrop({ up: false, maxH: 9999 });
    }
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (o) =>
          o.id.toLowerCase().includes(q) ||
          o.owned_by.toLowerCase().includes(q)
      )
    : options;

  // A list that doesn't overflow never fires a scroll event, so the fade would
  // sit over the last rows forever — most visible when a search narrows 190 rows
  // down to three. Every new query also starts from the top, so the first hit is
  // the first thing on screen instead of wherever the previous scroll left off.
  useEffect(() => {
    if (!listRef) return;
    listRef.scrollTop = 0;
    setAtBottom(listRef.scrollHeight - listRef.clientHeight < 8);
  }, [listRef, filtered.length, query]);

  /**
   * Where the popover fits. The list wants 22rem, which is taller than the space
   * under the trigger when the editor card sits low in the viewport — on a short
   * window or a phone that means the last rows land off-screen.
   *
   * So: measure the gap above and below the trigger, drop upward only when down
   * is genuinely cramped and up is roomier, and cap the height to whatever side
   * we picked. When there is room for the full 22rem (the normal desktop case)
   * this changes nothing — `maxH` lands above the CSS cap and 22rem still wins.
   */
  useEffect(() => {
    if (!open || !triggerRef) return;

    // Direction is decided once, on open, and held for as long as the popover
    // stays open. Re-deciding on scroll would flip the list from under the
    // pointer mid-gesture, which is worse than a slightly cramped popover.
    const first = triggerRef.getBoundingClientRect();
    const edge = 12; // never touch the viewport edge
    const roomBelow = window.innerHeight - first.bottom - edge;
    const roomAbove = first.top - edge;
    const up = roomBelow < 240 && roomAbove > roomBelow;

    const measure = () => {
      const r = triggerRef.getBoundingClientRect();
      const room = up ? r.top - edge : window.innerHeight - r.bottom - edge;
      // Floor of 10rem: below that the popover is useless anyway, and the page
      // scroll container can bring the rest into view.
      setDrop({ up, maxH: Math.max(160, Math.round(room)) });
    };

    measure();
    window.addEventListener("resize", measure);
    // Capture phase: the scrolling element is <main>, not the window.
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, triggerRef]);

  // Grouped by provider, providers A→Z, models A→Z inside each. Only used
  // when there's no query — a search reads better as one flat hit list.
  const groups = useMemo(() => {
    const map = new Map<string, { id: string; owned_by: string }[]>();
    for (const o of options) {
      const key = providerKey(o.owned_by);
      const list = map.get(key);
      if (list) list.push(o);
      else map.set(key, [o]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([provider, list]) =>
          [provider, [...list].sort((a, b) => a.id.localeCompare(b.id))] as const
      );
  }, [options]);

  const isChecked = (id: string) => (multi ? Boolean(selected?.has(id)) : value === id);

  const pick = (id: string) => {
    if (multi) {
      // Stay open: the whole point is clicking several in a row. Query and
      // scroll position are left alone.
      onToggle!(id);
      return;
    }
    onChange?.(id);
    setOpen(false);
    setQuery("");
  };

  /**
   * Move focus one row up or down. Reads the rendered buttons out of the DOM
   * rather than tracking an active index in state: the list is already the
   * source of truth for what's visible, and the rows stay ordinary buttons —
   * Enter and Space keep working natively, and Tab still walks the list.
   */
  const rove = (dir: 1 | -1) => {
    const rows = listRef
      ? [...listRef.querySelectorAll<HTMLButtonElement>("button[data-row]")]
      : [];
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    // Up from the first row goes back to the search box rather than dead-ending,
    // so one hand can type, scan down, and correct the query without a reach.
    if (at === 0 && dir === -1) {
      inputRef?.focus();
      return;
    }
    const next =
      at < 0
        ? dir === 1
          ? 0
          : rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, at + dir));
    const el = rows[next];
    if (!el) return;
    el.focus();
    // block:nearest keeps the list still when the row is already visible; the
    // rows carry scroll-margin so a sticky provider header never covers it.
    el.scrollIntoView({ block: "nearest" });
  };

  const triggerCls =
    "flex w-full items-center justify-between gap-2 rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-body transition-colors duration-150 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35";

  // 40px rows on touch, back to terminal density on pointer devices. The ring is
  // inset so a keyboard walk down a long list is visible without the row jumping.
  // scroll-mt clears the sticky provider header when a row is scrolled into view.
  const rowCls = (checked: boolean) =>
    `flex min-h-[40px] w-full scroll-mt-8 items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-body transition-colors duration-150 hover:bg-[var(--secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]/35 md:min-h-0 ${
      checked ? "bg-[var(--secondary)]" : ""
    }`;

  /**
   * Position of each selected id, 1-based. `selected` is a Set and JS Sets keep
   * insertion order, so when the caller builds it from the chain array the order
   * is the chain order — the picker can show a model's rank without a new prop.
   */
  const rank = useMemo(() => {
    const map = new Map<string, number>();
    if (multi && selected) {
      let i = 1;
      for (const id of selected) map.set(id, i++);
    }
    return map;
  }, [multi, selected]);

  const row = (o: { id: string; owned_by: string }, showOwner: boolean) => {
    const checked = isChecked(o.id);
    const at = rank.get(o.id);
    const tag = providerTag(o.owned_by);
    return (
      <li key={o.id}>
        <button
          type="button"
          data-row
          onClick={() => pick(o.id)}
          className={rowCls(checked)}
          aria-pressed={multi ? checked : undefined}
          title={
            multi
              ? checked
                ? `${o.id} — position ${at} in chain, click to remove`
                : `${o.id} — click to append to chain`
              : o.id
          }
        >
          <span className="min-w-0 truncate text-[var(--foreground)]">
            <Highlight text={o.id} q={q} />
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {showOwner && (
              <span className="flex max-w-[7rem] items-center gap-1.5 text-meta text-[var(--muted-foreground)]">
                <span
                  aria-hidden
                  className="h-1 w-1 shrink-0 rounded-full"
                  style={{ backgroundColor: tag.accent }}
                />
                {/* Capped and truncated: a long provider name must not push the
                    rank chip and check off the row at 375px. */}
                <span className="truncate">
                  <Highlight text={o.owned_by} q={q} />
                </span>
              </span>
            )}
            {/* In multi mode the rank is the receipt: click a model and its
                chain position appears here, so the picker and the chain list
                are visibly the same thing. */}
            {at !== undefined && (
              <span className="font-mono text-micro font-medium tabular-nums text-[var(--primary-text)]">
                #{at}
              </span>
            )}
            {checked && <Check className="w-3.5 h-3.5 text-[var(--primary-text)]" />}
          </span>
        </button>
      </li>
    );
  };

  const selectedCount = selected?.size ?? 0;

  return (
    <div ref={setContainerRef} className="relative w-full">
      <button
        ref={setTriggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={triggerCls}
        aria-expanded={open}
      >
        <span
          className={
            value
              ? "truncate text-[var(--foreground)]"
              : "truncate text-[var(--muted-foreground)]"
          }
        >
          {value || placeholder}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {/* In multi mode the trigger otherwise says "Add models…" forever,
              even with six models chained — the count makes it report state. */}
          {multi && selectedCount > 0 && (
            <span className="font-mono text-meta tabular-nums text-[var(--primary-text)]">
              {selectedCount} in chain
            </span>
          )}
          <ChevronsUpDown className="w-4 h-4 opacity-60" />
        </span>
      </button>

      {open && (
        <div
          // Flips above the trigger when the space below is too tight. The
          // popover is a flex column with its own max-height so the search box
          // and the count/Done footer are always reachable — only the row list
          // gives up height.
          className={`absolute z-overlay flex w-full flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--card)] shadow-lg ${
            drop.up ? "bottom-full mb-1" : "top-full mt-1"
          }`}
          style={{ maxHeight: drop.maxH }}
          onKeyDown={(e) => {
            // Arrows rove focus across rows from anywhere in the popover, so
            // typing a query and pressing Down lands on the first hit without
            // reaching for the mouse. Rows stay plain buttons: Enter and Space
            // toggle natively, Tab still walks them in order.
            if (e.key === "ArrowDown") {
              e.preventDefault();
              rove(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              rove(-1);
            }
          }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] pl-2 pr-1 py-1.5">
            <Search
              className={`w-3.5 h-3.5 shrink-0 transition-colors duration-150 ${
                q ? "text-[var(--primary-text)]" : "text-[var(--muted-foreground)]"
              }`}
            />
            <input
              autoFocus
              ref={setInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${options.length} models…`}
              aria-label="Search models"
              className="w-full bg-transparent font-mono text-body text-[var(--foreground)] placeholder:text-[var(--muted-faint)] focus:outline-none"
            />
            {/* Only present while filtering — a permanent X next to an empty
                box reads as "clear the whole selection", which it is not.
                Clearing returns to the box so typing continues immediately. */}
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  inputRef?.focus();
                }}
                aria-label="Clear search"
                title="Clear search"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* While a query is active the grouping is gone, so this line stands
              in for the provider headers: it says the list is filtered and how
              many survived, and stays put above the results. Multi only — the
              single-select footer already carries an `n of 190 models` count. */}
          {multi && q && filtered.length > 0 && (
            <p className="shrink-0 border-b border-[var(--hairline)] bg-[var(--secondary)]/40 px-3 py-1 font-mono text-micro tabular-nums text-[var(--muted-foreground)]">
              {filtered.length} {filtered.length === 1 ? "match" : "matches"} · grouping off while
              searching
            </p>
          )}

          {/* Pinned outside the scroll area so clearing a mapping never
              requires scrolling back up. Meaningless in multi mode. */}
          {allowClear && !multi && (
            <button
              type="button"
              onClick={() => pick("")}
              className={`${rowCls(!value)} shrink-0 border-b border-[var(--hairline)]`}
            >
              <span className="text-[var(--muted-foreground)]">
                — pass through (no mapping) —
              </span>
              {!value && <Check className="w-3.5 h-3.5 text-[var(--primary-text)]" />}
            </button>
          )}

          {/* min-h-0 lets the list shrink inside the flex column instead of
              forcing the popover past its max-height and pushing the footer
              out of view. 22rem stays the cap when there is room for it. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <ul
              ref={setListRef}
              className="min-h-0 flex-1 max-h-[22rem] overflow-y-auto overscroll-contain"
              onScroll={(e) => {
                const el = e.currentTarget;
                setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 8);
              }}
            >
              {q
                ? filtered.map((o) => row(o, true))
                : groups.map(([provider, list]) => {
                    const tag = providerTag(provider);
                    return (
                      <li key={provider}>
                        {/* Sticky against the scrolling <ul>: the header holds
                            the top edge while its own group is in view, then the
                            next one pushes it out. In a 190-row list this is the
                            only thing telling you where you are. Opaque --card
                            background, or rows would ghost through it. */}
                        <div className="sticky top-0 z-sticky flex items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--card)] px-3 py-1.5">
                          <span
                            className="eyebrow rounded border px-1.5 py-0.5"
                            style={{
                              color: tag.accentText,
                              borderColor: `color-mix(in srgb, ${tag.accent} 30%, transparent)`,
                              backgroundColor: `color-mix(in srgb, ${tag.accent} 12%, transparent)`,
                            }}
                          >
                            {tag.label}
                          </span>
                          <span className="font-mono text-micro tabular-nums text-[var(--muted-foreground)]">
                            {list.length}
                          </span>
                        </div>
                        <ul>{list.map((o) => row(o, false))}</ul>
                      </li>
                    );
                  })}

              {/* Two different empty states. A query that matched nothing is the
                  user's to fix; an empty option list is the system's, and saying
                  "no models match" for it would send them hunting a typo. */}
              {filtered.length === 0 && (
                <li className="px-3 py-3 font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
                  {q ? (
                    <>
                      Nothing matches{" "}
                      <span className="text-[var(--foreground)]">{query}</span>. Search covers model
                      name and provider.
                    </>
                  ) : (
                    "No models available — check that accounts are connected and enabled."
                  )}
                </li>
              )}

              {/* Breathing room after the last row so it doesn't sit flush
                  against the footer rule and read as one more list item. */}
              {filtered.length > 0 && <li aria-hidden className="h-2" />}
            </ul>

            {/* Fade only while there is more list below, so a full scroll
                reads as "that's all" instead of "still truncated". */}
            {!atBottom && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--card)] to-transparent"
              />
            )}
          </div>

          {/* Footer states the same two numbers the chain header does, in the
              same order and wording, so nothing has to be reconciled by eye.
              Done is a real 40px target on touch and sits hard right, away from
              the count it would otherwise crowd. */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] pl-3 pr-1.5 font-mono text-meta tabular-nums text-[var(--muted-foreground)]">
            <span className="truncate py-1.5">
              {multi
                ? `${selectedCount} in chain · ${options.length} available`
                : q
                  ? `${filtered.length} of ${options.length} models`
                  : `${options.length} models · ${groups.length} providers`}
            </span>
            {multi && (
              <button
                type="button"
                onClick={close}
                className="my-0.5 flex min-h-[36px] shrink-0 items-center rounded px-2 font-medium text-[var(--primary-text)] transition-[color,background-color,transform] duration-150 [transition-timing-function:var(--ease-out-expo)] hover:bg-[var(--primary)]/10 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35 md:min-h-0 md:py-1"
              >
                Done
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
