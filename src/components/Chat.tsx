import { useMemo, useState, useEffect, useRef } from "react";
import { formatPct, formatTokens, compactionNetSavings, type ContextUsage } from "../lib/context";
import { familyLabel, modeById, reasonTag } from "../lib/modes";
import { isBusyPhase } from "../lib/pacing";
import { JobConsole, type PacingView } from "./Punchcard";
import { fenceState } from "../lib/summarize";
import type { Attachment, ChatMessage, Compaction, ModeFamily, Session } from "../lib/types";
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
  onContinue,
  onFold,
  onUnfold,
  folding,
  usage,
  compactAt,
  autoCompact,
  demoNotice,
  pacing,
  onCancelJob,
  retro,
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
  onContinue: (messageId: string) => void;
  onFold: () => void;
  onUnfold: (index: number) => void;
  folding: boolean;
  usage: ContextUsage;
  compactAt: number;
  autoCompact: boolean;
  demoNotice: boolean;
  pacing: PacingView | null;
  onCancelJob: () => void;
  retro: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const mode = modeById(session.modeId);
  const tag = reasonTag(family, session.modeId);

  const compactions = useMemo(() => session.compactions ?? [], [session.compactions]);
  const active = compactions.length ? compactions[compactions.length - 1] : undefined;
  const foldIndex = useMemo(() => {
    if (!active) return -1;
    return session.messages.findIndex((m) => m.id === active.upToId);
  }, [active, session.messages]);
  const lastAssistantId = useMemo(() => {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === "assistant") return session.messages[i].id;
    }
    return null;
  }, [session.messages]);
  const lastAssistant = useMemo(
    () => session.messages.find((m) => m.id === lastAssistantId),
    [lastAssistantId, session.messages],
  );

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
  const canFold = session.messages.length >= 3 && !streamingId && !folding;
  const hot = usage.pct >= compactAt;

  return (
    <section className="stage">
      <div className="stage-head">
        <div>
          <div className="stage-mode">
            {tag} · {familyLabel(family)}
          </div>
          <div className="muted tiny">{mode.bestFor}</div>
        </div>
        <div className="stage-head-right">
          <span className={`ctx-read ${hot ? "hot" : ""}`} title="prompt tokens / usable window">
            {formatTokens(usage.used)}/{formatTokens(usage.budget.budget)} · {formatPct(usage.pct)}
            {usage.foldedMessages > 0 ? ` · ${usage.foldedMessages} folded` : ""}
          </span>
          <button
            type="button"
            className="icon-btn"
            onClick={onFold}
            disabled={!canFold}
            title={
              autoCompact
                ? `Fold older turns into a brief (auto at ${formatPct(compactAt)})`
                : "Fold older turns into a brief"
            }
          >
            {folding ? "folding…" : "fold"}
          </button>
          {session.messages.some((m) => m.role === "assistant") && (
            <button type="button" className="icon-btn" onClick={onRegen} disabled={!!streamingId}>
              regen
            </button>
          )}
        </div>
      </div>

      {demoNotice && (
        <div className="banner">
          llama-server is offline — this reply is a local demo stream so you can exercise the
          workbench. Start the MAX MTP server, then send again.
        </div>
      )}

      <div className="messages" ref={scroller}>
        {empty && <Empty example={mode.example} tag={tag} onStarter={onStarter} />}
        {session.messages.map((m, i) => {
          const hidden = foldIndex >= 0 && i <= foldIndex;
          const card = active && i === foldIndex + 1;
          if (hidden && !card) return null;
          // while the job is still being read (or the model is being paged back
          // in) the pending reply is a job console rather than a bare caret
          const jobbed =
            !!pacing &&
            streamingId === m.id &&
            !m.content &&
            !m.reasoning &&
            (isBusyPhase(pacing.phase) || pacing.phase === "paging");
          return (
            <div key={m.id}>
              {card && active && (
                <FoldCard
                  compaction={active}
                  index={compactions.length - 1}
                  onUnfold={onUnfold}
                  disabled={!!streamingId}
                />
              )}
              {hidden ? null : jobbed && pacing ? (
                retro ? (
                  <JobConsole view={pacing} onCancel={onCancelJob} />
                ) : (
                  <div className="job-minimal">
                    <span className="job-pip">
                      <i />
                      working · {Math.round(pacing.elapsedMs / 1000)}s
                    </span>
                    <button type="button" className="icon-btn" onClick={onCancelJob}>
                      cancel
                    </button>
                  </div>
                )
              ) : (
                <MessageView
                  message={m}
                  live={streamingId === m.id}
                  tip={m.id === lastAssistantId}
                  busy={!!streamingId}
                  onContinue={onContinue}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="composer">
        {pacing && retro && pacing.phase === "paging" && <JobConsole view={pacing} compact />}
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
          <span className={`muted tiny ${hot ? "hot-text" : ""}`}>
            ⌘↵ send · esc stop · {folding ? "folding context…" : `ctx ${formatPct(usage.pct)}`}
            {pacing && isBusyPhase(pacing.phase)
              ? " · job in flight, the console will keep you posted"
              : autoCompact
                ? ` · auto-fold at ${formatPct(compactAt)}`
                : " · auto-fold off"}
          </span>
          <span className="grow" />
          {lastAssistant && !streamingId && (
            <button
              type="button"
              className={`btn ${lastAssistant.truncated ? "primary" : ""}`}
              onClick={() => onContinue(lastAssistant.id)}
              title={
                fenceState(lastAssistant.content).open
                  ? "Resume inside the open code block"
                  : lastAssistant.truncated
                    ? "The reply hit max_tokens — resume it"
                    : "Ask the model to keep going from where it stopped"
              }
            >
              {lastAssistant.truncated ? "continue reply" : "continue"}
            </button>
          )}
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

function FoldCard({
  compaction,
  index,
  onUnfold,
  disabled,
}: {
  compaction: Compaction;
  index: number;
  onUnfold: (index: number) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const saved = compactionNetSavings(compaction);
  const pct = compaction.tokensBefore > 0 ? saved / compaction.tokensBefore : 0;
  return (
    <div className={`fold-card ${open ? "open" : ""}`}>
      <div className="fold-head">
        <span className="fold-mark">◈</span>
        <span className="fold-title">
          context folded · {compaction.foldedMessages} messages → 1 brief
        </span>
        <span className="fold-meta">
          {formatTokens(compaction.tokensBefore)} → {formatTokens(compaction.tokensAfter)} tokens
          {saved > 0 ? ` (−${formatPct(pct)})` : ""} · {compaction.source === "model" ? "model-written" : "local extract"}
          {compaction.auto ? " · automatic" : ""}
        </span>
        <span className="grow" />
        <button type="button" className="icon-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "hide brief" : "read brief"}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => onUnfold(index)}
          disabled={disabled}
          title="Put the folded messages back into the window"
        >
          unfold
        </button>
      </div>
      {open && (
        <div className="fold-body">
          <MarkdownView text={compaction.summary} />
        </div>
      )}
    </div>
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
        tag <code>{tag}</code> is injected at the head of each turn. Long sessions fold themselves
        into a handoff brief before the window runs out, and a reply cut off by max_tokens can be
        resumed with <em>continue</em>.
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

function MessageView({
  message,
  live,
  tip,
  busy,
  onContinue,
}: {
  message: ChatMessage;
  live: boolean;
  tip: boolean;
  busy: boolean;
  onContinue: (id: string) => void;
}) {
  if (message.role === "user") {
    return (
      <article className="msg user">
        <div className="msg-kicker">you {message.modeTag ? `· ${message.modeTag}` : ""}</div>
        <div className="msg-body">
          <MarkdownView text={message.content} />
        </div>
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
  const fence = fenceState(peeled.content);
  const resumable = !live && (message.truncated || tip);
  return (
    <article className={`msg assistant ${live ? "live" : ""}`}>
      <div className="msg-kicker">
        q38 {message.demo ? "· demo" : ""}{" "}
        {message.timings?.predicted_per_second
          ? `· ${message.timings.predicted_per_second.toFixed(1)} tok/s`
          : live
            ? "· streaming"
            : ""}
        {message.truncated && <span className="badge warn">cut at max_tokens</span>}
        {!!message.continues && <span className="badge">continued ×{message.continues}</span>}
        {fence.open && !live && peeled.content.trim() && (
          <span className="badge">open ```{fence.lang} block</span>
        )}
      </div>
      {peeled.reasoning ? (
        <Think text={peeled.reasoning} live={live && !peeled.content} />
      ) : null}
      {peeled.content ? <MarkdownView text={peeled.content} /> : live ? <span className="caret" /> : null}
      {message.error && <div className="err">{message.error}</div>}
      {resumable && (
        <div className="continue-row">
          <button
            type="button"
            className="linkish"
            disabled={busy}
            onClick={() => onContinue(message.id)}
            title={
              fence.open
                ? "Resume inside the open code block — the stub is sent back as a prefill"
                : "Resume the reply from its last token"
            }
          >
            {message.truncated ? "continue this reply" : "keep going"}
            {fence.open ? ` (inside \`\`\`${fence.lang})` : ""}
          </button>
          <span className="muted tiny">
            assistant prefill · falls back to a resume directive if the server refuses
          </span>
        </div>
      )}
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
      {open && (
        <div className="think-body">
          <MarkdownView text={text} />
        </div>
      )}
    </div>
  );
}
