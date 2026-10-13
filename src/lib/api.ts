import type {
  ChatMessage,
  FinishInfo,
  PromptProgress,
  Sampling,
  ServerStatus,
  Settings,
  Timings,
} from "./types";

export type StreamHandlers = {
  onReasoning: (chunk: string) => void;
  onContent: (chunk: string) => void;
  onTimings: (t: Timings, extra?: { demo?: boolean }) => void;
  /** fired once, when the round ends (finish_reason / stop_type). */
  onFinish?: (info: FinishInfo) => void;
  /** llama-server's prefill heartbeat, while the prompt is being read. */
  onProgress?: (p: PromptProgress) => void;
  /** the server is up but the model is not in memory yet; the job is queued. */
  onServerLoading?: (waitingMs: number) => void;
};

export type ChatStreamOptions = {
  forceDemo?: boolean;
  /** queue the job while llama-server loads the model (default true) */
  waitForModel?: boolean;
  /** how long to keep queueing before giving up, ms */
  modelWaitMs?: number;
  /** compaction briefs injected as system turns, right after the system prompt */
  systemExtra?: string[];
  /**
   * Continue a trailing assistant message instead of starting a new turn.
   * "content" is the prefill path (llama-server honours it, older builds follow it
   * through --prefill-assistant); "reasoning_content" resumes a thinking block.
   */
  continueFinal?: "content" | "reasoning_content" | null;
  /** extra user turn appended after the transcript (directive resume). */
  directive?: string;
  stream?: boolean;
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

/** llama-server answers every route with 503 "Loading model" until the weights are in. */
export function isLoadingModel(status: number, body: string): boolean {
  if (status !== 503) return false;
  return /loading model|unavailable_error/i.test(body);
}

/** Sleep that gives up the moment the job is cancelled. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
      const body = await healthRes.value.text().catch(() => "");
      if (isLoadingModel(healthRes.value.status, body)) {
        result.loading = true;
        result.error = null;
      } else {
        result.error = `llama-server /health ${healthRes.value.status}`;
      }
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
        const loading =
          json.loading === true ||
          (json.error == null && json.ok === false && json.health != null && json.health.status === 503);
        return { ...json, loading: json.loading ?? loading, via: json.via || "proxy" };
      }
    } catch {
      proxyDead = true;
    }
  }
  return fetchStatusDirect(settings);
}

/**
 * The workspace tree. A failure is reported as `ok: false` rather than an empty
 * list, because "the workbench cannot reach its own API" and "the folder is
 * empty" look identical in the UI otherwise — and they need different answers.
 */
export async function fetchTree() {
  const failed = (reason: string) => ({
    ok: false as const,
    root: "",
    children: [] as import("./types").FileNode[],
    missing: true,
    error: reason,
  });
  if (proxyDead) return failed("the workbench API is not reachable — run npm run dev or npm start");
  try {
    const res = await fetch("/api/workspace/tree");
    const json = (await readMaybeJson(res)) as {
      root?: string;
      children?: import("./types").FileNode[];
      missing?: boolean;
      error?: string;
    } | null;
    if (!json || typeof json !== "object" || !Array.isArray(json.children)) {
      return failed(`the workspace API answered ${res.status} and nothing usable`);
    }
    return {
      ok: true as const,
      root: json.root || "",
      children: json.children,
      missing: Boolean(json.missing),
    };
  } catch {
    return failed("the workbench API is not reachable — is npm run dev still running?");
  }
}

/**
 * Drop a file into ./workspace. The server keeps only the base name and never
 * clobbers an existing file — a taken name comes back as `config-2.json`.
 */
export async function uploadWorkspaceFile(name: string, content: string) {
  if (proxyDead) throw new Error("saving to the workspace needs npm run dev or npm start");
  const res = await fetch("/api/workspace/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: name, content }),
  });
  const json = (await readMaybeJson(res)) as
    | { error?: string; path?: string; size?: number; renamed?: boolean }
    | null;
  if (!res.ok || !json || json.error || !json.path) {
    throw new Error(json?.error || `could not save ${name}`);
  }
  return json as { path: string; size: number; renamed?: boolean };
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

/** Exact token count through llama-server's /tokenize. null when unavailable. */
export async function countTokens(text: string, settings: Settings): Promise<number | null> {
  if (!text) return 0;
  const body = JSON.stringify({ content: text });
  const post = async (url: string) => {
    const res = await fetch(url, { method: "POST", headers: llamaHeaders(settings), body });
    const json = (await readMaybeJson(res)) as { tokens?: unknown } | null;
    if (!json || json.tokens === undefined) return null;
    if (Array.isArray(json.tokens)) return json.tokens.length;
    if (typeof json.tokens === "number") return json.tokens;
    return null;
  };
  if (!proxyDead) {
    try {
      const n = await post("/api/llama/tokenize");
      if (n !== null) return n;
    } catch {
      /* fall through to the direct path */
    }
  }
  try {
    return await post(`${upstream(settings)}/tokenize`);
  } catch {
    return null;
  }
}

type WireMessage = { role: string; content: string };

export function buildWireMessages(
  messages: ChatMessage[],
  settings: Settings,
  opts: ChatStreamOptions,
): WireMessage[] {
  const out: WireMessage[] = [];
  if (settings.systemPrompt.trim()) {
    out.push({ role: "system", content: settings.systemPrompt.trim() });
  }
  for (const brief of opts.systemExtra ?? []) {
    if (brief.trim()) out.push({ role: "system", content: brief.trim() });
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
  if (opts.directive?.trim()) {
    out.push({ role: "user", content: opts.directive.trim() });
  }
  return out;
}

export function buildChatPayload(
  messages: ChatMessage[],
  sampling: Sampling,
  settings: Settings,
  opts: ChatStreamOptions,
) {
  const payload: Record<string, unknown> = {
    messages: buildWireMessages(messages, settings, opts),
    stream: opts.stream !== false,
    temperature: sampling.temperature,
    top_p: sampling.top_p,
    top_k: sampling.top_k,
    min_p: sampling.min_p,
    repeat_penalty: sampling.repeat_penalty,
    max_tokens: sampling.max_tokens,
    cache_prompt: sampling.cache_prompt,
    // llama-server streams prompt_progress chunks while it reads the prompt.
    // Older builds ignore the field.
    return_progress: opts.stream !== false,
    chat_template_kwargs: { enable_thinking: sampling.enable_thinking },
    reasoning_effort: sampling.reasoning_effort,
    reasoning_format: "deepseek",
  };
  if (opts.continueFinal) {
    // llama-server refuses continue_final_message together with add_generation_prompt.
    payload.continue_final_message = opts.continueFinal;
    payload.add_generation_prompt = false;
  }
  return payload;
}

function finishOf(json: Record<string, unknown>, current: FinishInfo): FinishInfo {
  const next: FinishInfo = { ...current };
  const choices = json.choices as { finish_reason?: string | null }[] | undefined;
  const reason = choices?.[0]?.finish_reason;
  if (typeof reason === "string" && reason) {
    next.reason = reason;
    if (reason === "length") next.truncated = true;
  }
  if (typeof json.stop_type === "string") {
    next.stopType = json.stop_type;
    if (json.stop_type === "limit") next.truncated = true;
  }
  if (json.truncated === true) next.truncated = true;
  return next;
}

async function readSse(
  res: Response,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<{ demo: boolean; finish: FinishInfo }> {
  if (!res.body) throw new Error("empty stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let demo = res.headers.get("x-q38-demo") === "1";
  let finish: FinishInfo = { reason: "", truncated: false };
  let done = false;

  const consume = (data: string) => {
    if (data === "[DONE]") return true;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (json.demo) demo = true;
    finish = finishOf(json, finish);
    const progress = json.prompt_progress as Record<string, unknown> | undefined;
    if (progress && typeof progress === "object" && handlers.onProgress) {
      handlers.onProgress({
        total: Number(progress.total) || 0,
        cache: Number(progress.cache) || 0,
        processed: Number(progress.processed) || 0,
        time_ms: Number(progress.time_ms) || 0,
      });
    }
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
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (consume(data)) {
        done = true;
        break;
      }
    }
    if (done) break;
  }
  if (!done && buf.trim().startsWith("data:")) {
    consume(buf.trim().slice(5).trim());
  }
  if (finish.truncated && !finish.reason) finish.reason = "length";
  handlers.onFinish?.(finish);
  return { demo, finish };
}

async function openChatStream(
  url: string,
  headers: HeadersInit,
  payload: unknown,
  signal: AbortSignal,
): Promise<Response | "static" | "loading" | null> {
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
      if (isLoadingModel(res.status, errText)) return "loading";
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

/** How the job got on: a normal round, or a demo stream because nothing answered. */
export type StreamOutcome = { demo: boolean; finish: FinishInfo; queuedMs: number };

export async function streamChat(
  messages: ChatMessage[],
  sampling: Sampling,
  settings: Settings,
  handlers: StreamHandlers,
  signal: AbortSignal,
  opts: ChatStreamOptions = {},
): Promise<StreamOutcome> {
  const payload = buildChatPayload(messages, sampling, settings, opts);
  const waitForModel = opts.waitForModel !== false;
  const modelWaitMs = opts.modelWaitMs ?? 20 * 60_000;
  const queuedAt = Date.now();
  let answeredAt: number | null = null;

  /**
   * llama-server refuses every route while it loads the model. Rather than
   * failing the turn, keep the job queued and let the console show it — the
   * weights are paging back in and the first card will be read shortly.
   */
  const queueWhileLoading = async (): Promise<void> => {
    const waited = Date.now() - queuedAt;
    if (!waitForModel) {
      throw new Error("llama-server is still loading the model. Send again once it reports ok.");
    }
    if (waited > modelWaitMs) {
      throw new Error(
        `llama-server is still loading the model after ${Math.round(waited / 1000)}s. Give it a moment, then send again.`,
      );
    }
    handlers.onServerLoading?.(waited);
    await pause(1500, signal);
  };

  if (!opts.forceDemo && !proxyDead) {
    for (;;) {
      const proxied = await openChatStream(
        "/api/llama/v1/chat/completions",
        llamaHeaders(settings),
        payload,
        signal,
      );
      if (proxied === "static") {
        proxyDead = true;
        break;
      }
      if (proxied === "loading") {
        await queueWhileLoading();
        continue;
      }
      if (proxied) {
        answeredAt = answeredAt ?? Date.now();
        const out = await readSse(proxied, handlers, signal);
        return { ...out, queuedMs: answeredAt - queuedAt };
      }
      break;
    }
  }

  if (!opts.forceDemo) {
    for (;;) {
      const direct = await openChatStream(
        `${upstream(settings)}/v1/chat/completions`,
        llamaHeaders(settings, { Accept: "text/event-stream" }),
        payload,
        signal,
      );
      if (direct === "loading") {
        await queueWhileLoading();
        continue;
      }
      if (direct && direct !== "static") {
        answeredAt = answeredAt ?? Date.now();
        const out = await readSse(direct, handlers, signal);
        return { ...out, queuedMs: answeredAt - queuedAt };
      }
      break;
    }
  }

  if (!proxyDead) {
    const demoRes = await openChatStream(
      "/api/demo/chat",
      { "Content-Type": "application/json" },
      payload,
      signal,
    );
    if (demoRes === "loading") {
      // the middleware is up but llama-server is still loading the model
      await queueWhileLoading();
      return streamChat(messages, sampling, settings, handlers, signal, opts);
    }
    if (demoRes && demoRes !== "static") {
      answeredAt = answeredAt ?? Date.now();
      const out = await readSse(demoRes, handlers, signal);
      return { ...out, demo: true, queuedMs: answeredAt - queuedAt };
    }
    if (demoRes === "static") proxyDead = true;
  }

  throw new Error(
    proxyDead
      ? `No Q38 proxy on this host, and llama-server at ${upstream(settings)} did not stream. After npm run build use npm start (not npx serve / dotnet serve). If you stay on a static host, enable CORS on llama-server and check Setup → URL.`
      : `llama-server unreachable at ${upstream(settings)}`,
  );
}

export type CompletionResult = {
  content: string;
  reasoning: string;
  model?: string;
  finish: FinishInfo;
};

/**
 * One non-streaming round, used for context folding. Returns null when no
 * server could answer, so the caller can fall back to a local brief.
 */
export async function completeOnce(
  wire: { role: string; content: string }[],
  settings: Settings,
  opts: { maxTokens: number; temperature?: number; top_p?: number } = { maxTokens: 1024 },
): Promise<CompletionResult | null> {
  const payload = {
    messages: wire,
    stream: false,
    temperature: opts.temperature ?? 0.2,
    top_p: opts.top_p ?? 0.9,
    top_k: 40,
    max_tokens: opts.maxTokens,
    cache_prompt: true,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: "none",
    reasoning_format: "deepseek",
    // a brief is a one-shot: no streaming, so no prefill heartbeat either
    return_progress: false,
  };

  const parse = (json: unknown): CompletionResult | null => {
    if (!json || typeof json !== "object") return null;
    const j = json as Record<string, unknown>;
    const choices = j.choices as
      | { message?: Record<string, unknown>; finish_reason?: string | null }[]
      | undefined;
    const msg = choices?.[0]?.message;
    if (!msg) return null;
    const content = typeof msg.content === "string" ? msg.content : "";
    const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
    if (!content.trim() && !reasoning.trim()) return null;
    const reason = choices?.[0]?.finish_reason;
    return {
      content,
      reasoning,
      model: typeof j.model === "string" ? j.model : undefined,
      finish: {
        reason: typeof reason === "string" ? reason : "",
        truncated: reason === "length" || j.stop_type === "limit" || j.truncated === true,
        stopType: typeof j.stop_type === "string" ? j.stop_type : undefined,
      },
    };
  };

  const post = async (url: string) => {
    const res = await fetch(url, { method: "POST", headers: llamaHeaders(settings), body: JSON.stringify(payload) });
    const json = await readMaybeJson(res);
    return json ? parse(json) : null;
  };

  if (!proxyDead) {
    try {
      const out = await post("/api/llama/v1/chat/completions");
      if (out) return out;
    } catch {
      /* server answered with an error — try the direct origin before giving up */
    }
  }
  try {
    return await post(`${upstream(settings)}/v1/chat/completions`);
  } catch {
    return null;
  }
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
