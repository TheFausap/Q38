import fs from "node:fs";
import path from "node:path";
import { writeDurable } from "./durable.mjs";

/**
 * The model's one way to put a file on disk: workspace_write.
 *
 * Everything it writes lands under its own namespace, ./workspace/model/…,
 * the same way github_read's saves land under ./workspace/github/…. Inside
 * that folder the model may create, replace and append to its own files;
 * outside it — your files, the GitHub copies, anything else — it cannot
 * reach, whatever path it names.
 *
 *   workspace_write { path: "notes/plan.md", content: "…" }
 *     → ./workspace/model/notes/plan.md
 *
 * mode "create" (the default) refuses a name that is taken, so a model that
 * meant a new file never silently wipes an old one; "overwrite" and "append"
 * have to be asked for.
 */

/** The folder inside ./workspace that belongs to the model. */
export const MODEL_DIR = "model";
/** Largest file one write may leave behind (after an append, too). */
export const WS_WRITE_MAX_BYTES = 2 * 1024 * 1024;
/** Written files at most this size come back with their text, ready to pin. */
const WS_PIN_MAX_BYTES = 800_000;
const MAX_DEPTH = 8;
const MAX_SEGMENT = 120;
const MODES = new Set(["create", "overwrite", "append"]);

/**
 * A path the model named, as clean segments under MODEL_DIR. Throws with a
 * reason the model can act on. A leading "model/" (the model echoing back a
 * path it was given) is dropped rather than nested.
 */
export function modelPath(raw) {
  let s = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!s) throw new Error("no path given — name the file, e.g. notes/plan.md");
  if (/^[a-z]:\//i.test(s) || s.startsWith("/") || s.startsWith("~")) {
    throw new Error(`"${s}" is an absolute path — give a path relative to the workspace, e.g. notes/plan.md`);
  }
  s = s.replace(/^(\.\/)+/, "");
  if (s.startsWith("workspace/")) s = s.slice("workspace/".length);
  if (s.startsWith(`${MODEL_DIR}/`)) s = s.slice(MODEL_DIR.length + 1);
  if (s.endsWith("/")) throw new Error(`"${s}" names a folder — name a file inside it`);
  const segs = s.split("/").filter((p) => p !== "" && p !== ".");
  if (!segs.length) throw new Error("no file named");
  for (const seg of segs) {
    if (seg === "..") throw new Error(`"${s}" climbs out with ".." — write inside the workspace`);
    if (/[\u0000-\u001f\u007f]/.test(seg)) throw new Error(`"${s}" contains control characters`);
    if (seg.length > MAX_SEGMENT) throw new Error(`a name in "${s}" is longer than ${MAX_SEGMENT} characters`);
  }
  if (segs.length > MAX_DEPTH) throw new Error(`"${s}" is nested more than ${MAX_DEPTH} folders deep`);
  return segs;
}

/** No symlink anywhere between the model's folder and the target. */
function noLinksOnTheWay(base, segs) {
  let cur = base;
  for (const seg of segs) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return; // the rest does not exist yet: nothing further to follow
    }
    if (st.isSymbolicLink()) throw new Error("that path goes through a link — links in the model's folder are not followed");
  }
}

/** Write one text file under ./workspace/model. Never throws; always an outcome. */
export function workspaceWrite({ path: rawPath, content, mode: rawMode } = {}, root) {
  let segs;
  try {
    segs = modelPath(rawPath);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const mode = rawMode === undefined || rawMode === null || rawMode === "" ? "create" : String(rawMode).trim().toLowerCase();
  if (!MODES.has(mode)) return { ok: false, error: `mode "${rawMode}" is not one of create, overwrite, append` };
  if (typeof content !== "string") return { ok: false, error: "content must be text" };
  if (content.includes("\u0000")) return { ok: false, error: "content holds a NUL byte — only text files are written" };

  const rel = [MODEL_DIR, ...segs].join("/");
  const base = path.resolve(root, MODEL_DIR);
  const full = path.resolve(base, ...segs);
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!full.startsWith(baseWithSep)) return { ok: false, error: "that path would leave the model's folder" };

  try {
    /* the model's folder itself must be a real folder, not a link elsewhere */
    if (fs.existsSync(base) && fs.lstatSync(base).isSymbolicLink()) {
      return { ok: false, error: "./workspace/model is a link; the model only writes into a real folder" };
    }
    noLinksOnTheWay(base, segs);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  let existing = null;
  try {
    const st = fs.statSync(full);
    if (st.isDirectory()) return { ok: false, error: `${rel} is a folder — name a file inside it` };
    existing = st;
  } catch {
    existing = null;
  }
  if (existing && mode === "create") {
    return {
      ok: false,
      exists: true,
      path: rel,
      error: `${rel} already exists — pass mode "overwrite" to replace it or "append" to add to its end`,
    };
  }

  let text = content;
  if (mode === "append" && existing) {
    if (existing.size + Buffer.byteLength(content, "utf8") > WS_WRITE_MAX_BYTES) {
      return { ok: false, error: `appending would take ${rel} over the ${WS_WRITE_MAX_BYTES / 1024 / 1024} MB limit` };
    }
    const before = fs.readFileSync(full);
    if (before.includes(0)) return { ok: false, error: `${rel} is a binary file; only text files are appended to` };
    text = before.toString("utf8") + content;
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > WS_WRITE_MAX_BYTES) {
    return { ok: false, error: `that is ${bytes} bytes, over the ${WS_WRITE_MAX_BYTES / 1024 / 1024} MB limit` };
  }

  try {
    writeDurable(full, text);
  } catch (err) {
    return { ok: false, error: `could not write ${rel}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    ok: true,
    path: rel,
    mode,
    created: !existing,
    bytes,
    lines: text.split("\n").length - (text.endsWith("\n") || text === "" ? 1 : 0),
    content: bytes <= WS_PIN_MAX_BYTES ? text : undefined,
  };
}
