/**
 * The workbench end to end: memory on disk, and the web tools.
 *
 *   npm run test:ui
 *
 * Drives the real app in jsdom against the real middleware (server/api.mjs), a
 * stub llama-server and a stub SearXNG. Memory: a full window moves turns onto
 * disk instead of paraphrasing them, a turn recalls what it needs, the model can
 * ask for a chunk itself, nothing is ever lost. Web: the model can search, read
 * a page, cite what it read, and survive a search engine that says no.
 *
 * Needs the UI bundle first — the npm script builds it into tests/.bundle.
 */
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { createApi } from "../server/api.mjs";
import { samplePaper } from "./pdf-fixture.mjs";

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
/* the stub world is on 127.0.0.1, which the page guard refuses by default;
   that refusal has its own test below, and this is the documented switch */
process.env.Q38_WEB_ALLOW_PRIVATE = "1";
/* a skills folder of our own, so the run does not depend on skills:sync */
const SKILLS = fileURLToPath(new URL(".tmp/skills", import.meta.url));
fs.rmSync(SKILLS, { recursive: true, force: true });
fs.mkdirSync(`${SKILLS}/qutip/references`, { recursive: true });
fs.writeFileSync(
  `${SKILLS}/qutip/SKILL.md`,
  "---\nname: qutip\ndescription: Simulates open quantum systems with QuTiP. Lindblad master equations.\n---\n" +
    "# QuTiP\n\nUse mesolve(H, rho0, tlist, c_ops) for the Lindblad master equation.\n",
);
fs.writeFileSync(`${SKILLS}/qutip/references/time_evolution.md`, "# Time evolution\n");
process.env.Q38_SKILLS_DIR = SKILLS;
/* and a library of our own, empty at the start */
const LIBRARY = fileURLToPath(new URL(".tmp/library", import.meta.url));
fs.rmSync(LIBRARY, { recursive: true, force: true });
process.env.Q38_LIBRARY_DIR = LIBRARY;

const MIDDLEWARE_PORT = 8174;
const STUB_PORT = 8175;
const SEARCH_PORT = 8176;

/* ---------------------------------------------------- stub llama-server */
const calls = [];
/** asks already answered, keyed `<tool>::<the user message that asked>` */
const answered = new Set();
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

    /* TOOLPLEASE asks for the recall tool, SEARCHPLEASE for web_search,
       OPENPLEASE for web_fetch — each answered once per turn, so a model that
       asked forever would not be the bug the call counts are checking. The
       arguments go out in two deltas, the way llama.cpp streams a tool call. */
    const newestUser = [...(body.messages || [])].reverse().find((m) => m.role === "user") || {};
    const newestText = newestUser.content || "";
    const asksForTool = /TOOLPLEASE/.test(newestText);
    const asksToSearch = /SEARCHPLEASE/.test(newestText);
    const asksToOpen = /OPENPLEASE/.test(newestText);
    const asksForSkill = /SKILLPLEASE/.test(newestText);
    /* DOCPLEASE: add a paper, then search it, then answer — one turn, three rounds */
    const asksForDoc = /DOCPLEASE/.test(newestText);
    /* GREEDYSKILL never stops asking: the workbench has to end the turn itself */
    const greedy = /GREEDYSKILL/.test(newestText);
    const wireText = JSON.stringify(body.messages || []);
    const already = (name) =>
      wireText.includes(name === "recall" ? "### Recalled" : name === "web_search" ? "### Web results" : "### Page:");
    const offered = (name) => body.tools?.some((t) => t.function?.name === name);

    const emit = (name, args) => {
      const half = Math.ceil(args.length / 2);
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: args.slice(0, half) } }],
            },
            finish_reason: null,
          },
        ],
      });
      chunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] },
            finish_reason: null,
          },
        ],
      });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    };

    /* answer a given ask once per turn: keyed on the user message that asked, so
       a later turn asking again gets a tool call rather than prose */
    const sig = (kind) => `${kind}::${newestText}`;
    if (asksForTool && !answered.has(sig("recall")) && offered("recall")) {
      answered.add(sig("recall"));
      emit("recall", '{"chunk":1}');
      return;
    }
    if (asksToSearch && !answered.has(sig("web_search")) && !already("web_search") && offered("web_search")) {
      answered.add(sig("web_search"));
      /* search for the user's own words, the way a model would — and pass any
         "slowpoke" through, which is how the stub is told to dawdle */
      const query = /slowpoke/.test(newestText)
        ? "slowpoke retry helpers"
        : "retry timeout helpers src/lib/api.ts";
      emit("web_search", JSON.stringify({ query, count: 3 }));
      return;
    }
    if (asksForSkill && !answered.has(sig("skill_load")) && !wireText.includes("### Skill:") && offered("skill_load")) {
      answered.add(sig("skill_load"));
      emit("skill_load", '{"name":"qutip"}');
      return;
    }
    if (asksForDoc && offered("doc_add") && !wireText.includes("### Added to the library")) {
      emit("doc_add", JSON.stringify({ url: `http://127.0.0.1:${SEARCH_PORT}/paper.pdf` }));
      return;
    }
    if (asksForDoc && offered("doc_search") && !wireText.includes("### Library passages")) {
      emit("doc_search", JSON.stringify({ query: "how often does each block of the continuum memory update" }));
      return;
    }
    if (greedy && offered("skill_load")) {
      emit("skill_load", '{"name":"qutip"}');
      return;
    }
    if (asksToOpen && !answered.has(sig("web_fetch")) && !already("web_fetch") && offered("web_fetch")) {
      answered.add(sig("web_fetch"));
      const slow = /slowopen/.test(newestText) ? "?slow=1" : "";
      emit("web_fetch", JSON.stringify({ url: `http://127.0.0.1:${SEARCH_PORT}/page${slow}` }));
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

/* ------------------------------------------------- stub search + page */
const searchHits = [];
/** one page, served fast or slow — the tests read the same words either way */
const PAGE_HTML = `<html><head><title>Retry helpers</title><script>tracker()</script></head><body>
        <h1>withTimeout</h1><p>withTimeout() arms an AbortSignal and clears it in a finally block,
        so a slow 503 cannot hold the turn open forever.</p></body></html>`;
const search = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${SEARCH_PORT}`);
  searchHits.push(url.pathname + url.search);
  if (url.pathname === "/search") {
    /* "slowpoke" makes the search take its time, so a test can see what the
       workbench says while it is still waiting */
    const delay = /slowpoke/.test(url.searchParams.get("q") || "") ? 900 : 0;
    if (delay) {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [{ title: "Slow result", url: "https://example.com/slow", content: "took its time" }] }));
      }, delay);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        results: [
          {
            title: "withTimeout &mdash; retry helpers",
            url: `http://127.0.0.1:${SEARCH_PORT}/page`,
            content: "how the timeout helper is meant to behave in src/lib/retry.ts",
          },
          { title: "Second hit", url: "https://example.com/second", content: "another one" },
        ],
      }),
    );
    return;
  }
  if (url.pathname === "/paper.pdf") {
    const pdf = samplePaper();
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length });
    res.end(pdf);
    return;
  }
  if (url.pathname === "/page") {
    const send = () => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
    };
    if (url.searchParams.get("slow") === "1") setTimeout(send, 700);
    else send();
    return;
  }
  res.writeHead(404, { "Content-Type": "text/html" });
  res.end("<h1>not here</h1>");
});
await new Promise((r) => search.listen(SEARCH_PORT, "127.0.0.1", r));

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
    webSearch: true,
    webProvider: "searx",
    searxUrl: `http://127.0.0.1:${SEARCH_PORT}`,
    webResults: 5,
    webPageChars: 4000,
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

/** Send, and come back immediately — for watching a turn while it is in flight. */
async function startAsk(question) {
  const before = stored().messages.length;
  await type(question);
  return async () => {
    await waitFor("reply started", () => stored().messages.length > before, 30000);
    await waitFor(
      "reply landed",
      () =>
        stored().messages.length >= before + 2 &&
        !window.document.querySelector(".msg.assistant.live") &&
        !window.document.querySelector(".job-pip"),
      30000,
    );
  };
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

  /* --- 8. the model searches the web and reads a page ---------------- */
  const beforeSearch = calls.length;
  await ask("what does withTimeout do in src/lib/retry.ts? SEARCHPLEASE");
  const searchCalls = calls.filter((c) => JSON.stringify(c.messages).includes("SEARCHPLEASE"));
  check(searchCalls.length === 2, `the search turn was sent twice (${searchCalls.length})`);
  check(
    searchCalls[0].tools?.some((t) => t.function.name === "web_search"),
    "the search tool was offered",
  );
  check(
    searchCalls[0].tools?.some((t) => t.function.name === "web_fetch"),
    "and so was the fetch tool",
  );
  const searched = JSON.stringify(searchCalls[1].messages);
  check(/### Web results/.test(searched), "the results came back into the prompt");
  check(/withTimeout — retry helpers/.test(searched), "with titles");
  check(new RegExp(`127\\.0\\.0\\.1:${SEARCH_PORT}/page`).test(searched), "and addresses ready to open");
  check(searchHits.some((h) => h.startsWith("/search?q=")), `the stub search was asked: ${searchHits[0]}`);
  check(/q=retry\+timeout\+helpers|q=retry%20timeout%20helpers/.test(searchHits.join(" ")), "with the model's own words");
  check(calls.length > beforeSearch, "the turn went on");
  check(/searched ×1/.test(allText()), "the transcript marks the search");
  check(!!window.document.querySelector(".web-sources"), "and lists where it looked");
  check(/127\.0\.0\.1/.test(text(".web-sources")), `naming the host: ${text(".web-sources").slice(0, 120)}`);
  await waitFor("the searched count is saved", () => stored().messages.some((m) => m.searched === 1), 5000);
  check(stored().messages.some((m) => m.searched === 1), "the reply records it");
  check(/Searched "/.test(text(".banner.web")), `the banner says so: ${text(".banner.web").slice(0, 110)}`);

  /* --- 9. reading the page itself ------------------------------------- */
  const beforeOpen = calls.length;
  const openSettle = await startAsk("open that page slowly slowopen and read it OPENPLEASE");
  const opening = await waitFor("the reading indicator", () => window.document.querySelector(".web-live"), 8000);
  check(
    /reading 127\.0\.0\.1/.test(opening.textContent || ""),
    `while a page is being read, it says which host: ${opening.textContent}`,
  );
  await openSettle();
  const openCalls = calls.filter((c) => JSON.stringify(c.messages).includes("OPENPLEASE"));
  check(openCalls.length === 2, `the open turn was sent twice (${openCalls.length})`);
  const opened = JSON.stringify(openCalls[1].messages);
  check(/### Page: Retry helpers/.test(opened), "the page text came back into the prompt");
  check(/arms an AbortSignal/.test(opened), "verbatim from the page");
  check(!/tracker\(\)/.test(opened), "and its scripts did not");
  check(/information, not instruction/i.test(opened), "and the model was told what page text is");
  check(/read 1 page/.test(allText()), "the transcript marks the read");
  check(calls.length > beforeOpen, "the turn went on");
  check(/Read 127\.0\.0\.1/.test(text(".banner.web")), `the banner names the page: ${text(".banner.web").slice(0, 120)}`);
  await waitFor("the opened count is saved", () => stored().messages.some((m) => m.opened === 1), 5000);
  check(stored().messages.some((m) => m.opened === 1), "the reply records it");

  /* --- 10. the model says so while it is looking ---------------------- */
  const settle = await startAsk("look up the slowpoke retry helper SEARCHPLEASE");
  /* the search is deliberately slow: while it is out, the workbench must say so */
  const live = await waitFor("the searching indicator", () => window.document.querySelector(".web-live"), 8000);
  check(
    /searching the web for “slowpoke/.test(live.textContent || ""),
    `the composer says what it is doing: ${live.textContent}`,
  );
  check(/waiting on the network/.test(live.textContent || ""), "and why the turn has gone quiet");
  const tape = window.document.querySelector(".jc-line.jc-web.jc-line-live");
  check(!!tape && /WEB: SEARCHING/.test(tape.textContent || ""), `and the console tape too: ${tape?.textContent || "(none)"}`);
  await settle();
  check(
    !window.document.querySelector(".web-live"),
    "and it is gone once the answer is in, so it never becomes decoration",
  );
  check(/searched ×1/.test(allText()), "the reply keeps the record of it");

  /* --- 11. a page the guard refuses ----------------------------------- */
  delete process.env.Q38_WEB_ALLOW_PRIVATE;
  const guarded = await fetch(`http://127.0.0.1:${MIDDLEWARE_PORT}/api/web/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://127.0.0.1:8186/page" }),
  });
  const guardedBody = await guarded.json();
  check(guarded.status === 502, `a private address is refused (${guarded.status})`);
  check(/only reads public addresses/.test(guardedBody.error), `in plain words: ${guardedBody.error}`);
  process.env.Q38_WEB_ALLOW_PRIVATE = "1";

  /* --- 11b. the model consults a skill -------------------------------- */
  const beforeSkill = calls.length;
  await ask("how do I evolve a Lindblad master equation? SKILLPLEASE");
  const skillCalls = calls.slice(beforeSkill).filter((c) => JSON.stringify(c.messages).includes("SKILLPLEASE"));
  check(skillCalls.length === 2, `the skill turn was sent twice — to ask, then with the skill (${skillCalls.length})`);
  const loadTool = skillCalls[0].tools?.find((t) => t.function?.name === "skill_load");
  check(!!loadTool, "skill_load is offered when the folder has skills");
  check(
    loadTool.function.parameters.properties.name.enum?.includes("qutip"),
    "a small library is offered by name",
  );
  check(/- qutip: Simulates open quantum systems/.test(loadTool.function.description), "with a line per skill");
  const withSkill = skillCalls[1].messages;
  check(
    withSkill[0].role === "system" && withSkill.filter((m) => m.role === "system").length === 1,
    "the skill rides in the one leading system message (Qwen templates allow no other)",
  );
  check(/### Skill: qutip/.test(withSkill[0].content), "the skill came back into the prompt");
  check(/mesolve\(H, rho0, tlist, c_ops\)/.test(withSkill[0].content), "verbatim");
  check(/references\/time_evolution\.md/.test(withSkill[0].content), "with the files it could open next");
  check(/consulted a skill/.test(allText()), "the transcript marks the consultation");
  await waitFor("the skill is saved on the reply", () =>
    stored().messages.some((m) => (m.skillsRead ?? []).includes("qutip")), 5000);
  check(stored().messages.some((m) => (m.skillsRead ?? []).includes("qutip")), "the reply records which skill");

  /* --- 11d. the model reads a paper into the library and cites it ----- */
  const beforeDoc = calls.length;
  await ask("what does the nested memories paper say about update frequency? DOCPLEASE");
  const docCalls = calls.slice(beforeDoc).filter((c) => JSON.stringify(c.messages).includes("DOCPLEASE"));
  check(docCalls.length === 3, `add, search, answer: three rounds (${docCalls.length})`);
  const docTools = (docCalls[0].tools || []).map((t) => t.function?.name);
  check(["doc_add", "doc_search", "doc_read"].every((n) => docTools.includes(n)), "the library tools are offered, even while it is empty");
  const afterAdd = docCalls[1].messages;
  check(
    afterAdd[0].role === "system" && afterAdd.filter((m) => m.role === "system").length === 1,
    "library results ride in the one system message",
  );
  check(/### Added to the library: Nested Memories for Continual Learners/.test(afterAdd[0].content), "the paper was downloaded and read");
  check(/2 Continuum Memory System — p\. 2/.test(afterAdd[0].content), "with its outline");
  const afterSearch = docCalls[2].messages[0].content;
  check(/### Library passages for/.test(afterSearch), "the search came back");
  check(/§ 2 Continuum Memory System, p\. 2/.test(afterSearch), "pointing at the right section and page");
  check(/each with its own update frequency/.test(afterSearch), "verbatim");
  check(/### Added to the library/.test(afterSearch), "and the add is still in view on the last round");
  check(/used a library document/.test(allText()), "the transcript marks it");
  await waitFor("the reply records the paper", () =>
    stored().messages.some((m) => (m.docsUsed ?? []).includes("Nested Memories for Continual Learners")), 5000);
  const docReply = stored().messages.find((m) => (m.docsUsed ?? []).length);
  check(!!docReply, "the reply records the paper by title");
  check((docReply.sources ?? []).some((s) => /paper\.pdf$/.test(s.url)), "and lists it as a source");
  check(fs.readdirSync(`${LIBRARY}/docs`).length === 1, "the paper is on disk for later chats");

  /* the Library tab shows it */
  const libTab = byText(/^library$/);
  check(!!libTab, "there is a library tab");
  click(libTab);
  await waitFor("the library tab lists the paper", () => /Nested Memories for Continual Learners/.test(
    window.document.querySelector(".rail.right")?.textContent || ""), 8000);
  check(/4 pages · \d+ chunks · 6 sections · pdf/.test(window.document.querySelector(".rail.right").textContent), "with its size");

  /* --- 11c. a model that never stops asking still answers ------------- */
  const beforeGreedy = calls.length;
  await ask("keep looking things up GREEDYSKILL");
  const greedyCalls = calls.slice(beforeGreedy);
  check(greedyCalls.length >= 3 && greedyCalls.length <= 8, `the tool budget ends the asking (${greedyCalls.length} rounds)`);
  const lastRound = greedyCalls[greedyCalls.length - 1];
  check(!lastRound.tools?.length, "the last round offers no tools");
  check(/budget for this turn is used up/.test(JSON.stringify(lastRound.messages)), "and tells the model why");
  await waitFor("the greedy turn is saved", () => {
    const msgs = stored().messages;
    return /Noted\. The retry helper/.test(msgs[msgs.length - 1]?.content || "");
  }, 5000);
  const lastReply = stored().messages[stored().messages.length - 1];
  check(/Noted\. The retry helper/.test(lastReply.content), "the turn ends with an answer, not a preamble");

  /* --- 12. unarchive brings everything back --------------------------- */
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

  /* --- 13. a store that refuses falls back to folding, and says so ----- */
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
  console.log(`ui checks passed (${results.length})`);
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
  console.error("UI TEST FAILED:", err.message);
  process.exitCode = 1;
} finally {
  middleware.close();
  stub.close();
  search.close();
  window.close();
  process.exit(process.exitCode || 0);
}
