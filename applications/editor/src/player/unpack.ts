// Reader for the `game.bin` container written by features/publish/pack.ts; see that file for the byte
// layout. Two ways in:
//   - a running game reads it by range (gameSource.ts): readGameHeader at boot, then readChunkSet for each
//     scene's chunks (collectSceneRefs names them), so the file itself is never held;
//   - unpackGameBin over the whole file in one buffer, every numeric array a VIEW onto it (tests, tools).
// The inflate* functions put a scene's arrays back into its JSON from either.
// Kept free of DOM and engine imports so it can be unit-tested against the packer under vitest.

import { PACK_MAGIC, PACK_HEADER_BYTES, ATTRS } from '../features/publish/pack';
import type { PackManifest, PackedTexture, PackedSound } from '../features/publish/pack';
import { ChunkReader, align4, isChunkRef, type ChunkRef } from '@cleo/app-kit/utils/chunkBlob';
import { serializedTerrainFoliageRules } from '../utils/terrainJson';
import { PROBE_BYTES, type GameSource } from './gameSource';

/** The shape Model.parse reads out of `model.geometry`. */
export interface GeometryArrays {
  positions?: Float32Array;
  normals?: Float32Array;
  tangents?: Float32Array;
  bitangents?: Float32Array;
  texCoords?: Float32Array;
  indices?: Uint16Array | Uint32Array;
}

export interface UnpackedTexture {
  id: string;
  bytes: Uint8Array;
  mime: string;
  config: any;
}

export interface UnpackedSound {
  id: string;
  bytes: Uint8Array;
  mime: string;
  /** The authored SoundSettings, applied when the sample is registered. */
  settings: any;
}

/** How the inflate functions reach a chunk's bytes: the whole-file reader, or one scene's chunk set. */
export interface ChunkLookup {
  /** Geometry arrays for a `model.geometryRef`, or undefined if the ref is unknown. */
  geometryFor(ref: string): GeometryArrays | undefined;
  /** Raw bytes of a blob chunk (terrain splat/height payloads), bounds-checked. */
  chunkBytes(chunk: { o: number; l: number } | undefined): Uint8Array | undefined;
  /** Floats of a blob chunk (a skinned model's per-vertex bone data), bounds-checked. */
  chunkFloats(chunk: { o: number; l: number } | undefined): Float32Array | undefined;
}

export interface UnpackedGame extends ChunkLookup {
  manifest: PackManifest;
  textures: UnpackedTexture[];
  /** Empty for a game published before audio existed, or one with no Sound nodes. */
  sounds: UnpackedSound[];
  /** GI Volume bakes by id (views into game.bin). Empty for a game with none. */
  giBakes: { id: string; bytes: Uint8Array }[];
}

/** What a running game knows of its game.bin before reading any chunk. */
export interface GameHeader {
  manifest: PackManifest;
  /** Where the blob region starts: chunk refs are relative to it. */
  blobStart: number;
  /** The file's length in bytes. */
  size: number;
}

/** Check the fixed header (the first {@link PACK_HEADER_BYTES}); the manifest's length. */
export function readHeaderPrefix(bytes: Uint8Array): { manifestLength: number } {
  if (bytes.byteLength < PACK_HEADER_BYTES) throw new Error('game.bin is truncated (no header)');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let magic = '';
  for (let i = 0; i < PACK_MAGIC.length; i++) magic += String.fromCharCode(view.getUint8(i));
  if (magic !== PACK_MAGIC) throw new Error(`Not a Cleo game pack (magic "${magic}")`);

  const version = view.getUint32(8, true);
  if (version !== 1) throw new Error(`Unsupported game pack version ${version}`);

  return { manifestLength: view.getUint32(12, true) };
}

/** The manifest's UTF-8 JSON. */
export function parseManifest(bytes: Uint8Array): PackManifest {
  return JSON.parse(new TextDecoder().decode(bytes)) as PackManifest;
}

function readHeader(buffer: ArrayBuffer): { manifest: PackManifest; blobStart: number } {
  const { manifestLength } = readHeaderPrefix(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, PACK_HEADER_BYTES)));
  const manifestEnd = PACK_HEADER_BYTES + manifestLength;
  if (manifestEnd > buffer.byteLength) throw new Error('game.bin is truncated (manifest)');
  return { manifest: parseManifest(new Uint8Array(buffer, PACK_HEADER_BYTES, manifestLength)), blobStart: align4(manifestEnd) };
}

/**
 * The header and manifest of the game.bin `source` reads. `prefix` is the file's first bytes when the page
 * already has them (the probe of gameSource.openGameUrl); only what it lacks is read.
 */
export async function readGameHeader(source: GameSource, prefix?: Uint8Array | null): Promise<GameHeader> {
  const head = prefix && prefix.byteLength >= PACK_HEADER_BYTES
    ? prefix
    : await source.read(0, Math.min(source.size, PROBE_BYTES));
  const { manifestLength } = readHeaderPrefix(head);
  const manifestEnd = PACK_HEADER_BYTES + manifestLength;
  if (manifestEnd > source.size) throw new Error('game.bin is truncated (manifest)');
  const manifestBytes = head.byteLength >= manifestEnd
    ? head.subarray(PACK_HEADER_BYTES, manifestEnd)
    : await source.read(PACK_HEADER_BYTES, manifestLength);
  return { manifest: parseManifest(manifestBytes), blobStart: align4(manifestEnd), size: source.size };
}

export function unpackGameBin(buffer: ArrayBuffer): UnpackedGame {
  const { manifest, blobStart } = readHeader(buffer);

  const reader = new ChunkReader(buffer, blobStart, 'game.bin');

  const textures: UnpackedTexture[] = (manifest.textures ?? []).map((t: PackedTexture) => ({
    id: t.id,
    bytes: reader.bytes({ o: t.o, l: t.l })!,
    mime: t.mime,
    config: t.config,
  }));

  const sounds: UnpackedSound[] = (manifest.sounds ?? []).map((a: PackedSound) => ({
    id: a.id,
    bytes: reader.bytes({ o: a.o, l: a.l })!,
    mime: a.mime,
    settings: a.settings,
  }));

  // A geometry referenced by N nodes is read N times. The FIRST reader gets the zero-copy view; every
  // later one MUST get its own copy: Geometry.scale() writes into _positions in place, so a shared
  // view would make one scaled instance deform all the others.
  const claimed = new Set<string>();

  const geometryFor = (ref: string): GeometryArrays | undefined => {
    const packed = manifest.geometries?.[ref];
    if (!packed) return undefined;

    const first = !claimed.has(ref);
    claimed.add(ref);

    const out: GeometryArrays = {};
    for (const name of ATTRS) {
      const floats = reader.floats(packed[name]);
      if (!floats) continue;
      out[name] = first ? floats : floats.slice();
    }
    if (packed.indices) {
      const indices = packed.indices.bits === 32 ? reader.u32(packed.indices)! : reader.u16(packed.indices)!;
      out.indices = first ? indices : indices.slice();
    }
    return out;
  };

  const chunkBytes = (chunk: { o: number; l: number } | undefined): Uint8Array | undefined =>
    reader.bytes(chunk);

  // Copied, not viewed: AnimatedModel keeps these arrays and a shared view over the whole game.bin would
  // pin the download in memory — and two models sharing one chunk must not share one buffer.
  const chunkFloats = (chunk: { o: number; l: number } | undefined): Float32Array | undefined => {
    const floats = reader.floats(chunk);
    return floats ? floats.slice() : undefined;
  };

  const giBakes = (manifest.giBakes ?? []).map((b: { id: string; o: number; l: number }) => ({
    id: b.id,
    bytes: reader.bytes({ o: b.o, l: b.l })!,
  })).filter((b: { bytes?: Uint8Array }) => !!b.bytes);

  return { manifest, textures, sounds, giBakes, geometryFor, chunkBytes, chunkFloats };
}

function inflateModelJson(model: any, game: ChunkLookup): void {
  if (!model || typeof model !== 'object') return;
  if (typeof model.geometryRef === 'string') {
    const geometry = game.geometryFor(model.geometryRef);
    if (geometry) model.geometry = geometry;
    delete model.geometryRef;
  }
  // The skinned half — see internModelJson in publish/pack.ts, which the two must always mirror.
  for (const name of ['jointIndices', 'jointWeights'] as const) {
    const chunk = model[`${name}Chunk`];
    if (!chunk) continue;
    const floats = game.chunkFloats(chunk);
    if (floats) model[name] = floats;
    delete model[`${name}Chunk`];
  }
}

/** Put back the prototype meshes of one foliage rule / serialized foliage layer.
 *  Mirrors pack's internFoliageSource — the two must always walk the same fields. */
function inflateFoliageSource(src: any, game: ChunkLookup): void {
  if (!src || typeof src !== 'object') return;
  inflateModelJson(src.model, game);
  for (const m of (src.models ?? [])) inflateModelJson(m, game);
  for (const l of (src.lods ?? [])) for (const m of (l?.models ?? [])) inflateModelJson(m, game);
}

/** Replace every `model.geometryRef` in a scene tree with the arrays it points at, in place. */
export function inflateSceneGeometry(node: any, game: ChunkLookup): void {
  if (!node || typeof node !== 'object') return;
  inflateModelJson(node.model, game);

  const terrain = node.terrain;
  if (terrain) {
    for (const f of (terrain.foliage ?? [])) inflateFoliageSource(f, game);
    for (const rule of serializedTerrainFoliageRules(terrain)) inflateFoliageSource(rule, game);
  }

  for (const child of (node.children ?? [])) inflateSceneGeometry(child, game);
}

/**
 * Decompress every landscape's splat map and height field out of the blob, in place.
 *
 * Async: DecompressionStream has no synchronous form. DEFLATE, not PNG: the splat's alpha channel is
 * layer 3's blend weight and a canvas round-trip premultiplies it away. Fields absent from the blob
 * are left alone — base64 `heights`/`splat` is read directly by Terrain.deserialize.
 */
export async function inflateTerrainData(node: any, game: ChunkLookup): Promise<void> {
  if (!node || typeof node !== 'object') return;

  const terrain = node.terrain;
  if (terrain) {
    const splat = game.chunkBytes(terrain.splatChunk);
    if (splat) {
      terrain.splatData = await inflateBytes(splat);
      delete terrain.splatChunk;
    }
    const heights = game.chunkBytes(terrain.heightChunk);
    if (heights) {
      const raw = await inflateBytes(heights);
      terrain.heightsU16 = new Uint16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
      delete terrain.heightChunk;
    }
    // The layer stack's paint masks, handed to TerrainLayerStack.load pre-decoded as `masksData`.
    const stack = terrain.layerStack;
    const masks = stack ? game.chunkBytes(stack.masksChunk) : null;
    if (masks) {
      stack.masksData = await inflateBytes(masks);
      delete stack.masksChunk;
    }
  }

  for (const child of (node.children ?? [])) await inflateTerrainData(child, game);
}

/**
 * Decompress every tilemap's cell grids out of the blob, in place.
 *
 * Async for the same reason as {@link inflateTerrainData}; `data` stored as base64 is left alone.
 */
export async function inflateTilemapData(node: any, game: ChunkLookup): Promise<void> {
  if (!node || typeof node !== 'object') return;

  const tilemap = node.tilemap;
  if (tilemap) {
    for (const layer of (tilemap.layers ?? [])) {
      for (const chunk of (layer?.chunks ?? [])) {
        const cells = game.chunkBytes(chunk.dataChunk);
        if (cells) {
          const raw = await inflateBytes(cells);
          // inflateBytes always returns a fresh buffer at offset 0, so this view is 4-byte aligned.
          chunk.cellsU32 = new Uint32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
          delete chunk.dataChunk;
        }
        const tint = game.chunkBytes(chunk.tintChunk);
        if (tint) {
          const raw = await inflateBytes(tint);
          chunk.tintU32 = new Uint32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
          delete chunk.tintChunk;
        }
      }
    }
  }

  for (const child of (node.children ?? [])) await inflateTilemapData(child, game);
}

// ---- Reading one scene's chunks -------------------------------------------------------------------------

/** The chunks a scene (or a template) needs read before its JSON can be inflated, and the GI bakes it uses. */
export interface SceneRefs {
  chunks: ChunkRef[];
  giBakeIds: string[];
}

function addRef(out: ChunkRef[], ref: unknown): void {
  if (isChunkRef(ref)) out.push({ o: ref.o, l: ref.l });
}

/** Mirrors inflateModelJson: the geometry a `geometryRef` names, and the skinned half's chunks. */
function collectModel(model: any, manifest: PackManifest, out: ChunkRef[]): void {
  if (!model || typeof model !== 'object') return;
  if (typeof model.geometryRef === 'string') {
    const packed = manifest.geometries?.[model.geometryRef];
    if (packed) {
      for (const name of ATTRS) addRef(out, packed[name]);
      addRef(out, packed.indices);
    }
  }
  for (const name of ['jointIndices', 'jointWeights'] as const) addRef(out, model[`${name}Chunk`]);
}

/** Mirrors inflateFoliageSource. */
function collectFoliageSource(src: any, manifest: PackManifest, out: ChunkRef[]): void {
  if (!src || typeof src !== 'object') return;
  collectModel(src.model, manifest, out);
  for (const m of (src.models ?? [])) collectModel(m, manifest, out);
  for (const l of (src.lods ?? [])) for (const m of (l?.models ?? [])) collectModel(m, manifest, out);
}

/**
 * Every chunk the inflate functions will ask for in the tree at `node`, walking exactly the fields they do,
 * plus the GI bakes its volumes load. `data: false` leaves out the landscape and tilemap payloads (a
 * template is inflated for its geometry only, as boot always has).
 */
export function collectSceneRefs(node: any, manifest: PackManifest, options: { data?: boolean } = {}): SceneRefs {
  const data = options.data !== false;
  const refs: SceneRefs = { chunks: [], giBakeIds: [] };
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    collectModel(n.model, manifest, refs.chunks);
    const terrain = n.terrain;
    if (terrain) {
      for (const f of (terrain.foliage ?? [])) collectFoliageSource(f, manifest, refs.chunks);
      for (const rule of serializedTerrainFoliageRules(terrain)) collectFoliageSource(rule, manifest, refs.chunks);
      if (data) {
        addRef(refs.chunks, terrain.splatChunk);
        addRef(refs.chunks, terrain.heightChunk);
        addRef(refs.chunks, terrain.layerStack?.masksChunk);
      }
    }
    if (data) {
      for (const layer of (n.tilemap?.layers ?? [])) {
        for (const chunk of (layer?.chunks ?? [])) {
          addRef(refs.chunks, chunk?.dataChunk);
          addRef(refs.chunks, chunk?.tintChunk);
        }
      }
    }
    // A Water node's flow bake rides the GI bake chain (same registry, same game data).
    const bakeId = n.giVolume?.bakeId ?? n.waterVolume?.bakeId;
    if (typeof bakeId === 'string' && bakeId) refs.giBakeIds.push(bakeId);
    for (const child of (n.children ?? [])) walk(child);
  };
  walk(node);
  return refs;
}

/** The texture ids UI image nodes in the tree at `node` show (the published player keeps those decoded). */
export function collectUiTextureIds(node: any, out: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== 'object') return out;
  // Any node whose `ui` payload names a texture, as the publish walk reads it (utils/references.ts): a uiImage.
  const id = node.ui?.textureId;
  if (typeof id === 'string' && id) out.add(id);
  for (const child of (node.children ?? [])) collectUiTextureIds(child, out);
  return out;
}

/** One scene's chunks, read: what its JSON is inflated from, and its GI bakes. */
export interface ChunkSet extends ChunkLookup {
  giBakes: { id: string; bytes: Uint8Array }[];
}

/**
 * Read `refs` from `source` and answer the inflate functions from them.
 *
 * Every read of an owning source (range, blob) is bytes of its own, so a geometry's first claimant in this
 * read keeps the arrays as they arrived and every later claimant copies (Geometry.scale() writes positions in
 * place; see unpackGameBin). The buffer source's reads are views onto the one resident file: `claimed` then
 * spans the session, so a scene visited again copies instead of re-viewing arrays the last visit owned, and
 * bone data is always copied, as unpackGameBin does.
 */
export async function readChunkSet(source: GameSource, header: GameHeader, refs: SceneRefs, claimed?: Set<string>): Promise<ChunkSet> {
  const { manifest, blobStart } = header;
  const key = (r: { o: number; l: number }) => `${r.o}:${r.l}`;
  const unique = new Map<string, ChunkRef>();
  for (const r of refs.chunks) unique.set(key(r), r);
  const bakeRefs: { id: string; ref: ChunkRef }[] = [];
  for (const id of new Set(refs.giBakeIds)) {
    const b = (manifest.giBakes ?? []).find(x => x.id === id);
    if (!b) continue;
    const ref = { o: b.o, l: b.l };
    bakeRefs.push({ id, ref });
    unique.set(key(ref), ref);
  }

  const list = [...unique.values()];
  const read = await source.readMany(list.map(r => ({ o: blobStart + r.o, l: r.l })));
  const got = new Map<string, Uint8Array>();
  list.forEach((r, i) => got.set(key(r), read[i]));

  const bytesOf = (ref: { o: number; l: number }): Uint8Array => {
    const b = got.get(key(ref));
    if (!b) throw new Error(`game.bin chunk ${key(ref)} was not read for this scene`);
    return b;
  };
  const owns = source.ownsReads;
  const seen = owns ? new Set<string>() : (claimed ?? new Set<string>());
  const floatsOf = (b: Uint8Array) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

  const geometryFor = (ref: string): GeometryArrays | undefined => {
    const packed = manifest.geometries?.[ref];
    if (!packed) return undefined;
    const first = !seen.has(ref);
    seen.add(ref);
    const out: GeometryArrays = {};
    for (const name of ATTRS) {
      const chunk = packed[name];
      if (!chunk) continue;
      const floats = floatsOf(bytesOf(chunk));
      out[name] = first ? floats : floats.slice();
    }
    if (packed.indices) {
      const b = bytesOf(packed.indices);
      const indices = packed.indices.bits === 32
        ? new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4)
        : new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2);
      out.indices = first ? indices : indices.slice();
    }
    return out;
  };

  // Bone data: two models sharing one chunk must not share one buffer (AnimatedModel keeps the arrays).
  const boneClaims = new Set<string>();
  const chunkFloats = (chunk: { o: number; l: number } | undefined): Float32Array | undefined => {
    if (!chunk) return undefined;
    const floats = floatsOf(bytesOf(chunk));
    if (!owns) return floats.slice();
    const k = key(chunk);
    if (boneClaims.has(k)) return floats.slice();
    boneClaims.add(k);
    return floats;
  };

  return {
    geometryFor,
    chunkBytes: chunk => (chunk ? bytesOf(chunk) : undefined),
    chunkFloats,
    giBakes: bakeRefs.map(({ id, ref }) => ({ id, bytes: bytesOf(ref) })),
  };
}

/** DEFLATE -> raw bytes. `DecompressionStream` is a global (not DOM), so this file stays testable. */
async function inflateBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
