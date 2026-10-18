import {
  DEFAULT_SAMPLING,
  DEFAULT_SETTINGS,
  type Sampling,
  type Session,
  type Settings,
} from "./types";

/*
 * Where the workbench keeps its state.
 *
 * The source of truth is the Q38 server's disk (server/store.mjs): every write
 * there is fsynced and renamed into place, so a conversation that has been
 * reported "saved" survives a power cut. localStorage is kept as a mirror only:
 * it is what the app falls back to when the server cannot be reached, and the
 * one-time import source when the server's store is still empty.
 *
 * Saves are batched (at most one round-trip every SAVE_EVERY ms, one in flight
 * at a time) and sent per conversation, so streaming a reply rewrites one file,
 * not the whole history. flushNow() pushes everything immediately — the app
 * calls it the moment a reply ends.
 */

const SESS_KEY = "q38.sessions.v1";
const SET_KEY = "q38.settings.v1";
const SAM_KEY = "q38.sampling.v1";
const ACTIVE_KEY = "q38.active.v1";

const SAVE_EVERY = 1200;
const RETRY_AFTER = 4000;
const LOAD_TIMEOUT = 5000;

/* ------------------------------------------------------------ localStorage */

function lsRead<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function lsWrite(key: string, value: unknown) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    /* the mirror is best-effort; the server copy is what counts */
  }
}

/** Tolerate transcripts written before folding existed. */
function normalizeSession(s: Session): Session {
  return {
    ...s,
    messages: Array.isArray(s.messages) ? s.messages : [],
    compactions: Array.isArray(s.compactions) ? s.compactions : [],
  };
}

/* ------------------------------------------------------------- save status */

export type SaveStatus =
  | { kind: "local"; message: string }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string }
  | { kind: "conflict"; message: string };

let status: SaveStatus = { kind: "local", message: "not loaded from the server yet" };
const listeners = new Set<(s: SaveStatus) => void>();

function setStatus(next: SaveStatus) {
  status = next;
  for (const fn of listeners) fn(next);
}

export function getSaveStatus(): SaveStatus {
  return status;
}

export function onSaveStatus(fn: (s: SaveStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ------------------------------------------------------------ server store */

type Kind = "settings" | "sampling" | "index" | "session";
type Pending = { kind: Kind; id?: string; data?: unknown; delete?: boolean };
type DocResult = { ok?: boolean; stale?: boolean; rev?: number; conflict?: boolean; error?: string };

const keyOf = (kind: Kind, id?: string) => (kind === "session" ? `session:${id}` : kind);

/** server mode once hydrate() reached the server; until then (or if it failed) local only */
let serverMode = false;
let hydrated = false;
const TAB = uid();

/** what the server last confirmed, per doc */
const revs = new Map<string, number>();
/** per-doc counter for this tab, so a late write can never overtake a newer one */
const seqs = new Map<string, number>();
/** docs changed since the last save went out */
const pending = new Map<string, Pending>();
/** docs the server refused because another tab saved them first */
const conflicted = new Map<string, Pending>();

/** what each doc looked like when last queued, to skip unchanged ones */
const lastSessionRef = new Map<string, Session>();
const lastJson = new Map<string, string>();

let cache: {
  settings: Partial<Settings> | null;
  sampling: Partial<Sampling> | null;
  sessions: Session[] | null;
  activeId: string | null;
} | null = null;

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let again = false;

/**
 * Load state before the app mounts. Prefers the server; falls back to
 * localStorage (and says so) if the server is out of reach. When the server's
 * store is empty, whatever is in localStorage is imported on the first save.
 */
export async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LOAD_TIMEOUT);
  try {
    const res = await fetch("/api/store", { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    const body = (await res.json()) as {
      settings: { rev: number; data: Partial<Settings> } | null;
      sampling: { rev: number; data: Partial<Sampling> } | null;
      index: { rev: number; data: { order?: string[]; activeId?: string | null } } | null;
      sessions: { id: string; rev: number; data: Session }[];
    };
    serverMode = true;
    watchPageExit();
    const hasState = !!(body.index || body.settings || body.sessions.length);
    if (!hasState) {
      /* first run on this server: import the browser's copy (queued by the
         app's mount-time saves, since nothing is marked as saved yet) */
      setStatus({ kind: "saving" });
      return;
    }
    if (body.settings) revs.set("settings", body.settings.rev);
    if (body.sampling) revs.set("sampling", body.sampling.rev);
    if (body.index) revs.set("index", body.index.rev);
    const order = body.index?.data?.order ?? [];
    const pos = new Map(order.map((id, i) => [id, i]));
    const sessions = body.sessions
      .map((s) => {
        revs.set(keyOf("session", s.id), s.rev);
        return normalizeSession({ ...s.data, id: s.id });
      })
      .sort((a, b) => {
        const pa = pos.get(a.id);
        const pb = pos.get(b.id);
        if (pa !== undefined && pb !== undefined) return pa - pb;
        if (pa !== undefined) return -1;
        if (pb !== undefined) return 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    for (const s of sessions) lastSessionRef.set(s.id, s);
    cache = {
      settings: body.settings?.data ?? null,
      sampling: body.sampling?.data ?? null,
      sessions,
      activeId: body.index?.data?.activeId ?? null,
    };
    /* what the server holds counts as saved: the mount-time saves are no-ops */
    if (body.settings) lastJson.set("settings", JSON.stringify({ ...DEFAULT_SETTINGS, ...body.settings.data }));
    if (body.sampling) lastJson.set("sampling", JSON.stringify({ ...DEFAULT_SAMPLING, ...body.sampling.data }));
    setStatus({ kind: "saved", at: Date.now() });
  } catch (err) {
    serverMode = false;
    const why = err instanceof Error && err.name === "AbortError" ? "did not answer" : "is out of reach";
    setStatus({
      kind: "local",
      message: `The Q38 server ${why}: changes are kept in this browser only and can be lost in a crash. Reload once the server is back.`,
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Leaving the page: a hidden tab saves at once (closing a laptop lid, switching
 * away), and closing with something unsaved asks first.
 */
function watchPageExit() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && pending.size) void flush();
  });
  window.addEventListener("beforeunload", (e) => {
    if (!hasUnsaved()) return;
    void flush();
    e.preventDefault();
    e.returnValue = "";
  });
}

function queue(p: Pending) {
  if (!serverMode) return;
  const key = keyOf(p.kind, p.id);
  if (conflicted.has(key)) {
    conflicted.set(key, p);
    return;
  }
  pending.set(key, p);
  if (status.kind === "saved") setStatus({ kind: "saving" });
  if (!timer && !inFlight) timer = setTimeout(() => void flush(), SAVE_EVERY);
  else if (inFlight) again = true;
}

async function send(batch: Pending[], force = false): Promise<DocResult[]> {
  const docs = batch.map((p) => {
    const key = keyOf(p.kind, p.id);
    const seq = (seqs.get(key) ?? 0) + 1;
    seqs.set(key, seq);
    return { ...p, base: revs.get(key) ?? 0, seq, force: force || undefined };
  });
  const res = await fetch("/api/store/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tab: TAB, docs }),
  });
  if (res.status !== 200 && res.status !== 409) {
    let msg = `the server answered ${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error || msg;
    } catch {
      /* keep the status line */
    }
    throw new Error(msg);
  }
  return ((await res.json()) as { results: DocResult[] }).results;
}

async function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (inFlight) {
    again = true;
    return inFlight;
  }
  if (!pending.size) return;
  const batch = [...pending.values()];
  pending.clear();
  setStatus({ kind: "saving" });
  inFlight = (async () => {
    try {
      const results = await send(batch);
      results.forEach((r, i) => {
        const p = batch[i];
        const key = keyOf(p.kind, p.id);
        if (r.conflict) {
          conflicted.set(key, pending.get(key) ?? p);
          pending.delete(key);
          if (typeof r.rev === "number") revs.set(key, r.rev);
        } else if (r.ok) {
          if (typeof r.rev === "number") revs.set(key, r.rev);
        } else if (!pending.has(key)) {
          pending.set(key, p);
        }
      });
      const errors = results.filter((r) => !r.ok && !r.conflict);
      if (conflicted.size) {
        setStatus({
          kind: "conflict",
          message:
            "Another Q38 tab saved newer changes. Reload to load them, or keep this tab's version (it overwrites the other).",
        });
      } else if (errors.length) {
        throw new Error(errors[0].error || "the server refused a save");
      } else if (!pending.size) {
        setStatus({ kind: "saved", at: Date.now() });
      }
    } catch (err) {
      /* put the batch back, unless something newer was queued meanwhile */
      for (const p of batch) {
        const key = keyOf(p.kind, p.id);
        if (!pending.has(key) && !conflicted.has(key)) pending.set(key, p);
      }
      setStatus({
        kind: "error",
        message: `Not saved to disk yet: ${err instanceof Error ? err.message : String(err)}. Retrying…`,
      });
      again = false;
      timer = setTimeout(() => void flush(), RETRY_AFTER);
    } finally {
      inFlight = null;
    }
    if (again) {
      again = false;
      if (pending.size) await flush();
    }
  })();
  return inFlight;
}

/**
 * Push every queued change now and resolve once the server has it on disk.
 * Resolves true when nothing is left unsaved.
 */
export async function flushNow(): Promise<boolean> {
  if (!serverMode) return false;
  /* chase until quiet: a save can queue more while one is in flight */
  for (let i = 0; i < 5 && (pending.size || inFlight); i += 1) {
    if (inFlight) await inFlight;
    else await flush();
  }
  return !pending.size && !inFlight && !conflicted.size;
}

/** Overwrite whatever another tab saved with this tab's version. */
export async function keepThisTab(): Promise<boolean> {
  if (!conflicted.size) return true;
  const batch = [...conflicted.values()];
  conflicted.clear();
  try {
    const results = await send(batch, true);
    results.forEach((r, i) => {
      const key = keyOf(batch[i].kind, batch[i].id);
      if (r.ok && typeof r.rev === "number") revs.set(key, r.rev);
      else pending.set(key, batch[i]);
    });
  } catch {
    for (const p of batch) pending.set(keyOf(p.kind, p.id), p);
  }
  return flushNow();
}

/** Anything not yet confirmed on disk. */
export function hasUnsaved(): boolean {
  return serverMode && (pending.size > 0 || inFlight !== null || conflicted.size > 0 || timer !== null);
}

/* -------------------------------------------------------------- public API */

let sessionsLoaded: Session[] | null = null;

export function loadSessions(): Session[] {
  /* one array for every caller, so StrictMode's double init does not make
     every session look changed */
  if (sessionsLoaded) return sessionsLoaded;
  sessionsLoaded = cache?.sessions ?? lsRead<Session[]>(SESS_KEY, []).map(normalizeSession);
  return sessionsLoaded;
}

let indexOrder: string[] = [];
let indexActive: string | null = null;

function queueIndex() {
  const data = { order: indexOrder, activeId: indexActive };
  const json = JSON.stringify(data);
  if (lastJson.get("index") === json) return;
  lastJson.set("index", json);
  queue({ kind: "index", data });
}

export function saveSessions(sessions: Session[]) {
  lsWrite(SESS_KEY, sessions);
  if (!serverMode) return;
  const seen = new Set<string>();
  for (const s of sessions) {
    seen.add(s.id);
    if (lastSessionRef.get(s.id) !== s) {
      lastSessionRef.set(s.id, s);
      queue({ kind: "session", id: s.id, data: s });
    }
  }
  for (const id of [...lastSessionRef.keys()]) {
    if (!seen.has(id)) {
      lastSessionRef.delete(id);
      queue({ kind: "session", id, delete: true });
    }
  }
  indexOrder = sessions.map((s) => s.id);
  queueIndex();
}

export function loadSettings(): Settings {
  const stored = cache ? cache.settings : null;
  return { ...DEFAULT_SETTINGS, ...(stored ?? lsRead<Partial<Settings>>(SET_KEY, {})) };
}

export function saveSettings(settings: Settings) {
  const json = JSON.stringify(settings);
  lsWrite(SET_KEY, json);
  if (lastJson.get("settings") === json) return;
  lastJson.set("settings", json);
  queue({ kind: "settings", data: settings });
}

export function loadSampling(): Sampling {
  const stored = cache ? cache.sampling : null;
  return { ...DEFAULT_SAMPLING, ...(stored ?? lsRead<Partial<Sampling>>(SAM_KEY, {})) };
}

export function saveSampling(sampling: Sampling) {
  const json = JSON.stringify(sampling);
  lsWrite(SAM_KEY, json);
  if (lastJson.get("sampling") === json) return;
  lastJson.set("sampling", json);
  queue({ kind: "sampling", data: sampling });
}

export function loadActiveId(): string | null {
  if (cache?.activeId) return cache.activeId;
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveId(id: string) {
  lsWrite(ACTIVE_KEY, id);
  indexActive = id;
  if (serverMode) queueIndex();
}

export function uid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
