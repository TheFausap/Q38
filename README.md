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
- **Context folding**: the fallback when the store is out of reach, one handoff brief instead of the old turns
- **Reply continuation**: a reply cut off by `max_tokens` resumes itself, mid-code-block included
- **Job console**: a punched-card readout for the slow parts — model loading, prompt reading, and weights paging back in after idle
- KaTeX for LaTeX: `$$...$$`, `$...$`, `\[...\]`, `\(...\)`, and `align`/`equation` environments
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

for smaller cards, using the turboquant fork, you can fit this in 6GB of VRAM and 32GB of RAM, but expect
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

The workbench's tools — the archive `recall`, and `web_search` / `web_fetch` — are **client-side**: the workbench sends an OpenAI `tools` array, the model asks for one, and the workbench does the work. llama-server only has to parse the model's tool call, and that is what `--jinja` is for:

- **`--jinja`** — use the chat template inside the GGUF, which is what knows the model's tool-call delimiters. It is in the launch line above. Recent builds default it on (`--no-jinja` turns it off); older ones need it spelled out. Without it, llama-server ignores the `tools` array and the model describes the call in prose instead of making one.
- **A tool-aware template is required, not just the flag.** Check `http://127.0.0.1:8080/props` — the model should report `chat_template_tool_use`. If a model's template has no tool support (some quants ship without it), point `--chat-template-file` at one that does, or fall back to `--chat-template chatml`.
- **`--tools` / `--agent` are a different thing and you do not want them here.** Those enable *llama-server's own* built-in tools (`read_file`, `write_file`, `grep_search`, `exec_shell_command`, …) for its web UI. They are not needed for the workbench's tools, they expose file and shell access over the API, and llama.cpp's own README says not to enable them in an untrusted environment.
- `parallel_tool_calls` (in the request) is off by default and only supported by some templates; the workbench asks for one call at a time, which every tool-aware model handles.

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

## Web search

The model can look things up while it answers. Two tools, offered on every turn while
**search the web** is on in Setup:

| Tool | What it does |
| --- | --- |
| `web_search(query, count?)` | returns titles, addresses and snippets — not the pages themselves |
| `web_fetch(url)` | opens one public page and returns its text, scripts and markup stripped |

A turn that asks for a search gets its results back in the prompt and keeps generating;
if a snippet is not enough the model can open the page and read it. Both are capped —
4 searches, 4 page reads, 6 round trips per turn — and both are visible.

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

## Tests

```bash
npm test             # everything
npm run test:unit    # pure logic: memory rules, web and skill tool text  (no DOM, no network)
npm run test:server  # the web and skill routes over real HTTP against stubs and fixtures
npm run test:ui      # the whole workbench in jsdom, against a stub model
```

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
- `tests/ui.mjs` — the whole app in jsdom against `server/api.mjs`, a stub
  llama-server and a stub SearXNG: a full window archives instead of summarising, the
  register (not the bodies) goes out in the prompt, a turn recalls what it needs and an
  unrelated one does not, the model's `recall` tool round-trips, `/recall 3` pins a
  chunk, the model searches and then opens a page and the reply carries its sources, a
  private address is refused on demand, the model loads a skill and it comes back in
  the one system message, a model that never stops calling tools is cut off and still
  answers, unarchive brings every message back, and a
  store that refuses falls back to folding.

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
  stays stable and llama-server's prompt cache survives the turn.
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
itself, up to **continue rounds** times (default 2, 0 = manual only). Any reply has a
A reply that *stopped short* — `finish_reason: "length"`, or text that ends inside an open
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

Buttons: **fold** in the stage head, **compact/fold now** + **measure exact** in the
Context tab, **continue** under any reply and in the composer bar.
