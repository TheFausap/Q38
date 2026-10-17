/**
 * The tool briefing: a few lines at the top of the system message saying
 * which tools this turn has and that they are real.
 *
 * Tools reach the model only as JSON schemas rendered by the chat template.
 * A model trained to say "I cannot browse" will often say exactly that —
 * especially in a long reasoning mode, and especially once the transcript
 * already holds one such refusal — unless it is told in plain words that the
 * tools exist. The briefing is written from the tools actually offered on the
 * turn, so it never promises one that is not there.
 */
type ToolDef = { function?: { name?: string } };

const PURPOSE: Record<string, string> = {
  web_search: "search the web",
  web_fetch: "read a web page",
  doc_add: "download a PDF or long document into the library (and OCR it when asked)",
  doc_search: "search the library's documents",
  doc_read: "read a document's outline or a whole section",
  skill_load: "load a procedure manual for a library or method",
  skill_search: "find a procedure manual",
  recall: "read earlier conversation back off the disk",
};

export function toolNames(tools: unknown[] | undefined): string[] {
  return (tools ?? [])
    .map((t) => (t as ToolDef)?.function?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

/** The briefing for these tools, or "" when there are none. */
export function toolBriefing(tools: unknown[] | undefined): string {
  const names = toolNames(tools);
  if (!names.length) return "";
  const has = (n: string) => names.includes(n);
  const lines = [
    "## Tools available in this conversation",
    "You are connected to tools that the workbench runs for you. Call them by name; their results come back to you in this conversation.",
    ...names.map((n) => `- ${n}: ${PURPOSE[n] ?? "see its description"}`),
  ];
  const can: string[] = [];
  if (has("web_search") || has("web_fetch")) can.push("you DO have internet access through web_search and web_fetch");
  if (has("doc_add")) can.push("you CAN download and read PDFs and papers through doc_add, then doc_search and doc_read");
  if (can.length) {
    lines.push(
      "",
      `Because of these tools, ${can.join(", and ")}. Never tell the user that you cannot browse, ` +
        "download, open links or read papers — call the tool instead. If a tool call fails, say what failed and why.",
    );
  }
  if (has("doc_add")) {
    lines.push(
      "To work from a paper: doc_add(url) once, then doc_search for the passage or doc_read for a section, " +
        "and quote it with section and page. Answer about a paper from what you read, not from memory.",
    );
  }
  return lines.join("\n");
}
