export type Role = "user" | "assistant" | "system";

export type Attachment = {
  path: string;
  content: string;
  source: "workspace" | "upload";
  /** pinned to the turn only: the workspace write did not happen */
  unstored?: boolean;
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

/**
 * llama-server's prefill heartbeat, streamed when the request asks for it
 * (`return_progress`). `processed` walks from `cache` up to `total`.
 */
export type PromptProgress = {
  /** prompt tokens for this turn */
  total: number;
  /** tokens served from the prompt cache */
  cache: number;
  /** tokens read into the batch so far */
  processed: number;
  time_ms: number;
};

/** How a stream ended. llama.cpp reports `finish_reason` + `stop_type`. */
export type FinishInfo = {
  /** "stop" | "length" | "tool_calls" | "" */
  reason: string;
  /** true when the model was cut off by max_tokens / n_predict rather than EOS. */
  truncated: boolean;
  /** llama.cpp only: eos | word | limit | none */
  stopType?: string;
  /** tool calls the model asked for this round (llama-server --jinja). */
  calls?: { id: string; name: string; arguments: string }[];
};

export type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  /** how many times the model went back to the disk mid-reply (recall tool) */
  recalled?: number;
  reasoning?: string;
  attachments?: Attachment[];
  modeTag?: string;
  timings?: Timings;
  demo?: boolean;
  error?: string;
  /** finish_reason of the round that produced this message. */
  finishReason?: string;
  /** true when the round hit max_tokens (reply can be continued). */
  truncated?: boolean;
  /** how many continuation rounds have been stitched into this message. */
  continues?: number;
};

/**
 * A context fold: every message up to and including `upToId` is replaced, in the
 * prompt and in the transcript, by one handoff brief.
 */
export type Compaction = {
  id: string;
  at: number;
  /** id of the last message folded into `summary` (inclusive). */
  upToId: string;
  /** how many messages were folded away. */
  foldedMessages: number;
  summary: string;
  /** prompt tokens removed from the window. */
  tokensBefore: number;
  /** prompt tokens the brief costs. */
  tokensAfter: number;
  /** true when the workbench compacted on its own before sending. */
  auto: boolean;
  /** who wrote the brief. */
  source: "model" | "local";
  model?: string;
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
  /** context folds, oldest first. The last one is the active brief. */
  compactions?: Compaction[];
  /** memories moved to disk, oldest first. The last one is the active cut. */
  archives?: ArchiveRef[];
  /** chunk ids the user has pinned back into the window by hand. */
  held?: string[];
};

/**
 * A chunk of transcript moved out of the window and onto disk. The session keeps
 * the ref — one register line and its matching terms; the messages themselves
 * live in the memory store and come back only when something recalls them.
 */
export type ArchiveRef = {
  id: string;
  /** 1-based position in this session's archive; what the register line shows. */
  seq: number;
  at: number;
  /** messages moved out, inclusive. They stay in the transcript either way. */
  fromId: string;
  toId: string;
  count: number;
  /** prompt tokens this chunk cost while it was in the window. */
  tokens: number;
  /** the one line that stands in for it. */
  register: string;
  /** first user line of the chunk, for the card and the register. */
  label: string;
  /** paths mentioned in the chunk, for the card. */
  paths: string[];
  /** terms the matcher scores against. */
  terms: string[];
  /** how many times it has been pulled back in. */
  recalls: number;
  lastRecallAt: number | null;
};

export type ContinueMode = "auto" | "prefill" | "directive";

export type Settings = {
  llamaUrl: string;
  apiKey: string;
  systemPrompt: string;
  autoCollapseThink: boolean;
  /** context window in tokens; 0 = read n_ctx from llama-server /props */
  contextSize: number;
  /** fold the transcript automatically when the window fills up */
  autoCompact: boolean;
  /** fold once the next prompt crosses this fraction of the usable window */
  compactAt: number;
  /** messages kept verbatim below the fold */
  keepTailMessages: number;
  /** token cap for one handoff brief */
  summaryMaxTokens: number;
  /** keep streaming when the model hits max_tokens mid-reply */
  autoContinue: boolean;
  /** extra rounds per reply (0 = manual only) */
  maxContinues: number;
  /** assistant-prefill continuation, prompt directive, or prefill with fallback */
  continueMode: ContinueMode;
  /** show the punched-card job console while a turn is being read */
  retroFeedback: boolean;
  /** idle time that counts as a cold start (the model pages back in) */
  coldStartSeconds: number;
  /** decode rate below this fraction of the warm baseline is "paging" */
  pagingFactor: number;
  /** let the model ask for a chunk off the disk mid-reply (the recall tool) */
  recallTool: boolean;
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
  /** llama-server is up but still loading the model into memory (503 Loading model) */
  loading?: boolean;
  upstream: string;
  health: { status?: string | number } | null;
  models: { id: string; meta?: Record<string, unknown> }[];
  props: Record<string, unknown> | null;
  error: string | null;
  workspace: string;
  via?: "proxy" | "direct" | "none";
  hint?: string;
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

export const DEFAULT_SYSTEM = `You are Q38, a coding workbench running DavidAU's Qwen3.8-27B Turbo-Brilliance (NEO MAX MTP) via llama-server. Prefer complete, production-ready code over sketches. Match the user's stack and surrounding files. Fence every code block with a language tag. When editing an existing file, return the full file or a focused unified diff — never omit the middle with comments like "// ... rest of file". Keep prose tight; be thorough in code. If you are resumed mid-answer, continue exactly where you stopped instead of restarting.`;

export const DEFAULT_SETTINGS: Settings = {
  llamaUrl: "http://127.0.0.1:8080",
  apiKey: "",
  systemPrompt: DEFAULT_SYSTEM,
  autoCollapseThink: true,
  contextSize: 0,
  autoCompact: true,
  compactAt: 0.72,
  keepTailMessages: 8,
  summaryMaxTokens: 1600,
  autoContinue: true,
  maxContinues: 2,
  continueMode: "auto",
  retroFeedback: true,
  coldStartSeconds: 120,
  pagingFactor: 0.45,
  recallTool: true,
};
