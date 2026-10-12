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

Vite binds `0.0.0.0:5173`. The bundled middleware exposes:

| Route | Role |
| --- | --- |
| `/api/llama/*` | reverse proxy to llama-server |
| `/api/status` | `/health` + `/v1/models` + `/props` |
| `/api/workspace/tree` | file tree for `WORKSPACE_DIR` (default `./workspace`) |
| `/api/workspace/file` | read a text file for context pinning |
| `/api/demo/chat` | SSE demo if the model is offline |

Point **Setup → llama-server URL** at your server (default `http://127.0.0.1:8080`). The proxy reads `X-Llama-Upstream` per request.

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
