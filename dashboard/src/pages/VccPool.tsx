import { useState, useEffect, useCallback, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import PageHeader from "@/components/layout/PageHeader";
import {
  CreditCard,
  Trash2,
  Upload,
  CheckCircle,
  Wand2,
  Copy,
  Download,
} from "lucide-react";
import { fetchApi } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { VisualCard } from "@/components/vcc/VisualCard";
import { ExportDialog } from "@/components/vcc/ExportDialog";
import { BinSelector } from "@/components/vcc/BinSelector";
import {
  generateVCCs,
  detectBrand,
  formatCardNumber,
  formatExpiry,
  parseCardLines,
  type GeneratedCard,
} from "@/lib/vcc-utils";
import type { BinEntry } from "@/lib/bin-data";

interface VCCCardInfo {
  id: number;
  last4: string;
  exp: string;
  name: string;
  status: string;
}

interface VCCPoolStatus {
  count: number;
  cards: VCCCardInfo[];
}

interface VCCTransaction {
  id: number;
  accountId: number;
  cardLast4: string;
  cardBrand: string;
  status: string;
  createdAt: string;
  email: string | null;
}

export default function VccPool() {
  const [pool, setPool] = useState<VCCPoolStatus>({ count: 0, cards: [] });
  const [transactions, setTransactions] = useState<VCCTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  // Generator state
  const [selectedBin, setSelectedBin] = useState("");
  const [binInfo, setBinInfo] = useState<BinEntry | null>(null);
  const [genCount, setGenCount] = useState(10);
  const [generatedCards, setGeneratedCards] = useState<GeneratedCard[]>([]);
  const [generating, setGenerating] = useState(false);

  // Import state
  const [bulkText, setBulkText] = useState("");

  // Export state
  const [exportOpen, setExportOpen] = useState(false);
  const [exportCards, setExportCards] = useState<GeneratedCard[]>([]);

  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const loadPool = useCallback(async () => {
    try {
      const data = await fetchApi<VCCPoolStatus>("/api/vcc/pool");
      setPool(data);
    } catch {
      setPool({ count: 0, cards: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTransactions = useCallback(async () => {
    try {
      const data = await fetchApi<{ transactions: VCCTransaction[] }>(
        "/api/vcc/transactions"
      );
      setTransactions(data.transactions || []);
    } catch {
      setTransactions([]);
    }
  }, []);

  useEffect(() => {
    loadPool();
    loadTransactions();
  }, [loadPool, loadTransactions]);

  // Stats
  const stats = useMemo(() => {
    const brandCounts: Record<string, number> = {};
    pool.cards.forEach((card) => {
      const brand = detectBrand(card.last4);
      brandCounts[brand] = (brandCounts[brand] || 0) + 1;
    });
    return {
      total: pool.count,
      visa: brandCounts.visa || 0,
      mastercard: brandCounts.mastercard || 0,
      amex: brandCounts.amex || 0,
      other: (brandCounts.discover || 0) + (brandCounts.unknown || 0),
    };
  }, [pool]);

  // Generator
  const handleBinChange = (bin: string) => {
    setSelectedBin(bin);
  };

  const handleBinInfo = (info: BinEntry | null) => {
    setBinInfo(info);
  };

  const handleGenerate = async () => {
    if (!selectedBin || selectedBin.length < 6) {
      setMessage("Please select or enter a BIN (minimum 6 digits)");
      return;
    }

    setGenerating(true);
    try {
      // Generate cards with BIN info for better metadata
      const cards = generateVCCs(selectedBin, genCount);

      // Attach BIN info to each card
      const cardsWithInfo = cards.map(card => ({
        ...card,
        binInfo: binInfo || undefined
      }));

      setGeneratedCards(cardsWithInfo);
      setMessage(`Generated ${cardsWithInfo.length} cards`);
    } catch (error) {
      setMessage("Failed to generate cards");
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyCard = async (card: GeneratedCard) => {
    const text = `${card.number}|${formatExpiry(card.expMonth, card.expYear)}|${card.cvv}`;
    await navigator.clipboard.writeText(text);
    setMessage("Card copied");
  };

  const handleCopyAll = async () => {
    const text = generatedCards
      .map((c) => `${c.number}|${formatExpiry(c.expMonth, c.expYear)}|${c.cvv}`)
      .join("\n");
    await navigator.clipboard.writeText(text);
    setMessage(`${generatedCards.length} cards copied`);
  };

  const handleExportGenerated = () => {
    setExportCards(generatedCards);
    setExportOpen(true);
  };

  // Import
  const handleBulkImport = async () => {
    if (!bulkText.trim()) {
      setMessage("Paste card list first");
      return;
    }

    const cards = parseCardLines(bulkText);

    if (cards.length === 0) {
      setMessage("No valid cards found");
      return;
    }

    try {
      const formattedCards = cards.map((card) => ({
        number: card.number,
        expMonth: card.month,
        expYear: card.year.length === 2 ? `20${card.year}` : card.year,
        cvv: card.cvv,
        name: "John Doe",
      }));

      const result = await fetchApi<{ added: number }>("/api/vcc/pool", {
        method: "POST",
        body: JSON.stringify({ cards: formattedCards }),
      });
      setBulkText("");
      setMessage(`${result.added} cards imported`);
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Import failed");
    }
  };

  // Pool management
  const handleDelete = async (id: number) => {
    try {
      await fetchApi(`/api/vcc/pool/${id}`, { method: "DELETE" });
      setMessage("Card removed");
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to remove card");
    }
  };

  const handleClearAll = async () => {
    if (!confirm("Remove all active VCC cards from pool?")) return;
    try {
      await fetchApi("/api/vcc/pool", { method: "DELETE" });
      setMessage("Pool cleared");
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to clear pool");
    }
  };

  const handleExportPool = () => {
    const cards: GeneratedCard[] = pool.cards.map((c) => ({
      bin: "",
      number: `****${c.last4}`,
      expMonth: c.exp.split("/")[0] || "",
      expYear: `20${c.exp.split("/")[1] || ""}`,
      cvv: "***",
      brand: detectBrand(c.last4),
    }));
    setExportCards(cards);
    setExportOpen(true);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="VCC Pool"
        meta={
          <>
            <span className={pool.count > 0 ? "text-[var(--success)]" : undefined}>
              {pool.count} active {pool.count === 1 ? "card" : "cards"}
            </span>
            <span aria-hidden className="text-[var(--border)]">·</span>
            <span>live BIN lookup</span>
          </>
        }
      />

      {/* Brand split: one divided strip, not five floating boxes */}
      {pool.count > 0 && (
        <Card className="grid grid-cols-2 divide-x divide-y divide-[var(--border)] sm:grid-cols-5 sm:divide-y-0">
          <Stat label="Total" value={stats.total} />
          <Stat label="Visa" value={stats.visa} tone="var(--chart-1)" />
          <Stat label="Mastercard" value={stats.mastercard} tone="var(--chart-2)" />
          <Stat label="Amex" value={stats.amex} tone="var(--chart-3)" />
          <Stat label="Other" value={stats.other} />
        </Card>
      )}

      {message && (
        <p className="border-l-2 border-[var(--border)] bg-[var(--secondary)]/50 px-3 py-2 font-mono text-[11px] text-[var(--foreground)]">
          {message}
        </p>
      )}

      {/* Tabs */}
      <Tabs defaultValue="generator" className="space-y-4">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="generator">Generator</TabsTrigger>
          <TabsTrigger value="generated">
            Generated {generatedCards.length > 0 && `(${generatedCards.length})`}
          </TabsTrigger>
          <TabsTrigger value="pool">Pool ({pool.count})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        {/* Generator Tab */}
        <TabsContent value="generator">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Left: Controls */}
            <Card>
              <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-4 py-3">
                <Wand2 className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
                <h2 className="eyebrow">Generate VCC</h2>
              </div>
              <div className="space-y-3 px-4 py-3">
                <BinSelector
                  value={selectedBin}
                  onChange={handleBinChange}
                  onBinInfo={handleBinInfo}
                />

                <div>
                  <label className="eyebrow mb-1.5 block">Number of Cards</label>
                  <Input
                    type="number"
                    value={genCount}
                    onChange={(e) => setGenCount(parseInt(e.target.value) || 1)}
                    min={1}
                    max={100}
                    className="font-mono tabular-nums"
                  />
                </div>

                <Button
                  onClick={handleGenerate}
                  className="w-full"
                  disabled={generating}
                >
                  <Wand2 className="w-3.5 h-3.5" />
                  {generating ? "Generating..." : `Generate ${genCount} Cards`}
                </Button>
              </div>
            </Card>

            {/* Right: Preview — the one card that earns a raised surface */}
            <Card className="shadow-[var(--shadow-raised)]">
              <div className="border-b border-[var(--border)] px-4 py-3">
                <h2 className="eyebrow">Preview</h2>
              </div>
              <div className="px-4 py-3">
                <VisualCard
                  number={selectedBin.padEnd(16, "0")}
                  expMonth="12"
                  expYear="2030"
                  name={binInfo?.issuer || "CARDHOLDER NAME"}
                  brand={detectBrand(selectedBin)}
                />
                {binInfo && (
                  <dl className="mt-4 divide-y divide-[var(--hairline)] border-t border-[var(--hairline)] font-mono text-[12px]">
                    {[
                      ["Brand", binInfo.brand, true],
                      ["Country", binInfo.countryName, false],
                      ["Bank", binInfo.issuer || "Unknown", false],
                      ["Type", binInfo.type, true],
                    ].map(([label, value, caps]) => (
                      <div key={label as string} className="flex items-baseline justify-between gap-3 py-1.5">
                        <dt className="eyebrow">{label as string}</dt>
                        <dd className={`truncate text-[var(--foreground)] ${caps ? "capitalize" : ""}`}>{value as string}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </Card>
          </div>
        </TabsContent>

        {/* Generated Cards Tab */}
        <TabsContent value="generated">
          <Card>
            <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
              <h2 className="eyebrow">Generated Cards <span className="tabular-nums opacity-70">{generatedCards.length}</span></h2>
              {generatedCards.length > 0 && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleCopyAll}>
                    <Copy className="w-3 h-3" />
                    Copy All
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleExportGenerated}>
                    <Download className="w-3 h-3" />
                    Export
                  </Button>
                </div>
              )}
            </div>
            <div className="px-4 py-3">
              {generatedCards.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-1.5 py-12 text-center">
                  <CreditCard className="h-6 w-6 text-[var(--muted-foreground)]/40" />
                  <p className="font-mono text-[12px] text-[var(--muted-foreground)]">
                    No cards generated yet — use the Generator tab.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {generatedCards.map((card, idx) => (
                    <div key={idx} className="space-y-2">
                      <VisualCard
                        number={card.number}
                        exp={formatExpiry(card.expMonth, card.expYear)}
                        name={card.binInfo?.issuer || "CARDHOLDER NAME"}
                        brand={card.brand || detectBrand(card.number)}
                        showActions
                        onCopy={() => handleCopyCard(card)}
                      />
                      <div className="px-1 font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
                        <div>{formatCardNumber(card.number)}</div>
                        <div className="mt-1 flex justify-between">
                          <span>Exp: {formatExpiry(card.expMonth, card.expYear)}</span>
                          <span>CVV: {card.cvv}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </TabsContent>

        {/* Pool Tab */}
        <TabsContent value="pool" className="space-y-4">
          {/* Import is a tool, not the subject — keep it flat above the list */}
          <Card>
            <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-4 py-3">
              <Upload className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
              <h2 className="eyebrow">Import Cards</h2>
            </div>
            <div className="space-y-2 px-4 py-3">
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={"number|mm/yy|cvv\n4111111111111111|12/30|123\n\nor: number|mm|yy|cvv\n4111111111111111|12|30|123"}
                className="h-[120px] w-full resize-none rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-[12px] text-[var(--foreground)] transition-colors duration-150 ease-out placeholder:text-[var(--muted-foreground)]/70 hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
              />
              <Button onClick={handleBulkImport} className="w-full">
                <Upload className="w-3.5 h-3.5" />
                Import Cards
              </Button>
            </div>
          </Card>

          {/* The pool itself is the page's primary surface */}
          <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
              <h2 className="eyebrow flex items-center gap-1.5">
                <CreditCard className="h-3.5 w-3.5" />
                Active Cards <span className="tabular-nums opacity-70">{pool.count}</span>
              </h2>
              {pool.count > 0 && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={handleExportPool}>
                    <Download className="w-3 h-3" />
                    Export
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleClearAll} className="text-[var(--error)] hover:text-[var(--destructive)]">
                    <Trash2 className="w-3 h-3" />
                    Clear All
                  </Button>
                </div>
              )}
            </div>
            {loading ? (
              <p className="px-4 py-3 font-mono text-[12px] text-[var(--muted-foreground)]">Loading…</p>
            ) : pool.cards.length === 0 ? (
              <p className="px-4 py-3 font-mono text-[12px] text-[var(--muted-foreground)]">
                No active cards. Generate or import above.
              </p>
            ) : (
              <div>
                {pool.cards.map((card) => (
                  <div
                    key={card.id}
                    className="flex items-center justify-between gap-3 border-t border-[var(--hairline)] px-4 py-2 font-mono text-[12px] transition-colors duration-150 first:border-t-0 hover:bg-[var(--secondary)]/50"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="tabular-nums text-[var(--foreground)]">•••• {card.last4}</span>
                      <span className="tabular-nums text-[var(--muted-foreground)]">{card.exp}</span>
                      <span className="hidden truncate text-[var(--muted-foreground)] sm:inline">{card.name}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(card.id)}
                      title="Remove card"
                      className="shrink-0 hover:text-[var(--destructive)]"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-[var(--error)]" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history">
          <Card className="overflow-hidden shadow-[var(--shadow-raised)]">
            <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-4 py-3">
              <CheckCircle className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
              <h2 className="eyebrow">Upgrade History <span className="tabular-nums opacity-70">{transactions.length}</span></h2>
            </div>
            {transactions.length === 0 ? (
              <p className="px-4 py-3 font-mono text-[12px] text-[var(--muted-foreground)]">No upgrade transactions yet.</p>
            ) : (
              <div>
                {transactions.map((tx) => (
                  <div
                    key={tx.id}
                    className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 border-t border-[var(--hairline)] px-4 py-2 font-mono text-[12px] transition-colors duration-150 first:border-t-0 hover:bg-[var(--secondary)]/50"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        aria-hidden
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${tx.status === "success" ? "bg-[var(--success)]" : "bg-[var(--error)]"}`}
                      />
                      <span className="tabular-nums text-[var(--foreground)]">•••• {tx.cardLast4}</span>
                      <span className="truncate text-[var(--muted-foreground)]">
                        {tx.email || `Account #${tx.accountId}`}
                      </span>
                      <Badge variant={tx.status === "success" ? "success" : "destructive"}>{tx.status}</Badge>
                    </div>
                    <span className="tabular-nums text-[11px] text-[var(--muted-foreground)]">
                      {new Date(tx.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      {/* Export Dialog */}
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        cards={exportCards}
        onMessage={setMessage}
      />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="px-3 py-3">
      <div className="eyebrow">{label}</div>
      <div
        className="mt-1.5 font-mono text-xl font-semibold leading-none tabular-nums"
        style={{ color: tone || "var(--foreground)" }}
      >
        {value}
      </div>
    </div>
  );
}
