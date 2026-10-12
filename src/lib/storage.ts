import {
  DEFAULT_SAMPLING,
  DEFAULT_SETTINGS,
  type Sampling,
  type Session,
  type Settings,
} from "./types";

const SESS_KEY = "q38.sessions.v1";
const SET_KEY = "q38.settings.v1";
const SAM_KEY = "q38.sampling.v1";
const ACTIVE_KEY = "q38.active.v1";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota */
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

export function loadSessions(): Session[] {
  return read<Session[]>(SESS_KEY, []).map(normalizeSession);
}

export function saveSessions(sessions: Session[]) {
  write(SESS_KEY, sessions);
}

export function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(SET_KEY, {}) };
}

export function saveSettings(settings: Settings) {
  write(SET_KEY, settings);
}

export function loadSampling(): Sampling {
  return { ...DEFAULT_SAMPLING, ...read<Partial<Sampling>>(SAM_KEY, {}) };
}

export function saveSampling(sampling: Sampling) {
  write(SAM_KEY, sampling);
}

export function loadActiveId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function saveActiveId(id: string) {
  localStorage.setItem(ACTIVE_KEY, id);
}

export function uid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
