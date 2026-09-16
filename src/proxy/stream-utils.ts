/**
 * Shared SSE stream helpers.
 *
 * Providers that parse upstream SSE by hand need the same details to agree, so
 * they live here instead of being re-derived per provider:
 *   - `[DONE]` is a TERMINAL sentinel, not "keep reading" (upstreams routinely
 *     finish the payload and then hold the socket open);
 *   - the trailing `[DONE]` is emitted at most once, including on the EOF path
 *     where the upstream never sent one;
 *   - an error event inside an HTTP-200 stream is surfaced, never flattened
 *     into an empty delta that looks like a successful empty answer;
 *   - a final event the upstream never terminated with a newline is still
 *     processed, and a plain JSON body (no SSE framing) is not dropped;
 *   - the upstream reader is released once the payload ended, or the response
 *     body keeps being read after the client is done — leaking the reader and
 *     the connection.
 */

import { getSseErrorFromParsed } from "./errors";
import type { StreamChunk } from "./providers/base";

/** The OpenAI terminal sentinel. */
export const SSE_DONE_SENTINEL = "[DONE]";

/**
 * What the provider decided to do with one parsed upstream event.
 *
 * A provider that rewrites events (dropping a moderation notice, correcting a
 * finish reason, mapping its own envelope) returns the chunk to forward; one
 * that already emitted its own frames omits `chunk`.
 */
export interface SseEventOutcome {
  /** Frames to forward downstream, in order; omit when the provider emitted its own. */
  chunks?: StreamChunk[];
  /** Content carried by this event; marks the answer as delivered. */
  content?: string;
  /** True when this event carried tool calls; marks the answer as delivered. */
  toolCalls?: boolean;
  /** End the turn after this event. */
  terminal?: boolean;
}

export interface SseStreamLoopOptions {
  /** Upstream response whose body carries the SSE payload. */
  response: Response;
  /** Response id stamped on the loop's own frames (error chunks). */
  id: string;
  /** Model id stamped on the loop's own frames (error chunks). */
  model: string;
  /** Prefix for this loop's error logs, e.g. `"[CodeBuddy]"`. */
  logPrefix: string;
  /**
   * Translate one parsed upstream event into what to forward. Not called for a
   * terminal sentinel or an upstream error event — the loop owns those.
   */
  onEvent: (parsed: any) => SseEventOutcome;
  /**
   * Recover the answer from a 200 body that carried no `data:` framing at all.
   * Without this the body would be dropped and the client would see an empty
   * answer.
   */
  onPlainJson: (parsed: any) => SseEventOutcome;
  /**
   * Abort the upstream reader after this many ms with no bytes received. Omit
   * to disable; a stalled upstream is then ended by the caller instead.
   */
  readTimeoutMs?: number;
  /**
   * Reject the downstream stream when a read error arrives before any content
   * was delivered, so the proxy's combo fallback can try the next target.
   * Defaults to false, which forwards the error as a chunk instead.
   */
  rejectOnErrorBeforeContent?: boolean;
}

/**
 * Read an upstream SSE body and forward it downstream, applying the terminal
 * semantics listed at the top of this file.
 *
 * Returns the `ReadableStream` for the caller to hand to its result; cancelling
 * it aborts the upstream reader.
 */
export function runSseStreamLoop(options: SseStreamLoopOptions): ReadableStream<Uint8Array> {
  const { response, id, model, logPrefix, onEvent, onPlainJson } = options;
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
      if (!reader) {
        controller.close();
        return;
      }

      let deliveredContent = false;

      /** Enqueue a frame, tolerating a consumer that already closed the stream. */
      const enqueue = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The consumer already cancelled/closed — nothing left to write.
        }
      };

      /** Fail the downstream stream without throwing at the caller. */
      const reject = (message: string) => {
        try {
          controller.error(new Error(message));
        } catch {
          // already closed
        }
      };

      let sentDone = false;
      /** Emit the terminating `[DONE]` marker at most once. */
      const emitDone = () => {
        if (sentDone) return;
        sentDone = true;
        enqueue(`data: ${SSE_DONE_SENTINEL}\n\n`);
      };

      /** Frame carrying a mid-stream failure as visible content for the client. */
      const errorChunk = (message: string): StreamChunk => ({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: `\n\n[Stream error: ${message}]` }, finish_reason: null }],
      });

      const decoder = new TextDecoder();
      let buffer = "";
      let sawSseData = false;
      let upstreamError: string | null = null;
      // Set once the logical end of the stream is reached ([DONE], an upstream
      // error event, or a provider terminal). Upstreams routinely finish the
      // payload and then leave the socket open; without this the read loop never
      // exits and the request hangs until the caller gives up.
      let finished = false;
      let timedOut = false;

      const applyOutcome = (outcome: SseEventOutcome) => {
        if (outcome.content || outcome.toolCalls) deliveredContent = true;
        for (const chunk of outcome.chunks ?? []) enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      /**
       * Handle one decoded SSE line. Returns true when the stream reached a
       * terminal state and the read loop should stop.
       */
      const handleLine = (line: string): boolean => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) return false;
        sawSseData = true;
        const data = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);

        if (data === SSE_DONE_SENTINEL) {
          // Terminal: stop reading. The upstream may hold the socket open after
          // the payload ends.
          emitDone();
          finished = true;
          return true;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch (parseError) {
          // Skip malformed chunks but keep streaming.
          console.error(`${logPrefix} Failed to parse chunk:`, parseError);
          return false;
        }

        // Upstream error event inside an HTTP-200 stream (rate limit, quota,
        // upstream_error, OpenAI-style {error}). Surface it instead of
        // forwarding an empty delta that silently looks like a successful-but-
        // empty answer.
        const sseError = getSseErrorFromParsed(parsed);
        if (sseError) {
          upstreamError = sseError;
          finished = true;
          return true;
        }

        const outcome = onEvent(parsed);
        applyOutcome(outcome);
        if (outcome.terminal) {
          finished = true;
          return true;
        }
        return false;
      };

      function abortOnStall() {
        timedOut = true;
        void releaseReader(reader);
      }

      // ONE idle watchdog for the stream, re-armed after every successful read —
      // NOT a per-read Promise.race. A per-iteration `Promise.race([read(),
      // timeout])` + clearTimeout leaves a never-settling pending Promise every
      // loop pass; when the stream is wrapped (peekStreamForError + usage
      // finalizer) and the upstream errors or the client disconnects, that
      // pattern deadlocks/hangs Bun on Windows and can kill the process. A
      // single re-armed timer aborts the read cleanly and still means "idle for
      // readTimeoutMs" (a healthy stream that keeps producing tokens past the
      // timeout is never cut off, only a genuinely stalled one is).
      const readTimeoutMs = options.readTimeoutMs;
      let watchdog = readTimeoutMs === undefined ? undefined : setTimeout(abortOnStall, readTimeoutMs);
      const rearm = () => {
        if (readTimeoutMs === undefined) return;
        clearTimeout(watchdog);
        watchdog = setTimeout(abortOnStall, readTimeoutMs);
      };

      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          rearm();

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (handleLine(line)) break;
          }
        }

        // `split("\n")` leaves the trailing partial line in `buffer`, so a final
        // event the upstream never terminated with a newline (common at EOF)
        // would be dropped. Process it once the stream has ended.
        if (buffer.trim()) handleLine(buffer);

        // Terminal state reached while the upstream may still hold the socket
        // open — release the reader so the connection is not left dangling.
        if (finished) await releaseReader(reader);

        // A 200 whose body is plain JSON (no `data:` framing) never enters the
        // loop body, so it would be dropped silently; recover it as content.
        if (!sawSseData && !deliveredContent && buffer.trim()) {
          try {
            applyOutcome(onPlainJson(JSON.parse(buffer.trim())));
          } catch {
            // Not JSON either — nothing usable to forward.
          }
        }

        if (upstreamError) {
          console.error(`${logPrefix} Upstream stream error:`, upstreamError);
          if (!deliveredContent) {
            // Nothing reached the client yet — fail the stream so the proxy's
            // combo fallback can try the next target instead of returning a
            // silently-empty 200 response.
            reject(upstreamError);
            return;
          }
          enqueue(`data: ${JSON.stringify(errorChunk(upstreamError))}\n\n`);
        }
        emitDone();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (timedOut) {
          // The watchdog already stopped a stalled upstream; do not append a
          // bogus content delta to a host that stopped responding.
          reject(message);
          return;
        }
        console.error(`${logPrefix} Stream error:`, message);
        if (options.rejectOnErrorBeforeContent && !deliveredContent) {
          reject(message);
          return;
        }
        enqueue(`data: ${JSON.stringify(errorChunk(message))}\n\n`);
        emitDone();
      } finally {
        clearTimeout(watchdog);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    // Abort the upstream reader when the consumer (client, or the peek/usage
    // finalizer wrapper) cancels this stream. Without this the upstream body
    // keeps being read in the background while the producer loop dangles after
    // a disconnect/error — leaking the reader and hanging the event loop.
    async cancel(reason) {
      if (reader) {
        try {
          await reader.cancel(reason);
        } catch {
          // already closed
        }
      }
    },
  });
}

/**
 * Release an upstream reader after the stream reached a terminal state.
 *
 * Never throws: by this point the reader is routinely already closed, cancelled
 * or errored, and a failure here must not mask the result the caller is
 * returning.
 */
export async function releaseReader(
  reader: { cancel(reason?: unknown): Promise<void> } | undefined
): Promise<void> {
  if (!reader) return;
  try {
    await reader.cancel();
  } catch {
    // Already closed, cancelled, or errored.
  }
}
