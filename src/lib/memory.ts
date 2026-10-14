import type { ArchiveRef, ChatMessage } from "./types";

/**
 * Memories out of the window.
 *
 * When the transcript no longer fits, the oldest turns are moved to disk as
 * chunks and replaced by one line each — a register. The window keeps the
 * indexes; the bodies come back only when something asks for them.
 *
 * Nothing here talks to the network or to storage: this module decides *what*
 * to evict and *what* to pull back. The routing lives in the server, the
 * reading and writing in api.ts, and the decisions in App.tsx.
 */

/** Terms too common to say anything about what a chunk is about. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "then", "than",
  "you", "your", "our", "are", "was", "were", "will", "would", "should", "could",
  "can", "not", "but", "all", "any", "out", "get", "got", "has", "have", "had",
  "how", "what", "when", "where", "which", "who", "why", "its", "it's", "just",
  "like", "make", "made", "use", "using", "used", "one", "two", "also", "more",
  "most", "some", "such", "them", "they", "these", "those", "there", "here",
  "about", "after", "before", "again", "still", "only", "over", "under", "other",
  "want", "need", "let", "lets", "please", "thanks", "test", "tests", "code",
  "file", "files", "line", "lines", "case", "cases", "work", "works", "new",
  "add", "added", "run", "runs", "see", "look", "looks", "good", "fine", "now",
]);

/** Paths, symbols and quoted strings are the anchors a coder actually greps for. */
export function extractTerms(text: string): string[] {
  const out = new Set<string>();
  if (!text) return [];
  /* The {REASON:coder} mode tag is injected by the app into every user turn and
     into nothing else. It is boilerplate, not topic: left in, "coder" and
     "reason" appear in the query *and* inside every archived chunk, so every
     turn would match every chunk. Strip markers before reading anything. */
  text = text.replace(/\{[A-Za-z]+:[^}]*\}/g, " ");
  const add = (t: string) => {
    const v = t.trim().toLowerCase();
    if (v.length < 3 || v.length > 60 || STOPWORDS.has(v)) return;
    out.add(v);
  };

  // paths: src/lib/api.ts, ./server/api.mjs, workspace/src/http.ts
  for (const m of text.matchAll(/[\w.@-]+(?:\/[\w.@-]+)+/g)) {
    add(m[0]);
    const base = m[0].split("/").pop();
    if (base) add(base);
  }
  // identifiers: camelCase, PascalCase, snake_case, kebab-case, dotted
  for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:[._-][A-Za-z0-9_]+)+\b/g)) add(m[0]);
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g)) {
    add(m[0]);
    for (const part of m[0].split(/(?=[A-Z])/)) add(part);
  }
  // quoted and fenced fragments
  for (const m of text.matchAll(/[`"']([^`"'\n]{3,50})[`"']/g)) add(m[1]);
  // plain words, once stopwords and length are handled
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) add(m[0]);

  return [...out].slice(0, 160);
}

/** Does this term look like a path or a symbol rather than an English word? */
function isAnchor(term: string): boolean {
  return /[/._-]/.test(term) || /[a-z][A-Z]/.test(term) || /^\d+$/.test(term);
}

/**
 * The one line a chunk keeps in the window. Mechanical — no model call, so it
 * cannot be wrong, and it costs about thirty tokens.
 */
export function registerLine(ref: {
  id: string;
  seq: number;
  label: string;
  paths: string[];
  tokens: number;
  count: number;
}): string {
  const label = ref.label.replace(/\s+/g, " ").trim().slice(0, 64) || "conversation";
  const where = ref.paths.slice(0, 3).join(" ");
  return [
    `#${ref.seq}`,
    `"${label}"`,
    where,
    `${ref.count} msg`,
    `${(ref.tokens / 1000).toFixed(1)}k tok`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Paths mentioned anywhere in a chunk, most frequent first. */
export function pathsIn(text: string, limit = 4): string[] {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/[\w.@-]+(?:\/[\w.@-]+)+/g)) {
    const p = m[0].replace(/^\.\//, "");
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([p]) => p);
}

/** The first user line of a chunk — what the turn was actually about. */
export function labelFor(messages: ChatMessage[]): string {
  const user = messages.find((m) => m.role === "user" && m.content.trim());
  const raw = (user?.content || messages[0]?.content || "").replace(/\s+/g, " ").trim();
  return raw.replace(/^\{REASON:[a-z]+\}\s*/i, "").slice(0, 120);
}

/** Everything the register needs about a chunk, worked out from its messages. */
export function describeChunk(messages: ChatMessage[], tokens: number) {
  const joined = messages.map((m) => `${m.content}\n${m.reasoning || ""}`).join("\n");
  return {
    label: labelFor(messages),
    paths: pathsIn(joined),
    terms: extractTerms(joined),
    tokens,
  };
}

/** The block that stands in for everything on disk. */
export function registerText(refs: ArchiveRef[]): string {
  if (!refs.length) return "";
  const total = refs.reduce((n, r) => n + r.tokens, 0);
  const lines = refs
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((r) => r.register);
  return [
    `## Archive — ${refs.length} chunk${refs.length === 1 ? "" : "s"} out of the window (${(
      total / 1000
    ).toFixed(1)}k tokens)`,
    "These turns happened earlier in this session. The bodies are on disk, not in this",
    "window: every line below is exact, not a paraphrase. If you need one, say which",
    "(by number or by subject) and it will be recalled verbatim.",
    "",
    ...lines,
  ].join("\n");
}

export type RecallPlan = {
  /** chunk ids, oldest first so the prompt prefix stays stable */
  ids: string[];
  /** tokens the recalled bodies add to the window */
  tokens: number;
  /** why these, for the transcript and the inspector */
  why: string;
};

/**
 * Pick the chunks a turn is likely to need. Lexical on purpose: paths and
 * symbols are what a coder greps for, matching them by hand beats a fuzzy score
 * for this workload, and it costs nothing to run.
 */
export function planRecall(opts: {
  query: string;
  refs: ArchiveRef[];
  budgetTokens: number;
  maxChunks?: number;
  /** never re-recall what is already in the window */
  exclude?: string[];
}): RecallPlan {
  const { query, refs, budgetTokens } = opts;
  const excluded = new Set(opts.exclude ?? []);
  const maxChunks = opts.maxChunks ?? 3;
  const candidates = refs.filter((r) => !excluded.has(r.id));
  if (!candidates.length || budgetTokens <= 0) return { ids: [], tokens: 0, why: "nothing to recall" };

  const qTerms = [...new Set(extractTerms(query))];
  if (!qTerms.length) return { ids: [], tokens: 0, why: "the turn has no words to match on" };

  const df = new Map<string, number>();
  for (const r of candidates) {
    for (const t of new Set(r.terms)) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = candidates.length;

  const scored = candidates.map((r) => {
    const terms = new Set(r.terms);
    const label = r.label.toLowerCase();
    let score = 0;
    const hits: string[] = [];
    for (const t of qTerms) {
      if (!terms.has(t)) continue;
      // a term in few chunks says more than a term in all of them
      const idf = Math.log(1 + n / (df.get(t) || 1));
      const weight = isAnchor(t) ? 2.5 : 1;
      const inLabel = label.includes(t) ? 1.6 : 1;
      score += idf * weight * inLabel;
      hits.push(t);
    }
    return { ref: r, score, hits };
  });

  /* A recall costs prompt tokens and shifts the prompt prefix, so it has to be
     worth it: a path, a symbol or a number on its own is a strong signal, but
     one ordinary word ("works", "turn") is not — that needs two of them. */
  const strong = (hits: string[]) =>
    hits.some(isAnchor) || hits.length >= 2 || hits.some((t) => t.length >= 6);

  const matched = scored.filter((s) => s.score > 0);
  const chosen = matched
    .filter((s) => strong(s.hits))
    .sort((a, b) => b.score - a.score || b.ref.seq - a.ref.seq);
  const weak = matched.filter((s) => !strong(s.hits)).length;

  const picked: typeof chosen = [];
  let tokens = 0;
  for (const c of chosen) {
    if (picked.length >= maxChunks) break;
    if (tokens + c.ref.tokens > budgetTokens && picked.length > 0) continue;
    if (c.ref.tokens > budgetTokens) continue;
    picked.push(c);
    tokens += c.ref.tokens;
  }
  if (!picked.length) {
    return {
      ids: [],
      tokens: 0,
      why: weak
        ? `only stray words matched ${weak} chunk${weak === 1 ? "" : "s"} — not worth the tokens`
        : "nothing in the archive matched this turn",
    };
  }
  picked.sort((a, b) => a.ref.seq - b.ref.seq);
  const hits = [...new Set(picked.flatMap((p) => p.hits))].slice(0, 6);
  return {
    ids: picked.map((p) => p.ref.id),
    tokens,
    why: `matched ${hits.join(", ")}`,
  };
}

/** What a recalled body looks like once it is back in the window. */
export function recallText(
  ref: ArchiveRef,
  body: { messages: ChatMessage[] },
): string {
  const when = new Date(ref.at).toLocaleString();
  // count what is actually being sent, not what the ref claims
  const n = body.messages.length;
  return [
    `### Recalled #${ref.seq} — ${n} message${n === 1 ? "" : "s"} from ${when}`,
    `Trigger: ${ref.register}`,
    "This is the verbatim transcript of those turns, recalled from disk:",
    "",
    ...body.messages.map((m) => {
      const who = m.role === "user" ? "user" : m.role === "assistant" ? "q38" : "system";
      const text = m.content.trim();
      const think = m.reasoning?.trim();
      return [`**${who}:**`, think ? `_[reasoning]_ ${think.slice(0, 600)}` : "", text, ""]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n");
}

/** Default recall budget: a slice of the usable window, not a second window. */
export const RECALL_BUDGET_FRACTION = 0.12;
