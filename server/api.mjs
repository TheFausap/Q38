import fs from "node:fs";
import http from "node:http";
import https from "node:https";
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function demoChunks() {
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

async function streamDemo(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Q38-Demo", "1");
  const { reasoning, content } = demoChunks();
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
      buf = "";
      await new Promise((r) => setTimeout(r, 12));
    }
  }
  if (buf) sseWrite(res, { choices: [{ delta: { content: buf } }] });
  sseWrite(res, {
    choices: [{ delta: {}, finish_reason: "stop" }],
    timings: {
      prompt_n: 128,
      predicted_n: 420,
      predicted_per_second: 38.2,
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

      if (url.pathname === "/api/demo/chat" && req.method === "POST") {
        await streamDemo(res);
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
