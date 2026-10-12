import { useEffect, useRef, useState } from "react";
import { familyLabel, modeById, reasonTag } from "../lib/modes";
import type { Attachment, ChatMessage, ModeFamily, Session } from "../lib/types";
import { MarkdownView } from "./MarkdownView";

export function Chat({
  session,
  family,
  streamingId,
  attachments,
  onDetach,
  draft,
  setDraft,
  onSend,
  onStop,
  onRegen,
  onStarter,
  demoNotice,
}: {
  session: Session;
  family: ModeFamily;
  streamingId: string | null;
  attachments: Attachment[];
  onDetach: (path: string) => void;
  draft: string;
  setDraft: (s: string) => void;
  onSend: () => void;
  onStop: () => void;
  onRegen: () => void;
  onStarter: (text: string) => void;
  demoNotice: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const mode = modeById(session.modeId);
  const tag = reasonTag(family, session.modeId);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [session.messages, streamingId]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [draft]);

  const empty = session.messages.length === 0;

  return (
    <section className="stage">
      <div className="stage-head">
        <div>
          <div className="stage-mode">
            {tag} · {familyLabel(family)}
          </div>
          <div className="muted tiny">{mode.bestFor}</div>
        </div>
        {session.messages.some((m) => m.role === "assistant") && (
          <button type="button" className="icon-btn" onClick={onRegen} disabled={!!streamingId}>
            regen
          </button>
        )}
      </div>

      {demoNotice && (
        <div className="banner">
          llama-server is offline — this reply is a local demo stream so you can exercise the
          workbench. Start the MAX MTP server, then send again.
        </div>
      )}

      <div className="messages" ref={scroller}>
        {empty && (
          <Empty
            example={mode.example}
            tag={tag}
            onStarter={onStarter}
          />
        )}
        {session.messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            live={streamingId === m.id}
          />
        ))}
      </div>

      <div className="composer">
        {attachments.length > 0 && (
          <div className="chips">
            {attachments.map((a) => (
              <button
                key={a.path}
                type="button"
                className="chip"
                onClick={() => onDetach(a.path)}
                title="Unpin"
              >
                {a.path} <span>×</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          value={draft}
          placeholder={`${tag} ${mode.example}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            }
            if (e.key === "Escape" && streamingId) onStop();
          }}
          rows={3}
        />
        <div className="composer-bar">
          <span className="muted tiny">⌘↵ send · esc stop · new chat when you change construct</span>
          <span className="grow" />
          {streamingId ? (
            <button type="button" className="btn danger" onClick={onStop}>
              stop
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={onSend} disabled={!draft.trim() && attachments.length === 0}>
              send
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function Empty({
  example,
  tag,
  onStarter,
}: {
  example: string;
  tag: string;
  onStarter: (text: string) => void;
}) {
  const starters = [
    example,
    "Review the pinned files. List the three riskiest bugs and patch the worst one.",
    "Add tests around the pinned module. Cover error paths.",
    "Refactor for clarity without changing behaviour. Show a unified diff.",
  ];
  return (
    <div className="empty">
      <div className="mono-mark">Q38</div>
      <h1>Prime the cortex.</h1>
      <p>
        Pin files from the workspace, pick a Turbo Brilliance construct, then write the brief. The
        tag <code>{tag}</code> is injected at the head of each turn.
      </p>
      <div className="starters">
        {starters.map((s) => (
          <button key={s} type="button" className="starter" onClick={() => onStarter(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function peelThink(content: string, reasoning?: string) {
  const tagged = content.match(/^[\s\S]*?<think>([\s\S]*?)<\/think>/i);
  if (tagged) {
    return {
      reasoning: (reasoning || "") + tagged[1],
      content: content.slice(tagged[0].length).replace(/^\s+/, ""),
    };
  }
  const open = content.match(/<think>([\s\S]*)$/i);
  if (open && !content.includes("</think>")) {
    return { reasoning: (reasoning || "") + open[1], content: "" };
  }
  return { reasoning, content };
}

function MessageView({ message, live }: { message: ChatMessage; live: boolean }) {
  if (message.role === "user") {
    return (
      <article className="msg user">
        <div className="msg-kicker">you {message.modeTag ? `· ${message.modeTag}` : ""}</div>
        <div className="msg-body whitespace">{message.content}</div>
        {message.attachments && message.attachments.length > 0 && (
          <div className="chips static">
            {message.attachments.map((a) => (
              <span key={a.path} className="chip">
                {a.path}
              </span>
            ))}
          </div>
        )}
      </article>
    );
  }
  const peeled = peelThink(message.content, message.reasoning);
  return (
    <article className={`msg assistant ${live ? "live" : ""}`}>
      <div className="msg-kicker">
        q38 {message.demo ? "· demo" : ""}{" "}
        {message.timings?.predicted_per_second
          ? `· ${message.timings.predicted_per_second.toFixed(1)} tok/s`
          : live
            ? "· streaming"
            : ""}
      </div>
      {peeled.reasoning ? (
        <Think text={peeled.reasoning} live={live && !peeled.content} />
      ) : null}
      {peeled.content ? <MarkdownView text={peeled.content} /> : live ? <span className="caret" /> : null}
      {message.error && <div className="err">{message.error}</div>}
    </article>
  );
}

function Think({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => {
    if (live) setOpen(true);
    else setOpen(false);
  }, [live]);
  return (
    <div className={`think ${open ? "open" : ""}`}>
      <button type="button" className="think-toggle" onClick={() => setOpen((v) => !v)}>
        <span>thinking</span>
        <span className="muted tiny">{text.length} chars {live ? "· live" : ""}</span>
      </button>
      {open && <div className="think-body">{text}</div>}
    </div>
  );
}
