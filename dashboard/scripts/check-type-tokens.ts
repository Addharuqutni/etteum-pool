/**
 * Guard: every `--text-*` size token must be registered in BOTH
 *   - the `@theme inline` block in src/index.css  (so Tailwind emits the utility)
 *   - FONT_SIZE_TOKENS in src/lib/utils.ts        (so tailwind-merge keeps it)
 *
 * Why this exists: both omissions fail SILENTLY.
 *   - Missing from @theme      -> the utility never exists; the class does nothing.
 *   - Missing from twMerge     -> cn() treats `text-x` as a text colour and
 *                                 deletes it whenever a colour class follows.
 * In both cases the element falls back to the browser default (16px) and the
 * source still reads correctly. `text-control` shipped broken exactly that way.
 *
 * Run: bun run check:tokens
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/index.css"), "utf8");
const utils = readFileSync(join(root, "src/lib/utils.ts"), "utf8");

/** Sizes declared in the :root block (the source of truth). */
const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("\n}"));
const declared = [
  ...rootBlock.matchAll(/^\s*--text-([a-z-]+):\s*[^;]+;/gm),
].map((m) => m[1]);

/** Sizes bridged into Tailwind's theme. */
const themeBlock = css.slice(css.indexOf("@theme inline {"));
const bridged = [
  ...themeBlock.matchAll(/^\s*--text-([a-z-]+):\s*[^;]+;/gm),
].map((m) => m[1]);

/** Sizes known to tailwind-merge. */
const mergeList = utils.slice(
  utils.indexOf("FONT_SIZE_TOKENS"),
  utils.indexOf("] as const")
);
const inMerge = [...mergeList.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);

// `--text-x--line-height` companions are not size keys themselves.
const sizes = declared.filter(
  (n) => !n.includes("line-height") && !n.startsWith("x-")
);

const missingTheme = sizes.filter((t) => !bridged.includes(t));
const missingMerge = sizes.filter((t) => !inMerge.includes(t));
const orphanMerge = inMerge.filter((t) => !sizes.includes(t));

let failed = false;

if (missingTheme.length) {
  failed = true;
  console.error(
    `\n✗ Not bridged in @theme inline (utility will not exist):\n    ${missingTheme.join(", ")}`
  );
}
if (missingMerge.length) {
  failed = true;
  console.error(
    `\n✗ Missing from FONT_SIZE_TOKENS in src/lib/utils.ts (twMerge will delete the class):\n    ${missingMerge.join(", ")}`
  );
}
if (orphanMerge.length) {
  failed = true;
  console.error(
    `\n✗ In FONT_SIZE_TOKENS but not declared in :root (stale entry):\n    ${orphanMerge.join(", ")}`
  );
}

if (failed) {
  console.error(
    "\nEvery --text-* token must be declared in :root, bridged in @theme inline, and listed in FONT_SIZE_TOKENS.\n"
  );
  process.exit(1);
}

console.log(`✓ type-scale tokens in sync: ${sizes.join(", ")}`);
