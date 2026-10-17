/**
 * OCR for the library: PDF pages rendered to images and read by a vision
 * model behind an OpenAI-compatible endpoint — PaddleOCR-VL under vLLM:
 *
 *   vllm serve PaddlePaddle/PaddleOCR-VL --trust-remote-code \
 *     --max-num-batched-tokens 16384 --no-enable-prefix-caching --mm-processor-cache-gb 0
 *
 * Each page is drawn by pdf.js onto an @napi-rs/canvas at about one megapixel
 * (the model's own ceiling is 1,003,520 pixels, so nothing is wasted on
 * downscaling), encoded as PNG, and sent as `[image, "OCR:"]` in one user
 * message at temperature 0 — the format PaddleOCR-VL is trained on. Two
 * pages are in flight at once; vLLM batches them.
 *
 * Used for PDFs with no text layer (scans) and, on request, for any PDF whose
 * maths and tables the text layer mangles.
 */
import { createRequire } from "node:module";

/** The model's own pixel ceiling (28 × 28 × 1280). */
export const OCR_MAX_PIXELS = 1_003_520;
export const OCR_DEFAULT_PROMPT = "OCR:";
const OCR_TIMEOUT_MS = 180_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_PAGES = 200;

const require = createRequire(import.meta.url);

/** Where pdf.js keeps the fonts and character maps a PDF may not embed. */
function pdfjsAssets() {
  try {
    const base = require.resolve("pdfjs-dist/package.json").replace(/package\.json$/, "");
    return { standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, cMapPacked: true };
  } catch {
    return {};
  }
}

/**
 * Page images, one at a time, so a 300-page scan never sits in memory whole.
 * Yields { page, total, png, width, height }.
 */
export async function* renderPages(bytes, { maxPixels = 1_000_000, maxPages = DEFAULT_MAX_PAGES } = {}) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let createCanvas;
  try {
    ({ createCanvas } = await import("@napi-rs/canvas"));
  } catch {
    throw new Error("page rendering needs @napi-rs/canvas, which did not install on this machine (npm install @napi-rs/canvas)");
  }
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    verbosity: 0,
    ...pdfjsAssets(),
  }).promise;
  try {
    const total = Math.min(doc.numPages, maxPages);
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      const unit = page.getViewport({ scale: 1 });
      const scale = Math.min(4, Math.sqrt(Math.min(maxPixels, OCR_MAX_PIXELS) / (unit.width * unit.height)));
      const viewport = page.getViewport({ scale });
      const width = Math.max(28, Math.floor(viewport.width));
      const height = Math.max(28, Math.floor(viewport.height));
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      const png = await canvas.encode("png");
      page.cleanup();
      yield { page: n, total, pages: doc.numPages, png, width, height };
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
}

/** A client for an OpenAI-compatible vision endpoint serving an OCR model. */
export function createOcr(baseUrl, { apiKey = "", model = "", prompt = OCR_DEFAULT_PROMPT, maxTokens = 4096 } = {}) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!base) return null;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let id = model || null;

  async function modelId() {
    if (id) return id;
    let res;
    try {
      res = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw new Error(`the OCR server at ${base} is not answering (${err instanceof Error ? err.message : err})`);
    }
    const json = await res.json().catch(() => null);
    id = String(json?.data?.[0]?.id || "PaddlePaddle/PaddleOCR-VL");
    return id;
  }

  /** One page image → its text. */
  async function readPage(png) {
    const m = await modelId();
    let res;
    try {
      res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: m,
          temperature: 0,
          max_tokens: maxTokens,
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` } },
                { type: "text", text: prompt },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`the OCR server at ${base} is not answering (${err instanceof Error ? err.message : err})`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`the OCR server answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("the OCR server's answer had no text in it");
    return text.trim();
  }

  return { base, modelId, readPage };
}

/**
 * A whole PDF through OCR. Pages go out `concurrency` at a time; a page that
 * fails is tried once more, then marked unreadable. More than a quarter of the
 * pages failing fails the document, with the server's own reason.
 */
export async function ocrPdf(bytes, ocr, { concurrency = DEFAULT_CONCURRENCY, maxPages, onProgress } = {}) {
  const model = await ocr.modelId(); // fail fast if the server is down
  const texts = [];
  const failures = [];
  let done = 0;
  let total = 0;
  let pageCount = 0;
  const inFlight = new Set();

  const readOne = async ({ page, png }) => {
    let text = "";
    try {
      text = await ocr.readPage(png);
    } catch (first) {
      try {
        text = await ocr.readPage(png);
      } catch (second) {
        failures.push({ page, error: second instanceof Error ? second.message : String(second) });
        text = "";
      }
    }
    texts[page - 1] = { page, text };
    done++;
    onProgress?.({ done, total });
  };

  for await (const img of renderPages(bytes, { maxPages })) {
    total = img.total;
    pageCount = img.pages;
    if (!done) onProgress?.({ done, total });
    const p = readOne(img).finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= Math.max(1, concurrency)) await Promise.race(inFlight);
    if (failures.length > Math.max(2, total * 0.25)) break;
  }
  await Promise.all(inFlight);

  if (failures.length && failures.length > Math.max(2, total * 0.25)) {
    throw new Error(`OCR failed on ${failures.length} pages — ${failures[0].error}`);
  }
  return {
    model,
    pages: pageCount,
    read: total,
    failed: failures.map((f) => f.page),
    texts: texts.filter(Boolean),
  };
}
