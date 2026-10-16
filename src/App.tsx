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
  memoryForget,
  memoryGet,
  memoryList,
  memoryPut,
  streamChat,
  uploadWorkspaceFile,
  webFetchPage,
  webSearch,
} from "./lib/api";
import {
  activeCompaction,
  cutIdOf,
  messagesAfter,
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
  MAX_TOOL_HOPS,
  WEB_MAX_CHARS,
  WEB_MAX_FETCHES_PER_TURN,
  WEB_MAX_SEARCHES_PER_TURN,
  WEB_TOOLS,
  argsOf,
  clampCount,
  dedupeSources,
  fetchTapeLine,
  pageText,
  searchResultsText,
  searchTapeLine,
  sourceOf,
  type WebPageOutcome,
} from "./lib/web";
import {
  RECALL_BUDGET_FRACTION,
  describeChunk,
  planRecall,
  recallText,
  registerLine,
  registerText,
} from "./lib/memory";
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
  ArchiveRef,
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

/**
 * The one tool the model gets: ask for a chunk back off the disk.
 *
 * It is offered only when something is actually on disk, and only the register
 * lines tell the model what exists. Chunk bodies never enter the prompt unless
 * this is called (or the turn matched on its own), which is the whole point of
 * moving them out.
 */
const RECALL_TOOL = {
  type: "function",
  function: {
    name: "recall",
    description:
      "Read a chunk of earlier conversation back off the disk, verbatim. The context shows " +
      "register lines like `#3 · \"label\" · src/lib/api.ts · 6 msg · 2.1k tok`: ask for the " +
      "number when an earlier turn matters and you no longer have it.",
    parameters: {
      type: "object",
      properties: {
        chunk: {
          type: "integer",
          description: "the register number, e.g. 3 for the line that starts with #3",
        },
        query: {
          type: "string",
          description:
            "or describe what you need in words and the closest chunk is brought back instead",
        },
      },
      required: [],
    },
  },
};

/** How many times one turn may go and fetch before it has to answer. */
const MAX_RECALL_HOPS = 2;

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
  const [memNotice, setMemNotice] = useState<string | null>(null);
  /** the console tape line for the last disk move (see PacingView.mem) */
  const [memLine, setMemLine] = useState<string | null>(null);
  /** the console tape line for the last web move (see PacingView.web) */
  const [webLine, setWebLine] = useState<string | null>(null);
  const [webNotice, setWebNotice] = useState<string | null>(null);
  const [memBusy, setMemBusy] = useState<string | null>(null);
  const [memRoot, setMemRoot] = useState<string>("");
  const [folding, setFolding] = useState(false);
  const [exactTokens, setExactTokens] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
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

  /** The session as it is *now* — an async turn must not read a stale memo. */
  const sessionById = useCallback(
    (id: string): Session | undefined => sessionsRef.current.find((s) => s.id === id),
    [],
  );

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

  useEffect(() => {
    let alive = true;
    const id = session?.id;
    if (!id) return;
    void memoryList(id)
      .then((out) => {
        if (alive) setMemRoot(out.root);
      })
      .catch(() => {
        if (alive) setMemRoot("");
      });
    return () => {
      alive = false;
    };
  }, [session?.id, session?.archives?.length]);

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
      setTreeError(t.ok ? null : t.error || "the workspace could not be read");
    } catch {
      setTree([]);
      setTreeError("the workspace could not be read");
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
    // the tree is re-read with the status: a file added to ./workspace by hand
    // shows up, and a workbench whose API went away stops claiming the folder
    // is empty
    const id = window.setInterval(() => {
      void refreshStatus();
      void refreshTree();
    }, 8000);
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
      mem: memLine,
      web: webLine,
    };
    // `tick` is the clock that moves this view forward between tokens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, tick, pace.baseline, settings.pagingFactor, jobInput, memLine, webLine]);

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
          next.push({ path: target, content, source: "upload", unstored: !stored });
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
  const archivedChunks = useMemo(() => session?.archives ?? [], [session]);
  const liveMessages = useMemo(
    () => (session ? messagesAfter(session.messages, cutIdOf(session)) : []),
    [session],
  );
  const briefTexts = useMemo(
    () => (archivedChunks.length ? [registerText(archivedChunks)] : carry ? [compactionBriefText(carry)] : []),
    [archivedChunks, carry],
  );

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

  /* ------------------------------------------------------------- memory */

  /** The chunks this session has moved out of the window. */
  const archivesOf = useCallback(
    (target: Session | undefined): ArchiveRef[] => target?.archives ?? [],
    [],
  );

  /**
   * Move the older half of `base` onto disk. Nothing is summarised and nothing
   * is deleted: the messages stay in the transcript, and the window keeps one
   * register line per chunk plus the terms needed to find it again.
   *
   * Returns `ok: false` when the store cannot be reached, which is the signal
   * to fall back to folding — a workbench on a static host still runs, just
   * without memory.
   */
  const archiveWindow = useCallback(
    async (
      target: Session,
      base: ChatMessage[],
      _opts: { auto: boolean },
    ): Promise<{ ok: true; ref: ArchiveRef; tail: ChatMessage[] } | { ok: false; why: string }> => {
      const plan = planFold(base, settings.keepTailMessages);
      if (!plan) {
        return { ok: false, why: "the transcript is still one turn — nothing to move out" };
      }
      const tokens = headPromptCost(plan.head);
      const described = describeChunk(plan.head, tokens);
      const seq = (target.archives?.length ?? 0) + 1;
      const ref: ArchiveRef = {
        id: `c${String(seq).padStart(3, "0")}-${uid().slice(0, 6)}`,
        seq,
        at: Date.now(),
        fromId: plan.head[0].id,
        toId: plan.boundaryId,
        count: plan.head.length,
        tokens,
        register: registerLine({
          id: "",
          seq,
          label: described.label,
          paths: described.paths,
          tokens,
          count: plan.head.length,
        }),
        label: described.label,
        paths: described.paths,
        terms: described.terms,
        recalls: 0,
        lastRecallAt: null,
      };

      setFolding(true);
      try {
        await memoryPut(
          target.id,
          { ...ref, body: { messages: plan.head } },
          { title: target.title, createdAt: target.createdAt, updatedAt: Date.now() },
        );
      } catch (err) {
        setFolding(false);
        return {
          ok: false,
          why: err instanceof Error ? err.message : "the memory store is not reachable",
        };
      }
      patchSession(target.id, (s) => ({
        ...s,
        archives: [...(s.archives ?? []), ref],
        updatedAt: Date.now(),
      }));
      setFolding(false);
      return { ok: true, ref, tail: plan.tail };
    },
    [settings.keepTailMessages],
  );

  /**
   * Pull chunks back into the window. Bodies come from disk; the register refs
   * record that it happened, so the inspector and the transcript can say so.
   */
  const recallChunks = useCallback(
    async (
      target: Session,
      ids: string[],
    ): Promise<{ texts: string[]; tokens: number; refs: ArchiveRef[] }> => {
      const refs = archivesOf(target);
      const texts: string[] = [];
      const used: ArchiveRef[] = [];
      let tokens = 0;
      for (const id of ids) {
        const ref = refs.find((r) => r.id === id);
        if (!ref) continue;
        try {
          const chunk = await memoryGet(target.id, id);
          texts.push(recallText(ref, chunk.body));
          used.push(ref);
          tokens += ref.tokens;
        } catch {
          /* gone from disk: skip it rather than failing the whole send */
        }
      }
      if (used.length) {
        const at = Date.now();
        patchSession(target.id, (s) => ({
          ...s,
          archives: (s.archives ?? []).map((r) =>
            used.some((u) => u.id === r.id) ? { ...r, recalls: r.recalls + 1, lastRecallAt: at } : r,
          ),
        }));
      }
      return { texts, tokens, refs: used };
    },
    [archivesOf],
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

  /* ------------------------------------------------- memory, by hand */

  /** Pull one chunk back into the window, now and on the next sends. */
  const pullBack = useCallback(
    async (id: string) => {
      const target = currentSession();
      if (!target) return;
      const ref = archivesOf(target).find((r) => r.id === id);
      if (!ref) return;
      setMemBusy(id);
      try {
        const back = await recallChunks(target, [id]);
        if (!back.texts.length) {
          setMemNotice(`#${ref.seq} is no longer on disk — nothing to pull back.`);
          return;
        }
        patchSession(target.id, (s) => ({
          ...s,
          held: [...new Set([...(s.held ?? []), id])],
          updatedAt: Date.now(),
        }));
        setMemNotice(
          `#${ref.seq} is back in the window (${formatTokens(ref.tokens)} prompt tokens) and stays there until you let it go.`,
        );
      } finally {
        setMemBusy(null);
      }
    },
    [archivesOf, currentSession, recallChunks],
  );

  /** Let a pinned chunk go out of the window again. */
  const releaseBack = useCallback(
    (id: string) => {
      const target = currentSession();
      if (!target) return;
      const ref = archivesOf(target).find((r) => r.id === id);
      patchSession(target.id, (s) => ({
        ...s,
        held: (s.held ?? []).filter((x) => x !== id),
        updatedAt: Date.now(),
      }));
      setMemNotice(`#${ref?.seq ?? "?"} is out of the window again. The chunk is still on disk.`);
    },
    [archivesOf, currentSession],
  );

  /** Throw a chunk away for good. */
  const forgetChunk = useCallback(
    async (id: string) => {
      const target = currentSession();
      if (!target) return;
      const ref = archivesOf(target).find((r) => r.id === id);
      setMemBusy(id);
      try {
        await memoryForget(target.id, [id]);
      } catch {
        /* the ref still goes: the window should not keep pointing at a body we gave up on */
      } finally {
        patchSession(target.id, (s) => ({
          ...s,
          archives: (s.archives ?? []).filter((r) => r.id !== id),
          held: (s.held ?? []).filter((x) => x !== id),
          updatedAt: Date.now(),
        }));
        setMemBusy(null);
        setMemNotice(`#${ref?.seq ?? "?"} is gone from disk. The messages are still in the transcript.`);
      }
    },
    [archivesOf, currentSession],
  );

  /** Undo the whole archive: everything comes back into the window. */
  const unarchive = useCallback(async () => {
    const target = currentSession();
    if (!target) return;
    const chunks = archivesOf(target);
    if (!chunks.length) return;
    setMemBusy("all");
    try {
      await memoryForget(target.id, []);
    } catch {
      /* leave the refs alone if the store refused: better a stale pointer than a lie */
      setMemBusy(null);
      setMemNotice("The memory store refused the delete — the archive is still on disk.");
      return;
    }
    patchSession(target.id, (s) => ({ ...s, archives: [], held: [], updatedAt: Date.now() }));
    setMemBusy(null);
    setMemNotice(
      `Archive cleared — ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} back in the window, nothing lost.`,
    );
  }, [archivesOf, currentSession]);

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

  /**
   * The model asked for something back. It either names a register number or
   * describes what it wants; either way the chunk that comes back is the real
   * thing, verbatim. Nothing is invented if the request misses.
   */
  const recallForTool = useCallback(
    async (
      target: Session,
      calls: { arguments: string }[],
    ): Promise<string[]> => {
      const archives = archivesOf(target);
      if (!archives.length) return [];
      const ids: string[] = [];
      const asked: string[] = [];
      for (const call of calls) {
        let args: { chunk?: unknown; query?: unknown } = {};
        try {
          args = JSON.parse(call.arguments || "{}") as typeof args;
        } catch {
          /* a malformed argument is a miss, not a crash */
        }
        const seq = Number(args.chunk);
        if (Number.isFinite(seq)) {
          const ref = archives.find((r) => r.seq === seq);
          if (ref) ids.push(ref.id);
          asked.push(`#${seq}`);
          continue;
        }
        const q = typeof args.query === "string" ? args.query : "";
        if (q) {
          const plan = planRecall({
            query: q,
            refs: archives.filter((r) => !ids.includes(r.id)),
            budgetTokens: Number.MAX_SAFE_INTEGER,
            maxChunks: 1,
          });
          if (plan.ids.length) ids.push(...plan.ids);
          asked.push(`"${q.slice(0, 60)}"`);
        }
      }
      if (!ids.length) {
        setMemNotice(
          `The model asked for ${asked.join(", ") || "a chunk"} and nothing on disk matched it.`,
        );
        return [];
      }
      const back = await recallChunks(target, [...new Set(ids)]);
      if (!back.texts.length) return [];
      setMemNotice(
        `The model read ${back.refs.map((r) => `#${r.seq}`).join(", #")} back off the disk (${formatTokens(
          back.tokens,
        )} prompt tokens) — ${asked.join(", ") || "asked for it"}.`,
      );
      setMemLine(
        `MEMORY: RECALL ${back.refs.map((r) => `#${r.seq}`).join(" ")} · ${formatTokens(back.tokens)} · ASKED BY THE MODEL`,
      );
      return back.texts;
    },
    [archivesOf, recallChunks],
  );

  /**
   * The model asked the web something. Each call goes out through the workbench's
   * middleware, and what comes back is written for a prompt — a miss included,
   * because a search that fails is information too.
   */
  const webForTool = useCallback(
    async (calls: { arguments: string }[]) => {
      const texts: string[] = [];
      const sources: { title: string; url: string }[] = [];
      for (const call of calls) {
        const args = argsOf(call.arguments);
        const query = String(args.query ?? "").trim();
        if (!query) {
          texts.push('### Web search skipped\nThe call had no query in it. Ask again with a `query`.');
          continue;
        }
        const count = clampCount(args.count, settings.webResults);
        const out = await webSearch(query, count, settings);
        texts.push(searchResultsText(query, out, count));
        setWebLine(searchTapeLine(query, out));
        setWebNotice(
          out.ok
            ? `Searched "${query.slice(0, 70)}" — ${out.results?.length ?? 0} results from ${out.provider}${
                out.ms ? ` in ${Math.round(out.ms)}ms` : ""
              }.`
            : `The search failed: ${out.error}${out.hint ? ` ${out.hint}` : ""}`,
        );
        for (const hit of out.results ?? []) sources.push(sourceOf(hit.url, hit.title));
      }
      return { texts, sources };
    },
    [settings],
  );

  /** The model asked to read one page. */
  const webPageForTool = useCallback(
    async (calls: { arguments: string }[]) => {
      const texts: string[] = [];
      const sources: { title: string; url: string }[] = [];
      for (const call of calls) {
        const url = String(argsOf(call.arguments).url ?? "").trim();
        if (!url) {
          texts.push('### Nothing to open\nThat call had no `url` in it.');
          continue;
        }
        const out: WebPageOutcome = await webFetchPage(url, settings.webPageChars, settings);
        texts.push(pageText(out));
        setWebLine(fetchTapeLine(url, out));
        setWebNotice(
          out.ok
            ? `Read ${out.host}${new URL(out.finalUrl || url).pathname.slice(0, 60)} — ${out.chars} characters${
                out.truncated ? " (cut to the budget)" : ""
              }.`
            : `Could not read that page: ${out.error}`,
        );
        if (out.ok) sources.push(sourceOf(out.finalUrl || url, out.title));
      }
      return { texts, sources };
    },
    [settings],
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
    /** more system turns for this round only (recalled chunks, tool results). */
    extraSystem?: string[];
    /** tools offered this round; only the recall tool exists. */
    tools?: unknown[];
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
        {
          systemExtra: args.extraSystem?.length
            ? [...args.systemExtra, ...args.extraSystem]
            : args.systemExtra,
          continueFinal,
          directive,
          tools: args.tools,
        },
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
    extraSystem?: string[];
    tools?: unknown[];
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
        extraSystem: args.extraSystem,
        tools: args.tools,
      });
    } catch (err) {
      endJob();
      throw err;
    }

    /* The model asked for something it cannot reach from here — a chunk off the
       disk, a search, a page. Fetch it, then send the turn again with it in the
       prompt. Capped per tool and in total, so a confused model cannot loop the
       machine into a very slow morning; the prose already streamed (if any) is
       appended to, never thrown away. */
    let hops = 0;
    let recalls = 0;
    let searches = 0;
    let fetches = 0;
    const sources: { title: string; url: string }[] = [];
    while (!args.ctrl.signal.aborted && hops < MAX_TOOL_HOPS) {
      const called = round.finish.calls ?? [];
      const recallCalls =
        recalls < MAX_RECALL_HOPS ? called.filter((c) => c.name === "recall") : [];
      const searchCalls =
        searches < WEB_MAX_SEARCHES_PER_TURN ? called.filter((c) => c.name === "web_search") : [];
      const fetchCalls =
        fetches < WEB_MAX_FETCHES_PER_TURN ? called.filter((c) => c.name === "web_fetch") : [];
      if (!recallCalls.length && !searchCalls.length && !fetchCalls.length) break;

      const session = sessionById(args.sessionId);
      const texts: string[] = [];
      let hopSources: { title: string; url: string }[] = [];
      let didRecall = 0;

      if (recallCalls.length && session) {
        const back = await recallForTool(session, recallCalls);
        texts.push(...back);
        if (back.length) {
          recalls++;
          didRecall = 1;
        }
      }
      if (searchCalls.length) {
        const found = await webForTool(searchCalls);
        texts.push(...found.texts);
        hopSources = [...hopSources, ...found.sources];
        searches += searchCalls.length;
      }
      if (fetchCalls.length && !args.ctrl.signal.aborted) {
        const read = await webPageForTool(fetchCalls);
        texts.push(...read.texts);
        hopSources = [...hopSources, ...read.sources];
        fetches += fetchCalls.length;
      }
      if (!texts.length) break;

      sources.push(...hopSources);
      hops++;
      round = await runRound({
        sessionId: args.sessionId,
        messageId: args.messageId,
        wire: round.body.trim()
          ? [...args.wireBefore, assistantMessage(round.body)]
          : args.wireBefore,
        systemExtra: args.systemExtra,
        ctrl: args.ctrl,
        acc,
        start: { body: round.body, reasoning: round.reasoning },
        continueFinal: round.body.trim() ? "content" : args.first.continueFinal,
        directive: undefined,
        extraSystem: [...(args.extraSystem ?? []), ...texts],
        tools: args.tools,
      });
      patchMessage(args.sessionId, args.messageId, (m) => ({
        ...m,
        recalled: (m.recalled ?? 0) + didRecall,
        searched: (m.searched ?? 0) + searchCalls.length,
        opened: (m.opened ?? 0) + fetchCalls.length,
      }));
    }
    if (sources.length) {
      const list = dedupeSources(sources);
      patchMessage(args.sessionId, args.messageId, (m) => ({ ...m, sources: list }));
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
        extraSystem: args.extraSystem,
        tools: args.tools,
      });
      patchMessage(args.sessionId, args.messageId, (m) => ({ ...m, continues }));
    }
    endJob();
    return round;
  };

  /** Fold if the window is about to overflow; return the window to send. */
  /**
   * Get the window ready to send: move what no longer fits onto disk, pull back
   * what this turn needs, and fall back to folding only if the disk is out of
   * reach. The recall set is decided here, once, before the stream starts —
   * re-ranking mid-turn would invalidate llama-server's prompt cache every
   * chunk, which on a big model is the whole cost of the feature.
   */
  const prepareWindow = async (
    target: Session,
    history: ChatMessage[],
    incoming: ChatMessage[],
    query: string,
  ) => {
    const archived = archivesOf(target);
    const previous = activeCompaction(target);
    // an archive and a fold are two ways of cutting the same transcript; the
    // archive wins when the session has one
    let wire = archived.length ? history : unfoldedMessages(history, previous);
    let systemExtra = archived.length ? [registerText(archived)] : previous ? [compactionBriefText(previous)] : [];

    const probe = measureContext({
      messages: [...wire, ...incoming],
      summaries: systemExtra,
      settings,
      sampling,
      props: status?.props ?? null,
    });
    const trigger = shouldAutoCompact(probe, settings, canFold(wire, settings));

    if (trigger.fold) {
      const out = await archiveWindow(target, wire, { auto: true });
      if (out.ok) {
        wire = out.tail;
        systemExtra = [registerText([...(archived ?? []), out.ref])];
        setMemLine(
          `MEMORY: ARCHIVE #${out.ref.seq} · ${formatTokens(out.ref.tokens)} OUT · ${out.ref.count} MSG → DISK`,
        );
        setMemNotice(
          `Window was at ${formatPct(trigger.pct)} — moved ${out.ref.count} messages (#${out.ref.seq}) to disk as one register line (−${formatTokens(
            out.ref.tokens,
          )} prompt tokens). Nothing was summarised; ask for it and it comes back verbatim.`,
        );
      } else {
        // no store: the old lossy path, announced as such
        const folded = await foldWindow(target, wire, { auto: true });
        if (folded.ok) {
          wire = folded.tail;
          systemExtra = [compactionBriefText(folded.compaction)];
          setFoldNotice(
            `Context was at ${formatPct(trigger.pct)} — the memory store is out of reach (${out.why}), so ${folded.compaction.foldedMessages} messages were folded into a ${
              folded.compaction.source === "model" ? "model-written" : "local"
            } brief instead (−${formatTokens(compactionNetSavings(folded.compaction))} tokens).`,
          );
        } else {
          setFoldNotice(`Context at ${formatPct(trigger.pct)}, not folded: ${folded.why}.`);
        }
      }
    } else if (probe.pct >= settings.compactAt) {
      setFoldNotice(`Window at ${formatPct(probe.pct)}: ${trigger.reason}.`);
    }

    /* Automatic recall: whatever the cut, this turn may need something that is
       no longer in the window. The budget is a share of the window plus the
       room that actually exists right now — on a small window a single chunk is
       often bigger than the share alone, and a turn that names a file wants
       that chunk. It is capped at half the window so recall can never crowd out
       the work. */
    const budget = resolveBudget(settings, sampling, status?.props ?? null);
    const share = Math.round(budget.budget * RECALL_BUDGET_FRACTION);
    const slack = Math.max(0, budget.budget - probe.used);
    const recallBudget = Math.max(
      share,
      Math.min(share + slack, Math.round(budget.budget * 0.5)),
    );
    const held = new Set(target.held ?? []);
    const plan = planRecall({
      query,
      refs: archivesOf(target).filter((r) => !held.has(r.id)),
      budgetTokens: recallBudget,
    });
    if (plan.ids.length) {
      const back = await recallChunks(target, plan.ids);
      if (back.texts.length) {
        systemExtra = [...systemExtra, ...back.texts];
        setMemLine(
          `MEMORY: RECALL ${back.refs.map((r) => `#${r.seq}`).join(" ")} · ${formatTokens(back.tokens)} · MATCHED THE TURN`,
        );
        setMemNotice(
          `Recalled #${back.refs.map((r) => r.seq).join(", #")} from disk (${formatTokens(
            back.tokens,
          )} prompt tokens) — ${plan.why}. It goes back out of the window after this turn.`,
        );
      }
    }

    /* Anything the user pinned by hand rides along too. */
    if (held.size) {
      const back = await recallChunks(
        target,
        [...held].filter((id) => !plan.ids.includes(id)),
      );
      systemExtra = [...systemExtra, ...back.texts];
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

    /* /recall 3 — bring chunk #3 back into the window and keep it there. The
       register line tells you the number; this is the same move as the card's
       pull back, typed instead of clicked. */
    const command = /^\/recall\b\s*(\d*)\s*$/.exec(raw);
    if (command) {
      const archives = archivesOf(target);
      const seq = command[1] ? Number(command[1]) : Number.NaN;
      const ref = archives.find((r) => r.seq === seq);
      setDraft("");
      if (!archives.length) {
        setMemNotice("Nothing is on disk for this session, so there is nothing to recall.");
      } else if (!ref) {
        setMemNotice(
          `No chunk #${command[1] || "?"}. On disk: ${archives
            .map((r) => `#${r.seq} (${formatTokens(r.tokens)})`)
            .join(", ")}.`,
        );
      } else if ((target.held ?? []).includes(ref.id)) {
        setMemNotice(`#${ref.seq} is already in the window — it stays until you let it go.`);
      } else {
        void pullBack(ref.id);
      }
      return;
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

    let wire = messagesAfter(history, cutIdOf(target));
    let systemExtra: string[] = [];
    let tools: unknown[] | undefined;
    try {
      const prepared = await prepareWindow(target, history, userMsg ? [userMsg] : [], content);
      wire = prepared.wire;
      systemExtra = prepared.systemExtra;
      /* offer each tool only when there is something on the other end of it */
      const onDisk = archivesOf(target).length > 0;
      const offered: unknown[] = [];
      if (onDisk && settings.recallTool) offered.push(RECALL_TOOL);
      if (settings.webSearch) offered.push(...WEB_TOOLS);
      tools = offered.length ? offered : undefined;
    } catch (err) {
      setFoldNotice(`Could not prepare the context: ${err instanceof Error ? err.message : String(err)}`);
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
        tools,
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

    let wire = messagesAfter(messages.slice(0, idx), cutIdOf(target));
    let systemExtra: string[] = [];
    try {
      const prepared = await prepareWindow(
        target,
        messages.slice(0, idx),
        [{ ...anchor, role: "assistant" }],
        `${anchor.content.slice(-2000)} ${messages[idx - 1]?.content ?? ""}`,
      );
      wire = prepared.wire;
      systemExtra = prepared.systemExtra;
    } catch (err) {
      setFoldNotice(`Could not prepare the context: ${err instanceof Error ? err.message : String(err)}`);
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
      // a manual resume is still a resume: count it on the message so the
      // transcript records that this reply was assembled from two rounds
      patchMessage(target.id, anchor.id, (m) => ({ ...m, continues: (m.continues ?? 0) + 1 }));
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

      {webNotice && (
        <div className="banner web">
          <span>{webNotice}</span>
          <button type="button" className="icon-btn" onClick={() => setSettingsOpen(true)}>
            setup
          </button>
          <button type="button" className="icon-btn" onClick={() => setWebNotice(null)}>
            dismiss
          </button>
        </div>
      )}

      {memNotice && (
        <div className="banner memory">
          <span>{memNotice}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              setRightOpen(true);
              setInspectorTab("context");
            }}
          >
            memory
          </button>
          <button type="button" className="icon-btn" onClick={() => setMemNotice(null)}>
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
            treeError={treeError}
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
          archives={archivedChunks}
          held={session.held ?? []}
          memRoot={memRoot}
          memBusy={memBusy}
          onPullBack={(id) => void pullBack(id)}
          onRelease={releaseBack}
          onForget={(id) => void forgetChunk(id)}
          onUnarchive={() => void unarchive()}
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
            archives={archivedChunks}
            held={session.held ?? []}
            memRoot={memRoot}
            memBusy={memBusy}
            onPullBack={(id) => void pullBack(id)}
            onRelease={releaseBack}
            onForget={(id) => void forgetChunk(id)}
            onUnarchive={() => void unarchive()}
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
        <div className="group-label">Web search</div>
        <p className="hint">
          The model can search and read pages while it answers, through this machine. DuckDuckGo
          needs nothing; a SearXNG instance or an API key is steadier. Pages on this machine or this
          network are refused unless <code>Q38_WEB_ALLOW_PRIVATE=1</code> — a page can never read
          your disks, only its own words can enter the prompt.
        </p>
        <label className="tiny-check block">
          <input
            type="checkbox"
            checked={settings.webSearch}
            onChange={(e) => onChange({ ...settings, webSearch: e.target.checked })}
          />
          let the model search the web and read pages
        </label>
        <label className="field">
          <span>provider</span>
          <select
            value={settings.webProvider}
            onChange={(e) => onChange({ ...settings, webProvider: e.target.value as Settings["webProvider"] })}
          >
            <option value="auto">auto — SearXNG → key → DuckDuckGo</option>
            <option value="duckduckgo">DuckDuckGo (no key)</option>
            <option value="searx">SearXNG (your instance, no key)</option>
            <option value="brave">Brave Search (API key)</option>
            <option value="tavily">Tavily (API key)</option>
          </select>
        </label>
        <label className="field">
          <span>SearXNG URL (if you run one)</span>
          <input
            value={settings.searxUrl}
            onChange={(e) => onChange({ ...settings, searxUrl: e.target.value })}
            placeholder="http://127.0.0.1:8888"
          />
        </label>
        <label className="field">
          <span>search API key (Brave or Tavily)</span>
          <input
            value={settings.searchApiKey}
            onChange={(e) => onChange({ ...settings, searchApiKey: e.target.value })}
            placeholder="optional"
          />
        </label>
        <div className="modal-row">
          <label className="field">
            <span>results per search</span>
            <input
              type="number"
              min={1}
              max={8}
              value={settings.webResults}
              onChange={(e) =>
                onChange({ ...settings, webResults: Math.max(1, Math.min(8, Number(e.target.value) || 5)) })
              }
            />
          </label>
          <label className="field">
            <span>characters per page</span>
            <input
              type="number"
              min={1000}
              max={16000}
              step={500}
              value={settings.webPageChars}
              onChange={(e) =>
                onChange({
                  ...settings,
                  webPageChars: Math.max(1000, Math.min(WEB_MAX_CHARS, Number(e.target.value) || 6000)),
                })
              }
            />
          </label>
        </div>
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
