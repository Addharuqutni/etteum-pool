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
    /* Centred. The panel used to be pinned 12vw from the left on `sm`+ with a
       comment claiming it "reads as a terminal prompt" — but at 1920px that
       put the card 560px left of centre, and the offset grew with the
       viewport, so it looked broken rather than deliberate. On a single-card
       screen there is no layout reason to off-centre it. */
    <div className="flex min-h-dvh items-center justify-center p-4">
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
            {/* A page heading, not an eyebrow. `.eyebrow` is a 10px micro
                label — as an <h1> it gave the screen no title at all against
                the 15px wordmark sitting right above it. */}
            <h1 className="font-mono text-title font-semibold uppercase leading-none tracking-caps text-[var(--foreground)]">
              Authenticate
            </h1>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3 px-4 py-4">
            <div>
              {/* Field label: readable, not a 10px micro-label. */}
              <label
                htmlFor="api-key"
                className="mb-1.5 block font-mono text-meta text-[var(--muted-foreground)]"
              >
                Admin key
              </label>
              <div className="relative">
                <Input
                  id="api-key"
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => { setKey(e.target.value); setError(null); }}
                  placeholder="sk-pool-…"
                  className="pr-11 font-mono"
                  autoFocus
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "api-key-error" : undefined}
                />
                {/* 40x40 tap target. Was 28x28 — below the floor and easy to
                    mis-tap, which matters because the whole point of this
                    screen is getting one secret typed correctly. */}
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-0 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-sm text-[var(--muted-foreground)] interactive hover:text-[var(--foreground)] focus-ring md:h-8 md:w-8"
                  aria-label={showKey ? "Hide key" : "Show key"}
                  aria-pressed={showKey}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
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
