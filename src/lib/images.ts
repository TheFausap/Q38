import type { ChatMessage, ImageRef } from "./types";

/**
 * Pictures sent with a turn, for a vision model (llama-server with --mmproj).
 *
 * The way in: the browser decodes the file, scales it down to the configured
 * megapixels and re-encodes it as PNG or JPEG (formats llama-server's loader
 * reads — WebP and HEIC are not), then uploads the bytes to the Q38 server,
 * which stores them by hash. The message keeps only the reference.
 *
 * The way out: just before a request is built, every referenced image is
 * fetched back once and kept here as a data: URL, so building the wire
 * messages stays synchronous and a regen does not download anything again.
 */

const cache = new Map<string, string>();

/** Vision patch footprint: one token per 28×28 px after merging (Qwen-VL). Rounds up, like the rest of the estimates. */
const PX_PER_TOKEN_SIDE = 28;

export const ACCEPTED_IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp,image/bmp";

export function imageTokens(img: Pick<ImageRef, "width" | "height">): number {
  const w = Math.max(1, Math.ceil(img.width / PX_PER_TOKEN_SIDE));
  const h = Math.max(1, Math.ceil(img.height / PX_PER_TOKEN_SIDE));
  /* plus the <vision_start>/<vision_end> markers and a little slack */
  return w * h + 8;
}

/** What /props says: true with --mmproj, false without, null when the build does not say. */
export function visionFromProps(props: Record<string, unknown> | null | undefined): boolean | null {
  const m = props?.modalities as Record<string, unknown> | undefined;
  if (m && typeof m.vision === "boolean") return m.vision;
  return null;
}

/** Where the transcript shows the picture from. */
export function imageSrc(img: ImageRef): string {
  return img.data ?? cache.get(img.id) ?? `/api/images/${img.id}`;
}

/** The data: URL for the request, once ensureImageData has run. */
export function imageDataUrl(img: ImageRef): string | null {
  return img.data ?? cache.get(img.id) ?? null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("could not read the image"));
    r.readAsDataURL(blob);
  });
}

/** Fetch every image the messages refer to that is not in memory yet. */
export async function ensureImageData(messages: ChatMessage[]): Promise<string[]> {
  const missing: string[] = [];
  const wanted = new Map<string, ImageRef>();
  for (const m of messages) {
    for (const img of m.images ?? []) {
      if (!img.data && !cache.has(img.id)) wanted.set(img.id, img);
    }
  }
  await Promise.all(
    [...wanted.values()].map(async (img) => {
      try {
        const res = await fetch(`/api/images/${img.id}`);
        if (!res.ok) throw new Error(String(res.status));
        cache.set(img.id, await blobToDataUrl(await res.blob()));
      } catch {
        missing.push(img.name);
      }
    }),
  );
  return missing;
}

function canvasBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the image"))), mime, 0.9),
  );
}

/**
 * Decode, scale to at most `megapixels`, and encode as PNG (for PNG/GIF input,
 * which may carry text or transparency) or JPEG (photos). A PNG or JPEG that is
 * already small enough goes through untouched.
 */
export async function prepareImage(
  file: Blob & { name?: string },
  megapixels: number,
): Promise<{ blob: Blob; mime: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = bitmap;
    const limit = Math.max(0.1, megapixels || 1) * 1_000_000;
    const scale = Math.min(1, Math.sqrt(limit / (width * height)));
    const direct = file.type === "image/png" || file.type === "image/jpeg";
    if (scale === 1 && direct && file.size <= 8 * 1024 * 1024) {
      return { blob: file, mime: file.type, width, height };
    }
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2D canvas in this browser");
    const lossless = file.type === "image/png" || file.type === "image/gif" || file.type === "image/bmp";
    const mime = lossless ? "image/png" : "image/jpeg";
    if (mime === "image/jpeg") {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    return { blob: await canvasBlob(canvas, mime), mime, width: w, height: h };
  } finally {
    bitmap.close();
  }
}

/** Prepare and store one picture; falls back to carrying it inline when the server is out of reach. */
export async function attachImage(file: File, megapixels: number): Promise<ImageRef> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not an image`);
  let prepared;
  try {
    prepared = await prepareImage(file, megapixels);
  } catch {
    throw new Error(`${file.name}: this browser cannot decode it`);
  }
  const { blob, mime, width, height } = prepared;
  const name = file.name || `pasted-${width}x${height}.${mime === "image/png" ? "png" : "jpg"}`;
  const dataUrl = await blobToDataUrl(blob);
  try {
    const res = await fetch("/api/images", {
      method: "POST",
      headers: { "Content-Type": mime },
      body: blob,
    });
    const json = (await res.json()) as { ok?: boolean; id?: string; error?: string };
    if (res.ok && json.ok && json.id) {
      cache.set(json.id, dataUrl);
      return { id: json.id, name, mime, width, height, bytes: blob.size };
    }
    if (res.status === 400 && json.error) throw new Error(`${name}: ${json.error}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${name}:`)) throw err;
    /* no Q38 server here: carry the picture in the message itself */
  }
  return {
    id: `inline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    mime,
    width,
    height,
    bytes: blob.size,
    data: dataUrl,
  };
}
