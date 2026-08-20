// Publish-time packer: turn a built game-data object into ONE self-contained binary — `game.bin`.
//
// What this replaces: publishing used to emit `game.json`, where every mesh's vertex arrays were
// decimal-string JSON (Model.serialize does Array.from(Float32Array)) and every texture was a base64
// data URI. Floats cost ~3-4x their binary size as text, base64 inflates already-compressed image
// bytes by 33%, and the player had to JSON.parse the lot and then rebuild every Float32Array by hand
// before it could draw a frame.
//
// Here the numeric arrays are written as raw little-endian bytes and the textures as their ORIGINAL
// compressed PNG/JPEG bytes, so the player can map typed arrays straight onto the downloaded
// ArrayBuffer (see player/unpack.ts) with no parse and no copy.
//
// This module is pure data — no DOM, no WebGL, no `cleo` import — because it runs inside
// projectWorker.ts. See the header of workers/projectJobs.ts for why that constraint is load-bearing.

// JSON, not a .ts constant, so webpack.player.config.js (CommonJS) can `require` the same file the
// packer imports. One number, one source of truth.
import playerContract from './playerContract.json';

/** File layout, version 1:
 *
 *   0   magic "CLEOPAK1"   8 bytes ASCII
 *   8   uint32 LE  version         format version (1)
 *   12  uint32 LE  manifestLength  byte length of the JSON manifest
 *   16  manifest            UTF-8 JSON, zero-padded to the next 4-byte boundary
 *   ..  blob region         concatenated chunks, each zero-padded to a 4-byte boundary
 *
 * The manifest gained optional fields over time (foliage geometry refs, terrain splat/height chunks)
 * without a version bump: an older reader ignores a field it does not know, and an older FILE simply
 * lacks it — so the readers fall back. Bumping the version would instead make every already-published
 * game.bin unloadable, which buys nothing.
 *
 * Chunk offsets in the manifest are **relative to the start of the blob region**, not absolute.
 * They have to be: an absolute offset depends on the manifest's length, which depends on how many
 * digits the offsets take to write — a circular dependency that would otherwise need an iterative
 * re-serialize to settle. The reader recovers the blob start with the same align4 it is written at.
 *
 * The 4-byte alignment is not cosmetic. `new Float32Array(buffer, offset, n)` throws unless
 * `offset % 4 === 0`, and that constructor is the whole point of this format.
 */
export const PACK_MAGIC = 'CLEOPAK1';
export const PACK_VERSION = 1;
export const PACK_HEADER_BYTES = 16;

/**
 * Player contract — a SECOND version number, orthogonal to PACK_VERSION above.
 *
 * PACK_VERSION describes the byte layout and must stay 1 forever (see the note above about not
 * orphaning already-published games). But "an older reader ignores a field it does not know" only
 * degrades gracefully when the missing field is optional, and some are not: when the packer moved
 * terrain heights out of the manifest string into `heightChunk`, a player that ignores `heightChunk`
 * does not fall back — it renders a perfectly flat landscape and logs nothing. The same is true of
 * an engine with no animation-field playback meeting a `state.field`.
 *
 * That is a real bug that shipped: `editor/public/player/game.js` is a build artifact nothing forces
 * you to rebuild, so it sat a month behind the packer and every publish in that month silently lost
 * its terrain and its blend spaces.
 *
 * So: the player build stamps this number into `public/player/build.json`, publishClient compares it
 * before shipping the bundle, and the player re-checks `manifest.contract` at boot. Bump it whenever
 * the packer starts emitting something an older player cannot read.
 */
export const PLAYER_CONTRACT: number = playerContract.contract;

/** Where a chunk sits in the blob region: byte offset and byte length. */
export interface ChunkRef { o: number; l: number }

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
   * plays which. An asset-backed clip is deliberately absent from every serialized node, so the player
   * retargets these onto each character at scene load — see player/animations.ts. Both absent on a game
   * published before shared animations existed.
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

const align4 = (n: number): number => (n + 3) & ~3;

/** Structured clone across the worker boundary can turn a Uint8Array back into a plain array. */
const asBytes = (input: any): Uint8Array =>
  input instanceof Uint8Array ? input : new Uint8Array(input);

/**
 * Narrowest lossless index width.
 *
 * This mirrors `needs32Bit`/`createIndexArray` in src/graphics/indexFormat.ts, which is the canonical
 * implementation. It is duplicated rather than imported because that module lives in the engine
 * package and the only path to it from here is `cleo` — and importing `cleo` inside the project
 * worker would drag the WebGL graph across the thread boundary, which projectJobs.ts explicitly
 * forbids. Keep the two in step: 65535 is excluded because WebGL2 treats it as the primitive-restart
 * index, so a mesh using it as a real index would silently drop triangles.
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
 *
 * Both shapes really occur. `Model.serialize()` emits flat arrays, but the editor's foliage rule baker
 * (utils/foliageRules.ts) emits NESTED tuples — and `new Float32Array(number[][])` does not throw, it
 * yields an array of NaN. Normalizing here is also what makes the nested copy of a foliage mesh and the
 * flat copy of the same mesh hash identically, so they dedupe to one chunk instead of two.
 *
 * Mirrors `toFlat` in src/core/geometry.ts, duplicated for the same reason as toIndexArray above: this
 * module may not import `cleo`.
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

/**
 * FNV-1a over a view's raw bytes.
 *
 * The old packAssets keyed its geometry dedup on `JSON.stringify(model.geometry)` — a full
 * re-stringification of every mesh in the game, O(total geometry bytes) of string work thrown away
 * immediately. Hashing the bytes we are about to write costs a single pass over data we already hold.
 */
function hashBytes(h: number, view: ArrayBufferView): number {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

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
 *
 * `data` is MUTATED, exactly as packAssets was: each `model.geometry` is replaced by a
 * `model.geometryRef` into the manifest's geometry table. That is safe here because the caller sends
 * the object into the worker by structured clone, so the editor's own copy is untouched.
 */
export function packGameBin(data: any): { buffer: ArrayBuffer; stats: PackStats } {
  const chunks: ArrayBufferView[] = [];
  let blobBytes = 0;

  const addChunk = (view: ArrayBufferView): ChunkRef => {
    const o = blobBytes;
    chunks.push(view);
    blobBytes = align4(blobBytes + view.byteLength);
    return { o, l: view.byteLength };
  };

  // --- Geometry: collect, dedupe, lay out -------------------------------------------------------

  const geometries: Record<string, PackedGeometry> = {};
  const buckets = new Map<number, { id: string; arrays: GeoArrays }[]>(); // hash -> candidates
  let counter = 0;

  const intern = (raw: any): string => {
    const arrays: GeoArrays = { attrs: {} };
    let h = 0x811c9dc5;
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

    // Hash collisions are astronomically unlikely but not impossible, and a false match would ship a
    // mesh drawn with another mesh's vertices — silent corruption. Compare exactly within the bucket.
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
    if (model && model.geometry && typeof model.geometry === 'object') {
      model.geometryRef = intern(model.geometry);
      delete model.geometry;
    }
  };

  /**
   * Every prototype mesh a foliage rule or a serialized foliage layer carries: the legacy single model,
   * LOD0's sub-meshes, and each extra LOD level's.
   *
   * These used to bypass the packer entirely and ship as decimal-string JSON inside the manifest — and
   * TWICE over, because the same mesh appears both on the terrain material's rule and on the scattered
   * layer built from it. Interning both makes them collapse to one chunk.
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
        // Compressed heights/splat (see publish/terrainImages.ts) move out of the JSON manifest into
        // the blob, referenced exactly like a geometry chunk.
        if (terrain.splatBytes) { terrain.splatChunk = addChunk(asBytes(terrain.splatBytes)); delete terrain.splatBytes; }
        if (terrain.heightBytes) { terrain.heightChunk = addChunk(asBytes(terrain.heightBytes)); delete terrain.heightBytes; }
      }

      // Tilemap chunks, symmetric to terrain's: the deflated cell grids move out of the JSON manifest and
      // into the blob, referenced the same way a geometry chunk is.
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

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const blobStart = align4(PACK_HEADER_BYTES + manifestBytes.length);
  const buffer = new ArrayBuffer(blobStart + blobBytes);
  const out = new Uint8Array(buffer);
  const view = new DataView(buffer);

  for (let i = 0; i < PACK_MAGIC.length; i++) view.setUint8(i, PACK_MAGIC.charCodeAt(i));
  view.setUint32(8, PACK_VERSION, true);
  view.setUint32(12, manifestBytes.length, true);
  out.set(manifestBytes, PACK_HEADER_BYTES);

  let cursor = blobStart;
  for (const chunk of chunks) {
    out.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), cursor);
    cursor = align4(cursor + chunk.byteLength);
  }

  return {
    buffer,
    stats: { geometries: counter, textures: textures.length, bytes: buffer.byteLength },
  };
}
