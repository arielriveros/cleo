// The binary-container primitives shared by the two things in this project that write one: publishing's
// `game.bin` (features/publish/pack.ts) and the project export's `assets.bin` (utils/bundleAssets.ts).
//
// Both formats are the same idea — a JSON side that describes the data, plus a blob of concatenated
// chunks that IS the data — and both need exactly the same three properties from it:
//
//   * 4-byte alignment. `new Float32Array(buffer, offset, n)` THROWS unless `offset % 4 === 0`, and
//     mapping typed arrays onto the buffer is the whole point of writing bytes instead of JSON.
//   * Blob-RELATIVE offsets. An absolute offset depends on the length of the JSON that holds it, which
//     depends on how many digits the offset takes to write — circular, and it would need an iterative
//     re-serialize to settle. The reader recovers the blob start with the same align4.
//   * Bounds checking on read. A chunk that runs past the end of a truncated file otherwise yields
//     plausible-looking garbage vertices rather than an error.
//
// Kept free of DOM, WebGL and `cleo` imports: this is pulled into projectWorker.ts, and the header of
// workers/projectJobs.ts explains why that constraint is load-bearing.

/** Where a chunk sits in the blob region: byte offset (blob-relative) and byte length. */
export interface ChunkRef { o: number; l: number }

/** Round up to the next 4-byte boundary. */
export const align4 = (n: number): number => (n + 3) & ~3;

/**
 * Coerce to a Uint8Array view.
 *
 * Needed because structured clone across the worker boundary can hand back a plain array where a
 * Uint8Array was sent. Anything binary arriving from the caller has to go through this or it silently
 * becomes a one-byte-per-element copy of the wrong thing.
 */
export const asBytes = (input: any): Uint8Array =>
  input instanceof Uint8Array ? input : new Uint8Array(input);

/** FNV-1a over a view's raw bytes, seeded so several views can be hashed into one digest. */
export const FNV_OFFSET = 0x811c9dc5;

export function hashBytes(h: number, view: ArrayBufferView): number {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** True when two views hold the same bytes. */
export function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Append-only writer for a blob of 4-byte-aligned chunks.
 *
 * `add` always writes a new chunk; `addInterned` returns the existing ref when the same bytes have been
 * written before. The split is deliberate rather than a flag: the publish packer must keep writing
 * chunk-per-attribute in its established order (it dedupes at the GEOMETRY level, above this), while the
 * export bundle wants dedup on every payload — which is what makes an animation clip stored once in a
 * model, once in a template and once in a scene collapse to a single copy.
 */
export class ChunkWriter {
  private readonly chunks: ArrayBufferView[] = [];
  private length = 0;
  /** hash -> the refs written under it, for addInterned. Empty unless addInterned is used. */
  private readonly buckets = new Map<number, { view: ArrayBufferView; ref: ChunkRef }[]>();

  /** Total bytes the blob will occupy, including trailing alignment padding. */
  get byteLength(): number { return this.length; }

  add(view: ArrayBufferView): ChunkRef {
    const ref: ChunkRef = { o: this.length, l: view.byteLength };
    this.chunks.push(view);
    this.length = align4(this.length + view.byteLength);
    return ref;
  }

  /**
   * Write `view`, or return the ref of an identical chunk already written.
   *
   * Bucketed by hash and then compared EXACTLY. A hash collision is astronomically unlikely but not
   * impossible, and accepting one would silently ship a mesh drawn with another mesh's vertices.
   */
  addInterned(view: ArrayBufferView): ChunkRef {
    const h = hashBytes(FNV_OFFSET, view);
    const bucket = this.buckets.get(h);
    if (bucket) {
      for (const entry of bucket) if (sameBytes(entry.view, view)) return entry.ref;
    }
    const ref = this.add(view);
    if (bucket) bucket.push({ view, ref });
    else this.buckets.set(h, [{ view, ref }]);
    return ref;
  }

  /** Copy every chunk into one buffer, at the offsets `add` handed out. */
  finish(): ArrayBuffer {
    const buffer = new ArrayBuffer(this.length);
    const out = new Uint8Array(buffer);
    let cursor = 0;
    for (const chunk of this.chunks) {
      out.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), cursor);
      cursor = align4(cursor + chunk.byteLength);
    }
    return buffer;
  }

  /**
   * Write every chunk into `out` starting at `blobStart`.
   *
   * The variant a container with a header uses: it has already allocated one buffer for header +
   * manifest + blob and only needs the blob region filled in.
   */
  writeInto(out: Uint8Array, blobStart: number): void {
    let cursor = blobStart;
    for (const chunk of this.chunks) {
      out.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), cursor);
      cursor = align4(cursor + chunk.byteLength);
    }
  }
}

/**
 * Bounds-checked reader over a blob of chunks.
 *
 * `label` names the file in the error message — the point of throwing at all is that a truncated
 * download is diagnosable instead of rendering as corrupt geometry.
 */
export class ChunkReader {
  constructor(
    private readonly buffer: ArrayBuffer,
    private readonly blobStart = 0,
    private readonly label = 'assets.bin',
  ) {}

  private start(ref: ChunkRef): number {
    const start = this.blobStart + ref.o;
    if (start < 0 || start + ref.l > this.buffer.byteLength)
      throw new Error(`${this.label} is truncated (chunk past end of file)`);
    return start;
  }

  bytes(ref: ChunkRef | undefined | null): Uint8Array | undefined {
    return ref ? new Uint8Array(this.buffer, this.start(ref), ref.l) : undefined;
  }

  floats(ref: ChunkRef | undefined | null): Float32Array | undefined {
    return ref ? new Float32Array(this.buffer, this.start(ref), ref.l / 4) : undefined;
  }

  u16(ref: ChunkRef | undefined | null): Uint16Array | undefined {
    return ref ? new Uint16Array(this.buffer, this.start(ref), ref.l / 2) : undefined;
  }

  u32(ref: ChunkRef | undefined | null): Uint32Array | undefined {
    return ref ? new Uint32Array(this.buffer, this.start(ref), ref.l / 4) : undefined;
  }
}

/** True when `v` looks like a `{ o, l }` chunk reference written by a ChunkWriter. */
export function isChunkRef(v: any): v is ChunkRef {
  return !!v && typeof v === 'object' && typeof v.o === 'number' && typeof v.l === 'number';
}
