import fs from "node:fs";
import path from "node:path";

/**
 * Writes that survive a power cut.
 *
 * `fs.writeFileSync` returns once the bytes are in the OS page cache; a power
 * loss in the next few seconds can lose them, and a crash mid-write can leave a
 * half-written file in place of a good one. Every write here goes:
 *
 *   tmp file → write → fsync(tmp) → rename over the target → fsync(directory)
 *
 * so the target is always either the old complete file or the new complete
 * file, and once the call returns the new one is on stable storage (the
 * directory fsync is what makes the rename itself durable on Linux).
 *
 * macOS caveat: plain fsync there flushes to the drive but not through the
 * drive's own cache (that needs F_FULLFSYNC, which Node does not expose). It is
 * still far stronger than a browser's lazy localStorage flush.
 */

function fsyncDir(dir) {
  /* Windows cannot open a directory for fsync; NTFS journals the rename anyway. */
  if (process.platform === "win32") return;
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    /* some filesystems refuse directory fsync; the file itself is synced */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

let tmpCounter = 0;

/** Atomically and durably replace `file` with `data` (string or Buffer). */
export function writeDurable(file, data, mode = 0o644) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  tmpCounter = (tmpCounter + 1) % 1e9;
  const tmp = `${file}.${process.pid}.${tmpCounter}.tmp`;
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const fd = fs.openSync(tmp, "w", mode);
  try {
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDir(dir);
}

/** Durable JSON write. */
export function writeJsonDurable(file, value, pretty = false) {
  writeDurable(file, JSON.stringify(value, null, pretty ? 2 : undefined));
}

/** Durably move a file (same filesystem). */
export function renameDurable(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  fsyncDir(path.dirname(to));
  if (path.dirname(from) !== path.dirname(to)) fsyncDir(path.dirname(from));
}

/** Durably remove a file; missing is fine. */
export function removeDurable(file) {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  fsyncDir(path.dirname(file));
}

/** Leftover temp files from a write that died mid-way. */
export function sweepTemps(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) if (/\.\d+\.\d+\.tmp$/.test(n)) fs.rmSync(path.join(dir, n), { force: true });
}
