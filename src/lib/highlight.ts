import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";
import swift from "highlight.js/lib/languages/swift";
import lua from "highlight.js/lib/languages/lua";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import makefile from "highlight.js/lib/languages/makefile";
import ini from "highlight.js/lib/languages/ini";
import scss from "highlight.js/lib/languages/scss";
import diff from "highlight.js/lib/languages/diff";

let registered = false;

export function ensureHljs() {
  if (registered) return hljs;
  const langs: [string, typeof javascript][] = [
    ["javascript", javascript],
    ["js", javascript],
    ["typescript", typescript],
    ["ts", typescript],
    ["tsx", typescript],
    ["jsx", javascript],
    ["python", python],
    ["py", python],
    ["rust", rust],
    ["rs", rust],
    ["go", go],
    ["golang", go],
    ["json", json],
    ["bash", bash],
    ["sh", bash],
    ["shell", bash],
    ["zsh", bash],
    ["css", css],
    ["xml", xml],
    ["html", xml],
    ["svg", xml],
    ["markdown", markdown],
    ["md", markdown],
    ["sql", sql],
    ["yaml", yaml],
    ["yml", yaml],
    ["c", c],
    ["h", c],
    ["cpp", cpp],
    ["hpp", cpp],
    ["java", java],
    ["kotlin", kotlin],
    ["kt", kotlin],
    ["ruby", ruby],
    ["rb", ruby],
    ["php", php],
    ["swift", swift],
    ["lua", lua],
    ["dockerfile", dockerfile],
    ["makefile", makefile],
    ["ini", ini],
    ["toml", ini],
    ["scss", scss],
    ["diff", diff],
  ];
  for (const [name, def] of langs) hljs.registerLanguage(name, def);
  registered = true;
  return hljs;
}

export function highlight(code: string, lang?: string): string {
  const h = ensureHljs();
  try {
    if (lang && h.getLanguage(lang)) {
      return h.highlight(code, { language: lang }).value;
    }
    return h.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
