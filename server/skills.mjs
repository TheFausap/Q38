/**
 * Skills: procedure manuals the model can look up mid-turn.
 *
 * A skill is a folder holding a `SKILL.md` (YAML-ish frontmatter with a `name`
 * and a `description`, then a markdown body) and, often, `references/` and
 * `scripts/` beside it — the Agent Skills layout. `npm run skills:sync` fills
 * the folder from K-Dense's scientific-agent-skills; any folder in that shape
 * works.
 *
 * Nothing here runs a skill. Q38 has no code execution, so a skill is text the
 * model reads: the method, the API, the pitfalls. Scripts can be read too, as
 * code to show the user, never as something that was run.
 *
 * Pure apart from the filesystem, so the tests can point it at a temp folder.
 */
import fs from "node:fs";
import path from "node:path";

/** Characters of one skill file that may enter the prompt by default. */
export const SKILL_DEFAULT_CHARS = 24_000;
/** …and never more than this, whatever a request asks for. */
export const SKILL_MAX_CHARS = 48_000;
/** Files listed beside a skill, so the model knows what it could open next. */
const MAX_LISTED_FILES = 40;
/** A skill folder is only walked this deep for its file list. */
const MAX_DEPTH = 3;
/** Only text a prompt can hold. */
const READABLE = new Set([".md", ".txt", ".py", ".r", ".jl", ".json", ".yaml", ".yml", ".toml", ".sh", ".tex", ".csv"]);

export function skillsRoot() {
  return path.resolve(process.cwd(), process.env.Q38_SKILLS_DIR || "./skills");
}

/**
 * The frontmatter of a SKILL.md, as far as Q38 needs it: top-level scalar keys.
 *
 * Not a YAML parser — nested maps and lists are skipped, quoted values are
 * unquoted, and a folded `>`/`|` value is joined from its indented lines. That
 * covers every description in the upstream library.
 */
export function parseFrontmatter(text) {
  const src = String(text || "").replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    let value = rawValue.trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(value.startsWith(">") ? " " : "\n");
    } else if (!value) {
      continue; // a nested block: not needed
    }
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    meta[key] = value;
  }
  return { meta, body: src.slice(m[0].length) };
}

function safeInside(root, rel) {
  const full = path.resolve(root, rel || ".");
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(withSep)) return null;
  return full;
}

function listFiles(dir, base, depth, acc) {
  if (depth > MAX_DEPTH || acc.length >= MAX_LISTED_FILES) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (acc.length >= MAX_LISTED_FILES) return;
    if (e.name.startsWith(".") || e.name === "__pycache__" || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (e.isDirectory()) listFiles(full, base, depth + 1, acc);
    else if (e.isFile() && rel !== "SKILL.md" && READABLE.has(path.extname(e.name).toLowerCase())) acc.push(rel);
  }
}

/**
 * Every skill under `root`, one level down: `root/<folder>/SKILL.md`.
 * A folder without a usable name or description is skipped, not guessed at.
 */
export function loadIndex(root = skillsRoot()) {
  if (!fs.existsSync(root)) return { root, missing: true, skills: [] };
  const skills = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("."));
  } catch {
    return { root, missing: true, skills: [] };
  }
  for (const d of dirs) {
    const file = path.join(root, d.name, "SKILL.md");
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(text);
    const name = String(meta.name || d.name).trim();
    const description = String(meta.description || "").replace(/\s+/g, " ").trim();
    if (!name || !description) continue;
    skills.push({ name, folder: d.name, description, chars: body.length, body });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { root, missing: false, skills };
}

/* The index is read from disk at most this often: a sync shows up within seconds. */
const INDEX_TTL_MS = 5_000;
let cached = null;

export function currentIndex(root = skillsRoot()) {
  const now = Date.now();
  if (cached && cached.root === root && now - cached.at < INDEX_TTL_MS) return cached.index;
  const index = loadIndex(root);
  cached = { root, at: now, index };
  return index;
}

/** The index as the client sees it: no bodies. */
export function publicIndex(index) {
  return {
    ok: true,
    root: index.root,
    missing: Boolean(index.missing),
    skills: index.skills.map(({ name, description, chars }) => ({ name, description, chars })),
  };
}

function words(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

const STOP = new Set(
  "the a an and or of to in for on with by from at as is are be it this that how what which use using into my me i".split(" "),
);

/**
 * The closest skills to a question, by plain word overlap: a name match counts
 * most, then the description, then the body (lightly, and capped, so a long
 * manual does not win just by being long). Good enough for a few hundred
 * skills; the model refines with a better query if it misses.
 */
export function searchSkills(index, query, k = 5) {
  const terms = [...new Set(words(query).filter((w) => !STOP.has(w)))];
  if (!terms.length) return [];
  const scored = [];
  for (const s of index.skills) {
    const name = s.name.toLowerCase();
    const nameWords = new Set(words(s.name.replace(/-/g, " ")));
    const descText = s.description.toLowerCase();
    const desc = new Set(words(s.description));
    const bodyText = s.body.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      let hit = false;
      if (name === t) (score += 12), (hit = true);
      else if (nameWords.has(t) || name.includes(t)) (score += 6), (hit = true);
      if (desc.has(t)) (score += 3), (hit = true);
      else if (t.length >= 5 && descText.includes(t.slice(0, -1))) (score += 2), (hit = true); // simulation ~ simulations
      let hits = 0;
      let at = bodyText.indexOf(t);
      while (at !== -1 && hits < 4) {
        hits++;
        at = bodyText.indexOf(t, at + t.length);
      }
      if (hits) hit = true;
      score += hits * 0.25;
      if (hit) matched++;
    }
    // a skill that covers more of the question beats one that repeats one word
    score *= 0.5 + (0.5 * matched) / terms.length;
    if (score > 0) scored.push({ name: s.name, description: s.description, chars: s.chars, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(1, Math.min(10, Math.round(Number(k) || 5))));
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 6) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function clampChars(chars) {
  const n = Math.round(Number(chars));
  if (!Number.isFinite(n) || n <= 0) return SKILL_DEFAULT_CHARS;
  return Math.max(1_000, Math.min(SKILL_MAX_CHARS, n));
}

/**
 * One skill's text: the SKILL.md body by default, or one of the files beside it.
 * The name must be in the index and the file must stay inside that skill's
 * folder — a skill cannot be used to read anything else on the disk.
 */
export function readSkill(index, name, { file = "", chars } = {}) {
  const wanted = String(name || "").trim().toLowerCase();
  const skill = index.skills.find((s) => s.name.toLowerCase() === wanted || s.folder.toLowerCase() === wanted);
  if (!skill) {
    const byName = index.skills
      .map((s) => ({ name: s.name, d: editDistance(wanted, s.name.toLowerCase()) }))
      .filter((x) => x.d <= Math.max(2, Math.floor(wanted.length / 4)))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.name);
    const bySearch = searchSkills(index, wanted.replace(/[-_]/g, " "), 3).map((s) => s.name);
    const near = [...new Set([...byName, ...bySearch])].slice(0, 3);
    return {
      ok: false,
      error: `there is no skill named "${String(name || "").slice(0, 60)}"`,
      suggestions: near,
    };
  }
  const dir = path.join(index.root, skill.folder);
  const files = [];
  listFiles(dir, dir, 0, files);
  const limit = clampChars(chars);

  let text;
  let shownFile = "SKILL.md";
  const rel = String(file || "").trim().replace(/^\.?\/+/, "");
  if (rel && rel !== "SKILL.md") {
    const full = safeInside(dir, rel);
    if (!full) return { ok: false, error: "that path leaves the skill's folder", name: skill.name, files };
    if (!READABLE.has(path.extname(full).toLowerCase())) {
      return { ok: false, error: `${rel} is not a text file a prompt can hold`, name: skill.name, files };
    }
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      return { ok: false, error: `${skill.name} has no file ${rel}`, name: skill.name, files };
    }
    shownFile = rel;
  } else {
    text = skill.body;
  }
  const full = text.trim();
  const shown = full.slice(0, limit);
  return {
    ok: true,
    name: skill.name,
    description: skill.description,
    file: shownFile,
    text: shown,
    chars: shown.length,
    totalChars: full.length,
    truncated: full.length > shown.length,
    files,
  };
}
