/**
 * The library tools' client half: what the model is offered, what it reads back.
 *
 *   node --experimental-strip-types tests/library.test.ts
 */
import assert from "node:assert/strict";
import {
  LIBRARY_INLINE_LIMIT,
  addTapeLine,
  addText,
  libraryTools,
  readText,
  searchText,
  type LibraryDoc,
} from "../src/lib/library.ts";

type Tool = { function: { name: string; description: string; parameters: { properties: Record<string, unknown>; required: string[] } } };

const doc = (i: number): LibraryDoc => ({
  id: `paper-${i}`,
  title: `Paper number ${i}`,
  kind: "pdf",
  source: `https://arxiv.org/pdf/${i}`,
  pages: 10 + i,
  chars: 40_000,
  chunks: 30,
  sections: 8,
  addedAt: "2026-10-17T00:00:00Z",
  embedded: null,
});

/* --------------------------------------------------------------- offer */
{
  const empty = libraryTools([]) as Tool[];
  assert.deepEqual(
    empty.map((t) => t.function.name),
    ["doc_add", "doc_search", "doc_read"],
    "all three are offered even when empty — a turn can add then search",
  );
  assert.match(empty[1].function.description, /library is empty/);
  for (const t of empty) assert.ok(t.function.parameters.required.length >= 1, `${t.function.name} requires something`);

  const two = libraryTools([doc(1), doc(2)]) as Tool[];
  assert.match(two[1].function.description, /- paper-1: Paper number 1 \(11 pages\)/, "documents are listed by id");
  const many = libraryTools(Array.from({ length: LIBRARY_INLINE_LIMIT + 7 }, (_, i) => doc(i))) as Tool[];
  assert.match(many[1].function.description, /holds 37 documents \(the 30 most recent listed\)/, "a big library is capped");
  assert.match(two[2].function.description, /paper's own number/, "doc_read explains section numbers");
}

/* ---------------------------------------------------------- read-backs */
{
  const outline = [
    { n: 1, title: "Abstract", page: 1, from: 0, to: 0 },
    { n: 2, title: "1 Introduction", page: 1, from: 1, to: 3 },
  ];
  const added = addText("https://arxiv.org/abs/1", { ok: true, doc: doc(1), outline });
  assert.match(added, /^### Added to the library: Paper number 1/);
  assert.match(added, /id: paper-1 · 11 pages · 30 chunks/);
  assert.match(added, / {2}1 Introduction — p\. 1/, "the outline uses the paper's own numbering");
  assert.match(added, /doc_search .*doc="paper-1"/, "and says what to do next");
  assert.match(addText("u", { ok: true, existing: true, doc: doc(1), outline }), /^### Already in the library/);
  assert.match(addText("u", { ok: false, error: "it is over the 50 MB limit" }), /Could not add u[\s\S]*50 MB/);

  const hits = searchText("memory", {
    ok: true,
    mode: "hybrid",
    results: [{ doc: "paper-1", title: "Paper number 1", section: "3.1 Associative Memory", page: 7, chunk: 24, of: 170, score: 0.03, text: "Associative memory is…" }],
  });
  assert.match(hits, /by meaning and keywords/);
  assert.match(hits, /\[1\] Paper number 1 — § 3\.1 Associative Memory, p\. 7 \(doc paper-1, chunk 24 of 170\)\nAssociative memory is…/);
  assert.match(hits, /Cite as \[title, §section, p\. N\]/);
  assert.match(searchText("x", { ok: true, mode: "empty", results: [] }), /library is empty/);
  assert.match(searchText("x", { ok: true, mode: "keyword", results: [] }), /Nothing in the library matches "x"/);

  const sec = readText("paper-1 § 2", {
    ok: true, doc: "paper-1", title: "Paper number 1", chunks: 170, label: "2 Preliminaries", from: 18, to: 22, more: 23, text: "## 2 Preliminaries (p. 6)\nWe…", chars: 30,
  });
  assert.match(sec, /^### Paper number 1 — 2 Preliminaries \(chunks 18–22 of 169\)/);
  assert.match(sec, /doc_read\(doc="paper-1", chunk=23\)/, "a cut read says how to continue");
  assert.match(sec, /garbled/, "and warns about extracted maths");
  const out = readText("paper-1", { ok: true, doc: "paper-1", title: "Paper number 1", pages: 11, chunks: 170, outline, text: "" });
  assert.match(out, /^### Outline of Paper number 1/);
  const miss = readText("nope", { ok: false, error: 'no document matches "nope"', docs: [{ id: "paper-1", title: "Paper number 1" }] });
  assert.match(miss, /Documents: paper-1 \(Paper number 1\)/);

  assert.equal(addTapeLine({ ok: true, doc: doc(1) }), "LIBRARY: ADD PAPER-1 · 30 CHUNKS");
}

console.log("library tool checks passed");
