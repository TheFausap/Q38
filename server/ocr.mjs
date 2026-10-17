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

/** PaddleOCR-VL's own pixel ceiling (28 × 28 × 1280). */
export const OCR_MAX_PIXELS = 1_003_520;
export const OCR_DEFAULT_PROMPT = "OCR:";

/** OvisOCR2's whole-page instruction, verbatim from its model card. */
export const OVIS_PROMPT =
  "\nExtract all readable content from the image in natural human reading order and output the result as a single " +
  "Markdown document. For charts or images, represent them using an HTML image tag: <img " +
  'src="images/bbox_{left}_{top}_{right}_{bottom}.jpg" />, where left, top, right, bottom are bounding box coordinates ' +
  "scaled to [0, 1000). Format formulas as LaTeX. Format tables as HTML: <table>...</table>. Transcribe all other " +
  "text as standard Markdown. Preserve the original text without translation or paraphrasing.";

/**
 * How each OCR model wants to be asked. A profile is the prompt, the output
 * budget, the page resolution, any extra request fields, and the clean-up its
 * output needs.
 *
 *   paddleocr-vl  `OCR:` on a ~1 MP page — its own ceiling; strongest on text,
 *                 and on formulas only inside Paddle's layout pipeline
 *   ovisocr2      a whole page in one pass, at up to 2880² px, LaTeX formulas
 *                 and HTML tables, thinking off — the best formula scores of
 *                 the small models, read end to end as Q38 does
 *   custom        your own prompt, budget and resolution
 */
export const OCR_PROFILES = {
  "paddleocr-vl": {
    label: "PaddleOCR-VL",
    prompt: OCR_DEFAULT_PROMPT,
    maxTokens: 4096,
    pixels: 1_000_000,
    maxPixels: OCR_MAX_PIXELS,
    extra: {},
    dropImageTags: false,
  },
  ovisocr2: {
    label: "OvisOCR2",
    prompt: OVIS_PROMPT,
    maxTokens: 16384,
    /* ~200 dpi on a letter page: sub- and superscripts stay legible, and the
       page costs about 4k image tokens instead of the 8k a full 2880² would */
    pixels: 4_000_000,
    maxPixels: 2880 * 2880,
    extra: {
      chat_template_kwargs: { enable_thinking: false },
      mm_processor_kwargs: { images_kwargs: { min_pixels: 448 * 448, max_pixels: 2880 * 2880 } },
    },
    dropImageTags: true,
  },
  custom: {
    label: "Custom",
    prompt: OCR_DEFAULT_PROMPT,
    maxTokens: 8192,
    pixels: 2_000_000,
    maxPixels: 16_000_000,
    extra: {},
    dropImageTags: false,
  },
};

/** The profile a served model wants, from the id /v1/models reports. */
export function profileForModel(modelId) {
  const id = String(modelId || "").toLowerCase();
  if (/ovis/.test(id)) return "ovisocr2";
  if (/paddle/.test(id)) return "paddleocr-vl";
  return "paddleocr-vl";
}

/**
 * Small OCR models sometimes end a long page by repeating a fragment until the
 * token budget runs out. Cut such a tail back to one copy (OvisOCR2's own
 * `_clean_truncated_repeats`, ported).
 */
export function cleanTruncatedRepeats(text, { minTextLen = 8000, maxPeriod = 200, minRepeatChars = 100, minRepeatTimes = 5 } = {}) {
  const n = text.length;
  if (n < minTextLen) return text;
  const top = Math.min(maxPeriod, n - 1);
  for (let unit = 1; unit <= top; unit++) {
    if (text[n - 1] !== text[n - 1 - unit]) continue;
    let match = 1;
    let i = n - 2;
    while (i >= unit && text[i] === text[i - unit]) {
      match++;
      i--;
    }
    const total = match + unit;
    const times = Math.floor(total / unit);
    const tail = total % unit;
    if (times >= minRepeatTimes && total >= minRepeatChars) return text.slice(0, n - total + unit) + text.slice(n - tail);
  }
  return text;
}

/** A page's text as the profile wants it cleaned. */
export function cleanOcrText(text, profile) {
  let out = String(text || "").trim();
  if (profile?.dropImageTags) {
    out = out
      .split("\n\n")
      .filter((block) => !block.trim().startsWith('<img src="images/bbox_'))
      .join("\n\n");
  }
  return cleanTruncatedRepeats(out);
}
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
  const target = Math.max(200_000, Math.min(16_000_000, Number(maxPixels) || 1_000_000));
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
      const scale = Math.min(6, Math.sqrt(target / (unit.width * unit.height)));
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

/**
 * A client for an OpenAI-compatible vision endpoint serving an OCR model.
 *
 * `profile` is a name from OCR_PROFILES, or "auto" (the default) to pick one
 * from the served model's id. `prompt`, `maxTokens` and `pixels`, when given,
 * override the profile — that is what the Custom profile is made of.
 */
export function createOcr(
  baseUrl,
  { apiKey = "", model = "", profile = "auto", prompt = "", maxTokens = 0, pixels = 0 } = {},
) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!base) return null;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let id = model || null;
  let resolved = null;
  let extrasRefused = false;

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

  /** The settings this server gets: its profile, with any overrides on top. */
  async function settings() {
    if (resolved) return resolved;
    const m = await modelId();
    const name = profile && profile !== "auto" && OCR_PROFILES[profile] ? profile : profileForModel(m);
    const p = OCR_PROFILES[name];
    resolved = {
      name,
      label: p.label,
      model: m,
      prompt: String(prompt || "").trim() ? String(prompt) : p.prompt,
      maxTokens: Number(maxTokens) > 0 ? Math.min(32768, Math.round(Number(maxTokens))) : p.maxTokens,
      pixels: Number(pixels) > 0 ? Math.min(p.maxPixels, Math.round(Number(pixels))) : p.pixels,
      extra: p.extra,
      dropImageTags: p.dropImageTags,
    };
    return resolved;
  }

  async function post(body) {
    try {
      return await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`the OCR server at ${base} is not answering (${err instanceof Error ? err.message : err})`);
    }
  }

  /** One page image → its text, cleaned the way the profile wants. */
  async function readPage(png) {
    const cfg = await settings();
    const body = {
      model: cfg.model,
      temperature: 0,
      max_tokens: cfg.maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` } },
            { type: "text", text: cfg.prompt },
          ],
        },
      ],
    };
    let res = await post(extrasRefused ? body : { ...body, ...cfg.extra });
    /* a vLLM build that does not take a profile's extra fields answers 400:
       read the page without them rather than fail the whole document */
    if (res.status === 400 && !extrasRefused && Object.keys(cfg.extra).length) {
      extrasRefused = true;
      res = await post(body);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`the OCR server answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("the OCR server's answer had no text in it");
    return cleanOcrText(text, cfg);
  }

  return { base, modelId, settings, readPage };
}

/**
 * A whole PDF through OCR. Pages go out `concurrency` at a time; a page that
 * fails is tried once more, then marked unreadable. More than a quarter of the
 * pages failing fails the document, with the server's own reason.
 */
export async function ocrPdf(bytes, ocr, { concurrency = DEFAULT_CONCURRENCY, maxPages, onProgress } = {}) {
  const cfg = await ocr.settings(); // fail fast if the server is down
  const model = cfg.model;
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

  for await (const img of renderPages(bytes, { maxPages, maxPixels: cfg.pixels })) {
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
    profile: cfg.name,
    pages: pageCount,
    read: total,
    failed: failures.map((f) => f.page),
    texts: texts.filter(Boolean),
  };
}
