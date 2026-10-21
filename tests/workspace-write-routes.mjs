/**
 * workspace_write: what the model may write, and where it may not.
 *
 *   node tests/workspace-write-routes.mjs
 *
 * Runs the real API against a temp workspace holding a file of "yours" and a
 * GitHub copy, and checks that every write lands under ./workspace/model and
 * that no path the model names reaches anything else.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q38-ws-test-"));
const WS = path.join(tmp, "workspace");
const OUTSIDE = path.join(tmp, "outside");
fs.mkdirSync(path.join(WS, "github", "o", "r"), { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
const MINE = "MY OWN FILE — the model must never touch it\n";
fs.writeFileSync(path.join(WS, "notes.md"), MINE);
fs.writeFileSync(path.join(WS, "github", "o", "r", "a.ts"), "from github\n");
process.env.WORKSPACE_DIR = WS;

const { createApi } = await import("../server/api.mjs");
const api = createApi();
const server = http.createServer((req, res) => api(req, res, () => res.end("{}")));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const write = async (body) =>
  (await fetch(`${base}/api/workspace/write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const read = (rel) => fs.readFileSync(path.join(WS, ...rel.split("/")), "utf8");

try {
  /* ------------------------------------------------------------ create */
  let r = await write({ path: "notes/plan.md", content: "# Plan\n\none\n" });
  check(r.ok && r.path === "model/notes/plan.md" && r.created && r.mode === "create", "a new file lands under model/, folders made on the way");
  check(read("model/notes/plan.md") === "# Plan\n\none\n" && r.lines === 3, "with exactly the text given, and its line count");
  check(r.content === "# Plan\n\none\n", "and comes back with its text, ready to pin");
  r = await write({ path: "notes/plan.md", content: "clobber\n" });
  check(!r.ok && r.exists && /overwrite/.test(r.error), "create refuses a taken name and says how to replace it");
  check(read("model/notes/plan.md") === "# Plan\n\none\n", "and leaves the file as it was");

  /* ------------------------------------------------- overwrite / append */
  r = await write({ path: "notes/plan.md", content: "# Plan v2\n", mode: "overwrite" });
  check(r.ok && !r.created && read("model/notes/plan.md") === "# Plan v2\n", "overwrite replaces the model's own file");
  r = await write({ path: "notes/plan.md", content: "two\n", mode: "append" });
  check(r.ok && read("model/notes/plan.md") === "# Plan v2\ntwo\n" && r.content === "# Plan v2\ntwo\n", "append adds to the end and returns the whole file");
  r = await write({ path: "log.txt", content: "first\n", mode: "append" });
  check(r.ok && r.created && read("model/log.txt") === "first\n", "append to a missing file creates it");
  r = await write({ path: "x.txt", content: "y", mode: "delete" });
  check(!r.ok && /not one of/.test(r.error), "an unknown mode is refused");

  /* ----------------------------------------------- paths the model echoes */
  r = await write({ path: "model/echo.md", content: "e" });
  check(r.ok && r.path === "model/echo.md", "a leading model/ is not nested twice");
  r = await write({ path: "./workspace/model/deep/e.md", content: "e" });
  check(r.ok && r.path === "model/deep/e.md", "nor is ./workspace/model/");
  r = await write({ path: "win\\style\\path.txt", content: "w" });
  check(r.ok && r.path === "model/win/style/path.txt", "backslashes are read as folders");

  /* ---------------------------------------------- nothing outside model/ */
  for (const bad of ["../notes.md", "../../outside/pwn.txt", "a/../../notes.md", "/etc/passwd", "C:/x.txt", "~/x.txt", "", "dir/", "a/\u0000b"]) {
    r = await write({ path: bad, content: "PWNED", mode: "overwrite" });
    check(!r.ok, `"${bad.replace("\u0000", "\\0")}" is refused`);
  }
  r = await write({ path: "github/o/r/a.ts", content: "PWNED", mode: "overwrite" });
  check(r.ok && r.path === "model/github/o/r/a.ts", "a path that looks like the GitHub folder still lands under model/");
  check(read("notes.md") === MINE && read("github/o/r/a.ts") === "from github\n", "your files and the GitHub copies are untouched");
  check(fs.readdirSync(OUTSIDE).length === 0, "and nothing was written outside the workspace");

  /* --------------------------------------------------------- links */
  fs.symlinkSync(OUTSIDE, path.join(WS, "model", "escape"));
  r = await write({ path: "escape/pwn.txt", content: "PWNED" });
  check(!r.ok && /link/.test(r.error) && fs.readdirSync(OUTSIDE).length === 0, "a symlink inside model/ is not followed");
  fs.writeFileSync(path.join(OUTSIDE, "target.txt"), "outside\n");
  fs.symlinkSync(path.join(OUTSIDE, "target.txt"), path.join(WS, "model", "file-link.txt"));
  r = await write({ path: "file-link.txt", content: "PWNED", mode: "overwrite" });
  check(!r.ok && fs.readFileSync(path.join(OUTSIDE, "target.txt"), "utf8") === "outside\n", "nor is a symlinked file");

  /* --------------------------------------------------------- content */
  r = await write({ path: "n.bin", content: "a\u0000b" });
  check(!r.ok && /NUL/.test(r.error), "binary content is refused");
  r = await write({ path: "obj.json", content: { a: 1 } });
  check(!r.ok && /text/.test(r.error), "content that is not a string is refused");
  r = await write({ path: "big.txt", content: "x".repeat(2 * 1024 * 1024 + 1) });
  check(!r.ok && /limit/.test(r.error) && !fs.existsSync(path.join(WS, "model", "big.txt")), "a file over 2 MB is refused and not written");
  r = await write({ path: "notes", content: "x", mode: "overwrite" });
  check(!r.ok && /folder/.test(r.error), "a folder is not overwritten with a file");

  const leftovers = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".tmp")) leftovers.push(e.name);
    }
  };
  walk(WS);
  check(leftovers.length === 0, "no temp files left behind");

  console.log(results.join("\n"));
  console.log(`workspace write checks passed (${results.length})`);
} catch (err) {
  console.error(results.join("\n"));
  console.error("WORKSPACE WRITE TEST FAILED:", err.message);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
