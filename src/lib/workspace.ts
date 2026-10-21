/**
 * workspace_write: the model's one way to put a file on disk.
 *
 * Files land under ./workspace/model/… (server/workspace-write.mjs), the
 * model's own folder, the same way github_read's saves land under github/….
 * It can create, replace and append to files there, and nothing outside it.
 *
 * Pure: no fetch, no DOM. The request lives in `lib/api.ts`.
 */

export type WorkspaceWriteOutcome = {
  ok: boolean;
  /** where it landed, relative to ./workspace (always model/…) */
  path?: string;
  mode?: "create" | "overwrite" | "append";
  created?: boolean;
  bytes?: number;
  lines?: number;
  /** the whole file after the write, when small enough to pin */
  content?: string;
  /** a create that hit a taken name */
  exists?: boolean;
  error?: string;
};

/** Writes one turn may make. */
export const WS_MAX_WRITES_PER_TURN = 8;

export const WORKSPACE_TOOLS = [
  {
    type: "function",
    function: {
      name: "workspace_write",
      description:
        "Write a text file into the user's workspace, where they can open it and pin it to later turns. " +
        "Use it when the user asks you to write, save, create or export a file — code, notes, a config, " +
        "a report — instead of only pasting it in the reply. Files go under model/ in the workspace; " +
        "path is relative to that, e.g. notes/plan.md or src/retry.py. Write the whole file in content. " +
        "mode 'create' (default) fails if the file exists; use 'overwrite' to replace a file you wrote " +
        "earlier, or 'append' to add to its end.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "file path inside the workspace's model/ folder, e.g. notes/plan.md" },
          content: { type: "string", description: "the full text of the file (or the text to add, with append)" },
          mode: {
            type: "string",
            enum: ["create", "overwrite", "append"],
            description: "create (default, fails if it exists), overwrite, or append",
          },
        },
        required: ["path", "content"],
      },
    },
  },
];

/** What the model reads back after a write. */
export function writeText(args: { path?: string }, out: WorkspaceWriteOutcome): string {
  if (!out.ok) {
    return [
      `### Could not write ${out.path || args.path || "that file"}`,
      `${out.error || "no reason given"}.`,
      out.exists ? "Call workspace_write again with mode overwrite or append if that is what you meant." : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const verb = out.mode === "append" ? (out.created ? "Created" : "Appended to") : out.created ? "Created" : "Replaced";
  return [
    `### ${verb} ${out.path}`,
    `${out.lines} line${out.lines === 1 ? "" : "s"}, ${out.bytes} bytes, now in the user's workspace at ./workspace/${out.path}.`,
    "Tell the user where the file is; do not paste its whole content again unless they ask.",
  ].join("\n");
}

/** One line for the notice bar under the chat. */
export function writeNotice(out: WorkspaceWriteOutcome, asked: string): string {
  if (!out.ok) return `The model could not write ${out.path || asked || "a file"}: ${out.error || "no reason given"}`;
  const how = out.mode === "append" && !out.created ? "appended to" : out.created ? "written" : "replaced";
  return `${out.path} → ${how} in ./workspace by the model · tick it in the tree to pin it`;
}
