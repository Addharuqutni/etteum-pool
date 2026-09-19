import { memo, useCallback, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Sanitized Markdown renderer for the Model Studio playground.
 *
 * Security model: every non-code byte is HTML-escaped BEFORE any markup is
 * synthesized, and the only tags that ever reach the DOM are the ones this
 * module emits. Link hrefs are scheme-checked (http/https/mailto/tel) and
 * anything else is rendered as inert text. There is no `dangerouslySetInnerHTML`
 * anywhere in this file, so model output cannot inject HTML, scripts, or
 * event handlers.
 *
 * Supported subset: fenced + inline code, headings, bold/italic/strike, links,
 * bare-URL autolinks, blockquotes, nested unordered/ordered lists, GFM tables,
 * horizontal rules, paragraphs with hard line breaks. Images are deliberately
 * not rendered (model output is untrusted and remote image tags are a tracking
 * + SSRF surface); their alt text shows instead.
 *   ponytail: hand-rolled GFM subset, pull in react-markdown if edge cases grow
 */

// ---- escaping ---------------------------------------------------------------
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SAFE_HREF = /^(https?:\/\/|mailto:|tel:)/i;

function safeHref(href: string): string | null {
  const target = href.trim();
  if (!SAFE_HREF.test(target)) return null;
  // Neutralize any attempt to break out of the attribute.
  return target.replace(/["'<>\\]/g, "");
}

// ---- inline ----------------------------------------------------------------
type Inline =
  | { t: "text"; v: string }
  | { t: "br" }
  | { t: "bold"; children: Inline[] }
  | { t: "italic"; children: Inline[] }
  | { t: "strike"; children: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; children: Inline[]; href: string };

const BARE_URL = /^https?:\/\/[^\s<>()]+/i;

function parseInline(input: string): Inline[] {
  const tokens: Inline[] = [];
  let text = "";
  let i = 0;
  const flush = () => {
    if (text.length > 0) {
      tokens.push({ t: "text", v: text });
      text = "";
    }
  };

  while (i < input.length) {
    const ch = input[i]!;

    if (ch === "\n") {
      flush();
      tokens.push({ t: "br" });
      i++;
      continue;
    }

    // Inline code: highest priority, contents are literal (already escaped).
    if (ch === "`") {
      const end = input.indexOf("`", i + 1);
      if (end > i) {
        flush();
        tokens.push({ t: "code", v: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Bare URL autolink (before the "[" branch so a link's own URL inside the
    // label can't double-wrap).
    const rest = input.slice(i);
    const urlMatch = rest.match(BARE_URL);
    if (urlMatch && (i === 0 || /\s/.test(input[i - 1]!))) {
      // Trim trailing punctuation that is almost never part of the URL.
      let url = urlMatch[0];
      while (url.length > 0 && /[.,;:!?)\]]$/.test(url)) url = url.slice(0, -1);
      flush();
      tokens.push({ t: "link", children: [{ t: "text", v: url }], href: url });
      i += url.length;
      continue;
    }

    // Reference-style link: [label](href)
    if (ch === "[") {
      const close = input.indexOf("]", i + 1);
      if (close > i && input[close + 1] === "(") {
        const end = input.indexOf(")", close + 2);
        if (end > close + 1) {
          const label = input.slice(i + 1, close);
          const href = input.slice(close + 2, end);
          flush();
          // Image syntax ![alt](url) renders as alt text, never as an <img>.
          const labelTokens = parseInline(label);
          tokens.push({ t: "link", children: labelTokens, href });
          i = end + 1;
          continue;
        }
      }
    }

    // Two-char emphasis: **bold**, __bold__, ~~strike~~
    const two = input.slice(i, i + 2);
    if (two === "**" || two === "__" || two === "~~") {
      const end = input.indexOf(two, i + 2);
      if (end > i + 1) {
        flush();
        const inner = input.slice(i + 2, end);
        tokens.push({ t: two === "~~" ? "strike" : "bold", children: parseInline(inner) });
        i = end + 2;
        continue;
      }
    }

    // One-char emphasis: *italic*, _italic_
    if (ch === "*" || ch === "_") {
      const end = input.indexOf(ch, i + 1);
      if (end > i) {
        flush();
        tokens.push({ t: "italic", children: parseInline(input.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    text += ch;
    i++;
  }

  flush();
  return tokens;
}

function renderInline(tokens: Inline[]): ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.t) {
      case "text":
        return token.v;
      case "br":
        return <br key={index} />;
      case "bold":
        return <strong key={index}>{renderInline(token.children)}</strong>;
      case "italic":
        return <em key={index}>{renderInline(token.children)}</em>;
      case "strike":
        return <s key={index}>{renderInline(token.children)}</s>;
      case "code":
        return (
          <code
            key={index}
            className="rounded-[5px] bg-[var(--muted)] px-1.5 py-0.5 font-mono text-body text-[var(--primary-text)]"
          >
            {token.v}
          </code>
        );
      case "link": {
        const href = safeHref(token.href);
        const children = renderInline(token.children);
        if (href === null) {
          // Unusable scheme: show the label (and the raw target) as text.
          return (
            <span key={index}>
              {children}{" "}
              <span className="text-[var(--muted-foreground)]">({token.href})</span>
            </span>
          );
        }
        return (
          <a
            key={index}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="font-medium text-[var(--primary-text)] underline underline-offset-2 hover:opacity-80"
          >
            {children}
          </a>
        );
      }
      default:
        return null;
    }
  });
}

// ---- blocks ----------------------------------------------------------------
type Block =
  | { kind: "code"; lang: string; code: string }
  | { kind: "heading"; level: number; inline: string }
  | { kind: "blockquote"; inline: string }
  | { kind: "ul"; items: ListItem[] }
  | { kind: "ol"; items: ListItem[] }
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][] }
  | { kind: "hr" }
  | { kind: "para"; inline: string };

interface ListItem {
  inline: string;
  children: ListItem[];
}

type Align = "left" | "center" | "right";

interface RawItem {
  depth: number;
  inline: string;
}

const FENCE_OPEN = /^```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^>\s?(.*)$/;
const UL_ITEM = /^(\s*)(?:[-*+]|\u2022)\s+(.*)$/;
const OL_ITEM = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_DELIM = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Turns a flat indented-item list into a tree (2 spaces == one nesting level). */
function buildTree(items: RawItem[]): ListItem[] {
  const root: ListItem[] = [];
  const stack: { depth: number; node: ListItem }[] = [];
  for (const item of items) {
    const node: ListItem = { inline: item.inline, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= item.depth) stack.pop();
    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1]!.node.children.push(node);
    }
    stack.push({ depth: item.depth, node });
  }
  return root;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block: contents stay raw until the closing fence.
    const fence = line.match(FENCE_OPEN);
    if (fence) {
      const lang = fence[1]?.trim() ?? "";
      const codeLines: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (FENCE_OPEN.test(lines[i]!)) {
          closed = true;
          break;
        }
        codeLines.push(lines[i]!);
        i++;
      }
      if (closed) i++;
      blocks.push({ kind: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, inline: escapeHtml(heading[2]!.trim()) });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        parts.push(lines[i]!.replace(QUOTE, "$1"));
        i++;
      }
      blocks.push({ kind: "blockquote", inline: escapeHtml(parts.join("\n")) });
      continue;
    }

    const ulMatch = line.match(UL_ITEM);
    if (ulMatch) {
      const items: RawItem[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(UL_ITEM);
        if (!m) break;
        items.push({ depth: Math.floor(m[1]!.length / 2), inline: escapeHtml(m[2]!.trim()) });
        i++;
      }
      blocks.push({ kind: "ul", items: buildTree(items) });
      continue;
    }

    const olMatch = line.match(OL_ITEM);
    if (olMatch) {
      const items: RawItem[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(OL_ITEM);
        if (!m) break;
        items.push({ depth: Math.floor(m[1]!.length / 2), inline: escapeHtml(m[2]!.trim()) });
        i++;
      }
      blocks.push({ kind: "ol", items: buildTree(items) });
      continue;
    }

    // GFM table: a header row followed by a delimiter row.
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]!)) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]!).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center" as const;
        if (right) return "right" as const;
        return "left" as const;
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitTableRow(lines[i]!).map(escapeHtml));
        i++;
      }
      blocks.push({ kind: "table", header: header.map(escapeHtml), align: aligns, rows });
      continue;
    }

    // Paragraph: consume until a blank line or a block-starting line.
    const parts: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (
        next.trim() === "" ||
        FENCE_OPEN.test(next) ||
        HEADING.test(next) ||
        HR.test(next) ||
        QUOTE.test(next) ||
        UL_ITEM.test(next) ||
        OL_ITEM.test(next)
      ) {
        break;
      }
      parts.push(next);
      i++;
    }
    blocks.push({ kind: "para", inline: escapeHtml(parts.join("\n")) });
  }

  return blocks;
}

function renderListItems(items: ListItem[], ordered: boolean): ReactNode[] {
  return items.map((item, index) => (
    <li key={index} className="leading-relaxed">
      {renderInline(parseInline(item.inline))}
      {item.children.length > 0 && (
        <ul className="mt-1 ml-5 list-disc space-y-1">{renderListItems(item.children, ordered)}</ul>
      )}
    </li>
  ));
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard API can be unavailable (insecure context); the text stays
      // selectable so the user can copy manually.
    }
  }, [code]);

  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--muted)]/40">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-1.5">
        <span className="font-mono text-meta uppercase tracking-wide text-[var(--muted-foreground)]">
          {lang || "code"}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-meta text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3 w-3 text-[var(--primary-text)]" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-[480px] overflow-auto p-3 text-meta leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  const blocks = parseBlocks(children);

  return (
    <div className="space-y-2 text-lead leading-relaxed">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "code":
            return <CodeBlock key={index} code={block.code} lang={block.lang} />;
          case "heading": {
            const sizes = ["text-xl", "text-lg", "text-base", "text-title", "text-sm", "text-sm"];
            return (
              <div key={index} className={`mt-3 font-semibold ${sizes[block.level - 1]}`}>
                {renderInline(parseInline(block.inline))}
              </div>
            );
          }
          case "blockquote":
            return (
              <blockquote
                key={index}
                className="border-l-2 border-[var(--primary)]/50 pl-3 italic text-[var(--muted-foreground)]"
              >
                {renderInline(parseInline(block.inline))}
              </blockquote>
            );
          case "ul":
            return (
              <ul key={index} className="ml-5 list-disc space-y-1">
                {renderListItems(block.items, false)}
              </ul>
            );
          case "ol":
            return (
              <ol key={index} className="ml-5 list-decimal space-y-1">
                {renderListItems(block.items, true)}
              </ol>
            );
          case "hr":
            return <hr key={index} className="my-3 border-t border-[var(--border)]" />;
          case "para":
            return <div key={index}>{renderInline(parseInline(block.inline))}</div>;
          case "table":
            return (
              <div key={index} className="my-3 overflow-x-auto">
                <table className="w-full border-collapse text-meta">
                  <thead>
                    <tr className="border-b border-[var(--border)]">
                      {block.header.map((cell, ci) => (
                        <th
                          key={ci}
                          style={{ textAlign: block.align[ci] ?? "left" }}
                          className="px-2.5 py-1.5 font-semibold"
                        >
                          {renderInline(parseInline(cell))}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri} className="border-b border-[var(--border)]/60">
                        {row.map((cell, ci) => (
                          <td
                            key={ci}
                            style={{ textAlign: block.align[ci] ?? "left" }}
                            className="px-2.5 py-1.5 align-top"
                          >
                            {renderInline(parseInline(cell))}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
});
