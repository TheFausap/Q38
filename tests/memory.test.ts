/**
 * Disk memory: the pure logic.
 *
 *   npm run test:unit
 *
 * No network, no disk, no DOM — just the rules that decide what the register
 * line says and whether a turn is allowed to pull a chunk back. The UI suite
 * (`tests/memory-ui.mjs`) covers the same rules where they meet the app.
 */
import assert from "node:assert/strict";
import {
  RECALL_BUDGET_FRACTION,
  extractTerms,
  labelFor,
  pathsIn,
  planRecall,
  recallText,
  registerLine,
  registerText,
} from "../src/lib/memory.ts";
import type { ArchiveRef, ChatMessage } from "../src/lib/types.ts";

const msg = (
  role: "user" | "assistant",
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({ id: `m${Math.random().toString(36).slice(2, 8)}`, role, content, ...extra });

function ref(over: Partial<ArchiveRef> & { seq: number; terms: string[]; label: string }): ArchiveRef {
  return {
    id: `c${String(over.seq).padStart(3, "0")}`,
    at: Date.UTC(2026, 0, over.seq),
    fromId: "u1",
    toId: "a1",
    count: 4,
    tokens: 1000,
    register: `#${over.seq} · "${over.label}"`,
    paths: [],
    recalls: 0,
    lastRecallAt: null,
    ...over,
  };
}

/* ------------------------------------------------------- extractTerms */
{
  const terms = extractTerms(
    'Wire retryLoop() into src/lib/api.ts, keep ABORT_SIGNAL and "the backoff jitter" intact.',
  );
  assert.ok(terms.includes("src/lib/api.ts"), `a path is a term: ${terms.join(", ")}`);
  assert.ok(terms.includes("api.ts"), "and so is its basename");
  assert.ok(terms.includes("retryloop"), "camelCase is a term");
  assert.ok(terms.includes("retry"), "with its parts");
  assert.ok(terms.includes("abort_signal"), "so is snake_case");
  assert.ok(terms.includes("backoff"), "and words");
  assert.ok(!terms.includes("the"), "stopwords are not");
  assert.ok(!terms.includes("into"), "nor is filler");

  /* The mode tag rides on every user turn the app sends. It must not become a
     term, or every turn would match every chunk that was archived with one. */
  const tagged = extractTerms("{REASON:coder} keep the drum seek");
  assert.ok(!tagged.includes("coder"), `the injected tag is not a term: ${tagged.join(", ")}`);
  assert.ok(!tagged.includes("reason"), "neither half of it");
  assert.ok(tagged.includes("drum"), "everything else survives");

  assert.ok(extractTerms("").length === 0, "empty text has no terms");
  assert.ok(extractTerms("the and for with that this from").length === 0, "filler alone has no terms");
  assert.ok(extractTerms(Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ")).length <= 160, "terms are capped");
}

/* ---------------------------------------------------- paths and labels */
{
  const paths = pathsIn("touch src/lib/api.ts, src/lib/retry.ts, ./server/api.mjs and README.md too");
  assert.deepEqual(
    [...paths].sort(),
    ["server/api.mjs", "src/lib/api.ts", "src/lib/retry.ts"],
    `every file-shaped token is found: ${paths.join(", ")}`,
  );
  assert.ok(paths.length <= 4, `paths are capped for the register line: ${paths.join(", ")}`);
  assert.deepEqual(pathsIn("nothing file-shaped here"), []);

  const label = labelFor([
    msg("user", "wire the retry loop into src/lib/api.ts so a 503 does not kill the turn"),
    msg("assistant", "done"),
  ]);
  assert.ok(/retry loop into src\/lib\/api\.ts/.test(label), `the label is the question: ${label}`);
  assert.ok(!/\{REASON/.test(labelFor([msg("user", "{REASON:coder} explain the meter")])), "never the tag");

  const described = registerLine({
    id: "c003",
    seq: 3,
    label: "wire the retry loop",
    paths: ["src/lib/api.ts", "src/lib/retry.ts"],
    count: 6,
    tokens: 2140,
  });
  assert.ok(/^#3 · /.test(described), `the line starts with the register number: ${described}`);
  assert.ok(/src\/lib\/api\.ts/.test(described), "names the files");
  assert.ok(/6 msg/.test(described), "counts the messages");
  assert.ok(/2\.1k tok/.test(described), `reports the size in k: ${described}`);
}

/* -------------------------------------------------------- registerText */
{
  const text = registerText([
    ref({ seq: 1, label: "retry loop", terms: ["retry"], paths: ["src/lib/api.ts"] }),
    ref({ seq: 2, label: "the meter", terms: ["meter"], tokens: 2300 }),
  ]);
  assert.ok(/#1/.test(text) && /#2/.test(text), "every chunk gets a line");
  assert.ok(/Archive/.test(text), "under an archive heading");
  assert.ok(/2 chunks/.test(text), `and counts them: ${text.split("\n")[0]}`);
  assert.ok(/exact, not a paraphrase/.test(text), "and says the lines are honest");
  assert.ok(/3\.3k|3.3k/.test(text), "and totals the tokens");

  const empty = registerText([]);
  assert.ok(!/#\d/.test(empty), `an empty archive registers nothing: ${JSON.stringify(empty)}`);
}

/* --------------------------------------------------------- planRecall */
const corpus = [
  ref({
    seq: 1,
    label: "wire the retry loop into the http client",
    terms: ["src/lib/api.ts", "api.ts", "retry", "retryloop", "abortsignal", "httperror"],
    paths: ["src/lib/api.ts"],
    tokens: 3100,
  }),
  ref({
    seq: 2,
    label: "widen the context meter in the top bar",
    terms: ["context", "meter", "topbar", "budget", "tokens"],
    tokens: 2200,
  }),
  ref({
    seq: 3,
    label: "the punched card console and the paging animation",
    terms: ["paging", "console", "punchcard", "drum", "seek", "token", "jobs"],
    tokens: 4800,
  }),
];

{
  const hit = planRecall({
    query: "does src/lib/api.ts still swallow aborts inside retryLoop?",
    refs: corpus,
    budgetTokens: 5000,
  });
  assert.deepEqual(hit.ids, ["c001"], `the file path picks its chunk (got ${JSON.stringify(hit.ids)})`);
  assert.equal(hit.tokens, 3100, "and reports what it costs");
  assert.ok(/src\/lib\/api\.ts|retryloop/.test(hit.why), `and says why: ${hit.why}`);

  const bySubject = planRecall({ query: "why does the drum seek before the first token?", refs: corpus, budgetTokens: 6000 });
  assert.deepEqual(bySubject.ids, ["c003"], "a subject match works too");

  const none = planRecall({ query: "what is the weather in Warsaw today", refs: corpus, budgetTokens: 4000 });
  assert.deepEqual(none.ids, [], "an unrelated turn recalls nothing");
  assert.ok(/nothing in the archive matched/.test(none.why), none.why);

  /* A recall costs prompt tokens and moves the prompt prefix, so weak evidence
     must not be enough: one ordinary word is not evidence, one distinctive word
     or two ordinary ones are. */
  const stray = planRecall({ query: "jobs", refs: corpus, budgetTokens: 5000 });
  assert.deepEqual(stray.ids, [], "one stray word recalls nothing");
  assert.ok(/stray words/.test(stray.why), `and says so plainly: ${stray.why}`);

  const twoWords = planRecall({ query: "drum seek", refs: corpus, budgetTokens: 9000 });
  assert.deepEqual(twoWords.ids, ["c003"], "two words are evidence");

  const longWord = planRecall({ query: "where is the punchcard", refs: corpus, budgetTokens: 9000 });
  assert.deepEqual(longWord.ids, ["c003"], "one distinctive word is evidence too");

  /* The mode tag is injected into every user turn and nothing else. */
  const tagged = planRecall({
    query: "{REASON:coder} explain how quicksort pivot selection works",
    refs: [...corpus, ref({ seq: 4, label: "the mode tag plumbing", terms: ["reason", "coder", "tag"], tokens: 900 })],
    budgetTokens: 5000,
  });
  assert.deepEqual(tagged.ids, [], "the injected {REASON:...} tag recalls nothing");

  const tight = planRecall({
    query: "tokens paging console context meter retry api.ts",
    refs: corpus,
    budgetTokens: 2500,
  });
  assert.ok(tight.tokens <= 2500, `the budget is respected (${tight.tokens})`);
  assert.ok(tight.ids.length >= 1, "and something still comes back");

  const excluded = planRecall({
    query: "src/lib/api.ts retryLoop",
    refs: corpus,
    budgetTokens: 5000,
    exclude: ["c001"],
  });
  assert.deepEqual(excluded.ids, [], "what is already in the window is never recalled again");

  const order = planRecall({ query: "drum seek retry api.ts meter tokens", refs: corpus, budgetTokens: 20000 });
  assert.equal(order.ids.length, 3, `every chunk with evidence comes back: ${order.ids.join(", ")}`);
  assert.deepEqual(order.ids, ["c001", "c002", "c003"], "oldest first, so the prompt prefix stays stable");

  const empty = planRecall({ query: "src/lib/api.ts", refs: [], budgetTokens: 5000 });
  assert.deepEqual(empty.ids, [], "an empty archive recalls nothing");
  assert.ok(/nothing to recall/.test(empty.why), empty.why);

  const noBudget = planRecall({ query: "src/lib/api.ts", refs: corpus, budgetTokens: 0 });
  assert.deepEqual(noBudget.ids, [], "no budget, no recall");
}

/* ---------------------------------------------------------- recallText */
{
  const body = {
    messages: [
      msg("user", "wire the retry loop into src/lib/api.ts"),
      msg("assistant", "done: retryLoop() honours abortSignal"),
    ],
  };
  const text = recallText(corpus[0], body);
  assert.ok(/### Recalled #1/.test(text), `the block is headlined: ${text.split("\n")[0]}`);
  assert.ok(/2 messages/.test(text), "and counts the messages it is actually sending");
  assert.ok(/verbatim/.test(text), "and says they are verbatim");
  assert.ok(/retryLoop\(\) honours abortSignal/.test(text), "the bodies are in it, word for word");
  assert.ok(/\*\*user:\*\*/.test(text) && /\*\*q38:\*\*/.test(text), "each turn is attributed");
  assert.ok(
    text.includes(String(new Date(corpus[0].at).getFullYear())),
    "and carries the date it was archived",
  );

  /* count what is sent, never what the ref claims */
  const one = recallText(corpus[0], { messages: [msg("user", "just this")] });
  assert.ok(/1 message from/.test(one), `a single message reads as one: ${one.split("\n")[0]}`);
}

/* ------------------------------------------------------------- budget */
assert.ok(
  RECALL_BUDGET_FRACTION > 0 && RECALL_BUDGET_FRACTION < 0.5,
  `recall may use a share of the window, not most of it (${RECALL_BUDGET_FRACTION})`,
);

console.log("memory checks passed");
