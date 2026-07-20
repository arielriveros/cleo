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

  return { manifest, textures, geometryFor };
}

/** Replace every `model.geometryRef` in a scene tree with the arrays it points at, in place. */
export function inflateSceneGeometry(node: any, game: UnpackedGame): void {
  if (!node || typeof node !== 'object') return;
  const model = node.model;
  if (model && typeof model.geometryRef === 'string') {
    const geometry = game.geometryFor(model.geometryRef);
    if (geometry) model.geometry = geometry;
    delete model.geometryRef;
  }
  for (const child of (node.children ?? [])) inflateSceneGeometry(child, game);
}
