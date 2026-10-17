import type {
  ArchiveRef,
  ChatMessage,
  FinishInfo,
  PromptProgress,
  Sampling,
  ServerStatus,
  Settings,
  Timings,
} from "./types";
import type { WebPageOutcome, WebSearchOutcome } from "./web";
import type { SkillIndex, SkillReadOutcome, SkillSearchOutcome } from "./skills";
import type { AddOutcome, LibraryJob, LibraryList, ReadOutcome, SearchOutcome } from "./library";

export type StreamHandlers = {
  onReasoning: (chunk: string) => void;
  onContent: (chunk: string) => void;
  onTimings: (t: Timings, extra?: { demo?: boolean }) => void;
  /** fired once, when the round ends (finish_reason / stop_type). */
  onFinish?: (info: FinishInfo) => void;
  /** llama-server's prefill heartbeat, while the prompt is being read. */
  onProgress?: (p: PromptProgress) => void;
  /** a tool call the model asked for, once its arguments are complete. */
  onToolCall?: (call: ToolCall) => void;
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
  /** OpenAI-style tools to offer this turn (llama-server needs --jinja to parse them) */
  tools?: unknown[];
  /**
   * Continue a trailing assistant message instead of starting a new turn.
   * "content" is the prefill path (llama-server honours it, older builds follow it
   * through --prefill-assistant); "reasoning_content" resumes a thinking block.
   */
  continueFinal?: "content" | "reasoning_content" | null;
  /** extra user turn appended after the transcript (directive resume). */
  directive?: string;
  /**
   * This turn's tool exchange, after the transcript: the model's message
   * carrying `tool_calls`, then one `tool` message per call with its result —
   * the shape Qwen-family templates render as <tool_call>/<tool_response>.
   */
  toolTrail?: WireMessage[];
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

/**
 * The proxy answered, but it could not reach llama-server at all. Not an error
 * to show the user: it means this route is dead, so the send carries on down
 * the chain and lands on the offline demo.
 */
export function isUpstreamDown(status: number, body: string): boolean {
  if (status !== 502 && status !== 504) return false;
  return /llama-server unreachable|ECONNREFUSED|socket hang up/i.test(body);
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

/* ------------------------------------------------------------------ memory
 * The archive lives on disk, behind the middleware. Every call here is
 * best-effort by design: if the store is unreachable the caller falls back to
 * folding, so a workbench on a static host still runs, just without memory.
 */

export type StoredChunk = ArchiveRef & { body: { messages: ChatMessage[] } };

export async function memoryPut(
  sessionId: string,
  chunk: StoredChunk,
  meta?: Record<string, unknown>,
): Promise<{ seq: number; chunks: number }> {
  const res = await fetch("/api/memory/put", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: sessionId, chunk, meta }),
  });
  const json = (await readMaybeJson(res)) as { error?: string; seq?: number; chunks?: number } | null;
  if (!res.ok || !json || json.error) throw new Error(json?.error || "the memory store refused the chunk");
  return { seq: json.seq ?? chunk.seq, chunks: json.chunks ?? 0 };
}

export async function memoryList(sessionId: string): Promise<{ chunks: ArchiveRef[]; root: string }> {
  const res = await fetch(`/api/memory/list?session=${encodeURIComponent(sessionId)}`);
  const json = (await readMaybeJson(res)) as { error?: string; chunks?: ArchiveRef[]; root?: string } | null;
  if (!res.ok || !json || json.error) throw new Error(json?.error || "the memory store could not be listed");
  return { chunks: json.chunks ?? [], root: json.root ?? "" };
}

export async function memoryGet(sessionId: string, id: string): Promise<StoredChunk> {
  const res = await fetch(
    `/api/memory/chunk?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`,
  );
  const json = (await readMaybeJson(res)) as { error?: string; chunk?: StoredChunk } | null;
  if (!res.ok || !json || json.error || !json.chunk) {
    throw new Error(json?.error || `chunk ${id} could not be read back`);
  }
  return json.chunk;
}

export async function memoryForget(sessionId: string, ids: string[]): Promise<number> {
  const res = await fetch("/api/memory/forget", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: sessionId, ids }),
  });
  const json = (await readMaybeJson(res)) as { error?: string; removed?: number } | null;
  if (!res.ok || !json || json.error) throw new Error(json?.error || "the memory store refused the delete");
  return json.removed ?? 0;
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

export type WireToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type WireMessage = {
  role: string;
  content: string;
  /** the model's thinking for this message; Qwen templates render it inside <think> */
  reasoning_content?: string;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
};

export function buildWireMessages(
  messages: ChatMessage[],
  settings: Settings,
  opts: ChatStreamOptions,
): WireMessage[] {
  const out: WireMessage[] = [];
  /* Qwen-family chat templates accept exactly one system message, and only at
     index 0 — a second one raises "System message must be at the beginning".
     So the prompt, briefs, recalls and tool results are joined into one. */
  const systemParts = [settings.systemPrompt, ...(opts.systemExtra ?? [])]
    .map((s) => s.trim())
    .filter(Boolean);
  if (systemParts.length) {
    out.push({ role: "system", content: systemParts.join("\n\n") });
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
  if (opts.toolTrail?.length) out.push(...opts.toolTrail);
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
  if (opts.tools?.length) {
    payload.tools = opts.tools;
    payload.tool_choice = "auto";
  }
  if (opts.continueFinal) {
    // llama-server refuses continue_final_message together with add_generation_prompt.
    payload.continue_final_message = opts.continueFinal;
    payload.add_generation_prompt = false;
  }
  return payload;
}

/** A tool call the model asked for. Arguments arrive as JSON text, in pieces. */
export type ToolCall = { id: string; name: string; arguments: string };

/**
 * llama-server streams tool calls the way OpenAI does: `delta.tool_calls[]`
 * fragments carrying an index, a name on the first piece, and argument JSON
 * split across pieces. Only complete calls are reported — a half-written
 * argument string is never handed to a caller that will JSON.parse it.
 */
function readToolDeltas(
  delta: Record<string, unknown>,
  open: Map<number, ToolCall>,
): ToolCall | null {
  const calls = delta.tool_calls as
    | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
    | undefined;
  if (!Array.isArray(calls)) return null;
  for (const piece of calls) {
    const index = Number(piece?.index ?? 0);
    const cur = open.get(index) ?? { id: "", name: "", arguments: "" };
    if (piece?.id) cur.id = String(piece.id);
    if (piece?.function?.name) cur.name = String(piece.function.name);
    if (piece?.function?.arguments) cur.arguments += String(piece.function.arguments);
    open.set(index, cur);
  }
  return null;
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
  const openCalls = new Map<number, ToolCall>();

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
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
    const message = choices?.[0]?.message;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const r =
      str(delta?.reasoning_content) ||
      str(delta?.reasoning) ||
      message?.reasoning_content ||
      "";
    const c = str(delta?.content) || message?.content || "";
    if (r) handlers.onReasoning(r);
    if (c) handlers.onContent(c);
    if (delta) readToolDeltas(delta, openCalls);
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
  /* The stream is over, so now every argument string is complete. A round that
     ended in tool_calls carries no prose — the caller runs the tools and sends
     the turn again. */
  if (openCalls.size) {
    const complete = [...openCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => c)
      .filter((c) => c.name);
    for (const call of complete) handlers.onToolCall?.(call);
    if (complete.length) finish.calls = complete;
  }
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
      // the server is down rather than complaining: fall through so the demo
      // can answer instead of failing the turn with a transport error
      if (isUpstreamDown(res.status, errText)) return null;
      throw new Error(errText || `llama-server ${res.status}`);
    }
    return res.body ? res : null;
  } catch (err) {
    if (signal.aborted) throw err;
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    /* Browsers say "Failed to fetch", Chrome "net::ERR_CONNECTION_REFUSED",
       Node/undici "fetch failed", and a proxy may say "unreachable". None of
       them is worth failing the turn over: they mean the model is not there,
       which is what the fallback chain and the demo exist for. */
    const transport = /failed to fetch|fetch failed|networkerror|unreachable|econnrefused|socket hang up|err_connection/i;
    if (err instanceof Error && err.message && !transport.test(err.message)) {
      throw err;
    }
    return null;
  }
}

/**
 * Search the web / read a page, through the workbench's own middleware.
 *
 * The middleware is where the network lives: it holds the provider choice (a
 * SearXNG URL or an API key from Setup), refuses to open private addresses, and
 * answers a failed search as a *result* — `ok:false` with a reason — rather than
 * as a broken request. A tool the model called must never take the turn down
 * with it, so nothing in here throws over the network.
 */
async function postWeb(path: string, body: unknown, settings: Settings, extra?: Record<string, string>) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Q38-Search-Provider": settings.webProvider,
    ...extra,
  };
  if (settings.searchApiKey) headers["X-Q38-Search-Key"] = settings.searchApiKey;
  if (settings.searxUrl) headers["X-Q38-Searx-Url"] = settings.searxUrl;
  try {
    const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      return json;
    } catch {
      return { ok: false, error: `the workbench answered ${res.status} with something that is not JSON` };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: /failed to fetch|fetch failed|networkerror|unreachable/i.test(reason)
        ? "the workbench server is not answering (is `npm run dev` still up?)"
        : reason,
    };
  }
}

export async function webSearch(
  query: string,
  count: number,
  settings: Settings,
): Promise<WebSearchOutcome> {
  const json = await postWeb("/api/web/search", { query, count }, settings);
  return json as unknown as WebSearchOutcome;
}

export async function webFetchPage(
  url: string,
  chars: number,
  settings: Settings,
): Promise<WebPageOutcome> {
  const json = await postWeb("/api/web/fetch", { url, chars }, settings);
  return json as unknown as WebPageOutcome;
}

async function getSkills(path: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(path);
    const text = await res.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, error: `the workbench answered ${res.status} with something that is not JSON` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------- library */

function libraryHeaders(settings: Settings, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (settings.embedUrl.trim()) h["X-Q38-Embed-Url"] = settings.embedUrl.trim();
  if (settings.ocrUrl.trim()) {
    h["X-Q38-Ocr-Url"] = settings.ocrUrl.trim();
    h["X-Q38-Ocr-Profile"] = settings.ocrProfile;
    if (settings.ocrProfile === "custom") {
      if (settings.ocrPrompt.trim()) h["X-Q38-Ocr-Prompt"] = encodeURIComponent(settings.ocrPrompt);
      if (settings.ocrMaxTokens > 0) h["X-Q38-Ocr-Max-Tokens"] = String(settings.ocrMaxTokens);
      if (settings.ocrMegapixels > 0) h["X-Q38-Ocr-Pixels"] = String(Math.round(settings.ocrMegapixels * 1_000_000));
    }
  }
  return h;
}

async function libraryCall<T>(path: string, settings: Settings, init: RequestInit = {}): Promise<T> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: libraryHeaders(settings, init.headers as Record<string, string> | undefined),
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return { ok: false, error: `the workbench answered ${res.status} with something that is not JSON` } as T;
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as T;
  }
}

export function libraryList(settings: Settings): Promise<LibraryList> {
  return libraryCall<LibraryList>("/api/library/list", settings);
}

export function libraryAdd(url: string, settings: Settings, opts: { ocr?: boolean } = {}): Promise<AddOutcome> {
  return libraryCall<AddOutcome>("/api/library/add", settings, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, ocr: opts.ocr === true }),
  });
}

export type OcrInfo = {
  ok: boolean;
  configured: boolean;
  base?: string;
  profile?: string;
  label?: string;
  model?: string;
  maxTokens?: number;
  pixels?: number;
  error?: string;
};

/** Which OCR profile the server will use — detected from the model, or as set. */
export function libraryOcrInfo(settings: Settings): Promise<OcrInfo> {
  return libraryCall<OcrInfo>("/api/library/ocr", settings);
}

export function libraryJobs(settings: Settings): Promise<{ ok: boolean; jobs?: LibraryJob[] }> {
  return libraryCall("/api/library/jobs", settings);
}

export function libraryReocr(id: string, settings: Settings): Promise<AddOutcome & { before?: number }> {
  return libraryCall("/api/library/reocr", settings, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export function libraryUpload(file: File, settings: Settings): Promise<AddOutcome> {
  return libraryCall<AddOutcome>("/api/library/upload", settings, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Q38-Filename": encodeURIComponent(file.name),
    },
    body: file,
  });
}

export function librarySearch(query: string, doc: string, settings: Settings): Promise<SearchOutcome> {
  const q = new URLSearchParams({ q: query, k: "5" });
  if (doc) q.set("doc", doc);
  return libraryCall<SearchOutcome>(`/api/library/search?${q}`, settings);
}

export function libraryRead(
  doc: string,
  opts: { section?: string; chunk?: number | null; chars: number },
  settings: Settings,
): Promise<ReadOutcome> {
  const q = new URLSearchParams({ doc, chars: String(opts.chars) });
  if (opts.section) q.set("section", opts.section);
  if (opts.chunk != null && Number.isFinite(opts.chunk)) q.set("chunk", String(opts.chunk));
  return libraryCall<ReadOutcome>(`/api/library/read?${q}`, settings);
}

export function libraryRemove(id: string, settings: Settings): Promise<{ ok: boolean; error?: string }> {
  return libraryCall("/api/library/remove", settings, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export function libraryEmbed(settings: Settings): Promise<{ ok: boolean; embedded?: number; model?: string; error?: string }> {
  return libraryCall("/api/library/embed", settings, { method: "POST" });
}

/** Every skill the workbench can see, without their bodies. */
export async function skillIndex(): Promise<SkillIndex> {
  const json = await getSkills("/api/skills/index");
  if (!Array.isArray(json.skills)) return { ok: false, skills: [], error: String(json.error || "no index") };
  return json as unknown as SkillIndex;
}

export async function skillSearch(query: string): Promise<SkillSearchOutcome> {
  return (await getSkills(`/api/skills/search?q=${encodeURIComponent(query)}&k=5`)) as SkillSearchOutcome;
}

export async function skillRead(name: string, file: string, chars: number): Promise<SkillReadOutcome> {
  const q = new URLSearchParams({ name, chars: String(chars) });
  if (file) q.set("file", file);
  return (await getSkills(`/api/skills/read?${q}`)) as SkillReadOutcome;
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
