import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge must be told about our custom type scale.
 *
 * By default `twMerge` treats any unknown `text-*` class as a text COLOR, so
 * when `cn("text-body", "text-[var(--foreground)]")` runs it sees two color
 * classes, keeps the last, and silently DROPS the font size. The element then
 * inherits 16px — a failure that is invisible in the source and only shows up
 * when you measure the rendered DOM.
 *
 * Registering the scale under the `font-size` group makes `text-body` and
 * `text-[var(--foreground)]` land in different groups, so both survive.
 *
 * ⚠ Every new `--text-*` token must be added to BOTH this list and the
 * `@theme inline` block in index.css. Miss this list and the class is silently
 * deleted at runtime — which is exactly how `text-control` shipped broken on
 * first attempt, leaving the login input at the 16px UA default.
 */
const FONT_SIZE_TOKENS = [
  "micro",
  "meta",
  "body",
  "lead",
  "title",
  "display",
  "stat-sm",
  "stat",
  "hero",
  "control",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...FONT_SIZE_TOKENS] }],
    },
  },
});

export { FONT_SIZE_TOKENS };

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
  return num.toString();
}

export function formatDateTimeID(value: string | Date): string {
  return parseUtcDate(value).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

export function formatTimeID(value: string | Date): string {
  return parseUtcDate(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function parseUtcDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
}

export function formatPercentage(value: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((value / total) * 100);
}

export function modelColor(model: string, index = 0): string {
  let hash = 0;
  for (let i = 0; i < model.length; i++) {
    hash = (hash * 31 + model.charCodeAt(i)) >>> 0;
  }

  // Golden-angle distribution keeps colors well separated even with many models.
  const hue = Math.round((hash + index * 137.508) % 360);
  return `hsl(${hue}, 88%, 58%)`;
}
