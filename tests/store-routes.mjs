/**
 * The workbench's own state on the server's disk: settings, the chat list and
 * every conversation, written so that a power cut cannot lose a saved reply.
 *
 *   node tests/store-routes.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q38-store-test-"));
process.env.Q38_STATE_DIR = tmp;
const { createApi } = await import("../server/api.mjs");
const { writeDurable } = await import("../server/durable.mjs");

const api = createApi();
const server = http.createServer((req, res) => api(req, res, () => res.end("{}")));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const load = async () => (await fetch(`${base}/api/store`)).json();
const save = async (tab, docs, contentType = "application/json") => {
  const res = await fetch(`${base}/api/store/save`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: JSON.stringify({ tab, docs }),
  });
  return { status: res.status, body: await res.json() };
};
const sessionFile = (id) => path.join(tmp, "ui", "sessions", `${id}.json`);
const convo = (n) => ({ id: "s1", title: "t", messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: "user", content: `turn ${i}` })) });

try {
  /* ------------------------------------------------------------- durable */
  const f = path.join(tmp, "d", "x.json");
  writeDurable(f, "one");
  writeDurable(f, "two");
  check(fs.readFileSync(f, "utf8") === "two", "a durable write replaces the file whole");
  check(fs.readdirSync(path.dirname(f)).length === 1, "and leaves no temp file behind");

  /* --------------------------------------------------------------- empty */
  let state = await load();
  check(state.ok && !state.settings && !state.index && state.sessions.length === 0, "an empty store says so");

  /* ---------------------------------------------------------- first save */
  let r = await save("tabA", [
    { kind: "settings", base: 0, seq: 1, data: { llamaUrl: "http://spark:8080", apiKey: "k" } },
    { kind: "session", id: "s1", base: 0, seq: 1, data: convo(2) },
    { kind: "index", base: 0, seq: 1, data: { order: ["s1"], activeId: "s1" } },
  ]);
  check(r.status === 200 && r.body.results.every((x) => x.ok && x.rev === 1), "a first save is accepted at rev 1");
  check(fs.existsSync(sessionFile("s1")), "each conversation is its own file");
  if (process.platform !== "win32") {
    const mode = fs.statSync(path.join(tmp, "ui", "settings.json")).mode & 0o777;
    check(mode === 0o600, "settings (they hold API keys) are readable by the owner only");
  }
  state = await load();
  check(state.settings.data.llamaUrl === "http://spark:8080" && state.sessions[0].data.messages.length === 2, "and it all loads back");

  /* ---------------------------------------------------- same tab, in order */
  r = await save("tabA", [{ kind: "session", id: "s1", base: 1, seq: 2, data: convo(4) }]);
  check(r.body.results[0].ok && r.body.results[0].rev === 2, "the same tab saves again");
  r = await save("tabA", [{ kind: "session", id: "s1", base: 1, seq: 2, data: convo(3) }]);
  check(r.body.results[0].stale === true, "a late write from the same tab is dropped");
  check(JSON.parse(fs.readFileSync(sessionFile("s1"), "utf8")).data.messages.length === 4, "so it never overwrites the newer reply");

  /* ------------------------------------------------- another tab, stale */
  r = await save("tabB", [{ kind: "session", id: "s1", base: 1, seq: 1, data: convo(1) }]);
  check(r.status === 409 && r.body.results[0].conflict && r.body.results[0].rev === 2, "a stale tab gets a conflict, not an overwrite");
  check(JSON.parse(fs.readFileSync(sessionFile("s1"), "utf8")).data.messages.length === 4, "the newer conversation is untouched");
  r = await save("tabB", [{ kind: "session", id: "s1", base: 2, seq: 2, data: convo(5) }]);
  check(r.body.results[0].ok && r.body.results[0].rev === 3, "a tab that saw the latest rev may save");
  r = await save("tabA", [{ kind: "session", id: "s1", base: 2, seq: 3, data: convo(6), force: true }]);
  check(r.body.results[0].ok, "and keep-this-tab overwrites on purpose");

  /* ------------------------------------------------------------- beacon */
  r = await save("tabA", [{ kind: "sampling", base: 0, seq: 1, data: { max_tokens: 99 } }], "text/plain");
  check(r.body.results[0].ok, "a text/plain body (a page-exit beacon) is read too");

  /* ------------------------------------------------------------- delete */
  r = await save("tabA", [{ kind: "session", id: "s1", base: 4, seq: 4, delete: true }]);
  check(r.body.results[0].ok && !fs.existsSync(sessionFile("s1")), "deleting a chat removes its file");

  /* ------------------------------------------------------------- safety */
  r = await save("tabA", [{ kind: "session", id: "../../etc/passwd", base: 0, seq: 1, data: {} }]);
  check(r.body.results[0].ok === false, "a session id cannot name a path");
  r = await save("tabA", [{ kind: "nope", base: 0, seq: 1, data: {} }]);
  check(r.body.results[0].ok === false, "unknown kinds are refused");

  /* ----------------------------------------------- torn or corrupt files */
  fs.writeFileSync(sessionFile("bad"), "{ half a file");
  fs.writeFileSync(path.join(tmp, "ui", "sessions", "s9.json.123.4.tmp"), "leftover");
  state = await load();
  check(!state.sessions.some((s) => s.id === "bad"), "an unreadable conversation does not break loading");
  const names = fs.readdirSync(path.join(tmp, "ui", "sessions"));
  check(names.some((n) => n.startsWith("bad.json.corrupt-")), "and is kept aside, not deleted");
  check(!names.some((n) => n.endsWith(".tmp")), "temp files from a write that died are swept");

  console.log(results.join("\n"));
  console.log(`store checks passed (${results.length})`);
} catch (err) {
  console.error(results.join("\n"));
  console.error("STORE TEST FAILED:", err.message);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
