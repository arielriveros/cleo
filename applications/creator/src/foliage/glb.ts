// A minimal glTF 2.0 binary (.glb) writer: what one foliage level needs and nothing more.
//
// One node and one mesh per part (one primitive, one material), POSITION / NORMAL / TEXCOORD_0 and
// indices, PNG images embedded in the BIN chunk. No TANGENT: the engine's importer (and every other)
// derives tangents from the uvs, which is what this generator's normal maps were authored against.
//
// Materials carry what the engine reads back (src/graphics/utils/gltfLoader.ts):
//   - one packed ORM image as both `occlusionTexture` and `metallicRoughnessTexture` (glTF's own layout);
//   - `alphaMode: MASK` + `alphaCutoff` for leaf and card cutouts, `doubleSided` for thin surfaces;
//   - `KHR_materials_diffuse_transmission` for translucency -- the standard extension, so other tools
//     read it too;
//   - `emissiveFactor` + `KHR_materials_emissive_strength` for emission above 1;
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
  /** Packed R = occlusion, G = roughness, B = metallic: both `occlusionTexture` and `metallicRoughnessTexture`. */
  ormImage?: number;
  alphaCutoff?: number;
  doubleSided?: boolean;
  translucency?: number;
  /** [r, g, b, blend]: written as the standard diffuseTransmissionColorFactor and, exactly, in extras.cleo. */
  translucencyTint?: [number, number, number, number];
  emissive?: [number, number, number];
  /** Multiplies `emissive` (KHR_materials_emissive_strength). */
  emissiveIntensity?: number;
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

  let usesTransmission = false, usesEmissiveStrength = false;
  const gltfMaterials = materials.map(m => {
    const out: Record<string, unknown> = {
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: m.baseColor,
        metallicFactor: m.metallic ?? 0,
        roughnessFactor: m.roughness,
        ...(m.baseColorImage !== undefined ? { baseColorTexture: { index: m.baseColorImage } } : {}),
        ...(m.ormImage !== undefined ? { metallicRoughnessTexture: { index: m.ormImage } } : {}),
      },
    };
    if (m.ormImage !== undefined) out.occlusionTexture = { index: m.ormImage };
    if (m.normalImage !== undefined) out.normalTexture = { index: m.normalImage, ...(m.normalScale !== undefined ? { scale: m.normalScale } : {}) };
    if (m.alphaCutoff && m.alphaCutoff > 0) { out.alphaMode = 'MASK'; out.alphaCutoff = m.alphaCutoff; }
    if (m.doubleSided) out.doubleSided = true;
    const extensions: Record<string, unknown> = {};
    if (m.translucency && m.translucency > 0) {
      usesTransmission = true;
      const t = m.translucencyTint;
      // The standard field is a multiplier, the nearest glTF has to "blend toward a colour": the tint at its
      // blend. Cleo reads the exact value back from extras.cleo.translucencyTint.
      extensions.KHR_materials_diffuse_transmission = {
        diffuseTransmissionFactor: m.translucency,
        ...(t && t[3] > 0 ? { diffuseTransmissionColorFactor: [0, 1, 2].map(i => 1 + (t[i] - 1) * t[3]) } : {}),
      };
    }
    if (m.emissive && m.emissive.some(c => c > 0)) {
      out.emissiveFactor = m.emissive;
      if (m.emissiveIntensity !== undefined && m.emissiveIntensity !== 1) {
        usesEmissiveStrength = true;
        extensions.KHR_materials_emissive_strength = { emissiveStrength: m.emissiveIntensity };
      }
    }
    if (Object.keys(extensions).length) out.extensions = extensions;
    const cleo: Record<string, unknown> = {};
    if (m.wind) cleo.wind = m.wind;
    if (m.translucencyTint && m.translucencyTint[3] > 0 && m.translucency) cleo.translucencyTint = m.translucencyTint;
    if (Object.keys(cleo).length) out.extras = { cleo };
    return out;
  });

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Cleo Creator · Foliage' },
    ...(usesTransmission || usesEmissiveStrength ? { extensionsUsed: [
      ...(usesTransmission ? ['KHR_materials_diffuse_transmission'] : []),
      ...(usesEmissiveStrength ? ['KHR_materials_emissive_strength'] : []),
    ] } : {}),
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
