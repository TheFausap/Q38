import { useMemo, useState } from "react";
import {
  compactionNetSavings,
  contextSourceLabel,
  formatPct,
  formatTokens,
  type ContextUsage,
} from "../lib/context";
import { GROUPS, familyLabel, modeById, MODES, reasonTag } from "../lib/modes";
import { formatClock, formatRate, type JobTick, type PaceStats } from "../lib/pacing";
import type { ArchiveRef, Compaction, ModeFamily, Sampling, ServerStatus, Settings } from "../lib/types";
import { SKILL_INLINE_LIMIT, type SkillIndex } from "../lib/skills";
import type { LibraryDoc, LibraryJob } from "../lib/library";
import type { OcrInfo } from "../lib/api";

export type InspectorTab = "construct" | "sample" | "context" | "library" | "server";

const TABS: InspectorTab[] = ["construct", "sample", "context", "library", "server"];

export function Inspector({
  tab,
  onTab,
  modeId,
  family,
  onMode,
  onFamily,
  sampling,
  onSampling,
  settings,
  onSettings,
  status,
  preview,
  onAskHelp,
  usage,
  compactions,
  exactTokens,
  onMeasure,
  onFold,
  onUnfold,
  folding,
  streaming,
  pace,
  tick,
  archives,
  held,
  memRoot,
  memBusy,
  onPullBack,
  onRelease,
  onForget,
  onUnarchive,
  skills,
  onReloadSkills,
  libDocs,
  libRoot,
  libNotice,
  libBusy,
  onLibraryAdd,
  onLibraryUpload,
  onLibraryRemove,
  onLibraryEmbed,
  onLibraryReload,
  libJobs,
  lastTools,
  ocrInfo,
  ocrOn,
  onLibraryReocr,
}: {
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  modeId: string;
  family: ModeFamily;
  onMode: (id: string) => void;
  onFamily: (f: ModeFamily) => void;
  sampling: Sampling;
  onSampling: (s: Sampling) => void;
  settings: Settings;
  onSettings: (s: Settings) => void;
  status: ServerStatus | null;
  preview: { path: string; content: string } | null;
  onAskHelp: () => void;
  usage: ContextUsage;
  compactions: Compaction[];
  exactTokens: number | null;
  onMeasure: () => void;
  onFold: () => void;
  onUnfold: (index: number) => void;
  folding: boolean;
  streaming: boolean;
  pace: PaceStats;
  tick: JobTick | null;
  archives: ArchiveRef[];
  held: string[];
  memRoot: string;
  memBusy: string | null;
  onPullBack: (id: string) => void;
  onRelease: (id: string) => void;
  onForget: (id: string) => void;
  onUnarchive: () => void;
  skills: SkillIndex | null;
  onReloadSkills: () => void;
  libDocs: LibraryDoc[] | null;
  libRoot: string;
  libNotice: string | null;
  libBusy: string | null;
  onLibraryAdd: (url: string) => void;
  onLibraryUpload: (files: File[]) => void;
  onLibraryRemove: (id: string) => void;
  onLibraryEmbed: () => void;
  onLibraryReload: () => void;
  libJobs: LibraryJob[];
  lastTools: string[] | null;
  ocrInfo: OcrInfo | null;
  ocrOn: boolean;
  onLibraryReocr: (id: string) => void;
}) {
  const [libUrl, setLibUrl] = useState("");
  /* llama-server reports its template in /props; one with no "tools" in it drops them */
  const template = typeof status?.props?.chat_template === "string" ? (status.props.chat_template as string) : "";
  const templateLacksTools = template.length > 0 && !/\btools\b/.test(template);
  const [q, setQ] = useState("");
  const mode = modeById(modeId);
  const tag = reasonTag(family, modeId);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return MODES;
    return MODES.filter(
      (m) =>
        m.id.includes(s) ||
        m.name.toLowerCase().includes(s) ||
        m.blurb.toLowerCase().includes(s) ||
        m.bestFor.toLowerCase().includes(s),
    );
  }, [q]);

  const set = <K extends keyof Sampling>(key: K, value: Sampling[K]) =>
    onSampling({ ...sampling, [key]: value });
  const setSetting = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onSettings({ ...settings, [key]: value });

  const savedTotal = compactions.reduce((n, c) => n + Math.max(0, compactionNetSavings(c)), 0);
  const meterPct = Math.max(0, Math.min(1, usage.pct));

  return (
    <aside className="rail right">
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? "tab on" : "tab"}
            onClick={() => onTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "construct" && (
        <div className="rail-scroll">
          <div className="family-row">
            {(["reasoning", "instruct", "xhigh"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={family === f ? "pill on" : "pill"}
                onClick={() => onFamily(f)}
                disabled={f === "xhigh" && !mode.xhigh && mode.id !== "help"}
                title={
                  f === "xhigh" && !mode.xhigh && mode.id !== "help"
                    ? "No xhigh variant for this construct"
                    : familyLabel(f)
                }
              >
                {familyLabel(f)}
              </button>
            ))}
          </div>
          <div className="tag-preview">
            <code>{tag}</code>
            <label className="tiny-check">
              <input
                type="checkbox"
                checked={sampling.inject_mode_tag}
                onChange={(e) => set("inject_mode_tag", e.target.checked)}
              />
              inject
            </label>
          </div>
          <p className="mode-lead">
            <strong>{mode.id}</strong> — {mode.name}
          </p>
          <p className="muted">{mode.blurb}</p>
          <p className="best">
            <span>Use when</span> {mode.bestFor}
          </p>
          <button type="button" className="linkish" onClick={onAskHelp}>
            Ask the built-in help system
          </button>
          <input
            className="search"
            placeholder="Search constructs"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {GROUPS.map((g) => {
            const items = filtered.filter((m) => m.group === g.id);
            if (!items.length) return null;
            return (
              <div key={g.id} className="mode-group">
                <div className="group-label">{g.label}</div>
                {items.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`mode-card ${m.id === modeId ? "on" : ""}`}
                    onClick={() => onMode(m.id)}
                  >
                    <span className="mode-id">
                      {m.id}
                      {m.xhigh ? <i>x</i> : null}
                    </span>
                    <span className="mode-blurb">{m.blurb}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {tab === "sample" && (
        <div className="rail-scroll sample-form">
          <p className="hint">
            DavidAU tester defaults for MAX: temp 0.5–1, top_k 64, min_p 0.05, top_p 0.95,
            repeat penalty off, no cache, 24k+ context.
          </p>
          <Slider
            label="temperature"
            min={0}
            max={1.5}
            step={0.05}
            value={sampling.temperature}
            onChange={(v) => set("temperature", v)}
          />
          <Slider
            label="top_k"
            min={0}
            max={128}
            step={1}
            value={sampling.top_k}
            onChange={(v) => set("top_k", v)}
          />
          <Slider
            label="top_p"
            min={0}
            max={1}
            step={0.01}
            value={sampling.top_p}
            onChange={(v) => set("top_p", v)}
          />
          <Slider
            label="min_p"
            min={0}
            max={0.3}
            step={0.01}
            value={sampling.min_p}
            onChange={(v) => set("min_p", v)}
          />
          <Slider
            label="repeat_penalty"
            min={1}
            max={1.5}
            step={0.01}
            value={sampling.repeat_penalty}
            onChange={(v) => set("repeat_penalty", v)}
          />
          <Slider
            label="max_tokens"
            min={256}
            max={32768}
            step={256}
            value={sampling.max_tokens}
            onChange={(v) => set("max_tokens", v)}
          />
          <label className="field">
            <span>reasoning_effort</span>
            <select
              value={sampling.reasoning_effort}
              onChange={(e) =>
                set("reasoning_effort", e.target.value as Sampling["reasoning_effort"])
              }
            >
              <option value="xhigh">xhigh (Qwen 3.8 native)</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
              <option value="none">none (disable thinking)</option>
            </select>
          </label>
          <label className="tiny-check block">
            <input
              type="checkbox"
              checked={sampling.enable_thinking}
              onChange={(e) => set("enable_thinking", e.target.checked)}
            />
            chat_template_kwargs.enable_thinking
          </label>
          <label className="tiny-check block">
            <input
              type="checkbox"
              checked={!sampling.cache_prompt}
              onChange={(e) => set("cache_prompt", !e.target.checked)}
            />
            disable prompt cache (recommended)
          </label>
        </div>
      )}

      {tab === "context" && (
        <div className="rail-scroll sample-form">
          <div className="meter">
            <div className="meter-bar">
              <span className={usage.pct >= 1 ? "fill over" : "fill"} style={{ width: `${meterPct * 100}%` }} />
              <span
                className="meter-mark"
                style={{ left: `${Math.min(100, settings.compactAt * 100)}%` }}
                title={`auto-fold at ${formatPct(settings.compactAt)}`}
              />
            </div>
            <div className="meter-nums">
              <strong className={usage.pct >= settings.compactAt ? "hot-text" : ""}>
                {formatTokens(usage.used)}
              </strong>
              <span className="muted tiny">
                / {formatTokens(usage.budget.budget)} prompt tokens · {formatPct(usage.pct)} · window{" "}
                {formatTokens(usage.budget.nCtx)}
              </span>
            </div>
            <dl className="kv tight">
              <dt>budget source</dt>
              <dd>{contextSourceLabel(usage.budget.source, status?.props ?? null)}</dd>
              <dt>reply reserve</dt>
              <dd>
                {formatTokens(usage.budget.reserve)} tokens (max_tokens) + {usage.budget.margin} margin
              </dd>
              <dt>in window</dt>
              <dd>
                {usage.messages} messages
                {usage.foldedMessages > 0 ? ` · ${usage.foldedMessages} folded into briefs` : ""}
              </dd>
              <dt>composition</dt>
              <dd className="break">
                system {formatTokens(usage.systemTokens)} · briefs {formatTokens(usage.summaryTokens)} ·
                transcript {formatTokens(usage.historyTokens)}
              </dd>
              {exactTokens !== null && (
                <>
                  <dt>measured</dt>
                  <dd>{formatTokens(exactTokens)} tokens (llama-server /tokenize)</dd>
                </>
              )}
            </dl>
            {usage.pct >= 1 && (
              <p className="warn-line">
                Over budget by {formatTokens(usage.over)} tokens — the server will start dropping the
                oldest context. Fold, or start a new chat.
              </p>
            )}
            {usage.pct >= settings.compactAt && usage.pct < 1 && settings.autoCompact && (
              <p className="muted tiny">
                Past the fold line — the next send folds the older turns automatically.
              </p>
            )}
          </div>

          <div className="row-actions">
            <button type="button" className="btn" onClick={onFold} disabled={folding || streaming}>
              {folding ? "folding…" : "fold now"}
            </button>
            <button type="button" className="btn" onClick={onMeasure}>
              measure exact
            </button>
          </div>

          <label className="tiny-check block">
            <input
              type="checkbox"
              checked={settings.autoCompact}
              onChange={(e) => setSetting("autoCompact", e.target.checked)}
            />
            fold automatically when the window fills up
          </label>
          <Slider
            label="fold at"
            min={0.4}
            max={0.95}
            step={0.01}
            value={settings.compactAt}
            onChange={(v) => setSetting("compactAt", v)}
            suffix=" of window"
          />
          <Slider
            label="keep verbatim"
            min={2}
            max={40}
            step={1}
            value={settings.keepTailMessages}
            onChange={(v) => setSetting("keepTailMessages", v)}
            suffix=" messages"
          />
          <Slider
            label="brief size"
            min={512}
            max={4096}
            step={128}
            value={settings.summaryMaxTokens}
            onChange={(v) => setSetting("summaryMaxTokens", v)}
            suffix=" tokens"
          />
          <label className="field">
            <span>context window (0 = /props n_ctx)</span>
            <input
              type="number"
              min={0}
              step={1024}
              value={settings.contextSize}
              onChange={(e) =>
                setSetting("contextSize", Math.max(0, Number(e.target.value) || 0))
              }
              placeholder="0"
            />
          </label>

          <p className="hint">
            Folding asks the model to rewrite the older turns into one handoff brief — goal, files,
            decisions, open threads, snippets that must survive — then keeps only the last{" "}
            {settings.keepTailMessages} messages verbatim. If llama-server is offline the brief is a
            local extract instead.
          </p>

          <div className="row-actions">
            <label className="tiny-check">
              <input
                type="checkbox"
                checked={settings.autoContinue}
                onChange={(e) => setSetting("autoContinue", e.target.checked)}
              />
              auto-continue truncated replies
            </label>
          </div>
          <Slider
            label="continue rounds"
            min={0}
            max={6}
            step={1}
            value={settings.maxContinues}
            onChange={(v) => setSetting("maxContinues", v)}
            suffix=" auto"
          />
          <label className="field">
            <span>continue mode</span>
            <select
              value={settings.continueMode}
              onChange={(e) => setSetting("continueMode", e.target.value as Settings["continueMode"])}
            >
              <option value="auto">auto — prefill, then directive fallback</option>
              <option value="prefill">prefill only (assistant message)</option>
              <option value="directive">directive only (extra prompt turn)</option>
            </select>
          </label>
          <p className="hint">
            Prefill hands the cut-off text back as a trailing assistant message
            (<code>continue_final_message</code>); llama-server resumes it without repeating. A
            server that refuses falls back to a resume directive.
          </p>

          <div className="group-label">Memory ({archives.length} on disk)</div>
          <p className="hint">
            When the window fills, the oldest turns are moved to disk as chunks and stand in as one
            register line each — exact, not paraphrased. A turn recalls what it needs on its own; you
            can pull a chunk back by hand here, and it stays until you let it go. Folding below is
            what happens when the store cannot be reached.
          </p>
          {archives.length === 0 && (
            <p className="muted pad">
              Nothing on disk{memRoot ? <> — the store lives at <code>{memRoot}</code></> : null}.
            </p>
          )}
          {archives.map((c) => {
            const isHeld = held.includes(c.id);
            return (
              <div key={c.id} className="row-card">
                <div className="row-top">
                  <code className="break">{c.register}</code>
                </div>
                <div className="row-meta">
                  {formatTokens(c.tokens)} prompt tokens out of the window
                  {c.recalls > 0 ? ` · recalled ×${c.recalls}` : ""}
                  {isHeld ? " · pinned back in" : ""}
                </div>
                <div className="row-actions">
                  {isHeld ? (
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => onRelease(c.id)}
                      disabled={streaming || memBusy !== null}
                      title="Send it back out of the window"
                    >
                      let go
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => onPullBack(c.id)}
                      disabled={streaming || memBusy !== null}
                      title="Read this chunk back from disk into the window"
                    >
                      {memBusy === c.id ? "reading…" : "pull back"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="linkish danger-text"
                    onClick={() => onForget(c.id)}
                    disabled={streaming || memBusy !== null}
                    title="Delete this chunk from disk — the messages stay in the transcript"
                  >
                    forget
                  </button>
                </div>
              </div>
            );
          })}
          {archives.length > 0 && (
            <button
              type="button"
              className="linkish"
              onClick={onUnarchive}
              disabled={streaming || memBusy !== null}
              title="Bring every chunk back into the window and clear the archive"
            >
              {memBusy === "all" ? "clearing…" : "unarchive everything"}
            </button>
          )}

          <div className="group-label">Folds ({compactions.length})</div>
          {compactions.length === 0 && <p className="muted pad">Nothing folded yet.</p>}
          {compactions.length > 0 && (
            <p className="muted tiny">
              {formatTokens(savedTotal)} tokens reclaimed in total. The newest brief is the one in
              the window.
            </p>
          )}
          {compactions.map((c, i) => {
            const saved = compactionNetSavings(c);
            const activeRow = i === compactions.length - 1;
            return (
              <div key={c.id} className={`fold-row ${activeRow ? "on" : ""}`}>
                <div className="fold-row-head">
                  <span>
                    #{i + 1} · {c.foldedMessages} msgs ·{" "}
                    {new Date(c.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="grow" />
                  <span className="muted tiny">
                    {formatTokens(c.tokensBefore)} → {formatTokens(c.tokensAfter)}
                    {saved > 0 ? ` (−${formatTokens(saved)})` : ""}
                  </span>
                </div>
                <div className="muted tiny">
                  {c.source === "model" ? `model brief${c.model ? ` · ${c.model}` : ""}` : "local extract"}
                  {c.auto ? " · automatic" : " · manual"}
                  {activeRow ? " · in window" : ""}
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => onUnfold(i)}
                    disabled={streaming}
                    title="Drop this fold and every later one — the messages come back into the window"
                  >
                    unfold from here
                  </button>
                </div>
                <details className="fold-details">
                  <summary>brief</summary>
                  <pre>{c.summary.slice(0, 6000)}</pre>
                </details>
              </div>
            );
          })}
        </div>
      )}

      {tab === "library" && (
        <div className="rail-scroll sample-form">
          <label className="tiny-check block">
            <input
              type="checkbox"
              checked={settings.library}
              onChange={(e) => setSetting("library", e.target.checked)}
            />
            let the model add, search and read documents
          </label>
          <p className="hint tiny">
            Papers and long pages are read once into the library, cut into sections, and searched
            later — in any chat. PDF, HTML, Markdown and text.
          </p>
          <form
            className="lib-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (libUrl.trim()) {
                onLibraryAdd(libUrl.trim());
                setLibUrl("");
              }
            }}
          >
            <input
              type="url"
              placeholder="https://arxiv.org/abs/…"
              value={libUrl}
              onChange={(e) => setLibUrl(e.target.value)}
              disabled={libBusy !== null}
              aria-label="document address"
            />
            <button type="submit" className="btn" disabled={libBusy !== null || !libUrl.trim()}>
              {libBusy === "add" ? "adding…" : "add"}
            </button>
          </form>
          <label className="field lib-upload">
            <span>or upload files</span>
            <input
              type="file"
              multiple
              accept=".pdf,.md,.markdown,.txt,.tex,.html,.htm,application/pdf,text/*"
              disabled={libBusy !== null}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                if (files.length) onLibraryUpload(files);
                e.target.value = "";
              }}
            />
          </label>
          {libBusy && libBusy !== "add" && <p className="hint tiny">{libBusy}…</p>}
          {libJobs.map((j) => (
            <div key={j.key} className="lib-job">
              <div className="lib-job-text">
                OCR · {j.label.length > 46 ? `${j.label.slice(0, 45)}…` : j.label}
                <span>{j.total ? `page ${j.done} of ${j.total}` : "rendering…"}</span>
              </div>
              <div className="lib-job-bar">
                <span style={{ width: `${j.total ? Math.round((100 * j.done) / j.total) : 2}%` }} />
              </div>
            </div>
          ))}
          {libNotice && <p className="hint tiny">{libNotice}</p>}

          <div className="group-label">OCR</div>
          {ocrOn ? (
            <>
              {ocrInfo && !ocrInfo.ok ? (
                <p className="hint tiny warn-text">{ocrInfo.error}</p>
              ) : ocrInfo?.label ? (
                <p className="hint tiny">
                  <strong>{ocrInfo.label}</strong>
                  {settings.ocrProfile === "auto" ? ` — detected from ${ocrInfo.model}` : ` on ${ocrInfo.model}`} ·{" "}
                  {((ocrInfo.pixels ?? 0) / 1e6).toFixed(1)} MP pages · up to {Math.round((ocrInfo.maxTokens ?? 0) / 1024)}k
                  tokens a page
                </p>
              ) : (
                <p className="hint tiny">Asking the OCR server which model it serves…</p>
              )}
              <p className="hint tiny">
                Scanned PDFs are read with OCR automatically. “re-read with OCR” on a paper replaces its text
                layer with the OCR model’s reading — slower, but faithful equations and tables.
              </p>
            </>
          ) : (
            <p className="hint tiny">
              Off. Set an OCR server in Setup (OvisOCR2 or PaddleOCR-VL on vLLM) to read scans and maths-heavy papers.
            </p>
          )}

          <div className="group-label">Search</div>
          {settings.embedUrl.trim() ? (
            <p className="hint tiny">
              By meaning and keywords, through <code className="break">{settings.embedUrl}</code>.{" "}
              {libDocs && libDocs.some((d) => !d.embedded) && (
                <button type="button" className="link-btn" onClick={onLibraryEmbed} disabled={libBusy !== null}>
                  embed {libDocs.filter((d) => !d.embedded).length} not yet embedded
                </button>
              )}
            </p>
          ) : (
            <p className="hint tiny">
              By keywords only. Set an embeddings server in Setup to search by meaning too.
            </p>
          )}

          <div className="group-label">
            {libDocs ? `${libDocs.length} document${libDocs.length === 1 ? "" : "s"}` : "Documents"}{" "}
            <button type="button" className="link-btn" onClick={onLibraryReload}>
              rescan
            </button>
          </div>
          {libDocs && !libDocs.length && (
            <p className="muted pad">
              Nothing yet. Add a paper above, ask the model to (“add arxiv.org/abs/… to the library”),
              {libRoot ? (
                <>
                  {" "}
                  or drop files into <code className="break">{libRoot}/inbox</code>
                </>
              ) : null}
              .
            </p>
          )}
          {(libDocs ?? []).map((d) => (
            <div key={d.id} className="lib-doc">
              <div className="lib-doc-title">{d.title}</div>
              <div className="lib-doc-meta">
                {d.pages ? `${d.pages} pages · ` : ""}
                {d.chunks} chunks · {d.sections} sections · {d.kind}
                {d.embedded ? " · embedded" : ""}
                {d.extractor?.startsWith("ocr") ? " · OCR" : ""}
              </div>
              <code className="lib-doc-id">{d.id}</code>
              <div className="lib-doc-actions">
                {/^https?:\/\//.test(d.source) && (
                  <a href={d.source} target="_blank" rel="noreferrer">
                    source
                  </a>
                )}
                {ocrOn && d.kind === "pdf" && !d.extractor?.startsWith("ocr") && (
                  <button
                    type="button"
                    className="lib-action"
                    onClick={() => onLibraryReocr(d.id)}
                    disabled={libBusy !== null}
                    title="Read this PDF again page by page with the OCR model — equations and tables come out faithfully"
                  >
                    re-read with OCR
                  </button>
                )}
                <button
                  type="button"
                  className="lib-remove"
                  onClick={() => onLibraryRemove(d.id)}
                  disabled={libBusy !== null}
                  title="Delete this document and its index from disk"
                >
                  remove
                </button>
              </div>
            </div>
          ))}
          {libRoot && libDocs && libDocs.length > 0 && (
            <p className="muted tiny">
              Stored in <code className="break">{libRoot}</code>; drop files into its <code>inbox</code>{" "}
              folder to add them.
            </p>
          )}
        </div>
      )}

      {tab === "server" && (
        <div className="rail-scroll">
          <p className="hint">
            NEO <strong>MAX</strong> MTP: output tensor BF16, MTP tensors Q8. Pair with
            llama-server <code>--spec-type draft-mtp</code>.
          </p>
          <dl className="kv">
            <dt>upstream</dt>
            <dd>{status?.upstream ?? "—"}</dd>
            <dt>via</dt>
            <dd>{status?.via || "—"}</dd>
            <dt>health</dt>
            <dd>{status?.ok ? "ok" : status?.error || "offline"}</dd>
            <dt>model</dt>
            <dd>{status?.models[0]?.id?.split(/[/\\]/).pop() || "—"}</dd>
            <dt>workspace</dt>
            <dd className="break">{status?.workspace ?? "—"}</dd>
            <dt>tools</dt>
            <dd className="break">
              {lastTools === null
                ? "sent with the next turn"
                : lastTools.length
                  ? `last turn: ${lastTools.join(", ")}`
                  : "none on the last turn — all tool settings are off"}
            </dd>
          </dl>
          {templateLacksTools && (
            <p className="hint tiny warn-text">
              The loaded chat template never mentions tools, so the model cannot see them. Start
              llama-server with <code>--jinja</code> and a GGUF whose template supports tool calling.
            </p>
          )}
          <div className="group-label">Machine pacing</div>
          <p className="hint">
            The console reads what llama-server actually reports: <code>503 Loading model</code> while
            the weights page back in, <code>prompt_progress</code> while the prompt is read, and the
            decode rate from <code>timings</code>. Everything else is the job log dressing.
          </p>
          <dl className="kv tight">
            <dt>warm baseline</dt>
            <dd>{pace.baseline ? `${formatRate(pace.baseline)} tok/s` : "not measured yet"}</dd>
            <dt>last round</dt>
            <dd>
              {pace.lastRate ? `${formatRate(pace.lastRate)} tok/s` : "—"}
              {pace.lastTtfMs != null ? ` · first token ${formatClock(pace.lastTtfMs)}` : ""}
            </dd>
            <dt>jobs run</dt>
            <dd>
              {pace.jobs}
              {pace.pagedJobs > 0 ? ` · paged on ${pace.pagedJobs}` : ""}
            </dd>
            {tick && (
              <>
                <dt>this job</dt>
                <dd className="break">
                  {tick.phase} · {tick.why}
                </dd>
              </>
            )}
          </dl>
          <label className="tiny-check block">
            <input
              type="checkbox"
              checked={settings.retroFeedback}
              onChange={(e) => setSetting("retroFeedback", e.target.checked)}
            />
            punched-card job console while reading
          </label>
          <label className="tiny-check block">
            <input
              type="checkbox"
              checked={settings.recallTool}
              onChange={(e) => setSetting("recallTool", e.target.checked)}
            />
            let the model read a chunk back off the disk mid-reply
          </label>
          <label className="tiny-check block">
            <input
              type="checkbox"
              checked={settings.webSearch}
              onChange={(e) => setSetting("webSearch", e.target.checked)}
            />
            let the model search the web and read pages
          </label>
          <label className="tiny-check block">
            <input
              type="checkbox"
              checked={settings.github}
              onChange={(e) => setSetting("github", e.target.checked)}
            />
            let the model read GitHub through gh
          </label>
          <p className="hint tiny">
            Provider: <strong>{settings.webProvider}</strong>
            {settings.webProvider === "auto"
              ? settings.searxUrl
                ? " → your SearXNG"
                : settings.searchApiKey
                  ? " → your API key"
                  : " → DuckDuckGo (keyless)"
              : ""}
            . Tools need llama-server <code>--jinja</code>; a SearXNG URL or a key is set in Setup.
          </p>
          <label className="tiny-check block">
            <input
              type="checkbox"
              checked={settings.skills}
              onChange={(e) => setSetting("skills", e.target.checked)}
            />
            let the model consult skills (procedure manuals)
          </label>
          {settings.skills && (
            <p className="hint tiny">
              {skills === null
                ? "Looking for the skills folder…"
                : skills.skills.length
                  ? `${skills.skills.length} skill${skills.skills.length === 1 ? "" : "s"} — ${
                      skills.skills.length <= SKILL_INLINE_LIMIT
                        ? "listed to the model by name"
                        : "found by the model through skill_search"
                    }. `
                  : skills.missing
                    ? "No skills folder yet — run npm run skills:sync. "
                    : "The skills folder is empty — run npm run skills:sync. "}
              <button type="button" className="link-btn" onClick={onReloadSkills}>
                rescan
              </button>
            </p>
          )}
          <Slider
            label="cold start after"
            min={15}
            max={600}
            step={15}
            value={settings.coldStartSeconds}
            onChange={(v) => setSetting("coldStartSeconds", v)}
            suffix="s idle"
          />
          <Slider
            label="paging below"
            min={0.1}
            max={0.9}
            step={0.05}
            value={settings.pagingFactor}
            onChange={(v) => setSetting("pagingFactor", v)}
            suffix="× baseline"
          />
          <p className="hint">
            Idle longer than the cold-start mark and the console says so up front: the first pass
            after a swap is the slow one. Below the paging factor the job keeps running but the
            console switches to the drum, because the weights are moving again.
          </p>

          <pre className="cmd">
            {`llama-server \\\n  -m Qwen3.8-27B-Turbo-Brilliance-50X-RI-NEO-MAX-MTP-Q6_K.gguf \\\n  --alias q38-max --host 0.0.0.0 --port 8080 \\\n  -c 65536 -ngl 99 -fa on --jinja \\\n  --reasoning-format deepseek \\\n  --temp 0.7 --top-k 64 --min-p 0.05 --top-p 0.95 \\\n  --repeat-penalty 1.0 \\\n  --spec-type draft-mtp --spec-draft-n-max 3`}
          </pre>
          {preview && (
            <div className="preview">
              <div className="preview-path">{preview.path}</div>
              <pre>
                <code>{preview.content.slice(0, 4000)}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  suffix,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  const shown =
    step < 1 ? `${value.toFixed(2)}${suffix ?? ""}` : `${value}${suffix ?? ""}`;
  return (
    <label className="field">
      <span>
        {label}
        <b>{shown}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
