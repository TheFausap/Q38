import fs from "node:fs";
import path from "node:path";
import { removeDurable, sweepTemps, writeDurable } from "./durable.mjs";

/**
 * The workbench's own state — settings, sampling, the chat list and every
 * conversation — kept on the server's disk instead of in the browser.
 *
 *   <state>/ui/settings.json
 *   <state>/ui/sampling.json
 *   <state>/ui/index.json            { order: [session ids], activeId }
 *   <state>/ui/sessions/<id>.json    one conversation
 *
 * Each file is an envelope { rev, tab, seq, at, data }:
 *   rev  bumps on every accepted write
 *   tab  the browser tab that wrote it, seq that tab's own counter for the doc
 *
 * A tab never conflicts with itself: a write whose seq is not newer than the
 * stored one is a late arrival and is dropped (a keepalive save can overtake a
 * slower one). A different tab must name the rev it last saw; if the doc moved
 * on since, the write is refused with 409 rather than silently overwriting a
 * newer conversation — unless it says force.
 */

const KINDS = new Set(["settings", "sampling", "index", "session"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function uiRoot(stateRoot) {
  return path.join(stateRoot, "ui");
}

function docFile(root, kind, id) {
  if (kind === "session") {
    if (!ID_RE.test(String(id || ""))) throw new Error("bad session id");
    return path.join(root, "sessions", `${id}.json`);
  }
  return path.join(root, `${kind}.json`);
}

function readEnvelope(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  try {
    const env = JSON.parse(raw);
    if (env && typeof env === "object" && typeof env.rev === "number" && "data" in env) return env;
  } catch {
    /* fall through */
  }
  /* unreadable: keep it aside for a human, and treat the doc as absent */
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, aside);
    console.warn(`[q38 store] ${file} was unreadable; kept as ${path.basename(aside)}`);
  } catch {
    /* ignore */
  }
  return null;
}

/** Everything the UI needs to start. */
export function loadAll(stateRoot) {
  const root = uiRoot(stateRoot);
  const one = (kind) => {
    const env = readEnvelope(docFile(root, kind));
    return env ? { rev: env.rev, data: env.data } : null;
  };
  const sessionsDir = path.join(root, "sessions");
  sweepTemps(root);
  sweepTemps(sessionsDir);
  const sessions = [];
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    /* none yet */
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    const env = readEnvelope(path.join(sessionsDir, name));
    if (env && env.data && typeof env.data === "object") sessions.push({ id, rev: env.rev, data: env.data });
  }
  return {
    settings: one("settings"),
    sampling: one("sampling"),
    index: one("index"),
    sessions,
  };
}

/**
 * Apply a batch of writes. Each doc: { kind, id?, base, seq, data?, delete?, force? }.
 * Returns one result per doc, in order: { ok, rev } | { ok, stale } | { conflict, rev }.
 */
export function saveDocs(stateRoot, tab, docs) {
  const root = uiRoot(stateRoot);
  if (!Array.isArray(docs)) throw new Error("docs must be an array");
  const tabId = String(tab || "");
  return docs.map((doc) => {
    const kind = String(doc?.kind || "");
    if (!KINDS.has(kind)) return { ok: false, error: `unknown kind ${kind}` };
    let file;
    try {
      file = docFile(root, kind, doc.id);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const cur = readEnvelope(file);
    const curRev = cur ? cur.rev : 0;
    const seq = Number(doc.seq) || 0;
    if (cur && tabId && cur.tab === tabId) {
      if (seq <= (Number(cur.seq) || 0)) return { ok: true, stale: true, rev: curRev };
    } else if (!doc.force && curRev !== (Number(doc.base) || 0)) {
      return { conflict: true, rev: curRev };
    }
    if (doc.delete) {
      removeDurable(file);
      return { ok: true, rev: 0 };
    }
    const env = { rev: curRev + 1, tab: tabId, seq, at: Date.now(), data: doc.data };
    /* 0600: settings carry API keys */
    writeDurable(file, JSON.stringify(env), 0o600);
    return { ok: true, rev: env.rev };
  });
}
