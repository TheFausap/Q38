import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".vite",
  "__pycache__",
  ".next",
  ".cache",
]);

const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".css",
  ".scss",
  ".html",
  ".htm",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".sql",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".env",
  ".sh",
  ".bash",
  ".zsh",
  ".xml",
  ".svg",
  ".csv",
  ".graphql",
  ".prisma",
  ".vue",
  ".svelte",
  ".lua",
  ".r",
  ".dockerfile",
  ".makefile",
  ".cmake",
  ".gradle",
]);

function workspaceRoot() {
  const raw = process.env.WORKSPACE_DIR || "./workspace";
  return path.resolve(process.cwd(), raw);
}

function defaultUpstream() {
  return (process.env.LLAMA_SERVER_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
}

function safeJoin(root, rel) {
  const resolved = path.resolve(root, rel || ".");
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error("path escapes workspace");
  }
  return resolved;
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  if (base === "makefile" || base === "dockerfile" || base === "license") return true;
  return false;
}

function walk(dir, root, depth, maxDepth, acc) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      const node = { name: entry.name, path: rel, type: "dir", children: [] };
      walk(full, root, depth + 1, maxDepth, node.children);
      acc.push(node);
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* ignore */
      }
      acc.push({
        name: entry.name,
        path: rel,
        type: "file",
        size,
        text: isTextFile(full),
      });
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
/** Same, but stops reading once the body is past `limit` bytes. */
function readBodyCapped(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error(`request body larger than ${Math.round(limit / 1e6)} MB`);
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
/**
 * What a dropped file is allowed to be called once it lands in the workspace.
 * Only the base name survives, so a drop can never write outside the root.
 */
function uploadName(raw) {
  const base = path.basename(String(raw || "").replace(/\\/g, "/"));
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!clean || clean === "." || clean === "..") return null;
  return clean.slice(0, 120);
}
/** Never clobber a file that is already in the workspace. */
function uniqueName(root, name) {
  if (!fs.existsSync(path.join(root, name))) return { name, renamed: false };
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 500; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(path.join(root, candidate))) return { name: candidate, renamed: true };
  }
  return { name: `${stem}-${Date.now()}${ext}`, renamed: true };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function lastMessage(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  return messages.length ? messages[messages.length - 1] : null;
}

/**
 * Is this request the workbench resuming a cut-off reply? llama.cpp continues a
 * trailing assistant message; the directive fallback shows up as a user turn that
 * says the previous reply was cut off.
 */
function isContinuation(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.continue_final_message === "content" || payload.continue_final_message === "reasoning_content") {
    return true;
  }
  if (payload.add_generation_prompt === false) return true;
  const last = lastMessage(payload);
  if (last && last.role === "assistant") return true;
  return Boolean(last && last.role === "user" && /cut off by the token limit/i.test(String(last.content || "")));
}

function demoContinuation() {
  const content = `
Also worth wiring in — a cancellation-aware SSE reader, since llama-server streams event-stream frames:

\`\`\`ts
export async function* readSse(res: Response, signal: AbortSignal) {
  if (!res.body) throw new Error("empty stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield JSON.parse(data) as Record<string, unknown>;
    }
  }
}
\`\`\`

Pass it the request's \`AbortSignal\` and history stops growing the moment the user hits **stop** — no orphaned timers, no half-written file.
`.trim();
  return { reasoning: [""], content };
}

function demoChunks(payload) {
  if (isContinuation(payload)) return demoContinuation();
  const reasoning = [
    "The user wants production-quality code from the coder construct.",
    " I'll keep the surface small, stream tokens, and return a complete module rather than a sketch.",
    " Stack: TypeScript + async HTTP. Include types, error paths, and a short usage note.",
  ];
  const content = `
Here is a compact, production-shaped fetch client with retries, timeouts, and typed errors.

\`\`\`ts
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(\`HTTP \${status} \${url}\`);
    this.name = "HttpError";
  }
}

export type RequestOpts = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
};

export async function request<T>(url: string, opts: RequestOpts = {}): Promise<T> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 20_000,
    retries = 2,
  } = opts;

  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, url, text);
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (err) {
      last = err;
      const retryable =
        err instanceof HttpError ? err.status >= 500 : true;
      if (!retryable || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}
\`\`\`

Wire this to llama-server as \`request(url + "/v1/chat/completions", { method: "POST", body })\`. Swap the demo stream for a live MAX MTP endpoint when \`llama-server\` is up.

**Defaults for this model:** temp 0.7 · top_k 64 · min_p 0.05 · top_p 0.95 · repeat_penalty off · context ≥ 24k (64k+ for real sessions) · no prompt cache.
`.trim();

  return { reasoning, content };
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/**
 * Prompt-progress heartbeat, the same shape llama-server streams when the
 * request sets `return_progress`. The demo uses it so the job console has
 * something honest to read while the "model" is thinking.
 */
async function demoProgress(res, payload) {
  if (!payload || !payload.return_progress) return;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const total = Math.max(64, Math.round(messages.reduce((n, m) => n + String(m.content || "").length, 0) / 3.6));
  const cache = Math.round(total * 0.25);
  const started = Date.now();
  const ticks = 6;
  for (let i = 0; i <= ticks; i++) {
    const processed = Math.round(cache + ((total - cache) * i) / ticks);
    sseWrite(res, {
      choices: [{ delta: {}, index: 0, finish_reason: null }],
      object: "chat.completion.chunk",
      prompt_progress: { total, cache, processed: Math.min(processed, total), time_ms: Date.now() - started },
    });
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function streamDemo(res, payload) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Q38-Demo", "1");
  const demoStartedAt = Date.now();
  const { reasoning, content } = demoChunks(payload);
  await demoProgress(res, payload);
  const slow = Number(process.env.DEMO_SLOW_TPS || 0);
  sseWrite(res, {
    choices: [{ delta: { reasoning_content: reasoning.join("") } }],
  });
  await new Promise((r) => setTimeout(r, 40));
  const words = content.split(/(\s+)/);
  let buf = "";
  for (const w of words) {
    buf += w;
    if (buf.length > 24) {
      sseWrite(res, { choices: [{ delta: { content: buf } }] });
      const chunkWords = buf.trim() ? buf.trim().split(/\s+/).length : 0;
      buf = "";
      const pauseMs = slow > 0 ? Math.round((chunkWords / slow) * 1000) : 12;
      await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(12, pauseMs))));
    }
  }
  if (buf) sseWrite(res, { choices: [{ delta: { content: buf } }] });
  const elapsedMs = Math.max(1, Date.now() - demoStartedAt);
  const wordCount = content.trim().split(/\s+/).length;
  const rate = slow > 0 ? slow : Number(((wordCount / elapsedMs) * 1000).toFixed(1));
  sseWrite(res, {
    choices: [{ delta: {}, finish_reason: "stop" }],
    timings: {
      prompt_n: 128,
      predicted_n: Math.round(wordCount * 1.5),
      predicted_per_second: rate,
      prompt_per_second: 210.4,
    },
    demo: true,
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

function proxyLlama(req, res, url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const upstreamHeader = req.headers["x-llama-upstream"];
    const upstream = String(upstreamHeader || defaultUpstream()).replace(/\/$/, "");
    const rest = url.pathname.replace(/^\/api\/llama/, "") + url.search;
    let target;
    try {
      target = new URL(rest || "/", `${upstream}/`);
    } catch (err) {
      sendJson(res, 500, {
        error: "bad llama-server URL",
        detail: err instanceof Error ? err.message : String(err),
      });
      finish();
      return;
    }

    const method = req.method || "GET";
    const lib = target.protocol === "https:" ? https : http;

    const run = async () => {
      const body =
        method === "GET" || method === "HEAD" ? undefined : await readBody(req);
      const headers = {};
      const pass = ["content-type", "authorization", "accept"];
      for (const key of pass) {
        const v = req.headers[key];
        if (typeof v === "string") headers[key] = v;
      }
      if (!headers.authorization && process.env.LLAMA_API_KEY) {
        headers.authorization = `Bearer ${process.env.LLAMA_API_KEY}`;
      }
      headers.host = target.host;
      if (body) headers["content-length"] = String(Buffer.byteLength(body));

      const proxyReq = lib.request(
        target,
        { method, headers },
        (proxyRes) => {
          req.socket?.setTimeout(0);
          proxyRes.socket?.setTimeout(0);
          if (res.writableEnded) {
            proxyRes.destroy();
            finish();
            return;
          }
          const out = { "x-q38-upstream": upstream };
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (v == null || HOP_BY_HOP.has(k.toLowerCase())) continue;
            out[k] = v;
          }
          res.writeHead(proxyRes.statusCode || 502, out);

          const kill = () => {
            if (!proxyRes.destroyed) proxyRes.destroy();
            if (!res.writableEnded) res.destroy();
            finish();
          };
          proxyRes.on("error", kill);
          res.on("error", kill);
          proxyRes.pipe(res);
          res.on("finish", finish);
          res.on("close", () => {
            if (!res.writableFinished) proxyRes.destroy();
            finish();
          });
        },
      );

      proxyReq.setTimeout(0);
      proxyReq.on("error", (err) => {
        if (!res.headersSent) {
          sendJson(res, 502, {
            error: `llama-server unreachable at ${upstream}`,
            detail: err.message,
          });
        } else if (!res.writableEnded) {
          res.destroy();
        }
        finish();
      });
      res.on("close", () => {
        if (!res.writableFinished && !proxyReq.destroyed) proxyReq.destroy();
      });
      if (body) proxyReq.end(body);
      else proxyReq.end();
    };

    run().catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      finish();
    });
  });
}

async function statusPayload(req) {
  const upstreamHeader = req.headers["x-llama-upstream"];
  const upstream = String(upstreamHeader || defaultUpstream()).replace(/\/$/, "");
  const result = {
    ok: false,
    loading: false,
    upstream,
    health: null,
    models: [],
    props: null,
    error: null,
    workspace: workspaceRoot(),
  };
  const headers = {};
  if (typeof req.headers.authorization === "string") {
    headers.authorization = req.headers.authorization;
  } else if (process.env.LLAMA_API_KEY) {
    headers.authorization = `Bearer ${process.env.LLAMA_API_KEY}`;
  }
  try {
    const ctrl = AbortSignal.timeout(2500);
    const [healthRes, modelsRes, propsRes] = await Promise.allSettled([
      fetch(upstream + "/health", { headers, signal: ctrl }),
      fetch(upstream + "/v1/models", { headers, signal: ctrl }),
      fetch(upstream + "/props", { headers, signal: ctrl }),
    ]);
    if (healthRes.status === "fulfilled" && healthRes.value.ok) {
      result.health = await healthRes.value.json().catch(() => ({ status: "ok" }));
      result.ok = true;
    } else if (healthRes.status === "fulfilled") {
      result.health = { status: healthRes.value.status };
      const body = await healthRes.value.text().catch(() => "");
      // llama-server refuses every route with 503 "Loading model" until the
      // weights are in memory: report it as warming, not as an error
      if (healthRes.value.status === 503 && /loading model|unavailable_error/i.test(body)) {
        result.loading = true;
      } else {
        result.error = `llama-server /health ${healthRes.value.status}`;
      }
    }
    if (modelsRes.status === "fulfilled" && modelsRes.value.ok) {
      const json = await modelsRes.value.json();
      result.models = json.data || [];
    }
    if (propsRes.status === "fulfilled" && propsRes.value.ok) {
      result.props = await propsRes.value.json();
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

/* ------------------------------------------------------------------ memory
 * Sessions keep their transcripts in the browser; the chunks they no longer
 * fit in the window live here, on disk, so the window stays small and nothing
 * is ever paraphrased away. One directory per session:
 *
 *   <state>/sessions/<id>/meta.json     title, timestamps, schema
 *   <state>/sessions/<id>/chunks.ndjson one chunk per line, newest last
 *
 * The index (term -> chunk) is derived on every read: a few megabytes at most,
 * and a derived index cannot drift out of step with the bodies.
 */

function stateRoot() {
  const explicit = process.env.Q38_STATE_DIR;
  if (explicit) return path.resolve(explicit);
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "q38");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "q38");
}

/**
 * Session ids are ours — uuid-shaped — but never trust one into a path: keep the
 * safe characters, refuse anything that is not a plain name after that (a
 * "../../etc" would otherwise survive as the directory "....etc").
 */
function safeSessionId(id) {
  const raw = String(id || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) throw new Error("bad session id");
  return raw;
}

function sessionDir(id) {
  return path.join(stateRoot(), "sessions", safeSessionId(id));
}

function readChunks(id) {
  const file = path.join(sessionDir(id), "chunks.ndjson");
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const chunk = JSON.parse(line);
      if (chunk && typeof chunk.id === "string") out.push(chunk);
    } catch {
      /* a torn line is skipped: the rest of the archive still loads */
    }
  }
  return out;
}

function writeChunks(id, chunks) {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "chunks.ndjson");
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : ""));
  fs.renameSync(tmp, file);
  return file;
}

function readMeta(id) {
  const file = path.join(sessionDir(id), "meta.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeMeta(id, patch) {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...(readMeta(id) || {}), ...patch, id: String(id), at: Date.now(), schema: 1 };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(next, null, 2));
  return next;
}

/** A ref without the body: what the window and the index need. */
function refOf(chunk) {
  const { body, ...ref } = chunk;
  return ref;
}

/** Largest chunk the memory store accepts, to keep a runaway turn off the disk. */
const MEMORY_MAX_BYTES = 4 * 1024 * 1024;

/** Longest drop the workbench will write into ./workspace. */
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

/* ------------------------------------------------------------------ web */
/**
 * Search and page reading for the model's tools.
 *
 * A tool the model calls has to survive the real web: an API that wants a key it
 * has not got, a result that is a PDF, a host that never answers. Every failure
 * below comes back as something the model can read and work around — never as a
 * broken turn.
 *
 * Providers, and what `auto` tries in order:
 *   searx       your own instance, no key            (Setup / Q38_SEARX_URL)
 *   brave       api.search.brave.com, key required   (Setup / Q38_SEARCH_KEY)
 *   tavily      api.tavily.com, key required
 *   duckduckgo  the keyless HTML endpoint, no promises
 */

const WEB_TIMEOUT_MS = 15_000;
const WEB_MAX_BYTES = 512 * 1024;
const WEB_MAX_REDIRECTS = 3;
/** No page is read from an address only this machine can reach unless asked. */
const WEB_USER_AGENT =
  "Q38-workbench/1.0 (local coding bench; reads pages for its own model)";

const SEARCH_PROVIDERS = ["auto", "searx", "brave", "tavily", "duckduckgo"];

/** Which provider a request will use, before anyone has tried it. */
export function pickProvider({ provider, key, searxUrl } = {}) {
  const want = String(provider || "auto").trim().toLowerCase();
  if (want && want !== "auto") return SEARCH_PROVIDERS.includes(want) ? want : "duckduckgo";
  if (searxUrl) return "searx";
  if (key) return "brave";
  return "duckduckgo";
}

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
  "#x27": "'", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", middot: "·", times: "×", deg: "°", euro: "€",
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-z#0-9x]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** The page as something worth putting in a prompt: no markup, no scripts. */
export function htmlToText(html) {
  const stripped = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(script|style|noscript|template)[^>]*\/?>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|tr|h[1-6]|section|article|header|footer|blockquote|pre|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The <title>, or the first heading, as a fallback. */
export function titleOf(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  if (title) {
    const text = htmlToText(title[1]);
    if (text) return text.slice(0, 200);
  }
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(String(html || ""));
  return heading ? htmlToText(heading[1]).slice(0, 200) : "";
}

/** DuckDuckGo hides the real address behind its own redirect. */
export function decodeDdgUrl(href) {
  const raw = String(href || "").trim();
  if (!raw) return "";
  const withScheme = raw.startsWith("//") ? `https:${raw}` : raw;
  try {
    const url = new URL(withScheme, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    if (target) return target;
    if (/(^|\.)duckduckgo\.com$/.test(url.hostname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

/** The href of an opening tag, whatever order its attributes came in. */
function hrefOf(attrs) {
  return /href=['"]([^'"]*)['"]/i.exec(String(attrs || ""))?.[1] || "";
}

/**
 * Every element whose opening tag carries `className`, with its own text.
 *
 * Attribute order is not ours to assume: DuckDuckGo has served
 * `<a class="result__a" href=…>` and `<a href=… class="result-link">` at
 * different times, and a parser that insists on one silently returns nothing
 * for the other.
 */
function elementsWithClass(src, className) {
  const out = [];
  const open = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*class=['"][^'"]*${className}[^'"]*['"][^>]*>`, "gi");
  for (const m of src.matchAll(open)) {
    const tag = m[1];
    const rest = src.slice((m.index || 0) + m[0].length);
    const end = rest.search(new RegExp(`</${tag}\\s*>`, "i"));
    out.push({ attrs: m[0], text: end < 0 ? rest.slice(0, 3000) : rest.slice(0, end) });
  }
  return out;
}

/** The html.duckduckgo.com layout. */
export function parseDuckHtml(html) {
  const src = String(html || "");
  const titles = elementsWithClass(src, "result__a");
  const snippets = elementsWithClass(src, "result__snippet");
  return titles.map((t, i) => ({
    title: htmlToText(t.text),
    url: decodeDdgUrl(hrefOf(t.attrs)),
    snippet: htmlToText(snippets[i]?.text || ""),
  }));
}

/** The lite.duckduckgo.com layout, for when the html page is not served. */
export function parseDuckLite(html) {
  const src = String(html || "");
  const titles = elementsWithClass(src, "result-link");
  const snippets = elementsWithClass(src, "result-snippet");
  return titles.map((t, i) => ({
    title: htmlToText(t.text),
    url: decodeDdgUrl(hrefOf(t.attrs)),
    snippet: htmlToText(snippets[i]?.text || ""),
  }));
}

export function parseSearxJson(json) {
  const list = Array.isArray(json?.results) ? json.results : [];
  return list.map((r) => ({
    title: String(r?.title || ""),
    url: String(r?.url || ""),
    snippet: String(r?.content || r?.snippet || ""),
  }));
}

export function parseBraveJson(json) {
  const list = Array.isArray(json?.web?.results) ? json.web.results : [];
  return list.map((r) => ({
    title: String(r?.title || ""),
    url: String(r?.url || ""),
    snippet: String(r?.description || ""),
  }));
}

export function parseTavilyJson(json) {
  const list = Array.isArray(json?.results) ? json.results : [];
  return list.map((r) => ({
    title: String(r?.title || ""),
    url: String(r?.url || ""),
    snippet: String(r?.content || ""),
  }));
}

/** One shape for every provider, with the junk taken out. */
function tidyResults(list, count) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const url = String(item?.url || "").trim();
    const title = decodeEntities(String(item?.title || "").replace(/\s+/g, " ")).trim();
    const snippet = decodeEntities(String(item?.snippet || "").replace(/\s+/g, " ")).trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: title || url, url, snippet: snippet.slice(0, 400) });
    if (out.length >= count) break;
  }
  return out;
}

/** Read a response body, but never more than `limit` bytes of it. */
async function readCapped(res, limit = WEB_MAX_BYTES) {
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      chunks.push(value.subarray(0, Math.max(0, limit - (size - value.length))));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

function withTimeout(ms = WEB_TIMEOUT_MS) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

/** "fetch failed" is undici's way of saying nothing at all: name the host. */
function transportReason(err) {
  const reason = err instanceof Error ? err.message : String(err);
  if (/timeout|abort/i.test(reason)) return `did not answer within ${Math.round(WEB_TIMEOUT_MS / 1000)}s`;
  if (/fetch failed|enotfound|eai_again|econnrefused|econnreset|ehostunreach|enetunreach|socket hang up/i.test(reason)) {
    return "no route to it from this machine";
  }
  return reason;
}

function hostOfTarget(target) {
  try {
    return new URL(String(target)).hostname;
  } catch {
    return String(target).slice(0, 60);
  }
}

/** fetch, but a transport failure comes back as a sentence worth reading. */
async function webFetch(target, init) {
  try {
    return await fetch(target, init);
  } catch (err) {
    throw new Error(`could not reach ${hostOfTarget(target)}: ${transportReason(err)}`);
  }
}

async function readJsonResponse(res) {
  const { text } = await readCapped(res, 256 * 1024);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`the provider answered with something that is not JSON (${res.status})`);
  }
}

/** The actual search, one provider at a time. Throws with a readable reason. */
export async function searchWeb({ query, count = 5, provider, key, searxUrl } = {}) {
  const chosen = pickProvider({ provider, key, searxUrl });
  const started = Date.now();
  const signal = withTimeout();
  const n = Math.max(1, Math.min(10, Math.round(Number(count) || 5)));

  if (chosen === "searx") {
    const base = String(searxUrl || "").trim().replace(/\/+$/, "");
    if (!base) throw new Error("no SearXNG URL is set");
    const withScheme = /^https?:\/\//i.test(base) ? base : `http://${base}`;
    const target = `${withScheme}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0`;
    const res = await webFetch(target, { headers: { Accept: "application/json", "User-Agent": WEB_USER_AGENT }, signal });
    if (!res.ok) {
      throw new Error(
        `SearXNG answered ${res.status}${res.status === 403 ? " (its settings.json needs format: [html, json])" : ""}`,
      );
    }
    return {
      provider: chosen,
      ms: Date.now() - started,
      results: tidyResults(parseSearxJson(await readJsonResponse(res)), n),
    };
  }

  if (chosen === "brave") {
    if (!key) throw new Error("no Brave Search API key is set");
    const target = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;
    const res = await webFetch(target, {
      headers: { Accept: "application/json", "X-Subscription-Token": key, "User-Agent": WEB_USER_AGENT },
      signal,
    });
    if (!res.ok) throw new Error(`Brave Search answered ${res.status}${res.status === 401 ? " (check the API key)" : ""}`);
    return {
      provider: chosen,
      ms: Date.now() - started,
      results: tidyResults(parseBraveJson(await readJsonResponse(res)), n),
    };
  }

  if (chosen === "tavily") {
    if (!key) throw new Error("no Tavily API key is set");
    const res = await webFetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
        "User-Agent": WEB_USER_AGENT,
      },
      body: JSON.stringify({ api_key: key, query, max_results: n, search_depth: "basic", include_answer: false }),
      signal,
    });
    if (!res.ok) throw new Error(`Tavily answered ${res.status}${res.status === 401 ? " (check the API key)" : ""}`);
    return {
      provider: chosen,
      ms: Date.now() - started,
      results: tidyResults(parseTavilyJson(await readJsonResponse(res)), n),
    };
  }

  // duckduckgo: two layouts, whichever answers today
  const headers = {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
  };
  let lastNote = "";
  for (const [host, parse] of [
    ["https://html.duckduckgo.com/html/", parseDuckHtml],
    ["https://lite.duckduckgo.com/lite/", parseDuckLite],
  ]) {
    let res;
    try {
      res = await webFetch(`${host}?q=${encodeURIComponent(query)}`, { headers, signal });
    } catch (err) {
      lastNote = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (!res.ok) {
      lastNote = `${new URL(host).hostname} answered ${res.status}`;
      continue;
    }
    const { text } = await readCapped(res, 512 * 1024);
    const results = tidyResults(parse(text), n);
    if (results.length) return { provider: chosen, ms: Date.now() - started, results };
    lastNote = `${new URL(host).hostname} returned no results`;
  }
  throw new Error(`DuckDuckGo did not answer with results (${lastNote})`);
}

/* ---------------------------------------------------------- page fetch */

function ipIsPrivate(host) {
  const ip = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (ip.includes(":")) {
    if (ip === "::" || ip === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true; // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return true; // fe80::/10
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return ipIsPrivate(mapped[1]);
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
  return false;
}

/** Hosts only this machine (or this network) can reach. */
export function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return ipIsPrivate(host);
  return false;
}

/** A URL the model may read, or the reason it may not. */
export function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    return { ok: false, error: "that is not a URL I can open" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `only http and https can be read, not ${url.protocol.replace(":", "")}` };
  }
  if (url.username || url.password) {
    return { ok: false, error: "URLs with credentials in them are not opened" };
  }
  if (!url.hostname) return { ok: false, error: "that URL has no host" };
  if (process.env.Q38_WEB_ALLOW_PRIVATE !== "1" && isPrivateHost(url.hostname)) {
    return {
      ok: false,
      error: `${url.hostname} is on this machine or this network, and the workbench only reads public addresses (Q38_WEB_ALLOW_PRIVATE=1 overrides)`,
    };
  }
  return { ok: true, url };
}

/** Belt and braces: a public name that resolves into the private range. */
async function resolvesIntoPrivate(hostname) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) return false;
  try {
    const found = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return found.some((entry) => ipIsPrivate(String(entry.address || "")));
  } catch {
    return false; // let the fetch itself report the bad name
  }
}

const TEXTUAL_TYPES = [
  "text/html", "text/plain", "text/markdown", "application/xhtml+xml",
  "application/json", "application/xml", "text/xml",
];

/** Open a public page and hand back something worth reading in a prompt. */
export async function fetchPage(raw, { chars = 6000 } = {}) {
  const checked = validateFetchUrl(raw);
  if (!checked.ok) return { ok: false, ...checked };
  const started = Date.now();
  const limit = Math.max(500, Math.min(20_000, Math.round(Number(chars) || 6000)));
  const signal = withTimeout();
  const headers = { Accept: "text/html,application/xhtml+xml,text/plain,application/json", "User-Agent": WEB_USER_AGENT };

  let current = checked.url;
  for (let hop = 0; hop <= WEB_MAX_REDIRECTS; hop++) {
    if (process.env.Q38_WEB_ALLOW_PRIVATE !== "1" && (await resolvesIntoPrivate(current.hostname))) {
      return { ok: false, error: `${current.hostname} resolves to a private address, so it is not read` };
    }
    let res;
    try {
      res = await fetch(current, { redirect: "manual", headers, signal });
    } catch (err) {
      return { ok: false, error: `could not reach ${current.hostname}: ${transportReason(err)}` };
    }
    if (res.status >= 300 && res.status < 400) {
      const where = res.headers.get("location");
      if (!where) return { ok: false, error: `${current.hostname} answered ${res.status} without telling me where to go` };
      const next = validateFetchUrl(new URL(where, current).toString());
      if (!next.ok) return { ok: false, error: `the redirect goes somewhere I will not follow: ${next.error}` };
      current = next.url;
      continue;
    }
    if (!res.ok) return { ok: false, error: `${current.hostname} answered ${res.status}` };

    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (type && !TEXTUAL_TYPES.includes(type)) {
      return { ok: false, error: `that is ${type}, and only text pages can be read` };
    }
    const { text: rawText, truncated: bytesTrimmed } = await readCapped(res);
    const isHtml = type.includes("html") || /<html|<body|<p[\s>]/i.test(rawText.slice(0, 2000));
    const full = isHtml ? htmlToText(rawText) : rawText.trim();
    const text = full.slice(0, limit);
    return {
      ok: true,
      url: checked.url.toString(),
      finalUrl: current.toString(),
      host: current.hostname,
      title: isHtml ? titleOf(rawText) : "",
      text,
      chars: text.length,
      totalChars: full.length,
      truncated: bytesTrimmed || full.length > text.length,
      ms: Date.now() - started,
    };
  }
  return { ok: false, error: `too many redirects (more than ${WEB_MAX_REDIRECTS})` };
}

export function createApi() {
  return async function q38Api(req, res, next) {
    const host = req.headers.host || "localhost";
    let url;
    try {
      url = new URL(req.url || "/", `http://${host}`);
    } catch {
      return next();
    }
    if (!url.pathname.startsWith("/api")) return next();

    try {
      if (url.pathname === "/api/status" && req.method === "GET") {
        sendJson(res, 200, await statusPayload(req));
        return;
      }

      if (url.pathname === "/api/workspace/tree" && req.method === "GET") {
        const root = workspaceRoot();
        const children = [];
        if (!fs.existsSync(root)) {
          sendJson(res, 200, { root, children: [], missing: true });
          return;
        }
        walk(root, root, 0, 8, children);
        sendJson(res, 200, { root, children });
        return;
      }

      if (url.pathname === "/api/workspace/file" && req.method === "GET") {
        const rel = url.searchParams.get("path") || "";
        const root = workspaceRoot();
        const full = safeJoin(root, rel);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (!isTextFile(full)) {
          sendJson(res, 415, { error: "binary or unsupported type" });
          return;
        }
        const stat = fs.statSync(full);
        if (stat.size > 800_000) {
          sendJson(res, 413, { error: "file too large for context" });
          return;
        }
        const content = fs.readFileSync(full, "utf8");
        sendJson(res, 200, { path: rel, content, size: stat.size });
        return;
      }

      if (url.pathname === "/api/workspace/upload" && req.method === "POST") {
        let raw;
        try {
          raw = await readBodyCapped(req, UPLOAD_MAX_BYTES + 64_000);
        } catch (err) {
          sendJson(res, err?.statusCode || 413, {
            error: err instanceof Error ? err.message : "could not read the upload",
          });
          return;
        }
        let payload = null;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          payload = null;
        }
        const name = uploadName(payload?.path);
        if (!name) {
          sendJson(res, 400, { error: "a file name is required" });
          return;
        }
        if (typeof payload?.content !== "string") {
          sendJson(res, 400, { error: `${name} is not text — only text files can be saved` });
          return;
        }
        const bytes = Buffer.byteLength(payload.content, "utf8");
        if (bytes > UPLOAD_MAX_BYTES) {
          sendJson(res, 413, {
            error: `${name} is ${bytes} bytes, over the ${UPLOAD_MAX_BYTES} byte limit`,
          });
          return;
        }
        const root = workspaceRoot();
        fs.mkdirSync(root, { recursive: true });
        const unique = uniqueName(root, name);
        fs.writeFileSync(path.join(root, unique.name), payload.content, "utf8");
        sendJson(res, 200, { path: unique.name, size: bytes, renamed: unique.renamed });
        return;
      }

      if (url.pathname.startsWith("/api/memory")) {
        /* GET routes name the session in the query; put/forget carry it in the
           body, so the id is validated where it is actually read. */
        let session = "";
        if (req.method === "GET") {
          try {
            session = safeSessionId(url.searchParams.get("session") || "");
          } catch {
            sendJson(res, 400, { error: "a session id of letters, digits, dash or underscore is required" });
            return;
          }
        }
        const id = url.searchParams.get("id") || "";

        if (url.pathname === "/api/memory/list" && req.method === "GET") {
          const chunks = readChunks(session);
          sendJson(res, 200, {
            ok: true,
            session,
            root: sessionDir(session),
            meta: readMeta(session),
            chunks: chunks.map(refOf),
          });
          return;
        }

        if (url.pathname === "/api/memory/chunk" && req.method === "GET") {
          const chunk = readChunks(session).find((c) => c.id === id);
          if (!chunk) {
            sendJson(res, 404, { error: `no chunk ${id} in this session` });
            return;
          }
          sendJson(res, 200, { ok: true, chunk });
          return;
        }

        if (url.pathname === "/api/memory/put" && req.method === "POST") {
          const raw = await readBodyCapped(req, MEMORY_MAX_BYTES);
          let payload = null;
          try {
            payload = JSON.parse(raw.toString("utf8"));
          } catch {
            payload = null;
          }
          const incoming = payload?.chunk;
          if (!incoming?.id || !Array.isArray(incoming?.body?.messages)) {
            sendJson(res, 400, { error: "a chunk with messages is required" });
            return;
          }
          try {
            safeSessionId(payload.session);
          } catch {
            sendJson(res, 400, { error: "a valid session id is required" });
            return;
          }
          const bytes = Buffer.byteLength(JSON.stringify(incoming), "utf8");
          if (bytes > MEMORY_MAX_BYTES) {
            sendJson(res, 413, { error: `chunk is ${bytes} bytes, over the ${MEMORY_MAX_BYTES} limit` });
            return;
          }
          const chunks = readChunks(payload.session);
          const at = chunks.findIndex((c) => c.id === incoming.id);
          if (at >= 0) chunks[at] = incoming;
          else chunks.push(incoming);
          writeChunks(payload.session, chunks);
          if (payload.meta) writeMeta(payload.session, payload.meta);
          sendJson(res, 200, { ok: true, seq: incoming.seq, chunks: chunks.length, bytes });
          return;
        }

        if (url.pathname === "/api/memory/forget" && req.method === "POST") {
          const raw = await readBodyCapped(req, 64_000);
          let payload = null;
          try {
            payload = JSON.parse(raw.toString("utf8"));
          } catch {
            payload = null;
          }
          try {
            safeSessionId(payload?.session);
          } catch {
            sendJson(res, 400, { error: "a valid session id is required" });
            return;
          }
          const ids = new Set(Array.isArray(payload.ids) ? payload.ids : []);
          const before = readChunks(payload.session);
          const keep = ids.size ? before.filter((c) => !ids.has(c.id)) : [];
          writeChunks(payload.session, keep);
          if (!keep.length) {
            const dir = sessionDir(payload.session);
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
          }
          sendJson(res, 200, { ok: true, removed: before.length - keep.length, chunks: keep.length });
          return;
        }

        sendJson(res, 404, { error: "unknown memory route" });
        return;
      }

      if (url.pathname === "/api/web/search" && req.method === "POST") {
        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw.toString("utf8") || "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: "the request body is not JSON" });
          return;
        }
        const query = String(payload?.query ?? "").trim();
        if (!query) {
          sendJson(res, 400, { ok: false, error: "a search needs a query" });
          return;
        }
        /* The provider and its key come from Setup through headers, the same way
           the llama-server URL does; the environment is the fallback. */
        const opts = {
          query,
          count: payload?.count,
          provider: payload?.provider || req.headers["x-q38-search-provider"] || process.env.Q38_SEARCH_PROVIDER,
          key: payload?.key || req.headers["x-q38-search-key"] || process.env.Q38_SEARCH_KEY,
          searxUrl: payload?.searxUrl || req.headers["x-q38-searx-url"] || process.env.Q38_SEARX_URL,
        };
        const provider = pickProvider(opts);
        try {
          const out = await searchWeb(opts);
          sendJson(res, 200, { ok: true, query, ...out });
        } catch (err) {
          sendJson(res, 502, {
            ok: false,
            provider,
            query,
            error: err instanceof Error ? err.message : String(err),
            hint:
              provider === "duckduckgo"
                ? "DuckDuckGo is keyless and unreliable; a SearXNG URL or an API key in Setup is steadier."
                : "check the provider settings in Setup",
          });
        }
        return;
      }

      if (url.pathname === "/api/web/fetch" && req.method === "POST") {
        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw.toString("utf8") || "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: "the request body is not JSON" });
          return;
        }
        const target = String(payload?.url ?? "").trim();
        if (!target) {
          sendJson(res, 400, { ok: false, error: "which page?" });
          return;
        }
        const out = await fetchPage(target, { chars: payload?.chars });
        if (!out.ok) {
          sendJson(res, 502, out);
          return;
        }
        sendJson(res, 200, out);
        return;
      }

      if (url.pathname === "/api/demo/chat" && req.method === "POST") {
        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          payload = null;
        }
        await streamDemo(res, payload);
        return;
      }

      if (url.pathname.startsWith("/api/llama")) {
        await proxyLlama(req, res, url);
        return;
      }

      sendJson(res, 404, { error: "unknown api route" });
    } catch (err) {
      if (res.headersSent) return;
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
