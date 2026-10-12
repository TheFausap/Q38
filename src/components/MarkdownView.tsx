import { useMemo, useState } from "react";
import { extForLang } from "../lib/api";
import { escapeHtml, highlight } from "../lib/highlight";
import { renderKatex, splitMath } from "../lib/math";

type Block =
  | { type: "code"; lang: string; code: string; closed: boolean }
  | { type: "text"; text: string };

function splitBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < src.length) {
    const start = src.indexOf("```", i);
    if (start === -1) {
      if (i < src.length) blocks.push({ type: "text", text: src.slice(i) });
      break;
    }
    if (start > i) blocks.push({ type: "text", text: src.slice(i, start) });
    const after = start + 3;
    const nl = src.indexOf("\n", after);
    const langEnd = nl === -1 ? src.length : nl;
    const lang = src.slice(after, langEnd).trim().split(/\s+/)[0] || "";
    const bodyStart = nl === -1 ? src.length : nl + 1;
    const end = src.indexOf("```", bodyStart);
    if (end === -1) {
      blocks.push({ type: "code", lang, code: src.slice(bodyStart), closed: false });
      break;
    }
    blocks.push({
      type: "code",
      lang,
      code: src.slice(bodyStart, end).replace(/\n$/, ""),
      closed: true,
    });
    i = end + 3;
    if (src[i] === "\n") i += 1;
  }
  return blocks;
}

function inline(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(
    /\[([^\]]+)\]\((https?:[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  return s;
}

function renderText(text: string): string {
  const lines = text.split("\n");
  const html: string[] = [];
  let i = 0;
  let list: string[] | null = null;
  let listType: "ul" | "ol" | null = null;

  const flushList = () => {
    if (list && listType) {
      html.push(`<${listType}>${list.join("")}</${listType}>`);
    }
    list = null;
    listType = null;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|.+\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*-/.test(lines[i + 1])) {
      flushList();
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = lines[i]
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
        if (!/^[-: ]+$/.test(cells.join("").replace(/-/g, "-"))) {
          if (!cells.every((c) => /^[-:]+$/.test(c))) rows.push(cells);
        }
        i++;
      }
      if (rows.length) {
        const head = rows[0];
        const body = rows.slice(1);
        html.push(
          `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`,
        );
      }
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ul || ol) {
      const nextType = ul ? "ul" : "ol";
      if (listType !== nextType) {
        flushList();
        listType = nextType;
        list = [];
      }
      list!.push(`<li>${inline((ul || ol)![1])}</li>`);
      i++;
      continue;
    }
    flushList();
    if (/^###\s+/.test(line)) html.push(`<h3>${inline(line.replace(/^###\s+/, ""))}</h3>`);
    else if (/^##\s+/.test(line)) html.push(`<h2>${inline(line.replace(/^##\s+/, ""))}</h2>`);
    else if (/^#\s+/.test(line)) html.push(`<h1>${inline(line.replace(/^#\s+/, ""))}</h1>`);
    else if (/^>\s?/.test(line)) html.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
    else if (/^\s*---+\s*$/.test(line)) html.push("<hr/>");
    else if (line.trim() === "") html.push("");
    else html.push(`<p>${inline(line)}</p>`);
    i++;
  }
  flushList();
  return html.join("\n");
}

function renderTextWithMath(text: string): string {
  const pieces = splitMath(text);
  const slots: string[] = [];
  const masked = pieces
    .map((p, i) => {
      if (p.type !== "math") return p.text;
      slots[i] = renderKatex(p.tex, p.display, p.closed);
      return p.display ? `\n\n@@MATH${i}@@\n\n` : `@@MATH${i}@@`;
    })
    .join("");
  let html = renderText(masked);
  html = html.replace(/<p>\s*@@MATH(\d+)@@\s*<\/p>/g, (_, n) => slots[Number(n)] || "");
  html = html.replace(/@@MATH(\d+)@@/g, (_, n) => slots[Number(n)] || "");
  return html;
}

function CodeBlock({ lang, code, closed }: { lang: string; code: string; closed: boolean }) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => (closed ? highlight(code, lang || undefined) : escapeHtml(code)), [code, lang, closed]);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const download = () => {
    const ext = extForLang(lang || "txt");
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `snippet.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span className="code-lang">{lang || "code"}</span>
        <span className="grow" />
        <button type="button" className="icon-btn" onClick={copy}>
          {copied ? "copied" : "copy"}
        </button>
        <button type="button" className="icon-btn" onClick={download}>
          save
        </button>
      </div>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

export function MarkdownView({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className="md">
      {blocks.map((b, i) =>
        b.type === "code" ? (
          <CodeBlock key={i} lang={b.lang} code={b.code} closed={b.closed} />
        ) : (
          <div key={i} dangerouslySetInnerHTML={{ __html: renderTextWithMath(b.text) }} />
        ),
      )}
    </div>
  );
}
