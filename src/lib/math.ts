import katex from "katex";

export type MathPiece =
  | { type: "text"; text: string }
  | { type: "math"; tex: string; display: boolean; closed: boolean };

const MATH_ENV =
  /^(equation|align|aligned|gather|gathered|multline|eqnarray|flalign|alignat|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|smallmatrix|cases|split|CD)\*?$/;

type Hit = { start: number; end: number; piece: MathPiece };

export function splitMath(src: string): MathPiece[] {
  const pieces: MathPiece[] = [];
  let i = 0;
  while (i < src.length) {
    const hit = findMath(src, i);
    if (!hit) {
      if (i < src.length) pieces.push({ type: "text", text: src.slice(i) });
      break;
    }
    if (hit.start > i) pieces.push({ type: "text", text: src.slice(i, hit.start) });
    pieces.push(hit.piece);
    i = hit.end;
  }
  return pieces;
}

function findMath(src: string, from: number): Hit | null {
  for (let j = from; j < src.length; j++) {
    if (src.startsWith("$$", j)) {
      const close = src.indexOf("$$", j + 2);
      if (close === -1) {
        return {
          start: j,
          end: src.length,
          piece: { type: "math", tex: src.slice(j + 2), display: true, closed: false },
        };
      }
      return {
        start: j,
        end: close + 2,
        piece: { type: "math", tex: src.slice(j + 2, close).trim(), display: true, closed: true },
      };
    }

    if (src.startsWith("\\[", j)) {
      const close = src.indexOf("\\]", j + 2);
      if (close === -1) {
        return {
          start: j,
          end: src.length,
          piece: { type: "math", tex: src.slice(j + 2), display: true, closed: false },
        };
      }
      return {
        start: j,
        end: close + 2,
        piece: { type: "math", tex: src.slice(j + 2, close).trim(), display: true, closed: true },
      };
    }

    if (src.startsWith("\\(", j)) {
      const close = src.indexOf("\\)", j + 2);
      if (close === -1) {
        return {
          start: j,
          end: src.length,
          piece: { type: "math", tex: src.slice(j + 2), display: false, closed: false },
        };
      }
      return {
        start: j,
        end: close + 2,
        piece: { type: "math", tex: src.slice(j + 2, close).trim(), display: false, closed: true },
      };
    }

    if (src.startsWith("\\begin{", j)) {
      const nameEnd = src.indexOf("}", j + 7);
      if (nameEnd === -1) continue;
      const env = src.slice(j + 7, nameEnd);
      if (!MATH_ENV.test(env)) continue;
      const closeTag = `\\end{${env}}`;
      const close = src.indexOf(closeTag, nameEnd + 1);
      if (close === -1) {
        return {
          start: j,
          end: src.length,
          piece: { type: "math", tex: src.slice(j), display: true, closed: false },
        };
      }
      const end = close + closeTag.length;
      return {
        start: j,
        end,
        piece: { type: "math", tex: src.slice(j, end).trim(), display: true, closed: true },
      };
    }

    if (src[j] === "$" && src[j - 1] !== "\\" && src[j + 1] !== "$") {
      if (/\s/.test(src[j + 1] || "")) continue;
      let close = -1;
      for (let k = j + 1; k < src.length; k++) {
        if (src[k] === "\n") break;
        if (src[k] === "$" && src[k - 1] !== "\\" && src[k + 1] !== "$") {
          if (/\s/.test(src[k - 1])) continue;
          close = k;
          break;
        }
      }
      if (close !== -1) {
        const tex = src.slice(j + 1, close);
        if (tex) {
          return {
            start: j,
            end: close + 1,
            piece: { type: "math", tex, display: false, closed: true },
          };
        }
      } else if (/\\[a-zA-Z]/.test(src.slice(j + 1, j + 48))) {
        return {
          start: j,
          end: src.length,
          piece: { type: "math", tex: src.slice(j + 1), display: false, closed: false },
        };
      }
    }
  }
  return null;
}

export function renderKatex(tex: string, display: boolean, closed: boolean): string {
  const body = tex.replace(/^\n+|\n+$/g, "");
  if (!body.trim()) return "";
  if (!closed) {
    try {
      return wrap(
        katex.renderToString(body, opts(display)),
        display,
      );
    } catch {
      return `<span class="math-pending">${escape(body)}</span>`;
    }
  }
  try {
    return wrap(katex.renderToString(body, opts(display)), display);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `<span class="katex-error" title="${escape(msg)}">${escape(body)}</span>`;
  }
}

function opts(display: boolean): katex.KatexOptions {
  return {
    displayMode: display,
    throwOnError: false,
    strict: "ignore",
    trust: false,
    output: "html",
    minRuleThickness: 0.06,
  };
}

function wrap(html: string, display: boolean) {
  return display ? `<div class="math-display">${html}</div>` : html;
}

function escape(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
