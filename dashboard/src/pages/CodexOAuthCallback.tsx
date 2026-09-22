import { useEffect, useMemo, useState } from "react";
import { completeCodexOAuth } from "@/lib/api";
import { Card } from "@/components/ui/card";

export default function CodexOAuthCallback() {
  const [message, setMessage] = useState("Completing Codex login...");
  const [done, setDone] = useState(false);

  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  useEffect(() => {
    let active = true;

    async function run() {
      const code = params.get("code") || "";
      const state = params.get("state") || "";
      const error = params.get("error") || "";
      const errorDescription = params.get("error_description") || error;

      if (error) {
        setMessage(errorDescription || "OAuth login failed");
        window.opener?.postMessage({ type: "codex_oauth_result", success: false, error: errorDescription || error, state }, window.location.origin);
        setDone(true);
        return;
      }

      if (!code || !state) {
        setMessage("Missing authorization code or state");
        window.opener?.postMessage({ type: "codex_oauth_result", success: false, error: "Missing authorization code or state", state }, window.location.origin);
        setDone(true);
        return;
      }

      try {
        const result = await completeCodexOAuth({ code, state });
        if (!active) return;
        setMessage(`Connected as ${result.connection?.displayName || result.connection?.email || "Codex"}`);
        window.opener?.postMessage({ type: "codex_oauth_result", success: true, state }, window.location.origin);
      } catch (error) {
        if (!active) return;
        const text = error instanceof Error ? error.message : String(error);
        setMessage(text);
        window.opener?.postMessage({ type: "codex_oauth_result", success: false, error: text, state }, window.location.origin);
      } finally {
        if (active) setDone(true);
        setTimeout(() => window.close(), 1200);
      }
    }

    run();
    return () => {
      active = false;
    };
  }, [params]);

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-[340px] overflow-hidden shadow-[var(--shadow-raised)]">
        <div className="border-b border-[var(--border)] px-4 py-3">
          {/* A real page heading, matching Login. `.eyebrow` here rendered the
              title at 10px — the same size as the caption beneath it. */}
          <h1 className="font-mono text-title font-semibold uppercase leading-none tracking-caps text-[var(--foreground)]">
            Codex Login
          </h1>
        </div>
        <div className="space-y-2 px-4 py-4">
          <p className="font-mono text-body leading-relaxed text-[var(--foreground)]">{message}</p>
          {done && (
            <p className="font-mono text-meta text-[var(--muted-foreground)]">You can close this window.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
