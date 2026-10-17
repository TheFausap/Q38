/**
 * The skills' client half: what the model is offered, and what it reads back.
 *
 *   node --experimental-strip-types tests/skills.test.ts
 *
 * Pure functions only; the folder and the routes live in `tests/skills-routes.mjs`.
 */
import assert from "node:assert/strict";
import {
  SKILL_INLINE_LIMIT,
  catalogueText,
  shortDescription,
  skillSearchText,
  skillTapeLine,
  skillText,
  skillTools,
  type SkillSummary,
} from "../src/lib/skills.ts";

const few: SkillSummary[] = [
  { name: "qutip", description: "Simulates open quantum systems. Use for master equations.", chars: 9000 },
  { name: "sympy", description: "Symbolic mathematics with SymPy.", chars: 12000 },
];
const many: SkillSummary[] = Array.from({ length: SKILL_INLINE_LIMIT + 5 }, (_, i) => ({
  name: `skill-${i}`,
  description: `Skill number ${i}.`,
  chars: 1000,
}));

type Tool = {
  type: string;
  function: { name: string; description: string; parameters: { properties: Record<string, any>; required: string[] } };
};

/* --------------------------------------------------------------- offer */
{
  assert.deepEqual(skillTools(null), [], "no index, no tools");
  assert.deepEqual(skillTools({ ok: true, skills: [] }), [], "an empty folder offers nothing");

  const small = skillTools({ ok: true, skills: few }) as Tool[];
  assert.equal(small.length, 1, "a small library needs only skill_load");
  const load = small[0].function;
  assert.equal(load.name, "skill_load");
  assert.match(load.description, /- qutip: Simulates open quantum systems\./, "the catalogue lists each skill");
  assert.doesNotMatch(load.description, /master equations/, "with the first sentence only");
  assert.deepEqual(load.parameters.properties.name.enum, ["qutip", "sympy"], "names are an enum the model cannot misspell");
  assert.deepEqual(load.parameters.required, ["name"]);
  assert.match(load.description, /cannot run code/i, "the model is told it cannot execute a skill");
  assert.match(load.description, /does not override the user/i, "and that a skill is not an authority over the user");

  const big = skillTools({ ok: true, skills: many }) as Tool[];
  assert.deepEqual(
    big.map((t) => t.function.name),
    ["skill_search", "skill_load"],
    "a large library is searched, not listed",
  );
  assert.ok(!("enum" in big[1].function.parameters.properties.name), "and names are free text there");
  assert.ok(big[1].function.description.length < 1200, "the large-library offer stays small");
}

/* ------------------------------------------------------------ catalogue */
{
  assert.equal(shortDescription("One. Two."), "One.");
  const long = shortDescription("x".repeat(500));
  assert.ok(long.length <= 120 && long.endsWith("…"), "a long line is cut with an ellipsis");
  assert.equal(catalogueText(few).split("\n").length, 2, "one line per skill");
}

/* ---------------------------------------------------------- read-backs */
{
  const ok = skillText("qutip", {
    ok: true,
    name: "qutip",
    file: "SKILL.md",
    text: "# QuTiP\nmesolve",
    chars: 15,
    totalChars: 15,
    truncated: false,
    files: ["references/a.md"],
  });
  assert.match(ok, /^### Skill: qutip\n/, "headed by the skill's name");
  assert.match(ok, /# QuTiP\nmesolve/, "verbatim body");
  assert.match(ok, /cannot execute/i, "with the no-execution reminder");
  assert.match(ok, /file=…\): references\/a\.md/, "and the files it could open next");

  const cut = skillText("qutip", { ok: true, name: "qutip", file: "references/a.md", text: "x", chars: 1, totalChars: 9, truncated: true });
  assert.match(cut, /### Skill: qutip · references\/a\.md/, "a reference file is named");
  assert.match(cut, /\(cut —/, "a cut is admitted");

  const miss = skillText("qutipp", { ok: false, error: 'there is no skill named "qutipp"', suggestions: ["qutip"] });
  assert.match(miss, /Closest names: qutip\./, "a miss carries the nearest names");

  assert.match(skillSearchText("q", { ok: true, results: [] }), /No skill matches/);
  assert.match(
    skillSearchText("master eq", { ok: true, results: [{ ...few[0], score: 3 }] }),
    /1\. qutip — Simulates open quantum systems\./,
  );
  assert.match(skillSearchText("q", { ok: false, error: "down" }), /failed/);

  assert.equal(
    skillTapeLine("qutip", { ok: true, name: "qutip", file: "SKILL.md", chars: 14089 }),
    "SKILL: QUTIP · 14.1k CHARS",
  );
  assert.match(skillTapeLine("x", { ok: false, error: "nope" }), /FAILED · NOPE/);
}

console.log("skill checks passed");
