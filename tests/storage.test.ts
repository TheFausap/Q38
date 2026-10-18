/**
 * The client half of the store: a fresh page loads from the server's disk, not
 * from whatever the browser happened to keep; the browser's copy is imported
 * once; a finished reply is flushed at once; an unreachable server is said out loud.
 *
 *   node --import ./tests/ts-resolve.mjs --experimental-strip-types tests/storage.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const results: string[] = [];
const check = (ok: boolean, msg: string) => {
  results.push(`${ok ? "·" : "✗"} ${msg}`);
  if (!ok) throw new Error(msg);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q38-storage-test-"));
process.env.Q38_STATE_DIR = tmp;
// @ts-expect-error plain JS module
const { createApi } = await import("../server/api.mjs");
const api = createApi();
const server = http.createServer((req, res) => api(req, res, () => res.end("{}")));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

/* a browser, as far as storage.ts can tell */
const ls = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
  setItem: (k: string, v: string) => void ls.set(k, String(v)),
  removeItem: (k: string) => void ls.delete(k),
};
const realFetch = globalThis.fetch;
let serverUp = true;
globalThis.fetch = ((input: string, init?: RequestInit) => {
  if (!serverUp) return Promise.reject(new TypeError("fetch failed"));
  return realFetch(input.startsWith("/") ? base + input : input, init);
}) as typeof fetch;

let n = 0;
/** a fresh page load: a new copy of the module */
const page = async () => import(`../src/lib/storage.ts?page=${++n}`);

const convo = (id: string, replies: string[]) => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  modeId: "coder",
  family: "reasoning",
  messages: replies.map((c, i) => ({ id: `${id}-m${i}`, role: i % 2 ? "assistant" : "user", content: c })),
  compactions: [],
});

try {
  /* ------------------------------------------- first run imports the browser */
  ls.set("q38.sessions.v1", JSON.stringify([convo("old", ["hi", "hello"])]));
  ls.set("q38.settings.v1", JSON.stringify({ llamaUrl: "http://spark:8080" }));
  let s = await page();
  await s.hydrate();
  const settings = s.loadSettings();
  const sessions = s.loadSessions();
  check(settings.llamaUrl === "http://spark:8080" && sessions.length === 1, "an empty server starts from the browser's copy");
  s.saveSettings(settings);
  s.saveSessions(sessions);
  s.saveActiveId("old");
  check(await s.flushNow(), "and the import is flushed");
  check(fs.existsSync(path.join(tmp, "ui", "sessions", "old.json")), "the browser's chats are now on the server's disk");

  /* ---------------------------------------- a reply finishes, then power dies */
  const next = [...sessions, convo("new", ["question", "the answer that must survive"])];
  s.saveSessions(next);
  const changed = { ...settings, llamaUrl: "http://spark:9090" };
  s.saveSettings(changed);
  check(await s.flushNow(), "a finished reply is flushed at once");
  check(s.getSaveStatus().kind === "saved", "and the status says saved");

  /* the browser loses its unflushed writes in the power cut */
  ls.set("q38.sessions.v1", JSON.stringify([convo("old", ["hi", "hello"])]));
  ls.set("q38.settings.v1", JSON.stringify({ llamaUrl: "http://spark:8080" }));

  s = await page();
  await s.hydrate();
  const back = s.loadSessions();
  check(back.some((x: { id: string }) => x.id === "new"), "after the crash the latest chat is back, from the server");
  check(
    back.find((x: { id: string }) => x.id === "new")?.messages.at(-1)?.content === "the answer that must survive",
    "with its last reply",
  );
  check(s.loadSettings().llamaUrl === "http://spark:9090", "and the changed settings, not the browser's stale ones");
  check(s.loadActiveId() === "old", "and the active chat");

  /* ------------------------------------------- the page's own mount saves */
  s.saveSettings(s.loadSettings());
  check(!s.hasUnsaved(), "loading does not rewrite what the server already has");

  /* ----------------------------------------------------------- deleting */
  s.saveSessions(back.filter((x: { id: string }) => x.id !== "old"));
  check(await s.flushNow(), "a deleted chat is saved");
  check(!fs.existsSync(path.join(tmp, "ui", "sessions", "old.json")), "and its file is gone");

  /* ----------------------------------------------------------- server down */
  serverUp = false;
  s = await page();
  await s.hydrate();
  check(s.getSaveStatus().kind === "local", "an unreachable server is reported, not hidden");
  check(s.loadSettings().llamaUrl === "http://spark:9090", "and the app still opens from the browser's mirror of the last state");

  console.log(results.join("\n"));
  console.log(`storage checks passed (${results.length})`);
} catch (err) {
  console.error(results.join("\n"));
  console.error("STORAGE TEST FAILED:", (err as Error).message);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
