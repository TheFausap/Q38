import type { PromptProgress } from "./types";

/**
 * Pacing: what the workbench says while the model is swapping, loading or
 * simply slow. Nothing here is invented — every phase is derived from
 * llama-server's own signals (503 "Loading model", `prompt_progress` events,
 * `timings.predicted_per_second`) so the console can promise the job is alive
 * without lying about it.
 */

const PACE_KEY = "q38.pacing.v1";

/** What the machine has taught us: how fast it is when warm, and how it behaved. */
export type PaceStats = {
  /** warm decode baseline, tokens/s */
  baseline: number | null;
  lastTtfMs: number | null;
  lastRate: number | null;
  jobs: number;
  pagedJobs: number;
};

export const EMPTY_PACE: PaceStats = {
  baseline: null,
  lastTtfMs: null,
  lastRate: null,
  jobs: 0,
  pagedJobs: 0,
};

export function loadPaceStats(): PaceStats {
  try {
    const raw = localStorage.getItem(PACE_KEY);
    if (!raw) return { ...EMPTY_PACE };
    const parsed = JSON.parse(raw) as Partial<PaceStats>;
    return { ...EMPTY_PACE, ...parsed };
  } catch {
    return { ...EMPTY_PACE };
  }
}

export function savePaceStats(stats: PaceStats) {
  try {
    localStorage.setItem(PACE_KEY, JSON.stringify(stats));
  } catch {
    /* quota */
  }
}

/** One 80-column card of context. The prompt is read one card at a time. */
export const CARD_TOKENS = 80;

export type Phase =
  | "idle" /* nothing in flight */
  | "loading" /* llama-server is loading the model: the job is queued */
  | "queued" /* accepted, nothing read yet */
  | "reading" /* prefill running — cards being punched */
  | "streaming" /* decoding at a healthy rate */
  | "paging"; /* decoding, but far below the warm baseline */

export type PacingConfig = {
  /** decode rate below this fraction of the warm baseline reads as paging */
  pagingFactor: number;
  /** no token for this long while decoding reads as paging */
  stallSeconds: number;
  /** grace period before a silent request is called slow */
  queuedGraceSeconds: number;
};

export const DEFAULT_PACING: PacingConfig = {
  pagingFactor: 0.45,
  stallSeconds: 4,
  queuedGraceSeconds: 6,
};

export type PhaseInput = {
  /** a turn is in flight */
  active: boolean;
  /** server said it is loading the model */
  loading: boolean;
  hasFirstToken: boolean;
  hasProgress: boolean;
  progressDone: boolean;
  /** recent decode rate, tokens/s */
  rate: number | null;
  /** warm baseline, tokens/s */
  baseline: number | null;
  /** ms since the last token (or since the job started, before any token) */
  msSinceToken: number;
  msSinceStart: number;
};

export type PhaseVerdict = { phase: Phase; why: string };

export function classifyPhase(input: PhaseInput, cfg: PacingConfig = DEFAULT_PACING): PhaseVerdict {
  if (!input.active) return { phase: "idle", why: "no job in flight" };
  if (input.loading) return { phase: "loading", why: "llama-server is loading the model" };

  if (input.hasFirstToken) {
    const stallMs = cfg.stallSeconds * 1000;
    if (input.msSinceToken > stallMs) {
      return {
        phase: "paging",
        why: `no token for ${(input.msSinceToken / 1000).toFixed(1)}s — the weights are paging back in`,
      };
    }
    if (input.rate != null && input.baseline != null && input.baseline > 0) {
      const ratio = input.rate / input.baseline;
      if (ratio < cfg.pagingFactor) {
        return {
          phase: "paging",
          why: `${input.rate.toFixed(1)} tok/s against a ${input.baseline.toFixed(1)} tok/s warm baseline`,
        };
      }
    }
    return { phase: "streaming", why: "decoding at a working pace" };
  }

  if (input.hasProgress && !input.progressDone) {
    return { phase: "reading", why: "the prompt is being read card by card" };
  }
  if (input.msSinceStart > cfg.queuedGraceSeconds * 1000) {
    return {
      phase: "queued",
      why: `no answer for ${(input.msSinceStart / 1000).toFixed(0)}s — the first pass after idle is the slow one`,
    };
  }
  return { phase: "queued", why: "the deck was accepted" };
}

export function isBusyPhase(phase: Phase): boolean {
  return phase === "loading" || phase === "queued" || phase === "reading";
}

/* ------------------------------------------------------------------ cards */

export type CardState = {
  totalCards: number;
  /** 1-based card on the read head */
  cardIndex: number;
  /** columns punched on the current card (0..CARD_TOKENS) */
  punched: number;
  /** alternate spelling for templates */
  pct: number;
  /** tokens/s while reading */
  readRate: number | null;
  etaMs: number | null;
};

export function cardState(progress: PromptProgress | null): CardState {
  if (!progress || progress.total <= 0) {
    return { totalCards: 1, cardIndex: 1, punched: 0, pct: 0, readRate: null, etaMs: null };
  }
  const totalCards = Math.max(1, Math.ceil(progress.total / CARD_TOKENS));
  const done = Math.max(0, Math.min(progress.total, progress.processed));
  const cardIndex = Math.min(totalCards, Math.floor(done / CARD_TOKENS) + 1);
  const punched = done >= progress.total ? CARD_TOKENS : done % CARD_TOKENS;
  const fresh = Math.max(0, done - Math.max(0, progress.cache));
  const readRate = progress.time_ms > 0 ? (fresh / progress.time_ms) * 1000 : null;
  const remaining = Math.max(0, progress.total - done);
  const etaMs = readRate && readRate > 0 ? (remaining / readRate) * 1000 : null;
  return {
    totalCards,
    cardIndex,
    punched,
    pct: done / progress.total,
    readRate,
    etaMs,
  };
}

/* --------------------------------------------------------------- baseline */

/**
 * Keep a warm baseline so "slow" means slow *for this machine*. Slow samples
 * never drag the baseline down — otherwise a session that spent its life
 * swapping would stop noticing that it is swapping.
 */
export function updateBaseline(prev: number | null, sample: number, alpha = 0.3): number | null {
  if (!Number.isFinite(sample) || sample <= 0.2 || sample > 5000) return prev;
  if (prev == null) return sample;
  if (sample < prev * 0.5) return prev;
  return prev * (1 - alpha) + sample * alpha;
}

export function baselineRatio(rate: number | null, baseline: number | null): number | null {
  if (rate == null || baseline == null || baseline <= 0) return null;
  return rate / baseline;
}

/* -------------------------------------------------------------- the clock */

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

export function formatEta(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return "<1s";
  return formatClock(ms);
}

export function formatRate(rate: number | null): string {
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return "—";
  if (rate < 10) return rate.toFixed(1);
  return rate.toFixed(0);
}

/* ------------------------------------------------------------ the ticker */

export type JobInput = {
  startedAt: number;
  firstTokenAt: number | null;
  lastTokenAt: number | null;
  tokens: number;
  /** rolling {at, tokens} samples from the live stream */
  samples: { at: number; tokens: number }[];
  progress: PromptProgress | null;
  serverLoading: boolean;
};

export type JobTick = {
  phase: Phase;
  why: string;
  elapsedMs: number;
  stalledMs: number;
  rate: number | null;
  ttfMs: number | null;
  tokens: number;
};

/** Shortest stretch we will call a rate: anything less is noise. */
export const MIN_RATE_SPAN_MS = 500;

/**
 * Decode rate over a sliding window, measured client-side from the tokens
 * arriving in the stream. Falls back to the last two samples while the window
 * is still filling, and refuses to answer from stale history — a rate averaged
 * over a stall says nothing about the machine right now.
 */
export function recentRate(
  samples: { at: number; tokens: number }[],
  now: number,
  windowMs = 6000,
): number | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  const inWindow = samples.filter((x) => x.at >= now - windowMs);
  const first = inWindow.length >= 2 ? inWindow[0] : samples[Math.max(0, samples.length - 2)];
  if (!first || first === last) return null;
  const span = last.at - first.at;
  const delta = last.tokens - first.tokens;
  if (span < MIN_RATE_SPAN_MS || delta <= 0) return null;
  if (span > windowMs * 3) return null;
  return (delta / span) * 1000;
}

export function planJobTick(
  job: JobInput,
  now: number,
  cfg: { baseline: number | null; pagingFactor: number; stallSeconds: number; queuedGraceSeconds: number },
): JobTick {
  const elapsedMs = Math.max(0, now - job.startedAt);
  const msSinceToken = Math.max(0, now - (job.lastTokenAt ?? job.startedAt));
  const rate = recentRate(job.samples, now);
  const ttfMs = job.firstTokenAt != null ? Math.max(0, job.firstTokenAt - job.startedAt) : null;
  const progressDone = job.progress != null && job.progress.processed >= job.progress.total;

  const verdict = classifyPhase(
    {
      active: true,
      loading: job.serverLoading,
      hasFirstToken: job.firstTokenAt != null,
      hasProgress: job.progress != null,
      progressDone,
      rate,
      baseline: cfg.baseline,
      msSinceToken,
      msSinceStart: elapsedMs,
    },
    {
      pagingFactor: cfg.pagingFactor,
      stallSeconds: cfg.stallSeconds,
      queuedGraceSeconds: cfg.queuedGraceSeconds,
    },
  );

  return {
    phase: verdict.phase,
    why: verdict.why,
    elapsedMs,
    stalledMs: verdict.phase === "paging" ? msSinceToken : 0,
    rate,
    ttfMs,
    tokens: job.tokens,
  };
}

/* ------------------------------------------------------------- the console */

export type ConsoleInput = {
  phase: Phase;
  elapsedMs: number;
  progress: PromptProgress | null;
  rate: number | null;
  baseline: number | null;
  ttfMs: number | null;
  cold: boolean;
  jobNo: number;
  tokens: number;
  progressSeen: boolean;
};

/**
 * Retro job-console lines. Kept to what is actually happening: a job number,
 * the cards being read, the measured rate, and the delay when the machine is
 * paging. The point is that the operator can see the job is alive.
 */
export function consoleLines(input: ConsoleInput): string[] {
  const cards = cardState(input.progress);
  const lines: string[] = [];
  const rate = formatRate(input.rate);
  const base = formatRate(input.baseline);

  if (input.phase === "loading") {
    lines.push(`MODEL LOADING INTO CORE — JOB ${pad4(input.jobNo)} QUEUED`);
    lines.push("MOUNTING VOLUME · DO NOT RESET THE CONSOLE");
    lines.push("THE OPERATOR WILL SEE THE FIRST CARD WHEN READING BEGINS");
    return lines;
  }

  if (input.phase === "queued") {
    lines.push(`IEF403I Q38 JOB ${pad4(input.jobNo)} ACCEPTED — CARD DECK LOADED`);
    if (input.cold) {
      lines.push(`COLD START · IDLE ${formatClock(input.elapsedMs)} — THE WEIGHTS PAGE BACK IN`);
      lines.push("FIRST PASS IS THE SLOW ONE · FEEDING CARDS");
    } else {
      lines.push("READ HEAD ADVANCING · NO CARDS READ YET");
    }
    return lines;
  }

  if (input.phase === "reading") {
    lines.push(
      `CARDS READ ${Math.min(cards.totalCards, cards.cardIndex)} / ${cards.totalCards} · READ HEAD ON CARD ${cards.cardIndex}`,
    );
    if (input.progress) {
      lines.push(
        `PREFILL ${(cards.pct * 100).toFixed(0)}% · ${input.progress.processed} OF ${input.progress.total} TOKENS` +
          (input.progress.cache > 0 ? ` (${input.progress.cache} FROM CACHE)` : ""),
      );
    }
    if (cards.readRate) lines.push(`READING AT ${formatRate(cards.readRate)} TOK/S · ETA ${formatEta(cards.etaMs)}`);
    else lines.push("READ HEAD WARMING · MEASURING THROUGHPUT");
    return lines;
  }

  if (input.phase === "paging") {
    lines.push("PAGING FROM DRUM — EXPECT DELAY");
    lines.push(`DECODING ${rate} TOK/S${input.baseline ? ` · WARM BASELINE ${base} TOK/S` : ""}`);
    lines.push(`${input.tokens} TOKENS SPOOLED · ${formatClock(input.elapsedMs)} OF WALL CLOCK`);
    if (input.ttfMs != null) lines.push(`FIRST OUTPUT AFTER ${formatClock(input.ttfMs)} — THEN THE SWAP`);
    return lines;
  }

  // streaming
  lines.push(`PRINT TRAIN RUNNING · ${rate} TOK/S`);
  lines.push(`${input.tokens} TOKENS SPOOLED`);
  if (input.ttfMs != null) lines.push(`RECORDED FIRST OUTPUT AT ${formatClock(input.ttfMs)}`);
  return lines;
}

function pad4(n: number): string {
  return String(Math.max(0, Math.floor(n)) % 10000).padStart(4, "0");
}

/** Headline for the compact bar that shows while decoding slowly. */
export function pagingHeadline(input: {
  rate: number | null;
  baseline: number | null;
  stalledMs: number;
}): string {
  if (input.stalledMs > 0) {
    return `PAGING · NO TOKEN FOR ${(input.stalledMs / 1000).toFixed(1)}s — THE DRUM IS SEEKING`;
  }
  const rate = formatRate(input.rate);
  if (input.baseline) {
    return `PAGING FROM DRUM · ${rate} TOK/S AGAINST ${formatRate(input.baseline)} WARM`;
  }
  return `PAGING FROM DRUM · ${rate} TOK/S — SLOW BUT TURNING`;
}

/** Short state word for the top-bar pill. */
export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "loading":
      return "warming";
    case "queued":
      return "queueing";
    case "reading":
      return "reading cards";
    case "paging":
      return "paging";
    case "streaming":
      return "decoding";
    default:
      return "idle";
  }
}
