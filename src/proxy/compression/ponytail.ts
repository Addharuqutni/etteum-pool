/**
 * Ponytail — Lazy Dev Ruleset Injection + Output Marker Scanner.
 *
 * Two-sided technique:
 *   1. applyPonytail()      — INJECTS a "lazy senior dev" ruleset into the
 *                             system prompt. This ADDS tokens (overhead), so
 *                             `saved` is NEGATIVE. The trade-off: the model
 *                             writes less code, fewer tool calls, shorter
 *                             diffs — savings materialise on the OUTPUT side.
 *   2. scanPonytailMarkers() — scans the provider response for `ponytail:`
 *                              markers the model emitted when deliberately
 *                              cutting a corner with a known ceiling. Records
 *                              them in compressionStats.ponytail.markerHits.
 *
 * Ruleset adapted from DietrichGebert/ponytail (MIT). See ponytail-ruleset.ts.
 *
 * Marker format (in model output):
 *   ponytail: <ceiling-name>, <upgrade-path>
 *   e.g. ponytail: O(n²) scan, replace with indexed lookup when n>1000
 */

import type { ChatCompletionRequest, ChatMessage } from "../providers/base";
import type { PonytailConfig, PonytailMarkerHit, PonytailMode } from "./types";
import {
  PONYTAIL_LITE_RULESET,
  PONYTAIL_FULL_RULESET,
  PONYTAIL_ULTRA_RULESET,
} from "./ponytail-ruleset";

const PONYTAIL_HEADER = "[Ponytail lazy-dev mode active]\n\n";

function rulesetForMode(mode: PonytailMode): string {
  switch (mode) {
    case "lite":
      return PONYTAIL_LITE_RULESET;
    case "full":
      return PONYTAIL_FULL_RULESET;
    case "ultra":
      return PONYTAIL_ULTRA_RULESET;
    default:
      return PONYTAIL_LITE_RULESET;
  }
}

/**
 * Inject the Ponytail ruleset into the request's system prompt.
 *
 * Returns { request, saved } where `saved` is NEGATIVE (chars added) because
 * this technique adds tokens. The pipeline orchestrator converts chars to
 * tokens via charsToTokens().
 *
 * Handles three system-prompt shapes:
 *   - Anthropic string:  system: "You are…"
 *   - Anthropic array:   system: [{ type: "text", text: "You are…" }]
 *   - OpenAI messages:   messages[0].role === "system"
 */
export function applyPonytail(
  request: ChatCompletionRequest,
  cfg: PonytailConfig,
  providerName?: string
): { request: ChatCompletionRequest; saved: number } {
  if (!cfg.enabled) return { request, saved: 0 };

  // Provider override — skip injection for blacklisted providers.
  if (providerName && cfg.providerOverrides[providerName] === false) {
    return { request, saved: 0 };
  }

  const ruleset = PONYTAIL_HEADER + rulesetForMode(cfg.mode);
  const addedChars = ruleset.length;
  let mutated = false;

  const next: any = { ...request };

  // ─── Anthropic-style system field ──────────────────────────────────────
  const sys = (next as any).system;
  if (typeof sys === "string") {
    // Prepend ruleset to existing system prompt.
    next.system = ruleset + "\n\n" + sys;
    mutated = true;
  } else if (Array.isArray(sys) && sys.length > 0) {
    // Prepend as a new text block at the front of the system array.
    next.system = [{ type: "text", text: ruleset }, ...sys];
    mutated = true;
  }
  // Note: when sys == null, we don't create next.system here — the OpenAI
  // system-message path below will insert a system message instead, which
  // works for both OpenAI and Anthropic (Anthropic providers accept messages
  // with role "system" and convert internally).

  // ─── OpenAI-style system messages ──────────────────────────────────────
  if (Array.isArray(next.messages) && next.messages.length > 0) {
    const newMessages = [...next.messages];
    const firstSysIdx = newMessages.findIndex(
      (m: any) => m && m.role === "system"
    );

    if (firstSysIdx >= 0) {
      const sysMsg = newMessages[firstSysIdx]!;
      if (typeof sysMsg.content === "string") {
        newMessages[firstSysIdx] = {
          ...sysMsg,
          content: ruleset + "\n\n" + sysMsg.content,
        };
        mutated = true;
      } else if (Array.isArray(sysMsg.content)) {
        // Prepend a text block.
        newMessages[firstSysIdx] = {
          ...sysMsg,
          content: [{ type: "text", text: ruleset }, ...sysMsg.content],
        };
        mutated = true;
      } else {
        // System message with unknown content shape — replace content.
        newMessages[firstSysIdx] = { ...sysMsg, content: ruleset };
        mutated = true;
      }
    } else if ((next as any).system == null) {
      // No system field, no system message — insert one at the front.
      // Only do this if we didn't already set next.system above.
      newMessages.unshift({ role: "system", content: ruleset });
      mutated = true;
    }

    next.messages = newMessages;
  }

  if (!mutated) return { request, saved: 0 };

  // Negative saved = tokens ADDED (overhead).
  return { request: next, saved: -addedChars };
}

// ─── Output marker scanner ─────────────────────────────────────────────────

const MARKER_RE = /ponytail:\s*([^,\n;]+?)\s*,\s*([^\n;]+)/gi;

/**
 * Walk a provider response looking for `ponytail: <ceiling>, <upgrade>` markers.
 *
 * Scans:
 *   - choices[].message.content (string or content-block array)
 *   - choices[].message.tool_calls[].function.arguments (JSON string)
 *   - content blocks of type "text" anywhere in the response tree
 *
 * @param response  The raw provider response object.
 * @param strip     If true, return a clone with markers removed from text.
 * @returns markers found, and optionally a stripped response clone.
 */
export function scanPonytailMarkers(
  response: any,
  strip = false
): { markers: PonytailMarkerHit[]; strippedResponse: any } {
  const markers: PonytailMarkerHit[] = [];

  if (!response || typeof response !== "object") {
    return { markers, strippedResponse: null };
  }

  // We scan the ORIGINAL response for markers (read-only), then separately
  // build a stripped clone if requested. This avoids accidentally mutating
  // the caller's response object.
  function scanText(text: string, location: string): void {
    if (!text || typeof text !== "string") return;
    let match: RegExpExecArray | null;
    // Reset lastIndex (global regex reused).
    MARKER_RE.lastIndex = 0;
    while ((match = MARKER_RE.exec(text)) !== null) {
      markers.push({
        ceiling: match[1]!.trim(),
        upgradePath: match[2]!.trim(),
        location,
      });
    }
  }

  function walkScan(node: any, path: string): void {
    if (node == null) return;
    if (typeof node === "string") {
      scanText(node, path);
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walkScan(node[i], `${path}[${i}]`);
      }
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (v == null) continue;
        walkScan(v, `${path}.${k}`);
      }
    }
  }

  walkScan(response, "response");

  // Build stripped clone if requested.
  if (!strip) {
    return { markers, strippedResponse: null };
  }

  // Deep clone and remove marker text from known text-bearing locations.
  const stripped = structuredClone(response);

  function stripText(text: string): string {
    if (!text || typeof text !== "string") return text;
    return text.replace(/ponytail:\s*[^,\n;]+?\s*,\s*[^\n;]+/gi, "").trim();
  }

  function stripNode(node: any): void {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (typeof node[i] === "string") {
          node[i] = stripText(node[i]);
        } else {
          stripNode(node[i]);
        }
      }
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (v == null) continue;
        if (typeof v === "string") {
          (node as any)[k] = stripText(v);
        } else {
          stripNode(v);
        }
      }
    }
  }

  stripNode(stripped);

  return { markers, strippedResponse: stripped };
}
