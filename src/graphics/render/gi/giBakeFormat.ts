import { GI_HIT_PROBES_PER_ROW, hitCacheSize } from './giLayout';

/**
 * The saved form of a GI volume's capture: the `.cgib` bytes a bake stores with the project and a published
 * game carries in game.bin. Pure.
 *
 * Only what the CAPTURE produced is saved — the per-probe state and the three hit cache textures, in their
 * texture row order so a load is three uploads with no conversion. The irradiance is NOT saved: it is
 * relit at load, under whatever sun and lights the scene has then; the visibility is rebuilt from the hit
 * distances by one pass.
 *
 * LAYOUT, little-endian, every section 4-byte aligned:
 *
 *   0   'CGIB'                     magic
 *   4   u32 version                GI_BAKE_VERSION
 *   8   u32 flags                  bit 0: the sections are deflated (GI_BAKE_DEFLATED)
 *   12  u32 nx, ny, nz             probe counts
 *   24  u32 rays                   64 | 256
 *   28  u32 captureResolution      16 | 32
 *   32  f32 maxRayDistance
 *   36  f32 sizeX, sizeY, sizeZ    the box the capture was taken for
 *   48  u32 probesPerRow           64: the hit cache layout
 *   52  u32 signature lo, hi       hash of the static geometry the capture saw
 *   60  u32 hitWidth, hitHeight
 *   68  u32 sectionCount           4
 *   72  u32 offset, length  x4     probe data, hit A, hit B, hit C
 *   104 ... sections
 *
 * Probe data is four f32 a probe: xyz an offset from its grid position (0 in v1), w its state
 * (giClassify.ts). The hit caches are RGBA8, `hitWidth` x `hitHeight`.
 *
 * PACKED: a saved bake is stored with everything after the header deflated (zlib, `packGiBake`), a third to
 * a sixth of its size; the header stays as it is, so a load checks the shape and the signature before it
 * inflates anything. The offsets in the header are those of the inflated layout (`unpackGiBake`).
 */

export const GI_BAKE_MAGIC = 0x42494743; // 'CGIB' read little-endian
export const GI_BAKE_VERSION = 1;
/** `flags` bit: everything after the header is deflated (zlib). */
export const GI_BAKE_DEFLATED = 1;
const HEADER_BYTES = 104;
const SECTIONS = 4;

/** What a bake's header says, readable without inflating it. */
export interface GiBakeHeader {
    counts: [number, number, number];
    rays: number;
    captureResolution: number;
    maxRayDistance: number;
    size: [number, number, number];
    signature: [number, number];
    /** The sections are deflated: `unpackGiBake` before `decodeGiBake`. */
    packed: boolean;
}

export interface GiBake {
    counts: [number, number, number];
    rays: number;
    captureResolution: number;
    maxRayDistance: number;
    size: [number, number, number];
    /** The geometry signature, two u32 (see {@link GiSignature}). */
    signature: [number, number];
    /** Four floats a probe: offset xyz, state. */
    probeData: Float32Array;
    hitA: Uint8Array;
    hitB: Uint8Array;
    hitC: Uint8Array;
}

export class GiBakeFormatError extends Error {
    constructor(message: string) {
        super(`GI bake: ${message}`);
        this.name = 'GiBakeFormatError';
    }
}

/** Bytes a bake of this shape takes. */
export function giBakeByteLength(counts: ArrayLike<number>, rays: number): number {
    const probes = counts[0] * counts[1] * counts[2];
    const [w, h] = hitCacheSize(probes, rays);
    return HEADER_BYTES + probes * 16 + 3 * w * h * 4;
}

export function encodeGiBake(bake: GiBake): Uint8Array {
    const probes = bake.counts[0] * bake.counts[1] * bake.counts[2];
    const [w, h] = hitCacheSize(probes, bake.rays);
    const hitBytes = w * h * 4;
    if (bake.probeData.length !== probes * 4) throw new GiBakeFormatError(`probe data holds ${bake.probeData.length / 4} probes, the grid ${probes}`);
    for (const [name, hit] of [['A', bake.hitA], ['B', bake.hitB], ['C', bake.hitC]] as const) {
        if (hit.length !== hitBytes) throw new GiBakeFormatError(`hit cache ${name} is ${hit.length} bytes, ${w}x${h} needs ${hitBytes}`);
    }
    const out = new Uint8Array(giBakeByteLength(bake.counts, bake.rays));
    const view = new DataView(out.buffer);
    view.setUint32(0, GI_BAKE_MAGIC, true);
    view.setUint32(4, GI_BAKE_VERSION, true);
    view.setUint32(8, 0, true);
    view.setUint32(12, bake.counts[0], true);
    view.setUint32(16, bake.counts[1], true);
    view.setUint32(20, bake.counts[2], true);
    view.setUint32(24, bake.rays, true);
    view.setUint32(28, bake.captureResolution, true);
    view.setFloat32(32, bake.maxRayDistance, true);
    view.setFloat32(36, bake.size[0], true);
    view.setFloat32(40, bake.size[1], true);
    view.setFloat32(44, bake.size[2], true);
    view.setUint32(48, GI_HIT_PROBES_PER_ROW, true);
    view.setUint32(52, bake.signature[0] >>> 0, true);
    view.setUint32(56, bake.signature[1] >>> 0, true);
    view.setUint32(60, w, true);
    view.setUint32(64, h, true);
    view.setUint32(68, SECTIONS, true);

    let offset = HEADER_BYTES;
    const sections: [number, Uint8Array][] = [
        [probes * 16, new Uint8Array(bake.probeData.buffer, bake.probeData.byteOffset, probes * 16)],
        [hitBytes, bake.hitA], [hitBytes, bake.hitB], [hitBytes, bake.hitC],
    ];
    sections.forEach(([length, bytes], i) => {
        view.setUint32(72 + i * 8, offset, true);
        view.setUint32(76 + i * 8, length, true);
        out.set(bytes, offset);
        offset += length;
    });
    return out;
}

/** The header of `bytes`, packed or not. Throws {@link GiBakeFormatError} on a malformed one. */
export function readGiBakeHeader(bytes: Uint8Array | ArrayBuffer): GiBakeHeader {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.byteLength < HEADER_BYTES) throw new GiBakeFormatError(`${data.byteLength} bytes is shorter than the header`);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) !== GI_BAKE_MAGIC) throw new GiBakeFormatError('not a GI bake (bad magic)');
    const version = view.getUint32(4, true);
    if (version !== GI_BAKE_VERSION) throw new GiBakeFormatError(`version ${version} is not supported (this build reads ${GI_BAKE_VERSION})`);
    const rays = view.getUint32(24, true);
    if (rays !== 64 && rays !== 256) throw new GiBakeFormatError(`${rays} rays per probe`);
    if (view.getUint32(48, true) !== GI_HIT_PROBES_PER_ROW) throw new GiBakeFormatError('unknown hit cache layout');
    return {
        counts: [view.getUint32(12, true), view.getUint32(16, true), view.getUint32(20, true)],
        rays,
        captureResolution: view.getUint32(28, true),
        maxRayDistance: view.getFloat32(32, true),
        size: [view.getFloat32(36, true), view.getFloat32(40, true), view.getFloat32(44, true)],
        signature: [view.getUint32(52, true), view.getUint32(56, true)],
        packed: (view.getUint32(8, true) & GI_BAKE_DEFLATED) !== 0,
    };
}

/** `bytes` through a compression or decompression stream (browsers, Electron and Node 18+ all have them). */
async function throughStream(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
    const blob = new Blob([bytes as BlobPart]);
    return new Uint8Array(await new Response(blob.stream().pipeThrough(stream as any)).arrayBuffer());
}

/**
 * A bake as it is saved: the header as it was (its `flags` marked) and the rest deflated. A bake the
 * deflate would not shrink stays as it is. Idempotent.
 */
export async function packGiBake(raw: Uint8Array): Promise<Uint8Array> {
    if (readGiBakeHeader(raw).packed) return raw;
    const body = await throughStream(raw.subarray(HEADER_BYTES), new CompressionStream('deflate'));
    if (HEADER_BYTES + body.byteLength >= raw.byteLength) return raw;
    const out = new Uint8Array(HEADER_BYTES + body.byteLength);
    out.set(raw.subarray(0, HEADER_BYTES), 0);
    out.set(body, HEADER_BYTES);
    const view = new DataView(out.buffer);
    view.setUint32(8, view.getUint32(8, true) | GI_BAKE_DEFLATED, true);
    return out;
}

/** The plain form of a bake `packGiBake` packed (`decodeGiBake` reads it); one already plain as it is. */
export async function unpackGiBake(bytes: Uint8Array): Promise<Uint8Array> {
    if (!readGiBakeHeader(bytes).packed) return bytes;
    let body: Uint8Array;
    try {
        body = await throughStream(bytes.subarray(HEADER_BYTES), new DecompressionStream('deflate'));
    } catch (e) {
        throw new GiBakeFormatError(`the packed sections do not inflate (${(e as Error)?.message ?? e})`);
    }
    const out = new Uint8Array(HEADER_BYTES + body.byteLength);
    out.set(bytes.subarray(0, HEADER_BYTES), 0);
    out.set(body, HEADER_BYTES);
    const view = new DataView(out.buffer);
    view.setUint32(8, view.getUint32(8, true) & ~GI_BAKE_DEFLATED, true);
    return out;
}

/**
 * Read a plain bake (a packed one throws: `unpackGiBake` it first). The sections are VIEWS onto `bytes`
 * where its alignment allows, copies where it does not. Throws {@link GiBakeFormatError} on anything
 * malformed.
 */
export function decodeGiBake(bytes: Uint8Array | ArrayBuffer): GiBake {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const header = readGiBakeHeader(data);
    if (header.packed) throw new GiBakeFormatError('the bake is packed: unpack it first');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const counts = header.counts, rays = header.rays;
    const probes = counts[0] * counts[1] * counts[2];
    const [w, h] = hitCacheSize(probes, rays);
    if (view.getUint32(60, true) !== w || view.getUint32(64, true) !== h) throw new GiBakeFormatError('hit cache size does not match the grid');
    if (view.getUint32(68, true) !== SECTIONS) throw new GiBakeFormatError('unexpected section count');

    const section = (i: number, expected: number): Uint8Array => {
        const offset = view.getUint32(72 + i * 8, true), length = view.getUint32(76 + i * 8, true);
        if (length !== expected) throw new GiBakeFormatError(`section ${i} is ${length} bytes, expected ${expected}`);
        if (offset % 4 !== 0 || offset + length > data.byteLength) throw new GiBakeFormatError(`section ${i} lies outside the data`);
        return data.subarray(offset, offset + length);
    };
    const probeBytes = section(0, probes * 16);
    const aligned = (probeBytes.byteOffset % 4) === 0;
    const probeData = aligned
        ? new Float32Array(probeBytes.buffer, probeBytes.byteOffset, probes * 4)
        : new Float32Array(probeBytes.slice().buffer);
    return {
        counts, rays,
        captureResolution: view.getUint32(28, true),
        maxRayDistance: view.getFloat32(32, true),
        size: [view.getFloat32(36, true), view.getFloat32(40, true), view.getFloat32(44, true)],
        signature: [view.getUint32(52, true), view.getUint32(56, true)],
        probeData,
        hitA: section(1, w * h * 4), hitB: section(2, w * h * 4), hitC: section(3, w * h * 4),
    };
}

/**
 * A 64-bit hash of what a capture saw (two FNV-1a 32-bit lanes with different seeds), so a load can tell
 * the static geometry has changed since the bake. Numbers are quantized to 1e-4 so float noise in a
 * transform does not read as a change.
 */
export class GiSignature {
    private _a = 0x811c9dc5;
    private _b = 0x01000193 ^ 0x9e3779b9;

    public addString(s: string): this {
        for (let i = 0; i < s.length; i++) this._byte(s.charCodeAt(i) & 0xff)._byte((s.charCodeAt(i) >>> 8) & 0xff);
        return this._byte(0);
    }

    public addNumber(v: number): this {
        const q = Number.isFinite(v) ? Math.round(v * 1e4) : 0;
        const lo = q | 0, hi = Math.floor(q / 4294967296) | 0;
        for (const word of [lo, hi]) {
            for (let k = 0; k < 4; k++) this._byte((word >>> (k * 8)) & 0xff);
        }
        return this;
    }

    public addNumbers(values: ArrayLike<number>): this {
        for (let i = 0; i < values.length; i++) this.addNumber(values[i]);
        return this;
    }

    public get value(): [number, number] { return [this._a >>> 0, this._b >>> 0]; }

    private _byte(b: number): this {
        this._a = Math.imul(this._a ^ b, 0x01000193);
        this._b = Math.imul(this._b ^ b, 0x01000193) ^ (this._b >>> 15);
        return this;
    }
}

/** Whether two signatures are the same. */
export function sameGiSignature(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
    return (a[0] >>> 0) === (b[0] >>> 0) && (a[1] >>> 0) === (b[1] >>> 0);
}
