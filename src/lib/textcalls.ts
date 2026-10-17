/**
 * Tool calls written as text.
 *
 * llama-server turns a model's tool call into structured `tool_calls` only
 * when its parser recognises the format the chat template uses. A fine-tune
 * can drift from that — DavidAU's Qwen3.8 writes Qwen's XML form
 *
 *   <tool_call>
 *   <function=doc_search>
 *   <parameter=query>
 *   continuum memory
 *   </parameter>
 *   </function>
 *   </tool_call>
 *
 * as plain content, and the call is shown instead of run. This module reads
 * those (and the Hermes JSON form, `<tool_call>{"name": …, "arguments": …}`)
 * back into calls, strips them from the prose, and maps parameter names the
 * model guessed (`doc_id`, `q`, `link`) onto the ones the tool declares.
 * Only tools that were actually offered are accepted.
 */
export type TextCall = { id: string; name: string; arguments: string };

type Schema = { properties?: Record<string, { type?: string }> };
type ToolDef = { function?: { name?: string; parameters?: Schema } };

/** Names a model reaches for → the parameter our tools actually declare. */
const ALIASES: Record<string, string[]> = {
  doc: ["doc_id", "document", "document_id", "docid", "id", "paper", "paper_id", "file"],
  query: ["q", "search", "search_query", "question", "text", "terms", "keywords"],
  url: ["link", "href", "address", "uri", "source", "pdf", "pdf_url"],
  name: ["skill", "skill_name", "skill_id"],
  section: ["section_id", "section_name", "section_title", "heading", "chapter"],
  chunk: ["chunk_id", "chunk_index", "start", "from", "offset"],
  count: ["n", "num", "num_results", "max_results", "limit", "k", "top_k"],
};

function schemaOf(tools: unknown[], name: string): Schema | null {
  for (const t of tools) {
    const fn = (t as ToolDef)?.function;
    if (fn?.name === name) return fn.parameters ?? {};
  }
  return null;
}

/** Coerce a text value to what the schema wants (numbers, booleans, JSON). */
function coerce(raw: unknown, type: string | undefined): unknown {
  if (typeof raw !== "string") return raw;
  const v = raw.trim();
  if (type === "integer" || type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? (type === "integer" ? Math.round(n) : n) : v;
  }
  if (type === "boolean") return /^(true|yes|1)$/i.test(v);
  if (type === "object" || type === "array") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * Arguments as the tool declares them: known names kept, aliases renamed,
 * values coerced, anything the tool does not take dropped.
 */
export function normaliseArgs(args: Record<string, unknown>, schema: Schema | null): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const declared = Object.keys(props);
  if (!declared.length) return args;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const k = key.trim();
    let target = declared.includes(k) ? k : "";
    if (!target) {
      const low = k.toLowerCase();
      target = declared.find((d) => d.toLowerCase() === low || (ALIASES[d] ?? []).includes(low)) ?? "";
    }
    if (!target || target in out) continue;
    out[target] = coerce(value, props[target]?.type);
  }
  return out;
}

const XML_CALL = /<tool_call>\s*(<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$))\s*(?:<\/tool_call>|$)/g;
const BARE_FUNCTION = /<function=([\w.-]+)>([\s\S]*?)<\/function>/g;
const XML_PARAM = /<parameter=([\w.-]+)>\s*([\s\S]*?)\s*(?:<\/parameter>|(?=<parameter=)|$)/g;
const JSON_CALL = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;

function paramsOf(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const m of body.matchAll(XML_PARAM)) args[m[1]] = m[2];
  return args;
}

let seq = 0;
const callId = () => `text_call_${Date.now().toString(36)}_${++seq}`;

/**
 * The calls written in `text`, for the tools offered, and the text without them.
 * Calls inside fenced code blocks are left alone — a model explaining tool
 * syntax is not calling anything.
 */
export function parseTextToolCalls(text: string, tools: unknown[]): { calls: TextCall[]; cleaned: string } {
  const src = String(text || "");
  if (!/<tool_call>|<function=/.test(src) || !tools.length) return { calls: [], cleaned: src };

  /* keep fenced code out of reach */
  const fences: string[] = [];
  const masked = src.replace(/```[\s\S]*?```/g, (m) => `\u0000F${fences.push(m) - 1}\u0000`);

  const calls: TextCall[] = [];
  const take = (name: string, args: Record<string, unknown>) => {
    const schema = schemaOf(tools, name);
    if (!schema) return false;
    calls.push({ id: callId(), name, arguments: JSON.stringify(normaliseArgs(args, schema)) });
    return true;
  };

  let cleaned = masked.replace(JSON_CALL, (whole, json: string) => {
    try {
      const parsed = JSON.parse(json) as { name?: string; arguments?: unknown; parameters?: unknown };
      let args = parsed.arguments ?? parsed.parameters ?? {};
      if (typeof args === "string") args = JSON.parse(args);
      return parsed.name && take(parsed.name, args as Record<string, unknown>) ? "" : whole;
    } catch {
      return whole;
    }
  });
  cleaned = cleaned.replace(XML_CALL, (whole, _fn: string, name: string, body: string) =>
    take(name, paramsOf(body)) ? "" : whole,
  );
  cleaned = cleaned.replace(BARE_FUNCTION, (whole, name: string, body: string) =>
    take(name, paramsOf(body)) ? "" : whole,
  );

  cleaned = cleaned
    .replace(/\u0000F(\d+)\u0000/g, (_, i: string) => fences[Number(i)])
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { calls, cleaned: calls.length ? cleaned : src };
}

/**
 * For display while a reply streams: complete call blocks removed, and a call
 * still being written cut off, so the reader sees prose rather than markup.
 */
export function stripToolMarkup(text: string): string {
  const src = String(text || "");
  if (!/<tool_call|<function=/.test(src)) return src;
  const fences: string[] = [];
  let out = src.replace(/```[\s\S]*?```/g, (m) => `\u0000F${fences.push(m) - 1}\u0000`);
  out = out
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<function=[\w.-]+>[\s\S]*?<\/function>/g, "")
    .replace(/<tool_call>[\s\S]*$/, "")
    .replace(/<function=[\w.-]+>[\s\S]*$/, "")
    .replace(/<\/?tool_call>/g, "");
  return out
    .replace(/\u0000F(\d+)\u0000/g, (_, i: string) => fences[Number(i)])
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

const BLOCK = /<tool_call>[\s\S]*?(?:<\/tool_call>|$)|<function=[\w.-]+>[\s\S]*?(?:<\/function>|$)/g;

/**
 * Tool calls at the very end of a model's thinking, with nothing after them.
 *
 * Some fine-tunes write their call before closing </think>, so llama-server
 * files it under reasoning and the round looks empty. Only a trailing group
 * counts — a call written mid-thought, with more thinking after it, is the
 * model planning, not calling.
 */
export function trailingToolCalls(text: string, tools: unknown[]): { calls: TextCall[]; before: string } {
  const src = String(text || "");
  if (!/<tool_call>|<function=/.test(src) || !tools.length) return { calls: [], before: src };
  const blocks = [...src.matchAll(BLOCK)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  if (!blocks.length) return { calls: [], before: src };
  /* the group must reach the end, with only whitespace (or a stray tag) between its blocks */
  const gap = (s: string) => /^[\s]*(<\/?(tool_call|think)>[\s]*)*$/.test(s);
  if (!gap(src.slice(blocks[blocks.length - 1].end))) return { calls: [], before: src };
  let first = blocks.length - 1;
  while (first > 0 && gap(src.slice(blocks[first - 1].end, blocks[first].start))) first--;
  const tail = src.slice(blocks[first].start);
  const { calls } = parseTextToolCalls(tail, tools);
  return calls.length ? { calls, before: src.slice(0, blocks[first].start).trimEnd() } : { calls: [], before: src };
}
