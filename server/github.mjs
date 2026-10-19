import { execFile } from "node:child_process";

/**
 * GitHub through the `gh` CLI on the machine that runs the Q38 server.
 *
 * The model never writes a command. It names a repository, a path, a ref or a
 * query; this module checks each one against a strict pattern and builds the
 * argument vector itself. Every call is
 *
 *   gh api --method GET <path we built> [-H Accept: …]
 *
 * run with execFile (no shell, so nothing in an argument is ever interpreted),
 * a timeout and an output cap. GET is read-only on GitHub's API; no -f/-F field
 * (which would turn the request into a POST) and no --input is ever passed.
 *
 * Whatever `gh` is logged in as is who reads: private repositories you can see
 * are readable, and the rate limit is the authenticated 5,000 an hour.
 *
 * Q38_GH_BIN points at a different binary (the tests use a stub).
 */

const GH_TIMEOUT_MS = 20_000;
/** Largest response `gh` may hand back: big enough for any source file worth reading. */
const GH_MAX_BYTES = 8 * 1024 * 1024;
/** Paths listed by one tree call. */
export const GH_TREE_MAX_ENTRIES = 400;
/** Characters of a file one read may return, however many are asked for. */
export const GH_READ_MAX_CHARS = 20_000;
/** Hits one search may return. */
export const GH_SEARCH_MAX = 15;

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;
const SEGMENT_RE = /^[^\u0000-\u001f\u007f\/\\]{1,255}$/;

function ghBin() {
  return process.env.Q38_GH_BIN || "gh";
}

/* --------------------------------------------------------- validation */

/** "owner/repo", also accepted as a github.com URL or with a .git suffix. */
export function parseRepo(raw) {
  let s = String(raw || "").trim();
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+\/[^/\s#?]+)/i.exec(s);
  if (m) s = m[1];
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!REPO_RE.test(s) || s.split("/")[1] === "." || s.split("/")[1] === "..") {
    throw new Error(`"${String(raw).slice(0, 80)}" is not a repository: name it as owner/repo`);
  }
  return s;
}

export function parseRef(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (!REF_RE.test(s) || s.includes("..") || s.startsWith("/") || s.startsWith("-")) {
    throw new Error(`"${s.slice(0, 80)}" is not a branch, tag or commit`);
  }
  return s;
}

/** A path inside the repo, as encoded URL segments. "" is the root. */
export function parsePath(raw) {
  const s = String(raw ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!s) return { path: "", encoded: "" };
  const parts = s.split("/");
  for (const p of parts) {
    if (!SEGMENT_RE.test(p) || p === "." || p === "..") {
      throw new Error(`"${s.slice(0, 120)}" is not a path inside the repository`);
    }
  }
  return { path: s, encoded: parts.map(encodeURIComponent).join("/") };
}

/**
 * A github.com URL the model already has, taken apart: blob and tree links
 * carry the repo, the ref and the path in one string.
 */
export function parseGithubUrl(raw) {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:blob|tree|raw)\/([^/\s#?]+)(?:\/([^\s#?]*))?)?/i.exec(
    String(raw || "").trim(),
  );
  if (m) return { repo: `${m[1]}/${m[2].replace(/\.git$/i, "")}`, ref: m[3] || "", path: m[4] || "" };
  const r = /^(?:https?:\/\/)?raw\.githubusercontent\.com\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/([^\s#?]*)/i.exec(
    String(raw || "").trim(),
  );
  if (r) return { repo: `${r[1]}/${r[2]}`, ref: r[3], path: r[4] };
  return null;
}

/* ---------------------------------------------------------------- gh */

/** Why gh said no, in a line a person (and the model) can act on. */
function explain(stderr, code) {
  const err = String(stderr || "").trim();
  if (/gh auth login|not logged in|authentication required|GH_TOKEN/i.test(err)) {
    return "gh is not logged in on the machine running Q38 — run `gh auth login` there";
  }
  const http = /HTTP (\d{3})/.exec(err);
  if (http) {
    const status = Number(http[1]);
    if (status === 404) return "not found (no such repository, branch or path — or this account cannot see it)";
    if (status === 403 && /rate limit/i.test(err)) return "GitHub's rate limit is spent for now; try again later";
    if (status === 403) {
      const why = (/^gh:\s*(.*?)\s*\(HTTP 403\)/m.exec(err) || [])[1] || "";
      return `GitHub refused access (403)${why ? `: ${why.slice(0, 160)}` : ""}`;
    }
    if (status === 422) return "GitHub could not run that query (422) — simplify it";
    if (status === 409) return "the repository is empty";
    return `GitHub answered ${status}`;
  }
  const first = err.split("\n").find((l) => l.trim()) || `gh exited with ${code}`;
  return first.replace(/^gh:\s*/, "").slice(0, 200);
}

/** Run `gh` with arguments we built. Resolves { ok, stdout } or { ok: false, error }. */
export function runGh(args, { timeout = GH_TIMEOUT_MS, maxBuffer = GH_MAX_BYTES } = {}) {
  return new Promise((resolve) => {
    execFile(
      ghBin(),
      args,
      {
        shell: false,
        timeout,
        maxBuffer,
        windowsHide: true,
        encoding: "buffer",
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          GH_PAGER: "",
          NO_COLOR: "1",
          CLICOLOR: "0",
        },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout });
        if (err.code === "ENOENT") {
          return resolve({ ok: false, error: "gh is not installed on the machine running Q38 (or not on its PATH)" });
        }
        if (err.killed || err.signal === "SIGTERM") {
          return resolve({ ok: false, error: `GitHub did not answer within ${Math.round(timeout / 1000)} s` });
        }
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return resolve({ ok: false, error: `the answer is larger than ${Math.round(maxBuffer / 1e6)} MB` });
        }
        resolve({ ok: false, error: explain(stderr?.toString("utf8"), err.code) });
      },
    );
  });
}

/** GET one API path; JSON unless `raw`. */
async function apiGet(apiPath, { raw = false } = {}) {
  if (/^-/.test(apiPath)) throw new Error("bad api path");
  const args = ["api", "--method", "GET", apiPath];
  if (raw) args.push("-H", "Accept: application/vnd.github.raw");
  else args.push("-H", "Accept: application/vnd.github+json");
  const out = await runGh(args);
  if (!out.ok) return out;
  if (raw) return { ok: true, bytes: out.stdout };
  try {
    return { ok: true, json: JSON.parse(out.stdout.toString("utf8")) };
  } catch {
    return { ok: false, error: "gh answered with something that is not JSON" };
  }
}

/* ------------------------------------------------------------- cache */

const CACHE_MS = 60_000;
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  if (value?.ok) {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return value;
}
export function clearGithubCache() {
  cache.clear();
}

/* -------------------------------------------------------------- status */

/** Is gh there, and logged in? Never throws. */
export async function githubStatus() {
  const version = await runGh(["--version"], { timeout: 5000 });
  if (!version.ok) return { ok: false, available: false, error: version.error };
  const ver = (/gh version ([\d.]+)/.exec(version.stdout.toString("utf8")) || [])[1] || "";
  const who = await runGh(["api", "--method", "GET", "user", "--jq", ".login"], { timeout: 10_000 });
  if (!who.ok) return { ok: false, available: true, version: ver, error: who.error };
  return { ok: true, available: true, version: ver, login: who.stdout.toString("utf8").trim() };
}

/* -------------------------------------------------------------- repo */

async function repoInfo(repo) {
  return cached(`repo:${repo}`, async () => {
    const r = await apiGet(`repos/${repo}`);
    if (!r.ok) return r;
    const j = r.json || {};
    return {
      ok: true,
      repo: j.full_name || repo,
      description: j.description || "",
      defaultBranch: j.default_branch || "main",
      private: !!j.private,
      language: j.language || "",
      stars: j.stargazers_count ?? 0,
      pushedAt: j.pushed_at || "",
      archived: !!j.archived,
    };
  });
}

/* -------------------------------------------------------------- tree */

/**
 * Files and folders under `path` (the whole repo when blank), one level or all
 * the way down. Capped; the caller is told when the list was cut.
 */
export async function githubTree({ repo: rawRepo, ref: rawRef, path: rawPath, recursive = true } = {}) {
  let repo, ref, path;
  try {
    const fromUrl = parseGithubUrl(rawRepo);
    repo = parseRepo(fromUrl ? fromUrl.repo : rawRepo);
    ref = parseRef(rawRef || fromUrl?.ref || "");
    path = parsePath(rawPath || fromUrl?.path || "").path;
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const info = await repoInfo(repo);
  if (!info.ok) return info;
  const useRef = ref || info.defaultBranch;
  const tree = await cached(`tree:${repo}@${useRef}`, () =>
    apiGet(`repos/${repo}/git/trees/${encodeURIComponent(useRef)}?recursive=1`),
  );
  if (!tree.ok) return tree;
  const all = Array.isArray(tree.json?.tree) ? tree.json.tree : [];
  const prefix = path ? `${path}/` : "";
  const depth = prefix ? prefix.split("/").length - 1 : 0;
  let entries = all
    .filter((e) => e && typeof e.path === "string" && (e.type === "blob" || e.type === "tree"))
    .filter((e) => !prefix || e.path.startsWith(prefix))
    .filter((e) => recursive || e.path.split("/").length === depth + 1)
    .map((e) => ({ path: e.path, type: e.type === "tree" ? "dir" : "file", size: e.size ?? 0 }));
  if (path && !entries.length && !all.some((e) => e.path === path)) {
    return { ok: false, error: `no folder "${path}" on ${useRef}` };
  }
  if (path && !entries.length) {
    return { ok: false, error: `"${path}" is a file, not a folder — read it with github_read` };
  }
  const total = entries.length;
  const cut = total > GH_TREE_MAX_ENTRIES;
  if (cut) entries = entries.slice(0, GH_TREE_MAX_ENTRIES);
  return {
    ok: true,
    ...info,
    ref: useRef,
    path,
    entries,
    total,
    truncated: cut || !!tree.json?.truncated,
  };
}

/* -------------------------------------------------------------- read */

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/**
 * One file, by line range: `line` is where to start (1-based), and as many
 * whole lines as fit in `chars` come back, with where to carry on.
 */
export async function githubRead({ repo: rawRepo, path: rawPath, ref: rawRef, line = 1, chars = 12_000 } = {}) {
  let repo, ref, path, encoded;
  try {
    /* the model may hand over a github.com link in either field */
    const pathUrl = parseGithubUrl(rawPath);
    const fromUrl = pathUrl || parseGithubUrl(rawRepo);
    repo = parseRepo(fromUrl ? fromUrl.repo : rawRepo);
    ref = parseRef(rawRef || fromUrl?.ref || "");
    ({ path, encoded } = parsePath(pathUrl ? pathUrl.path : rawPath || fromUrl?.path || ""));
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!path) return { ok: false, error: "no path given — list the repository with github_tree first" };
  const budget = Math.max(1000, Math.min(GH_READ_MAX_CHARS, Math.round(Number(chars) || 12_000)));
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const got = await cached(`file:${repo}@${ref}:${path}`, () => apiGet(`repos/${repo}/contents/${encoded}${q}`, { raw: true }));
  if (!got.ok) return got;
  const bytes = got.bytes;
  /* a folder answers with its JSON listing even under the raw media type */
  const head = bytes.subarray(0, 1).toString("utf8");
  if (head === "[") {
    try {
      const list = JSON.parse(bytes.toString("utf8"));
      if (Array.isArray(list)) {
        return {
          ok: false,
          error: `"${path}" is a folder (${list.length} entries) — list it with github_tree`,
        };
      }
    } catch {
      /* a file that starts with "[": read it */
    }
  }
  if (looksBinary(bytes)) return { ok: false, error: `"${path}" is a binary file (${bytes.length.toLocaleString()} bytes) and cannot be read as text` };
  const text = bytes.toString("utf8").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  const start = Math.max(1, Math.min(totalLines || 1, Math.round(Number(line) || 1)));
  let end = start - 1;
  let used = 0;
  while (end < totalLines) {
    const next = lines[end].length + 1;
    if (used + next > budget && end >= start) break;
    used += next;
    end += 1;
  }
  /* one line longer than the whole budget: cut it, but say so */
  let body = lines.slice(start - 1, end).join("\n");
  let lineCut = false;
  if (body.length > budget) {
    body = body.slice(0, budget);
    lineCut = true;
  }
  return {
    ok: true,
    repo,
    ref: ref || "(default branch)",
    path,
    text: body,
    startLine: start,
    endLine: end,
    totalLines,
    totalChars: text.length,
    nextLine: end < totalLines ? end + 1 : 0,
    lineCut,
    url: `https://github.com/${repo}/blob/${ref || "HEAD"}/${path}`,
  };
}

/* ------------------------------------------------------------ search */

/** Code search (needs a logged-in gh) or repository search. */
export async function githubSearch({ query: rawQuery, repo: rawRepo, kind = "code", count = 10 } = {}) {
  const query = String(rawQuery || "")
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, 256);
  if (!query) return { ok: false, error: "no query given" };
  let repo = "";
  try {
    if (rawRepo) repo = parseRepo(parseGithubUrl(rawRepo)?.repo || rawRepo);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const k = kind === "repos" ? "repos" : "code";
  const n = Math.max(1, Math.min(GH_SEARCH_MAX, Math.round(Number(count) || 10)));
  const q = repo && k === "code" ? `${query} repo:${repo}` : query;
  const endpoint = k === "repos" ? "search/repositories" : "search/code";
  const r = await apiGet(`${endpoint}?q=${encodeURIComponent(q)}&per_page=${n}`);
  if (!r.ok) return r;
  const items = Array.isArray(r.json?.items) ? r.json.items : [];
  const results =
    k === "repos"
      ? items.map((it) => ({
          repo: it.full_name,
          description: it.description || "",
          stars: it.stargazers_count ?? 0,
          language: it.language || "",
          url: it.html_url,
        }))
      : items.map((it) => ({
          repo: it.repository?.full_name || repo,
          path: it.path,
          url: it.html_url,
        }));
  return { ok: true, kind: k, query: q, total: r.json?.total_count ?? results.length, results };
}
