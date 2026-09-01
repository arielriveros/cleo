// Publish-time packer: turn a built game-data object into ONE self-contained binary — `game.bin`.
// Numeric arrays are written as raw little-endian bytes and textures as their ORIGINAL compressed
// PNG/JPEG bytes, so the player maps typed arrays straight onto the downloaded ArrayBuffer with no
// parse and no copy (see player/unpack.ts).
// Pure data — no DOM, no WebGL, no `cleo` import: this module runs inside projectWorker.ts.

// JSON, not a .ts constant, so vite.player.config.ts can import the same file to stamp build.json.
import playerContract from './playerContract.json';
// The container primitives (alignment, chunk refs, byte hashing) are shared with the project export's
// assets.bin — see utils/chunkBlob.ts.
import { ChunkWriter, align4, asBytes, hashBytes, FNV_OFFSET, type ChunkRef } from '../../utils/chunkBlob';

/** File layout, version 1:
 *
 *   0   magic "CLEOPAK1"   8 bytes ASCII
 *   8   uint32 LE  version         format version (1)
 *   12  uint32 LE  manifestLength  byte length of the JSON manifest
 *   16  manifest            UTF-8 JSON, zero-padded to the next 4-byte boundary
 *   ..  blob region         concatenated chunks, each zero-padded to a 4-byte boundary
 *
 * New optional manifest fields are added without a version bump; a reader that does not know a field
 * ignores it and an older file simply lacks it.
 *
 * Chunk offsets in the manifest are **relative to the start of the blob region**, never absolute: an
 * absolute offset would depend on the manifest's length, which depends on the offsets' digit count.
 * The reader recovers the blob start with the same align4 it is written at.
 *
 * The 4-byte alignment is required: `new Float32Array(buffer, offset, n)` throws unless
 * `offset % 4 === 0`.
 */
export const PACK_MAGIC = 'CLEOPAK1';
export const PACK_VERSION = 1;
export const PACK_HEADER_BYTES = 16;

/**
 * Player contract — a SECOND version number, orthogonal to PACK_VERSION above.
 *
 * PACK_VERSION stays 1 so already-published games stay loadable, but ignoring an unknown field does not
 * always degrade gracefully: a player that ignores `heightChunk` renders a flat landscape and logs
 * nothing. The player build stamps this number into `public/player/build.json`, publishClient compares
 * it before shipping the bundle, and the player re-checks `manifest.contract` at boot.
 * Bump it whenever the packer starts emitting something an older player cannot read.
 */
export const PLAYER_CONTRACT: number = playerContract.contract;

/** Where a chunk sits in the blob region: byte offset and byte length. */
export type { ChunkRef };

/** The five float attributes, in the order Model.serialize emits them. */
export const ATTRS = ['positions', 'normals', 'tangents', 'bitangents', 'texCoords'] as const;
export type AttrName = typeof ATTRS[number];

export interface PackedGeometry extends Partial<Record<AttrName, ChunkRef>> {
  /** Absent for an unindexed mesh. `bits` is 16 or 32. */
  indices?: ChunkRef & { bits: 16 | 32 };
}

export interface PackedTexture {
  id: string;
  mime: string;
  config: any;
  o: number;
  l: number;
}

export interface PackManifest {
  format: 'cleopak';
  version: number;
  /** See PLAYER_CONTRACT. Absent on games published before the guard existed. */
  contract?: number;
  entry: string;
  scenes: Record<string, { name: string; scene: any }>;
  /** Baked node templates for runtime scene.instantiate. Global, like textures — not per scene. */
  templates?: { id: string; name: string; node: any }[];
  /**
   * Shared animation clips, ONCE for the whole game, in their source rig's space, plus which model asset
   * plays which. An asset-backed clip is absent from every serialized node; the player retargets these
   * onto each character at scene load (player/animations.ts). Both absent on older published games.
   */
  animations?: { id: string; name: string; clips: any[]; sourceSkin: any }[];
  modelAnimations?: Record<string, string[]>;
  config?: any;
  geometries: Record<string, PackedGeometry>;
  textures: PackedTexture[];
}

export interface PackStats {
  geometries: number;
  textures: number;
  bytes: number;
}

/**
 * Narrowest lossless index width. Mirrors `needs32Bit`/`createIndexArray` in
 * src/graphics/indexFormat.ts, duplicated because this module may not import `cleo`; keep the two in
 * step. 65535 is excluded: WebGL2 treats it as the primitive-restart index.
 */
const INDEX_16_LIMIT = 65535;

function toIndexArray(indices: ArrayLike<number>): Uint16Array | Uint32Array {
  let max = -1;
  for (let i = 0; i < indices.length; i++) if (indices[i] > max) max = indices[i];
  return max >= INDEX_16_LIMIT ? new Uint32Array(indices) : new Uint16Array(indices);
}

/** Components per element, so a nested `[[x,y,z], ...]` attribute can be flattened. */
const ATTR_STRIDE: Record<AttrName, number> = {
  positions: 3, normals: 3, tangents: 3, bitangents: 3, texCoords: 2,
};

/**
 * Normalize an attribute to a flat Float32Array, whatever shape it arrived in.
 * `Model.serialize()` emits flat arrays; the foliage rule baker (utils/foliageRules.ts) emits NESTED
 * tuples, and `new Float32Array(number[][])` yields NaN rather than throwing. Normalizing also makes the
 * nested and flat copies of one mesh hash identically, so they dedupe to a single chunk.
 * Mirrors `toFlat` in src/core/geometry.ts, duplicated because this module may not import `cleo`.
 */
function toFloats(input: any, stride: number): Float32Array {
  if (!input || input.length === 0) return EMPTY_F32;
  if (input instanceof Float32Array) return input;
  if (typeof input[0] === 'object' && input[0] !== null) {
    const out = new Float32Array(input.length * stride);
    for (let i = 0; i < input.length; i++)
      for (let k = 0; k < stride; k++) out[i * stride + k] = input[i][k] ?? 0;
    return out;
  }
  return new Float32Array(input);
}

const EMPTY_F32 = new Float32Array(0);

/** Turn every typed array left in a structure into a plain array, in place. @see plainifyBuffers use. */
function plainifyBuffers(value: any, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  const keys = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
  for (const key of keys as any[]) {
    const child = (value as any)[key];
    if (ArrayBuffer.isView(child)) (value as any)[key] = Array.from(child as any);
    else if (child && typeof child === 'object') plainifyBuffers(child, seen);
  }
}

// Geometry dedup hashes the bytes it is about to write (hashBytes, chunkBlob.ts).

/** Typed arrays for one geometry, before layout. */
interface GeoArrays {
  attrs: Partial<Record<AttrName, Float32Array>>;
  indices?: Uint16Array | Uint32Array;
}

function sameGeometry(a: GeoArrays, b: GeoArrays): boolean {
  const eq = (x?: ArrayLike<number>, y?: ArrayLike<number>): boolean => {
    if (!x || !y) return !x?.length && !y?.length;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  };
  for (const name of ATTRS) if (!eq(a.attrs[name], b.attrs[name])) return false;
  if ((a.indices?.BYTES_PER_ELEMENT ?? 0) !== (b.indices?.BYTES_PER_ELEMENT ?? 0)) return false;
  return eq(a.indices, b.indices);
}

/**
 * Pack a built game-data object into a `game.bin` buffer.
 * `data` is MUTATED: each `model.geometry` is replaced by a `model.geometryRef` into the manifest's
 * geometry table. Safe because the caller sends the object into the worker by structured clone.
 */
export function packGameBin(data: any): { buffer: ArrayBuffer; stats: PackStats } {
  // Plain `add`, not `addInterned`: this format dedupes one level up, at the GEOMETRY (see intern below),
  // so two meshes sharing only their normals still get their own contiguous records.
  const blob = new ChunkWriter();
  const addChunk = (view: ArrayBufferView): ChunkRef => blob.add(view);

  // --- Geometry: collect, dedupe, lay out -------------------------------------------------------

  const geometries: Record<string, PackedGeometry> = {};
  const buckets = new Map<number, { id: string; arrays: GeoArrays }[]>(); // hash -> candidates
  let counter = 0;

  const intern = (raw: any): string => {
    const arrays: GeoArrays = { attrs: {} };
    let h = FNV_OFFSET;
    for (const name of ATTRS) {
      const floats = toFloats(raw[name], ATTR_STRIDE[name]);
      if (floats.length === 0) continue; // omit empty attributes entirely
      arrays.attrs[name] = floats;
      h = hashBytes(h, floats);
    }
    if (raw.indices && raw.indices.length > 0) {
      arrays.indices = toIndexArray(raw.indices);
      h = hashBytes(h, arrays.indices);
    }

    // A hash collision would ship a mesh drawn with another mesh's vertices, so compare exactly within
    // the bucket.
    const bucket = buckets.get(h);
    if (bucket) {
      for (const candidate of bucket) if (sameGeometry(candidate.arrays, arrays)) return candidate.id;
    }

    const id = `g${counter++}`;
    const packed: PackedGeometry = {};
    for (const name of ATTRS) {
      const floats = arrays.attrs[name];
      if (floats) packed[name] = addChunk(floats);
    }
    if (arrays.indices) {
      const bits = arrays.indices instanceof Uint32Array ? 32 : 16;
      packed.indices = { ...addChunk(arrays.indices), bits };
    }
    geometries[id] = packed;

    if (bucket) bucket.push({ id, arrays });
    else buckets.set(h, [{ id, arrays }]);
    return id;
  };

  const internModelJson = (model: any): void => {
    if (!model || typeof model !== 'object') return;
    if (model.geometry && typeof model.geometry === 'object') {
      model.geometryRef = intern(model.geometry);
      delete model.geometry;
    }
    // A skinned model's per-vertex bone data is 8 more floats a vertex — as big as positions+normals —
    // and `Model.serialize` now writes it as a Float32Array, which JSON.stringify would render as
    // `{"0":…}` and the player would read back as an empty buffer. Chunked, like terrain's grids.
    for (const name of ['jointIndices', 'jointWeights'] as const) {
      const value = model[name];
      if (value && value.length > 0) {
        model[`${name}Chunk`] = addChunk(toFloats(value, 4));
        delete model[name];
      }
    }
  };

  /**
   * Every prototype mesh a foliage rule or a serialized foliage layer carries: the legacy single model,
   * LOD0's sub-meshes, and each extra LOD level's. The same mesh appears both on the terrain material's
   * rule and on the scattered layer built from it; interning both collapses them to one chunk.
   */
  const internFoliageSource = (src: any): void => {
    if (!src || typeof src !== 'object') return;
    internModelJson(src.model);
    for (const m of (src.models ?? [])) internModelJson(m);
    for (const l of (src.lods ?? [])) for (const m of (l?.models ?? [])) internModelJson(m);
  };

  const visit = (node: any): void => {
    if (node && typeof node === 'object') {
      internModelJson(node.model);

      const terrain = node.terrain;
      if (terrain) {
        for (const f of (terrain.foliage ?? [])) internFoliageSource(f);
        for (const layer of (terrain.layers ?? []))
          for (const rule of (layer?.material?.foliageInclude ?? [])) internFoliageSource(rule);
        // Compressed heights/splat (publish/terrainImages.ts) move out of the JSON manifest into the
        // blob, referenced exactly like a geometry chunk.
        if (terrain.splatBytes) { terrain.splatChunk = addChunk(asBytes(terrain.splatBytes)); delete terrain.splatBytes; }
        if (terrain.heightBytes) { terrain.heightChunk = addChunk(asBytes(terrain.heightBytes)); delete terrain.heightBytes; }
      }

      // Tilemap chunks, symmetric to terrain's: the deflated cell grids move into the blob, referenced
      // the same way a geometry chunk is.
      const tilemap = node.tilemap;
      if (tilemap) {
        for (const layer of (tilemap.layers ?? [])) {
          for (const chunk of (layer?.chunks ?? [])) {
            if (chunk.dataBytes) { chunk.dataChunk = addChunk(asBytes(chunk.dataBytes)); delete chunk.dataBytes; }
            if (chunk.tintBytes) { chunk.tintChunk = addChunk(asBytes(chunk.tintBytes)); delete chunk.tintBytes; }
          }
        }
      }

      for (const child of (node.children ?? [])) visit(child);
    }
  };
  // One shared geometry table across every scene — identical meshes dedupe across scenes for free.
  for (const s of Object.values<any>(data?.scenes ?? {})) visit(s?.scene);
  // Templates share that table, so a template of a mesh already placed in a scene adds no bytes at all.
  for (const t of (data?.templates ?? [])) visit(t?.node);

  // --- Textures: original compressed bytes, no base64 anywhere ----------------------------------

  const textures: PackedTexture[] = [];
  for (const t of (data?.textureBytes ?? [])) {
    if (!t?.bytes || t.bytes.length === 0) continue;
    const bytes: Uint8Array = t.bytes instanceof Uint8Array ? t.bytes : new Uint8Array(t.bytes);
    const ref = addChunk(bytes);
    textures.push({ id: t.id, mime: t.mime || 'image/png', config: t.config, o: ref.o, l: ref.l });
  }

  // --- Assemble ---------------------------------------------------------------------------------

  const manifest: PackManifest = {
    format: 'cleopak',
    version: PACK_VERSION,
    contract: PLAYER_CONTRACT,
    entry: data?.entry ?? '',
    scenes: data?.scenes ?? {},
    templates: data?.templates,
    animations: data?.animations,
    modelAnimations: data?.modelAnimations,
    config: data?.config,
    geometries,
    textures,
  };

  // Last line of defence before the manifest becomes text. Anything still holding a typed array —
  // a skin's inverse-bind matrices, an animation sampler, a field added later — would stringify as
  // `{"0":…}` and load back as nothing. Chunked payloads are already gone by now; what is left is small,
  // so a plain array is the right shape for it.
  plainifyBuffers(manifest);

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const blobStart = align4(PACK_HEADER_BYTES + manifestBytes.length);
  const buffer = new ArrayBuffer(blobStart + blob.byteLength);
  const out = new Uint8Array(buffer);
  const view = new DataView(buffer);

  for (let i = 0; i < PACK_MAGIC.length; i++) view.setUint8(i, PACK_MAGIC.charCodeAt(i));
  view.setUint32(8, PACK_VERSION, true);
  view.setUint32(12, manifestBytes.length, true);
  out.set(manifestBytes, PACK_HEADER_BYTES);

  blob.writeInto(out, blobStart);

  return {
    buffer,
    stats: { geometries: counter, textures: textures.length, bytes: buffer.byteLength },
  };
}
