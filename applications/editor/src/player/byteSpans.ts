// Reading many small byte ranges of game.bin in few requests. A scene's chunks (mesh attributes, terrain
// payloads, bone data) sit close together in the file, so neighbours are fetched as one SPAN and the span's
// bytes are scattered into one exact-size buffer per range as they stream in. No span-sized buffer is ever
// kept: a Geometry keeps the arrays it is given by reference, so a view onto a shared span would pin every
// neighbour for as long as one mesh lives.
//
// Pure (no DOM, no engine): unit-tested under vitest.

/** A run of bytes, by absolute offset into the file. */
export interface ByteRange {
  o: number;
  l: number;
}

/** Bytes fetched in one request: `[start, end)`, covering the ranges at `members` (indices into the input). */
export interface Span {
  start: number;
  end: number;
  members: number[];
}

export interface SpanOptions {
  /** Neighbours closer than this are fetched together (the bytes between are read and dropped). */
  maxGap: number;
  /** A span stops growing at this size, so one request never carries a whole scene. */
  maxSpan: number;
}

export const DEFAULT_SPAN_OPTIONS: SpanOptions = { maxGap: 64 << 10, maxSpan: 16 << 20 };

/** Group `ranges` into spans in file order. A range larger than `maxSpan` is a span of its own. */
export function planSpans(ranges: readonly ByteRange[], options: SpanOptions = DEFAULT_SPAN_OPTIONS): Span[] {
  const order = ranges.map((_, i) => i).sort((a, b) => ranges[a].o - ranges[b].o || ranges[a].l - ranges[b].l);
  const spans: Span[] = [];
  let current: Span | null = null;
  for (const i of order) {
    const { o, l } = ranges[i];
    const end = o + l;
    if (current && o - current.end <= options.maxGap && Math.max(current.end, end) - current.start <= options.maxSpan) {
      current.end = Math.max(current.end, end);
      current.members.push(i);
    } else {
      current = { start: o, end, members: [i] };
      spans.push(current);
    }
  }
  return spans;
}

/**
 * Copy a span's streamed bytes into `targets[m]` (an exact-size buffer for `ranges[m]`) for every member
 * `m` of the span. Throws when the stream carries fewer bytes than the span.
 */
export async function scatter(
  stream: ReadableStream<Uint8Array>,
  span: Span,
  ranges: readonly ByteRange[],
  targets: Uint8Array[],
): Promise<number> {
  // Members in file order, so the copy for each piece starts at the first member still open.
  const members = [...span.members].sort((a, b) => ranges[a].o - ranges[b].o);
  let first = 0;
  let pos = span.start;
  let ended = false;
  const reader = stream.getReader();
  try {
    while (pos < span.end) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      const pieceStart = pos;
      const pieceEnd = pos + value.length;
      while (first < members.length && ranges[members[first]].o + ranges[members[first]].l <= pieceStart) first++;
      for (let k = first; k < members.length; k++) {
        const r = ranges[members[k]];
        if (r.o >= pieceEnd) break;
        const from = Math.max(r.o, pieceStart);
        const to = Math.min(r.o + r.l, pieceEnd);
        if (to > from) targets[members[k]].set(value.subarray(from - pieceStart, to - pieceStart), from - r.o);
      }
      pos = pieceEnd;
    }
    // Every byte is in: see the stream end rather than cancel it, which a browser counts as an aborted
    // response (and may then not cache).
    if (!ended && pos >= span.end) ended = (await reader.read()).done;
  } finally {
    // A source that sent more than the span (or an error mid-way) leaves the rest unread: let it go.
    if (ended) reader.releaseLock();
    else await reader.cancel().catch(() => {});
  }
  if (pos < span.end) throw new Error(`game.bin ended early: got ${pos - span.start} of ${span.end - span.start} bytes at ${span.start}`);
  return pos - span.start;
}

/** `fn` over `items`, at most `limit` at a time; results in input order. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}
