import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PageHeader from "@/components/layout/PageHeader";
import { Copy, Eye, EyeOff, RefreshCw, Check, Save, ShieldCheck } from "lucide-react";
import { fetchApiKey, regenerateApiKey, setApiKey, testApiKey } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

export default function ApiKey() {
  const [apiKey, setApiKeyState] = useState(localStorage.getItem("api_key") || "pool-proxy-secret-key");
  const [source, setSource] = useState("browser");
  const [showKey, setShowKey] = useState(false);
  const { message, setMessage: setTimedMessage, clearMessage } = useTimedMessage<string>(null, 3500);
  const { message: copied, setMessage: setCopiedTimed } = useTimedMessage<boolean>(null, 2000);
  const [error, setError] = useState<string | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);

  function notify(text: string) {
    setTimedMessage(text);
    setError(null);
  }

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    clearMessage();
  }

  function saveToBrowser(key = apiKey) {
    localStorage.setItem("api_key", key);
    setApiKeyState(key);
  }

  async function loadKey() {
    try {
      const res = await fetchApiKey() as { key: string; source: string };
      setApiKeyState(res.key);
      setSource(res.source);
      saveToBrowser(res.key);
      setValid(true);
    } catch (err) {
      fail(err);
    }
  }

  useEffect(() => {
    loadKey();
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(apiKey);
    setCopiedTimed(true);
  };

  async function handleSave() {
    try {
      const res = await setApiKey(apiKey) as { key: string; source: string };
      saveToBrowser(res.key);
      setSource(res.source);
      setValid(true);
      notify("Key saved to backend and browser. Active for proxy requests.");
    } catch (err) {
      fail(err);
    }
  }

  async function handleRegenerate() {
    if (!confirm("Regenerate API key? Existing generated key will stop working.")) return;
    try {
      const res = await regenerateApiKey() as { key: string; source: string };
      saveToBrowser(res.key);
      setSource(res.source);
      setValid(true);
      notify("New key generated, saved and active.");
    } catch (err) {
      fail(err);
    }
  }

  async function handleTest() {
    try {
      const res = await testApiKey(apiKey) as { valid: boolean };
      setValid(res.valid);
      notify(res.valid ? "Key valid." : "Key rejected.");
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="API Key"
        meta={
          <>
            <span>source {source}</span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span
              style={{
                color:
                  valid === true
                    ? "var(--success)"
                    : valid === false
                      ? "var(--error)"
                      : undefined,
              }}
            >
              {valid === true ? "valid" : valid === false ? "invalid" : "untested"}
            </span>
          </>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={loadKey}>Load active</Button>
            <Button variant="ghost" size="sm" onClick={handleTest}>Test</Button>
            <Button variant="outline" size="sm" onClick={handleRegenerate}>
              <RefreshCw className="w-3.5 h-3.5" /> Generate
            </Button>
            <Button size="sm" onClick={handleSave}>
              <Save className="w-3.5 h-3.5" /> Save
            </Button>
          </>
        }
      />

      {(message || error) && (
        <p
          className={`border-l-2 px-3 py-2 font-mono text-[11px] ${message ? "border-[var(--success)] bg-[var(--success)]/8 text-[var(--success)]" : "border-[var(--error)] bg-[var(--error)]/8 text-[var(--error)]"}`}
        >
          {message || error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Primary: the key itself */}
        <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <h2 className="eyebrow flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" /> Active key
            </h2>
          </div>
          <div className="px-4 py-4">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKeyState(e.target.value);
                    setValid(null);
                  }}
                  className="pr-9 font-mono"
                  aria-label="Proxy API key"
                />
                <button
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-sm text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:text-[var(--foreground)]"
                  aria-label={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <Button variant="outline" size="icon" onClick={handleCopy} title="Copy key" aria-label="Copy key">
                {copied ? <Check className="w-4 h-4 text-[var(--success)]" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            <p className="mt-2.5 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
              Saving writes to the backend and this browser. The env fallback key stays accepted.
            </p>
          </div>
        </Card>

        {/* Secondary: flat, recessed, reference only */}
        <Card>
          <div className="border-b border-[var(--border)] px-4 py-3">
            <h2 className="eyebrow">Request example</h2>
          </div>
          <pre className="overflow-x-auto bg-[var(--sunken)] px-4 py-3 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
{`curl http://localhost:1930/v1/chat/completions \\
  -H "Authorization: Bearer ${showKey ? apiKey : "sk-pool-***"}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "ping"}]
  }'`}
          </pre>
        </Card>
      </div>
    </div>
  );
}
