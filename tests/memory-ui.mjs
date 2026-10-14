/**
 * Disk memory end to end.
 *
 *   npm run test:ui
 *
 * Drives the real workbench in jsdom against the real middleware (server/api.mjs)
 * and a stub llama-server: a full window moves turns onto disk instead of
 * paraphrasing them, a turn recalls what it needs, the model can ask for a chunk
 * itself, and nothing is ever lost.
 *
 * Needs the UI bundle first — the npm script builds it into tests/.bundle.
 */
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { createApi } from "../server/api.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BUNDLE = fileURLToPath(new URL(".bundle/ui-test-entry.js", import.meta.url));
const STATE = fileURLToPath(new URL(".tmp/state", import.meta.url));
const WORK = fileURLToPath(new URL(".tmp/ws-memory", import.meta.url));

if (!fs.existsSync(BUNDLE)) {
  console.error(`No bundle at ${BUNDLE}. Run \`npm run test:ui\` (it builds first).`);
  process.exit(2);
}
fs.rmSync(STATE, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
process.env.Q38_STATE_DIR = STATE;
process.env.WORKSPACE_DIR = WORK;

const MIDDLEWARE_PORT = 8174;
const STUB_PORT = 8175;

/* ---------------------------------------------------- stub llama-server */
const calls = [];
let toolAsksSeen = 0;
const stub = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${STUB_PORT}`);
  const json = (body) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/health") return json({ status: "ok" });
  if (url.pathname === "/v1/models") return json({ data: [{ id: "stub-q38" }] });
  if (url.pathname === "/props") return json({ default_generation_settings: { n_ctx: 3000 } });
  if (url.pathname !== "/v1/chat/completions") return json({});

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    calls.push({ messages: body.messages, tools: body.tools });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (j) => res.write(`data: ${JSON.stringify(j)}\n\n`);

    /* A turn that says TOOLPLEASE gets a tool call instead of prose, as long as
       the client actually offered the tool — that is the whole check. The ask is
       answered once, then prose: a model that asked forever would be a different
       bug, and the hop cap is checked by the call count. */
    const newestUser = [...(body.messages || [])].reverse().find((m) => m.role === "user") || {};
    const asksForTool = /TOOLPLEASE/.test(newestUser.content || "");
    if (asksForTool) toolAsksSeen++;
    if (asksForTool && toolAsksSeen === 1 && body.tools?.length) {
      const wanted = body.tools[0]?.function?.name;
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: wanted, arguments: '{"chunk":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      chunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: null },
        ],
      });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const answer = "Noted. The retry helper keeps its abort path.";
    for (const piece of answer.match(/[\s\S]{1,40}/g) || []) {
      chunk({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    }
    chunk({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      timings: { prompt_n: 200, predicted_n: 12, predicted_per_second: 30 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

/* ------------------------------------------------------- app middleware */
const api = createApi();
const middleware = http.createServer((req, res) => api(req, res, () => res.end("{}")));
await new Promise((r) => middleware.listen(MIDDLEWARE_PORT, "127.0.0.1", r));

/* --------------------------------------------------------------- jsdom */
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => console.log("   [jsdomError]", e.message));
vc.on("warn", () => {});
const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
  url: "http://localhost:5173/",
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;
for (const key of [
  "window", "document", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "Event",
  "MouseEvent", "KeyboardEvent", "Node", "Element", "Text", "CustomEvent", "DOMParser",
  "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

const realFetch = globalThis.fetch;
/** flipped on to make the store refuse writes: the fold fallback must catch it */
let memoryBroken = false;
const patched = (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (memoryBroken && url.startsWith("/api/memory/")) {
    return Promise.resolve(
      new Response(JSON.stringify({ ok: false, error: "the disk is not answering" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  if (url.startsWith("/api/")) return realFetch(`http://127.0.0.1:${MIDDLEWARE_PORT}${url}`, init);
  return realFetch(input, init);
};
globalThis.fetch = patched;
window.fetch = patched;

/* a session already long enough that the window is over the fold line */
const long = (t) => t.repeat(6);
const session = {
  id: "sess-mem-1",
  title: "memory run",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  modeId: "coder",
  family: "reasoning",
  messages: [
    { id: "u1", role: "user", content: long("{REASON:coder} wire the retry loop into src/lib/api.ts so a 503 does not kill the turn. ") },
    { id: "a1", role: "assistant", content: long("Done: retryLoop() now honours abortSignal in src/lib/api.ts and throws HttpError. ") },
    { id: "u2", role: "user", content: long("also handle the timeout in src/lib/retry.ts and keep the backoff jittered. ") },
    { id: "a2", role: "assistant", content: long("Added withTimeout() to src/lib/retry.ts; backoff is jittered. ") },
    { id: "u3", role: "user", content: "now switch the histogram to a rate meter" },
    { id: "a3", role: "assistant", content: "Switched the meter to a rate gauge in src/lib/meter.ts." },
  ],
  compactions: [],
};
window.localStorage.setItem("q38.sessions.v1", JSON.stringify([session]));
window.localStorage.setItem("q38.active.v1", "sess-mem-1");
window.localStorage.setItem(
  "q38.settings.v1",
  JSON.stringify({
    llamaUrl: `http://127.0.0.1:${STUB_PORT}`,
    systemPrompt: "You are Q38.",
    contextSize: 3000,
    autoCompact: true,
    compactAt: 0.2,
    keepTailMessages: 2,
    summaryMaxTokens: 800,
    autoContinue: false,
    retroFeedback: true,
  }),
);
window.localStorage.setItem("q38.sampling.v1", JSON.stringify({ max_tokens: 64 }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allText = () => window.document.body.textContent || "";
const text = (sel) => window.document.querySelector(sel)?.textContent || "";
const buttons = () => [...window.document.querySelectorAll("button")];
const byText = (re) => buttons().find((b) => re.test((b.textContent || "").trim()));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const stored = () => JSON.parse(window.localStorage.getItem("q38.sessions.v1"))[0];
const chunkFiles = () => {
  const file = `${STATE}/sessions/sess-mem-1/chunks.ndjson`;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

async function waitFor(label, fn, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Type into the composer and press send. */
async function type(text) {
  const area = await waitFor("composer", () => window.document.querySelector(".composer textarea"));
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(area, text);
  area.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(60);
  click(byText(/^send$/));
}

async function ask(question) {
  // progress is measured in stored turns, not rendered ones: archiving hides
  // messages from the transcript by design, so the DOM count is not a signal
  const before = stored().messages.length;
  await type(question);
  await waitFor("reply started", () => stored().messages.length > before, 30000);
  await waitFor(
    "reply landed",
    () =>
      stored().messages.length >= before + 2 &&
      !window.document.querySelector(".msg.assistant.live") &&
      !window.document.querySelector(".job-pip"),
    30000,
  );
  await sleep(150);
}

/** Type a slash command and press send: it acts on the spot and sends nothing. */
async function command(text) {
  await type(text);
  await sleep(400);
}

const results = [];
const check = (ok, msg) => {
  results.push(`${ok ? "·" : "✗"} ${msg}`);
  if (!ok) throw new Error(msg);
};

try {
  await import(BUNDLE);
  await waitFor("boot", () => window.document.querySelector(".composer textarea"));

  /* --- 1. a full window archives instead of summarising ---------------- */
  await ask("what does the retry loop do about aborts?");
  await waitFor("archive happened", () => stored().archives?.length > 0, 25000);

  const refs = stored().archives;
  check(refs.length === 1, `one chunk moved out (got ${refs.length})`);
  check(refs[0].count >= 2, `the chunk holds the oldest turns (${refs[0].count} messages)`);
  check(/^#1 ·/.test(refs[0].register), `the register line is mechanical: ${refs[0].register}`);
  check(refs[0].paths.includes("src/lib/api.ts"), `the register names the files: ${refs[0].paths.join(", ")}`);

  const onDisk = chunkFiles();
  check(onDisk.length === 1, "the chunk is on disk");
  check(onDisk[0].body.messages.length === refs[0].count, "and carries the messages it claims");
  check(
    onDisk[0].body.messages.some((m) => /retry loop into src\/lib\/api\.ts/.test(m.content)),
    "verbatim, not paraphrased",
  );
  check(refs[0].register.startsWith("#1"), "the store path is per session, under the state root");

  /* the model sees the register, not the bodies */
  const firstCall = calls[calls.length - 1];
  const wire = JSON.stringify(firstCall.messages);
  check(/## Archive/.test(wire), "the window carries the archive register");
  check(/#1 ·/.test(wire), "with the register line in it");
  check(!/retryLoop\(\) now honours abortSignal/.test(wire), "and not the archived messages themselves");
  check(stored().messages.length === 8, "no message was deleted from the transcript");

  /* --- 2. the card and the banner say what happened -------------------- */
  check(!!window.document.querySelector(".mem-card"), "the memory card is in the transcript");
  check(/1 chunk on disk/.test(text(".mem-card")), `and counts them: ${text(".mem-head")}`);
  check(/pull back/.test(text(".mem-card")), "and offers to pull a chunk back");
  check(/memory/.test(text(".banner.memory")), `the banner explains it: ${text(".banner.memory").slice(0, 90)}`);

  /* --- 3. a turn that needs the archive recalls it automatically ------- */
  const before = calls.length;
  await ask("remind me what retryLoop does in src/lib/api.ts");
  const recallWire = JSON.stringify(calls[calls.length - 1].messages);
  check(calls.length > before, "the turn was sent");
  check(/### Recalled #1/.test(recallWire), "the archived chunk came back for this turn");
  check(/retryLoop\(\) now honours abortSignal/.test(recallWire), "verbatim, in the window this time");
  check(/matched/.test(text(".banner.memory")), `and the banner says why: ${text(".banner.memory").slice(0, 120)}`);
  check(stored().archives[0].recalls === 1, "the ref counts the recall");
  check(!(stored().held ?? []).includes(refs[0].id), "an automatic recall is not a permanent pin");

  /* --- 4. a turn that needs nothing does not drag the archive back ----- */
  const beforePlain = calls.length;
  await ask("explain how quicksort pivot selection works");
  const plainWire = JSON.stringify(calls[calls.length - 1].messages);
  check(calls.length > beforePlain, "the second turn was sent");
  check(!/### Recalled/.test(plainWire), "an unrelated turn recalls nothing");
  check(/## Archive/.test(plainWire), "but the register is still there, so the model knows it exists");

  /* --- 5. pull back by hand keeps it in the window --------------------- */
  const pull = byText(/pull back/);
  check(!!pull, "the card still offers pull back");
  click(pull);
  await waitFor("pinned", () => (stored().held ?? []).length === 1, 20000);
  check(
    /back in the window/.test(text(".banner.memory")) && /stays there/.test(text(".banner.memory")),
    `pulling back says so: ${text(".banner.memory").slice(0, 120)}`,
  );
  const beforeHeld = calls.length;
  await ask("and what about the timeout helper?");
  const heldWire = JSON.stringify(calls[calls.length - 1].messages);
  check(calls.length > beforeHeld, "the next turn was sent");
  check(/### Recalled #1/.test(heldWire), "a pinned chunk rides along every turn");

  const release = byText(/let go/);
  check(!!release, "and can be let go");
  click(release);
  await waitFor("released", () => (stored().held ?? []).length === 0, 20000);

  /* --- 6. the model can ask for a chunk itself ------------------------- */
  await ask("read something older back for me TOOLPLEASE");
  const hopCalls = calls.filter((c) => JSON.stringify(c.messages).includes("TOOLPLEASE"));
  check(hopCalls.length === 2, `the turn was sent twice — once to ask, once with the chunk (${hopCalls.length})`);
  check(!!hopCalls[0].tools?.length, "the tool was offered while something is on disk");
  check(
    hopCalls[0].tools[0].function.name === "recall",
    `and it is the recall tool: ${hopCalls[0].tools[0].function.name}`,
  );
  check(!/### Recalled/.test(JSON.stringify(hopCalls[0].messages)), "the first attempt carries no chunk body");
  check(
    /### Recalled #1/.test(JSON.stringify(hopCalls[1].messages)),
    "the second attempt carries the chunk the model asked for",
  );
  check(/read .* back off the disk/.test(allText()), "the transcript shows the hop");
  check(stored().messages.filter((m) => m.recalled).length === 1, "and the reply records it");
  check(stored().archives[0].recalls >= 1, "the chunk counts the model's read");

  /* --- 7. /recall N is the same move, typed ---------------------------- */
  const beforeCommand = calls.length;
  await command("/recall 1");
  await waitFor("command pinned the chunk", () => (stored().held ?? []).length === 1, 20000);
  check(calls.length === beforeCommand, "a command is not sent to the model");
  check(
    /back in the window/.test(text(".banner.memory")),
    `/recall says what it did: ${text(".banner.memory").slice(0, 110)}`,
  );
  const areaAfter = window.document.querySelector(".composer textarea");
  check(areaAfter.value === "", "and the command does not stay in the composer");

  await command("/recall 9");
  check(/No chunk #9/.test(text(".banner.memory")), "an unknown register number is reported, not sent");

  /* --- 8. unarchive brings everything back ---------------------------- */
  const unarchive = byText(/unarchive/);
  check(!!unarchive, "the card offers unarchive");
  /* Unarchive must not drop a single message: 6 seeded + 2 per turn asked. */
  const beforeUnarchive = stored().messages.length;
  check(beforeUnarchive >= 6 + 2 * 5, `the transcript grew with every turn (${beforeUnarchive} messages)`);
  click(unarchive);
  await waitFor("archive cleared", () => (stored().archives ?? []).length === 0, 20000);
  check(stored().messages.length === beforeUnarchive, "every message is back in the window");
  check(!window.document.querySelector(".mem-card"), "the card is gone");
  check(!fs.existsSync(`${STATE}/sessions/sess-mem-1/chunks.ndjson`), "and the store was cleared with it");

  /* --- 9. a store that refuses falls back to folding, and says so ----- */
  memoryBroken = true;
  await ask("now the long one, tell me everything about the retry loop and the timeout helper and the meter");
  memoryBroken = false;
  check(!window.document.querySelector(".mem-card"), "nothing pretends to be on disk when the store refuses");
  check(!!window.document.querySelector(".fold-card"), "the fold card takes its place");
  check(
    /memory store is out of reach/.test(allText()) && /folded into a/.test(allText()),
    "and the banner says the store is out of reach, so it folded instead",
  );
  check((stored().compactions ?? []).length === 1, "the fold is recorded, so it can be undone");

  console.log(results.join("\n"));
  console.log("memory ui checks passed");
} catch (err) {
  try {
    console.error("   [debug] calls:", calls.length);
    console.error(
      "   [debug] stored turns:",
      stored()
        .messages.map((m) => m.role[0] + (m.error ? "!" + String(m.error).slice(0, 60) : ""))
        .join(","),
    );
  } catch {
    /* nothing to report */
  }
  console.error(results.join("\n"));
  console.error("MEMORY UI TEST FAILED:", err.message);
  process.exitCode = 1;
} finally {
  middleware.close();
  stub.close();
  window.close();
  process.exit(process.exitCode || 0);
}
