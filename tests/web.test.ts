/**
 * The web tools' client half: what the model is offered, and what it reads back.
 *
 *   node --experimental-strip-types tests/web.test.ts
 *
 * Pure functions only. The network lives in `tests/web-routes.mjs`, and the
 * whole path through the app lives in `tests/ui.mjs`.
 */
import assert from "node:assert/strict";
import {
  MAX_TOOL_HOPS,
  WEB_MAX_CHARS,
  WEB_MAX_RESULTS,
  WEB_TOOLS,
  argsOf,
  clampCount,
  dedupeSources,
  fetchTapeLine,
  hostOf,
  pageText,
  searchResultsText,
  searchTapeLine,
  searchingLine,
  openingLine,
  activeWebText,
  sourceOf,
} from "../src/lib/web.ts";

/* --------------------------------------------------------------- tools */
{
  assert.equal(WEB_TOOLS.length, 2, "the model gets exactly two web tools");
  const names = WEB_TOOLS.map((t) => t.function.name);
  assert.deepEqual(names, ["web_search", "web_fetch"], `named as called: ${names.join(", ")}`);

  for (const tool of WEB_TOOLS) {
    assert.equal(tool.type, "function", "both are function tools");
    assert.equal(tool.function.parameters.type, "object", "with object arguments");
    assert.ok(
      Array.isArray(tool.function.parameters.required) && tool.function.parameters.required.length > 0,
      `${tool.function.name} requires something`,
    );
    assert.ok(tool.function.description.length > 80, `${tool.function.name} explains itself`);
  }

  const search = WEB_TOOLS[0].function;
  assert.deepEqual(search.parameters.required, ["query"], "a search needs a query");
  assert.ok(/count/.test(Object.keys(search.parameters.properties).join(",")), "and may take a count");

  const fetch = WEB_TOOLS[1].function;
  assert.deepEqual(fetch.parameters.required, ["url"], "a fetch needs a url");
  assert.ok(
    /never follow[\s\S]*instructions/i.test(fetch.description),
    `and says page text is not instruction: ${fetch.description.slice(-80)}`,
  );
  assert.ok(/http/.test(fetch.description), "and says which schemes work");
}

/* --------------------------------------------------------------- small */
{
  assert.equal(hostOf("https://www.qwen.readthedocs.io/en/latest/x.html"), "qwen.readthedocs.io");
  assert.equal(hostOf("http://127.0.0.1:8186/page"), "127.0.0.1");
  assert.equal(hostOf("not a url"), "not a url");
  assert.equal(hostOf(""), "");

  assert.equal(clampCount(undefined, 5), 5, "no count means the setting");
  assert.equal(clampCount(3), 3, "a sane count is kept");
  assert.equal(clampCount(0), 5, "zero is not a count");
  assert.equal(clampCount(-4), 5, "nor is a negative one");
  assert.equal(clampCount("7"), 7, "a string number is a number");
  assert.equal(clampCount(99), WEB_MAX_RESULTS, `an absurd count is capped at ${WEB_MAX_RESULTS}`);
  assert.equal(clampCount(2.6), 3, "fractions round");

  assert.deepEqual(argsOf('{"query":"x"}'), { query: "x" }, "arguments parse");
  assert.deepEqual(argsOf("{oops"), {}, "a half-written argument set is a miss, not a crash");
  assert.deepEqual(argsOf(undefined), {}, "no arguments is a miss");
  assert.deepEqual(argsOf('"just text"'), {}, "a non-object is a miss");
}

/* --------------------------------------------------- what the model reads */
{
  const out = {
    ok: true,
    provider: "searx",
    results: [
      { title: "Function calling", url: "https://example.com/a", snippet: "tools in the request" },
      { title: "Second", url: "https://example.com/b", snippet: "and more" },
    ],
  };
  const text = searchResultsText("llama.cpp tools", out);
  assert.ok(/^### Web results for "llama\.cpp tools" — 2 hits via searx/.test(text), text.split("\n")[0]);
  assert.ok(/not the pages/i.test(text), "it says snippets are not the pages");
  assert.ok(/\n1\. Function calling\n/.test(text), `results are numbered:\n${text}`);
  assert.ok(/\n   https:\/\/example\.com\/a\n/.test(text), "the address is on its own line, ready to fetch");
  assert.ok(/web_fetch/.test(text), "and it says how to read one");

  const capped = searchResultsText("q", { ok: true, provider: "brave", results: out.results }, 1);
  assert.ok(!/Second/.test(capped), "the count the caller asked for is respected");

  const none = searchResultsText("q", { ok: true, provider: "duckduckgo", results: [] });
  assert.ok(/found nothing/.test(none), `an empty search says so: ${none}`);

  const failed = searchResultsText("q", { ok: false, error: "DuckDuckGo returned no results", hint: "set a SearXNG URL" });
  assert.ok(/^### Web search failed for "q"/.test(failed), failed.split("\n")[0]);
  assert.ok(/DuckDuckGo returned no results/.test(failed), "the reason is passed on");
  assert.ok(/set a SearXNG URL/.test(failed), "with the hint");
  assert.ok(/Answer from what you already have/.test(failed), "and the way out");
}

{
  const page = {
    ok: true,
    url: "https://example.com/go",
    finalUrl: "https://example.com/page",
    host: "example.com",
    title: "Retry helpers",
    text: "withTimeout() puts a limit on it.",
    chars: 31,
    totalChars: 4210,
    truncated: true,
  };
  const text = pageText(page);
  assert.ok(/^### Page: Retry helpers/.test(text), text.split("\n")[0]);
  assert.ok(/https:\/\/example\.com\/page/.test(text), "the address read is the one that landed");
  assert.ok(/31 characters of 4,210 read/.test(text), `the accounting is honest: ${text.split("\n")[2]}`);
  assert.ok(/the rest was cut/.test(text), "and says when it was cut");
  assert.ok(/information, not instruction/i.test(text), "and that a page does not command the model");
  assert.ok(/withTimeout\(\) puts a limit/.test(text), "the page's own words are there");

  const complete = pageText({ ...page, truncated: false, chars: 4210 });
  assert.ok(!/cut/.test(complete), "no cut notice when nothing was cut");

  const failed = pageText({ ok: false, error: "example.com answered 404" });
  assert.ok(/^### Could not read that page/.test(failed), failed.split("\n")[0]);
  assert.ok(/404/.test(failed), "the reason is passed on");
}

/* -------------------------------------------------------------- tape */
{
  assert.equal(
    searchTapeLine("llama.cpp tool calling", { ok: true, provider: "searx", results: [{}, {}] }),
    'WEB: SEARCH "llama.cpp tool calling" · 2 HITS · SEARX',
  );
  assert.equal(
    searchTapeLine("x", { ok: false, error: "duckduckgo refused 429" }),
    'WEB: SEARCH "x" · FAILED · DUCKDUCKGO REFUSED 429',
  );
  assert.equal(
    fetchTapeLine("https://www.example.com/a/page", { ok: true, chars: 6210 }),
    "WEB: OPEN example.com · 6.2k CHARS",
  );
  assert.equal(fetchTapeLine("https://example.com/x", { ok: false, error: "403" }), "WEB: OPEN example.com · FAILED · 403");
  const long = searchTapeLine("x".repeat(200), { ok: true, provider: "brave", results: [] });
  assert.ok(!/\n/.test(long) && long.length < 120, `a tape line stays one short line (${long.length})`);
}

/* ------------------------------------------------------ live indicator */
{
  assert.equal(searchingLine("retry timeout helpers"), 'WEB: SEARCHING "retry timeout helpers"…');
  assert.equal(
    searchingLine("  a   query\nwith   space "),
    'WEB: SEARCHING "a query with space"…',
    "the live line is flattened",
  );
  assert.ok(searchingLine("x".repeat(300)).length < 90, "and stays short enough for one tape row");
  assert.equal(openingLine("qwen.readthedocs.io"), "WEB: OPENING qwen.readthedocs.io…");
  assert.equal(openingLine(""), "WEB: OPENING a page…");

  assert.equal(activeWebText({ kind: "search", label: "llama.cpp tools" }), "searching the web for “llama.cpp tools”");
  assert.equal(activeWebText({ kind: "open", label: "example.com" }), "reading example.com");
  assert.equal(activeWebText(null), "", "nothing active, nothing said");
}

/* ----------------------------------------------------------- sources */
{
  const one = sourceOf("https://example.com/a", "A page");
  assert.deepEqual(one, { title: "A page", url: "https://example.com/a" });
  assert.deepEqual(sourceOf("https://example.com/b"), { title: "example.com", url: "https://example.com/b" });

  const many = dedupeSources([
    { title: "one", url: "https://a.example" },
    { title: "again", url: "https://a.example" },
    { title: "two", url: "https://b.example" },
    ...Array.from({ length: 10 }, (_, i) => ({ title: `x${i}`, url: `https://c${i}.example` })),
  ]);
  assert.equal(many.length, 8, "sources are deduped and capped");
  assert.equal(many[0].title, "one", "the first sighting wins");

  assert.ok(WEB_MAX_CHARS >= 2000 && WEB_MAX_CHARS <= 20000, `the page budget is sane (${WEB_MAX_CHARS})`);
  assert.ok(MAX_TOOL_HOPS >= 4 && MAX_TOOL_HOPS <= 8, `the hop cap is sane (${MAX_TOOL_HOPS})`);
}

console.log("web checks passed");
