import { CHARS_PER_TOKEN, estimateTokens, messageTokens } from "./context";
import type { ChatMessage, ContinueMode } from "./types";

/**
 * Context folding and reply continuation.
 *
 * Folding: older turns are rewritten into a handoff brief by the model itself
 * (falling back to a deterministic local extract when llama-server is offline).
 *
 * Continuation: a reply cut off by max_tokens is resumed. llama-server continues a
 * trailing assistant message natively (--prefill-assistant / continue_final_message);
 * servers that refuse it get a prompt directive instead. Both paths are stitched
 * back into the original message, with overlap and code-fence repair.
 */

export const SUMMARY_SYSTEM = [
  "You are the context compactor for Q38, a coding workbench running Qwen3.8-27B Turbo-Brilliance via llama-server.",
  "You are given a transcript of earlier turns, oldest first, plus your own previous brief when one exists.",
  "Rewrite them into one dense handoff brief so the model can continue the session with no loss of working state.",
  "",
  "Rules:",
  "- Reply with the brief only. No preamble, no meta commentary about compacting.",
  "- Same language as the user.",
  "- Keep everything that changes the work: file paths, symbol names, signatures, types, config keys, commands, versions, error strings, decisions and their reasons.",
  "- Preserve identifiers, paths and commands verbatim. Never paraphrase them.",
  "- Carry the threads forward: what is done, what is half-written, what is next, what was rejected and why.",
  "- Quote the short code that must survive (signatures, schemas, regex, SQL) in fenced blocks with a language tag. Never invent code that is not in the transcript.",
  "- Drop chit-chat, restatements, and reasoning that did not change the outcome.",
  "- If something is uncertain or unfinished, say so. Do not guess.",
  "",
  "Output markdown with exactly these sections:",
  "## Goal",
  "## Stack & conventions",
  "## Files in play",
  "## Decisions & constraints",
  "## State of the work",
  "## Open threads / next steps",
  "## Must-not-lose snippets",
].join("\n");

export const LOCAL_BRIEF_NOTE =
  "_Local extract — llama-server was unreachable when this fold was made, so the brief is mechanical rather than paraphrased._";

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [${text.length - max} chars trimmed]`;
}

function clean(text: string): string {
  return text.replace(/\{REASON:[^}]*\}/gi, "").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * Assemble the material handed to the summarizer. Newest turns win the budget:
 * the model's immediate working state matters more than turn 2.
 */
export function buildSummaryMaterial(
  messages: ChatMessage[],
  prevSummary: string | undefined,
  maxChars: number,
): string {
  const parts: string[] = [];
  let spent = 0;
  const push = (block: string) => {
    parts.push(block);
    spent += block.length;
  };

  push(
    "The transcript below is the earlier part of an ongoing coding session. Some very old turns may have been trimmed to fit this request — never state anything that is not present here.",
  );

  if (prevSummary) {
    const block = `### Previous brief (already folded)\n${clip(prevSummary, 3500)}`;
    push(block);
  }

  const firstUser = messages.find((m) => m.role === "user" && clean(m.content));
  if (firstUser) {
    push(`### Opening request\n${clip(clean(firstUser.content), 2000)}`);
  }

  const budget = Math.max(2000, maxChars);
  const perMessage = 4000;
  const tailFirst = [...messages].reverse();
  const blocks: string[] = [];
  for (const m of tailFirst) {
    if (m === firstUser) continue;
    const body = clean(m.content);
    const attachments = (m.attachments ?? [])
      .map((a) => `  pinned file: ${a.path} (${a.content.length} chars)`)
      .join("\n");
    if (!body && !attachments) continue;
    const header = m.role === "user" ? "### user" : "### assistant";
    const block = [header, clip(body || "(no text)", perMessage), attachments].filter(Boolean).join("\n");
    const cost = block.length + 2;
    if (spent + cost > budget) break;
    blocks.push(block);
    spent += cost;
  }
  blocks.reverse();
  parts.push(...blocks);
  return parts.join("\n\n");
}

export function summaryRequest(
  messages: ChatMessage[],
  prevSummary: string | undefined,
  contextTokens: number,
  maxTokens: number,
): { role: string; content: string }[] {
  const maxChars = Math.max(4000, Math.round((contextTokens - maxTokens - 800) * CHARS_PER_TOKEN));
  return [
    { role: "system", content: SUMMARY_SYSTEM },
    { role: "user", content: buildSummaryMaterial(messages, prevSummary, maxChars) },
  ];
}

/** Offline fallback: mechanical, deterministic, honest about what it is. */
export function localSummary(messages: ChatMessage[], prevSummary?: string): string {
  const users = messages.filter((m) => m.role === "user");
  const assistants = messages.filter((m) => m.role === "assistant");

  const asks = users.map((m) => clip(clean(m.content).replace(/\s+/g, " "), 220));
  const firstAsk = asks[0] ?? "(none)";
  const recentAsks = asks.length > 4 ? asks.slice(-3) : asks.slice(1);

  const pathRe = /(?:[\w.@-]+\/)+[\w.@-]+\.[a-zA-Z0-9]{1,6}\b/g;
  const paths = new Set<string>();
  for (const m of messages) {
    for (const a of m.attachments ?? []) paths.add(a.path);
    for (const hit of m.content.match(pathRe) ?? []) paths.add(hit);
  }

  const threadRe = /^\s*(?:[-*]\s*)?(?:TODO|FIXME|NEXT|TODO\(|Remaining|Not yet|Open thread)[:-]?(.*)$/gim;
  const threads: string[] = [];
  for (const m of assistants) {
    for (const hit of m.content.matchAll(threadRe)) {
      const line = clip((hit[1] || "").trim(), 160);
      if (line && !threads.includes(line)) threads.push(line);
      if (threads.length >= 8) break;
    }
  }

  const last = assistants[assistants.length - 1];
  const tail = last
    ? clip(
        clean(last.content)
          .split("\n")
          .filter((l) => l.trim())
          .slice(0, 6)
          .join("\n"),
        700,
      )
    : "(no assistant turns)";

  const out: string[] = [LOCAL_BRIEF_NOTE, "", "## Goal", firstAsk];
  if (recentAsks.length) {
    out.push("", `## Recent asks`, ...recentAsks.map((a) => `- ${a}`));
  }
  if (prevSummary) {
    out.push("", "## Earlier brief (carried forward)", clip(prevSummary, 1200));
  }
  out.push(
    "",
    "## Files in play",
    paths.size ? [...paths].slice(0, 16).map((p) => `- \`${p}\``).join("\n") : "- (none named)",
  );
  out.push(
    "",
    "## State of the work",
    `${messages.length} messages folded (${users.length} user / ${assistants.length} assistant). Exchanges are summarised mechanically — re-read any file you are about to edit.`,
  );
  out.push(
    "",
    "## Open threads / next steps",
    threads.length ? threads.map((t) => `- ${t}`).join("\n") : "- continue the work described in the Goal.",
  );
  out.push("", "## Last assistant output (trimmed)", "```text", tail, "```");
  return out.join("\n");
}

/**
 * A fold only earns its keep when the brief is cheaper than the messages it
 * replaces — otherwise the window would grow and thrash.
 */
export function foldPaysOff(tokensBefore: number, tokensAfter: number): boolean {
  return tokensAfter < tokensBefore;
}

export function summaryTokensOf(text: string): number {
  return estimateTokens(text);
}

/** Tokens a folded block costs once it is back in the prompt as a system turn. */
export function foldedPromptCost(summary: string): number {
  return estimateTokens(summary) + 48;
}

/** Tokens the folded messages would have cost. */
export function headPromptCost(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + messageTokens(m), 0);
}

export type FenceState = { open: boolean; lang: string };

/** Are we inside an unterminated fenced code block, and in which language? */
export function fenceState(text: string): FenceState {
  let open = false;
  let lang = "";
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(```+|~~~+)\s*([a-zA-Z0-9+#._-]*)/);
    if (!m) continue;
    if (!open) {
      open = true;
      lang = (m[2] || "").toLowerCase();
    } else {
      open = false;
      lang = "";
    }
  }
  return { open, lang };
}

/**
 * Glue a continuation onto the text it continues: drop the overlap the model
 * repeated, and re-open the code fence only if the first half was not inside one.
 */
export function stitchContinuation(prev: string, next: string): string {
  if (!next) return prev;
  if (!prev) return next;

  let add = next;
  const maxK = Math.min(2400, prev.length, add.length);
  for (let k = maxK; k >= 24; k--) {
    if (prev.endsWith(add.slice(0, k))) {
      add = add.slice(k);
      break;
    }
  }

  const state = fenceState(prev);
  if (state.open) {
    const opener = add.match(/^\s*```+([a-zA-Z0-9+#._-]*)[^\n]*\n/);
    if (opener) {
      const lang = (opener[1] || "").toLowerCase();
      const same = !lang || !state.lang || lang === state.lang || state.lang.startsWith(lang) || lang.startsWith(state.lang);
      if (same) add = add.slice(opener[0].length).replace(/^\n+/, "");
    }
  }

  return prev + add;
}

export type ContinueKind = "content" | "reasoning";

/** Hint the model with the last lines it wrote, so a directive resume lands in context. */
function tailLines(text: string, count = 4, maxChars = 320): string {
  const lines = text.split("\n").filter((l) => l.trim());
  return clip(lines.slice(-count).join("\n"), maxChars);
}

/**
 * Directive continuation, used when the server will not continue a prefill
 * (or when the reply died inside its thinking block and there is no content yet).
 */
export function continueDirective(kind: ContinueKind, prevText: string): string {
  const fence = fenceState(prevText);
  const bits: string[] = [];
  if (kind === "reasoning") {
    bits.push(
      "Your previous turn was cut off by the token limit while you were still thinking. Finish the analysis, then give the complete answer.",
    );
  } else {
    bits.push(
      "Your previous reply was cut off by the token limit. Continue it from the exact point where it stopped.",
    );
  }
  bits.push("Do not repeat anything you already wrote, do not restart the answer, do not apologise.");
  if (fence.open) {
    bits.push(
      `You stopped inside an open \`\`\`${fence.lang || ""} code block — keep writing that same block and do not emit a new opening fence or a closing one until the code is complete.`,
    );
  } else if (kind === "content") {
    bits.push("Match the formatting of the part already written (headings, fences, list style).");
  }
  if (prevText.trim()) {
    bits.push("", "The last text you produced was:", "```text", tailLines(prevText), "```");
  }
  return bits.join("\n");
}

/** Small preview for the fold card in the transcript. */
export function briefPreview(summary: string, chars = 4000): string {
  return clip(summary, chars);
}

export type ContinuationSettings = {
  autoContinue: boolean;
  maxContinues: number;
  continueMode: ContinueMode;
};

export type ResumeStep = {
  kind: ContinueKind;
  /** assistant prefill path; null means "send a directive instead" */
  continueFinal: "content" | "reasoning_content" | null;
  directive?: string;
  /** used if the server refuses the prefill before emitting a token */
  fallbackDirective?: string;
  why: string;
};

/** How a manual "continue" on an existing reply should be issued. */
export function planResume(args: {
  body: string;
  reasoning: string;
  continueMode: ContinueMode;
}): ResumeStep {
  const hasContent = args.body.trim().length > 0;
  const kind: ContinueKind = hasContent ? "content" : "reasoning";
  const directive = continueDirective(kind, hasContent ? args.body : args.reasoning);
  if (!hasContent) {
    return {
      kind,
      continueFinal: null,
      directive,
      fallbackDirective: directive,
      why: "no content yet — resume by directive so the thinking block can finish",
    };
  }
  if (args.continueMode === "directive") {
    return { kind, continueFinal: null, directive, fallbackDirective: directive, why: "directive mode" };
  }
  return { kind, continueFinal: "content", fallbackDirective: directive, why: "assistant prefill" };
}

export type ContinuationPlan =
  | { proceed: false; why: string }
  | ({ proceed: true; why: string } & ResumeStep);

/** Should this truncated round be continued automatically, and how? */
export function planContinuation(args: {
  truncated: boolean;
  body: string;
  reasoning: string;
  roundsDone: number;
  allowAuto: boolean;
  settings: ContinuationSettings;
}): ContinuationPlan {
  if (!args.allowAuto) return { proceed: false, why: "auto-continue is off for this turn" };
  if (!args.truncated) return { proceed: false, why: "the round ended cleanly" };
  if (!args.settings.autoContinue) return { proceed: false, why: "auto-continue disabled in settings" };
  if (args.roundsDone >= args.settings.maxContinues) {
    return { proceed: false, why: `round budget of ${args.settings.maxContinues} spent` };
  }
  const step = planResume({
    body: args.body,
    reasoning: args.reasoning,
    continueMode: args.settings.continueMode,
  });
  return { proceed: true, ...step };
}
