#!/usr/bin/env node
/**
 * Fill the skills folder from K-Dense's scientific-agent-skills.
 *
 *   npm run skills:sync                  the curated set below
 *   npm run skills:sync -- sympy qutip   exactly these
 *   npm run skills:sync -- --add pysam   the curated set plus these
 *   npm run skills:sync -- --all         every skill in the library (~177)
 *   npm run skills:sync -- --list        what the library has, and stop
 *
 * Only the chosen folders are fetched (a sparse, shallow clone). Skills this
 * script installed before and that are no longer chosen are removed; any other
 * folder in skills/ — your own skills — is left alone.
 *
 * Env: Q38_SKILLS_DIR (default ./skills), Q38_SKILLS_REPO, Q38_SKILLS_REF.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = process.env.Q38_SKILLS_REPO || "https://github.com/K-Dense-AI/scientific-agent-skills.git";
const REF = process.env.Q38_SKILLS_REF || "";
const DEST = path.resolve(process.cwd(), process.env.Q38_SKILLS_DIR || "./skills");
const MANIFEST = path.join(DEST, ".source.json");

/**
 * Physics, maths, statistics, ML and research method — and nothing that needs an
 * API key to be useful. `paper-lookup` pairs with web_fetch: its endpoints are
 * public JSON and Atom APIs the model can read directly.
 */
export const CURATED = [
  // physics & maths
  "sympy",
  "astropy",
  "qutip",
  "qiskit",
  "pennylane",
  "fluidsim",
  "uncertainty-and-units",
  // statistics & inference
  "statistical-analysis",
  "statsmodels",
  "pymc",
  "experimental-design",
  // machine learning
  "transformers",
  "pytorch-lightning",
  "torch-geometric",
  // figures
  "matplotlib",
  "scientific-visualization",
  // research method & writing
  "paper-lookup",
  "scientific-critical-thinking",
  "hypothesis-generation",
  "scientific-brainstorming",
  "peer-review",
  "scientific-writing",
];

function git(args, cwd) {
  const out = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (out.error) throw new Error(`git is not available: ${out.error.message}`);
  if (out.status !== 0) throw new Error(`git ${args[0]} failed:\n${(out.stderr || out.stdout).trim()}`);
  return out.stdout.trim();
}

function parseArgs(argv) {
  const opts = { all: false, list: false, add: [], only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") opts.all = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--add") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) opts.add.push(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
      process.exit(0);
    } else if (!a.startsWith("--")) opts.only.push(a);
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  } catch {
    return { skills: [] };
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q38-skills-"));
  try {
    console.log(`fetching the skill list from ${REPO}…`);
    const clone = ["clone", "--depth", "1", "--filter=blob:none", "--sparse"];
    if (REF) clone.push("--branch", REF);
    git([...clone, REPO, tmp]);
    const available = git(["ls-tree", "--name-only", "HEAD", "skills/"], tmp)
      .split("\n")
      .map((p) => p.replace(/^skills\//, ""))
      .filter(Boolean)
      .sort();

    if (opts.list) {
      console.log(`${available.length} skills:\n${available.join("  ")}`);
      return;
    }

    const wanted = opts.all
      ? available
      : [...new Set([...(opts.only.length ? opts.only : CURATED), ...opts.add])];
    const missing = wanted.filter((s) => !available.includes(s));
    if (missing.length) console.warn(`not in the library, skipped: ${missing.join(", ")}`);
    const chosen = wanted.filter((s) => available.includes(s));
    if (!chosen.length) throw new Error("nothing to install");

    console.log(`fetching ${chosen.length} skill${chosen.length === 1 ? "" : "s"}…`);
    git(["sparse-checkout", "set", "--no-cone", ...chosen.map((s) => `/skills/${s}/`)], tmp);
    const commit = git(["rev-parse", "--short", "HEAD"], tmp);

    fs.mkdirSync(DEST, { recursive: true });
    const before = readManifest().skills ?? [];
    for (const old of before) {
      if (!chosen.includes(old)) fs.rmSync(path.join(DEST, old), { recursive: true, force: true });
    }
    for (const name of chosen) {
      const from = path.join(tmp, "skills", name);
      const to = path.join(DEST, name);
      if (!fs.existsSync(path.join(from, "SKILL.md"))) {
        console.warn(`${name} has no SKILL.md upstream, skipped`);
        continue;
      }
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
    }
    const removed = before.filter((s) => !chosen.includes(s));
    fs.writeFileSync(
      MANIFEST,
      JSON.stringify({ repo: REPO, commit, syncedAt: new Date().toISOString(), skills: chosen }, null, 2) + "\n",
    );
    console.log(
      `installed ${chosen.length} skills from ${commit} into ${DEST}` +
        (removed.length ? `; removed ${removed.join(", ")}` : "") +
        ". The workbench picks them up within a few seconds (Setup → rescan).",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`skills:sync failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
