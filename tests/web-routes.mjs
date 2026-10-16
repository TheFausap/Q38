/**
 * The web tools' server half.
 *
 *   node tests/web-routes.mjs
 *
 * No internet here: the providers are exercised as parsers against canned
 * payloads, and the routes are exercised over real HTTP against a stub SearXNG
 * and a stub page server. The one thing these tests cannot prove is that
 * duckduckgo.com answers today — that is the live path, and it fails honestly.
 */
import assert from "node:assert/strict";
import http from "node:http";
import {
  createApi,
  decodeDdgUrl,
  fetchPage,
  htmlToText,
  isPrivateHost,
  parseBraveJson,
  parseDuckHtml,
  parseDuckLite,
  parseSearxJson,
  parseTavilyJson,
  pickProvider,
  searchWeb,
  titleOf,
  validateFetchUrl,
} from "../server/api.mjs";

const results = [];
const check = (ok, msg) => {
  results.push(`${ok ? "·" : "✗"} ${msg}`);
  if (!ok) throw new Error(msg);
};

/* ------------------------------------------------------------- parsing */
{
  const text = htmlToText(`
    <html><head><title>Retry patterns &amp; timeouts</title>
    <style>body{color:red}</style><script>alert("nope")</script></head>
    <body><h1>Backoff</h1><p>Jitter &lt;always&gt; helps.</p>
    <ul><li>one</li><li>two</li></ul>
    <div>Caf&eacute; &#233; &#x27;quoted&#x27;</div></body></html>`);
  check(!/alert/.test(text), "a page's scripts are not read into the prompt");
  check(!/color:red/.test(text), "nor its styles");
  check(/Backoff/.test(text), "headings survive");
  check(/Jitter <always> helps/.test(text), "entities are decoded");
  check(/\n/.test(text), "block elements become line breaks");
  /* decoded text may contain "<" honestly ("Jitter <always> helps"); what must
     be gone is the markup it came from */
  check(!/<\/?(html|body|p|h1|div|li|ul|head|script|style)\b/i.test(text), "no markup is left behind");
  check(titleOf("<title>Q38 &mdash; docs</title>") === "Q38 — docs", "the title is read and decoded");
  check(titleOf("<h1>Fallback heading</h1>") === "Fallback heading", "an h1 stands in for a missing title");
}

/* -------------------------------------------------------- ddg results */
const ddgHtml = `
<div class="result results_links web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a"
     href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fqwen.readthedocs.io%2Fen%2Flatest%2Fframework%2Ffunction_calling.html&amp;rut=abc">Function calling &mdash; Qwen docs</a></h2>
  <a class="result__snippet" href="x">Pass <b>tools</b> in the request and read tool_calls back.</a>
</div>
<div class="result results_links web-result">
  <h2 class="result__title"><a href="https://example.com/plain" rel="nofollow" class="result__a">Plain result</a></h2>
  <a class="result__snippet" href="y">No redirect wrapper here.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=&amp;rut=z">Junk</a>
</div>`;
{
  const parsed = parseDuckHtml(ddgHtml);
  check(parsed.length === 3, `every result row is read (${parsed.length})`);
  check(
    parsed[0].url === "https://qwen.readthedocs.io/en/latest/framework/function_calling.html",
    `the redirect wrapper is unwrapped: ${parsed[0].url}`,
  );
  check(/^Function calling/.test(parsed[0].title), `the title is text: ${parsed[0].title}`);
  check(/tool_calls/.test(parsed[0].snippet), "the snippet is text, tags removed");
  check(parsed[1].url === "https://example.com/plain", "a plain link is kept, whatever order its attributes came in");

  const lite = parseDuckLite(`
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flocalhost%2Fsecret" class='result-link'>Lite &amp; steady</a>
    <td class='result-snippet'>Snippet <b>here</b>.</td>`);
  check(lite[0].url === "https://localhost/secret", "the lite layout is read too");
  check(lite[0].title === "Lite & steady", "and its titles decoded");

  check(decodeDdgUrl("https://example.com/x") === "https://example.com/x", "a normal URL passes through");
  check(decodeDdgUrl("//duckduckgo.com/l/?uddg=%2Fx") === "/x", "an encoded target is decoded");
  check(decodeDdgUrl("/relative/path") === "", "a relative link is not a result");
}

/* --------------------------------------------- the providers' payloads */
{
  const searx = parseSearxJson({
    results: [
      { title: "A", url: "https://a.example", content: "first" },
      { title: "B", url: "https://b.example", snippet: "second" },
    ],
  });
  check(searx.length === 2 && searx[1].snippet === "second", "SearXNG JSON maps to results");

  const brave = parseBraveJson({ web: { results: [{ title: "B", url: "https://b.example", description: "brave" }] } });
  check(brave[0].snippet === "brave", "Brave's description becomes the snippet");

  const tavily = parseTavilyJson({ results: [{ title: "T", url: "https://t.example", content: "tavily" }] });
  check(tavily[0].snippet === "tavily", "Tavily's content becomes the snippet");

  const orders = [
    [{}, "duckduckgo"],
    [{ key: "k" }, "brave"],
    [{ searxUrl: "http://192.168.1.5:8888" }, "searx"],
    [{ key: "k", searxUrl: "http://x:8888" }, "searx"],
    [{ provider: "tavily", key: "k" }, "tavily"],
    [{ provider: "auto", key: "k" }, "brave"],
    [{ provider: "nonsense" }, "duckduckgo"],
  ];
  for (const [input, want] of orders) {
    check(pickProvider(input) === want, `${JSON.stringify(input)} → ${want}`);
  }
}

/* --------------------------------------------------------------- guard */
{
  for (const host of ["localhost", "api.localhost", "printer.local", "127.0.0.1", "10.1.2.3", "172.16.0.9",
    "172.31.255.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "::1", "fc00::1", "fe80::1", "0.0.0.0"]) {
    check(isPrivateHost(host), `${host} is not for a model to read`);
  }
  for (const host of ["example.com", "1.1.1.1", "172.32.0.1", "8.8.8.8", "qwen.readthedocs.io"]) {
    check(!isPrivateHost(host), `${host} is public`);
  }
  check(validateFetchUrl("file:///etc/passwd").error.includes("http"), "file: is refused");
  check(validateFetchUrl("javascript:alert(1)").ok === false, "javascript: is refused");
  check(validateFetchUrl("not a url").ok === false, "a non-URL is refused");
  check(validateFetchUrl("https://user:pw@example.com").ok === false, "credentials in a URL are refused");
  check(validateFetchUrl("http://169.254.169.254/latest/meta-data/").ok === false, "cloud metadata is refused");
  check(validateFetchUrl("https://example.com/page").ok === true, "a public page passes");
}

/* ---------------------------------------------------- stub HTTP world */
const STUB_PORT = 8186;
const hits = [];
const stub = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${STUB_PORT}`);
  hits.push(url.pathname + url.search);
  if (url.pathname === "/forbidden/search") {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }
  if (url.pathname === "/search") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        query: url.searchParams.get("q"),
        results: [
          { title: "llama.cpp function calling", url: "https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md", content: "Tools need --jinja." },
          { title: "A second hit", url: "https://example.com/second", content: "and another" },
          { title: "Not a URL", url: "javascript:alert(1)", content: "dropped" },
        ],
      }),
    );
    return;
  }
  if (url.pathname === "/page") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<html><head><title>Retry helpers</title><script>ignoreMe()</script></head>
      <body><h1>withTimeout</h1><p>${"word ".repeat(400)}</p></body></html>`);
    return;
  }
  if (url.pathname === "/pdf") {
    res.writeHead(200, { "Content-Type": "application/pdf" });
    res.end("%PDF-1.4 not for reading");
    return;
  }
  if (url.pathname === "/go") {
    res.writeHead(302, { Location: "/page" });
    res.end();
    return;
  }
  if (url.pathname === "/loop") {
    res.writeHead(302, { Location: "/loop" });
    res.end();
    return;
  }
  if (url.pathname === "/json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, note: "raw JSON is text" }));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/html" });
  res.end("<h1>not here</h1>");
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

const API_PORT = 8185;
const api = createApi();
const middleware = http.createServer((req, res) => api(req, res, () => res.end("{}")));
await new Promise((r) => middleware.listen(API_PORT, "127.0.0.1", r));

const post = async (path, body, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const SEARX = { "X-Q38-Searx-Url": `http://127.0.0.1:${STUB_PORT}/` };

try {
  /* -------------------------------------------------- search over HTTP */
  const found = await post("/api/web/search", { query: "llama.cpp tool calling", count: 5, provider: "searx" }, SEARX);
  check(found.status === 200 && found.json.ok === true, `a search answers 200 (${found.status})`);
  check(found.json.provider === "searx", `and names the provider: ${found.json.provider}`);
  check(found.json.results.length === 2, `junk results are dropped (${found.json.results.length} of 3)`);
  check(/function-calling\.md/.test(found.json.results[0].url), "and the addresses are intact");
  check(hits.some((h) => h.startsWith("/search?q=llama.cpp")), `the stub was asked: ${hits.join(", ")}`);
  check(/format=json/.test(hits.find((h) => h.startsWith("/search")) || ""), "as a JSON request");

  const countCapped = await post("/api/web/search", { query: "x", count: 1, provider: "searx" }, SEARX);
  check(countCapped.json.results.length === 1, "the result count is honoured");

  const refused = await post("/api/web/search", { query: "x", provider: "searx" }, {
    "X-Q38-Searx-Url": `http://127.0.0.1:${STUB_PORT}/forbidden`,
  });
  check(refused.status === 502 && refused.json.ok === false, `a provider that says no answers 502 (${refused.status})`);
  check(/403/.test(refused.json.error), `with the status in the message: ${refused.json.error}`);
  check(/format: \[html, json\]/.test(refused.json.error), "and the fix for the common SearXNG mistake");

  const noQuery = await post("/api/web/search", { query: "   " }, SEARX);
  check(noQuery.status === 400, "a search with no query is a client error, not a provider failure");

  /* a host nothing answers on: the model has to be told which host and why */
  const dead = await post("/api/web/search", { query: "x", provider: "searx" }, {
    "X-Q38-Searx-Url": "http://127.0.0.1:8199",
  });
  check(dead.status === 502, `a dead provider is a 502 (${dead.status})`);
  check(
    /could not reach 127\.0\.0\.1/.test(dead.json.error) && /no route|refused|answered/i.test(dead.json.error),
    `and says which host: ${dead.json.error}`,
  );

  const noKey = await post("/api/web/search", { query: "x", provider: "brave" });
  check(noKey.status === 502 && /API key/.test(noKey.json.error), `a keyless provider says so: ${noKey.json.error}`);
  const noUrl = await post("/api/web/search", { query: "x", provider: "searx" });
  check(noUrl.status === 502 && /SearXNG URL/.test(noUrl.json.error), "and so does a missing SearXNG URL");

  /* the same call through searchWeb() directly, as the route does it */
  const direct = await searchWeb({ query: "q", provider: "searx", searxUrl: `http://127.0.0.1:${STUB_PORT}/` });
  check(direct.results.length === 2 && typeof direct.ms === "number", "searchWeb reports results and time");

  /* --------------------------------------------------- reading a page */
  process.env.Q38_WEB_ALLOW_PRIVATE = "";
  const guarded = await post("/api/web/fetch", { url: `http://127.0.0.1:${STUB_PORT}/page` });
  check(guarded.status === 502 && /only reads public addresses/.test(guarded.json.error), `a private address is refused: ${guarded.json.error}`);
  const literal = await post("/api/web/fetch", { url: "http://169.254.169.254/latest/meta-data/" });
  check(literal.status === 502 && /private|only reads public/.test(literal.json.error), "so is the metadata address");

  process.env.Q38_WEB_ALLOW_PRIVATE = "1";
  const page = await post("/api/web/fetch", { url: `http://127.0.0.1:${STUB_PORT}/page`, chars: 8000 });
  check(page.status === 200 && page.json.ok === true, `the stub page is read (${page.status})`);
  check(page.json.title === "Retry helpers", `and titled: ${page.json.title}`);
  check(/withTimeout/.test(page.json.text), "the body is there");
  check(!/ignoreMe/.test(page.json.text), "the script is not");
  check(!/<p>/.test(page.json.text), "and no markup is left");
  check(page.json.totalChars >= page.json.chars, `the char count matches what was sent (${page.json.chars}/${page.json.totalChars})`);

  const big = await post("/api/web/fetch", { url: `http://127.0.0.1:${STUB_PORT}/page`, chars: 1000 });
  check(big.json.chars <= 1000 && big.json.truncated === true, `a long page is cut to the budget (${big.json.chars} chars)`);

  const pdf = await post("/api/web/fetch", { url: `http://127.0.0.1:${STUB_PORT}/pdf` });
  check(pdf.status === 502 && /application\/pdf/.test(pdf.json.error), `a PDF is refused in plain words: ${pdf.json.error}`);

  const missing = await post("/api/web/fetch", { url: `http://127.0.0.1:${STUB_PORT}/nope` });
  check(missing.status === 502 && /404/.test(missing.json.error), "a 404 is reported as a 404");

  const redirected = await post("/api/web/fetch", { url: `http://127.0.0.1:${STUB_PORT}/go` });
  check(redirected.json.ok === true && /\/page$/.test(redirected.json.finalUrl), "a redirect is followed");
  check(redirected.json.url.endsWith("/go"), "and the URL asked for is still reported");

  const looped = await post("/api/web/fetch", { url: `http://127.0.0.1:${STUB_PORT}/loop` });
  check(looped.status === 502 && /redirects/.test(looped.json.error), "a redirect loop stops after the cap");

  const raw = await post("/api/web/fetch", { url: `http://127.0.0.1:${STUB_PORT}/json` });
  check(raw.json.ok === true && /raw JSON is text/.test(raw.json.text), "JSON is text too");

  const badSchemes = await post("/api/web/fetch", { url: "file:///etc/passwd" });
  check(badSchemes.status === 502 && /http and https/.test(badSchemes.json.error), "file: cannot be read");
  const noUrlAtAll = await post("/api/web/fetch", {});
  check(noUrlAtAll.status === 400, "a fetch with no URL is a client error");

  /* fetchPage is what the route calls; check it can be used straight */
  const directPage = await fetchPage(`http://127.0.0.1:${STUB_PORT}/page`, { chars: 700 });
  check(directPage.ok === true && directPage.chars <= 700, `fetchPage honours its own budget (${directPage.chars})`);
  const floor = await fetchPage(`http://127.0.0.1:${STUB_PORT}/page`, { chars: 10 });
  check(floor.ok === true && floor.chars >= 400, `an absurdly small budget is raised to something readable (${floor.chars})`);

  console.log(results.join("\n"));
  console.log(`web route checks passed (${results.length})`);
} catch (err) {
  console.error(results.join("\n"));
  console.error("WEB ROUTE TEST FAILED:", err.message);
  process.exitCode = 1;
} finally {
  delete process.env.Q38_WEB_ALLOW_PRIVATE;
  middleware.close();
  stub.close();
  process.exit(process.exitCode || 0);
}
