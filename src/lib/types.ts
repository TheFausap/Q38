export type Role = "user" | "assistant" | "system";

export type Attachment = {
  path: string;
  content: string;
  source: "workspace" | "upload";
};

export type Timings = {
  prompt_n?: number;
  predicted_n?: number;
  predicted_per_second?: number;
  prompt_per_second?: number;
  predicted_ms?: number;
  prompt_ms?: number;
  cache_n?: number;
};

export type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  reasoning?: string;
  attachments?: Attachment[];
  modeTag?: string;
  timings?: Timings;
  demo?: boolean;
  error?: string;
};

export type ModeFamily = "reasoning" | "instruct" | "xhigh";

export type ModeGroup =
  | "core"
  | "research"
  | "engineers"
  | "characters"
  | "supers"
  | "native";

export type ModeDef = {
  id: string;
  name: string;
  blurb: string;
  group: ModeGroup;
  xhigh?: boolean;
  bestFor: string;
  example: string;
};

export type Sampling = {
  temperature: number;
  top_k: number;
  top_p: number;
  min_p: number;
  repeat_penalty: number;
  max_tokens: number;
  reasoning_effort: "xhigh" | "high" | "medium" | "low" | "none";
  enable_thinking: boolean;
  cache_prompt: boolean;
  inject_mode_tag: boolean;
};

export type Session = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modeId: string;
  family: ModeFamily;
  messages: ChatMessage[];
};

export type Settings = {
  llamaUrl: string;
  apiKey: string;
  systemPrompt: string;
  autoCollapseThink: boolean;
};

export type FileNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  text?: boolean;
  children?: FileNode[];
};

export type ServerStatus = {
  ok: boolean;
  upstream: string;
  health: { status?: string | number } | null;
  models: { id: string; meta?: Record<string, unknown> }[];
  props: Record<string, unknown> | null;
  error: string | null;
  workspace: string;
};

export const DEFAULT_SAMPLING: Sampling = {
  temperature: 0.7,
  top_k: 64,
  top_p: 0.95,
  min_p: 0.05,
  repeat_penalty: 1,
  max_tokens: 8192,
  reasoning_effort: "xhigh",
  enable_thinking: true,
  cache_prompt: false,
  inject_mode_tag: true,
};

export const DEFAULT_SYSTEM = `You are Q38, a coding workbench running DavidAU's Qwen3.8-27B Turbo-Brilliance (NEO MAX MTP) via llama-server. Prefer complete, production-ready code over sketches. Match the user's stack and surrounding files. Fence every code block with a language tag. When editing an existing file, return the full file or a focused unified diff — never omit the middle with comments like "// ... rest of file". Keep prose tight; be thorough in code.`;

export const DEFAULT_SETTINGS: Settings = {
  llamaUrl: "http://127.0.0.1:8080",
  apiKey: "",
  systemPrompt: DEFAULT_SYSTEM,
  autoCollapseThink: true,
};
