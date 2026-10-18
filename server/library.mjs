/**
 * The library: documents read once, kept on disk, searched by the model later.
 *
 * A paper is too big for a prompt — a 50-page PDF is ~200k characters — so it is
 * read into the library instead: its text is pulled out (pdf.js for PDFs), cut
 * into section-labelled chunks of ~1.4k characters, and stored under
 * `<state>/library/docs/<id>/`. The model then asks `doc_search` for the chunks
 * that answer a question and `doc_read` for a whole section, and quotes the
 * paper by section and page instead of from memory.
 *
 * Search is hybrid when it can be and keyword-only when it must be:
 *   - BM25 over every chunk, always — exact terms ("CMS", "Hope", "mesolve")
 *     matter in technical text, and it needs nothing running.
 *   - Embeddings, when an OpenAI-compatible /v1/embeddings server is configured
 *     (a second llama-server with an embedding model): matches by meaning.
 *   The two rankings are fused with reciprocal rank fusion.
 *
 * No vector database: a personal library is thousands of chunks, and a
 * brute-force scan over normalised Float32 vectors answers in milliseconds.
 *
 * The heavy dependencies are injected (`download`, `htmlToText`, `titleOf`) so
 * this module does not import the API module that imports it, and so the tests
 * can run it against fixtures.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { writeDurable } from "./durable.mjs";
import path from "node:path";
import { ocrPdf } from "./ocr.mjs";

/** Bytes a single document may have. */
export const LIBRARY_MAX_BYTES = 50 * 1024 * 1024;
/** A chunk aims for this many characters… */
const CHUNK_TARGET = 1400;
/** …and is cut hard past this. */
const CHUNK_MAX = 2200;
/** Characters `read` returns by default, and its ceiling. */
export const READ_DEFAULT_CHARS = 12_000;
const READ_MAX_CHARS = 40_000;
/** Embedding requests carry this many chunks each. */
const EMBED_BATCH = 16;
const EMBED_TIMEOUT_MS = 120_000;

/* ================================================================ text ===== */

const STOP = new Set(
  ("a an and are as at be by for from has have how in is it its of on or that the this to was were what " +
    "when where which who why will with we our their they you your can into than then there these those " +
    "not but also such more most other some any all each both between about over under via per").split(" "),
);

/** Terms for BM25: lowercase, accents off, plurals folded, stop words out. */
export function terms(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && (w.length > 1 || /\d/.test(w)) && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

function slug(text, max = 40) {
  return (
    String(text || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "doc"
  );
}

/** Join PDF lines: undo end-of-line hyphenation, keep words apart otherwise. */
function joinLines(lines) {
  let out = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) out = line;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line;
    else out += " " + line;
  }
  return out;
}

/* ============================================================= extract ===== */

const HEADING_WORDS = /^(abstract|introduction|related work|background|method(s|ology)?|experiments?|results|discussion|conclusions?|references|bibliography|acknowledg(e)?ments?|appendix\b.*)$/i;
const NUMBERED = /^((\d{1,2}(\.\d{1,2}){0,3}\.?)|([A-Z](\.\d{1,2}){0,3}\.?)|appendix [A-Z]\b[.:]?)\s+[A-Z(][^]{1,90}$/;

/** Display maths set large: an equation number, operators, math letters. */
function looksLikeMath(t) {
  if (/\(\d{1,3}\)\s*$/.test(t)) return true; // "(24)" equation number
  if (/[=∈∑∏∫≤≥≈→←⇒∀∃∂∇]|:=/.test(t)) return true;
  if (/[\u{1D400}-\u{1D7FF}]/u.test(t)) return true; // 𝒌 𝚯 …
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  return letters < t.replace(/\s/g, "").length * 0.6;
}

/** How a line could be a heading: "structural" (numbered, or a known name) or "big". */
export function headingKind(text, height, body) {
  const t = text.trim();
  if (t.length < 3 || t.length > 110) return null;
  if (/^\d+$/.test(t) || /^arxiv:\s*\d/i.test(t)) return null;
  if (/[.,;:]$/.test(t) && !/^\d/.test(t)) return null;
  /* a run-in heading ("Toy example. In Section 4.3 we…") is a paragraph */
  if (/[a-z)]\.\s+[A-Z]/.test(t.replace(/^\S+\s+/, ""))) return null;
  if (looksLikeMath(t)) return null;
  if (height >= body * 0.95 && NUMBERED.test(t)) return "structural";
  if (height >= body * 0.85 && HEADING_WORDS.test(t)) return "structural"; // "Abstract" is often set small
  if (height >= body * 1.12 && /[A-Za-z]{3}/.test(t) && t.split(/\s+/).length <= 14) return "big";
  return null;
}

/**
 * A PDF as blocks: headings and text, each with the page it starts on.
 * pdf.js is loaded on first use so the server starts without it.
 */
export async function extractPdf(bytes) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  try {
    const info = (await doc.getMetadata().catch(() => null))?.info ?? {};
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let text = "";
      let lastY = null;
      const sizes = new Map();
      const flush = () => {
        const t = text.replace(/\s+/g, " ").trim();
        if (t) {
          let height = 0;
          let most = -1;
          for (const [h, n] of sizes) if (n > most) (most = n), (height = h);
          lines.push({ text: t, height, page: p });
        }
        text = "";
        sizes.clear();
      };
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform[5];
        const h = Math.round(Math.hypot(item.transform[2], item.transform[3]) * 2) / 2;
        if (lastY !== null && Math.abs(y - lastY) > Math.max(2, h * 0.6) && text.trim()) flush();
        text += item.str;
        if (item.str.trim()) sizes.set(h, (sizes.get(h) ?? 0) + item.str.length);
        lastY = y;
        if (item.hasEOL) flush();
      }
      flush();
      page.cleanup();
    }

    /* the body font is the one most characters are set in */
    const weight = new Map();
    for (const l of lines) weight.set(l.height, (weight.get(l.height) ?? 0) + l.text.length);
    let body = 10;
    let most = -1;
    for (const [h, n] of weight) if (n > most) (most = n), (body = h);

    /* running heads and feet: the same short line on many pages */
    const seen = new Map();
    for (const l of lines) if (l.text.length < 90) seen.set(l.text, (seen.get(l.text) ?? 0) + 1);
    const repeated = new Set(
      [...seen].filter(([, n]) => doc.numPages >= 4 && n >= Math.max(3, doc.numPages * 0.3)).map(([t]) => t),
    );

    /* the title: the metadata if it is real, else the biggest line on page 1 */
    const metaTitle = String(info.Title || "").trim();
    let title = /^(untitled|microsoft word|.*\.(dvi|tex|docx?))/i.test(metaTitle) || metaTitle.length < 6 ? "" : metaTitle;
    if (!title) {
      /* a real title line: several words, not the arXiv side stamp, not a drop cap */
      const first = lines.filter(
        (l) =>
          l.page === 1 &&
          l.text.length >= 10 &&
          l.text.split(/\s+/).length >= 2 &&
          /[A-Za-z]{3}/.test(l.text) &&
          !/^arxiv:\s*\d/i.test(l.text),
      );
      const top = Math.max(0, ...first.map((l) => l.height));
      title = first
        .filter((l) => l.height === top)
        .slice(0, 3)
        .map((l) => l.text)
        .join(" ")
        .slice(0, 200);
    }

    const blocks = [];
    let para = [];
    let paraPage = 1;
    let structural = false; // until the first real heading, a big line is the masthead
    let lastHeading = null;
    const endPara = () => {
      const text = joinLines(para);
      if (text) blocks.push({ kind: "text", text, page: paraPage });
      para = [];
    };
    for (const l of lines) {
      if (repeated.has(l.text) || /^\d{1,4}$/.test(l.text) || /^arxiv:\s*\d/i.test(l.text)) continue;
      if (l.page === 1 && title && title.includes(l.text) && l.height > body * 1.3) continue;
      const kind = headingKind(l.text, l.height, body);
      if (kind === "structural" || (kind === "big" && structural)) {
        /* a heading that wraps: the second line is the same size, not numbered */
        if (
          kind === "big" &&
          lastHeading &&
          blocks[blocks.length - 1] === lastHeading.block &&
          !para.length &&
          lastHeading.page === l.page &&
          lastHeading.height === l.height
        ) {
          lastHeading.block.text += " " + l.text;
          continue;
        }
        endPara();
        const block = { kind: "heading", text: l.text.replace(/\s+/g, " "), page: l.page };
        blocks.push(block);
        lastHeading = { block, page: l.page, height: l.height };
        if (kind === "structural") structural = true;
        continue;
      }
      lastHeading = null;
      if (!para.length) paraPage = l.page;
      para.push(l.text);
      /* a short line that ends a sentence usually ends a paragraph */
      if (l.text.length < 55 && /[.!?:]$/.test(l.text)) endPara();
    }
    endPara();
    return { kind: "pdf", title: title || "", pages: doc.numPages, blocks };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

/**
 * OCR output as blocks. There are no font sizes here, so a heading is a
 * Markdown `#` line or a line that is numbered or a known section name. Lines
 * repeated on many pages (running heads) and lone page numbers are dropped;
 * a table the model wrote as HTML becomes ` | `-separated rows.
 */
export function blocksFromOcr(pageTexts) {
  const cleaned = pageTexts.map(({ page, text }) => ({
    page,
    lines: String(text || "")
      .replace(/<\/(td|th)>\s*/gi, " | ")
      .replace(/<\/tr>\s*/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim()),
  }));
  const seen = new Map();
  for (const p of cleaned) for (const l of new Set(p.lines)) if (l && l.length < 90) seen.set(l, (seen.get(l) ?? 0) + 1);
  const repeated = new Set(
    [...seen].filter(([, n]) => cleaned.length >= 4 && n >= Math.max(3, cleaned.length * 0.3)).map(([t]) => t),
  );

  const blocks = [];
  let title = "";
  for (const { page, lines } of cleaned) {
    let para = [];
    const endPara = () => {
      const text = joinLines(para);
      if (text) blocks.push({ kind: "text", text, page });
      para = [];
    };
    for (const line of lines) {
      if (!line) {
        endPara();
        continue;
      }
      if (repeated.has(line) || /^\d{1,4}$/.test(line) || /^arxiv:\s*\d/i.test(line)) continue;
      const md = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
      const text = md ? md[2].replace(/\*\*/g, "").trim() : line;
      if (md && page === 1 && !title && md[1].length === 1 && !/^\d/.test(text) && !HEADING_WORDS.test(text)) {
        endPara();
        title = text;
        continue;
      }
      if ((md && text.length <= 140 && !looksLikeMath(text)) || headingKind(text, 10, 10) === "structural") {
        endPara();
        blocks.push({ kind: "heading", text, page });
        continue;
      }
      para.push(line);
      if (line.length < 55 && /[.!?:]$/.test(line)) endPara();
    }
    endPara();
  }
  if (!title) {
    const first = blocks.find((b) => b.page === 1 && b.kind === "text" && b.text.length >= 10 && b.text.length <= 200);
    title = first ? first.text.split(/(?<=[.!?])\s/)[0].slice(0, 160) : "";
  }
  return { title, blocks };
}

/** A PDF read page by page by the OCR model instead of from its text layer. */
export async function extractPdfOcr(bytes, ocr, { onProgress, maxPages } = {}) {
  const out = await ocrPdf(bytes, ocr, { onProgress, maxPages });
  const { title, blocks } = blocksFromOcr(out.texts);
  return {
    kind: "pdf",
    title,
    pages: out.pages,
    blocks,
    extractor: `ocr:${out.model}`,
    ocr: { model: out.model, read: out.read, failed: out.failed },
  };
}

/** HTML as blocks, keeping h1–h6 as headings. */
export function extractHtml(html, { htmlToText, titleOf }) {
  const marked = String(html || "")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<title[\s\S]*?<\/title>/gi, " ")
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, level, inner) => `<br>\u0001H${level} ${inner.replace(/<[^>]+>/g, " ")}<br>`,
    );
  const text = htmlToText(marked);
  const blocks = [];
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^\u0001H([1-6])\s*(.*)$/.exec(line);
    if (h) {
      if (h[2].trim()) blocks.push({ kind: "heading", text: h[2].trim(), page: 0 });
    } else blocks.push({ kind: "text", text: line, page: 0 });
  }
  return { kind: "html", title: titleOf(html) || "", pages: 0, blocks };
}

/** Markdown or plain text: `#` lines are headings, blank lines end paragraphs. */
export function extractText(text, kind = "text") {
  const blocks = [];
  let title = "";
  for (const para of String(text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = para.split("\n");
    let rest = [];
    for (const line of lines) {
      const h = kind === "md" ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
      if (h) {
        if (rest.length) blocks.push({ kind: "text", text: rest.join(" ").trim(), page: 0 });
        rest = [];
        blocks.push({ kind: "heading", text: h[2], page: 0 });
        if (!title && h[1].length === 1) title = h[2];
      } else if (line.trim()) rest.push(line.trim());
    }
    if (rest.length) blocks.push({ kind: "text", text: rest.join(kind === "md" ? " " : "\n").trim(), page: 0 });
  }
  if (!title) title = (blocks.find((b) => b.kind === "text")?.text || "").split("\n")[0].slice(0, 80);
  return { kind, title, pages: 0, blocks };
}

/* ================================================================ chunk ===== */

/** Cut text near `target`, at a sentence end if one is close, else a space. */
function cutPoint(text, target) {
  if (text.length <= target) return text.length;
  const window = text.slice(Math.floor(target * 0.6), Math.min(text.length, CHUNK_MAX));
  const sentence = /[.!?]["')\]]?\s+(?=[A-Z(\["'])/g;
  let best = -1;
  let m;
  while ((m = sentence.exec(window))) {
    const at = Math.floor(target * 0.6) + m.index + m[0].length;
    if (at <= CHUNK_MAX) best = at;
    if (at >= target) break;
  }
  if (best > 0) return best;
  const space = text.lastIndexOf(" ", Math.min(text.length, CHUNK_MAX));
  return space > target * 0.5 ? space + 1 : Math.min(text.length, CHUNK_MAX);
}

/**
 * Blocks → chunks and an outline. A heading always starts a new chunk, so a
 * chunk never straddles two sections and every chunk can say where it is.
 */
export function chunkBlocks(blocks) {
  const chunks = [];
  const sections = [];
  let section = "";
  let buf = "";
  let bufPage = 0;
  const push = (text, page) => {
    const t = text.trim();
    if (t) chunks.push({ i: chunks.length, section, page, text: t });
  };
  const flush = (force) => {
    while (buf.length > CHUNK_TARGET || (force && buf.trim())) {
      const at = cutPoint(buf, CHUNK_TARGET);
      push(buf.slice(0, at), bufPage);
      buf = buf.slice(at).trimStart();
      if (!force && buf.length <= CHUNK_TARGET) break;
    }
  };
  for (const b of blocks) {
    if (b.kind === "heading") {
      flush(true);
      section = b.text;
      sections.push({ n: sections.length + 1, title: b.text, page: b.page, from: chunks.length, to: chunks.length - 1 });
      continue;
    }
    if (!buf) bufPage = b.page;
    buf += (buf ? "\n" : "") + b.text;
    flush(false);
  }
  flush(true);
  for (let s = 0; s < sections.length; s++) {
    sections[s].to = (s + 1 < sections.length ? sections[s + 1].from : chunks.length) - 1;
  }
  return { chunks, sections: sections.filter((s) => s.to >= s.from) };
}

/* ============================================================ embedding ===== */

/**
 * Embedding models want queries and passages framed differently. Matched on
 * the model id the server reports; unknown models get plain text, which works.
 */
export function embedPrefixes(modelId) {
  const id = String(modelId || "").toLowerCase();
  if (/qwen3?-?embed/.test(id)) {
    return { query: "Instruct: Given a question, retrieve passages that answer it\nQuery: ", doc: "" };
  }
  if (/nomic/.test(id)) return { query: "search_query: ", doc: "search_document: " };
  if (/\be5\b|multilingual-e5|e5-/.test(id)) return { query: "query: ", doc: "passage: " };
  if (/bge/.test(id)) return { query: "Represent this sentence for searching relevant passages: ", doc: "" };
  if (/snowflake|arctic-embed/.test(id)) return { query: "Represent this sentence for searching relevant passages: ", doc: "" };
  return { query: "", doc: "" };
}

function normalise(vec) {
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

/** A client for an OpenAI-compatible embeddings endpoint (llama-server --embedding). */
export function createEmbedder(baseUrl, { apiKey = "" } = {}) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!base) return null;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let model = null;

  /** The model's id, which keys stored vectors; an unreachable server throws. */
  async function modelId() {
    if (model !== null) return model;
    let res;
    try {
      res = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw new Error(`the embedding server at ${base} is not answering (${err instanceof Error ? err.message : err})`);
    }
    try {
      const json = await res.json();
      model = String(json?.data?.[0]?.id || json?.models?.[0]?.name || "embedding");
    } catch {
      model = "embedding"; // answers, but not with a model list: still usable
    }
    return model;
  }

  async function embed(texts, kind) {
    const id = await modelId();
    const prefix = embedPrefixes(id)[kind] || "";
    const out = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH).map((t) => prefix + t);
      let res;
      try {
        res = await fetch(`${base}/v1/embeddings`, {
          method: "POST",
          headers,
          body: JSON.stringify({ input: batch, model: id, encoding_format: "float" }),
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(`the embedding server at ${base} is not answering (${err instanceof Error ? err.message : err})`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `the embedding server answered ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}` +
            (res.status === 501 || /embedding/i.test(body) ? " — was it started with --embedding?" : ""),
        );
      }
      const json = await res.json();
      const rows = (json.data || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== batch.length) throw new Error("the embedding server returned the wrong number of vectors");
      for (const r of rows) out.push(normalise(r.embedding));
    }
    return { model: id, vectors: out };
  }

  return { base, modelId, embed };
}

/* ============================================================== library ===== */

const READABLE_EXT = { ".pdf": "pdf", ".html": "html", ".htm": "html", ".md": "md", ".markdown": "md", ".txt": "text", ".tex": "text", ".rst": "text" };

function detectKind({ bytes, type = "", name = "" }) {
  const head = bytes.subarray(0, 1024).toString("latin1");
  if (head.startsWith("%PDF") || type === "application/pdf") return "pdf";
  const ext = READABLE_EXT[path.extname(String(name).toLowerCase())];
  if (ext) return ext;
  if (/html/.test(type) || /<html|<!doctype html|<body/i.test(head)) return "html";
  if (/markdown/.test(type)) return "md";
  if (/^text\//.test(type) || /json|xml/.test(type)) return "text";
  /* no type and no extension: text if it decodes cleanly */
  const sample = bytes.subarray(0, 4096).toString("utf8");
  const bad = (sample.match(/�|[\u0000-\u0008\u000E-\u001F]/g) || []).length;
  return bad < sample.length * 0.01 ? "text" : null;
}

/** arXiv abstract pages and OpenReview forums → their PDFs. */
export function documentUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    return String(raw || "").trim();
  }
  if (/(^|\.)arxiv\.org$/.test(url.hostname)) {
    const m = /^\/(abs|html)\/(.+?)(\.pdf)?\/?$/.exec(url.pathname);
    if (m) return `https://arxiv.org/pdf/${m[2]}`;
  }
  if (/(^|\.)openreview\.net$/.test(url.hostname) && url.pathname === "/forum" && url.searchParams.get("id")) {
    return `https://openreview.net/pdf?id=${encodeURIComponent(url.searchParams.get("id"))}`;
  }
  return url.toString();
}

export function createLibrary({ root, download, htmlToText, titleOf }) {
  const docsDir = path.join(root, "docs");
  const inboxDir = path.join(root, "inbox");
  let cache = null; // { docs: [{meta, chunks, vectors}], bm25 }
  let queue = Promise.resolve();
  /** Long reads in progress (OCR), for the UI: key → { label, done, total, startedAt } */
  const jobs = new Map();
  let jobSeq = 0;
  const startJob = (label) => {
    const key = `job-${++jobSeq}`;
    jobs.set(key, { key, label, done: 0, total: 0, startedAt: Date.now() });
    return {
      progress: ({ done, total }) => Object.assign(jobs.get(key) ?? {}, { done, total }),
      end: () => jobs.delete(key),
    };
  };

  /** One write at a time: two adds racing would each rebuild a stale index. */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  function readDocDir(id) {
    const dir = path.join(docsDir, id);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
      const chunks = JSON.parse(fs.readFileSync(path.join(dir, "chunks.json"), "utf8"));
      let vectors = null;
      if (meta.embed?.dim) {
        try {
          const buf = fs.readFileSync(path.join(dir, "vectors.f32"));
          const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
          if (all.length === meta.embed.dim * chunks.length) vectors = all;
        } catch {
          /* vectors missing: keyword search still works */
        }
      }
      return { meta, chunks, vectors };
    } catch {
      return null;
    }
  }

  function load() {
    if (cache) return cache;
    const docs = [];
    let ids = [];
    try {
      ids = fs.readdirSync(docsDir);
    } catch {
      /* no library yet */
    }
    for (const id of ids) {
      const d = readDocDir(id);
      if (d) docs.push(d);
    }
    docs.sort((a, b) => (b.meta.addedAt || "").localeCompare(a.meta.addedAt || ""));
    cache = { docs, bm25: buildBm25(docs) };
    return cache;
  }

  const invalidate = () => {
    cache = null;
  };

  function buildBm25(docs) {
    const postings = new Map();
    const lengths = [];
    const refs = [];
    for (let d = 0; d < docs.length; d++) {
      const { meta, chunks } = docs[d];
      const titleTerms = terms(meta.title);
      for (const c of chunks) {
        const tokens = [...terms(c.text), ...terms(c.section), ...terms(c.section), ...titleTerms];
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        const ref = refs.length;
        refs.push([d, c.i]);
        lengths.push(tokens.length);
        for (const [t, n] of tf) {
          let list = postings.get(t);
          if (!list) postings.set(t, (list = []));
          list.push([ref, n]);
        }
      }
    }
    const avg = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
    return { postings, lengths, refs, avg };
  }

  function bm25Rank(index, query, allowDoc) {
    const k1 = 1.2;
    const b = 0.75;
    const N = index.refs.length;
    const scores = new Map();
    for (const t of new Set(terms(query))) {
      const list = index.postings.get(t);
      if (!list) continue;
      const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
      for (const [ref, tf] of list) {
        if (allowDoc && !allowDoc(index.refs[ref][0])) continue;
        const len = index.lengths[ref];
        const s = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / index.avg));
        scores.set(ref, (scores.get(ref) ?? 0) + s);
      }
    }
    return [...scores].sort((a, b2) => b2[1] - a[1]).map(([ref, score]) => ({ ref, score }));
  }

  function summary(d) {
    const m = d.meta;
    return {
      id: m.id,
      title: m.title,
      kind: m.kind,
      source: m.source,
      pages: m.pages,
      chars: m.chars,
      chunks: d.chunks.length,
      sections: m.sections.length,
      addedAt: m.addedAt,
      embedded: d.vectors ? m.embed.model : null,
      extractor: m.extractor || "text",
    };
  }

  /** Find a document by id, or by a title the model half-remembers. */
  function resolve(docs, ref) {
    const want = String(ref || "").trim().toLowerCase();
    if (!want) return null;
    const exact = docs.find((d) => d.meta.id === want);
    if (exact) return exact;
    const byTitle = docs.find((d) => d.meta.title.toLowerCase() === want);
    if (byTitle) return byTitle;
    const wantTerms = new Set(terms(want));
    let best = null;
    let bestScore = 0;
    for (const d of docs) {
      const t = terms(d.meta.title + " " + d.meta.id);
      const hit = t.filter((w) => wantTerms.has(w)).length / Math.max(1, wantTerms.size);
      if (hit > bestScore) (best = d), (bestScore = hit);
    }
    return bestScore >= 0.5 ? best : null;
  }

  async function embedDoc(dir, meta, chunks, embedder) {
    const texts = chunks.map((c) => `${meta.title}\n${c.section ? c.section + "\n" : ""}${c.text}`);
    const { model, vectors } = await embedder.embed(texts, "doc");
    const dim = vectors[0]?.length ?? 0;
    const flat = new Float32Array(dim * vectors.length);
    vectors.forEach((v, i) => flat.set(v, i * dim));
    writeDurable(path.join(dir, "vectors.f32"), Buffer.from(flat.buffer));
    meta.embed = { model, dim };
    writeDurable(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    return { model, dim };
  }

  /**
   * A PDF's blocks: from its text layer, or through OCR when asked (`forceOcr`)
   * or when there is no text layer to speak of and an OCR server is set.
   */
  async function readPdf(bytes, { ocr, forceOcr, label }) {
    const runOcr = async (why) => {
      const job = startJob(label);
      try {
        const x = await extractPdfOcr(bytes, ocr, { onProgress: job.progress });
        return { ...x, why };
      } finally {
        job.end();
      }
    };
    if (forceOcr) {
      if (!ocr) throw new Error("no OCR server is configured (Setup → OCR server)");
      const layer = await extractPdf(bytes).catch(() => null);
      const x = await runOcr("read with OCR on request");
      /* the text layer's title (metadata or the masthead) beats a guess from OCR */
      return { ...x, title: layer?.title && layer.title.length >= 6 ? layer.title : x.title };
    }
    const layer = await extractPdf(bytes);
    const layerChars = layer.blocks.reduce((n, b) => n + b.text.length, 0);
    if (layerChars >= 200 && layerChars >= layer.pages * 40) return { ...layer, extractor: "text" };
    if (!ocr) return { ...layer, extractor: "text" }; // too little text: the caller says why
    const x = await runOcr("no usable text layer, so it was read with OCR");
    return { ...x, title: layer.title && layer.title.length >= 6 ? layer.title : x.title };
  }

  /** Bytes in, a stored document out. Same bytes twice → the same document. */
  async function ingest({ bytes, type = "", name = "", source = "", embedder = null, ocr = null, forceOcr = false }) {
    if (!bytes?.length) return { ok: false, error: "the document is empty" };
    if (bytes.length > LIBRARY_MAX_BYTES) return { ok: false, error: `it is over the ${LIBRARY_MAX_BYTES / 1048576} MB limit` };
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const existing = load().docs.find((d) => d.meta.sha256 === hash);
    if (existing) return { ok: true, existing: true, doc: summary(existing), outline: existing.meta.sections };

    const kind = detectKind({ bytes, type, name });
    if (!kind) return { ok: false, error: `cannot read ${type || name || "that file"}: PDF, HTML, Markdown and plain text only` };
    if (kind !== "pdf" && forceOcr) return { ok: false, error: "OCR is for PDFs; this is " + kind };
    let extracted;
    try {
      if (kind === "pdf") extracted = await readPdf(bytes, { ocr, forceOcr, label: name || source || "a PDF" });
      else if (kind === "html") extracted = extractHtml(bytes.toString("utf8"), { htmlToText, titleOf });
      else extracted = extractText(bytes.toString("utf8"), kind);
    } catch (err) {
      return { ok: false, error: `could not read the ${kind.toUpperCase()}: ${err instanceof Error ? err.message : err}` };
    }
    const { chunks, sections } = chunkBlocks(extracted.blocks);
    const chars = chunks.reduce((n, c) => n + c.text.length, 0);
    if (chars < 200) {
      return {
        ok: false,
        error:
          kind !== "pdf"
            ? "there is almost no text in it"
            : extracted.ocr
              ? "even OCR found almost no text in it"
              : "the PDF has almost no text layer (a scan?) — set an OCR server in Setup to read it",
      };
    }
    const title = (extracted.title || path.basename(String(name || source || ""), path.extname(String(name || ""))) || "untitled")
      .replace(/\s+/g, " ")
      .trim();
    const id = `${slug(title)}-${hash.slice(0, 6)}`;
    const dir = path.join(docsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const meta = {
      id,
      title,
      kind,
      source: source || name || "",
      sha256: hash,
      pages: extracted.pages,
      chars,
      sections,
      addedAt: new Date().toISOString(),
      embed: null,
      extractor: extracted.extractor || "text",
      ocrFailedPages: extracted.ocr?.failed?.length ? extracted.ocr.failed : undefined,
    };
    const ext = kind === "pdf" ? ".pdf" : kind === "html" ? ".html" : kind === "md" ? ".md" : ".txt";
    writeDurable(path.join(dir, `source${ext}`), bytes);
    writeDurable(path.join(dir, "chunks.json"), JSON.stringify(chunks));
    writeDurable(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

    let embedNote = "";
    if (embedder) {
      try {
        await embedDoc(dir, meta, chunks, embedder);
      } catch (err) {
        embedNote = `stored without embeddings: ${err instanceof Error ? err.message : err}`;
      }
    }
    invalidate();
    const stored = load().docs.find((d) => d.meta.id === id);
    const notes = [
      extracted.why || "",
      extracted.ocr?.failed?.length ? `OCR could not read page${extracted.ocr.failed.length === 1 ? "" : "s"} ${extracted.ocr.failed.join(", ")}` : "",
      embedNote,
    ].filter(Boolean);
    return { ok: true, existing: false, doc: summary(stored), outline: sections, note: notes.join("; ") || undefined };
  }

  return {
    root,

    list() {
      return { ok: true, root, docs: load().docs.map(summary), jobs: [...jobs.values()] };
    },

    /** Long reads in progress, for a progress line. */
    jobs() {
      return [...jobs.values()];
    },

    addBytes(opts) {
      return serial(() => ingest(opts));
    },

    async addUrl(raw, { embedder = null, ocr = null, forceOcr = false } = {}) {
      const target = documentUrl(raw);
      const got = await download(target);
      if (!got.ok) return { ok: false, error: got.error };
      const name = decodeURIComponent(new URL(got.finalUrl).pathname.split("/").pop() || "");
      return serial(() => ingest({ bytes: got.bytes, type: got.type, name, source: got.finalUrl, embedder, ocr, forceOcr }));
    },

    /**
     * Read a stored PDF again through OCR — for papers whose text layer mangles
     * the maths. Same id, same added date; new chunks, outline and vectors.
     */
    reocr(id, { ocr, embedder = null } = {}) {
      return serial(async () => {
        if (!ocr) return { ok: false, error: "no OCR server is configured (Setup → OCR server)" };
        const d = load().docs.find((x) => x.meta.id === id);
        if (!d) return { ok: false, error: `no document ${id}` };
        if (d.meta.kind !== "pdf") return { ok: false, error: "only PDFs can be read with OCR" };
        const dir = path.join(docsDir, d.meta.id);
        let bytes;
        try {
          bytes = fs.readFileSync(path.join(dir, "source.pdf"));
        } catch {
          return { ok: false, error: "the original PDF is not in the library any more — add it again" };
        }
        let x;
        const job = startJob(d.meta.title);
        try {
          x = await extractPdfOcr(bytes, ocr, { onProgress: job.progress });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        } finally {
          job.end();
        }
        const { chunks, sections } = chunkBlocks(x.blocks);
        const chars = chunks.reduce((n, c) => n + c.text.length, 0);
        if (chars < 200) return { ok: false, error: "OCR found almost no text — the document was left as it was" };
        const meta = {
          ...d.meta,
          pages: x.pages,
          chars,
          sections,
          extractor: x.extractor,
          ocrFailedPages: x.ocr.failed.length ? x.ocr.failed : undefined,
          rereadAt: new Date().toISOString(),
          embed: null,
        };
        fs.rmSync(path.join(dir, "vectors.f32"), { force: true });
        writeDurable(path.join(dir, "chunks.json"), JSON.stringify(chunks));
        writeDurable(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
        let note = x.ocr.failed.length
          ? `OCR could not read page${x.ocr.failed.length === 1 ? "" : "s"} ${x.ocr.failed.join(", ")}`
          : "";
        if (embedder) {
          try {
            await embedDoc(dir, meta, chunks, embedder);
          } catch (err) {
            note = [note, `stored without embeddings: ${err instanceof Error ? err.message : err}`].filter(Boolean).join("; ");
          }
        }
        invalidate();
        const stored = load().docs.find((y) => y.meta.id === id);
        return { ok: true, doc: summary(stored), outline: sections, before: d.chunks.length, note: note || undefined };
      });
    },

    /** Files dropped into <root>/inbox are read in and moved out of the way. */
    scanInbox({ embedder = null, ocr = null } = {}) {
      return serial(async () => {
        let names = [];
        try {
          names = fs.readdirSync(inboxDir).filter((n) => !n.startsWith(".") && n !== "failed");
        } catch {
          fs.mkdirSync(inboxDir, { recursive: true });
          return { ok: true, added: [], failed: [] };
        }
        const added = [];
        const failed = [];
        for (const n of names) {
          const full = path.join(inboxDir, n);
          if (!fs.statSync(full).isFile()) continue;
          const out = await ingest({ bytes: fs.readFileSync(full), name: n, source: n, embedder, ocr });
          if (out.ok) {
            fs.rmSync(full, { force: true });
            added.push(out.doc.title);
          } else {
            fs.mkdirSync(path.join(inboxDir, "failed"), { recursive: true });
            fs.renameSync(full, path.join(inboxDir, "failed", n));
            writeDurable(path.join(inboxDir, "failed", `${n}.error.txt`), out.error + "\n");
            failed.push({ name: n, error: out.error });
          }
        }
        return { ok: true, added, failed };
      });
    },

    remove(id) {
      return serial(async () => {
        const d = load().docs.find((x) => x.meta.id === id);
        if (!d) return { ok: false, error: `no document ${id}` };
        fs.rmSync(path.join(docsDir, d.meta.id), { recursive: true, force: true });
        invalidate();
        return { ok: true, removed: d.meta.title };
      });
    },

    /** Give every document without vectors (or with another model's) some. */
    embedMissing(embedder) {
      return serial(async () => {
        if (!embedder) return { ok: false, error: "no embedding server is configured" };
        const model = await embedder.modelId();
        const todo = load().docs.filter((d) => !d.vectors || d.meta.embed?.model !== model);
        let done = 0;
        for (const d of todo) {
          await embedDoc(path.join(docsDir, d.meta.id), d.meta, d.chunks, embedder);
          done++;
        }
        invalidate();
        return { ok: true, embedded: done, model };
      });
    },

    /**
     * The chunks that best answer `query`. Keyword always; meaning too when an
     * embedder answers and the documents were embedded with the same model.
     */
    async search(query, { k = 5, doc = "", embedder = null } = {}) {
      const { docs, bm25 } = load();
      if (!docs.length) return { ok: true, query, mode: "empty", results: [] };
      const only = doc ? resolve(docs, doc) : null;
      if (doc && !only) return { ok: false, error: `no document matches "${doc}"`, docs: docs.map(summary) };
      const onlyIdx = only ? docs.indexOf(only) : -1;
      const allow = only ? (d) => d === onlyIdx : null;
      const want = Math.max(1, Math.min(10, Math.round(Number(k) || 5)));

      const keyword = bm25Rank(bm25, query, allow).slice(0, 50);
      let semantic = [];
      let mode = "keyword";
      let note = "";
      if (embedder) {
        try {
          const model = await embedder.modelId();
          const usable = docs
            .map((d, i) => ({ d, i }))
            .filter(({ d, i }) => d.vectors && d.meta.embed?.model === model && (!allow || allow(i)));
          if (usable.length) {
            const { vectors } = await embedder.embed([query], "query");
            const q = vectors[0];
            const scored = [];
            for (const { d, i } of usable) {
              const dim = d.meta.embed.dim;
              if (dim !== q.length) continue;
              for (let c = 0; c < d.chunks.length; c++) {
                let s = 0;
                const off = c * dim;
                for (let j = 0; j < dim; j++) s += d.vectors[off + j] * q[j];
                scored.push({ key: `${i}:${c}`, d: i, c, score: s });
              }
            }
            semantic = scored.sort((a, b) => b.score - a.score).slice(0, 50);
            mode = "hybrid";
            const missing = docs.length - usable.length;
            if (missing > 0 && !only) {
              note = `${missing} document${missing === 1 ? " is" : "s are"} not embedded yet and matched by keyword only (Library tab → embed)`;
            }
          } else {
            note = "no document is embedded yet with this model — keyword only (Library tab → embed)";
          }
        } catch (err) {
          mode = "keyword";
          note = `${err instanceof Error ? err.message : err} — keyword only`;
        }
      }

      /* reciprocal rank fusion: rank, not raw score, so the two scales never fight */
      const fused = new Map();
      keyword.forEach(({ ref }, rank) => {
        const [d, c] = bm25.refs[ref];
        const key = `${d}:${c}`;
        fused.set(key, { d, c, score: (fused.get(key)?.score ?? 0) + 1 / (60 + rank) });
      });
      semantic.forEach(({ key, d, c }, rank) => {
        fused.set(key, { d, c, score: (fused.get(key)?.score ?? 0) + 1 / (60 + rank) });
      });
      const results = [...fused.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, want)
        .map(({ d, c, score }) => {
          const docAt = docs[d];
          const chunk = docAt.chunks[c];
          return {
            doc: docAt.meta.id,
            title: docAt.meta.title,
            source: docAt.meta.source,
            section: chunk.section,
            page: chunk.page,
            chunk: chunk.i,
            of: docAt.chunks.length,
            score: Math.round(score * 10000) / 10000,
            text: chunk.text,
          };
        });
      return { ok: true, query, mode, note: note || undefined, results };
    },

    /**
     * Read from one document: its outline (no section, no chunk), a section by
     * number or name, or a run of chunks starting at one.
     */
    read(ref, { section = "", chunk = null, chars = READ_DEFAULT_CHARS } = {}) {
      const { docs } = load();
      const d = resolve(docs, ref);
      if (!d) {
        return {
          ok: false,
          error: `no document matches "${String(ref || "").slice(0, 80)}"`,
          docs: docs.slice(0, 20).map((x) => ({ id: x.meta.id, title: x.meta.title })),
        };
      }
      const budget = Math.max(1000, Math.min(READ_MAX_CHARS, Math.round(Number(chars) || READ_DEFAULT_CHARS)));
      const base = {
        ok: true,
        doc: d.meta.id,
        title: d.meta.title,
        source: d.meta.source,
        pages: d.meta.pages,
        chunks: d.chunks.length,
      };
      const sections = d.meta.sections;

      let from = null;
      let to = null;
      let label = "";
      const wanted = String(section ?? "").trim();
      if (wanted) {
        /* "3.1" or "B" means the paper's own numbering; only failing that, the outline position */
        const num = wanted.replace(/^(§|section)\s*/i, "").replace(/\.$/, "");
        let s = /^(\d+(\.\d+)*|[A-Z](\.\d+)*)$/.test(num)
          ? sections.find((x) => x.title.startsWith(num + " ") || x.title.startsWith(num + ". "))
          : null;
        if (!s && /^\d+$/.test(num) && Number(num) >= 1 && Number(num) <= sections.length) s = sections[Number(num) - 1];
        if (!s) {
          const low = wanted.toLowerCase();
          s =
            sections.find((x) => x.title.toLowerCase() === low) ||
            sections.find((x) => x.title.toLowerCase().startsWith(low + " ") || x.title.toLowerCase().startsWith(low)) ||
            sections.find((x) => x.title.toLowerCase().includes(low));
          if (!s) {
            const want = new Set(terms(wanted));
            let best = 0;
            for (const x of sections) {
              const hit = terms(x.title).filter((t) => want.has(t)).length / Math.max(1, want.size);
              if (hit > best) (best = hit), (s = x);
            }
            if (best < 0.5) s = null;
          }
        }
        if (!s) return { ...base, ok: false, error: `no section matches "${wanted}"`, outline: sections };
        from = s.from;
        to = s.to;
        label = s.title;
      } else if (chunk !== null && chunk !== "" && Number.isFinite(Number(chunk))) {
        from = Math.max(0, Math.min(d.chunks.length - 1, Math.round(Number(chunk))));
        to = d.chunks.length - 1;
        label = `from chunk ${from}`;
      } else {
        return { ...base, outline: sections, text: "", chars: 0 };
      }

      let text = "";
      let last = from - 1;
      let lastSection = null;
      for (let i = from; i <= to; i++) {
        const c = d.chunks[i];
        const head = c.section !== lastSection && c.section ? `\n## ${c.section}${c.page ? ` (p. ${c.page})` : ""}\n` : "";
        if (text.length + head.length + c.text.length > budget && i > from) break;
        text += head + c.text + "\n";
        lastSection = c.section;
        last = i;
      }
      text = text.trim();
      if (text.length > budget) text = text.slice(0, budget);
      return {
        ...base,
        label,
        from,
        to: last,
        more: last < to ? last + 1 : null,
        text,
        chars: text.length,
      };
    },
  };
}
