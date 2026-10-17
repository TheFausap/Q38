/**
 * Tool calls written as text: read back into calls, stripped from the prose.
 *
 *   node --experimental-strip-types tests/textcalls.test.ts
 */
import assert from "node:assert/strict";
import { normaliseArgs, parseTextToolCalls, stripToolMarkup } from "../src/lib/textcalls.ts";
import { libraryTools } from "../src/lib/library.ts";
import { WEB_TOOLS } from "../src/lib/web.ts";

const tools = [...WEB_TOOLS, ...libraryTools([])];

/* exactly what the model wrote in the bug report */
const reported = `You're right, my apologies — I do have those tools. Let me actually use them now.

<tool_call>
<function=doc_search>
<parameter=doc_id>
nested-learning-the-illusion-of-deep-lea-a0d8e2
</parameter>
<parameter=query>
Continuum Memory System CMS write read formulas exponential decay memory slots
</parameter>
<parameter=limit>
8
</parameter>
</function>
</tool_call>
<tool_call>
<function=doc_search>
<parameter=doc_id>
nested-learning-the-illusion-of-deep-lea-a0d8e2
</parameter>
<parameter=query>
Hope self-referential learning module controller update rule architecture
</parameter>
<parameter=limit>
8
</parameter>
</function>
</tool_call>`;
{
  const { calls, cleaned } = parseTextToolCalls(reported, tools);
  assert.equal(calls.length, 2, "both calls are read");
  assert.deepEqual(JSON.parse(calls[0].arguments), {
    doc: "nested-learning-the-illusion-of-deep-lea-a0d8e2",
    query: "Continuum Memory System CMS write read formulas exponential decay memory slots",
  }, "doc_id becomes doc, the undeclared limit is dropped, values are trimmed");
  assert.equal(calls[1].name, "doc_search");
  assert.ok(calls[0].id !== calls[1].id, "each call has its own id");
  assert.equal(cleaned, "You're right, my apologies — I do have those tools. Let me actually use them now.", "the prose stays, the markup goes");
}

/* Hermes JSON form */
{
  const { calls, cleaned } = parseTextToolCalls(
    'Searching.\n<tool_call>\n{"name": "web_search", "arguments": {"q": "nested learning hope", "count": "3"}}\n</tool_call>',
    tools,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { query: "nested learning hope", count: 3 }, "q → query, a numeric string → integer");
  assert.equal(cleaned, "Searching.");
}

/* a call cut off by the token limit still has what it needs */
{
  const { calls } = parseTextToolCalls("<tool_call>\n<function=doc_add>\n<parameter=url>\nhttps://arxiv.org/abs/2512.24695\n</parameter>\n<parameter=ocr>\ntrue", [
    ...libraryTools([], { ocr: true }),
  ]);
  assert.equal(calls.length, 1, "an unterminated call is still read");
  assert.deepEqual(JSON.parse(calls[0].arguments), { url: "https://arxiv.org/abs/2512.24695", ocr: true }, "booleans are coerced");
}

/* what must not be run */
{
  const unknown = parseTextToolCalls("<tool_call>\n<function=rm_rf>\n<parameter=path>/</parameter>\n</function>\n</tool_call>", tools);
  assert.equal(unknown.calls.length, 0, "a tool that was not offered is not called");
  assert.match(unknown.cleaned, /rm_rf/, "and the text is left as written");
  const fenced = "Here is the syntax:\n```\n<tool_call>\n<function=web_search>\n<parameter=query>x</parameter>\n</function>\n</tool_call>\n```";
  assert.equal(parseTextToolCalls(fenced, tools).calls.length, 0, "a call inside a code fence is an example, not a call");
  assert.equal(parseTextToolCalls("plain prose", tools).calls.length, 0);
  assert.equal(parseTextToolCalls(reported, []).calls.length, 0, "no tools offered, nothing called");
}

/* arguments of structured calls get the same mapping */
{
  const schema = { properties: { doc: { type: "string" }, chunk: { type: "integer" }, section: { type: "string" } } };
  assert.deepEqual(normaliseArgs({ document_id: "x", chunk_id: "12", extra: 1 }, schema), { doc: "x", chunk: 12 });
  assert.deepEqual(normaliseArgs({ doc: "a", doc_id: "b" }, schema), { doc: "a" }, "a real name beats an alias");
}

/* live display */
{
  assert.equal(stripToolMarkup("Let me look.\n<tool_call>\n<function=doc_se"), "Let me look.", "a call being written is hidden");
  assert.equal(stripToolMarkup(reported), "You're right, my apologies — I do have those tools. Let me actually use them now.");
  assert.equal(stripToolMarkup("no markup"), "no markup");
  assert.match(stripToolMarkup("```\n<tool_call>x</tool_call>\n```"), /<tool_call>x<\/tool_call>/, "code fences are left alone");
}

console.log("text tool call checks passed");
