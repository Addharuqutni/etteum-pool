/**
 * Unit tests for SSE error detection (pure functions, no DB/wiring).
 *
 * Run with:  bun test src/proxy/errors.test.ts
 */

import { describe, it, expect } from "bun:test";
import { getSseError } from "./errors";

describe("getSseError", () => {
  it("detects upstream_error SSE payloads and extracts the message", () => {
    expect(getSseError('{"type":"upstream_error","error":"upstream 502"}')).toBe("upstream 502");
    expect(getSseError('{"type":"upstream_error"}')).toBe("upstream_error");
  });

  it("detects statusCodeValue >= 400 SSE payloads", () => {
    expect(getSseError('{"code":"112","statusCodeValue":403,"message":"forbidden"}')).toBe("forbidden");
    expect(getSseError('{"code":"112","statusCodeValue":500}')).toBe("upstream HTTP 500");
  });

  it("detects OpenAI-style error objects and strings", () => {
    expect(getSseError('{"error":{"message":"bad key","type":"invalid_request_error"}}')).toBe("bad key");
    expect(getSseError('{"error":{"type":"server_error"}}')).toBe("upstream error");
    expect(getSseError('{"error":"plain string error"}')).toBe("plain string error");
  });

  it("ignores statusCodeValue below 400", () => {
    expect(getSseError('{"statusCodeValue":200,"message":"ok"}')).toBeNull();
  });

  it("returns null for normal content chunks", () => {
    expect(getSseError('{"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}')).toBeNull();
    expect(getSseError('{"id":"x","choices":[{"delta":{"role":"assistant"}}]}')).toBeNull();
    expect(getSseError('{"error":null,"id":"x"}')).toBeNull();
  });

  it("returns null for [DONE], empty, and non-JSON payloads", () => {
    expect(getSseError("[DONE]")).toBeNull();
    expect(getSseError("")).toBeNull();
    expect(getSseError("not json")).toBeNull();
  });
});
