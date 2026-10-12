import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createApi } from "./api.mjs";

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const dist = path.resolve(process.cwd(), "dist");
const api = createApi();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function safeFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] || "/");
  const rel = decoded === "/" ? "/index.html" : decoded;
  const full = path.resolve(dist, "." + rel);
  const root = dist.endsWith(path.sep) ? dist : dist + path.sep;
  if (full !== dist && !full.startsWith(root)) return null;
  return full;
}

function sendFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const stream = fs.createReadStream(file);
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
  });
  stream.pipe(res);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("read error");
    }
  });
}

const server = http.createServer((req, res) => {
  api(req, res, () => {
    if (!fs.existsSync(dist)) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("dist/ is missing. Run npm run build, then npm start.\n");
      return;
    }
    const urlPath = req.url || "/";
    if (urlPath.startsWith("/api")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown api route" }));
      return;
    }
    const file = safeFile(urlPath);
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      sendFile(res, file);
      return;
    }
    const index = path.join(dist, "index.html");
    if (fs.existsSync(index)) {
      sendFile(res, index);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Q38 workbench  http://${HOST}:${PORT}`);
  console.log(`llama-server   ${process.env.LLAMA_SERVER_URL || "http://127.0.0.1:8080"}`);
  console.log(`This process includes the /api proxy. Do not use a static host (npx serve, dotnet serve) — those return index.html for /api/status.`);
});
