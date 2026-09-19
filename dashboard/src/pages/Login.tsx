import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eye, EyeOff } from "lucide-react";
import { validateApiKey, API_BASE } from "@/lib/api";

interface LoginProps {
  onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) {
      setError("Key required");
      return;
    }

    setLoading(true);
    setError(null);

    const valid = await validateApiKey(key.trim());
    if (valid) {
      localStorage.setItem("api_key", key.trim());
      onLogin();
    } else {
      setError("Key rejected — check the admin key and endpoint below");
    }
    setLoading(false);
  }

  return (
    /* Off-center on purpose: the panel sits on a left-anchored column so it
       reads as a terminal prompt, not a centered marketing hero. */
    <div className="flex min-h-dvh items-center justify-center p-4 sm:justify-start sm:px-[12vw]">
      <div className="w-full max-w-[340px]">
        {/* Wordmark line — mono, inline, no icon tile with a glow behind it */}
        <div className="mb-5 flex items-baseline gap-2.5">
          <img src="/etteum.svg" alt="" className="h-5 w-5 self-center" />
          <span className="font-mono text-title font-semibold tracking-caps text-[var(--foreground)]">
            ETTEUM
          </span>
          <span className="eyebrow">proxy pool</span>
        </div>

        <div className="rounded-md border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-raised)]">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <h1 className="eyebrow">Authenticate</h1>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3 px-4 py-4">
            <div>
              <label htmlFor="api-key" className="eyebrow mb-1.5 block">
                Admin key
              </label>
              <div className="relative">
                <Input
                  id="api-key"
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => { setKey(e.target.value); setError(null); }}
                  placeholder="sk-pool-…"
                  className="pr-9 font-mono"
                  autoFocus
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "api-key-error" : undefined}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-sm text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:text-[var(--foreground)]"
                  aria-label={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <p
                id="api-key-error"
                role="alert"
                className="border-l-2 border-[var(--error)] bg-[var(--error)]/8 px-3 py-2 font-mono text-meta text-[var(--error-text)]"
              >
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Verifying…" : "Sign in"}
            </Button>
          </form>

          <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-2">
            <span className="eyebrow shrink-0">Endpoint</span>
            <p className="truncate font-mono text-micro text-[var(--muted-foreground)]">
              {API_BASE || window.location.origin}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
