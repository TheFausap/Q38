import type { Attachment, ChatMessage, Compaction, Sampling, Settings } from "./types";

/**
 * Token accounting for the workbench.
 *
 * It is deliberately an estimate: the browser has no tokenizer for the model, and
 * llama-server is not asked on every keystroke. Everything here errs on the safe
 * side (rounds up), and the Setup panel can measure the exact count through
 * llama-server's /tokenize when accuracy matters.
 */

/** Mixed prose + code sits around 3.5–4 chars per token for Qwen-class vocabularies. */
export const CHARS_PER_TOKEN = 3.6;
/** Used when /props has no n_ctx and the user did not set one. */
export const FALLBACK_CONTEXT = 24_576;
/** Per-message chat-template scaffolding (<|im_start|>role … <|im_end|>). */
export const MESSAGE_OVERHEAD = 6;
/** Headroom for template drift and the safety margin of the BOS/CRLF of a long turn. */
export const TEMPLATE_MARGIN = 192;

export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function attachmentTokens(a: Attachment): number {
  return estimateTokens(a.path) + estimateTokens(a.content) + 24;
}

export function messageTokens(m: ChatMessage): number {
  let n = MESSAGE_OVERHEAD + estimateTokens(m.content);
  for (const a of m.attachments ?? []) n += attachmentTokens(a);
  return n;
}

export function messagesTokens(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += messageTokens(m);
  return n;
}

export type BudgetSource = "props" | "settings" | "fallback";

export type ContextBudget = {
  /** total window the server was started with */
  nCtx: number;
  source: BudgetSource;
  /** tokens held back for the reply (max_tokens) */
  reserve: number;
  margin: number;
  /** prompt tokens allowed before we are stealing from the reply */
  budget: number;
};

/** /props exposes the slot window in a couple of shapes depending on the build. */
export function contextFromProps(props: Record<string, unknown> | null): number | null {
  if (!props) return null;
  const dg = props.default_generation_settings as Record<string, unknown> | undefined;
  const candidates = [dg?.n_ctx, props.n_ctx, props.n_ctx_per_seq, props.slot_n_ctx];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 512) return Math.floor(c);
  }
  return null;
}

export function contextSourceLabel(source: BudgetSource, props: Record<string, unknown> | null): string {
  if (source === "settings") return "manual override";
  if (source === "props") return "llama-server /props";
  return props ? "fallback (no n_ctx in /props)" : "fallback (server offline)";
}

export function resolveBudget(
  settings: Settings,
  sampling: Sampling,
  props: Record<string, unknown> | null,
): ContextBudget {
  const fromProps = contextFromProps(props);
  const manual = settings.contextSize > 0 ? Math.floor(settings.contextSize) : 0;
  const nCtx = manual || fromProps || FALLBACK_CONTEXT;
  const source: BudgetSource = manual ? "settings" : fromProps ? "props" : "fallback";
  const reserve = Math.max(0, Math.round(sampling.max_tokens));
  const budget = Math.max(512, nCtx - reserve - TEMPLATE_MARGIN);
  return { nCtx, source, reserve, margin: TEMPLATE_MARGIN, budget };
}

export type ContextUsage = {
  budget: ContextBudget;
  /** what the next request will cost in prompt tokens */
  used: number;
  /** used / budget, may exceed 1 */
  pct: number;
  over: number;
  systemTokens: number;
  summaryTokens: number;
  historyTokens: number;
  messages: number;
  foldedMessages: number;
};

export function measureContext(opts: {
  /** the unfolded messages that will be sent */
  messages: ChatMessage[];
  /** compaction briefs injected as system turns */
  summaries?: string[];
  settings: Settings;
  sampling: Sampling;
  props: Record<string, unknown> | null;
  foldedMessages?: number;
}): ContextUsage {
  const { messages, summaries = [], settings, sampling, props } = opts;
  const budget = resolveBudget(settings, sampling, props);
  const systemTokens = estimateTokens(settings.systemPrompt) + MESSAGE_OVERHEAD;
  const summaryTokens = summaries.reduce((n, s) => n + estimateTokens(s) + MESSAGE_OVERHEAD, 0);
  const historyTokens = messagesTokens(messages);
  const used = systemTokens + summaryTokens + historyTokens;
  return {
    budget,
    used,
    pct: budget.budget > 0 ? used / budget.budget : 0,
    over: Math.max(0, used - budget.budget),
    systemTokens,
    summaryTokens,
    historyTokens,
    messages: messages.length,
    foldedMessages: opts.foldedMessages ?? 0,
  };
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatPct(pct: number): string {
  return `${Math.round(pct * 100)}%`;
}

/** The active brief is always the newest fold; older ones are already folded inside it. */
export function activeCompaction(session: { compactions?: Compaction[] }): Compaction | undefined {
  const all = session.compactions ?? [];
  return all.length ? all[all.length - 1] : undefined;
}

/** Everything after the fold boundary — the messages that still travel verbatim. */
export function unfoldedMessages(messages: ChatMessage[], compaction?: Compaction): ChatMessage[] {
  if (!compaction) return messages;
  const cut = messages.findIndex((m) => m.id === compaction.upToId);
  if (cut < 0) return messages;
  return messages.slice(cut + 1);
}

export function compactionBriefText(c: Compaction): string {
  const when = new Date(c.at).toLocaleString();
  const by = c.source === "model" ? "written by the model" : "local extract (llama-server was offline)";
  return [
    `## Folded context — ${c.foldedMessages} earlier messages`,
    `Compacted ${when}, ${by}. Everything below happened before the messages that follow; treat it as verbatim history and do not ask the user to repeat it.`,
    "",
    c.summary,
  ].join("\n");
}

export function compactionNetSavings(c: Compaction): number {
  return c.tokensBefore - c.tokensAfter;
}

export type FoldPlan = {
  /** messages replaced by the brief */
  head: ChatMessage[];
  /** messages kept verbatim */
  tail: ChatMessage[];
  /** last folded message (the transcript anchor for the fold card) */
  boundaryId: string;
};

/**
 * Split the transcript into "fold" and "keep" halves. The tail starts on a user
 * turn so a brief never separates an answer from the prompt that caused it.
 */
export function planFold(messages: ChatMessage[], keepTail: number): FoldPlan | null {
  if (messages.length < 3) return null;
  const keep = Math.max(2, Math.floor(keepTail) || 2);
  let i = Math.max(0, messages.length - keep);
  while (i > 0 && messages[i].role !== "user") i--;
  if (i <= 0) return null;
  const head = messages.slice(0, i);
  const tail = messages.slice(i);
  const boundaryId = head[head.length - 1]?.id;
  if (!boundaryId || !head.length) return null;
  return { head, tail, boundaryId };
}

/** Would folding buy us anything right now? */
export function canFold(messages: ChatMessage[], settings: Settings): boolean {
  return planFold(messages, settings.keepTailMessages) !== null;
}

export type FoldTrigger = {
  fold: boolean;
  pct: number;
  reason: string;
};

export function shouldAutoCompact(usage: ContextUsage, settings: Settings, foldable: boolean): FoldTrigger {
  if (!settings.autoCompact) {
    return { fold: false, pct: usage.pct, reason: "auto-compact off" };
  }
  if (usage.pct < settings.compactAt) {
    return { fold: false, pct: usage.pct, reason: `under ${formatPct(settings.compactAt)} threshold` };
  }
  if (!foldable) {
    return { fold: false, pct: usage.pct, reason: "window full but the transcript is one turn — nothing to fold" };
  }
  return { fold: true, pct: usage.pct, reason: `crossed ${formatPct(settings.compactAt)} of the window` };
}
