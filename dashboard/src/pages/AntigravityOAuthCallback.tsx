import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";
import { completeAntigravityOAuth } from "@/lib/api";

export default function AntigravityOAuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [message, setMessage] = useState("Completing Google Cloud Code Assist authentication...");
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get("code") || "";
    const state = searchParams.get("state") || "";
    const error = searchParams.get("error") || "";
    const errorDescription = searchParams.get("error_description") || "";

    // Popup mode: opened by Accounts.tsx via window.open. Hand the result back
    // to the opener (it exchanges the token) and close ourselves — window.close()
    // is allowed here because this script lives inside the popup.
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(
        { type: "oauth_callback", data: { code, state, error, errorDescription } },
        window.location.origin
      );
      window.close();
      return;
    }

    if (error) {
      setError(`OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ""}`);
      setStatus("error");
      return;
    }

    if (!code || !state) {
      setError("Missing authorization code or state parameter");
      setStatus("error");
      return;
    }


    // Full-tab mode (manual flow): no opener, so exchange here and navigate.
    async function completeLogin() {
      try {
        setMessage("Exchanging code for tokens and provisioning Google project...");
        const result = await completeAntigravityOAuth({ code, state });

        if (result.success) {
          setStatus("success");
          setMessage(
            `✅ Successfully authenticated as ${result.connection?.email || "Antigravity user"}` +
            `\nProject ID: ${result.connection?.projectId || "N/A"}` +
            `\n\nRedirecting to accounts page...`
          );

          setTimeout(() => {
            navigate("/accounts");
          }, 3000);
        } else {
          throw new Error(result.error || "Authentication failed");
        }
      } catch (err) {
        console.error("[Antigravity OAuth Callback] Error:", err);
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    }

    completeLogin();
  }, [searchParams, navigate]);


  return (
    /* Centred like Login and the Codex callback. Padding steps down on small
       screens so the card is not squeezed to the edge of a phone. */
    <div className="flex min-h-dvh items-center justify-center bg-[var(--background)] p-4 text-[var(--foreground)] sm:p-8">
      <Card className="w-full max-w-[340px] overflow-hidden shadow-[var(--shadow-raised)] sm:max-w-md">
        {/* Same card-header pattern as the Codex callback: a hairline, a
            15px mono caps title. PageHeader is a page-level component and
            does not belong inside a card. */}
        <div className="border-b border-[var(--border)] px-4 py-3">
          <h1 className="font-mono text-title font-semibold uppercase leading-none tracking-caps text-[var(--foreground)]">
            Google Cloud Code Assist Login
          </h1>
        </div>

        <div className="space-y-6 px-4 py-4">
        {status === "loading" && (
          <div className="space-y-4 text-center">
            {/* `text-primary` was a dead class — there is no --color-primary in
                the theme, so the utility never existed and the spinner
                rendered in the inherited colour. Use the token. */}
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-[var(--primary)]" aria-hidden />
            <p className="text-[var(--muted-foreground)]">{message}</p>
            <p className="text-body text-[var(--muted-foreground)]">
              This may take a few seconds while we provision your project.
            </p>
          </div>
        )}

        {status === "success" && (
          <div className="text-center space-y-4">
            {/* Icon carries the success signal; the heading is plain text.
                No "✓" glyph — the CheckCircle2 icon already says it, and
                emoji-as-icon renders inconsistently across platforms. */}
            <CheckCircle2 className="mx-auto h-12 w-12 text-[var(--success-text)]" aria-hidden />
            <div className="space-y-2">
              <p className="font-medium text-title">Authentication Successful</p>
              <p className="text-[var(--muted-foreground)] text-body whitespace-pre-line">{message}</p>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="text-center space-y-4">
            <AlertCircle className="mx-auto h-12 w-12 text-[var(--error-text)]" aria-hidden />
            <div className="space-y-2">
              <p className="font-medium text-title text-[var(--error-text)]">Authentication Failed</p>
              <p className="text-[var(--muted-foreground)] text-body">{error}</p>
            </div>
            <Button onClick={() => navigate("/accounts")} variant="outline">
              Back to Accounts
            </Button>
          </div>
        )}
        </div>
      </Card>
    </div>
  );
}
