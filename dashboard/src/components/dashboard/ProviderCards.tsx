import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

interface ProviderData {
  name: string;
  color: string;
  bgColor: string;
  accounts: { active: number; exhausted: number; error: number; total: number };
  credits: { used: number; total: number; remaining?: number };
}

interface ProviderCardsProps {
  providers?: ProviderData[];
}

const defaultProviders: ProviderData[] = [];

export default function ProviderCards({ providers = defaultProviders }: ProviderCardsProps) {
  return (
    // Auto-fit rather than a fixed 3-column cap: on a 3440px monitor a hard
    // lg:grid-cols-3 leaves the same dead gutter the page container just gave
    // up. Cards keep a 20rem floor so they never squeeze into unreadable slivers.
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(20rem,1fr))]">
      {providers.map((provider) => {
        const usedPercentage = provider.credits.total > 0
          ? Math.round((provider.credits.used / provider.credits.total) * 100)
          : 0;
        const remaining = provider.credits.remaining ?? (provider.credits.total - provider.credits.used);

        return (
          <Card key={provider.name} className="overflow-hidden">
            {/* Card header follows the page convention: hairline rule, eyebrow
                label, live counts on the right. */}
            <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
              <h3 className="eyebrow flex min-w-0 items-center gap-2 text-[var(--foreground)]">
                <span
                  aria-hidden
                  className="h-3 w-[2px] shrink-0 rounded-full"
                  style={{ backgroundColor: provider.color }}
                />
                <span className="truncate">{provider.name}</span>
              </h3>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
                {provider.accounts.active}/{provider.accounts.total}
              </span>
            </div>

            <div className="space-y-3 px-4 py-3">
              {/* Status badges */}
              <div className="flex flex-wrap gap-2">
                {provider.accounts.active > 0 && (
                  <Badge variant="success">{provider.accounts.active} active</Badge>
                )}
                {provider.accounts.exhausted > 0 && (
                  <Badge variant="warning">{provider.accounts.exhausted} exhausted</Badge>
                )}
                {provider.accounts.error > 0 && (
                  <Badge variant="error">{provider.accounts.error} error</Badge>
                )}
              </div>

              {/* Credits */}
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="eyebrow">Credits</span>
                  <span className="font-mono text-[12px] tabular-nums text-[var(--foreground)]">
                    {provider.credits.used.toFixed(2)} / {provider.credits.total.toFixed(2)}
                  </span>
                </div>
                <Progress
                  value={usedPercentage}
                  indicatorClassName="rounded-full bg-[var(--progress-color)]"
                  style={{ ["--progress-color" as any]: provider.color }}
                  className="h-2"
                />
                <div className="flex justify-between font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
                  <span>{usedPercentage}% used</span>
                  <span>{remaining.toFixed(2)} remaining</span>
                </div>
              </div>
            </div>
          </Card>
        );
      })}
      {providers.length === 0 && (
        <Card className="col-span-full">
          <p className="px-4 py-3 font-mono text-[12px] text-[var(--muted-foreground)]">
            No provider data yet. Add/login accounts to populate this section.
          </p>
        </Card>
      )}
    </div>
  );
}
