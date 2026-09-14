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
    
    if (!code || !state) {
      setError("Missing authorization code or state parameter");
      setStatus("error");
      return;
    }

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
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)] p-8 flex items-center justify-center">
      <Card className="max-w-md w-full p-8 space-y-6">
        <PageHeader title="Google Cloud Code Assist Login" />

        {status === "loading" && (
          <div className="text-center space-y-4">
            <Loader2 className="h-12 w-12 animate-spin mx-auto text-primary" />
            <p className="text-[var(--muted-foreground)]">{message}</p>
            <p className="text-sm text-[var(--muted-foreground)]">
              This may take a few seconds while we provision your project.
            </p>
          </div>
        )}

        {status === "success" && (
          <div className="text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
            <div className="space-y-2">
              <p className="font-medium text-lg">✓ Authentication Successful</p>
              <p className="text-[var(--muted-foreground)] text-sm whitespace-pre-line">{message}</p>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="text-center space-y-4">
            <AlertCircle className="h-12 w-12 text-red-500 mx-auto" />
            <div className="space-y-2">
              <p className="font-medium text-lg text-red-500">Authentication Failed</p>
              <p className="text-[var(--muted-foreground)] text-sm">{error}</p>
            </div>
            <Button onClick={() => navigate("/accounts")} variant="outline">
              Back to Accounts
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
