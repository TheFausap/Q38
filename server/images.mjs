import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeDurable } from "./durable.mjs";

/**
 * Images attached to chat turns, kept on the server's disk next to the
 * conversations rather than inside them.
 *
 *   <state>/ui/images/<sha256>.<ext>
 *
 * A conversation file is rewritten every second or so while a reply streams,
 * and mirrored into localStorage; a few megabytes of base64 in it would make
 * every one of those writes slow and blow the browser's quota. So a message
 * carries only a reference ({ id, name, mime, width, height }) and the bytes
 * live here, addressed by their hash: the same picture pasted twice is stored
 * once, and an id is never reused for different bytes.
 *
 * The browser resizes and re-encodes before uploading, so what arrives is
 * already PNG or JPEG. Only formats llama-server's image loader reads are
 * accepted, sniffed from the bytes themselves, not taken from a header.
 */

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const ID_RE = /^[a-f0-9]{64}$/;

const FORMATS = [
  { ext: "png", mime: "image/png", test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { ext: "jpg", mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", mime: "image/gif", test: (b) => b.length > 6 && b.toString("latin1", 0, 4) === "GIF8" },
  { ext: "bmp", mime: "image/bmp", test: (b) => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
];

export function sniffImage(buf) {
  return FORMATS.find((f) => f.test(buf)) || null;
}

export function imagesRoot(stateRoot) {
  return path.join(stateRoot, "ui", "images");
}

/** Store the bytes; returns { id, mime, bytes } or { error }. */
export function putImage(stateRoot, buf) {
  if (!buf || !buf.length) return { error: "the upload is empty" };
  if (buf.length > IMAGE_MAX_BYTES) return { error: `the image is over the ${IMAGE_MAX_BYTES / 1048576} MB limit` };
  const fmt = sniffImage(buf);
  if (!fmt) return { error: "not a PNG, JPEG, GIF or BMP image" };
  const id = crypto.createHash("sha256").update(buf).digest("hex");
  const root = imagesRoot(stateRoot);
  const file = path.join(root, `${id}.${fmt.ext}`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(root, { recursive: true });
    writeDurable(file, buf);
  }
  return { id, mime: fmt.mime, bytes: buf.length };
}

/** Find a stored image by id; returns { file, mime } or null. */
export function findImage(stateRoot, id) {
  if (!ID_RE.test(String(id || ""))) return null;
  const root = imagesRoot(stateRoot);
  for (const f of FORMATS) {
    const file = path.join(root, `${id}.${f.ext}`);
    if (fs.existsSync(file)) return { file, mime: f.mime };
  }
  return null;
}
