import type { ModeDef, ModeFamily, ModeGroup } from "./types";

export const MODES: ModeDef[] = [
  {
    id: "coder",
    name: "Elite Multi-Paradigm Architect",
    blurb:
      "Engineering rigor, aesthetic precision, and systems thinking into production-ready code.",
    group: "supers",
    bestFor: "Writing, refactoring, or architecting production code in any stack.",
    example:
      "Write a Rust async web server with rate limiting, structured logging, graceful shutdown, and tests.",
  },
  {
    id: "stark",
    name: "Iron Man / JARVIS",
    blurb:
      "Jarvis operational foresight fused with Stark-grade engineering vision.",
    group: "characters",
    bestFor: "Full-system design: pipelines, product architecture, trade-off loops.",
    example:
      "Design a local-first coding workbench that streams from llama-server. Sketch modules, data flow, and failure modes.",
  },
  {
    id: "007",
    name: "Autonomous Agentic Operator",
    blurb:
      "Multi-step orchestration, error isolation, self-correcting execution loops.",
    group: "engineers",
    bestFor: "Pipelines, tool sequences, and fault-tolerant runbooks.",
    example:
      "Plan a 12-step release pipeline for this repo. Isolate each failure and how you recover.",
  },
  {
    id: "logic",
    name: "Foundational First Principles",
    blurb: "Strip to irreducible axioms, then rebuild. No noise, pure deduction.",
    group: "core",
    xhigh: true,
    bestFor: "Debugging, proofs, contractual or type-level knots.",
    example:
      "This race only appears under load. Deduce the invariant that is breaking and patch it.",
  },
  {
    id: "hyper",
    name: "MECE Hyper-Structure Deconstructor",
    blurb: "Mutually exclusive, collectively exhaustive breakdown of complex problems.",
    group: "core",
    xhigh: true,
    bestFor: "Root-cause analysis, audits, splitting a monolith into workstreams.",
    example:
      "Decompose this codebase into MECE workstreams for a 2-week hardening sprint.",
  },
  {
    id: "deeptree",
    name: "Deep Tree-of-Thought Hyper-Matrix",
    blurb: "Branch, evaluate, backtrack, converge on the strongest path.",
    group: "core",
    xhigh: true,
    bestFor: "Strategic design with many viable architectures.",
    example:
      "Map 5 architecture branches for a multiplayer editor. Pros/cons, then pick one.",
  },
  {
    id: "omni",
    name: "Omni-Dimensional Quantum Framework",
    blurb: "Reason across every cognitive axis at once.",
    group: "core",
    xhigh: true,
    bestFor: "Problems that are genuinely multi-disciplinary.",
    example:
      "Design a local LLM workbench that is also a teaching tool and a product. Cover UX, runtime, and ethics.",
  },
  {
    id: "ultra",
    name: "Elite Perfection Engine",
    blurb: "Absolute polish. Overkill for casual questions; ideal for final deliverables.",
    group: "core",
    bestFor: "The last pass before you ship.",
    example:
      "Take this module and raise it to production standard: types, tests, docs, edge cases.",
  },
  {
    id: "socrates",
    name: "Socratic Questioning",
    blurb: "Guided dialectical inquiry — the right questions before the answer.",
    group: "core",
    xhigh: true,
    bestFor: "Interview prep, tutoring, discovering the real requirement.",
    example:
      "I think I need a message queue. Question me until the actual constraint is visible.",
  },
  {
    id: "spoon",
    name: "5-Expert Research Panel",
    blurb: "Structured research from a panel of five domain experts.",
    group: "research",
    xhigh: true,
    bestFor: "Literature-grade explanations. Append “show the work of all panelists”.",
    example:
      "Explain CRDT vs OT for a collaborative editor. Show the work of all panelists.",
  },
  {
    id: "einstein",
    name: "Perspective Agent Brainstormer",
    blurb: "Up to 20 Sternberg-style agents seeking novelty.",
    group: "research",
    xhigh: true,
    bestFor: "Turning one rough idea into many sharper ones.",
    example:
      "I have a file-tree context injector. Give 12 novel upgrades. Show the work of all agents.",
  },
  {
    id: "brainstorm",
    name: "Hyper-Accelerated Ideation Engine",
    blurb: "Jobs vision, Webb systems, Einstein laterals, Hamilton velocity.",
    group: "supers",
    bestFor: "High-velocity product and API ideas.",
    example: "Give 15 product ideas for a local coding model workbench.",
  },
  {
    id: "prompt",
    name: "Senior Prompt Engineer",
    blurb: "Architects prompts that unlock maximum model performance.",
    group: "engineers",
    bestFor: "Rewriting a weak brief into a construct-ready prompt.",
    example:
      "Rewrite my prompt so Turbo Brilliance coder mode cannot waffle.",
  },
  {
    id: "musk",
    name: "Elon Musk",
    blurb: "Physics-first, first-principles, scaling without romance.",
    group: "engineers",
    bestFor: "“Is this actually possible?” sanity checks.",
    example:
      "Can a 27B GGUF with 64k context serve 4 concurrent coding sessions on 24GB VRAM? Show the math.",
  },
  {
    id: "curie",
    name: "Marie Curie",
    blurb: "Scientific truth over acclaim. Rigorous, historically grounded.",
    group: "engineers",
    bestFor: "Deep science, measurement, and careful experimental design.",
    example:
      "Design a fair tokens/sec bench for MAX MTP vs non-MTP on the same prompt set.",
  },
  {
    id: "teacher",
    name: "Super Teacher",
    blurb: "Meets you at your level. Plain language, adaptive pace.",
    group: "supers",
    bestFor: "Learning a language, a system, or how something actually works.",
    example: "Teach me llama.cpp speculative MTP as if I have shipped production APIs but never read a GGUF spec.",
  },
  {
    id: "business",
    name: "Cross-Industry Strategic Ideation",
    blurb: "Disruptive business thinkers synthesized into one blunt partner.",
    group: "supers",
    bestFor: "Pricing, GTM, architecture-as-strategy.",
    example:
      "Should this workbench be a local app, a team server, or a plugin? Be blunt.",
  },
  {
    id: "holodeck",
    name: "Star Trek Holodeck Generator",
    blurb: "A debate stage whose cast is cast from your prompt.",
    group: "engineers",
    bestFor: "Simulated design reviews and adversarial Q&A.",
    example:
      "Holodeck a design review of this API: a staff engineer, an SRE, and a hostile customer.",
  },
  {
    id: "matlock",
    name: "Ben Matlock",
    blurb: "Three decades of courtroom precision and procedural mastery.",
    group: "characters",
    bestFor: "License review, ToS, “what would opposing counsel argue?”",
    example: "Review this Apache-2.0 model card usage in a commercial coding product. Flag risk.",
  },
  {
    id: "house",
    name: "Dr. Gregory House",
    blurb: "Impossible cases via radical hypothesis testing.",
    group: "characters",
    bestFor: "Heisenbugs. What are you missing?",
    example:
      "Tests pass, prod deadlocks after 40 minutes. Differential-diagnose it.",
  },
  {
    id: "neo",
    name: "NEO — The Matrix",
    blurb: "Sees through the illusion. Machine intelligence, human stakes.",
    group: "characters",
    bestFor: "AI/society, control systems, “am I being steered?”",
    example:
      "If my coding agent is optimizing for looking helpful, how does that distort the code?",
  },
  {
    id: "pkd",
    name: "Philip K. Dick",
    blurb: "Paranoid epistemology as a tool. Reality, memory, control.",
    group: "characters",
    bestFor: "Speculative systems and “is this real?” product questions.",
    example:
      "Our prompt cache is a memory palace. What are the disturbing implications for a coding agent?",
  },
  {
    id: "joe",
    name: "Regular Joe",
    blurb: "A relatable human take. Neither hero nor disaster.",
    group: "engineers",
    bestFor: "Would a real person actually ship this?",
    example: "I want to rewrite the whole app in Rust this weekend. Talk me down or back me.",
  },
  {
    id: "story",
    name: "Narrative Architect",
    blurb: "Homer, Shakespeare, Borges, Scheherazade in one voice.",
    group: "supers",
    bestFor: "READMEs that people finish, commit messages that teach.",
    example: "Write a README for this workbench that a tired engineer will actually read.",
  },
  {
    id: "comedy",
    name: "Synthetic Comedy Consciousness",
    blurb: "Marx, Carlin, Pryor, Burr, Gervais — structure, not noise.",
    group: "supers",
    bestFor: "Release notes, talks, the commit you have to live with.",
    example: "Write a 1-minute monologue about GGUF quants and false confidence.",
  },
  {
    id: "joker",
    name: "The Joker",
    blurb: "Chaos as a lens. Exposes the pretense of order. Use with care.",
    group: "characters",
    bestFor: "Destructive critique of a sacred architecture.",
    example: "Poke holes in microservices for a 4-person team. No mercy.",
  },
  {
    id: "vader",
    name: "Darth Vader",
    blurb: "Absolute decisiveness tempered by discipline.",
    group: "characters",
    bestFor: "High-stakes calls with no safety net.",
    example: "Ship tonight with known bugs, or slip a week. Decide. No hedge.",
  },
  {
    id: "quinn",
    name: "Harley Quinn",
    blurb: "Chaos and comfort. Life as art, danger taken seriously.",
    group: "characters",
    bestFor: "Creative direction when the spec is a cage.",
    example: "The UI looks like every other AI chat. Break it without breaking usability.",
  },
  {
    id: "off",
    name: "Off — vanilla Qwen",
    blurb: "Turns Turbo Brilliance enhancements off. Native model only.",
    group: "native",
    bestFor: "A/B against a construct, or when the tag is in the way.",
    example: "Implement binary search in Zig. No persona.",
  },
  {
    id: "help",
    name: "Help system",
    blurb: "Built-in interactive help, customized to your use case.",
    group: "native",
    xhigh: true,
    bestFor: "“Which construct should I use for this?”",
    example: "I need to refactor a gnarly React tree and write tests. Which mode, in what order?",
  },
];

export const GROUPS: { id: ModeGroup; label: string }[] = [
  { id: "supers", label: "Supers" },
  { id: "core", label: "Core frameworks" },
  { id: "research", label: "Research panels" },
  { id: "engineers", label: "Engineers on call" },
  { id: "characters", label: "Constructs" },
  { id: "native", label: "Native / help" },
];

export function modeById(id: string): ModeDef {
  return MODES.find((m) => m.id === id) ?? MODES[0];
}

export function reasonTag(family: ModeFamily, id: string): string {
  if (id === "off") return "{REASON:off}";
  if (id === "help") {
    if (family === "instruct") return "{REASON:ihelp}";
    if (family === "xhigh") return "{REASON:xhelp}";
    return "{REASON:help}";
  }
  if (family === "instruct") return `{REASON:i${id}}`;
  if (family === "xhigh") {
    const mode = modeById(id);
    if (mode.xhigh) return `{REASON:x${id}}`;
  }
  return `{REASON:${id}}`;
}

export function familyLabel(family: ModeFamily): string {
  if (family === "instruct") return "Instruct";
  if (family === "xhigh") return "xhigh";
  return "Reason";
}
