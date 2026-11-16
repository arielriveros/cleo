// Where a running game reads game.bin from, a byte range at a time. The player never needs the whole file at
// once: the header and manifest at boot, each texture and sound once, a scene's chunks when it loads. Reading
// only those keeps the file itself out of memory for the whole session.
//
//   range  — fetch with a Range header: a desktop game (game:// serves ranges, app-kit/desktop/gameProtocol.js)
//            and a web build whose host honours Range (most static hosts and dev servers do).
//   blob   — Play in window: the editor leaves the packed game in IndexedDB as a Blob, which reads lazily.
//   buffer — a web host that ignores Range: the file is read once, whole, into one buffer (and tests).
//
// No DOM beyond fetch/Blob/streams and no engine imports: index.tsx opens the source before the engine loads.

import { DEFAULT_SPAN_OPTIONS, planSpans, pool, scatter, type ByteRange, type Span } from './byteSpans';

export type { ByteRange } from './byteSpans';

export interface GameSource {
  readonly kind: 'range' | 'blob' | 'buffer';
  /** The file's length in bytes. */
  readonly size: number;
  /**
   * True when every read hands back bytes of its own (an exact-size buffer at offset 0); false for the buffer
   * source, whose reads are views onto the one resident copy of the file.
   */
  readonly ownsReads: boolean;
  read(o: number, l: number): Promise<Uint8Array>;
  /** Several ranges at once, in as few requests as their layout allows. Results in input order. */
  readMany(ranges: readonly ByteRange[]): Promise<Uint8Array[]>;
  /** A range as a Blob of `type` (an image or sound to decode), without bringing its bytes into the page where it can. */
  readBlob(o: number, l: number, type: string): Promise<Blob>;
  /** What it has read so far (also `window.CLEO_GAME_SOURCE`). */
  readonly stats: SourceStats;
}

/** What has been read so far, for the smoke test and memory measurements (`window.CLEO_GAME_SOURCE`). */
export interface SourceStats {
  kind: GameSource['kind'];
  size: number;
  requests: number;
  bytesRead: number;
}

/** Requests in flight at once: the per-host limit of HTTP/1.1, and plenty for a local file. */
const PARALLEL = 4;
/** The first request asks for this much: the header and, for most games, the whole manifest. */
export const PROBE_BYTES = 1 << 20;

function checkRange(size: number, o: number, l: number): void {
  if (!(o >= 0 && l >= 0 && o + l <= size)) throw new Error(`game.bin is truncated: bytes ${o}..${o + l} of ${size}`);
}

function newStats(kind: GameSource['kind'], size: number): SourceStats {
  const stats = { kind, size, requests: 0, bytesRead: 0 };
  if (typeof window !== 'undefined') (window as any).CLEO_GAME_SOURCE = stats;
  return stats;
}

/** The file read whole into `buffer` (views onto it; nothing is copied). */
export function bufferSource(buffer: ArrayBuffer): GameSource {
  const size = buffer.byteLength;
  const stats = newStats('buffer', size);
  stats.bytesRead = size;
  const view = (o: number, l: number) => { checkRange(size, o, l); return new Uint8Array(buffer, o, l); };
  return {
    kind: 'buffer',
    size,
    stats,
    ownsReads: false,
    read: async (o, l) => view(o, l),
    readMany: async ranges => ranges.map(r => view(r.o, r.l)),
    readBlob: async (o, l, type) => new Blob([view(o, l) as BlobPart], { type }),
  };
}

/** Exact-size targets for `ranges`, filled span by span from `open(span)`. */
async function readSpans(
  ranges: readonly ByteRange[],
  size: number,
  stats: SourceStats,
  open: (span: Span) => Promise<ReadableStream<Uint8Array>>,
): Promise<Uint8Array[]> {
  for (const r of ranges) checkRange(size, r.o, r.l);
  const targets = ranges.map(r => new Uint8Array(r.l));
  const spans = planSpans(ranges, DEFAULT_SPAN_OPTIONS).filter(s => s.end > s.start);
  await pool(spans, PARALLEL, async span => {
    stats.requests++;
    // Not `bytesRead += await …`: that reads the total before the await, and parallel spans overwrite each other.
    const read = await scatter(await open(span), span, ranges, targets);
    stats.bytesRead += read;
  });
  return targets;
}

/** A Blob read lazily (Play in window: IndexedDB keeps it on disk). */
export function blobSource(blob: Blob): GameSource {
  const size = blob.size;
  const stats = newStats('blob', size);
  const readMany = (ranges: readonly ByteRange[]) =>
    readSpans(ranges, size, stats, async span => blob.slice(span.start, span.end).stream() as ReadableStream<Uint8Array>);
  return {
    kind: 'blob',
    size,
    stats,
    ownsReads: true,
    readMany,
    read: async (o, l) => (await readMany([{ o, l }]))[0],
    readBlob: async (o, l, type) => { checkRange(size, o, l); return blob.slice(o, o + l, type); },
  };
}

/** `bytes a-b/size` → its parts; null when absent or unparsable (`*` sizes included). */
export function parseContentRange(header: string | null): { start: number; end: number; size: number } | null {
  const m = header ? /^\s*bytes\s+(\d+)-(\d+)\/(\d+)\s*$/i.exec(header) : null;
  return m ? { start: Number(m[1]), end: Number(m[2]), size: Number(m[3]) } : null;
}

const encoded = (res: Response) => {
  const e = res.headers.get('content-encoding');
  return !!e && e.toLowerCase() !== 'identity';
};

/**
 * game.bin at `url` read by Range requests. Every answer must be a 206 for exactly the bytes asked of a file
 * of `size` — and carry the first answer's ETag, when it had one — or the file changed under the game.
 */
export function rangeSource(url: string, size: number, etag: string | null): GameSource {
  const stats = newStats('range', size);
  const fetchRange = async (start: number, end: number): Promise<Response> => {
    const ask = () => fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    let res: Response;
    try { res = await ask(); }
    catch { res = await ask(); } // one retry: a dropped connection, not a wrong answer
    const range = parseContentRange(res.headers.get('content-range'));
    const tag = res.headers.get('etag');
    if (res.status !== 206 || !range || range.start !== start || range.end !== end - 1 || range.size !== size ||
        encoded(res) || (etag && tag && tag !== etag)) {
      void res.body?.cancel().catch(() => {});
      throw new Error(`game.bin changed while the game was running (HTTP ${res.status}). Reload the page.`);
    }
    return res;
  };
  const readMany = (ranges: readonly ByteRange[]) =>
    readSpans(ranges, size, stats, async span => (await fetchRange(span.start, span.end)).body as ReadableStream<Uint8Array>);
  return {
    kind: 'range',
    size,
    stats,
    ownsReads: true,
    readMany,
    read: async (o, l) => (await readMany([{ o, l }]))[0],
    readBlob: async (o, l, type) => {
      checkRange(size, o, l);
      if (l === 0) return new Blob([], { type });
      stats.requests++;
      stats.bytesRead += l;
      // Re-wrapped for its type (an SVG must say so to decode); wrapping a Blob copies nothing.
      return new Blob([await (await fetchRange(o, o + l)).blob()], { type });
    },
  };
}

/**
 * A whole response body into one buffer. Streamed into a buffer of the announced length, so the file is
 * never held twice; `arrayBuffer()` only when the length is unknown or the body is encoded (its decoded
 * length is not the header's).
 */
async function readWhole(res: Response, onProgress?: (done: number, total: number) => void): Promise<ArrayBuffer> {
  const total = Number(res.headers.get('content-length'));
  if (!res.body || encoded(res) || !(total > 0)) {
    const buffer = await res.arrayBuffer();
    onProgress?.(buffer.byteLength, buffer.byteLength);
    return buffer;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (pos + value.length > total) { void reader.cancel(); throw new Error('game.bin is longer than its server said'); }
    out.set(value, pos);
    pos += value.length;
    onProgress?.(pos, total);
  }
  if (pos !== total) throw new Error(`game.bin ended early: ${pos} of ${total} bytes`);
  return out.buffer;
}

/** fetch, with the reason a web build opened from disk cannot work. */
async function fetchGame(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    // Browsers block reading a local file over file:// — the web build must be served over HTTP.
    if (typeof location !== 'undefined' && location.protocol === 'file:') {
      throw new Error(
        'This web build must be served over HTTP.\n' +
        'Browsers block reading game.bin when index.html is opened directly (file://).\n\n' +
        'Run one of these inside this folder, then open the URL it prints:\n' +
        '    npx http-server .\n' +
        '    python -m http.server\n\n' +
        'Tip: to get a double-click game instead, use Publish → Desktop in the editor.'
      );
    }
    throw new Error(`Could not load game.bin (${(e as any)?.message || e}).`);
  }
}

export interface OpenedGame {
  source: GameSource;
  /** The first bytes of the file, already read (the header and usually the manifest), or null. */
  prefix: Uint8Array | null;
}

/**
 * Open game.bin at `url`. The first request asks for its first {@link PROBE_BYTES}: a host that answers with
 * those (206) is read by range from then on; one that answers with the whole file (200) has ignored the
 * Range, and that same answer is streamed into one buffer, reporting `onProgress`.
 */
export async function openGameUrl(url: string, onProgress?: (done: number, total: number) => void): Promise<OpenedGame> {
  const res = await fetchGame(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` } });
  if (res.status === 206) {
    const range = parseContentRange(res.headers.get('content-range'));
    if (range && range.start === 0 && !encoded(res)) {
      const prefix = new Uint8Array(await res.arrayBuffer());
      // The whole file came back in the probe: nothing left to read by range.
      if (range.end + 1 >= range.size) return { source: bufferSource(prefix.buffer), prefix };
      return { source: rangeSource(url, range.size, res.headers.get('etag')), prefix };
    }
    // A range we cannot use (an encoded body, an unknown size): read the file whole instead.
    void res.body?.cancel().catch(() => {});
    const whole = await fetchGame(url);
    if (!whole.ok) throw new Error(`Could not load game.bin (HTTP ${whole.status}).`);
    return { source: bufferSource(await readWhole(whole, onProgress)), prefix: null };
  }
  if (!res.ok) throw new Error(`Could not load game.bin (HTTP ${res.status}).`);
  return { source: bufferSource(await readWhole(res, onProgress)), prefix: null };
}
