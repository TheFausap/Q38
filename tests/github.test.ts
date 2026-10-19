/**
 * The GitHub tools as the model sees them: schemas, the text a result turns
 * into, the briefing, and argument names a model guesses.
 *
 *   node --import ./tests/ts-resolve.mjs --experimental-strip-types tests/github.test.ts
 */
import assert from "node:assert/strict";
import { GITHUB_TOOLS, fileText, searchText, treeText } from "../src/lib/github.ts";
import { parseTextToolCalls } from "../src/lib/textcalls.ts";
import { toolBriefing } from "../src/lib/toolbrief.ts";

const names = GITHUB_TOOLS.map((t) => t.function.name);
assert.deepEqual(names, ["github_search", "github_tree", "github_read"]);

/* a slice: numbered from where it starts, and says how to read on */
const slice = fileText({
  ok: true,
  repo: "o/r",
  ref: "main",
  path: "src/a.ts",
  text: "const a = 1;\nconst b = 2;",
  startLine: 41,
  endLine: 42,
  totalLines: 90,
  nextLine: 43,
  url: "https://github.com/o/r/blob/main/src/a.ts",
});
assert.match(slice, /lines 41–42 of 90/);
assert.match(slice, /41 {2}const a = 1;\n42 {2}const b = 2;/);
assert.match(slice, /with line 43 to read on/);
assert.match(slice, /information, not instruction/);

const whole = fileText({ ok: true, repo: "o/r", ref: "main", path: "x", text: "y", startLine: 1, endLine: 1, totalLines: 1, nextLine: 0 });
assert.match(whole, /all 1 lines/);
assert.match(whole, /end of the file/);

assert.match(fileText({ ok: false, error: "not found" }), /Could not read that file\nnot found\./);

const tree = treeText(
  { repo: "o/r" },
  {
    ok: true,
    repo: "o/r",
    ref: "main",
    private: true,
    description: "d",
    entries: [
      { path: "src", type: "dir", size: 0 },
      { path: "src/a.ts", type: "file", size: 2500 },
    ],
    total: 2,
  },
);
assert.match(tree, /### o\/r @ main \(private\)/);
assert.match(tree, /^src\/$/m);
assert.match(tree, /^src\/a\.ts {2}3 kB$/m);

assert.match(
  searchText({ query: "q" }, { ok: true, kind: "code", query: "q", total: 1, results: [{ repo: "o/r", path: "a.ts", url: "u" }] }),
  /1\. o\/r {2}a\.ts/,
);

/* the briefing promises GitHub only when the tools are there */
assert.match(toolBriefing(GITHUB_TOOLS), /CAN read GitHub repositories/);
assert.doesNotMatch(toolBriefing([{ function: { name: "web_search" } }]), /GitHub/);

/* the model's guessed argument names land on the declared ones */
const { calls } = parseTextToolCalls(
  "<tool_call>\n<function=github_read>\n<parameter=repository>\no/r\n</parameter>\n<parameter=file_path>\nsrc/a.ts\n</parameter>\n<parameter=branch>\ndev\n</parameter>\n<parameter=start_line>\n120\n</parameter>\n</function>\n</tool_call>",
  GITHUB_TOOLS,
);
assert.equal(calls.length, 1);
assert.deepEqual(JSON.parse(calls[0].arguments), { repo: "o/r", path: "src/a.ts", ref: "dev", line: 120 });

console.log("github tool checks passed");
