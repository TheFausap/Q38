import type { ChatMessage, Sampling, ServerStatus, Settings, Timings } from "./types";

export type StreamHandlers = {
  onReasoning: (chunk: string) => void;
  onContent: (chunk: string) => void;
  onTimings: (t: Timings, extra?: { demo?: boolean }) => void;
};

/** Static hosts (npx serve, dotnet serve) have no /api proxy. Once we see HTML/304, skip it. */
let proxyDead = false;

export function proxyIsDead() {
  return proxyDead;
}

const STATIC_HINT =
  "This page is on a static host (serve / dist) with no /api proxy. Use `npm start` after `npm run build`, or `npm run dev`. Talking to llama-server directly as a fallback.";

function llamaHeaders(settings: Settings, extra?: Record<string, string>): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Llama-Upstream": settings.llamaUrl,
    ...extra,
  };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

function upstream(settings: Settings) {
  return settings.llamaUrl.replace(/\/$/, "") || "http://127.0.0.1:8080";
}

function isStaticHole(res: Response, bodyText?: string) {
  if (res.status === 304) return true;
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("text/html")) return true;
  if (ct.includes("application/json") || ct.includes("text/event-stream")) return false;
  const t = (bodyText || "").trimStart();
  return t.startsWith("<!") || t.startsWith("<html");
}

async function readMaybeJson(res: Response): Promise<unknown | null> {
  if (res.status === 304) {
    proxyDead = true;
    return null;
  }
  const text = await res.text();
  if (isStaticHole(res, text)) {
    proxyDead = true;
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    proxyDead = true;
    return null;
  }
}

async function fetchStatusDirect(settings: Settings): Promise<ServerStatus> {
  const base = upstream(settings);
  const headers: Record<string, string> = {};
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const result: ServerStatus = {
    ok: false,
    upstream: base,
    health: null,
    models: [],
    props: null,
    error: null,
    workspace: "",
    via: "direct",
    hint: STATIC_HINT,
  };
  try {
    const ctrl = AbortSignal.timeout(2500);
    const [healthRes, modelsRes, propsRes] = await Promise.allSettled([
      fetch(base + "/health", { headers, signal: ctrl }),
      fetch(base + "/v1/models", { headers, signal: ctrl }),
      fetch(base + "/props", { headers, signal: ctrl }),
    ]);
    if (healthRes.status === "fulfilled" && healthRes.value.ok) {
      result.health = await healthRes.value.json().catch(() => ({ status: "ok" }));
      result.ok = true;
    } else if (healthRes.status === "fulfilled") {
      result.health = { status: healthRes.value.status };
      result.error = `llama-server /health ${healthRes.value.status}`;
    } else {
      result.error = healthRes.reason instanceof Error ? healthRes.reason.message : String(healthRes.reason);
    }
    if (modelsRes.status === "fulfilled" && modelsRes.value.ok) {
      const json = await modelsRes.value.json();
      result.models = json.data || [];
    }
    if (propsRes.status === "fulfilled" && propsRes.value.ok) {
      result.props = await propsRes.value.json();
    }
    if (!result.ok && /Failed to fetch|NetworkError|CORS/i.test(result.error || "")) {
      result.error =
        `Cannot reach ${base} from the browser (CORS or it is down). ` +
        `Static serve has no proxy — run npm start after npm run build.`;
      result.via = "none";
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.via = "none";
  }
  return result;
}

export async function fetchStatus(settings: Settings): Promise<ServerStatus> {
  if (!proxyDead) {
    try {
      const res = await fetch("/api/status", {
        headers: llamaHeaders(settings),
        cache: "no-store",
      });
      const json = (await readMaybeJson(res)) as ServerStatus | null;
      if (json && typeof json === "object" && "upstream" in json) {
        return { ...json, via: json.via || "proxy" };
      }
    } catch {
      proxyDead = true;
    }
  }
  return fetchStatusDirect(settings);
}

export async function fetchTree() {
  if (proxyDead) {
    return { root: "", children: [], missing: true };
  }
  const res = await fetch("/api/workspace/tree");
  const json = await readMaybeJson(res);
  if (!json || typeof json !== "object") {
    return { root: "", children: [], missing: true };
  }
  return json as {
    root: string;
    children: import("./types").FileNode[];
    missing?: boolean;
  };
}

export async function fetchFile(path: string) {
  if (proxyDead) throw new Error("workspace reads need npm start (static serve has no /api)");
  const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);
  const json = (await readMaybeJson(res)) as { error?: string; path?: string; content?: string; size?: number } | null;
  if (!json || json.error || json.content === undefined) {
    throw new Error(json?.error || "could not read file");
  }
  return json as { path: string; content: string; size: number };
}

function toPayload(
  messages: ChatMessage[],
  sampling: Sampling,
  settings: Settings,
) {
  const out: { role: string; content: string }[] = [];
  if (settings.systemPrompt.trim()) {
    out.push({ role: "system", content: settings.systemPrompt.trim() });
  }
  for (const m of messages) {
    if (m.role === "system") continue;
    let content = m.content;
    if (m.role === "user" && m.attachments?.length) {
      const blocks = m.attachments
        .map((a) => `### Context: ${a.path}\n\`\`\`\n${a.content}\n\`\`\``)
        .join("\n\n");
      content = `${content}\n\n${blocks}`;
    }
    out.push({ role: m.role, content });
  }
  return {
    messages: out,
    stream: true,
    temperature: sampling.temperature,
    top_p: sampling.top_p,
    top_k: sampling.top_k,
    min_p: sampling.min_p,
    repeat_penalty: sampling.repeat_penalty,
    max_tokens: sampling.max_tokens,
    cache_prompt: sampling.cache_prompt,
    chat_template_kwargs: { enable_thinking: sampling.enable_thinking },
    reasoning_effort: sampling.reasoning_effort,
    reasoning_format: "deepseek",
  };
}

async function readSse(
  res: Response,
  handlers: StreamHandlers,
  signal: AbortSignal,
) {
  if (!res.body) throw new Error("empty stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let demo = res.headers.get("x-q38-demo") === "1";

  const consume = (data: string) => {
    if (data === "[DONE]") return true;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (json.demo) demo = true;
    const choices = json.choices as
      | { delta?: Record<string, string>; message?: Record<string, string> }[]
      | undefined;
    const delta = choices?.[0]?.delta;
    const message = choices?.[0]?.message;
    const r =
      delta?.reasoning_content ||
      delta?.reasoning ||
      message?.reasoning_content ||
      "";
    const c = delta?.content || message?.content || "";
    if (r) handlers.onReasoning(r);
    if (c) handlers.onContent(c);
    if (json.timings && typeof json.timings === "object") {
      handlers.onTimings(json.timings as Timings, { demo });
    }
    return false;
  };

  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (consume(data)) return { demo };
    }
  }
  if (buf.trim().startsWith("data:")) {
    consume(buf.trim().slice(5).trim());
  }
  return { demo };
}

async function openChatStream(
  url: string,
  headers: HeadersInit,
  payload: unknown,
  signal: AbortSignal,
): Promise<Response | "static" | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (res.status === 304 || ct.includes("text/html")) return "static";
    if (res.ok && res.body && (ct.includes("event-stream") || ct.includes("json") || !ct)) {
      return res;
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      if (isStaticHole(res, errText)) return "static";
      throw new Error(errText || `llama-server ${res.status}`);
    }
    return res.body ? res : null;
  } catch (err) {
    if (signal.aborted) throw err;
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof Error && err.message && !/Failed to fetch|NetworkError|unreachable/i.test(err.message)) {
      throw err;
    }
    return null;
  }
}

export async function streamChat(
  messages: ChatMessage[],
  sampling: Sampling,
  settings: Settings,
  handlers: StreamHandlers,
  signal: AbortSignal,
  forceDemo = false,
): Promise<{ demo: boolean }> {
  const payload = toPayload(messages, sampling, settings);
  const headers = llamaHeaders(settings);

  if (!forceDemo && !proxyDead) {
    const proxied = await openChatStream(
      "/api/llama/v1/chat/completions",
      headers,
      payload,
      signal,
    );
    if (proxied === "static") {
      proxyDead = true;
    } else if (proxied) {
      return readSse(proxied, handlers, signal);
    }
  }

  if (!forceDemo) {
    const direct = await openChatStream(
      `${upstream(settings)}/v1/chat/completions`,
      llamaHeaders(settings, { Accept: "text/event-stream" }),
      payload,
      signal,
    );
    if (direct && direct !== "static") {
      return readSse(direct, handlers, signal);
    }
  }

  if (!proxyDead) {
    const demoRes = await openChatStream("/api/demo/chat", { "Content-Type": "application/json" }, payload, signal);
    if (demoRes && demoRes !== "static") {
      await readSse(demoRes, handlers, signal);
      return { demo: true };
    }
    if (demoRes === "static") proxyDead = true;
  }

  throw new Error(
    proxyDead
      ? `No Q38 proxy on this host, and llama-server at ${upstream(settings)} did not stream. After npm run build use npm start (not npx serve / dotnet serve). If you stay on a static host, enable CORS on llama-server and check Setup → URL.`
      : `llama-server unreachable at ${upstream(settings)}`,
  );
}

export function guessLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    mjs: "js",
    py: "python",
    rs: "rust",
    go: "go",
    json: "json",
    md: "md",
    css: "css",
    html: "html",
    sh: "bash",
    bash: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sql: "sql",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    rb: "ruby",
    php: "php",
    vue: "html",
    svelte: "html",
  };
  return map[ext] || ext || "txt";
}

export function extForLang(lang: string): string {
  const map: Record<string, string> = {
    typescript: "ts",
    javascript: "js",
    tsx: "tsx",
    jsx: "jsx",
    python: "py",
    rust: "rs",
    golang: "go",
    bash: "sh",
    shell: "sh",
    yaml: "yml",
    markdown: "md",
    text: "txt",
  };
  return map[lang] || lang || "txt";
}
