/**
 * Inline markdown for the reply view: code spans, bold, italics, links.
 *
 * Code spans are set aside before anything else runs, so nothing inside one
 * is ever formatted — an asterisk in `M*` or `a * b` must not pair with the
 * opening asterisk of a later *word* and italicise everything in between.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Matching backtick runs (`` `x` ``, ``` ``a ` b`` ```), as CommonMark pairs them. */
const CODE_SPAN = /(`+)([\s\S]*?[^`])\1(?!`)/g;

export function inline(text: string): string {
  const spans: string[] = [];
  let s = String(text ?? "").replace(CODE_SPAN, (_, _ticks: string, body: string) => {
    const inner = body.length > 2 && body.startsWith(" ") && body.endsWith(" ") ? body.slice(1, -1) : body;
    return `\u0000C${spans.push(`<code>${escapeHtml(inner)}</code>`) - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s.replace(/\u0000C(\d+)\u0000/g, (_, i: string) => spans[Number(i)] ?? "");
}
