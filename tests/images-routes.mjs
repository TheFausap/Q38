/**
 * Images attached to chat turns, stored by the server by hash.
 *
 *   node tests/images-routes.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const results = [];
const check = (ok, msg) => {
  results.push(`${ok ? "·" : "✗"} ${msg}`);
  if (!ok) throw new Error(msg);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q38-images-test-"));
process.env.Q38_STATE_DIR = tmp;
const { createApi } = await import("../server/api.mjs");

const api = createApi();
const server = http.createServer((req, res) => api(req, res, () => res.end("{}")));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

/* the smallest valid PNG: 1×1, transparent */
const png = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000100e5270de40000000049454e44ae426082",
  "hex",
);
const sha = crypto.createHash("sha256").update(png).digest("hex");
const put = async (body, type = "image/png") => {
  const res = await fetch(`${base}/api/images`, { method: "POST", headers: { "Content-Type": type }, body });
  return { status: res.status, body: await res.json() };
};

try {
  let out = await put(png);
  check(out.status === 200 && out.body.ok && out.body.id === sha, "a PNG is stored under the hash of its bytes");
  check(out.body.mime === "image/png" && out.body.bytes === png.length, "and the answer says what it is");
  check(fs.existsSync(path.join(tmp, "ui", "images", `${sha}.png`)), "in the state directory, next to the conversations");

  out = await put(png, "image/jpeg");
  check(out.body.id === sha && fs.readdirSync(path.join(tmp, "ui", "images")).length === 1, "the same picture twice is stored once, whatever the header says");

  const res = await fetch(`${base}/api/images/${sha}`);
  const back = Buffer.from(await res.arrayBuffer());
  check(res.status === 200 && res.headers.get("content-type") === "image/png", "it comes back with its type");
  check(back.equals(png), "byte for byte");
  check(/immutable/.test(res.headers.get("cache-control") || ""), "and may be cached for good");

  out = await put(Buffer.from("not a picture at all"));
  check(out.status === 400 && !out.body.ok, "text is refused");
  out = await put(Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "image/webp");
  check(out.status === 400, "so is WebP, which llama-server cannot read (the browser converts it first)");

  check((await fetch(`${base}/api/images/${"0".repeat(64)}`)).status === 404, "an unknown id is a 404");
  check((await fetch(`${base}/api/images/..%2F..%2Fsettings`)).status === 404, "and a path is not an id");
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(results.join("\n"));
}
console.log(`images routes passed (${results.length})`);
