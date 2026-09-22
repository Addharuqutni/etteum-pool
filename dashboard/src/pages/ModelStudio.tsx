import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/layout/PageHeader";
import ModelCombobox from "@/components/ModelCombobox";
import { Markdown } from "@/lib/markdown";
import {
  Bot,
  ChevronDown,
  Eraser,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Square,
  Trash2,
  User as UserIcon,
  Zap,
} from "lucide-react";
import {
  createStudioSession,
  deleteStudioSession,
  fetchStudioModels,
  getStudioSession,
  listStudioSessions,
  streamModelStudioChat,
  updateStudioSession,
  type StudioMessage,
  type StudioModelOption,
  type StudioSession,
  type StudioSessionSummary,
  type StudioUsage,
} from "@/lib/model-studio";
import { modelColor } from "@/lib/utils";

const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const DEFAULT_MAX_TOKENS = 8192;
const MAX_INPUT_CHARS = 32_000;

function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.slice(0, 60) || "New chat";
}

function timeAgo(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "baru saja";
  if (m < 60) return `${m}m lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}j lalu`;
  return `${Math.floor(h / 24)}h lalu`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

interface DraftMessage {
  content: string;
  reasoning: string;
  usage?: StudioUsage;
  firstTokenMs?: number;
  error?: string;
}

export default function ModelStudio() {
  const [models, setModels] = useState<StudioModelOption[]>([]);
  const [sessions, setSessions] = useState<StudioSessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [session, setSession] = useState<StudioSession | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<string>("medium");
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
  const [input, setInput] = useState("");

  const [draft, setDraft] = useState<DraftMessage | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const loadModels = useCallback(async () => {
    try {
      const { data } = await fetchStudioModels();
      setModels(data);
      setModel((prev) => prev || data[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load models");
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const { data } = await listStudioSessions();
      setSessions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    }
  }, []);

  useEffect(() => {
    void loadModels();
    void loadSessions();
  }, [loadModels, loadSessions]);

  // Abort any in-flight stream when leaving the page.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const selectSession = useCallback(
    async (id: string) => {
      if (streaming) return;
      try {
        const { data } = await getStudioSession(id);
        setActiveId(id);
        setSession(data);
        setModel(data.model || model);
        setSystemPrompt(data.systemPrompt || "");
        setSidebarOpen(false);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load session");
      }
    },
    [streaming, model]
  );

  const newChat = useCallback(() => {
    if (streaming) return;
    abortRef.current?.abort();
    // Clearing activeId is what makes the NEXT send create a fresh session.
    // Without it, saveTurn reuses the old id and the new turns are appended
    // to the previous session's history.
    setActiveId(null);
    setSession(null);
    setDraft(null);
    setInput("");
    setSidebarOpen(false);
    setError(null);
    stickToBottom.current = true;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [streaming]);

  const removeSession = useCallback(
    async (id: string) => {
      try {
        await deleteStudioSession(id);
        if (activeId === id) newChat();
        void loadSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete session");
      }
    },
    [activeId, newChat, loadSessions]
  );

  // Persist the current turn: user message + streamed assistant message.
  const saveTurn = useCallback(
    async (userMessage: StudioMessage, assistant: StudioMessage) => {
      let id = activeId;
      // After "New chat" there is no session yet, so this turn creates one.
      const base = id ? session?.messages ?? [] : [];
      try {
        if (!id) {
          const { data } = await createStudioSession({
            title: deriveTitle(userMessage.content),
            model,
            systemPrompt,
          });
          id = data.id;
          setActiveId(data.id);
          setSession(data);
        }
        await updateStudioSession(id, {
          messages: [...base, userMessage, assistant],
          model,
          systemPrompt,
        });
        const { data } = await getStudioSession(id);
        setSession(data);
        void loadSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save session");
      }
    },
    [activeId, session, model, systemPrompt, loadSessions]
  );

  // Conversation history sent to the model: stored turns minus any system role
  // (the system prompt is folded in server-side) plus the new user message.
  const runCompletion = useCallback(
    async (history: StudioMessage[], userMessage: StudioMessage) => {
      setError(null);
      setDraft({ content: "", reasoning: "" });
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      const payload = {
        model,
        systemPrompt,
        maxTokens,
        reasoningEffort,
        messages: [...history, userMessage].map((m) => ({ role: m.role, content: m.content })),
      };

      let content = "";
      let reasoning = "";
      let usage: StudioUsage | undefined;
      let firstTokenMs: number | undefined;

      try {
        await streamModelStudioChat(
          payload,
          {
            onText: (chunk) => {
              content += chunk;
              setDraft({ content, reasoning, usage, firstTokenMs });
            },
            onReasoning: (chunk) => {
              reasoning += chunk;
              setDraft({ content, reasoning, usage, firstTokenMs });
            },
            onUsage: (u) => {
              usage = u;
              setDraft({ content, reasoning, usage: u, firstTokenMs });
            },
            onFirstToken: (ms) => {
              firstTokenMs = ms;
              setDraft({ content, reasoning, usage, firstTokenMs: ms });
            },
          },
          controller.signal
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "aborted" || controller.signal.aborted) {
          // Keep whatever streamed so far; an aborted turn is still a turn.
        } else {
          setError(message);
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }

      const assistant: StudioMessage = {
        role: "assistant",
        content,
        ts: new Date().toISOString(),
        ...(reasoning ? { reasoning } : {}),
        ...(usage ? { usage } : {}),
      };
      setDraft(null);
      await saveTurn(userMessage, assistant);
    },
    [model, systemPrompt, maxTokens, reasoningEffort, saveTurn]
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || !model) return;
    const userMessage: StudioMessage = {
      role: "user",
      content: text.slice(0, MAX_INPUT_CHARS),
      ts: new Date().toISOString(),
    };
    setInput("");
    const history = (session?.messages ?? []).filter((m) => m.role !== "system");
    await runCompletion(history, userMessage);
  }, [input, streaming, model, session, runCompletion]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const regenerate = useCallback(async () => {
    if (streaming || !session) return;
    const msgs = [...session.messages];
    while (msgs.length > 0 && msgs[msgs.length - 1]!.role === "assistant") msgs.pop();
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "user") {
      setError("Nothing to regenerate — send a message first");
      return;
    }
    // Trim the stored conversation so a mid-stream abort never leaves a
    // dangling assistant turn behind.
    try {
      await updateStudioSession(activeId!, { messages: msgs });
      setSession((prev) => (prev ? { ...prev, messages: msgs } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trim session");
      return;
    }
    const history = msgs.slice(0, -1);
    await runCompletion(history, last);
  }, [streaming, session, activeId, runCompletion]);

  const clearMessages = useCallback(async () => {
    if (streaming || !activeId) return;
    try {
      await updateStudioSession(activeId, { messages: [] });
      setSession((prev) => (prev ? { ...prev, messages: [] } : prev));
      void loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear messages");
    }
  }, [streaming, activeId, loadSessions]);

  // Close the composer's "unsaved session" affordance as soon as a session
  // exists, and keep the transcript pinned to the bottom after a new chat.
  useEffect(() => {
    stickToBottom.current = true;
  }, [activeId]);

  const messages = session?.messages ?? [];
  const visible: Array<StudioMessage | { role: "assistant-draft" }> = useMemo(() => {
    if (!draft) return messages;
    return [...messages, { role: "assistant-draft" as const }];
  }, [messages, draft]);

  // Auto-scroll while streaming, unless the user scrolled up to read.
  useLayoutEffect(() => {
    if (!stickToBottom.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [visible, draft]);

  // Grow the composer with its content, capped so long prompts scroll
  // instead of pushing the transcript off-screen.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send]
  );

  const activeModel = models.find((m) => m.id === model);
  const canSend = input.trim().length > 0 && !streaming && Boolean(model);

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col gap-3 md:h-[calc(100vh-3.25rem)] md:gap-4">
      <PageHeader
        title="Model Studio"
        meta={
          <>
            <span>{models.length} models</span>
            <span aria-hidden className="text-[var(--border)]">│</span>
            <span>{sessions.length} sessions</span>
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSidebarOpen((v) => !v)}
              className="md:hidden"
              title="Toggle sessions"
            >
              {sidebarOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">Sessions</span>
            </Button>
            <Button variant="outline" size="sm" onClick={newChat} disabled={streaming}>
              <Plus className="h-3.5 w-3.5" />
              New chat
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={clearMessages}
              disabled={streaming || messages.length === 0}
              title="Clear messages in this session"
            >
              <Eraser className="h-3.5 w-3.5" />
              Clear
            </Button>
          </>
        }
      />

      <div className="relative flex min-h-0 flex-1 gap-3 md:gap-4">
        {/* Mobile session overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-scrim bg-[var(--scrim)] md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
        )}

        {/* Session sidebar */}
        <aside
          className={`shrink-0 flex-col border-[var(--border)] pr-3 transition-transform duration-200 ${
            sidebarOpen
              ? "fixed inset-y-0 left-0 z-overlay flex w-72 border-r bg-[var(--card)] p-4 shadow-xl md:static md:z-auto md:w-64 md:border-r md:bg-transparent md:p-0 md:shadow-none"
              : "hidden md:flex md:w-64 md:border-r"
          }`}
        >
          <div className="mb-2 flex items-center justify-between font-mono text-meta uppercase tracking-wide text-[var(--muted-foreground)]">
            <span className="flex items-center gap-1.5 font-semibold text-[var(--foreground)]">
              <MessageSquare className="h-3.5 w-3.5 text-[var(--primary-text)]" />
              Sessions ({sessions.length})
            </span>
            {sidebarOpen && (
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] md:hidden"
                aria-label="Close sidebar"
              >
                ✕
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {sessions.length === 0 ? (
              <p className="px-1 py-6 text-center text-body text-[var(--muted-foreground)]">
                No saved sessions yet. Send a message to start one.
              </p>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => void selectSession(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void selectSession(s.id);
                    }
                  }}
                  className={`group flex w-full cursor-pointer flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors ${
                    activeId === s.id
                      ? "border-[var(--primary)]/40 bg-[var(--muted)]/60"
                      : "border-transparent hover:bg-[var(--muted)]/40"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-lead font-medium text-[var(--foreground)]">
                      {s.title}
                    </span>
                    <button
                      type="button"
                      aria-label="Delete session"
                      title="Delete session"
                      className="ml-auto shrink-0 rounded p-0.5 text-[var(--muted-foreground)] opacity-0 transition-opacity hover:text-[var(--destructive-text)] focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeSession(s.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                  <span className="flex items-center gap-1.5 font-mono text-micro text-[var(--muted-foreground)]">
                    {s.model ? (
                      <span
                        className="max-w-[110px] truncate"
                        style={{ color: modelColor(s.model) }}
                      >
                        {s.model}
                      </span>
                    ) : null}
                    <span aria-hidden className="text-[var(--border)]">·</span>
                    <span>{s.messageCount} msg</span>
                    <span aria-hidden className="text-[var(--border)]">·</span>
                    <span>{timeAgo(s.updatedAt)}</span>
                  </span>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Chat column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] pb-2.5">
            <div className="w-full sm:w-auto sm:min-w-[200px] sm:flex-1">
              <ModelCombobox
                value={model}
                options={models}
                onChange={setModel}
                allowClear={false}
                placeholder="Select a model"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 font-mono text-meta text-[var(--muted-foreground)]">
                <Zap className="h-3.5 w-3.5 text-[var(--warning-text)]" />
                <span className="hidden sm:inline">Reasoning</span>
                <select
                  value={reasoningEffort}
                  onChange={(e) => setReasoningEffort(e.target.value)}
                  disabled={streaming}
                  className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 font-mono text-meta text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                  title="Reasoning effort"
                >
                  {REASONING_EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5 font-mono text-meta text-[var(--muted-foreground)]">
                <span className="hidden sm:inline">Max tokens</span>
                <input
                  type="number"
                  min={256}
                  max={65536}
                  step={256}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value) || DEFAULT_MAX_TOKENS)}
                  disabled={streaming}
                  className="w-20 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 font-mono text-meta text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                />
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSystem((v) => !v)}
                aria-expanded={showSystem}
                title="System prompt"
                className="h-7 px-2.5 text-xs"
              >
                <Settings2 className="h-3.5 w-3.5" />
                System
                <ChevronDown className={`h-3 w-3 transition-transform duration-150 ${showSystem ? "rotate-180" : ""}`} />
              </Button>
            </div>
          </div>
          {showSystem ? (
            <div className="border-b border-[var(--border)] py-3">
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value.slice(0, 32_000))}
                disabled={streaming}
                rows={3}
                placeholder="System prompt — applied to every turn in this session"
                className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-lead text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
              />
              <div className="mt-1 text-right font-mono text-micro text-[var(--muted-foreground)]">
                {systemPrompt.length.toLocaleString()} / 32,000
              </div>
            </div>
          ) : null}

          {activeModel?.thinking ? (
            <p className="pt-2 font-mono text-micro text-[var(--muted-foreground)]">
              reasoning-capable model — effort "{reasoningEffort}"
            </p>
          ) : null}

          {error ? (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 px-3 py-2 text-body text-[var(--destructive-text)]">
              <span className="flex-1 break-words">{error}</span>
              <button
                type="button"
                className="shrink-0 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                onClick={() => setError(null)}
              >
                ✕
              </button>
            </div>
          ) : null}

          {/* Messages */}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4"
          >
            {visible.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <Bot className="h-10 w-10 text-[var(--muted-foreground)]" />
                <p className="text-lead font-medium text-[var(--foreground)]">
                  {model ? "New chat — ready when you are" : "Model Studio playground"}
                </p>
                <p className="max-w-sm text-body text-[var(--muted-foreground)]">
                  {model ? (
                    <>Type below to start a fresh session. Nothing is sent until you hit Send.</>
                  ) : (
                    <>
                      Pick a model above, then send a message. Sends go through the exact same
                      dispatch pipeline as real{" "}
                      <code className="font-mono text-meta">/v1/chat/completions</code> traffic —
                      sanitization, compression, sticky routing and logging all apply.
                    </>
                  )}
                </p>
              </div>
            ) : (
              visible.map((message, index) => {
                const isDraft = (message as { role: string }).role === "assistant-draft";
                const role = isDraft ? "assistant" : (message as StudioMessage).role;
                const content = isDraft ? draft!.content : (message as StudioMessage).content;
                const reasoning = isDraft ? draft!.reasoning : (message as StudioMessage).reasoning;
                const usage = isDraft ? draft!.usage : (message as StudioMessage).usage;
                const firstMs = isDraft ? draft!.firstTokenMs : undefined;
                const isUser = role === "user";

                const itemKey = isDraft ? "assistant-draft" : `${(message as StudioMessage).role}-${(message as StudioMessage).ts || index}`;

                return (
                  <div
                    key={itemKey}
                    className={`flex gap-3 rounded-lg px-2 py-1 transition-colors sm:px-3 ${
                      isUser ? "bg-[var(--primary)]/[0.03]" : ""
                    }`}
                  >
                    <div
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
                        isUser
                          ? "border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary-text)]"
                          : "border-[var(--border)] bg-[var(--muted)]/60 text-[var(--muted-foreground)]"
                      }`}
                    >
                      {isUser ? <UserIcon className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center gap-2 font-mono text-micro uppercase tracking-wide text-[var(--muted-foreground)]">
                        <span className="font-semibold">{isUser ? "You" : "Assistant"}</span>
                        {isDraft ? (
                          <span className="flex items-center gap-1 text-[var(--primary-text)]">
                            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--primary)]" />
                            streaming
                          </span>
                        ) : null}
                        {firstMs !== undefined ? <span>{(firstMs / 1000).toFixed(2)}s ttft</span> : null}
                      </div>

                      {reasoning ? (
                        <details
                          {...(isDraft ? { open: true } : {})}
                          className="mb-2 rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-1.5"
                        >
                          <summary className="cursor-pointer font-mono text-micro uppercase tracking-wide text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                            Reasoning
                          </summary>
                          <div className="mt-1.5 whitespace-pre-wrap font-mono text-meta leading-relaxed text-[var(--muted-foreground)]">
                            {reasoning}
                          </div>
                        </details>
                      ) : null}

                      {isUser ? (
                        <div className="whitespace-pre-wrap break-words text-lead leading-relaxed text-[var(--foreground)]">
                          {content}
                        </div>
                      ) : content ? (
                        <div className="break-words">
                          <Markdown>{content}</Markdown>
                        </div>
                      ) : streaming && isDraft && !reasoning ? (
                        <span className="inline-flex items-center gap-1 py-1 text-[var(--muted-foreground)]">
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
                        </span>
                      ) : null}

                      {usage ? (
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-[var(--border)]/40 pt-1 font-mono text-micro text-[var(--muted-foreground)]">
                          <span>in {formatTokens(usage.inputTokens)}</span>
                          <span>out {formatTokens(usage.outputTokens)}</span>
                          {usage.reasoningTokens > 0 ? (
                            <span>reasoning {formatTokens(usage.reasoningTokens)}</span>
                          ) : null}
                          {usage.cachedTokens > 0 ? (
                            <span>cached {formatTokens(usage.cachedTokens)}</span>
                          ) : null}
                          <span className="text-[var(--primary-text)] font-medium">total {formatTokens(usage.totalTokens)}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-[var(--border)] pt-2.5">
            <div className="relative rounded-lg border border-[var(--border)] bg-[var(--background)] transition-colors focus-within:border-[var(--primary)] focus-within:ring-1 focus-within:ring-[var(--primary)]/30">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value.slice(0, MAX_INPUT_CHARS))}
                onKeyDown={onKeyDown}
                disabled={streaming}
                rows={2}
                placeholder={model ? `Message ${model}…  (Enter to send, Shift+Enter for newline)` : "Select a model first"}
                className="w-full resize-none bg-transparent px-3 py-2.5 pr-28 text-lead leading-relaxed text-[var(--foreground)] outline-none disabled:opacity-60"
              />
              <div className="absolute bottom-2 right-2 flex items-center gap-1">
                {streaming ? (
                  <Button variant="destructive" size="sm" onClick={stop} title="Stop generating" className="h-7 px-2.5 text-xs">
                    <Square className="h-3.5 w-3.5" />
                    <span className="hidden xs:inline">Stop</span>
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void regenerate()}
                      disabled={messages.length === 0 || messages[messages.length - 1].role !== "user"}
                      title="Regenerate the last answer"
                      className="h-7 w-7 p-0"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void send()}
                      disabled={!canSend}
                      title="Send"
                      className="h-7 px-2.5 text-xs font-medium"
                    >
                      <Send className="h-3.5 w-3.5" />
                      <span>Send</span>
                    </Button>
                  </>
                )}
              </div>
            </div>
            <div className="mt-1 flex justify-between font-mono text-micro text-[var(--muted-foreground)]">
              <span>{activeId ? `session ${activeId.slice(0, 8)}` : "unsaved session"}</span>
              <span>{input.length.toLocaleString()} / {MAX_INPUT_CHARS.toLocaleString()}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
