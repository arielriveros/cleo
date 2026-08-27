// The binary-container primitives shared by publishing's `game.bin` (features/publish/pack.ts) and the
// project export's `assets.bin` (utils/bundleAssets.ts): a JSON side describing the data plus a blob of
// concatenated chunks that IS the data. Three properties both formats require:
//
//   * 4-byte alignment. `new Float32Array(buffer, offset, n)` THROWS unless `offset % 4 === 0`.
//   * Blob-RELATIVE offsets. An absolute offset depends on the length of the JSON holding it, which
//     depends on the offset's own digit count — circular. The reader recovers the blob start via align4.
//   * Bounds checking on read, or a truncated file yields plausible-looking garbage vertices.
//
// Must stay free of DOM, WebGL and `cleo` imports: this is pulled into projectWorker.ts.

/** Where a chunk sits in the blob region: byte offset (blob-relative) and byte length. */
export interface ChunkRef { o: number; l: number }

/** Round up to the next 4-byte boundary. */
export const align4 = (n: number): number => (n + 3) & ~3;

/**
 * Coerce to a Uint8Array view. Everything binary arriving from a caller must go through this: structured
 * clone across the worker boundary can hand back a plain array where a Uint8Array was sent.
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
 * `add` always writes a new chunk; `addInterned` returns the existing ref for bytes already written.
 * The publish packer needs `add` (it dedupes at the GEOMETRY level, above this); the export bundle needs
 * `addInterned`, which is what collapses a clip stored in a model, a template and a scene into one copy.
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
   * Bucketed by hash and then compared EXACTLY: accepting a hash collision would ship a mesh drawn with
   * another mesh's vertices.
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
   * Write every chunk into `out` starting at `blobStart` — for a container that has already allocated one
   * buffer for header + manifest + blob and needs only the blob region filled in.
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
 * Bounds-checked reader over a blob of chunks. `label` names the file in the error message, so a truncated
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
