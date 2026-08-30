import { describe, expect, test, mock } from "bun:test";
import { refreshCodebuddyToken } from "../../src/proxy/providers/codebuddy";
import { refreshCodebuddyChinaToken } from "../../src/proxy/providers/codebuddy-china";

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("refreshCodebuddyToken", () => {
  const originalFetch = globalThis.fetch;

  test("posts empty body with X-Refresh-Token header and parses envelope", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock(async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse(200, {
        code: 0,
        msg: "",
        data: {
          accessToken: "new-access-jwt",
          refreshToken: "new-refresh-jwt",
          expiresIn: 86400,
        },
      });
    }) as unknown as typeof fetch;

    try {
      const result = await refreshCodebuddyToken("old-refresh-jwt");

      expect(capturedUrl).toBe("https://www.codebuddy.ai/v2/plugin/auth/token/refresh");
      expect(capturedInit?.method).toBe("POST");
      expect(String(capturedInit?.body)).toBe("{}");
      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers["X-Refresh-Token"]).toBe("old-refresh-jwt");
      expect(headers["X-Domain"]).toBe("www.codebuddy.ai");
      expect(headers["X-Auth-Refresh-Source"]).toBe("plugin");
      expect(headers["X-Product"]).toBe("SaaS");

      expect(result.access_token).toBe("new-access-jwt");
      expect(result.refresh_token).toBe("new-refresh-jwt");
      // expires_at = now + 86400 → numeric, future timestamp
      expect(Number(result.expires_at)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps old refresh token when response omits a new one", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse(200, { code: 0, data: { accessToken: "jwt", expiresIn: 3600 } })
    ) as unknown as typeof fetch;

    try {
      const result = await refreshCodebuddyToken("old-refresh-jwt");
      expect(result.refresh_token).toBe("old-refresh-jwt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws on 401 (refresh token itself dead)", async () => {
    globalThis.fetch = mock(async () => jsonResponse(401, { code: 401 })) as unknown as typeof fetch;
    try {
      expect(refreshCodebuddyToken("dead-refresh-jwt")).rejects.toThrow(/re-login/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("refreshCodebuddyChinaToken", () => {
  const originalFetch = globalThis.fetch;

  test("hits www.codebuddy.cn with X-Refresh-Token and parses envelope", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock(async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse(200, {
        code: 0,
        data: {
          accessToken: "cn-new-access-jwt",
          refreshToken: "cn-new-refresh-jwt",
          expiresIn: 86400,
        },
      });
    }) as unknown as typeof fetch;

    try {
      const result = await refreshCodebuddyChinaToken("cn-old-refresh-jwt");

      expect(capturedUrl).toBe("https://www.codebuddy.cn/v2/plugin/auth/token/refresh");
      expect(String(capturedInit?.body)).toBe("{}");
      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers["X-Refresh-Token"]).toBe("cn-old-refresh-jwt");
      expect(headers["X-Domain"]).toBe("www.codebuddy.cn");
      expect(headers["X-Auth-Refresh-Source"]).toBe("plugin");

      expect(result.access_token).toBe("cn-new-access-jwt");
      expect(result.refresh_token).toBe("cn-new-refresh-jwt");
      expect(Number(result.expires_at)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps old refresh token when response omits a new one", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse(200, { code: 0, data: { accessToken: "cn-jwt", expiresIn: 3600 } })
    ) as unknown as typeof fetch;

    try {
      const result = await refreshCodebuddyChinaToken("cn-old-refresh-jwt");
      expect(result.refresh_token).toBe("cn-old-refresh-jwt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});