// A minimal glTF 2.0 binary (.glb) writer: what one foliage level needs and nothing more.
//
// One node and one mesh per part (one primitive, one material), POSITION / NORMAL / TEXCOORD_0 and
// indices, PNG images embedded in the BIN chunk. No TANGENT: the engine's importer (and every other)
// derives tangents from the uvs, which is what this generator's normal maps were authored against.
//
// Materials carry what the engine reads back (src/graphics/utils/gltfLoader.ts):
//   - `alphaMode: MASK` + `alphaCutoff` for leaf and card cutouts, `doubleSided` for thin surfaces;
//   - `KHR_materials_diffuse_transmission` for translucency -- the standard extension, so other tools
//     read it too;
//   - `extras.cleo.wind`, the engine's foliage wind response, which glTF has no field for.

import type { PartBuffers } from './mesh';

export interface GlbImage { name: string; png: Uint8Array }

export interface GlbMaterial {
  name: string;
  baseColor: [number, number, number, number];
  roughness: number;
  metallic?: number;
  /** Index into the images. */
  baseColorImage?: number;
  normalImage?: number;
  normalScale?: number;
  alphaCutoff?: number;
  doubleSided?: boolean;
  translucency?: number;
  wind?: { windStrength: number; windStiffness: number; windRole: 'plant' | 'leaves'; windFlutter: number };
}

export interface GlbMesh { name: string; buffers: PartBuffers; material: number }

const pad4 = (n: number) => (n + 3) & ~3;
const FLOAT = 5126, UINT16 = 5123, UINT32 = 5125;
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;
const REPEAT = 10497, LINEAR = 9729, LINEAR_MIPMAP_LINEAR = 9987;

export function writeGlb(meshes: readonly GlbMesh[], materials: readonly GlbMaterial[], images: readonly GlbImage[],
                         extras?: Record<string, unknown>): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];

  const addView = (bytes: Uint8Array, target?: number): number => {
    const start = offset;
    chunks.push(bytes);
    offset += bytes.byteLength;
    const padding = pad4(offset) - offset;
    if (padding) { chunks.push(new Uint8Array(padding)); offset += padding; }
    bufferViews.push({ buffer: 0, byteOffset: start, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    return bufferViews.length - 1;
  };
  const asBytes = (a: Float32Array | Uint16Array | Uint32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

  const addFloatAccessor = (data: Float32Array, components: 2 | 3, withBounds: boolean): number => {
    const view = addView(asBytes(data), ARRAY_BUFFER);
    const count = data.length / components;
    const acc: Record<string, unknown> = { bufferView: view, componentType: FLOAT, count, type: components === 3 ? 'VEC3' : 'VEC2' };
    if (withBounds) {
      const min = [Infinity, Infinity, Infinity].slice(0, components), max = [-Infinity, -Infinity, -Infinity].slice(0, components);
      for (let i = 0; i < data.length; i += components) for (let k = 0; k < components; k++) {
        if (data[i + k] < min[k]) min[k] = data[i + k];
        if (data[i + k] > max[k]) max[k] = data[i + k];
      }
      acc.min = count ? min : min.map(() => 0);
      acc.max = count ? max : max.map(() => 0);
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  const gltfMeshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  for (const m of meshes) {
    const b = m.buffers;
    const vertexCount = b.positions.length / 3;
    const position = addFloatAccessor(b.positions, 3, true);
    const normal = addFloatAccessor(b.normals, 3, false);
    const uv = addFloatAccessor(b.uvs, 2, false);
    const small = vertexCount <= 0xffff;
    const indexData = small ? Uint16Array.from(b.indices) : b.indices;
    const indexView = addView(asBytes(indexData), ELEMENT_ARRAY_BUFFER);
    accessors.push({ bufferView: indexView, componentType: small ? UINT16 : UINT32, count: b.indices.length, type: 'SCALAR' });
    const indices = accessors.length - 1;
    gltfMeshes.push({ name: m.name, primitives: [{ attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, indices, material: m.material, mode: 4 }] });
    nodes.push({ name: m.name, mesh: gltfMeshes.length - 1 });
  }

  const gltfImages = images.map(img => ({ name: img.name, mimeType: 'image/png', bufferView: addView(img.png) }));
  const textures = images.map((_, i) => ({ sampler: 0, source: i }));

  let usesTransmission = false;
  const gltfMaterials = materials.map(m => {
    const out: Record<string, unknown> = {
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: m.baseColor,
        metallicFactor: m.metallic ?? 0,
        roughnessFactor: m.roughness,
        ...(m.baseColorImage !== undefined ? { baseColorTexture: { index: m.baseColorImage } } : {}),
      },
    };
    if (m.normalImage !== undefined) out.normalTexture = { index: m.normalImage, ...(m.normalScale !== undefined ? { scale: m.normalScale } : {}) };
    if (m.alphaCutoff && m.alphaCutoff > 0) { out.alphaMode = 'MASK'; out.alphaCutoff = m.alphaCutoff; }
    if (m.doubleSided) out.doubleSided = true;
    if (m.translucency && m.translucency > 0) {
      usesTransmission = true;
      out.extensions = { KHR_materials_diffuse_transmission: { diffuseTransmissionFactor: m.translucency } };
    }
    if (m.wind) out.extras = { cleo: { wind: m.wind } };
    return out;
  });

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Cleo Creator · Foliage' },
    ...(usesTransmission ? { extensionsUsed: ['KHR_materials_diffuse_transmission'] } : {}),
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    materials: gltfMaterials,
    ...(images.length ? { images: gltfImages, textures, samplers: [{ magFilter: LINEAR, minFilter: LINEAR_MIPMAP_LINEAR, wrapS: REPEAT, wrapT: REPEAT }] } : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
    ...(extras ? { extras } : {}),
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = pad4(jsonBytes.length);
  const binLen = pad4(offset);
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);       // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLen, true);
  view.setUint32(16, 0x4e4f534a, true);      // 'JSON'
  out.fill(0x20, 20, 20 + jsonLen);          // JSON pads with spaces
  out.set(jsonBytes, 20);
  const bin = 20 + jsonLen;
  view.setUint32(bin, binLen, true);
  view.setUint32(bin + 4, 0x004e4942, true); // 'BIN\0'
  let o = bin + 8;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}
