import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Chat } from "./components/Chat";
import { Inspector, type InspectorTab } from "./components/Inspector";
import { Sidebar } from "./components/Sidebar";
import {
  buildWireMessages,
  completeOnce,
  countTokens,
  fetchFile,
  fetchStatus,
  fetchTree,
  streamChat,
} from "./lib/api";
import {
  activeCompaction,
  canFold,
  compactionBriefText,
  compactionNetSavings,
  formatPct,
  formatTokens,
  measureContext,
  planFold,
  resolveBudget,
  shouldAutoCompact,
  unfoldedMessages,
  type ContextUsage,
} from "./lib/context";
import { modeById, reasonTag } from "./lib/modes";
import {
  foldPaysOff,
  foldedPromptCost,
  headPromptCost,
  localSummary,
  planContinuation,
  planResume,
  stitchContinuation,
  summaryRequest,
} from "./lib/summarize";
import {
  loadActiveId,
  loadSampling,
  loadSessions,
  loadSettings,
  saveActiveId,
  saveSampling,
  saveSessions,
  saveSettings,
  uid,
} from "./lib/storage";
import type {
  Attachment,
  ChatMessage,
  Compaction,
  FileNode,
  FinishInfo,
  ModeFamily,
  Sampling,
  ServerStatus,
  Session,
  Settings,
} from "./lib/types";
import { DEFAULT_SETTINGS } from "./lib/types";

function blankSession(modeId: string, family: ModeFamily): Session {
  const now = Date.now();
  return {
    id: uid(),
    title: "untitled",
    createdAt: now,
    updatedAt: now,
    modeId,
    family,
    messages: [],
    compactions: [],
  };
}

type Round = { body: string; reasoning: string; finish: FinishInfo };

/** Result of trying to fold the older half of a transcript. */
type FoldOutcome =
  | { ok: true; compaction: Compaction; tail: ChatMessage[] }
  | { ok: false; why: string };

const EMPTY_FINISH: FinishInfo = { reason: "", truncated: false };

/** Where the next text goes when a reply is resumed. */
export type ContinuePlan = {
  continueFinal: "content" | "reasoning_content" | null;
  directive?: string;
  fallbackDirective?: string;
};

export function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [sampling, setSampling] = useState<Sampling>(() => loadSampling());
  const [sessions, setSessions] = useState<Session[]>(() => {
    const loaded = loadSessions();
    return loaded.length ? loaded : [blankSession("coder", "reasoning")];
  });
  const [activeId, setActiveId] = useState(() => loadActiveId() || sessions[0]?.id);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("construct");
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [demoNotice, setDemoNotice] = useState(false);
  const [modeWarn, setModeWarn] = useState<string | null>(null);
  const [foldNotice, setFoldNotice] = useState<string | null>(null);
  const [folding, setFolding] = useState(false);
  const [exactTokens, setExactTokens] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const sessionsRef = useRef(sessions);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const session = useMemo(
    () => sessions.find((s) => s.id === activeId) || sessions[0],
    [sessions, activeId],
  );

  const currentSession = useCallback((): Session | undefined => {
    return sessionsRef.current.find((s) => s.id === activeId) ?? sessionsRef.current[0];
  }, [activeId]);

  useEffect(() => {
    saveSessions(sessions);
  }, [sessions]);
  useEffect(() => {
    if (session) saveActiveId(session.id);
  }, [session]);
  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveSampling(sampling), [sampling]);

  const refreshTree = useCallback(async () => {
    try {
      const t = await fetchTree();
      setTree(t.children || []);
    } catch {
      setTree([]);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await fetchStatus(settings));
    } catch {
      setStatus({
        ok: false,
        upstream: settings.llamaUrl,
        health: null,
        models: [],
        props: null,
        error: "could not reach /api/status or llama-server",
        workspace: "",
        via: "none",
      });
    }
  }, [settings]);

  useEffect(() => {
    void refreshTree();
    void refreshStatus();
    const id = window.setInterval(() => void refreshStatus(), 8000);
    return () => window.clearInterval(id);
  }, [refreshTree, refreshStatus]);

  /* ------------------------------------------------------------- sessions */

  const patchSession = (id: string, fn: (s: Session) => Session) => {
    setSessions((all) => all.map((s) => (s.id === id ? fn(s) : s)));
  };

  const patchMessage = (sessionId: string, messageId: string, fn: (m: ChatMessage) => ChatMessage) => {
    patchSession(sessionId, (s) => ({
      ...s,
      updatedAt: Date.now(),
      messages: s.messages.map((m) => (m.id === messageId ? fn(m) : m)),
    }));
  };

  const newSession = (modeId?: string, family?: ModeFamily) => {
    const s = blankSession(modeId || session?.modeId || "coder", family || session?.family || "reasoning");
    setSessions((all) => [s, ...all]);
    setActiveId(s.id);
    setDraft("");
    setAttachments([]);
    setDemoNotice(false);
    setModeWarn(null);
    setFoldNotice(null);
    setExactTokens(null);
  };

  const deleteSession = (id: string) => {
    setSessions((all) => {
      const next = all.filter((s) => s.id !== id);
      if (!next.length) {
        const s = blankSession("coder", "reasoning");
        setActiveId(s.id);
        return [s];
      }
      if (id === activeId) setActiveId(next[0].id);
      return next;
    });
  };

  const changeMode = (modeId: string) => {
    if (!session) return;
    if (session.messages.length > 0) {
      setModeWarn(
        `Turbo Brilliance wants a new chat when you switch constructs (${session.modeId} → ${modeId}).`,
      );
    }
    const family: ModeFamily =
      session.family === "xhigh" && !modeById(modeId).xhigh && modeId !== "help"
        ? "reasoning"
        : session.family;
    patchSession(session.id, (s) => ({ ...s, modeId, family, updatedAt: Date.now() }));
  };

  const changeFamily = (family: ModeFamily) => {
    if (!session) return;
    if (session.messages.length > 0) {
      setModeWarn("New chat recommended when switching reason / instruct / xhigh.");
    }
    patchSession(session.id, (s) => ({ ...s, family, updatedAt: Date.now() }));
    if (family === "instruct") {
      setSampling((x) => ({ ...x, enable_thinking: false }));
    } else if (family === "reasoning" || family === "xhigh") {
      setSampling((x) => ({ ...x, enable_thinking: true, reasoning_effort: family === "xhigh" ? "xhigh" : x.reasoning_effort }));
    }
  };

  const toggleFile = async (node: FileNode) => {
    if (node.type !== "file") return;
    setAttachments((cur) => {
      if (cur.some((a) => a.path === node.path)) return cur.filter((a) => a.path !== node.path);
      return cur;
    });
    if (attachments.some((a) => a.path === node.path)) return;
    try {
      const file = await fetchFile(node.path);
      setAttachments((cur) =>
        cur.some((a) => a.path === node.path)
          ? cur
          : [...cur, { path: file.path, content: file.content, source: "workspace" }],
      );
    } catch (err) {
      setPreview({
        path: node.path,
        content: err instanceof Error ? err.message : "could not read",
      });
    }
  };

  const previewFile = async (node: FileNode) => {
    if (node.type !== "file") return;
    try {
      const file = await fetchFile(node.path);
      setPreview(file);
    } catch (err) {
      setPreview({
        path: node.path,
        content: err instanceof Error ? err.message : "could not read",
      });
    }
  };

  const onFiles = async (list: FileList | File[]) => {
    const files = Array.from(list);
    const next: Attachment[] = [];
    for (const f of files) {
      if (f.size > 800_000) continue;
      const content = await f.text();
      next.push({ path: f.name, content, source: "upload" });
    }
    setAttachments((cur) => {
      const map = new Map(cur.map((a) => [a.path, a]));
      for (const n of next) map.set(n.path, n);
      return [...map.values()];
    });
  };

  /* -------------------------------------------------------------- context */

  const carry = useMemo(
    () => activeCompaction({ compactions: session?.compactions ?? [] }),
    [session],
  );
  const liveMessages = useMemo(
    () => (session ? unfoldedMessages(session.messages, carry) : []),
    [session, carry],
  );
  const briefTexts = useMemo(() => (carry ? [compactionBriefText(carry)] : []), [carry]);

  const usage = useMemo<ContextUsage>(
    () =>
      measureContext({
        messages: liveMessages,
        summaries: briefTexts,
        settings,
        sampling,
        props: status?.props ?? null,
        foldedMessages: session ? session.messages.length - liveMessages.length : 0,
      }),
    [liveMessages, briefTexts, settings, sampling, status?.props, session],
  );

  /** Rewrite the older half of `base` into one handoff brief. */
  const foldWindow = useCallback(
    async (
      target: Session,
      base: ChatMessage[],
      opts: { auto: boolean },
    ): Promise<FoldOutcome> => {
      const plan = planFold(base, settings.keepTailMessages);
      if (!plan) {
        return { ok: false, why: "the transcript is still one turn — nothing to fold" };
      }
      const previous = activeCompaction(target);
      setFolding(true);
      let summary = "";
      let source: "model" | "local" = "local";
      let model: string | undefined;
      try {
        const budget = resolveBudget(settings, sampling, status?.props ?? null);
        const out = await completeOnce(
          summaryRequest(plan.head, previous?.summary, budget.nCtx, settings.summaryMaxTokens),
          settings,
          { maxTokens: settings.summaryMaxTokens },
        );
        if (out?.content.trim()) {
          summary = out.content.trim();
          source = "model";
          model = out.model;
        }
      } catch {
        /* offline or refused — the local extract takes over below */
      }
      if (!summary) {
        summary = localSummary(plan.head, previous?.summary);
        source = "local";
      }
      const tokensBefore = headPromptCost(plan.head);
      const tokensAfter = foldedPromptCost(summary);
      if (!foldPaysOff(tokensBefore, tokensAfter)) {
        setFolding(false);
        return {
          ok: false,
          why: `the brief would cost more than the ${plan.head.length} messages it replaces (${formatTokens(
            tokensBefore,
          )} → ${formatTokens(tokensAfter)})`,
        };
      }
      const compaction: Compaction = {
        id: uid(),
        at: Date.now(),
        upToId: plan.boundaryId,
        foldedMessages: plan.head.length,
        summary,
        tokensBefore,
        tokensAfter,
        auto: opts.auto,
        source,
        model,
      };
      patchSession(target.id, (s) => ({
        ...s,
        compactions: [...(s.compactions ?? []), compaction],
        updatedAt: Date.now(),
      }));
      setFolding(false);
      return { ok: true, compaction, tail: plan.tail };
    },
    [settings, sampling, status?.props],
  );

  const foldNow = useCallback(async () => {
    const target = currentSession();
    if (!target || sendingRef.current || folding) return;
    const base = unfoldedMessages(target.messages, activeCompaction(target));
    const out = await foldWindow(target, base, { auto: false });
    if (!out.ok) {
      setFoldNotice(`Nothing folded: ${out.why}.`);
      return;
    }
    setFoldNotice(
      `Folded ${out.compaction.foldedMessages} messages into a ${
        out.compaction.source === "model" ? "model-written" : "local"
      } brief: ${formatTokens(out.compaction.tokensBefore)} → ${formatTokens(
        out.compaction.tokensAfter,
      )} tokens (−${formatTokens(compactionNetSavings(out.compaction))}).`,
    );
  }, [currentSession, folding, foldWindow]);

  const unfold = useCallback(
    (index: number) => {
      const target = currentSession();
      if (!target) return;
      patchSession(target.id, (s) => ({
        ...s,
        compactions: (s.compactions ?? []).slice(0, index),
        updatedAt: Date.now(),
      }));
      setFoldNotice("Fold removed — the full transcript is back in the window.");
    },
    [currentSession],
  );

  const measureExact = useCallback(async () => {
    const target = currentSession();
    if (!target) return;
    const c = activeCompaction(target);
    const wire = buildWireMessages(unfoldedMessages(target.messages, c), settings, {
      systemExtra: c ? [compactionBriefText(c)] : [],
    });
    const n = await countTokens(wire.map((m) => `${m.role}: ${m.content}`).join("\n"), settings);
    setExactTokens(n);
    if (n === null) setFoldNotice("llama-server /tokenize is not answering — the estimate stands.");
  }, [currentSession, settings]);

  /* ---------------------------------------------------------- streaming */

  const runRound = async (args: {
    sessionId: string;
    messageId: string;
    wire: ChatMessage[];
    systemExtra: string[];
    ctrl: AbortController;
    acc: { body: string; reasoning: string };
    start: { body: string; reasoning: string };
    continueFinal: "content" | "reasoning_content" | null;
    directive?: string;
    fallbackDirective?: string;
  }): Promise<Round> => {
    const { acc, start } = args;
    const resuming = Boolean(start.body || start.reasoning);
    let freshBody = "";
    let freshReasoning = "";
    let finish: FinishInfo = { ...EMPTY_FINISH };

    const settle = () =>
      resuming
        ? {
            body: stitchContinuation(start.body, freshBody),
            reasoning: stitchContinuation(start.reasoning, freshReasoning),
          }
        : { body: freshBody, reasoning: freshReasoning };

    const attempt = async (continueFinal: "content" | "reasoning_content" | null, directive?: string) => {
      const result = await streamChat(
        args.wire,
        sampling,
        settings,
        {
          onReasoning: (c) => {
            freshReasoning += c;
            const s = settle();
            acc.body = s.body;
            acc.reasoning = s.reasoning;
            patchMessage(args.sessionId, args.messageId, (m) => ({ ...m, reasoning: s.reasoning }));
          },
          onContent: (c) => {
            freshBody += c;
            const s = settle();
            acc.body = s.body;
            acc.reasoning = s.reasoning;
            patchMessage(args.sessionId, args.messageId, (m) => ({ ...m, content: s.body }));
          },
          onTimings: (t, extra) => {
            patchMessage(args.sessionId, args.messageId, (m) => ({ ...m, timings: t, demo: extra?.demo }));
            if (extra?.demo) setDemoNotice(true);
          },
          onFinish: (f) => {
            finish = f;
          },
        },
        args.ctrl.signal,
        { systemExtra: args.systemExtra, continueFinal, directive },
      );
      if (result.demo) setDemoNotice(true);
      return result.finish;
    };

    try {
      finish = (await attempt(args.continueFinal, args.directive)) || finish;
    } catch (err) {
      const untouched = acc.body === start.body && acc.reasoning === start.reasoning;
      if (args.fallbackDirective && untouched && !args.ctrl.signal.aborted && settings.continueMode === "auto") {
        // the prefill path was refused before a single token — resume by directive instead
        finish = (await attempt(null, args.fallbackDirective)) || finish;
      } else {
        throw err;
      }
    }

    const s = settle();
    acc.body = s.body;
    acc.reasoning = s.reasoning;
    patchMessage(args.sessionId, args.messageId, (m) => ({
      ...m,
      content: s.body,
      reasoning: s.reasoning,
      finishReason: finish.reason || m.finishReason,
      truncated: finish.truncated,
    }));
    return { body: s.body, reasoning: s.reasoning, finish };
  };

  /**
   * One round plus the automatic continuations a truncated reply earns.
   * `wireBefore` is everything that precedes the assistant message being written.
   */
  const runReply = async (args: {
    sessionId: string;
    messageId: string;
    wireBefore: ChatMessage[];
    systemExtra: string[];
    ctrl: AbortController;
    acc: { body: string; reasoning: string };
    first: ContinuePlan;
    allowAuto: boolean;
    resuming: boolean;
  }): Promise<Round> => {
    const { acc } = args;
    const assistantMessage = (content: string) =>
      ({ id: args.messageId, role: "assistant" as const, content });
    const firstWire = args.resuming
      ? [...args.wireBefore, assistantMessage(acc.body)]
      : args.wireBefore;

    let round = await runRound({
      sessionId: args.sessionId,
      messageId: args.messageId,
      wire: firstWire,
      systemExtra: args.systemExtra,
      ctrl: args.ctrl,
      acc,
      start: { body: acc.body, reasoning: acc.reasoning },
      continueFinal: args.first.continueFinal,
      directive: args.first.directive,
      fallbackDirective: args.first.fallbackDirective,
    });

    let continues = 0;
    for (;;) {
      const step = planContinuation({
        truncated: round.finish.truncated,
        body: round.body,
        reasoning: round.reasoning,
        roundsDone: continues,
        allowAuto: args.allowAuto,
        settings,
      });
      if (!step.proceed || args.ctrl.signal.aborted) break;
      continues++;
      round = await runRound({
        sessionId: args.sessionId,
        messageId: args.messageId,
        wire: [...args.wireBefore, assistantMessage(round.body)],
        systemExtra: args.systemExtra,
        ctrl: args.ctrl,
        acc,
        start: { body: round.body, reasoning: round.reasoning },
        continueFinal: step.continueFinal,
        directive: step.directive,
        fallbackDirective: step.fallbackDirective,
      });
      patchMessage(args.sessionId, args.messageId, (m) => ({ ...m, continues }));
    }
    return round;
  };

  /** Fold if the window is about to overflow; return the window to send. */
  const prepareWindow = async (target: Session, history: ChatMessage[], incoming: ChatMessage[]) => {
    const previous = activeCompaction(target);
    let wire = unfoldedMessages(history, previous);
    let systemExtra = previous ? [compactionBriefText(previous)] : [];
    const probe = measureContext({
      messages: [...wire, ...incoming],
      summaries: systemExtra,
      settings,
      sampling,
      props: status?.props ?? null,
    });
    const trigger = shouldAutoCompact(probe, settings, canFold(wire, settings));
    if (trigger.fold) {
      const out = await foldWindow(target, wire, { auto: true });
      if (out.ok) {
        wire = out.tail;
        systemExtra = [compactionBriefText(out.compaction)];
        setFoldNotice(
          `Context was at ${formatPct(trigger.pct)} — folded ${out.compaction.foldedMessages} messages into a ${
            out.compaction.source === "model" ? "model-written" : "local"
          } brief (−${formatTokens(compactionNetSavings(out.compaction))} tokens), then sent.`,
        );
      } else {
        setFoldNotice(`Context at ${formatPct(trigger.pct)}, not folded: ${out.why}.`);
      }
    } else if (probe.pct >= settings.compactAt) {
      setFoldNotice(`Window at ${formatPct(probe.pct)}: ${trigger.reason}.`);
    } else {
      setFoldNotice(null);
    }
    return { wire, systemExtra };
  };

  const send = async (text?: string, regen = false) => {
    const target = currentSession();
    if (!target) return;
    const raw = (text ?? draft).trim();
    if (!raw && attachments.length === 0 && !regen) return;
    const ctrl = new AbortController();
    const prev = abortRef.current;
    abortRef.current = ctrl;
    sendingRef.current = true;
    prev?.abort();

    let history = target.messages;
    if (regen) {
      const lastUser = [...history].reverse().find((m) => m.role === "user");
      const cut = lastUser ? history.lastIndexOf(lastUser) : -1;
      history = cut >= 0 ? history.slice(0, cut + 1) : history.filter((m) => m.role !== "assistant");
    }

    const tag = reasonTag(target.family, target.modeId);
    let content = raw;
    if (!regen) {
      if (sampling.inject_mode_tag && !/\{REASON:/i.test(content)) {
        content = `${tag} ${content}`.trim();
      }
    }

    const userMsg: ChatMessage | null = regen
      ? null
      : {
          id: uid(),
          role: "user",
          content,
          attachments: attachments.length ? attachments : undefined,
          modeTag: tag,
        };

    setStreamingId(null);
    setDemoNotice(false);

    let wire = unfoldedMessages(history, activeCompaction(target));
    let systemExtra: string[] = [];
    try {
      const prepared = await prepareWindow(target, history, userMsg ? [userMsg] : []);
      wire = prepared.wire;
      systemExtra = prepared.systemExtra;
    } catch (err) {
      setFoldNotice(`Could not fold the context: ${err instanceof Error ? err.message : String(err)}`);
    }

    const asst: ChatMessage = { id: uid(), role: "assistant", content: "", reasoning: "" };
    const titleSource = content || userMsg?.content || target.title;

    patchSession(target.id, (s) => ({
      ...s,
      title:
        s.title === "untitled"
          ? titleSource.replace(/\{REASON:[^}]+\}/g, "").trim().slice(0, 48) || "untitled"
          : s.title,
      // folded messages stay in the transcript so a fold can be undone
      messages: regen ? [...history, asst] : [...s.messages, userMsg!, asst],
      updatedAt: Date.now(),
    }));
    if (!regen) {
      setDraft("");
    }
    setStreamingId(asst.id);

    const acc = { body: "", reasoning: "" };
    try {
      await runReply({
        sessionId: target.id,
        messageId: asst.id,
        wireBefore: regen ? wire : [...wire, userMsg!],
        systemExtra,
        ctrl,
        acc,
        first: { continueFinal: null },
        allowAuto: true,
        resuming: false,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        /* stopped */
      } else {
        const message = err instanceof Error ? err.message : String(err);
        patchMessage(target.id, asst.id, (m) => ({
          ...m,
          error: message,
          content: acc.body || m.content,
        }));
      }
    } finally {
      if (abortRef.current === ctrl) {
        sendingRef.current = false;
        setStreamingId(null);
      }
    }
  };

  /** Resume a reply that was cut off (or stopped early) mid-answer. */
  const continueMessage = async (messageId?: string) => {
    const target = currentSession();
    if (!target || sendingRef.current) return;
    const messages = target.messages;
    let idx = messageId ? messages.findIndex((m) => m.id === messageId) : -1;
    if (idx < 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) return;
    const anchor = messages[idx];
    if (!anchor.content.trim() && !anchor.reasoning?.trim()) return;

    if (messages.length > idx + 1) {
      // resuming an older reply means the session forks here: keep the tail out of the way
      const dropped = messages.length - (idx + 1);
      const keepIds = new Set(messages.slice(0, idx + 1).map((m) => m.id));
      patchSession(target.id, (s) => ({
        ...s,
        messages: s.messages.slice(0, idx + 1),
        compactions: (s.compactions ?? []).filter((c) => keepIds.has(c.upToId)),
        updatedAt: Date.now(),
      }));
      setFoldNotice(
        `Continuing an earlier reply dropped ${dropped} later message${dropped === 1 ? "" : "s"} so the model can resume the right turn.`,
      );
    }

    const ctrl = new AbortController();
    const prev = abortRef.current;
    abortRef.current = ctrl;
    sendingRef.current = true;
    prev?.abort();
    setDemoNotice(false);

    let wire = unfoldedMessages(messages.slice(0, idx), activeCompaction(target));
    let systemExtra: string[] = [];
    try {
      const prepared = await prepareWindow(target, messages.slice(0, idx), [
        { ...anchor, role: "assistant" },
      ]);
      wire = prepared.wire;
      systemExtra = prepared.systemExtra;
    } catch (err) {
      setFoldNotice(`Could not fold the context: ${err instanceof Error ? err.message : String(err)}`);
    }

    const acc = { body: anchor.content, reasoning: anchor.reasoning ?? "" };
    const step = planResume({
      body: anchor.content,
      reasoning: anchor.reasoning ?? "",
      continueMode: settings.continueMode,
    });

    setStreamingId(anchor.id);
    try {
      await runReply({
        sessionId: target.id,
        messageId: anchor.id,
        wireBefore: wire,
        systemExtra,
        ctrl,
        acc,
        first: step,
        allowAuto: true,
        resuming: true,
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const message = err instanceof Error ? err.message : String(err);
        patchMessage(target.id, anchor.id, (m) => ({ ...m, error: message }));
      }
    } finally {
      if (abortRef.current === ctrl) {
        sendingRef.current = false;
        setStreamingId(null);
      }
    }
  };

  const stop = () => abortRef.current?.abort();

  const askHelp = () => {
    if (!session) return;
    const tag =
      session.family === "instruct"
        ? "{REASON:ihelp}"
        : session.family === "xhigh"
          ? "{REASON:xhelp}"
          : "{REASON:help}";
    void send(
      `${tag} I am using the Q38 coder workbench with construct ${session.modeId}. Show the detailed help menu, then recommend the best mode sequence for software engineering work.`,
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newSession();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  if (!session) return null;
  const modelName =
    status?.models[0]?.id?.split(/[/\\]/).pop() ||
    "Qwen3.8-27B Turbo-Brilliance NEO MAX MTP";

  return (
    <div className="shell">
      <header className="topbar">
        <button type="button" className="icon-btn rail-toggle" onClick={() => setLeftOpen((v) => !v)}>
          files
        </button>
        <div className="brand">
          <span className="wordmark">Q38</span>
          <div className="brand-meta">
            <div className="brand-title">Turbo Brilliance</div>
            <div className="brand-sub">coder workbench · NEO MAX MTP</div>
          </div>
        </div>
        <div className="model-chip" title={modelName}>
          {modelName}
        </div>
        <span className="grow" />
        <button
          type="button"
          className={`ctx-pill ${usage.pct >= settings.compactAt ? "hot" : ""} ${folding ? "busy" : ""}`}
          style={{ "--fill": `${Math.min(100, usage.pct * 100).toFixed(1)}%` } as CSSProperties}
          title={`${formatTokens(usage.used)} / ${formatTokens(usage.budget.budget)} prompt tokens · window ${formatTokens(
            usage.budget.nCtx,
          )} (${usage.budget.source})`}
          onClick={() => {
            setRightOpen(true);
            setInspectorTab("context");
          }}
        >
          <span>{folding ? "folding" : formatPct(usage.pct)}</span>
          <i />
        </button>
        <StatusPill status={status} />
        <button type="button" className="icon-btn" onClick={() => newSession()}>
          new chat
        </button>
        <button type="button" className="icon-btn" onClick={() => setSettingsOpen(true)}>
          setup
        </button>
        <button type="button" className="icon-btn rail-toggle" onClick={() => setRightOpen((v) => !v)}>
          construct
        </button>
      </header>

      {status?.via === "direct" && (
        <div className="banner warn">
          <span>
            Static host has no /api proxy (that 304 on /api/status is index.html). Talking to{" "}
            {status.upstream} directly. Prefer <code>npm start</code> after <code>npm run build</code>
            — not <code>npx serve</code> / <code>dotnet serve</code>.
          </span>
        </div>
      )}
      {status?.via === "none" && status?.error && (
        <div className="banner warn">
          <span>{status.error}</span>
        </div>
      )}

      {modeWarn && (
        <div className="banner warn">
          <span>{modeWarn}</span>
          <button type="button" className="icon-btn" onClick={() => { newSession(session.modeId, session.family); }}>
            start new chat
          </button>
          <button type="button" className="icon-btn" onClick={() => setModeWarn(null)}>
            dismiss
          </button>
        </div>
      )}

      {foldNotice && (
        <div className="banner fold">
          <span>{foldNotice}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              setRightOpen(true);
              setInspectorTab("context");
            }}
          >
            context
          </button>
          <button type="button" className="icon-btn" onClick={() => setFoldNotice(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="workspace">
        {leftOpen && (
          <Sidebar
            sessions={sessions}
            activeId={session.id}
            onSelect={(id) => {
              setActiveId(id);
              setDemoNotice(false);
              setModeWarn(null);
              setFoldNotice(null);
              setExactTokens(null);
            }}
            onNew={() => newSession()}
            onDelete={deleteSession}
            tree={tree}
            attachments={attachments}
            onToggleFile={toggleFile}
            onPreviewFile={previewFile}
            onFiles={onFiles}
          />
        )}
        <Chat
          session={session}
          family={session.family}
          streamingId={streamingId}
          attachments={attachments}
          onDetach={(p) => setAttachments((a) => a.filter((x) => x.path !== p))}
          draft={draft}
          setDraft={setDraft}
          onSend={() => void send()}
          onStop={stop}
          onRegen={() => void send(undefined, true)}
          onStarter={(t) => {
            setDraft(t);
          }}
          onContinue={(id) => void continueMessage(id)}
          onFold={() => void foldNow()}
          onUnfold={unfold}
          folding={folding}
          usage={usage}
          compactAt={settings.compactAt}
          autoCompact={settings.autoCompact}
          demoNotice={demoNotice}
        />
        {rightOpen && (
          <Inspector
            tab={inspectorTab}
            onTab={setInspectorTab}
            modeId={session.modeId}
            family={session.family}
            onMode={changeMode}
            onFamily={changeFamily}
            sampling={sampling}
            onSampling={setSampling}
            settings={settings}
            onSettings={setSettings}
            status={status}
            preview={preview}
            onAskHelp={askHelp}
            usage={usage}
            compactions={session.compactions ?? []}
            exactTokens={exactTokens}
            onMeasure={() => void measureExact()}
            onFold={() => void foldNow()}
            onUnfold={unfold}
            folding={folding}
            streaming={Boolean(streamingId)}
          />
        )}
      </div>

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
          onPing={() => void refreshStatus()}
        />
      )}
    </div>
  );
}

function StatusPill({ status }: { status: ServerStatus | null }) {
  const ok = !!status?.ok;
  const label = ok
    ? status?.via === "direct"
      ? "llama-server · direct"
      : "llama-server"
    : "offline";
  return (
    <div className={`status ${ok ? "ok" : "down"}`}>
      <i />
      {label}
    </div>
  );
}

function SettingsModal({
  settings,
  onChange,
  onClose,
  onPing,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  onPing: () => void;
}) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Setup</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            close
          </button>
        </header>
        <label className="field">
          <span>llama-server URL</span>
          <input
            value={settings.llamaUrl}
            onChange={(e) => onChange({ ...settings, llamaUrl: e.target.value })}
            placeholder="http://127.0.0.1:8080"
          />
        </label>
        <label className="field">
          <span>API key (if --api-key)</span>
          <input
            value={settings.apiKey}
            onChange={(e) => onChange({ ...settings, apiKey: e.target.value })}
            placeholder="optional"
          />
        </label>
        <label className="field">
          <span>context window (tokens · 0 = read n_ctx from /props)</span>
          <input
            type="number"
            min={0}
            step={1024}
            value={settings.contextSize}
            onChange={(e) =>
              onChange({ ...settings, contextSize: Math.max(0, Number(e.target.value) || 0) })
            }
            placeholder="0"
          />
        </label>
        <label className="field">
          <span>system prompt</span>
          <textarea
            rows={8}
            value={settings.systemPrompt}
            onChange={(e) => onChange({ ...settings, systemPrompt: e.target.value })}
          />
        </label>
        <div className="modal-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => onChange({ ...DEFAULT_SETTINGS, llamaUrl: settings.llamaUrl, apiKey: settings.apiKey })}
          >
            reset prompt
          </button>
          <span className="grow" />
          <button type="button" className="btn" onClick={onPing}>
            ping server
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            done
          </button>
        </div>
      </div>
    </div>
  );
}
