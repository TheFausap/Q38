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
- **Context folding**: older turns are rewritten by the model into one handoff brief before the window fills up
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

Notes from the model card:

- Context **24k minimum**, **64k+** for real coding sessions (model max ~256k)
- Higher quant → better construct fidelity. MAX > non-MAX. MTP is free speed if your llama.cpp build supports `--spec-type draft-mtp`
- **New chat** when you change construct; the workbench warns you
- Help: `{REASON:help}` / `{REASON:ihelp}` / `{REASON:xhelp}`

If your llama.cpp is older and rejects `--spec-type`, drop that flag. The GGUF still runs; you just lose the built-in draft head.

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

## Context: budget, folding, continuation

MAX MTP burns context quickly — 64k is a real session, not a lot of one. The
workbench measures the window, folds the older turns into a brief, and resumes a
reply that was cut off mid-code.

**Budget.** `n_ctx` comes from llama-server `/props`, or from `context window` in
Setup when you set it (0 = auto). The pill in the top bar and the **Context** tab
show prompt tokens against `n_ctx − max_tokens − margin`, split into system prompt,
briefs and transcript. Estimates assume ~3.6 chars/token; **measure exact** runs the
live prompt through llama-server's `/tokenize`.

**Folding.** Past the fold line (**fold at**, default 72% of the usable window) the
older turns are rewritten into a single handoff brief — goal, stack, files in play,
decisions, state of the work, open threads, snippets that must survive — and sent as
a system turn ahead of the messages kept verbatim (**keep verbatim**, default 8).
Folding is skipped when it would not pay for itself (the brief costs more than the
messages it replaces), and falls back to a mechanical local extract when
llama-server is unreachable. Nothing is deleted: the fold card in the transcript
(and every entry in the Context tab) can be **unfolded**, which puts the original
messages back into the window.

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
| `auto-continue` | on | resume truncated replies without asking |
| `continue rounds` | 2 | automatic resumptions per reply |
| `continue mode` | auto | `prefill` (trailing assistant message) → `directive` fallback |

In offline demo mode both features still exercise: folding falls back to the local
extract and the demo stream answers a continuation with more code. With llama-server
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

Buttons: **fold** in the stage head, **compact/fold now** + **measure exact** in the
Context tab, **continue** under any reply and in the composer bar.
