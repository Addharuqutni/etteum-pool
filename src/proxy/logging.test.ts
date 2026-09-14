/**
 * Unit tests for stream log summary (pure helper).
 *
 * Run with:  bun test src/proxy/logging.test.ts
 */

import { describe, it, expect } from "bun:test";
import { buildStreamLogSummary, prepareLogBody } from "./logging";

describe("buildStreamLogSummary", () => {
  it("carries content preview + usage for stream finalize", () => {
    const summary = buildStreamLogSummary({
      model: "test-model",
      content: "hello world",
      contentBytes: 11,
      promptTokens: 10,
      completionTokens: 3,
      totalTokens: 13,
      creditSource: "estimated",
    });
    expect(summary.stream).toBe(true);
    expect(summary.contentPreview).toBe("hello world");
    expect(summary.usage.totalTokens).toBe(13);
    // prepareLogBody keeps small summaries intact (no truncate wrapper)
    const logged = prepareLogBody(summary) as Record<string, unknown>;
    expect((logged as { contentPreview?: string }).contentPreview).toBe("hello world");
  });

  it("empty stream still yields a loggable error body", () => {
    const logged = prepareLogBody({ error: "Upstream stream delivered no data" }) as Record<string, unknown>;
    expect(logged.error).toBe("Upstream stream delivered no data");
  });
});
