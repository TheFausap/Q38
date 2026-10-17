/**
 * The tool briefing: what the model is told about the tools a turn carries.
 *
 *   node --experimental-strip-types tests/toolbrief.test.ts
 */
import assert from "node:assert/strict";
import { toolBriefing, toolNames } from "../src/lib/toolbrief.ts";

const tool = (name: string) => ({ type: "function", function: { name, description: "", parameters: {} } });

assert.equal(toolBriefing(undefined), "", "no tools, no briefing");
assert.equal(toolBriefing([]), "", "an empty list too");
assert.deepEqual(toolNames([tool("web_search"), { nope: 1 }, tool("doc_add")]), ["web_search", "doc_add"]);

const web = toolBriefing([tool("web_search"), tool("web_fetch")]);
assert.match(web, /^## Tools available in this conversation/);
assert.match(web, /- web_search: search the web/);
assert.match(web, /you DO have internet access/);
assert.match(web, /Never tell the user that you cannot browse/);
assert.doesNotMatch(web, /doc_add/, "it names only the tools on offer");

const lib = toolBriefing([tool("doc_add"), tool("doc_search"), tool("doc_read")]);
assert.match(lib, /you CAN download and read PDFs/);
assert.match(lib, /doc_add\(url\) once, then doc_search/);
assert.doesNotMatch(lib, /internet access through web_search/, "no web promise without web tools");

const recallOnly = toolBriefing([tool("recall")]);
assert.match(recallOnly, /- recall: read earlier conversation/);
assert.doesNotMatch(recallOnly, /Never tell the user/, "no browsing claim when nothing browses");

console.log("tool briefing checks passed");
