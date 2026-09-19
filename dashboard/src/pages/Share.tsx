import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";
import { API_BASE } from "@/lib/api";

interface ShareData {
  name: string;
  description: string | null;
  baseUrl: string;
  shareSlug: string;
  usage: {
    monthlyRequests: number;
    monthlyTokens: number;
    totalRequests: number;
    totalTokens: number;
  };
}

export default function Share() {
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/keys/share/${slug}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Share not found or disabled"))))
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [slug]);

  function copy(id: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  }

  if (error) {
    return (
      <div className="flex h-dvh items-center justify-center font-mono text-lead text-[var(--muted-foreground)]">
        {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-dvh items-center justify-center font-mono text-lead text-[var(--muted-foreground)]">
        Loading...
      </div>
    );
  }

  const curl = `curl ${data.baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <KEY_ANDA>" \\
  -d '{"model": "<MODEL>", "messages": [{"role": "user", "content": "hi"}]}'`;
  const opencode = JSON.stringify(
    { $schema: "https://opencode.ai/config.json", provider: { etteum: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `${data.baseUrl}/v1`, apiKey: "<KEY_ANDA>" } } } },
    null,
    2
  );

  const snippets = [
    { id: "curl", label: "cURL", text: curl },
    { id: "opencode", label: "opencode.json", text: opencode },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-10">
      <div className="rise">
        <p className="eyebrow">etteum pool · shared key</p>
        <h1 className="mt-1 text-stat-sm font-semibold tracking-normal">{data.name}</h1>
        {data.description && (
          <p className="mt-1 font-mono text-body text-[var(--muted-foreground)]">{data.description}</p>
        )}
      </div>
      <Card className="rise" style={{ ["--d" as string]: "40ms" }}>
        <CardContent className="space-y-1 pt-4 font-mono text-body tabular-nums">
          <div>Base URL: <span className="text-[var(--foreground)]">{data.baseUrl}</span></div>
          <div>Bulan ini: {data.usage.monthlyRequests} request · {data.usage.monthlyTokens.toLocaleString()} token</div>
          <div>Total: {data.usage.totalRequests} request · {data.usage.totalTokens.toLocaleString()} token</div>
          <div className="text-[var(--muted-foreground)]">Minta secret key pada admin, lalu ganti {"<KEY_ANDA>"} di bawah.</div>
        </CardContent>
      </Card>
      {snippets.map((s, i) => (
        <Card key={s.id} className="rise overflow-hidden" style={{ ["--d" as string]: `${80 + i * 40}ms` }}>
          <CardHeader className="flex-row items-center justify-between py-2">
            <CardTitle>{s.label}</CardTitle>
            <Button size="sm" variant="outline" onClick={() => copy(s.id, s.text)}>
              {copied === s.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Copy
            </Button>
          </CardHeader>
          <pre className="max-h-64 overflow-auto border-t border-[var(--border)] bg-[var(--sunken)] px-4 py-3 font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">{s.text}</pre>
        </Card>
      ))}
      <p className="font-mono text-meta tabular-nums text-[var(--muted-foreground)]">
        Secret key hanya dibagikan sekali oleh admin — simpan baik-baik.
      </p>
    </div>
  );
}
