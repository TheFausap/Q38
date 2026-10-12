import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chat } from "./components/Chat";
import { Inspector } from "./components/Inspector";
import { Sidebar } from "./components/Sidebar";
import { fetchFile, fetchStatus, fetchTree, streamChat } from "./lib/api";
import { modeById, reasonTag } from "./lib/modes";
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
  FileNode,
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
  };
}

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
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [demoNotice, setDemoNotice] = useState(false);
  const [modeWarn, setModeWarn] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);

  const session = useMemo(
    () => sessions.find((s) => s.id === activeId) || sessions[0],
    [sessions, activeId],
  );

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

  const patchSession = (id: string, fn: (s: Session) => Session) => {
    setSessions((all) => all.map((s) => (s.id === id ? fn(s) : s)));
  };

  const newSession = (modeId?: string, family?: ModeFamily) => {
    const s = blankSession(modeId || session?.modeId || "coder", family || session?.family || "reasoning");
    setSessions((all) => [s, ...all]);
    setActiveId(s.id);
    setDraft("");
    setAttachments([]);
    setDemoNotice(false);
    setModeWarn(null);
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

  const send = async (text?: string, regen = false) => {
    if (!session) return;
    const raw = (text ?? draft).trim();
    if (!raw && attachments.length === 0 && !regen) return;
    const ctrl = new AbortController();
    const prev = abortRef.current;
    abortRef.current = ctrl;
    sendingRef.current = true;
    prev?.abort();

    let history = session.messages;
    if (regen) {
      const lastUser = [...history].reverse().find((m) => m.role === "user");
      const cut = lastUser ? history.lastIndexOf(lastUser) : -1;
      history = cut >= 0 ? history.slice(0, cut + 1) : history.filter((m) => m.role !== "assistant");
    }

    const tag = reasonTag(session.family, session.modeId);
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
    const asst: ChatMessage = {
      id: uid(),
      role: "assistant",
      content: "",
      reasoning: "",
    };
    const nextMessages = regen
      ? [...history, asst]
      : [...history, userMsg!, asst];

    const titleSource = content || userMsg?.content || session.title;
    patchSession(session.id, (s) => ({
      ...s,
      title:
        s.title === "untitled"
          ? titleSource.replace(/\{REASON:[^}]+\}/g, "").trim().slice(0, 48) || "untitled"
          : s.title,
      messages: nextMessages,
      updatedAt: Date.now(),
    }));
    if (!regen) {
      setDraft("");
    }
    setStreamingId(asst.id);
    setDemoNotice(false);

    let reasoning = "";
    let body = "";
    try {
      const result = await streamChat(
        nextMessages.filter((m) => m.id !== asst.id),
        sampling,
        settings,
        {
          onReasoning: (c) => {
            reasoning += c;
            patchSession(session.id, (s) => ({
              ...s,
              messages: s.messages.map((m) => (m.id === asst.id ? { ...m, reasoning } : m)),
            }));
          },
          onContent: (c) => {
            body += c;
            patchSession(session.id, (s) => ({
              ...s,
              messages: s.messages.map((m) => (m.id === asst.id ? { ...m, content: body } : m)),
            }));
          },
          onTimings: (t, extra) => {
            patchSession(session.id, (s) => ({
              ...s,
              messages: s.messages.map((m) =>
                m.id === asst.id ? { ...m, timings: t, demo: extra?.demo } : m,
              ),
            }));
            if (extra?.demo) setDemoNotice(true);
          },
        },
        ctrl.signal,
      );
      if (result.demo) setDemoNotice(true);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        /* stopped */
      } else {
        const message = err instanceof Error ? err.message : String(err);
        patchSession(session.id, (s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === asst.id ? { ...m, error: message, content: body || m.content } : m,
          ),
        }));
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

      <div className="workspace">
        {leftOpen && (
          <Sidebar
            sessions={sessions}
            activeId={session.id}
            onSelect={(id) => {
              setActiveId(id);
              setDemoNotice(false);
              setModeWarn(null);
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
          demoNotice={demoNotice}
        />
        {rightOpen && (
          <Inspector
            modeId={session.modeId}
            family={session.family}
            onMode={changeMode}
            onFamily={changeFamily}
            sampling={sampling}
            onSampling={setSampling}
            status={status}
            preview={preview}
            onAskHelp={askHelp}
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
