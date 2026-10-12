import { useMemo, useState } from "react";
import { GROUPS, familyLabel, modeById, MODES, reasonTag } from "../lib/modes";
import type { ModeFamily, Sampling, ServerStatus } from "../lib/types";

export function Inspector({
  modeId,
  family,
  onMode,
  onFamily,
  sampling,
  onSampling,
  status,
  preview,
  onAskHelp,
}: {
  modeId: string;
  family: ModeFamily;
  onMode: (id: string) => void;
  onFamily: (f: ModeFamily) => void;
  sampling: Sampling;
  onSampling: (s: Sampling) => void;
  status: ServerStatus | null;
  preview: { path: string; content: string } | null;
  onAskHelp: () => void;
}) {
  const [tab, setTab] = useState<"construct" | "sample" | "server">("construct");
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

  return (
    <aside className="rail right">
      <div className="tabs">
        {(["construct", "sample", "server"] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? "tab on" : "tab"}
            onClick={() => setTab(t)}
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

      {tab === "server" && (
        <div className="rail-scroll">
          <p className="hint">
            NEO <strong>MAX</strong> MTP: output tensor BF16, MTP tensors Q8. Pair with
            llama-server <code>--spec-type draft-mtp</code>.
          </p>
          <dl className="kv">
            <dt>upstream</dt>
            <dd>{status?.upstream ?? "—"}</dd>
            <dt>health</dt>
            <dd>{status?.ok ? "ok" : status?.error || "offline"}</dd>
            <dt>model</dt>
            <dd>{status?.models[0]?.id?.split(/[/\\]/).pop() || "—"}</dd>
            <dt>workspace</dt>
            <dd className="break">{status?.workspace ?? "—"}</dd>
          </dl>
          <pre className="cmd">
            {`llama-server \\
  -m Qwen3.8-27B-Turbo-Brilliance-50X-RI-NEO-MAX-MTP-Q6_K.gguf \\
  --alias q38-max --host 0.0.0.0 --port 8080 \\
  -c 65536 -ngl 99 -fa on --jinja \\
  --reasoning-format deepseek \\
  --temp 0.7 --top-k 64 --min-p 0.05 --top-p 0.95 \\
  --repeat-penalty 1.0 \\
  --spec-type draft-mtp --spec-draft-n-max 3`}
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
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      <span>
        {label}
        <b>{Number.isInteger(step) ? value : value.toFixed(2)}</b>
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
