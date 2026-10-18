# Q38

Coder workbench for [DavidAU’s Qwen3.8-27B Turbo-Brilliance](https://huggingface.co/DavidAU/Qwen3.8-27B-Turbo-Brilliance-50X-Reasoning-Instruct-NEO-MAX-MTP-GGUF) **NEO MAX MTP** GGUF, served by `llama-server`.

The UI is built around Turbo Brilliance — 27 reasoning constructs, matching instruct variants, and the 9 combined `xhigh` modes — not a generic chat box with a model name taped on.

## What you get

- Streaming chat against llama-server’s OpenAI-compatible `/v1/chat/completions`
- Collapsible `reasoning_content` (DeepSeek-style) from Qwen 3.8 thinking
- Construct picker that injects `{REASON:coder}`, `{REASON:icoder}`, `{REASON:xlogic}`, …
- Sampling panel locked to the model card defaults (temp 0.7, top_k 64, min_p 0.05, top_p 0.95, repeat penalty off, **no prompt cache**)
- Native `reasoning_effort` (`xhigh` / medium / low / none) plus `enable_thinking`
- Workspace file tree: pin files into the turn as fenced context (read-only)
- Session history, regen, stop, syntax-highlighted code with copy/save
- **Disk memory**: older turns move to a chunk file off the window and stand in as one exact register line; a turn recalls what it needs, you can pull any chunk back by hand (`/recall 3`), and the model can ask for one itself
- **Web search the model drives itself**: `web_search` / `web_fetch` tools, capped and sourced, keyless by default
- **Skills**: procedure manuals (K-Dense's scientific-agent-skills) the model loads on demand
- **Library**: PDFs and long documents read once, chunked by section, searched by keyword and meaning, optionally OCR'd
- **Tools that actually run**: a briefing tells the model which tools it has, results go back as proper tool messages, and calls a fine-tune writes as text (or inside its thinking) are still executed — every multi-round turn carries a **turn trace**
- **Context folding**: the fallback when the store is out of reach, one handoff brief instead of the old turns
- **Reply continuation**: a reply cut off by `max_tokens` resumes itself, mid-code-block included
- **Job console**: a punched-card readout for the slow parts — model loading, prompt reading, and weights paging back in after idle
- KaTeX for LaTeX: `$$...$$`, `$...$`, `\[...\]`, `\(...\)`, and `align`/`equation` environments — the model is told so in every prompt, and asked to write formulas (including ones quoted from a document) as LaTeX rather than Unicode in backticks; code spans are never formatted or read as maths
- Same-origin proxy so the browser never talks to `localhost` and CORS is not your problem
- Offline demo stream if llama-server is down, so the workbench still exercises

## MAX + llama-server

Use a **NEO MAX MTP** quant. MAX keeps the output tensor at BF16 and MTP tensors at Q8; that is what this UI assumes.

```bash
llama-server \
  -m Qwen3.8-27B-Turbo-Brilliance-50X-RI-NEO-MAX-MTP-Q6_K.gguf \
  --alias q38-max \
  --host 0.0.0.0 --port 8080 \
  -c 65536 -ngl 99 -fa on --jinja \
  --reasoning-format deepseek \
  --temp 0.7 --top-k 64 --min-p 0.05 --top-p 0.95 \
  --repeat-penalty 1.0 \
  --spec-type draft-mtp --spec-draft-n-max 3
```

For smaller cards, using the turboquant fork (its `turbo4`/`turbo3` KV-cache types are not in mainline llama.cpp), you can fit this in 6GB of VRAM and 32GB of RAM, but expect
very slow response times.

```bash
llama-server \
  -m Qwen3.8-27B-Turbo-Brilliance-50X-RI-NEO-MAX-MTP-Q4_K_M.gguf \
  --alias q38-max \
  --host 0.0.0.0 --port 8080 \
  -c 65536 \
  --cache-type-k turbo4 --cache-type-v turbo3 \
  -fa on --jinja -ngl 6 --reasoning-format deepseek \
  --temp 0.7 --top-k 64 --min-p 0.05 --top-p 0.95 --repeat-penalty 1.0 \
  --spec-type draft-mtp --spec-draft-n-max 3 --no-cache-prompt \
  -lm none --fit off
```

Notes from the model card:

- Context **24k minimum**, **64k+** for real coding sessions (model max ~256k)
- Higher quant → better construct fidelity. MAX > non-MAX. MTP is free speed if your llama.cpp build supports `--spec-type draft-mtp`
- **New chat** when you change construct; the workbench warns you
- Help: `{REASON:help}` / `{REASON:ihelp}` / `{REASON:xhelp}`

If your llama.cpp is older and rejects `--spec-type`, drop that flag. The GGUF still runs; you just lose the built-in draft head.

### Tools on the server side

The workbench's tools — the archive `recall`, `web_search` / `web_fetch`, `skill_load` / `skill_search`, and `doc_add` / `doc_search` / `doc_read` — are **client-side**: the workbench sends an OpenAI `tools` array, the model asks for one, and the workbench does the work. llama-server only has to parse the model's tool call, and that is what `--jinja` is for:

- **`--jinja`** — use the chat template inside the GGUF, which is what knows the model's tool-call delimiters. It is in the launch line above. Recent builds default it on (`--no-jinja` turns it off); older ones need it spelled out. Without it, llama-server ignores the `tools` array and the model describes the call in prose instead of making one.
- **A tool-aware template is required, not just the flag.** Check `http://127.0.0.1:8080/props` — the model should report `chat_template_tool_use`; the **Server** tab warns when the loaded template never mentions tools, and lists the tools sent on the last turn. Keep the template that ships in the Turbo-Brilliance GGUF: it is heavily customised (it is what implements the `{REASON:…}` constructs), so swapping in the stock Qwen 3.8 template or `chatml` loses the constructs. Its tool support is Qwen's `<tool_call><function=…>` form.
- **`--tools` / `--agent` are a different thing and you do not want them here.** Those enable *llama-server's own* built-in tools (`read_file`, `write_file`, `grep_search`, `exec_shell_command`, …) for its web UI. They are not needed for the workbench's tools, they expose file and shell access over the API, and llama.cpp's own README says not to enable them in an untrusted environment.
- The workbench does not ask for `parallel_tool_calls`; if a round still carries several calls, they are run one after another.

**How a tool turn goes over the wire.** Everything the workbench adds — system prompt, a one-line note on how replies are rendered, tool briefing, memory register, skills — is merged into **one** leading system message, because Qwen-family templates refuse a second one (`System message must be at the beginning`). After a round that called tools, the next request carries the assistant message with its `tool_calls` *and its `reasoning_content`* (the template renders it back inside `<think>`, so the model sees what it was planning), then one `role: "tool"` message per call. If the model writes the call as plain text instead of a structured call — this fine-tune often writes Qwen's XML form in its reply, or at the very end of its thinking — the workbench parses it, maps guessed parameter names (`doc_id` → `doc`, `q` → `query`, …) onto the declared ones, runs it, and hides the markup from the reply. A round after the results that says nothing gets one nudge; a turn that keeps calling tools is stopped at 6 round trips and given a final round without tools, so it always answers. Each tool has its own per-turn cap (below); a call over its cap is answered "not run" rather than ignored. When a turn took more than one round, the reply carries a collapsible **turn trace**: each round's finish reason, the calls it made (and whether they were written as text), text and thinking sizes, tokens, and any nudge.

## Run the workbench

```bash
cp .env.example .env   # optional
npm install
npm run dev
```

Vite binds `0.0.0.0:5173`. Long generations (slow GPU, big `xhigh` traces) are streamed with **no idle timeout** — stop with the UI button or Escape. The bundled middleware exposes:

| Route | Role |
| --- | --- |
| `/api/llama/*` | reverse proxy to llama-server |
| `/api/status` | `/health` + `/v1/models` + `/props` |
| `/api/workspace/tree` | file tree for `WORKSPACE_DIR` (default `./workspace`) |
| `/api/workspace/file` | read a text file for context pinning |
| `/api/workspace/upload` | write a dropped file into `WORKSPACE_DIR` |
| `/api/demo/chat` | SSE demo if the model is offline |
| `/api/memory/list` `/chunk` `/put` `/forget` | the disk store behind memory (below) |
| `/api/web/search` | a web search through the configured provider |
| `/api/web/fetch` | open one public page and return its text |
| `/api/skills/index` `/search` `/read` | the skills folder (below) |
| `/api/library/list` `/add` `/upload` `/search` `/read` `/remove` `/embed` `/jobs` `/reocr` `/ocr` | the document library (below) |

Point **Setup → llama-server URL** at your server (default `http://127.0.0.1:8080`). The proxy reads `X-Llama-Upstream` per request.

**Dropping a file.** Drop it anywhere in the window — the whole window is the target,
not just the dashed box, and the file never reaches the browser (which would navigate
away). If drag and drop does not reach the page at all (some remote/VDI setups, or a
frame that swallows the drag), the box's **or browse…** picker takes the same path. Each drop does two things: the file is written into `WORKSPACE_DIR` so it appears
in the tree, and — up to 800 KB, the same limit the context reader uses — it is pinned
to the next turn. The banner afterwards names every file and what became of it; a name
that is already taken comes back as `config-2.json` rather than overwriting the original.
Files over 8 MB are refused with a reason, never silently dropped. If the workbench
API cannot be reached at all (the dev server was stopped, say), the file is pinned to
the turn and the chip says **not in workspace** — the pin is real, the save is not, and
the workspace tree says *Workspace unavailable* rather than pretending the folder is
empty.

```bash
npm run build
npm start          # serves dist/ AND the /api proxy  (port 4173)
```

`npm run preview` also includes the proxy. **Do not** use `npx serve dist`, `dotnet serve`, or any other static file host: `/api/status` then becomes `index.html` (often a 304) and the UI cannot reach llama-server.

If you already built, from the repo root:

```bash
npm start
```

Then open the URL it prints — not the old `serve` port.

### Where your chats and settings live

On the **server's disk**, not in the browser: `<state>/ui` (`~/.local/share/q38/ui`,
`%APPDATA%\q38\ui`, or `$Q38_STATE_DIR/ui`) — `settings.json`, `sampling.json`,
`index.json` (chat order, active chat) and one `sessions/<id>.json` per conversation.

Every write is power-cut safe: written to a temp file, fsynced, renamed over the old
file, and the directory fsynced. A file is always either the old complete version or
the new one. Saves go out at most every ~1 s while you type or a reply streams, and
**the moment a reply ends** it is pushed and fsynced at once; the header pill reads
**saved** once the server confirms it. Leaving or hiding the tab flushes too, and
closing with something unsaved asks first.

`localStorage` is only a mirror now: what the app opens from when the server can't
be reached (a **browser only** banner says so), and, the first time a server's store
is empty, what gets imported into it. Two tabs on the same chat can't silently erase
each other: the stale one gets a banner with **reload** / **keep this tab**.

Files are created `0600` (settings hold API keys). An unreadable file is set aside as
`*.corrupt-<time>` rather than deleted. On macOS, fsync flushes to the drive but not
through the drive's own cache (that needs `F_FULLFSYNC`, which Node does not expose);
on Linux it reaches stable storage.

## Web search

The model can look things up while it answers. Two tools, offered on every turn while
*let the model search the web and read pages* is on (Setup or the Server tab):

| Tool | What it does |
| --- | --- |
| `web_search(query, count?)` | returns titles, addresses and snippets — not the pages themselves |
| `web_fetch(url)` | opens one public page and returns its text, scripts and markup stripped |

A turn that asks for a search gets its results back in the prompt and keeps generating;
if a snippet is not enough the model can open the page and read it. Both are capped —
4 searches and 4 page reads per turn, inside the turn's 6 round trips — and both are visible.
A PDF link is refused with a pointer to `doc_add`, which puts it in the library instead.

**While it is out**, a strip above the composer says what is happening — *searching the
web for "retry timeout helpers" · waiting on the network* — and the job console tape
carries the live line (`WEB: SEARCHING "…"…`). The model has already stopped talking at
that point, and a search is a blink on a fast line and several seconds on a slow one, so
without it the turn reads as stalled exactly while it is working hardest.

**Afterwards** the reply keeps the record: a `searched ×1` / `read 1 page` badge, a
`read this turn` list of the pages it actually opened (linked, in a new tab), and a tape
line on the console (`WEB: SEARCH "retry timeout helpers" · 2 HITS · SEARX`).

**The providers.** Setup → **provider**:

| Provider | Key | Notes |
| --- | --- | --- |
| `duckduckgo` | none | the HTML endpoint; it is free because it is not an API, so it can rate-limit or change its markup |
| `searx` | none | your own instance; it must allow JSON output (`format: [html, json]` in its `settings.yml`), or it answers 403 with that hint |
| `brave` | Brave Search API | `api.search.brave.com`, 2 000 free queries a month |
| `tavily` | Tavily API | built for this; a few hundred free calls a month |

`auto` uses a SearXNG URL if one is set, else an API key, else DuckDuckGo. The same
values can come from the environment (`Q38_SEARCH_PROVIDER`, `Q38_SEARCH_KEY`,
`Q38_SEARX_URL`) for a headless start. A search that fails is not a broken turn: the
model is told what went wrong and answers from what it has — the console says
`WEB: SEARCH "…" · FAILED · DUCKDUCKGO REFUSED 429`, and the banner names the fix.

**What it will not do.** Only `http` and `https`, only text pages, only public
addresses: `localhost`, `10.x`, `192.168.x`, `169.254.169.254` and anything that
*resolves* into those ranges is refused before a socket opens, redirects are re-checked
at each hop, and a page is read with a byte cap and a 15 s timeout. So the model cannot
use the tool to read your files, your router, or your cloud metadata — that is what the
workspace tree is for. Page text enters the prompt quoted and labelled as information
rather than instruction, because a page is not a person. Set `Q38_WEB_ALLOW_PRIVATE=1`
if you really do want it reading your intranet.

Settings live in Setup: provider, SearXNG URL, API key, results per search (1–8),
characters per page (1 000–16 000).

## Skills

The model can consult **skills** — procedure manuals in the [Agent Skills](https://agentskills.io/)
layout: a folder with a `SKILL.md` (frontmatter `name` + `description`, then the
method) and often `references/` and `scripts/` beside it. Q38 reads them from
`./skills` (or `Q38_SKILLS_DIR`) and fills that folder from K-Dense's
[scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills):

```bash
npm run skills:sync                  # the curated set (22 skills, ~4 MB)
npm run skills:sync -- --add pysam   # …plus more
npm run skills:sync -- sympy qutip   # exactly these
npm run skills:sync -- --all         # the whole library (~177)
npm run skills:sync -- --list        # what exists upstream
```

The curated set is physics and maths (`sympy`, `astropy`, `qutip`, `qiskit`,
`pennylane`, `fluidsim`, `uncertainty-and-units`), statistics (`statistical-analysis`,
`statsmodels`, `pymc`, `experimental-design`), ML (`transformers`, `pytorch-lightning`,
`torch-geometric`), figures (`matplotlib`, `scientific-visualization`) and research
method (`paper-lookup`, `scientific-critical-thinking`, `hypothesis-generation`,
`scientific-brainstorming`, `peer-review`, `scientific-writing`) — nothing that needs an
API key. `skills/` is git-ignored; the sync writes `skills/.source.json` with the
upstream commit, and a re-sync removes only the skills it installed, never your own
folders.

Turn them on in the Server tab (*let the model consult skills*).

**How the model sees them.** Up to 40 skills are listed inside a single `skill_load`
tool — one line each, names as an enum — about 1k tokens for the curated set. Past 40
the list would cost too much, so the model gets `skill_search` instead and finds names
by asking. `skill_load` returns the `SKILL.md` body (24k characters by default,
Setup → *characters per skill file*) plus the list of files beside it, which the
model can open with `file=references/…`. A turn may load 4 skill files and run 3
skill searches; the reply carries a `skill · qutip` badge for each one read.

**What it will not do.** Q38 has no code execution, so a skill is text: the model is
told it cannot run a skill's scripts and must show code rather than claim results.
Reads stay inside the skill's own folder and only text files are served. Skill text
is third-party reference material and is labelled as such in the prompt.
`paper-lookup` works well with `web_fetch`: its endpoints (OpenAlex, Crossref, arXiv)
are public JSON and Atom APIs the page reader accepts.

## Library

Papers and long documents do not fit through `web_fetch` — a PDF is refused outright, and a
page read is a few thousand characters. So they go into the **library** instead: read once,
cut into section-labelled chunks, kept on disk, and searched by the model in any later chat.

```
doc_add(url)                      download + index a PDF, HTML page, Markdown or text
doc_search(query, doc?)           the passages that best answer it, with section and page
doc_read(doc, section? | chunk?)  the outline, a whole section ("8.3", "Continuum Memory"), or read on
```

The model gets all three while the library is on (the switch in the Library tab), with the
documents it holds listed in `doc_search` (the 30 most recent, when there are more). A turn may
add 2 documents, run 4 searches and make 4 reads; a read returns up to 12k characters
(Setup → *characters per document read*). A typical turn: *"what does the Nested Learning paper say about CMS?"*
→ `doc_add("https://arxiv.org/abs/2512.24695")` → `doc_search("continuum memory system update
frequency")` → an answer quoting §7.1, p. 27. arXiv abstract links and OpenReview forums are
fetched as their PDFs. Replies carry a `doc · <title>` badge and list the paper as a source.

You can also add documents yourself — the Library tab takes a URL or uploaded files — or drop
files into `<library>/inbox`; they are read in on the next refresh (anything unreadable is
moved to `inbox/failed` with the reason beside it).

**What happens to a PDF.** `pdf.js` pulls out the text layer page by page. The body font is
whatever most characters are set in; a line is a section heading when it is numbered
(`3.1 Associative Memory`, `B Proofs`) or a known name (`Abstract`, `References`), or set
larger than the body — unless it is display maths, the arXiv side stamp or a run-in heading.
Running heads, page numbers and end-of-line hyphens are cleaned up. Chunks are ~1.4k
characters, cut at sentence ends, and never straddle two sections. The Nested Learning paper
(52 pages) reads in about a second into 171 chunks with the paper's own 39-section outline.
Limits: 50 MB per document; from the text layer, **equations and tables come through
garbled** — the prose and structure are faithful, the maths is not. Scans and maths-heavy
papers are what OCR (below) is for.

**OCR (scans, and papers whose maths matters).** Point Setup → *Library & skills* →
*OCR server* (or `Q38_OCR_URL`) at an OpenAI-compatible vision endpoint serving an OCR model. Each page is
rendered by pdf.js and sent as an image with an instruction; how depends on the **OCR
profile**, which by default is picked from the model name the server reports:

| Profile | Instruction | Page size | Output | Notes |
| --- | --- | --- | --- | --- |
| **OvisOCR2** | its own whole-page instruction (verbatim from the model card) | ~4 MP (up to 2880²) | 16k tokens, LaTeX formulas, HTML tables | thinking off; figure placeholders dropped; best formula scores of the small models, and it reads whole pages end to end — the way Q38 sends them |
| **PaddleOCR-VL** | `OCR:` | ~1 MP (its ceiling) | 4k tokens | strong on text in many languages; its formula strength needs Paddle's own layout pipeline, which Q38 does not run |
| **Custom** | yours | yours | yours | for any other model |

Setup → *OCR profile* picks one by hand (*auto* is the default); *Custom* adds a prompt, a
token budget and a page size in megapixels, where 0 keeps the default.

```bash
vllm serve ATH-MaaS/OvisOCR2                                   # or:
vllm serve PaddlePaddle/PaddleOCR-VL --trust-remote-code \
  --max-num-batched-tokens 16384 --no-enable-prefix-caching --mm-processor-cache-gb 0
```

The Library tab shows what was detected (*OvisOCR2 — detected from ATH-MaaS/OvisOCR2 · 4.0 MP
pages · up to 16k tokens a page*). A long page that ends in a runaway repeated fragment is
cut back to one copy, and a vLLM build that refuses a profile's extra request fields gets the
page again without them. Then:

- a PDF with **no usable text layer** is read with OCR automatically instead of being refused;
- any stored PDF can be **re-read with OCR** from the Library tab — same id, new text,
  outline and vectors — which is the fix for papers whose equations the text layer mangles:
  OCR keeps them as LaTeX (`\theta_{t+1} = \theta_t - \eta g_t`) and tables as rows;
- the model's `doc_add` gains `ocr=true` for the same thing, described to it as slow.

OCR takes seconds per page instead of a second per paper, so the Library tab and the live
strip show *OCR page 12/52* while it runs. A page that fails twice is skipped and named in
the note; more than a quarter failing fails the read and leaves the document as it was.
The environment can set the same things for a headless start: `Q38_OCR_PROFILE`
(`auto`, `ovisocr2`, `paddleocr-vl`, `custom`), `Q38_OCR_PROMPT`, `Q38_OCR_MAX_TOKENS`,
`Q38_OCR_PIXELS`, `Q38_OCR_MODEL`, and `Q38_OCR_API_KEY` if the server wants a bearer token. The OCR server may be on your own network — it is a
configured endpoint, like llama-server, not something the model chose to fetch. Page
rendering uses `@napi-rs/canvas`, which pdf.js installs with it.

**Search.** Keyword ranking (BM25) always — exact terms matter in technical writing and it
needs nothing running. Add an embeddings server and search also matches by meaning, the two
rankings fused by reciprocal rank:

```bash
# a second llama-server, next to the chat model (~1 GB)
llama-server -m Qwen3-Embedding-0.6B-Q8_0.gguf --embedding --pooling last -ub 2048 -b 2048 --port 8081
```

Then Setup → *Library & skills* → *embeddings server* = `http://127.0.0.1:8081` (or
`Q38_EMBED_URL`, with `Q38_EMBED_API_KEY` if it needs a token). New
documents are embedded on add; the Library tab offers to embed those added before. Query
framing is picked from the model's id (Qwen3-Embedding's instruction, nomic's
`search_query:`, e5's `query:`, bge's). If the server is down, search says so and falls back
to keywords. There is no vector database: vectors are Float32 files beside each document and a
brute-force scan over a personal library takes milliseconds.

**Where it lives.** `<state>/library` (`~/.local/share/q38/library`, `%APPDATA%\q38\library`)
or `Q38_LIBRARY_DIR`: `docs/<id>/` holds the original file, `chunks.json`, `meta.json` and
`vectors.f32`. Downloads go through the same public-address guard as `web_fetch`.

## Tests

```bash
npm test             # everything
npm run test:unit    # pure logic: memory rules, web, skill and library tool text, the tool briefing, text tool calls, markdown  (no DOM, no network)
npm run test:server  # the store, web, skill and library routes over real HTTP against stubs and fixtures
npm run test:ui      # the whole workbench in jsdom, against a stub model
```

- `tests/store-routes.mjs` — the state store on disk: durable writes leave no temp
  files, revisions, a late same-tab write never overwrites a newer reply, a stale tab
  gets a conflict, deletes, path safety, corrupt and torn files.
- `tests/storage.test.ts` — the client half: import from the browser on first run, a
  finished reply flushed at once, and after a simulated power cut the page reloads the
  latest chat and settings from the server, not the browser's stale copy.
- `tests/memory.test.ts` — which tokens count as terms (and that the injected
  `{REASON:coder}` tag never does), what a register line says, when a turn has earned
  a recall.
- `tests/web.test.ts` — the tool schemas the model is offered, argument parsing,
  and the exact text a search result, a page and a failure turn into.
- `tests/web-routes.mjs` — the server half over real HTTP: DuckDuckGo and SearXNG
  markup parsed from fixtures, a search round trip against a stub SearXNG, the
  private-address guard (both sides of it), redirect following and loops, content-type
  refusals, byte and character caps.
- `tests/skills.test.ts` — the skill tools on offer (inline catalogue vs. search),
  and the text a skill, a search and a miss turn into.
- `tests/skills-routes.mjs` — frontmatter parsing, indexing a fixture folder,
  search ranking, reading reference files, refusing paths out of a skill and binary
  files, typo suggestions, and the three routes over HTTP.
- `tests/library.test.ts` — the library tools on offer (and `ocr=true` only with an OCR
  server) and the text an add, a search, a section read and each kind of miss turn into.
- `tests/toolbrief.test.ts` — the briefing at the top of the system message: written only
  from the tools actually offered, and never promising one that is not there.
- `tests/textcalls.test.ts` — tool calls written as text: Qwen's XML form and the Hermes
  JSON form read back into calls, guessed parameter names mapped to declared ones, values
  coerced, calls inside code fences left alone, markup stripped from the reply, and calls
  at the very end of the thinking accepted while mid-thought ones are not.
- `tests/markdown.test.ts` — inline markdown: nothing inside a code span is formatted (an
  asterisk in `` `M*` `` cannot italicise the rest of the line), escaping, links, spaced
  asterisks as multiplication; and maths is found outside code spans only.
- `tests/library-routes.mjs` — PDF extraction on generated PDFs (`tests/pdf-fixture.mjs`):
  the outline, running heads, hyphens, maths that is not a heading; chunking; BM25 search,
  section reads by the paper's own numbers, budgets and continuation; dedupe, the inbox,
  removal; hybrid search against a stub embeddings server and the fallback when it is down;
  arXiv/OpenReview links; every route, including the download guard and size limit; and OCR
  against stub vLLM servers — scans read automatically, `ocr=true`, re-reading in place,
  progress, the request's shape and image size, a failing page, a dead server; the OvisOCR2
  profile picked from the model id (its instruction, thinking off, 16k tokens, ~4 MP pages),
  Polish and LaTeX intact, placeholders and runaway tails cleaned, a server that refuses the
  extra fields, and a Custom profile's own prompt, budget and resolution.
- `tests/ui.mjs` — the whole app in jsdom against `server/api.mjs`, a stub
  llama-server and a stub SearXNG: a full window archives instead of summarising, the
  register (not the bodies) goes out in the prompt, a turn recalls what it needs and an
  unrelated one does not, the model's `recall` tool round-trips, `/recall 3` pins a
  chunk, the model searches and then opens a page and the reply carries its sources, a
  private address is refused on demand, the model loads a skill and it comes back in
  the one system message, the model adds a paper, searches it and the reply cites it, a
  call written as text in the reply or inside the thinking is still run, a silent round
  after the results gets one nudge, a model that never stops calling tools is cut off and
  still answers, unarchive brings every message back, and a store that refuses falls back
  to folding.

Scratch output lands in `tests/.bundle` and `tests/.tmp`, both ignored.

## Context: budget, memory, continuation

MAX MTP burns context quickly — 64k is a real session, not a lot of one. The
workbench measures the window, folds the older turns into a brief, and resumes a
reply that was cut off mid-code.

**Budget.** `n_ctx` comes from llama-server `/props`, or from `context window` in
Setup when you set it (0 = auto). The pill in the top bar and the **Context** tab
show prompt tokens against `n_ctx − max_tokens − margin`, split into system prompt,
briefs and transcript. Estimates assume ~3.6 chars/token; **measure exact** runs the
live prompt through llama-server's `/tokenize`.

**Memory: old turns go to disk, not through a summariser.** Past the fold line
(**fold at**, default 72% of the usable window) the oldest turns are written to a
chunk file under the OS data dir and their place in the prompt is taken by **one
register line** — exact, not a paraphrase:

```
#3 · "wire the retry loop into src/lib/api.ts" · src/lib/api.ts src/lib/retry.ts · 6 msg · 2.1k tok
```

Nothing is deleted from the transcript and nothing is rewritten, so a chunk can
always come back word for word. It comes back three ways:

- **On its own.** Before each send the turn is matched against the chunks' own
  terms (paths, symbols, quoted strings, words) and the closest one or two are
  read back verbatim. A path, a symbol or a number is evidence on its own; one
  ordinary word is not. The decision is made once per send, so the prompt prefix
  stays stable within the turn (which is what lets llama-server's prompt cache help,
  if you turn it back on in the Sample tab).
- **By hand.** The memory card in the transcript and the **Memory** panel in the
  Context tab list every chunk with **pull back** (it stays in the window until
  you **let go**), **forget** (delete it from the disk) and **unarchive
  everything**. `/recall 3` does the same from the composer, without a model call.
- **By the model.** While something is on disk, turns offer a `recall` tool: the
  model names a register number or describes what it needs and the chunk comes
  back verbatim, then the turn is sent again with it in the prompt. Capped at two
  hops per turn, and visible — transcript, banner and the console tape
  (`MEMORY: RECALL #3 · 2.1k TOK`). Toggle it in Setup.

Recall has a budget: 12% of the usable window, plus whatever room is free right
now, capped at half the window — so it can never crowd out the work in front of
it. Everything recalled is announced; nothing is guessed.

**Folding is now the fallback.** If the store cannot be reached (no `/api` proxy,
a read-only data dir), the workbench says so and folds instead: the older turns
are rewritten into a single handoff brief and sent as a system turn. A fold can be
**unfolded** from the transcript card or the Context tab, which puts the original
messages back into the window.

The store is plain files — `sessions/<id>/chunks.ndjson`, one chunk per line —
under `%APPDATA%\q38` on Windows, `$XDG_DATA_HOME/q38` (else
`~/.local/share/q38`) elsewhere, or `Q38_STATE_DIR` if you set it. Deleting it
loses nothing that is not still in the transcript.

**Continuation.** When a round stops on `finish_reason: "length"` the reply resumes
itself, up to **continue rounds** times (default 2, 0 = manual only). A reply that *stopped short* — `finish_reason: "length"`, or text that ends inside an open
code block — is offered **continue this reply** / **finish the code block** directly under
it, and only then: a reply that finished cleanly gets no resume button at all. The cut-off
text is sent back as a trailing assistant message
with `continue_final_message` + `add_generation_prompt: false`, which llama-server
resumes exactly where it stopped; a server that refuses it falls back to a resume
directive. The resumed text is stitched into the same message with overlap trimming
and code-fence repair, so a half-written ```ts block stays one code block.

| Setting (Setup / Context tab) | Default | Effect |
| --- | --- | --- |
| `context window` | 0 (auto) | overrides the `n_ctx` read from `/props` |
| `fold at` | 0.72 | fraction of the usable window that triggers a fold |
| `keep verbatim` | 8 | messages below the fold that stay untouched |
| `brief size` | 1600 | token cap handed to the summariser |
| `recall tool` | on | let the model read a chunk back mid-reply |
| `auto-continue` | on | resume truncated replies without asking |
| `continue rounds` | 2 | automatic resumptions per reply |
| `continue mode` | auto | `prefill` (trailing assistant message) → `directive` fallback |

In offline demo mode the archive still runs on the real store, and folding falls
back to the local extract; the demo stream answers a continuation with more code. With llama-server
down, a turn streams from the demo stream (badged `demo`) instead of failing with a
transport error — a refused connection is a reason to fall back, not to lose the turn.

## Slow turns: the job console

On a small GPU the model is often not wrong so much as *elsewhere*: llama-server
holds the request for a minute while the weights come back in, then decodes at a
fraction of speed until the cache warms again. A bare caret there reads as a hang.
The workbench reads the machine's own signals and shows the job as a punched-card
run instead.

**What it keys off.** Three real signals, no guessing:

| Signal | Source | Shown as |
| --- | --- | --- |
| `503 {"error":{"message":"Loading model"}}` | every llama-server route while loading | `MODEL LOADING INTO CORE — JOB nnnn QUEUED` |
| `prompt_progress {total, cache, processed, time_ms}` | streamed once per prefill chunk (`return_progress: true`) | `CARDS READ n / n` with a punched card deck |
| `timings.predicted_per_second` vs. a warm baseline | the stream itself | `DECODING 3.2 TOK/S · WARM BASELINE 42 TOK/S` |

A turn that has produced no token for 4 s, or is decoding below 45% of the baseline
the workbench measured while the machine was warm, is labelled **paging**:
`PAGING FROM DRUM — EXPECT DELAY`. The baseline is a slow-rise EMA kept in
`localStorage`, and it only counts rounds that actually decoded — a slow round can
never teach the workbench that slow is normal. No progress bar is ever advanced by a
timer.

**What you see.** A line printer console takes the place of the pending reply: job
number, a state lamp, a wall clock, the card deck feeding the read head, six register
figures (cards, columns punched, prefill %, read rate, ETA, cache hits), a spooling
line of tape, and a `cancel job` handle. Once the first token lands the long form
folds away and a compact strip takes over above the composer while the job keeps
crawling; the top bar carries a small pip so a job is never invisible, even scrolled
away. Everything is monospace and paper-white on carbon — the same palette as the
rest of the bench.

**Control.** Setup → *Machine pacing*:

| Setting | Default | Effect |
| --- | --- | --- |
| `punched-card job console` | on | off = one minimal pulse, same signals |
| `cold start` | 120 s | idle time after which a send counts as a cold start |
| `paging factor` | 0.45 | decode rate vs. warm baseline that reads as paging |

The console also runs in offline demo mode (`DEMO_SLOW_TPS=2 npm run dev` pretends to
be a cold machine), so the animation can be judged without a loaded GPU.

## Constructs (primer)

Prefix is always `{REASON:…}` at the start of the user turn.

| Family | Example | Effect |
| --- | --- | --- |
| Reason | `{REASON:coder}` | Thinking + construct |
| Instruct | `{REASON:icoder}` | Instant answer, same construct (`i` prefix) |
| Combined xhigh | `{REASON:xlogic}` | Native xhigh + construct (subset: omni, deeptree, hyper, socrates, logic, einstein, spoon, help) |
| Off | `{REASON:off}` | Vanilla Qwen 3.8 |

Default construct for this UI is **coder**. Switch family with the Reason / Instruct / xhigh pills. Do not change construct mid-thread if you can avoid it.

## Keyboard

- `⌘/Ctrl + Enter` send
- `Escape` stop
- `⌘/Ctrl + N` new chat
- `⌘/Ctrl + ,` setup

Slash commands: `/recall 3` reads chunk #3 back off the disk and keeps it in the
window (same as **pull back** on the memory card); with no number it lists what is
on disk.

Buttons: **fold** in the stage head, **fold now** + **measure exact** in the
Context tab, **continue** under a reply that stopped short and in the composer bar.
