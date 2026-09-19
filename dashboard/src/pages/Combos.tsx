import { useState, useEffect, useCallback, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/layout/PageHeader";
import { cn } from "@/lib/utils";
import {
  Plus,
  Trash2,
  Power,
  PowerOff,
  Pencil,
  X,
  Layers,
  ChevronUp,
  ChevronDown,
  GripVertical,
} from "lucide-react";
import {
  fetchCombos,
  createCombo,
  updateCombo,
  deleteCombo,
  fetchModels,
  type ComboDTO,
} from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useWsEvent } from "@/hooks/useWebSocket";
import ModelCombobox, { providerTag } from "@/components/ModelCombobox";

interface ComboFormState {
  id: number | null;
  name: string;
  targets: string[];
}

const emptyForm: ComboFormState = { id: null, name: "", targets: [] };

/** Rank label for a chain slot. Position 0 wins; everything after it is a backup. */
function rankLabel(i: number): string {
  return i === 0 ? "Primary" : `Fallback ${i}`;
}

export default function Combos() {
  const [combos, setCombos] = useState<ComboDTO[]>([]);
  const [models, setModels] = useState<{ id: string; owned_by: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<ComboFormState | null>(null);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);
  /** Row index being dragged, and the row it is currently hovering over. */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  /** Model id that just entered the chain — brief highlight, then it clears. */
  const { message: added, setMessage: setAdded } = useTimedMessage<string>(null, 900);
  /** Last reorder, announced to screen readers. Reordering is silent otherwise:
   *  the moved row keeps focus, and a changed aria-label is not reliably read. */
  const { message: moved, setMessage: setMoved } = useTimedMessage<string>(null, 2000);

  const load = useCallback(async () => {
    try {
      const result = await fetchCombos();
      setCombos(result.data || []);
    } catch {
      setCombos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Combos show up in /v1/models as owned_by "combo" — pickers must exclude them.
  const loadModels = useCallback(async () => {
    try {
      const res: { data: { id: string; owned_by: string }[] } = await fetchModels();
      setModels((res.data || []).filter((m) => m.owned_by !== "combo"));
    } catch {
      setModels([]);
    }
  }, []);

  useEffect(() => { loadModels(); }, [loadModels]);
  useEffect(() => { loadModels(); }, [combos]); // reload so new combos disappear from the picker

  useWsEvent(["combos_updated"], load);

  const enabledCount = combos.filter((c) => c.enabled).length;

  const handleToggle = async (combo: ComboDTO) => {
    try {
      await updateCombo(combo.id, { enabled: !combo.enabled });
      load();
    } catch (e: any) {
      setMessage(e.message || "Failed to toggle combo");
    }
  };

  const handleDelete = async (combo: ComboDTO) => {
    if (!confirm(`Delete combo "${combo.name}"?`)) return;
    try {
      await deleteCombo(combo.id);
      setMessage("Combo deleted");
      load();
    } catch (e: any) {
      setMessage(e.message || "Failed to delete combo");
    }
  };

  const handleSave = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      setMessage("Combo name is required");
      return;
    }
    if (form.targets.length === 0) {
      setMessage("Add at least one model to the chain");
      return;
    }
    const dup = combos.find(
      (c) => c.name === name && (form.id == null || c.id !== form.id)
    );
    if (dup) {
      setMessage(`Combo "${name}" already exists`);
      return;
    }
    try {
      if (form.id == null) {
        await createCombo({ name, targets: form.targets });
        setMessage("Combo created");
      } else {
        await updateCombo(form.id, { name, targets: form.targets });
        setMessage("Combo updated");
      }
      setForm(null);
      load();
    } catch (e: any) {
      setMessage(e.message || "Save failed");
    }
  };

  const move = (i: number, dir: -1 | 1) => {
    if (!form) return;
    const j = i + dir;
    if (j < 0 || j >= form.targets.length) return;
    const targets = [...form.targets];
    [targets[i], targets[j]] = [targets[j], targets[i]];
    setForm({ ...form, targets });
    setMoved(`${targets[j]} moved to position ${j + 1}, ${rankLabel(j).toLowerCase()}`);
  };

  /** Drag reorder: pull the row out and re-insert it, so dropping across
   *  several rows shifts the rest instead of swapping two distant entries. */
  const moveTo = (from: number, to: number) => {
    if (!form || from === to) return;
    const targets = [...form.targets];
    const [row] = targets.splice(from, 1);
    if (row === undefined) return;
    targets.splice(to, 0, row);
    setForm({ ...form, targets });
    setMoved(`${row} moved to position ${to + 1}, ${rankLabel(to).toLowerCase()}`);
  };

  const removeMember = (i: number) => {
    if (!form) return;
    setForm({ ...form, targets: form.targets.filter((_, idx) => idx !== i) });
  };

  const toggleMember = (id: string) => {
    if (!form) return;
    const has = form.targets.includes(id);
    setForm(
      has
        ? { ...form, targets: form.targets.filter((t) => t !== id) }
        : { ...form, targets: [...form.targets, id] }
    );
    // Appending happens at the bottom of a list the picker may be covering, so
    // the new row flags itself for a beat once the popover is out of the way.
    setAdded(has ? null : id);
  };

  const chainSet = useMemo(() => new Set(form?.targets ?? []), [form?.targets]);

  /** owned_by per model id, for the provider hint on each chain row. */
  const ownerById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of models) map.set(m.id, m.owned_by);
    return map;
  }, [models]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Model Combos"
        meta={`${combos.length} combos · ${enabledCount} active`}
        actions={
          <Button size="sm" onClick={() => setForm({ ...emptyForm })}>
            <Plus className="w-3.5 h-3.5" /> New combo
          </Button>
        }
      />

      {message && (
        <p className="border-l-2 border-[var(--border)] bg-[var(--secondary)]/50 px-3 py-2 font-mono text-meta text-[var(--foreground)]">
          {message}
        </p>
      )}

      {form && (
        // No overflow-hidden here, deliberately: the "Add models" popover is
        // absolutely positioned inside this card and taller than the space left
        // below its trigger, so clipping the card clips the model list. Nothing
        // in the card bleeds past the rounded corners (the header is a plain
        // border-b, no fill), so there is nothing to clip anyway.
        <Card className="shadow-[var(--shadow-raised)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <h2 className="eyebrow flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5" />
              {form.id == null ? "New combo" : "Edit combo"}
            </h2>
            <button
              onClick={() => setForm(null)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
              aria-label="Discard"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {/* Form column stays readable while the card goes full width. A name
              input and a chain row stretched across 3400px is a worse read than
              a gutter, and this is the one place on the page with form fields
              rather than scannable table rows. */}
          <div className="max-w-3xl space-y-3 px-4 py-3">
            <div>
              <label htmlFor="combo-name" className="eyebrow mb-1.5 block">Name</label>
              <input
                id="combo-name"
                className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-2 font-mono text-body text-[var(--foreground)] transition-colors duration-150 ease-out placeholder:text-[var(--muted-faint)] hover:border-[var(--muted)] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35"
                placeholder="my-model-combo"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <p className="mt-1 font-mono text-meta text-[var(--muted-foreground)]">
                Clients request this model name.
              </p>
            </div>
            <div>
              {/* The chain IS a priority list, so the header states the rule in
                  words once and the rows carry the rank from there. */}
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="eyebrow">Fallback order</span>
                <span className="font-mono text-meta tabular-nums text-[var(--muted-foreground)]">
                  {form.targets.length > 0
                    ? `${form.targets.length} in chain · ${models.length} available`
                    : `${models.length} available`}
                </span>
              </div>
              <p className="mb-2 font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
                Requests go to <span className="text-[var(--primary-text)]">#1</span>. Each model below it
                is tried only when the one above fails.
              </p>

              {form.targets.length > 1 && (
                <p
                  className="mb-2 truncate font-mono text-meta text-[var(--muted-foreground)]"
                  title={form.targets.join(" → ")}
                >
                  {form.targets.join(" → ")}
                </p>
              )}

              <div className="space-y-1.5">
                {form.targets.length === 0 && (
                  <p className="rounded-md border border-dashed border-[var(--border)] px-2.5 py-3 font-mono text-meta text-[var(--muted-foreground)]">
                    Chain is empty — pick a model below to make it the primary.
                  </p>
                )}

                {/* An ordered list, because that is what this is: position
                    carries meaning, and a screen reader gets the numbering for
                    free instead of from a label we maintain by hand. */}
                <ol className="space-y-1.5">
                {form.targets.map((t, i) => {
                  const owner = ownerById.get(t);
                  const tag = owner ? providerTag(owner) : null;
                  const primary = i === 0;
                  const last = i === form.targets.length - 1;
                  return (
                    <li
                      // Keyed by id, not index: ids are unique in a chain, so a
                      // reorder moves the existing DOM node and keyboard focus
                      // rides along with the row it was on.
                      key={t}
                      onDragEnter={() => setDragOver(i)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragFrom !== null) moveTo(dragFrom, i);
                        setDragFrom(null);
                        setDragOver(null);
                      }}
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-1.5 py-1.5 transition-[background-color,border-color,opacity] duration-300 [transition-timing-function:var(--ease-out-expo)]",
                        // Primary is stated twice — tinted bed and a brand rank
                        // chip — so "first wins" survives a glance at 6 rows.
                        primary
                          ? "border-[var(--primary)]/30 bg-[var(--primary)]/[0.06]"
                          : "border-[var(--hairline)] bg-[var(--secondary)]/30",
                        added === t && "border-[var(--primary)]/60 bg-[var(--primary)]/[0.12]",
                        dragOver === i && dragFrom !== null && dragFrom !== i &&
                          "border-[var(--primary)]/60",
                        dragFrom === i && "opacity-40"
                      )}
                    >
                      {/* The handle is the drag source, not the whole row —
                          so selecting a model name to copy it still works.
                          It is also the keyboard reorder control, and is never
                          disabled, so focus has somewhere stable to live while
                          a row travels to either end of the chain. */}
                      <button
                        type="button"
                        draggable
                        onDragStart={(e) => {
                          setDragFrom(i);
                          e.dataTransfer.effectAllowed = "move";
                          // Firefox refuses to start a drag without payload.
                          e.dataTransfer.setData("text/plain", t);
                        }}
                        onDragEnd={() => {
                          setDragFrom(null);
                          setDragOver(null);
                        }}
                        onKeyDown={(e) => {
                          if (!e.altKey) return;
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            move(i, -1);
                          } else if (e.key === "ArrowDown") {
                            e.preventDefault();
                            move(i, 1);
                          }
                        }}
                        title="Drag to reorder, or Alt with arrow keys"
                        aria-label={`${t} — position ${i + 1} of ${form.targets.length}. Alt with arrow up or down to move.`}
                        className="flex min-h-[40px] w-7 shrink-0 cursor-grab items-center justify-center rounded-sm text-[var(--muted-foreground)] transition-colors duration-150 ease-out hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/35 active:cursor-grabbing md:min-h-0 md:h-8 md:w-6"
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </button>

                      <span
                        className={cn(
                          "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-micro font-medium tabular-nums",
                          primary
                            ? "bg-[var(--primary)]/15 text-[var(--primary-text)]"
                            : "text-[var(--muted-foreground)]"
                        )}
                      >
                        #{i + 1}
                      </span>

                      <div className="flex min-w-0 flex-1 flex-col">
                        <span
                          className="truncate font-mono text-body text-[var(--foreground)]"
                          title={t}
                        >
                          {t}
                        </span>
                        <span className="flex items-center gap-1.5 font-mono text-micro text-[var(--muted-foreground)]">
                          {tag && (
                            <>
                              <span
                                aria-hidden
                                className="h-1 w-1 shrink-0 rounded-full"
                                style={{ backgroundColor: tag.accent }}
                              />
                              <span className="truncate">{owner}</span>
                              <span aria-hidden className="text-[var(--border)]">
                                │
                              </span>
                            </>
                          )}
                          <span className={primary ? "text-[var(--primary-text)]" : undefined}>
                            {rankLabel(i)}
                          </span>
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => move(i, -1)}
                          disabled={primary}
                          title={primary ? "Already primary" : "Move up"}
                          aria-label={`Move ${t} up`}
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => move(i, 1)}
                          disabled={last}
                          title={last ? "Already last" : "Move down"}
                          aria-label={`Move ${t} down`}
                        >
                          <ChevronDown className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeMember(i)}
                          disabled={form.targets.length === 1}
                          title={form.targets.length === 1 ? "A combo needs one model" : "Remove"}
                          aria-label={`Remove ${t} from chain`}
                          className="hover:text-[var(--destructive-text)]"
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
                </ol>

                <ModelCombobox
                  value=""
                  options={models}
                  onToggle={toggleMember}
                  selected={chainSet}
                  allowClear={false}
                  placeholder="Add models…"
                />

                {/* Reorder and append both leave focus where it was, so the
                    change is announced here instead of going unheard. */}
                <p className="sr-only" role="status" aria-live="polite">
                  {moved ?? ""}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--hairline)] pt-3">
              <Button variant="ghost" size="sm" onClick={() => setForm(null)}>Cancel</Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!form.name.trim() || form.targets.length === 0}
              >
                Save
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <p className="px-4 py-3 font-mono text-body text-[var(--muted-foreground)]">Loading…</p>
        ) : combos.length === 0 ? (
          <p className="px-4 py-3 font-mono text-body text-[var(--muted-foreground)]">
            No combos yet — create one to chain models with fallback.
          </p>
        ) : (
          <div>
            {combos.map((combo, i) => (
              <div
                key={combo.id}
                className={`flex items-center justify-between gap-3 border-t border-[var(--hairline)] px-3 py-2 transition-colors duration-150 ease-out first:border-t-0 hover:bg-[var(--secondary)]/40 ${combo.enabled ? "" : "opacity-55"}`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2.5 font-mono text-body">
                  <span className="w-7 shrink-0 tabular-nums text-[var(--muted-foreground)]">{i + 1}</span>
                  <span
                    aria-hidden
                    className="h-3 w-[2px] shrink-0 rounded-full"
                    style={{ backgroundColor: combo.enabled ? "var(--success)" : "var(--border)" }}
                    title={combo.enabled ? "enabled" : "disabled"}
                  />
                  <span className="shrink-0 font-medium text-[var(--foreground)]" title={combo.name}>
                    {combo.name}
                  </span>
                  <Badge variant="secondary">{combo.targets.length}</Badge>
                  <span className="min-w-0 flex-1 truncate text-[var(--muted-foreground)]" title={combo.targets.join(" → ")}>
                    {combo.targets.join(" → ")}
                  </span>
                </div>
                <div className="flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleToggle(combo)}
                    title={combo.enabled ? "Disable" : "Enable"}
                    aria-label={combo.enabled ? "Disable combo" : "Enable combo"}
                  >
                    {combo.enabled ? <PowerOff className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setForm({ id: combo.id, name: combo.name, targets: [...combo.targets] })}
                    title="Edit"
                    aria-label="Edit combo"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDelete(combo)}
                    title="Delete"
                    aria-label="Delete combo"
                    className="hover:text-[var(--destructive-text)]"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}