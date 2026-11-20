// Caches kept beside a reference clip (app-kit `putCreatorFile`, private files of the video asset): the
// timeline's thumbnail strip and the sound's peaks, and later the analysis and the tracks. Each is one
// Blob: a little-endian u32 header length, a JSON header, then the binary parts it names, in order.
// Plain functions on Blobs and typed arrays, so the tests run them without a browser.

export const THUMBS_FILE = 'thumbs.bin';
export const PEAKS_FILE = 'peaks.bin';

/** Bump when a cache's meaning changes: an older one is read as missing and made again. */
export const CACHE_VERSION = 1;

interface Header { v: number; kind: string; parts: number[]; meta: Record<string, unknown>; }

/** One cache Blob from a header and its binary parts. */
export function packCache(kind: string, meta: Record<string, unknown>, parts: (Blob | ArrayBufferView)[]): Blob {
  const sizes = parts.map(p => (p instanceof Blob ? p.size : p.byteLength));
  const header = new TextEncoder().encode(JSON.stringify({ v: CACHE_VERSION, kind, parts: sizes, meta } satisfies Header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.byteLength, true);
  return new Blob([len, header, ...parts.map(p => (p instanceof Blob ? p : new Uint8Array(p.buffer, p.byteOffset, p.byteLength)))] as BlobPart[]);
}

/** A cache Blob back into its header and parts (Blob slices, read as needed). Null: not this kind or version. */
export async function unpackCache(blob: Blob, kind: string): Promise<{ meta: Record<string, unknown>; parts: Blob[] } | null> {
  try {
    if (blob.size < 4) return null;
    const len = new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(await blob.slice(4, 4 + len).arrayBuffer())) as Header;
    if (header.v !== CACHE_VERSION || header.kind !== kind || !Array.isArray(header.parts)) return null;
    const parts: Blob[] = [];
    let at = 4 + len;
    for (const size of header.parts) { parts.push(blob.slice(at, at + size)); at += size; }
    if (at > blob.size) return null;
    return { meta: header.meta ?? {}, parts };
  } catch {
    return null;
  }
}

/** The timeline's thumbnails: a picture every so often, each a small JPEG. */
export interface ThumbStrip { times: number[]; images: Blob[]; height: number; }

export const packThumbs = (s: ThumbStrip) => packCache('thumbs', { times: s.times, height: s.height }, s.images);
export async function unpackThumbs(blob: Blob): Promise<ThumbStrip | null> {
  const c = await unpackCache(blob, 'thumbs');
  const times = c?.meta.times;
  if (!c || !Array.isArray(times) || times.length !== c.parts.length) return null;
  return { times: times as number[], images: c.parts.map(p => p.slice(0, p.size, 'image/jpeg')), height: Number(c.meta.height) || 54 };
}

/** The sound's loudness: the largest |sample| in each bucket of 1/`perSecond` s, from `start` (video time). */
export interface AudioPeaks { start: number; perSecond: number; peaks: Float32Array; }

export const packPeaks = (p: AudioPeaks) => packCache('peaks', { start: p.start, perSecond: p.perSecond }, [p.peaks]);
export async function unpackPeaks(blob: Blob): Promise<AudioPeaks | null> {
  const c = await unpackCache(blob, 'peaks');
  if (!c || c.parts.length !== 1) return null;
  return { start: Number(c.meta.start) || 0, perSecond: Number(c.meta.perSecond) || 50, peaks: new Float32Array(await c.parts[0].arrayBuffer()) };
}
