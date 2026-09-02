// Reader for the `game.bin` container written by features/publish/pack.ts; see that file for the byte
// layout. Every numeric array comes back as a typed-array VIEW onto the downloaded ArrayBuffer.
// Kept free of DOM and engine imports so it can be unit-tested against the packer under vitest.

import { PACK_MAGIC, PACK_HEADER_BYTES, ATTRS } from '../features/publish/pack';
import type { PackManifest, PackedTexture, PackedSound } from '../features/publish/pack';
import { ChunkReader, align4 } from '../utils/chunkBlob';

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

export interface UnpackedGame {
  manifest: PackManifest;
  textures: UnpackedTexture[];
  /** Empty for a game published before audio existed, or one with no Sound nodes. */
  sounds: UnpackedSound[];
  /** Geometry arrays for a `model.geometryRef`, or undefined if the ref is unknown. */
  geometryFor(ref: string): GeometryArrays | undefined;
  /** Raw bytes of a blob chunk (terrain splat/height payloads), bounds-checked. */
  chunkBytes(chunk: { o: number; l: number } | undefined): Uint8Array | undefined;
  /** Floats of a blob chunk (a skinned model's per-vertex bone data), bounds-checked. */
  chunkFloats(chunk: { o: number; l: number } | undefined): Float32Array | undefined;
}

function readHeader(buffer: ArrayBuffer): { manifest: PackManifest; blobStart: number } {
  if (buffer.byteLength < PACK_HEADER_BYTES) throw new Error('game.bin is truncated (no header)');

  const view = new DataView(buffer);
  let magic = '';
  for (let i = 0; i < PACK_MAGIC.length; i++) magic += String.fromCharCode(view.getUint8(i));
  if (magic !== PACK_MAGIC) throw new Error(`Not a Cleo game pack (magic "${magic}")`);

  const version = view.getUint32(8, true);
  if (version !== 1) throw new Error(`Unsupported game pack version ${version}`);

  const manifestLength = view.getUint32(12, true);
  const manifestEnd = PACK_HEADER_BYTES + manifestLength;
  if (manifestEnd > buffer.byteLength) throw new Error('game.bin is truncated (manifest)');

  const json = new TextDecoder().decode(new Uint8Array(buffer, PACK_HEADER_BYTES, manifestLength));
  return { manifest: JSON.parse(json) as PackManifest, blobStart: align4(manifestEnd) };
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

  return { manifest, textures, sounds, geometryFor, chunkBytes, chunkFloats };
}

function inflateModelJson(model: any, game: UnpackedGame): void {
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
function inflateFoliageSource(src: any, game: UnpackedGame): void {
  if (!src || typeof src !== 'object') return;
  inflateModelJson(src.model, game);
  for (const m of (src.models ?? [])) inflateModelJson(m, game);
  for (const l of (src.lods ?? [])) for (const m of (l?.models ?? [])) inflateModelJson(m, game);
}

/** Replace every `model.geometryRef` in a scene tree with the arrays it points at, in place. */
export function inflateSceneGeometry(node: any, game: UnpackedGame): void {
  if (!node || typeof node !== 'object') return;
  inflateModelJson(node.model, game);

  const terrain = node.terrain;
  if (terrain) {
    for (const f of (terrain.foliage ?? [])) inflateFoliageSource(f, game);
    for (const layer of (terrain.layers ?? []))
      for (const rule of (layer?.material?.foliageInclude ?? [])) inflateFoliageSource(rule, game);
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
export async function inflateTerrainData(node: any, game: UnpackedGame): Promise<void> {
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
  }

  for (const child of (node.children ?? [])) await inflateTerrainData(child, game);
}

/**
 * Decompress every tilemap's cell grids out of the blob, in place.
 *
 * Async for the same reason as {@link inflateTerrainData}; `data` stored as base64 is left alone.
 */
export async function inflateTilemapData(node: any, game: UnpackedGame): Promise<void> {
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

/** DEFLATE -> raw bytes. `DecompressionStream` is a global (not DOM), so this file stays testable. */
async function inflateBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
