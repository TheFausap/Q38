import { useMemo, useState, useEffect, useRef } from "react";
import { formatPct, formatTokens, compactionNetSavings, type ContextUsage } from "../lib/context";
import { familyLabel, modeById, reasonTag } from "../lib/modes";
import { isBusyPhase } from "../lib/pacing";
import { JobConsole, type PacingView } from "./Punchcard";
import { fenceState } from "../lib/summarize";
import { ArchiveCard } from "./Memory";
import type { ArchiveRef, Attachment, ChatMessage, Compaction, ModeFamily, Session } from "../lib/types";
import { MarkdownView } from "./MarkdownView";
import { stripToolMarkup } from "../lib/textcalls";
import type { RoundTrace } from "../lib/types";
import { activeWebText } from "../lib/web";

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
  webActive,
  archives,
  held,
  memRoot,
  memBusy,
  onPullBack,
  onRelease,
  onForget,
  onUnarchive,
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
  webActive: { kind: "search" | "open" | "skill" | "library"; label: string } | null;
  archives: ArchiveRef[];
  held: string[];
  memRoot: string;
  memBusy: string | null;
  onPullBack: (id: string) => void;
  onRelease: (id: string) => void;
  onForget: (id: string) => void;
  onUnarchive: () => void;
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
  /** Where the window starts: the cut is an archive when there is one, else a fold. */
  const cutIndex = useMemo(() => {
    const boundary = archives.length ? archives[archives.length - 1].toId : active?.upToId;
    if (!boundary) return -1;
    return session.messages.findIndex((m) => m.id === boundary);
  }, [archives, active, session.messages]);

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
          const hidden = cutIndex >= 0 && i <= cutIndex;
          const card = cutIndex >= 0 && i === cutIndex + 1;
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
              {card && active && !archives.length && (
                <FoldCard
                  compaction={active}
                  index={compactions.length - 1}
                  onUnfold={onUnfold}
                  disabled={!!streamingId}
                />
              )}
              {card && archives.length > 0 && (
                <ArchiveCard
                  chunks={archives}
                  held={held}
                  root={memRoot}
                  busy={memBusy}
                  onPullBack={onPullBack}
                  onRelease={onRelease}
                  onForget={onForget}
                  onUnarchive={onUnarchive}
                  disabled={!!streamingId}
                />
              )}
              {!hidden && (m.recalled || m.searched || m.opened || m.skillsRead?.length || m.docsUsed?.length) ? (
                <div className="mem-hop">
                  {[
                    m.recalled
                      ? `⇄ read ${m.recalled === 1 ? "a chunk" : `${m.recalled} chunks`} back off the disk`
                      : "",
                    m.searched ? `⇄ searched the web ×${m.searched}` : "",
                    m.opened ? `⇄ opened ${m.opened} page${m.opened === 1 ? "" : "s"}` : "",
                    m.skillsRead?.length
                      ? `⇄ consulted ${m.skillsRead.length === 1 ? "a skill" : `${m.skillsRead.length} skills`}`
                      : "",
                    m.docsUsed?.length
                      ? `⇄ used ${m.docsUsed.length === 1 ? "a library document" : `${m.docsUsed.length} library documents`}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              ) : null}
              {!hidden && m.role === "assistant" && m.trace && showTrace(m.trace) ? <TurnTrace trace={m.trace} /> : null}
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
        {/* The model stopped talking to go and look something up. Without this the
            turn reads as stalled exactly while it is working hardest. */}
        {webActive && (
          <div className="web-live" role="status" aria-live="polite">
            <span className="web-live-dot" aria-hidden="true" />
            <span className="web-live-text">{activeWebText(webActive)}</span>
            <span className="web-live-note">waiting on the network</span>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="chips">
            {attachments.map((a) => (
              <button
                key={a.path}
                type="button"
                className={`chip ${a.unstored ? "unstored" : ""}`}
                onClick={() => onDetach(a.path)}
                title={
                  a.unstored
                    ? "Pinned to this turn only — it was not written into ./workspace (the API was unreachable)"
                    : "Unpin"
                }
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

/** The host of a source, for the chip: the reader cares more about the site
 *  than about the path, and the whole URL is in the tooltip. */
function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "link";
  }
}

function MessageView({
  message,
  live,
  busy,
  onContinue,
}: {
  message: ChatMessage;
  live: boolean;
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
  /* a tool call the model writes as text is run, not read: keep its markup off the page */
  const peeled = peelThink(stripToolMarkup(message.content), message.reasoning);
  const fence = fenceState(peeled.content);
  /* Only offer a resume where the reply demonstrably stopped short: the server
     said max_tokens, or the text ends inside an open code block. A reply that
     finished cleanly gets no button — "keep going" on a complete answer reads
     as if something went wrong. */
  const resumable = !live && (message.truncated || fence.open);
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
        {!!message.searched && <span className="badge web">searched ×{message.searched}</span>}
        {!!message.opened && <span className="badge web">read {message.opened} page{message.opened === 1 ? "" : "s"}</span>}
        {message.docsUsed?.map((d) => (
          <span key={`doc-${d}`} className="badge web" title={d}>
            doc · {d.length > 40 ? `${d.slice(0, 39)}…` : d}
          </span>
        ))}
        {message.skillsRead?.map((s) => (
          <span key={s} className="badge web" title="skill read for this reply">
            skill · {s}
          </span>
        ))}
        {fence.open && !live && peeled.content.trim() && (
          <span className="badge">open ```{fence.lang} block</span>
        )}
      </div>
      {peeled.reasoning ? (
        <Think text={peeled.reasoning} live={live && !peeled.content} />
      ) : null}
      {peeled.content ? <MarkdownView text={peeled.content} /> : live ? <span className="caret" /> : null}
      {message.sources && message.sources.length > 0 && (
        <div className="web-sources">
          <span className="web-sources-head">read this turn</span>
          {message.sources.map((source) => (
            <a
              key={source.url}
              className="web-source"
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              title={source.url}
            >
              <span className="web-source-host">{sourceHost(source.url)}</span>
              <span className="web-source-title">{source.title}</span>
            </a>
          ))}
        </div>
      )}
      {message.error && <div className="err">{message.error}</div>}
      {resumable && (
        <div className="continue-row">
          <button
            type="button"
            className="linkish"
            disabled={busy}
            onClick={() => onContinue(message.id)}
            title={
              message.truncated
                ? "The reply hit max_tokens — resume it from its last token"
                : "The reply ends inside an open code block — resume it"
            }
          >
            {message.truncated ? "continue this reply" : "finish the code block"}
            {!message.truncated && fence.open ? ` (inside \`\`\`${fence.lang})` : ""}
          </button>
          <span className="muted tiny">
            {message.truncated
              ? "stopped at max_tokens · the cut-off text goes back as an assistant prefill"
              : "the reply stops inside an open code block · it resumes from the last token"}
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

/** Worth showing: more than one round, or a round that went oddly. */
function showTrace(trace: RoundTrace[]): boolean {
  return trace.length > 1 || trace.some((r) => r.via || r.note || r.reason === "length" || (!r.text && !r.calls.length));
  /* (an empty round is exactly what someone debugging a stalled turn needs to see) */
}

function kchars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Round by round: how each ended, what it called, how much it said and thought. */
function TurnTrace({ trace }: { trace: RoundTrace[] }) {
  const calls = trace.reduce((n, r) => n + r.calls.length, 0);
  return (
    <details className="turn-trace">
      <summary>
        turn trace · {trace.length} round{trace.length === 1 ? "" : "s"}
        {calls ? ` · ${calls} tool call${calls === 1 ? "" : "s"}` : ""}
      </summary>
      <ol>
        {trace.map((r, i) => {
          const counted = r.calls.reduce<Record<string, number>>((acc, c) => ((acc[c] = (acc[c] ?? 0) + 1), acc), {});
          const called = Object.entries(counted).map(([c, n]) => (n > 1 ? `${c} ×${n}` : c)).join(", ");
          return (
            <li key={i}>
              <span className={r.reason === "length" ? "hot" : ""}>{r.reason}</span>
              {called ? ` → ${called}` : ""}
              {r.via ? ` (written in its ${r.via === "thinking" ? "thinking" : "reply text"})` : ""}
              {` · ${kchars(r.text)} text · ${kchars(r.thinking)} thinking`}
              {r.generated != null ? ` · ${r.generated} tok generated` : ""}
              {r.prompt != null ? ` of a ${r.prompt}-tok prompt` : ""}
              {!r.text && !r.calls.length ? " · said nothing" : ""}
              {r.note ? <em> — {r.note}</em> : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
