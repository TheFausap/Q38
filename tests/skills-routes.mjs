/**
 * The skills' server half: reading the folder, searching it, and the routes.
 *
 *   node tests/skills-routes.mjs
 *
 * Runs against a temporary skills folder built here, so it needs neither the
 * network nor `npm run skills:sync`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const results = [];
const check = (ok, msg) => {
  results.push(`${ok ? "·" : "✗"} ${msg}`);
  if (!ok) throw new Error(msg);
};

/* ------------------------------------------------------------ fixtures */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q38-skills-test-"));
const root = path.join(tmp, "skills");
const outside = path.join(tmp, "secret.md");
fs.writeFileSync(outside, "SECRET — must never be readable through a skill");

function skill(folder, frontmatter, body, extra = {}) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  for (const [rel, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

skill(
  "qutip",
  [
    "name: qutip",
    'description: "Simulates open quantum systems with QuTiP: Lindblad master equations, Monte Carlo trajectories."',
    "allowed-tools: Read Bash",
    "license: MIT",
    "metadata:",
    "  version: \"1.0\"",
    "  skill-author: test",
  ].join("\n"),
  "# QuTiP\n\nUse `mesolve` for the Lindblad master equation. Collapse operators go in c_ops.\n",
  {
    "references/time_evolution.md": "# Time evolution\nmesolve, mcsolve, sesolve.\n",
    "scripts/check.py": "print('hello')\n",
    "assets/plot.png": "\x89PNG not text",
  },
);
skill(
  "pymc",
  "name: pymc\ndescription: >\n  Bayesian modelling with PyMC: hierarchical models,\n  NUTS sampling and posterior checks.",
  "# PyMC\n\nHierarchical model with partial pooling. Sample with NUTS.\n",
);
skill("broken", "name: broken", "# no description, so not a skill\n");
fs.mkdirSync(path.join(root, "no-skill-md"));
fs.mkdirSync(path.join(root, ".hidden"));
skill(".hidden", "name: hidden\ndescription: should never be listed", "x");

process.env.Q38_SKILLS_DIR = root;
const { loadIndex, parseFrontmatter, publicIndex, readSkill, searchSkills, SKILL_MAX_CHARS } = await import(
  "../server/skills.mjs"
);
const { createApi } = await import("../server/api.mjs");

const API_PORT = 18000 + Math.floor(Math.random() * 1000);
const api = createApi();
const server = http.createServer((req, res) => api(req, res, () => res.end("{}")));
await new Promise((r) => server.listen(API_PORT, "127.0.0.1", r));
const get = async (p) => {
  const res = await fetch(`http://127.0.0.1:${API_PORT}${p}`);
  return { status: res.status, json: await res.json() };
};

try {
  /* -------------------------------------------------------- frontmatter */
  {
    const { meta, body } = parseFrontmatter('---\nname: a\ndescription: "quoted: value"\nnested:\n  k: v\n---\n# Body');
    check(meta.name === "a", "a plain value is read");
    check(meta.description === "quoted: value", "quotes are taken off, colons inside kept");
    check(!("k" in meta) && !("nested" in meta), "nested maps are skipped rather than misread");
    check(body === "# Body", "the body is what follows the frontmatter");
    const folded = parseFrontmatter("---\ndescription: >\n  one\n  two\n---\n").meta.description;
    check(folded === "one two", `a folded value is joined (${folded})`);
    check(parseFrontmatter("# no frontmatter").body === "# no frontmatter", "a file without frontmatter is all body");
  }

  /* -------------------------------------------------------------- index */
  {
    const index = loadIndex(root);
    const names = index.skills.map((s) => s.name);
    assert.deepEqual(names, ["pymc", "qutip"], `only real skills are listed, sorted: ${names.join(", ")}`);
    check(true, "folders without a SKILL.md, without a description, or hidden are skipped");
    check(/hierarchical models, NUTS/.test(index.skills[0].description), "a folded description is one line");
    const pub = publicIndex(index);
    check(pub.skills.every((s) => !("body" in s)), "the public index carries no bodies");
    check(loadIndex(path.join(tmp, "nope")).missing === true, "a missing folder says so instead of throwing");
  }

  /* ------------------------------------------------------------- search */
  {
    const index = loadIndex(root);
    check(searchSkills(index, "Lindblad master equation")[0]?.name === "qutip", "a method finds its library");
    check(searchSkills(index, "hierarchical bayesian")[0]?.name === "pymc", "and the other way round");
    check(searchSkills(index, "the of and").length === 0, "stop words alone find nothing");
    check(searchSkills(index, "", 5).length === 0, "an empty query finds nothing");
  }

  /* --------------------------------------------------------------- read */
  {
    const index = loadIndex(root);
    const q = readSkill(index, "qutip");
    check(q.ok && /mesolve/.test(q.text), "a skill reads as its body");
    check(!/^---/.test(q.text) && !/allowed-tools/.test(q.text), "without its frontmatter");
    check(q.files.includes("references/time_evolution.md") && q.files.includes("scripts/check.py"), "with its files listed");
    check(!q.files.some((f) => f.endsWith(".png")), "binary files are not offered");
    const ref = readSkill(index, "qutip", { file: "references/time_evolution.md" });
    check(ref.ok && ref.file === "references/time_evolution.md" && /mcsolve/.test(ref.text), "a reference file can be read");
    const esc = readSkill(index, "qutip", { file: "../../secret.md" });
    check(!esc.ok && !/SECRET/.test(JSON.stringify(esc)), "a path out of the skill's folder is refused");
    const abs = readSkill(index, "qutip", { file: outside });
    check(!abs.ok && !/SECRET/.test(JSON.stringify(abs)), "and so is an absolute path");
    const bin = readSkill(index, "qutip", { file: "assets/plot.png" });
    check(!bin.ok && /not a text file/.test(bin.error), "a binary file is refused by name");
    const miss = readSkill(index, "qutipp");
    check(!miss.ok && miss.suggestions.includes("qutip"), "a typo gets the nearest name back");
    const cut = readSkill(index, "qutip", { chars: 10 });
    check(cut.chars >= 50 && cut.chars <= 1000, `a tiny budget is raised to something readable (${cut.chars})`);
    check(SKILL_MAX_CHARS >= 24000, "the ceiling holds a full SKILL.md");
  }

  /* ------------------------------------------------------------- routes */
  {
    const index = await get("/api/skills/index");
    check(index.status === 200 && index.json.skills.length === 2, "GET /api/skills/index lists the folder");
    const search = await get("/api/skills/search?q=master%20equation");
    check(search.json.results[0]?.name === "qutip", "GET /api/skills/search ranks");
    const read = await get("/api/skills/read?name=pymc");
    check(read.status === 200 && /partial pooling/.test(read.json.text), "GET /api/skills/read returns the text");
    const bad = await get("/api/skills/read?name=qutip&file=..%2F..%2Fsecret.md");
    check(bad.status === 404 && !/SECRET/.test(JSON.stringify(bad.json)), "and refuses an escape over HTTP too");
    const none = await get("/api/skills/read?name=nothing-like-this");
    check(none.status === 404 && none.json.ok === false, "an unknown skill is a 404 with a reason");
  }

  console.log(results.join("\n"));
  console.log(`skill route checks passed (${results.length})`);
} catch (err) {
  console.error(results.join("\n"));
  console.error("SKILL ROUTE TEST FAILED:", err.message);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
