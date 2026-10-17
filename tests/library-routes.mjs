/**
 * The library's server half: extraction, chunking, search, reading, the routes.
 *
 *   node tests/library-routes.mjs
 *
 * PDFs are written by tests/pdf-fixture.mjs, documents are served by a stub on
 * 127.0.0.1, and embeddings come from a stub /v1/embeddings — no network, no model.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { makePdf, samplePaper } from "./pdf-fixture.mjs";

const results = [];
const check = (ok, msg) => {
  results.push(`${ok ? "·" : "✗"} ${msg}`);
  if (!ok) throw new Error(msg);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q38-library-test-"));
process.env.Q38_LIBRARY_DIR = path.join(tmp, "library");
process.env.Q38_STATE_DIR = path.join(tmp, "state");
process.env.Q38_WEB_ALLOW_PRIVATE = "1"; // the stubs live on 127.0.0.1

const lib = await import("../server/library.mjs");
const { createApi, htmlToText, titleOf } = await import("../server/api.mjs");
const { chunkBlocks, createEmbedder, createLibrary, documentUrl, embedPrefixes, extractHtml, extractPdf, extractText, headingKind, terms } = lib;

/* ---------------------------------------------------------- stubs */
const paper = samplePaper();
const STUB = 18600 + Math.floor(Math.random() * 300);
const EMBED = STUB + 1;
const API = STUB + 2;
const stub = http.createServer((req, res) => {
  if (req.url === "/paper.pdf") {
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": paper.length });
    return res.end(paper);
  }
  if (req.url === "/moved") {
    res.writeHead(302, { Location: "/paper.pdf" });
    return res.end();
  }
  if (req.url === "/article") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(
      `<html><head><title>A long article</title></head><body><h1>A long article</h1>` +
        `<h2>Setup</h2><p>${"The setup paragraph explains the apparatus in detail. ".repeat(12)}</p>` +
        `<h2>Findings</h2><p>${"The findings paragraph reports a resonance near 4 kelvin. ".repeat(12)}</p>` +
        `<script>steal()</script></body></html>`,
    );
  }
  if (req.url === "/huge.pdf") {
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(60 * 1024 * 1024) });
    return res.end("%PDF");
  }
  if (req.url === "/scan.pdf") {
    const empty = makePdf({ pages: [[{ size: 10, text: " " }]] });
    res.writeHead(200, { "Content-Type": "application/pdf" });
    return res.end(empty);
  }
  res.writeHead(404);
  res.end();
});
/* embeddings: a bag of hashed words, so related text really is closer */
let embedInputs = [];
const DIM = 128;
const vec = (t) => {
  const v = new Array(DIM).fill(0);
  for (const w of t.toLowerCase().split(/[^a-z]+/)) {
    if (w.length < 3) continue;
    let h = 7;
    for (const ch of w.slice(0, 6)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  return v;
};
const embed = http.createServer((req, res) => {
  if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "nomic-embed-text-v1.5.Q8_0.gguf" }] }));
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body);
    embedInputs.push(...j.input);
    res.end(JSON.stringify({ data: j.input.map((t, i) => ({ index: i, embedding: vec(t) })) }));
  });
});
await new Promise((r) => stub.listen(STUB, "127.0.0.1", r));
await new Promise((r) => embed.listen(EMBED, "127.0.0.1", r));
const api = createApi();
const server = http.createServer((req, res) => api(req, res, () => res.end("{}")));
await new Promise((r) => server.listen(API, "127.0.0.1", r));
const call = async (p, init = {}) => {
  const res = await fetch(`http://127.0.0.1:${API}${p}`, init);
  return { status: res.status, json: await res.json() };
};
const post = (p, body, headers = {}) =>
  call(p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

try {
  /* ------------------------------------------------------------ text */
  {
    check(terms("The Memories of Models").join(" ") === "memorie model", `terms fold case, stop words, plurals (${terms("The Memories of Models")})`);
    check(headingKind("3.1 Associative Memory", 10, 10) === "structural", "a numbered line is a heading");
    check(headingKind("References", 10, 10) === "structural", "so is a known section name");
    check(headingKind("M(0) := M(0)(x; W) (24)", 14, 10) === null, "a display equation is not, however large");
    check(headingKind("Toy example. In Section 4.3 we show", 10, 10) === null, "a run-in heading is a paragraph");
    check(headingKind("arXiv:2512.24695v1 [cs.LG] 31 Dec 2025", 20, 10) === null, "the arXiv side stamp is not");
    check(headingKind("We show that it works.", 14, 10) === null, "a sentence is not");
  }

  /* --------------------------------------------------------- extract */
  {
    const x = await extractPdf(paper);
    const heads = x.blocks.filter((b) => b.kind === "heading").map((b) => b.text);
    check(x.title === "Nested Memories for Continual Learners", `the title comes from the metadata (${x.title})`);
    check(x.pages === 4, "pages are counted");
    check(
      JSON.stringify(heads) === JSON.stringify(["Abstract", "1 Introduction", "2 Continuum Memory System", "3 Experiments", "References", "A Proofs"]),
      `the outline is the paper's own: ${heads.join(" | ")}`,
    );
    const all = x.blocks.map((b) => b.text).join("\n");
    check(!/Preprint under review/.test(all), "a running head on every page is dropped");
    check(/learns something new/.test(all), "an end-of-line hyphen is joined back");
    check(/M\(0\) :=/.test(all), "the equation stays, as text");
    check(!x.blocks.some((b) => b.kind === "heading" && /Ada Example/.test(b.text)), "the author line is not a section");

    const html = extractHtml(
      "<title>T</title><h1>Top</h1><p>one</p><h2>Second</h2><p>two</p><script>x()</script>",
      { htmlToText, titleOf },
    );
    check(html.title === "T" && html.blocks.filter((b) => b.kind === "heading").length === 2, "HTML keeps h1–h6 as headings");
    check(!/x\(\)/.test(JSON.stringify(html.blocks)), "and drops its scripts");
    const md = extractText("# Doc\n\nintro\n\n## Part two\n\nbody", "md");
    check(md.title === "Doc" && md.blocks.some((b) => b.kind === "heading" && b.text === "Part two"), "Markdown # lines are headings");
  }

  /* ----------------------------------------------------------- chunk */
  {
    const long = "This sentence is about eighty characters long and ends with a full stop here. ".repeat(60);
    const { chunks, sections } = chunkBlocks([
      { kind: "heading", text: "1 One", page: 1 },
      { kind: "text", text: long, page: 1 },
      { kind: "heading", text: "2 Two", page: 3 },
      { kind: "text", text: "short", page: 3 },
    ]);
    check(chunks.every((c) => c.text.length <= 2200), "no chunk is over the hard cap");
    check(chunks.filter((c) => c.section === "1 One").length >= 3, "a long section is cut into several chunks");
    check(chunks.filter((c) => c.section === "1 One").every((c) => /\.$/.test(c.text)), "cut at sentence ends");
    check(sections[1].from === sections[0].to + 1 && sections[1].title === "2 Two", "sections map to chunk ranges");
    check(chunks[chunks.length - 1].page === 3, "chunks keep their page");
  }

  /* --------------------------------------------------------- library */
  const root = path.join(tmp, "unit");
  const L = createLibrary({ root, download: null, htmlToText, titleOf });
  let id;
  {
    const added = await L.addBytes({ bytes: paper, name: "paper.pdf" });
    check(added.ok && !added.existing && added.doc.pages === 4, "a PDF is added");
    id = added.doc.id;
    check(/^nested-memories-for-continual-learners-[0-9a-f]{6}$/.test(id), `with a readable id (${id})`);
    check(fs.existsSync(path.join(root, "docs", id, "source.pdf")), "the original is kept");
    const again = await L.addBytes({ bytes: paper, name: "copy.pdf" });
    check(again.ok && again.existing && again.doc.id === id, "the same bytes twice are one document");
    const junk = await L.addBytes({ bytes: Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9, 0, 0, 1]), name: "blob.bin" });
    check(!junk.ok && /PDF, HTML, Markdown and plain text/.test(junk.error), "binary junk is refused in plain words");

    const hit = await L.search("update frequency continuum memory");
    check(hit.ok && hit.mode === "keyword", "search works with no embedder");
    check(hit.results[0].section === "2 Continuum Memory System", `and finds the right section (${hit.results[0].section})`);
    check(hit.results[0].page === 2 && hit.results[0].doc === id, "naming its page and document");
    const scoped = await L.search("frequency", { doc: "nested memories" });
    check(scoped.ok && scoped.results.every((r) => r.doc === id), "a search can be held to one document, by a loose title");
    const none = await L.search("frequency", { doc: "no such paper at all" });
    check(!none.ok && /no document matches/.test(none.error), "an unknown document is said so");

    const outline = L.read(id);
    check(outline.ok && outline.outline.length === 6 && !outline.text, "reading a document alone gives its outline");
    const byNum = L.read(id, { section: "2" });
    check(/chain of blocks/.test(byNum.text) && byNum.label === "2 Continuum Memory System", `a section by number (${byNum.label})`);
    const byName = L.read(id, { section: "continuum memory" });
    check(byName.label === byNum.label, "or by part of its name");
    const tiny = L.read(id, { chunk: 0, chars: 1000 });
    check(tiny.chars <= 1000 && tiny.more != null, "a budget is honoured and says where to carry on");
    const next = L.read(id, { chunk: tiny.more, chars: 1000 });
    check(next.ok && next.from === tiny.more, "and carrying on starts there");
    check(!L.read(id, { section: "nothing like this" }).ok, "an unknown section is a miss with the outline");

    fs.mkdirSync(path.join(root, "inbox"), { recursive: true });
    fs.writeFileSync(path.join(root, "inbox", "notes.md"), `# Lab notes\n\n${"The cryostat reached 4 kelvin on Tuesday. ".repeat(10)}`);
    fs.writeFileSync(path.join(root, "inbox", "empty.txt"), "x");
    const scan = await L.scanInbox();
    check(scan.added.includes("Lab notes"), "a file dropped in the inbox is read in");
    check(scan.failed.length === 1 && fs.existsSync(path.join(root, "inbox", "failed", "empty.txt")), "one it cannot read is moved aside");
    check(fs.existsSync(path.join(root, "inbox", "failed", "empty.txt.error.txt")), "with the reason next to it");
    check(!fs.existsSync(path.join(root, "inbox", "notes.md")), "and the inbox is emptied of what was read");

    const removed = await L.remove(id);
    check(removed.ok && !fs.existsSync(path.join(root, "docs", id)), "remove deletes the document and its index");
  }

  /* ----------------------------------------------------- embeddings */
  {
    check(embedPrefixes("Qwen3-Embedding-0.6B-Q8_0.gguf").query.startsWith("Instruct:"), "Qwen3 embeddings get an instruction");
    check(embedPrefixes("nomic-embed-text-v1.5").doc === "search_document: ", "nomic gets its prefixes");
    check(embedPrefixes("mystery").query === "", "an unknown model gets none");

    const E = createEmbedder(`http://127.0.0.1:${EMBED}/v1`);
    const L2 = createLibrary({ root: path.join(tmp, "embedded"), download: null, htmlToText, titleOf });
    embedInputs = [];
    const added = await L2.addBytes({ bytes: paper, name: "p.pdf", embedder: E });
    check(added.ok && added.doc.embedded === "nomic-embed-text-v1.5.Q8_0.gguf", "an embedder stores vectors on add");
    check(embedInputs.every((t) => t.startsWith("search_document: ")), "documents are framed as documents");
    embedInputs = [];
    const hy = await L2.search("how often does each block update", { embedder: E });
    check(hy.mode === "hybrid" && embedInputs[0].startsWith("search_query: "), "search goes hybrid, the query framed as a query");
    check(hy.results.length > 0, "and finds passages");
    const down = await L2.search("frequency", { embedder: createEmbedder("http://127.0.0.1:1") });
    check(down.ok && down.mode === "keyword" && /not answering/.test(down.note), `a dead embedder falls back to keywords, and says so (${down.note})`);
    const L3 = createLibrary({ root: path.join(tmp, "late"), download: null, htmlToText, titleOf });
    await L3.addBytes({ bytes: paper, name: "p.pdf" });
    check(/embedded yet/i.test((await L3.search("x frequency", { embedder: E })).note || ""), "documents added without vectors are flagged");
    const filled = await L3.embedMissing(E);
    check(filled.ok && filled.embedded === 1, "and can be embedded afterwards");
    check((await L3.search("frequency", { embedder: E })).mode === "hybrid", "after which search is hybrid");
  }

  /* ------------------------------------------------------- addresses */
  {
    check(documentUrl("https://arxiv.org/abs/2512.24695") === "https://arxiv.org/pdf/2512.24695", "an arXiv abstract maps to its PDF");
    check(documentUrl("https://arxiv.org/abs/2512.24695v2") === "https://arxiv.org/pdf/2512.24695v2", "versions too");
    check(documentUrl("https://openreview.net/forum?id=abc_1") === "https://openreview.net/pdf?id=abc_1", "an OpenReview forum maps to its PDF");
    check(documentUrl("https://example.org/x.pdf") === "https://example.org/x.pdf", "anything else is left alone");
  }

  /* ---------------------------------------------------------- routes */
  {
    const empty = await call("/api/library/list");
    check(empty.status === 200 && empty.json.docs.length === 0, "GET /api/library/list starts empty");

    const viaRedirect = await post("/api/library/add", { url: `http://127.0.0.1:${STUB}/moved` });
    check(viaRedirect.status === 200 && viaRedirect.json.doc.pages === 4, "POST /api/library/add downloads a PDF, through a redirect");
    check(viaRedirect.json.doc.source.endsWith("/paper.pdf"), "and records where it really came from");
    const article = await post("/api/library/add", { url: `http://127.0.0.1:${STUB}/article` });
    check(article.status === 200 && article.json.doc.title === "A long article", "an HTML page can be added too");
    check(article.json.outline.some((s) => s.title === "Findings"), "with its headings as sections");

    const huge = await post("/api/library/add", { url: `http://127.0.0.1:${STUB}/huge.pdf` });
    check(huge.status === 422 && /MB limit/.test(huge.json.error), `an oversized document is refused before it downloads (${huge.json.error})`);
    const scan = await post("/api/library/add", { url: `http://127.0.0.1:${STUB}/scan.pdf` });
    check(scan.status === 422 && /OCR/.test(scan.json.error), "a PDF with no text layer is named as such");
    delete process.env.Q38_WEB_ALLOW_PRIVATE;
    const guarded = await post("/api/library/add", { url: `http://127.0.0.1:${STUB}/paper.pdf` });
    check(guarded.status === 422 && /public addresses/.test(guarded.json.error), "the private-address guard holds for downloads");
    process.env.Q38_WEB_ALLOW_PRIVATE = "1";

    const up = await call("/api/library/upload", {
      method: "POST",
      headers: { "Content-Type": "text/markdown", "X-Q38-Filename": encodeURIComponent("my notes.md") },
      body: `# Bench notes\n\n${"Laser alignment drifted after the coffee break. ".repeat(10)}`,
    });
    check(up.status === 200 && up.json.doc.title === "Bench notes", "POST /api/library/upload takes a file");

    const listed = await call("/api/library/list");
    check(listed.json.docs.length === 3, `the list holds all three (${listed.json.docs.length})`);

    const found = await call(`/api/library/search?q=${encodeURIComponent("resonance kelvin")}`);
    check(found.status === 200 && found.json.results[0].title === "A long article", "GET /api/library/search ranks across documents");
    check(found.json.results[0].section === "Findings", "down to the section");

    const paperId = viaRedirect.json.doc.id;
    const read = await call(`/api/library/read?doc=${paperId}&section=3`);
    check(read.status === 200 && /needle-in-a-haystack/.test(read.json.text), "GET /api/library/read returns a section");
    const miss = await call(`/api/library/read?doc=nope`);
    check(miss.status === 404 && miss.json.docs.length === 3, "an unknown document is a 404 listing what exists");

    const withEmbed = { "X-Q38-Embed-Url": `http://127.0.0.1:${EMBED}` };
    const fill = await call("/api/library/embed", { method: "POST", headers: withEmbed });
    check(fill.status === 200 && fill.json.embedded === 3, "POST /api/library/embed fills in vectors");
    const hybrid = await call(`/api/library/search?q=alignment`, { headers: withEmbed });
    check(hybrid.json.mode === "hybrid", "and the embed header turns search hybrid");
    const noEmbed = await call("/api/library/embed", { method: "POST" });
    check(noEmbed.status === 400, "embedding with no server configured is refused");

    const gone = await post("/api/library/remove", { id: paperId });
    check(gone.status === 200 && (await call("/api/library/list")).json.docs.length === 2, "POST /api/library/remove removes");
    const pdfRead = await post("/api/web/fetch", { url: `http://127.0.0.1:${STUB}/paper.pdf` });
    check(/doc_add/.test(pdfRead.json.error), "a PDF given to web_fetch points the model at the library");
  }

  console.log(results.join("\n"));
  console.log(`library checks passed (${results.length})`);
} catch (err) {
  console.error(results.join("\n"));
  console.error("LIBRARY TEST FAILED:", err.message);
  process.exitCode = 1;
} finally {
  server.close();
  stub.close();
  embed.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
