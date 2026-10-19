/**
 * GitHub through gh: what the server runs, and what comes back.
 *
 *   node tests/github-routes.mjs
 *
 * Runs against a stub `gh` (Q38_GH_BIN) that records every argument vector it
 * is handed, so the test can check that only read-only `gh api --method GET`
 * calls built by the server ever go out — whatever the model asks for.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const results = [];
const check = (ok, msg) => {
  results.push(`${ok ? "·" : "✗"} ${msg}`);
  if (!ok) throw new Error(msg);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q38-gh-test-"));
const LOG = path.join(tmp, "calls.ndjson");
const FAKE = path.join(tmp, "gh");
const big = Array.from({ length: 300 }, (_, i) => `export const line${i + 1} = ${i + 1}; // ${"x".repeat(40)}`).join("\n") + "\n";
fs.writeFileSync(path.join(tmp, "big.ts"), big);
fs.writeFileSync(
  FAKE,
  `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(args) + "\\n");
const out = (s) => { process.stdout.write(s); process.exit(0); };
const fail = (msg, code = 1) => { process.stderr.write(msg + "\\n"); process.exit(code); };
if (args[0] === "--version") out("gh version 2.99.0 (2026-10-01)\\n");
const p = args[3] || "";
if (p === "user") {
  if (process.env.FAKE_GH_LOGGED_OUT) fail("To get started with GitHub CLI, please run:  gh auth login", 4);
  out("tester\\n");
}
if (p === "repos/o/r") out(JSON.stringify({ full_name: "o/r", description: "a repo", default_branch: "main", private: true, language: "TypeScript" }));
if (p === "repos/o/r/git/trees/main?recursive=1") out(JSON.stringify({ truncated: false, tree: [
  { path: "README.md", type: "blob", size: 120 },
  { path: "src", type: "tree" },
  { path: "src/big.ts", type: "blob", size: ${Buffer.byteLength(big)} },
  { path: "src/lib", type: "tree" },
  { path: "src/lib/a.ts", type: "blob", size: 10 },
] }));
if (p === "repos/o/r/contents/src/big.ts" || p === "repos/o/r/contents/src/big.ts?ref=main") out(fs.readFileSync(${JSON.stringify(path.join(tmp, "big.ts"))}, "utf8"));
if (p === "repos/o/r/contents/src/big.ts?ref=v1.0") out("only on v1.0\\n");
if (p === "repos/o/r/contents/src/big.ts?ref=feature%2Fx") out("on a branch\\n");
if (p === "repos/o/r/contents/src") out(JSON.stringify([{ name: "big.ts" }, { name: "lib" }]));
if (p === "repos/o/r/contents/bin.dat") { process.stdout.write(Buffer.from([1, 0, 2, 3])); process.exit(0); }
if (p.startsWith("search/code?q=")) out(JSON.stringify({ total_count: 1, items: [{ path: "src/lib/a.ts", html_url: "https://github.com/o/r/blob/main/src/lib/a.ts", repository: { full_name: "o/r" } }] }));
fail("gh: Not Found (HTTP 404)");
`,
);
fs.chmodSync(FAKE, 0o755);
process.env.Q38_GH_BIN = FAKE;
const WS = path.join(tmp, "workspace");
fs.mkdirSync(path.join(WS, "src"), { recursive: true });
fs.writeFileSync(path.join(WS, "src", "big.ts"), "MY OWN FILE — a save must never touch it\n");
process.env.WORKSPACE_DIR = WS;

const { createApi } = await import("../server/api.mjs");
const gh = await import("../server/github.mjs");
const api = createApi();
const server = http.createServer((req, res) => api(req, res, () => res.end("{}")));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (op, body) =>
  (await fetch(`${base}/api/github/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const calls = () => fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

try {
  /* ------------------------------------------------------------ status */
  let st = await (await fetch(`${base}/api/github/status`)).json();
  check(st.ok && st.login === "tester" && st.version === "2.99.0", "status says gh is there and who it is logged in as");
  process.env.FAKE_GH_LOGGED_OUT = "1";
  st = await gh.githubStatus();
  check(!st.ok && st.available && /gh auth login/.test(st.error), "a logged-out gh is reported with the fix");
  delete process.env.FAKE_GH_LOGGED_OUT;
  process.env.Q38_GH_BIN = path.join(tmp, "no-such-gh");
  st = await gh.githubStatus();
  check(!st.ok && st.available === false && /not installed/.test(st.error), "a missing gh is reported as missing");
  process.env.Q38_GH_BIN = FAKE;

  /* -------------------------------------------------------------- tree */
  let r = await post("tree", { repo: "o/r" });
  check(r.ok && r.defaultBranch === "main" && r.private === true, "a tree carries the repo's branch and visibility");
  check(r.entries.length === 5 && r.entries.some((e) => e.path === "src" && e.type === "dir"), "and every file and folder");
  r = await post("tree", { repo: "https://github.com/o/r/tree/main/src/lib" });
  check(r.ok && r.entries.length === 1 && r.entries[0].path === "src/lib/a.ts", "a github.com tree link narrows to its folder");
  r = await post("tree", { repo: "o/r", path: "src/big.ts" });
  check(!r.ok && /is a file/.test(r.error), "a file passed as a folder says to read it instead");

  /* -------------------------------------------------------------- read */
  r = await post("read", { repo: "o/r", path: "src/big.ts", chars: 3000 });
  check(r.ok && r.startLine === 1 && r.endLine < 300 && r.totalLines === 300, "a long file comes back as a slice of whole lines");
  check(r.text.length <= 3000 && r.nextLine === r.endLine + 1, "inside the budget, with the line to read on from");
  const second = await post("read", { repo: "o/r", path: "src/big.ts", chars: 3000, line: r.nextLine });
  check(second.ok && second.startLine === r.endLine + 1 && second.text.startsWith(`export const line${r.endLine + 1} `), "reading on starts exactly where the last slice ended");
  r = await post("read", { repo: "o/r", path: "src/big.ts", chars: 20000, line: 280 });
  check(r.ok && r.endLine === 300 && r.nextLine === 0, "the last slice says it is the end");
  r = await post("read", { path: "https://github.com/o/r/blob/v1.0/src/big.ts" });
  check(r.ok && r.text === "only on v1.0" && r.ref === "v1.0", "a blob link is read at its own ref");
  r = await post("read", { repo: "o/r", path: "src" });
  check(!r.ok && /is a folder/.test(r.error), "a folder is not read as a file");
  r = await post("read", { repo: "o/r", path: "bin.dat" });
  check(!r.ok && /binary/.test(r.error), "a binary file is refused");
  r = await post("read", { repo: "o/r", path: "nope.ts" });
  check(!r.ok && /not found/.test(r.error), "a missing file says not found");

  /* ------------------------------------------------------------ search */
  r = await post("search", { query: "createApi", repo: "o/r" });
  check(r.ok && r.results[0].path === "src/lib/a.ts", "code search finds files");
  check(calls().some((a) => a[3] === `search/code?q=${encodeURIComponent("createApi repo:o/r")}&per_page=10`), "scoped to the repository asked for");

  /* -------------------------------------------------------------- save */
  const inWs = (rel) => path.join(WS, ...rel.split("/"));
  r = await post("save", { repo: "o/r", path: "src/big.ts" });
  check(r.ok && r.saved === "github/o/r/src/big.ts" && r.lines === 300, "a save lands under github/<owner>/<repo>/");
  check(fs.readFileSync(inWs(r.saved), "utf8") === big, "verbatim, the whole file");
  check(r.content === big && r.replaced === false, "and comes back with its text, ready to pin");
  r = await post("save", { target: "o/r/src/big.ts" });
  check(r.ok && r.replaced === true, "saving again refreshes the earlier copy");
  r = await post("save", { target: "https://github.com/o/r/blob/main/src/big.ts" });
  check(r.ok && r.saved === "github/o/r/src/big.ts" && r.replaced, "a link that names the default branch is the same copy");
  r = await post("save", { target: "https://github.com/o/r/blob/v1.0/src/big.ts" });
  check(r.ok && r.saved === "github/o/r@v1.0/src/big.ts" && fs.readFileSync(inWs(r.saved), "utf8") === "only on v1.0\n", "another ref gets its own folder");
  r = await post("save", { repo: "o/r", path: "src/big.ts", ref: "feature/x" });
  check(r.ok && r.saved === "github/o/r@feature~x/src/big.ts", "a ref with a slash stays one folder");
  check(fs.readFileSync(path.join(WS, "src", "big.ts"), "utf8").startsWith("MY OWN FILE"), "a file of yours with the same name is untouched");
  r = await post("save", { target: "https://github.com/o/r" });
  check(!r.ok && /repository, not a file/.test(r.error), "a repository link is not a file");
  r = await post("save", { target: "https://github.com/o/r/tree/main/src" });
  check(!r.ok && /folder/.test(r.error), "nor is a folder link");
  r = await post("save", { repo: "o/r", path: "src" });
  check(!r.ok && /folder/.test(r.error), "a folder path is refused");
  r = await post("save", { repo: "o/r", path: "bin.dat" });
  check(!r.ok && /binary/.test(r.error), "a binary file is not saved");
  r = await post("save", { target: "o/r/../../../etc/passwd" });
  check(!r.ok && !fs.existsSync(path.join(tmp, "etc")), "a path that climbs out is refused");

  /* ------------------------------------------------- what may not happen */
  const before = calls().length;
  for (const bad of [
    { repo: "o/r; rm -rf ~", path: "a" },
    { repo: "o/r", path: "../../etc/passwd" },
    { repo: "o/r", path: "src/../../x" },
    { repo: "--method=POST/x", path: "a" },
    { repo: "o/r", path: "a", ref: "--input=/etc/passwd" },
    { repo: "o/r", path: "a", ref: "main..evil" },
  ]) {
    const out = await post("read", bad);
    check(!out.ok, `refused before gh runs: ${JSON.stringify(bad)}`);
  }
  check(calls().length === before, "none of those reached gh");
  r = await post("delete", { repo: "o/r" });
  check(r.ok === false && /unknown github route/.test(r.error), "there is no route that writes to GitHub");

  const all = calls();
  const apiCalls = all.filter((a) => a[0] === "api");
  check(all.every((a) => a[0] === "api" || a[0] === "--version"), "gh is only ever asked for api calls or its version");
  check(apiCalls.every((a) => a[1] === "--method" && a[2] === "GET"), "every api call is a GET");
  check(
    apiCalls.every((a) => !a.some((x) => /^(-f|-F|--field|--raw-field|--input|-X)$/.test(x) || /^--(field|raw-field|input)=/.test(x))),
    "and carries no field or input that could turn it into a write",
  );
  check(apiCalls.every((a) => !String(a[3]).startsWith("-")), "and its path is never read as a flag");

  console.log(results.join("\n"));
  console.log(`github route checks passed (${results.length})`);
} catch (err) {
  console.error(results.join("\n"));
  console.error("GITHUB TEST FAILED:", err.message);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
