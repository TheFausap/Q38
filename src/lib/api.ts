import type { ChatMessage, Sampling, ServerStatus, Settings, Timings } from "./types";

export type StreamHandlers = {
  onReasoning: (chunk: string) => void;
  onContent: (chunk: string) => void;
  onTimings: (t: Timings, extra?: { demo?: boolean }) => void;
};

function llamaHeaders(settings: Settings): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Llama-Upstream": settings.llamaUrl,
  };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

export async function fetchStatus(settings: Settings): Promise<ServerStatus> {
  const res = await fetch("/api/status", { headers: llamaHeaders(settings) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

export async function fetchTree() {
  const res = await fetch("/api/workspace/tree");
  if (!res.ok) throw new Error(`tree ${res.status}`);
  return res.json() as Promise<{
    root: string;
    children: import("./types").FileNode[];
    missing?: boolean;
  }>;
}

export async function fetchFile(path: string) {
  const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `file ${res.status}`);
  }
  return res.json() as Promise<{ path: string; content: string; size: number }>;
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
        .map(
          (a) =>
            `### Context: ${a.path}\n\`\`\`\n${a.content}\n\`\`\``,
        )
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

export async function streamChat(
  messages: ChatMessage[],
  sampling: Sampling,
  settings: Settings,
  handlers: StreamHandlers,
  signal: AbortSignal,
  forceDemo = false,
): Promise<{ demo: boolean }> {
  const payload = toPayload(messages, sampling, settings);

  if (!forceDemo) {
    try {
      const res = await fetch("/api/llama/v1/chat/completions", {
        method: "POST",
        headers: llamaHeaders(settings),
        body: JSON.stringify(payload),
        signal,
      });
      if (res.ok && res.body) {
        return readSse(res, handlers, signal);
      }
      const errText = await res.text().catch(() => res.statusText);
      if (res.status !== 502 && res.status !== 503 && res.status !== 0) {
        throw new Error(errText || `llama-server ${res.status}`);
      }
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (err instanceof Error && !/unreachable|Failed to fetch|502|network/i.test(err.message)) {
        throw err;
      }
    }
  }

  const demoRes = await fetch("/api/demo/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!demoRes.ok) throw new Error("demo stream failed");
  await readSse(demoRes, handlers, signal);
  return { demo: true };
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
