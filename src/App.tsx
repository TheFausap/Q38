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
  uploadWorkspaceFile,
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
  DEFAULT_PACING,
  loadPaceStats,
  planJobTick,
  savePaceStats,
  updateBaseline,
  type JobTick,
  type PaceStats,
} from "./lib/pacing";
import { JobPip, type PacingView } from "./components/Punchcard";
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
  PromptProgress,
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

/** Longest drop that may be written into ./workspace (mirrors server/api.mjs). */
const DROP_MAX_BYTES = 8 * 1024 * 1024;
/** Above this the file is saved but too big to pin as context (server read cap). */
const PIN_MAX_BYTES = 800_000;

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A turn in flight, as the console sees it: when it was sent, what the server
 * has reported since, and how the machine is behaving.
 */
type Job = {
  no: number;
  startedAt: number;
  idleBefore: number;
  cold: boolean;
  loadingAt: number | null;
  queuedAckAt: number | null;
  progress: PromptProgress | null;
  firstTokenAt: number | null;
  lastTokenAt: number | null;
  /** rolling decode samples for the live rate */
  samples: { at: number; tokens: number }[];
  tokens: number;
  chars: number;
  /** decode rate as last measured from the stream */
  rate: number | null;
  /** the server's own predicted_per_second for the round */
  finalRate: number | null;
};

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
  const [dragging, setDragging] = useState(false);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [tick, setTick] = useState(0);
  const [pace, setPace] = useState<PaceStats>(() => loadPaceStats());
  const [lastTick, setLastTick] = useState<JobTick | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const sessionsRef = useRef(sessions);
  const jobRef = useRef<Job | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const jobNoRef = useRef<number>(0);
  const pagedRef = useRef(false);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    jobRef.current = job;
  }, [job]);

  useEffect(() => {
    savePaceStats(pace);
  }, [pace]);

  /* While a turn is in flight, tick the console four times a second: the clock,
     the stall detector and the sliding-window rate all move without a token. */
  useEffect(() => {
    if (!job) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, [job]);

  const serverLoading = status?.loading === true;

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

  /* ---------------------------------------------------- job console state */

  const jobInput = useCallback(
    (j: Job | null) => {
      if (!j) return null;
      return {
        startedAt: j.startedAt,
        firstTokenAt: j.firstTokenAt,
        lastTokenAt: j.lastTokenAt,
        tokens: j.tokens,
        samples: j.samples,
        progress: j.progress,
        // the server only says "loading" while it has not started reading yet
        serverLoading: serverLoading && j.progress == null && j.firstTokenAt == null,
      };
    },
    [serverLoading],
  );

  /** The console's verdict on the job in flight, recomputed on every tick. */
  const pacingView: PacingView | null = useMemo(() => {
    const j = job;
    const input = jobInput(j);
    if (!j || !input) return null;
    const now = Date.now();
    const t = planJobTick(input, now, {
      // always the *warm* baseline: comparing a round against its own rate
      // would call every round healthy, however slow the machine had gone
      baseline: pace.baseline,
      pagingFactor: settings.pagingFactor,
      stallSeconds: DEFAULT_PACING.stallSeconds,
      queuedGraceSeconds: DEFAULT_PACING.queuedGraceSeconds,
    });
    return {
      phase: t.phase,
      why: t.why,
      jobNo: j.no,
      startedAt: j.startedAt,
      elapsedMs: t.elapsedMs,
      stalledMs: t.stalledMs,
      progress: j.progress,
      progressSeen: j.progress != null,
      ttfMs: t.ttfMs,
      rate: t.rate,
      baseline: pace.baseline,
      tokens: t.tokens,
      cold: j.cold,
      loadingMs: j.loadingAt != null ? now - j.loadingAt : null,
      queuedMs: j.queuedAckAt ?? 0,
    };
    // `tick` is the clock that moves this view forward between tokens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, tick, pace.baseline, settings.pagingFactor, jobInput]);

  /* One source of truth: the same verdict feeds the console, the top-bar pip
     and the pacing stats. The ticker latches "this job paged" for the session. */
  useEffect(() => {
    if (!pacingView) {
      setLastTick(null);
      return;
    }
    if (pacingView.phase === "paging") pagedRef.current = true;
    setLastTick({
      phase: pacingView.phase,
      why: pacingView.why,
      elapsedMs: pacingView.elapsedMs,
      stalledMs: pacingView.stalledMs,
      rate: pacingView.rate,
      ttfMs: pacingView.ttfMs,
      tokens: pacingView.tokens,
    });
  }, [pacingView]);

  /** Start of every turn: stamp the job so the console has something to say. */
  const beginJob = useCallback(() => {
    const idleBefore = Date.now() - lastActivityRef.current;
    jobNoRef.current += 1;
    pagedRef.current = false;
    const next: Job = {
      no: jobNoRef.current,
      startedAt: Date.now(),
      idleBefore,
      cold: idleBefore > settings.coldStartSeconds * 1000 || serverLoading,
      loadingAt: serverLoading ? Date.now() : null,
      queuedAckAt: null,
      progress: null,
      firstTokenAt: null,
      lastTokenAt: null,
      samples: [],
      tokens: 0,
      chars: 0,
      rate: null,
      finalRate: null,
    };
    jobRef.current = next;
    setJob(next);
    return next;
  }, [settings.coldStartSeconds, serverLoading]);

  /** Fold a stream event into the job without re-rendering per character. */
  const patchJob = useCallback((fn: (j: Job) => Job) => {
    const current = jobRef.current;
    if (!current) return;
    const next = fn(current);
    jobRef.current = next;
    setJob(next);
  }, []);

  const endJob = useCallback(() => {
    const j = jobRef.current;
    lastActivityRef.current = Date.now();
    if (j) {
      const paged = pagedRef.current;
      const ttfMs = j.firstTokenAt != null ? Math.max(0, j.firstTokenAt - j.startedAt) : null;
      setPace((prev) => ({
        ...prev,
        // only a round that actually decoded teaches us anything about speed
        baseline: updateBaseline(prev.baseline, j.finalRate ?? j.rate ?? 0),
        lastTtfMs: ttfMs,
        lastRate: j.finalRate ?? j.rate,
        jobs: prev.jobs + 1,
        pagedJobs: prev.pagedJobs + (paged ? 1 : 0),
      }));
    }
    setJob(null);
    setTick(0);
  }, []);

  const noteToken = useCallback(
    (chars: number) => {
      patchJob((j) => {
        const now = Date.now();
        const tokens = Math.max(j.tokens, Math.round((j.chars + chars) / 3.6));
        const samples = [...j.samples, { at: now, tokens }].filter((x) => now - x.at < 20_000);
        const recent = samples.length > 24 ? samples.slice(-24) : samples;
        return {
          ...j,
          chars: j.chars + chars,
          tokens,
          samples: recent,
          firstTokenAt: j.firstTokenAt ?? now,
          lastTokenAt: now,
        };
      });
    },
    [patchJob],
  );

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

  /**
   * A drop does two things: the file is saved into ./workspace (which is what
   * the tree right below the dropzone promises), and — when it is small enough
   * to read as context — pinned to the next turn. Every file gets a line in
   * the notice, including the ones that were refused, so a drop is never
   * silent.
   */
  const onFiles = useCallback(
    async (list: FileList | File[]) => {
      const files = Array.from(list);
      if (files.length === 0) return;
      const next: Attachment[] = [];
      const notes: string[] = [];
      let failed = 0;

      for (const f of files) {
        if (f.size > DROP_MAX_BYTES) {
          notes.push(`${f.name} — ${humanBytes(f.size)}, over the ${humanBytes(DROP_MAX_BYTES)} limit`);
          failed += 1;
          continue;
        }
        let content: string;
        try {
          content = await f.text();
        } catch {
          notes.push(`${f.name} — could not be read`);
          failed += 1;
          continue;
        }
        let target = f.name;
        let stored = false;
        try {
          const saved = await uploadWorkspaceFile(f.name, content);
          target = saved.path;
          stored = true;
          notes.push(`${saved.path} → saved to ./workspace${saved.renamed ? " (name was taken)" : ""}`);
        } catch (err) {
          // the workspace write needs the middleware: without it, pin anyway
          notes.push(
            `${f.name} — not saved (${err instanceof Error ? err.message : "workspace unreachable"})`,
          );
        }
        if (f.size > PIN_MAX_BYTES) {
          notes.push(`${target} is ${humanBytes(f.size)} — too big to pin as context`);
        } else {
          next.push({ path: target, content, source: "upload" });
          if (!stored) notes.push(`${target} is pinned to this turn only`);
        }
      }

      if (next.length) {
        setAttachments((cur) => {
          const map = new Map(cur.map((a) => [a.path, a]));
          for (const n of next) map.set(n.path, n);
          return [...map.values()];
        });
      }
      const pinned = next.length
        ? `pinned ${next.length} file${next.length > 1 ? "s" : ""} as context`
        : "";
      setDropNotice(
        [pinned, ...notes].filter(Boolean).join(" · ") ||
          (failed ? "nothing could be taken from that drop" : ""),
      );
      void refreshTree();
    },
    [refreshTree],
  );

  /* A drop anywhere in the window is ours: the dashed box is a hint, not the
     only target, and the browser must never get the file (it would navigate
     away from the workbench, which is what "nothing happens" looked like).
     `dragenter` has to be cancelled as well as `dragover` — a browser will not
     fire `drop` for a target that only cancels one of them. */
  useEffect(() => {
    /**
     * Is this drag carrying files? Browsers are not consistent about it, and a
     * drag that crosses an origin boundary (the workbench is framed) may report
     * no types at all until the drop. An unidentified drag is therefore treated
     * as a possible file drag: refusing it would mean the browser never offers
     * the drop and the file goes nowhere. Anything that identifies itself as
     * something else — dragging text around the page, say — is left alone.
     */
    const isFileDrag = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt) return false;
      if (dt.files && dt.files.length > 0) return true; // populated on drop
      const types = Array.from(dt.types || []).map((t) => String(t).toLowerCase());
      if (import.meta.env.DEV && types.length) {
        console.debug("[q38] drag types:", types.join(", "));
      }
      if (types.length === 0) return true; // unknown provenance: do not refuse it
      return types.some(
        (t) => t === "files" || t === "application/x-moz-file" || t === "application/x-webkit-file",
      );
    };

    const onDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    };
    /* dragover fires continuously: cancel it so the pointer keeps showing a
       copy cursor, and hold the hint up while it does */
    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      // leaving the window, not just an element inside it
      if (!e.relatedTarget) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      // take the drop even if the drag never announced itself as files
      if (!files || files.length === 0) return;
      e.preventDefault();
      setDragging(false);
      void onFiles(files);
    };
    const onDragEnd = () => setDragging(false);

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, [onFiles]);

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
            noteToken(c.length);
          },
          onContent: (c) => {
            freshBody += c;
            const s = settle();
            acc.body = s.body;
            acc.reasoning = s.reasoning;
            patchMessage(args.sessionId, args.messageId, (m) => ({ ...m, content: s.body }));
            noteToken(c.length);
          },
          onTimings: (t, extra) => {
            patchMessage(args.sessionId, args.messageId, (m) => ({ ...m, timings: t, demo: extra?.demo }));
            if (extra?.demo) setDemoNotice(true);
            if (t.predicted_per_second && t.predicted_per_second > 0) {
              patchJob((j) => {
                const rate = t.predicted_per_second as number;
                return {
                  ...j,
                  finalRate: rate,
                  rate,
                  tokens: t.predicted_n ?? j.tokens,
                };
              });
            }
            if (t.prompt_n) {
              patchJob((j) => ({
                ...j,
                progress: {
                  total: t.prompt_n as number,
                  cache: t.cache_n ?? 0,
                  processed: t.prompt_n as number,
                  time_ms: t.prompt_ms ?? 0,
                },
              }));
            }
          },
          onProgress: (p) => {
            patchJob((j) => ({ ...j, progress: p, queuedAckAt: j.queuedAckAt ?? Date.now() }));
          },
          onServerLoading: () => {
            patchJob((j) => ({ ...j, loadingAt: j.loadingAt ?? Date.now() }));
          },
          onFinish: (f) => {
            finish = f;
          },
        },
        args.ctrl.signal,
        { systemExtra: args.systemExtra, continueFinal, directive },
      );
      if (result.demo) setDemoNotice(true);
      if (result.queuedMs > 0) {
        patchJob((j) => ({ ...j, idleBefore: j.idleBefore + result.queuedMs }));
      }
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

    beginJob();
    let round: Round;
    try {
      round = await runRound({
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
    } catch (err) {
      endJob();
      throw err;
    }

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
    endJob();
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
        {pacingView && pacingView.phase !== "idle" && (
          <JobPip phase={pacingView.phase} elapsedMs={pacingView.elapsedMs} />
        )}
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
      {status?.loading && (
        <div className="banner warming">
          <span className="pager-drum" aria-hidden="true">
            <i />
          </span>
          <span>
            llama-server is loading the model into memory. Send whenever you like — the job is
            queued and the card reader shows it being read the moment the weights are in.
          </span>
        </div>
      )}
      {status?.via === "none" && status?.error && !status.loading && (
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

      {dropNotice && (
        <div className="banner note">
          <span>{dropNotice}</span>
          <button type="button" className="icon-btn" onClick={() => setDropNotice(null)}>
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
        {dragging && (
          <div className="drop-veil">
            <span>Drop to save into ./workspace and pin as context</span>
          </div>
        )}
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
          pacing={pacingView}
          onCancelJob={stop}
          retro={settings.retroFeedback}
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
            pace={pace}
            tick={lastTick}
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
  const warming = !ok && status?.loading === true;
  const label = ok
    ? status?.via === "direct"
      ? "llama-server · direct"
      : "llama-server"
    : warming
      ? "warming up"
      : "offline";
  return (
    <div className={`status ${ok ? "ok" : warming ? "warm" : "down"}`}>
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
