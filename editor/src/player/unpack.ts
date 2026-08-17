// Reader for the `game.bin` container written by features/publish/pack.ts. See that file for the
// byte layout and for why offsets are blob-relative.
//
// This is the whole point of the binary format: every numeric array comes back as a typed-array VIEW
// onto the downloaded ArrayBuffer, so a geometry costs zero parsing and zero copying — Geometry's
// toFlat() passes a Float32Array straight through, and its constructor takes a Uint32Array directly,
// so Model.parse needs no engine change to consume this. Texture bytes go to
// TextureManager.addTextureFromBytes, the same path an import uses.
//
// Kept free of DOM and engine imports so it can be unit-tested against the packer under vitest.

import { PACK_MAGIC, PACK_HEADER_BYTES, ATTRS } from '../features/publish/pack';
import type { PackManifest, PackedTexture } from '../features/publish/pack';

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

export interface UnpackedGame {
  manifest: PackManifest;
  textures: UnpackedTexture[];
  /** Geometry arrays for a `model.geometryRef`, or undefined if the ref is unknown. */
  geometryFor(ref: string): GeometryArrays | undefined;
  /** Raw bytes of a blob chunk (terrain splat/height payloads), bounds-checked. */
  chunkBytes(chunk: { o: number; l: number } | undefined): Uint8Array | undefined;
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
  return { manifest: JSON.parse(json) as PackManifest, blobStart: (manifestEnd + 3) & ~3 };
}

export function unpackGameBin(buffer: ArrayBuffer): UnpackedGame {
  const { manifest, blobStart } = readHeader(buffer);

  const bounded = (o: number, l: number): number => {
    const start = blobStart + o;
    if (start + l > buffer.byteLength) throw new Error('game.bin is truncated (chunk past end of file)');
    return start;
  };

  const textures: UnpackedTexture[] = (manifest.textures ?? []).map((t: PackedTexture) => ({
    id: t.id,
    bytes: new Uint8Array(buffer, bounded(t.o, t.l), t.l),
    mime: t.mime,
    config: t.config,
  }));

  // A geometry referenced by N nodes is read N times. The FIRST reader gets the zero-copy view;
  // every later one gets its own copy.
  //
  // This is not paranoia. Geometry.scale() writes into _positions IN PLACE, and toFlat() passes a
  // Float32Array through without copying — so handing the same view to every instance would make one
  // scaled crate deform all the others. The JSON path never had this problem because
  // `new Float32Array(number[])` copied for each Model.parse; matching that keeps the change to the
  // publish format observationally invisible to the runtime.
  const claimed = new Set<string>();

  const geometryFor = (ref: string): GeometryArrays | undefined => {
    const packed = manifest.geometries?.[ref];
    if (!packed) return undefined;

    const first = !claimed.has(ref);
    claimed.add(ref);

    const out: GeometryArrays = {};
    for (const name of ATTRS) {
      const chunk = packed[name];
      if (!chunk) continue;
      const floats = new Float32Array(buffer, bounded(chunk.o, chunk.l), chunk.l / 4);
      out[name] = first ? floats : floats.slice();
    }
    if (packed.indices) {
      const { o, l, bits } = packed.indices;
      const start = bounded(o, l);
      const indices = bits === 32
        ? new Uint32Array(buffer, start, l / 4)
        : new Uint16Array(buffer, start, l / 2);
      out.indices = first ? indices : indices.slice();
    }
    return out;
  };

  const chunkBytes = (chunk: { o: number; l: number } | undefined): Uint8Array | undefined =>
    chunk ? new Uint8Array(buffer, bounded(chunk.o, chunk.l), chunk.l) : undefined;

  return { manifest, textures, geometryFor, chunkBytes };
}

function inflateModelJson(model: any, game: UnpackedGame): void {
  if (model && typeof model.geometryRef === 'string') {
    const geometry = game.geometryFor(model.geometryRef);
    if (geometry) model.geometry = geometry;
    delete model.geometryRef;
  }
}

/** Put back the prototype meshes of one foliage rule / serialized foliage layer. Mirrors pack's
 *  internFoliageSource — the two must always walk the same fields. */
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
 * Separate from inflateSceneGeometry because it is ASYNC: DecompressionStream has no synchronous form.
 * DEFLATE rather than PNG on purpose — the splat's alpha channel is layer 3's blend weight, and a
 * canvas round-trip premultiplies, which destroys the RGB of every texel where layer 3 is unused (the
 * common case). Deflate is the same algorithm PNG uses internally, minus the lossy image semantics.
 *
 * Falls back silently when the fields are absent: a game.bin published before this existed still
 * carries `heights`/`splat` as base64, which Terrain.deserialize reads directly.
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
 * Async for the same reason as the terrain path, and with the same fallback: a game.bin published before
 * this existed carries `data` as base64, which TilemapLayer.parse reads directly.
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
