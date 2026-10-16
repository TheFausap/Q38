import { useEffect, useMemo, useRef, useState } from "react";
import {
  CARD_TOKENS,
  cardState,
  consoleLines,
  formatClock,
  formatEta,
  formatRate,
  phaseLabel,
  type Phase,
} from "../lib/pacing";
import type { PromptProgress } from "../lib/types";

/**
 * The job console.
 *
 * A slow machine is not a broken machine. While a turn is being read — the first
 * pass after idle on a small GPU is the slow one — this shows the job being
 * accepted, the prompt read card by card (llama-server's own `prompt_progress`),
 * and the measured rate when the drum starts seeking. Everything on screen is a
 * number the server actually reported.
 */

export type PacingView = {
  phase: Phase;
  /** why the console reads the machine this way (surfaced in the inspector) */
  why: string;
  jobNo: number;
  startedAt: number;
  elapsedMs: number;
  stalledMs: number;
  progress: PromptProgress | null;
  progressSeen: boolean;
  ttfMs: number | null;
  rate: number | null;
  baseline: number | null;
  tokens: number;
  cold: boolean;
  loadingMs: number | null;
  queuedMs: number;
  /** the last disk move this job made (recall / archive), shown on the tape */
  mem?: string | null;
  /** the last web move this job made (search / page read) */
  web?: string | null;
};

function deckDepth(phase: Phase): number {
  if (phase === "loading") return 6;
  if (phase === "queued") return 5;
  if (phase === "reading") return 3;
  return 1;
}

export function JobConsole({
  view,
  onCancel,
  compact = false,
}: {
  view: PacingView;
  onCancel?: () => void;
  compact?: boolean;
}) {
  const cards = useMemo(() => cardState(view.progress), [view.progress]);
  const lines = useMemo(
    () =>
      consoleLines({
        phase: view.phase,
        elapsedMs: view.elapsedMs,
        progress: view.progress,
        rate: view.rate,
        baseline: view.baseline,
        ttfMs: view.ttfMs,
        cold: view.cold,
        jobNo: view.jobNo,
        tokens: view.tokens,
        progressSeen: view.progressSeen,
      }),
    [view],
  );

  if (compact) return <CompactBar view={view} lines={lines} />;

  const drum = view.phase === "paging" || view.phase === "loading";
  const reading = view.phase === "reading" || view.phase === "queued" || view.phase === "loading";

  return (
    <div className={`job-console phase-${view.phase}`}>
      <div className="jc-head">
        <span className="jc-lamp" aria-hidden="true" />
        <span className="jc-job">JOB {String(view.jobNo).padStart(4, "0")}</span>
        <span className="jc-state">{phaseLabel(view.phase).toUpperCase()}</span>
        <span className="grow" />
        {view.cold && <span className="jc-cold">COLD START</span>}
        <span className="jc-clock">{formatClock(view.elapsedMs)}</span>
        {onCancel && (
          <button type="button" className="icon-btn jc-cancel" onClick={onCancel}>
            cancel job
          </button>
        )}
      </div>

      <div className="jc-body">
        <div className={`jc-reader ${drum ? "drumming" : ""}`}>
          <div className="jc-deck" aria-hidden="true">
            {Array.from({ length: deckDepth(view.phase) }, (_, i) => (
              <span key={i} className="jc-deck-card" style={{ transform: `translateY(${i * 3}px)` }} />
            ))}
          </div>
          <div className="jc-slot" aria-hidden="true" />
          <Card
            jobNo={view.jobNo}
            punched={reading ? cards.punched : 0}
            total={cards.totalCards}
            index={cards.cardIndex}
            done={view.phase === "streaming" || view.phase === "paging"}
          />
          <div className="jc-drum" aria-hidden="true">
            <span />
          </div>
        </div>

        <div className="jc-figures">
          <div className="jc-figure">
            <span className="jc-label">cards read</span>
            <strong>
              {reading ? Math.min(cards.totalCards, cards.cardIndex) : cards.totalCards}
              <em> / {cards.totalCards}</em>
            </strong>
          </div>
          <div className="jc-figure">
            <span className="jc-label">read head</span>
            <strong>{view.progress ? `${(cards.pct * 100).toFixed(0)}%` : "—"}</strong>
          </div>
          <div className="jc-figure">
            <span className="jc-label">rate</span>
            <strong>{formatRate(view.rate)}<em> tok/s</em></strong>
          </div>
          <div className="jc-figure">
            <span className="jc-label">warm baseline</span>
            <strong>{view.baseline ? formatRate(view.baseline) : "—"}<em>{view.baseline ? " tok/s" : ""}</em></strong>
          </div>
          <div className="jc-figure">
            <span className="jc-label">{view.phase === "reading" ? "eta" : "first token"}</span>
            <strong>
              {view.phase === "reading"
                ? formatEta(cards.etaMs)
                : view.ttfMs != null
                  ? formatClock(view.ttfMs)
                  : "—"}
            </strong>
          </div>
          <div className="jc-figure">
            <span className="jc-label">tokens</span>
            <strong>{view.tokens || "—"}</strong>
          </div>
        </div>
      </div>

      <div className="jc-tape">
        {view.mem && (
          <div className="jc-line jc-mem">
            <span className="jc-stamp">{formatClock(view.elapsedMs)}</span>
            <span className="jc-text">{view.mem}</span>
          </div>
        )}
        {view.web && (
          <div className="jc-line jc-web">
            <span className="jc-stamp">{formatClock(view.elapsedMs)}</span>
            <span className="jc-text">{view.web}</span>
          </div>
        )}
        {lines.map((line, i) => (
          <div key={`${i}-${line}`} className={`jc-line ${i === lines.length - 1 ? "jc-line-live" : ""}`}>
            <span className="jc-stamp">{formatClock(view.elapsedMs)}</span>
            <span className="jc-text">{line}</span>
          </div>
        ))}
        <div className="jc-line jc-line-live">
          <span className="jc-stamp">{formatClock(view.elapsedMs)}</span>
          <span className="jc-text">
            <span className="jc-caret" />
          </span>
        </div>
      </div>
    </div>
  );
}

/** The 80-column card on the read head: holes punch in as tokens are read. */
function Card({
  jobNo,
  punched,
  total,
  index,
  done,
}: {
  jobNo: number;
  punched: number;
  total: number;
  index: number;
  done: boolean;
}) {
  const columns = CARD_TOKENS;
  const prev = useRef(punched);
  const [justPunched, setJustPunched] = useState(-1);

  useEffect(() => {
    if (punched > prev.current) setJustPunched(punched - 1);
    prev.current = punched;
  }, [punched]);

  return (
    <div className={`jc-card ${done ? "done" : ""}`}>
      <div className="jc-card-top">
        <span>Q38 · JOB {String(jobNo).padStart(4, "0")}</span>
        <span>
          CARD {index} / {total}
        </span>
      </div>
      <div className="jc-holes" role="img" aria-label={`${punched} of ${columns} columns punched`}>
        {Array.from({ length: columns }, (_, i) => (
          <span
            key={i}
            className={`jc-hole ${i < punched ? "punched" : ""} ${i === justPunched ? "just" : ""}`}
            style={i < punched ? { animationDelay: `${(i % 8) * 6}ms` } : undefined}
          />
        ))}
      </div>
      <div className="jc-card-bot">
        <span className="jc-card-cut" aria-hidden="true" />
        <span>
          {punched} / {columns} COL
        </span>
      </div>
    </div>
  );
}

function CompactBar({ view, lines }: { view: PacingView; lines: string[] }) {
  const cards = cardState(view.progress);
  return (
    <div className="pager-bar">
      <span className="pager-drum" aria-hidden="true">
        <i />
      </span>
      <div className="pager-text">
        <div className="pager-head">{lines[0]}</div>
        <div className="pager-sub">
          {lines[1] ?? `${formatRate(view.rate)} tok/s`}
          {view.phase === "reading" && view.progress
            ? ` · card ${cards.cardIndex}/${cards.totalCards}`
            : ""}
        </div>
      </div>
      <span className="grow" />
      <span className="pager-clock">{formatClock(view.elapsedMs)}</span>
    </div>
  );
}

/** Tiny always-on indicator for the top bar while a job is in flight. */
export function JobPip({ phase, elapsedMs }: { phase: Phase; elapsedMs: number }) {
  return (
    <span className={`job-pip phase-${phase}`} title={`${phaseLabel(phase)} · ${formatClock(elapsedMs)}`}>
      <i />
      <span>{phaseLabel(phase)}</span>
      <em>{formatClock(elapsedMs)}</em>
    </span>
  );
}
