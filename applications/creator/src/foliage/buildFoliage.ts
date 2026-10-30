// The Foliage Creator's pipeline: document -> levels, materials and textures -> .glb per level.
//
// Pure and DOM-free (PNG encoding uses CompressionStream, present in workers and Node), so the same code
// runs in the generation worker, in the export and in the tests. The live preview imports the very
// .glb files the export writes, through the engine's own glTF importer, so what the viewport shows is
// exactly what the Editor will get.

import { bakeOctahedralImpostor, rgbaSampler, type OctahedralBakePart } from 'cleo/terrain/octahedralBake';
import type { OctahedralImpostorInfo } from 'cleo/terrain/octahedralImpostor';
import { encodePngRgba8 } from '../core/png';
import { normaliseFoliage, type FoliageDoc, type FoliageKind, type Rgba } from './foliageParams';
import { writeGlb, type GlbImage, type GlbMaterial, type GlbMesh } from './glb';
import { buildGrass } from './grass';
import { boundsOf, triangles, vertices, type FoliageLevel, type MaterialKey, type V3 } from './mesh';
import { buildRock } from './rock';
import { barkTextures } from './textures/bark';
import { leafAtlas } from './textures/leaves';
import { resample, type Image } from './textures/image';
import { buildSkeleton } from './tree/skeleton';
import { treeLevels } from './tree/treeMesh';

/** Every texture a foliage asset can carry. */
export type TextureKey = 'grass' | 'grassCard' | 'rockAlbedo' | 'rockNormal' | 'bark' | 'barkNormal' | 'leaves';

/** The textures a user may replace with an image of their own, per kind. */
export const OVERRIDE_SLOTS: Record<FoliageKind, { key: TextureKey; label: string; hint: string }[]> = {
  grass: [{ key: 'grass', label: 'Blades', hint: 'Four blade variants side by side, tip at the top. The last column is the dry variant.' }],
  rock: [
    { key: 'rockAlbedo', label: 'Albedo', hint: 'Baked into the rock\'s six-chart layout; a tiling photo also works.' },
    { key: 'rockNormal', label: 'Normal', hint: 'Tangent space, OpenGL (+Y up).' },
  ],
  tree: [
    { key: 'bark', label: 'Bark', hint: 'Tiles around and along every branch.' },
    { key: 'barkNormal', label: 'Bark normal', hint: 'Tangent space, OpenGL (+Y up), tiling.' },
    { key: 'leaves', label: 'Leaves', hint: 'A 2×2 atlas of sprig cards with alpha; each card is anchored at the middle of its bottom edge.' },
  ],
};

export const TEXTURE_LABELS: Record<TextureKey, string> = {
  grass: 'Blades', grassCard: 'Clump card', rockAlbedo: 'Albedo', rockNormal: 'Normal', bark: 'Bark', barkNormal: 'Bark normal', leaves: 'Leaves',
};

export interface MaterialSpec {
  name: string;
  baseColor: Rgba;
  roughness: number;
  baseColorTexture?: TextureKey;
  normalTexture?: TextureKey;
  alphaCutoff?: number;
  doubleSided?: boolean;
  translucency?: number;
  wind?: GlbMaterial['wind'];
}

export interface FoliageModel {
  kind: FoliageKind;
  name: string;
  levels: FoliageLevel[];
  materials: Partial<Record<MaterialKey, MaterialSpec>>;
  textures: Partial<Record<TextureKey, Image>>;
  cullDistance: number;
  /** Trees: where the impostor replaces the last level, or null when it does not. */
  impostor: { distance: number; frames: number; frameSize: number } | null;
  /** A suggested foliage collider, in the Editor's terms. */
  collider: { shape: 'cylinder' | 'sphere'; radius: number; height?: number; offsetY?: number } | null;
  bounds: { min: V3; max: V3 };
}

export type Overrides = Partial<Record<TextureKey, Image>>;

/**
 * The last few generated textures, by the parameters that made them. Textures are most of a build's
 * cost and most slider moves (a branch angle, a LOD distance) do not touch them, so the live preview
 * re-uses them. Pure functions of their key, so a hit is always exact.
 */
const textureCache = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  if (textureCache.has(key)) {
    const hit = textureCache.get(key) as T;
    textureCache.delete(key);
    textureCache.set(key, hit);
    return hit;
  }
  const value = make();
  textureCache.set(key, value);
  while (textureCache.size > 8) textureCache.delete(textureCache.keys().next().value!);
  return value;
}

const WHITE: Rgba = [1, 1, 1, 1];

/** Build the model for a document. `overrides` replace generated textures (resized to the slot's size). */
export function buildFoliage(raw: FoliageDoc, overrides: Overrides = {}): FoliageModel {
  const doc = normaliseFoliage(raw);
  const seed = doc.seed;
  const sized = (key: TextureKey, size: number) => overrides[key] ? resample(overrides[key]!, size, size) : undefined;

  if (doc.kind === 'grass') {
    const p = doc.grass;
    const g = buildGrass(seed, p, sized('grass', p.textureSize));
    const wind = { windStrength: p.windStrength, windStiffness: p.windStiffness, windRole: 'plant' as const, windFlutter: p.windFlutter };
    const all = g.levels.flatMap(l => l.parts);
    return {
      kind: 'grass', name: doc.name, levels: g.levels,
      materials: {
        grass: { name: 'Grass', baseColor: WHITE, roughness: p.roughness, baseColorTexture: 'grass', doubleSided: true, translucency: p.translucency, wind },
        grassCard: { name: 'Grass card', baseColor: WHITE, roughness: p.roughness, baseColorTexture: 'grassCard', alphaCutoff: 0.5, doubleSided: true, translucency: p.translucency, wind },
      },
      textures: { grass: g.bladeTexture, grassCard: g.cardTexture },
      cullDistance: p.cullDistance, impostor: null, collider: null, bounds: boundsOf(all),
    };
  }

  if (doc.kind === 'rock') {
    const p = doc.rock;
    const r = buildRock(seed, p, { albedo: sized('rockAlbedo', p.textureSize), normal: sized('rockNormal', p.textureSize) });
    return {
      kind: 'rock', name: doc.name, levels: r.levels,
      materials: { rock: { name: 'Rock', baseColor: WHITE, roughness: p.roughness, baseColorTexture: 'rockAlbedo', normalTexture: 'rockNormal' } },
      textures: { rockAlbedo: r.albedo, rockNormal: r.normal },
      cullDistance: p.cullDistance, impostor: null,
      collider: { shape: 'sphere', radius: r.collider.radius, offsetY: r.collider.center[1] },
      bounds: boundsOf(r.levels[0].parts),
    };
  }

  const p = doc.tree;
  const skeleton = buildSkeleton(seed, p);
  const levels = treeLevels(skeleton, p);
  const bark = cached(JSON.stringify(['bark', seed, p.barkTextureSize, p.barkPattern, p.barkColor]),
                      () => barkTextures(seed, p.barkTextureSize, p.barkPattern, p.barkColor));
  const textures: Overrides = {
    bark: sized('bark', p.barkTextureSize) ?? bark.albedo,
    barkNormal: sized('barkNormal', p.barkTextureSize) ?? bark.normal,
  };
  // Bark and leaves bend with ONE wind shape (the prototype's bounds), so they share strength and
  // stiffness; only the leaves flutter.
  const materials: FoliageModel['materials'] = {
    bark: { name: 'Bark', baseColor: WHITE, roughness: p.barkRoughness, baseColorTexture: 'bark', normalTexture: 'barkNormal',
            wind: { windStrength: p.windStrength, windStiffness: p.windStiffness, windRole: 'plant', windFlutter: 0 } },
  };
  if (p.leafKind !== 'none') {
    const atlas = {
      seed, size: p.leafTextureSize, kind: p.leafKind, shape: p.leafShape, color: p.leafColor,
      variation: p.leafColorVariation, autumn: p.leafKind === 'broadleaf' ? p.autumn : 0,
    };
    textures.leaves = sized('leaves', p.leafTextureSize) ?? cached(JSON.stringify(['leaves', atlas]), () => leafAtlas(atlas));
    materials.leaves = { name: 'Leaves', baseColor: WHITE, roughness: p.leafRoughness, baseColorTexture: 'leaves', alphaCutoff: 0.5,
                         doubleSided: true, translucency: p.leafTranslucency,
                         wind: { windStrength: p.windStrength, windStiffness: p.windStiffness, windRole: 'leaves', windFlutter: p.windFlutter } };
  }
  const trunk = skeleton.stems[0];
  return {
    kind: 'tree', name: doc.name, levels, materials, textures,
    cullDistance: p.cullDistance,
    impostor: p.impostor ? { distance: p.impostorDistance, frames: p.impostorFrames, frameSize: p.impostorFrameSize } : null,
    // The Editor's trunk fit: the base radius, 60% of the height (foliageColliderFit.ts).
    collider: { shape: 'cylinder', radius: trunk.radii[Math.min(1, trunk.radii.length - 1)], height: p.height * 0.6 },
    bounds: boundsOf(levels[0].parts),
  };
}

/**
 * A model without its buffers and images: what the UI and the export need once the files are written,
 * cheap to post across the worker boundary.
 */
export interface FoliageSummary {
  kind: FoliageKind;
  name: string;
  levels: { distance: number; triangles: number; vertices: number; parts: number }[];
  materials: MaterialSpec[];
  cullDistance: number;
  impostor: FoliageModel['impostor'];
  collider: FoliageModel['collider'];
  bounds: FoliageModel['bounds'];
}

export function summarize(model: FoliageModel): FoliageSummary {
  const stats = levelStats(model);
  return {
    kind: model.kind, name: model.name,
    levels: model.levels.map((l, i) => ({ distance: l.distance, ...stats[i] })),
    materials: Object.values(model.materials).filter((m): m is MaterialSpec => !!m),
    cullDistance: model.cullDistance, impostor: model.impostor, collider: model.collider, bounds: model.bounds,
  };
}

/** Each level's triangles and vertices. */
export function levelStats(model: FoliageModel): { triangles: number; vertices: number; parts: number }[] {
  return model.levels.map(l => ({ triangles: triangles(l), vertices: vertices(l), parts: l.parts.length }));
}

/** PNG bytes for every texture of a model. */
export async function encodeTextures(model: FoliageModel): Promise<Partial<Record<TextureKey, Uint8Array>>> {
  const out: Partial<Record<TextureKey, Uint8Array>> = {};
  for (const [key, img] of Object.entries(model.textures) as [TextureKey, Image][])
    out[key] = await encodePngRgba8(img.width, img.height, img.data);
  return out;
}

/** One level as a .glb, with the textures its materials use embedded. */
export function levelGlb(model: FoliageModel, level: number, pngs: Partial<Record<TextureKey, Uint8Array>>): Uint8Array {
  const parts = model.levels[level].parts;
  const materialIndex = new Map<MaterialKey, number>();
  const materials: GlbMaterial[] = [];
  const imageIndex = new Map<TextureKey, number>();
  const images: GlbImage[] = [];
  const image = (key?: TextureKey) => {
    if (!key || !pngs[key]) return undefined;
    let i = imageIndex.get(key);
    if (i === undefined) { i = images.length; images.push({ name: `${model.name}_${key}`, png: pngs[key]! }); imageIndex.set(key, i); }
    return i;
  };
  const meshes: GlbMesh[] = parts.map(part => {
    let m = materialIndex.get(part.material);
    if (m === undefined) {
      const spec = model.materials[part.material]!;
      m = materials.length;
      materials.push({
        name: spec.name, baseColor: spec.baseColor, roughness: spec.roughness,
        baseColorImage: image(spec.baseColorTexture), normalImage: image(spec.normalTexture),
        alphaCutoff: spec.alphaCutoff, doubleSided: spec.doubleSided, translucency: spec.translucency, wind: spec.wind,
      });
      materialIndex.set(part.material, m);
    }
    return { name: part.name, buffers: part.buffers, material: m };
  });
  return writeGlb(meshes, materials, images, { cleo: { foliage: model.kind, lod: level, distance: model.levels[level].distance } });
}

export interface FoliageFiles {
  glbs: Uint8Array[];
  pngs: Partial<Record<TextureKey, Uint8Array>>;
}

export async function encodeFoliage(model: FoliageModel): Promise<FoliageFiles> {
  const pngs = await encodeTextures(model);
  return { glbs: model.levels.map((_, i) => levelGlb(model, i, pngs)), pngs };
}

export interface ImpostorBake {
  info: OctahedralImpostorInfo;
  albedo: Uint8Array;
  normal: Uint8Array;
  albedoSize: number;
  normalSize: number;
}

/**
 * The octahedral impostor, baked from the LAST mesh level -- what it replaces on screen, so the hand-over
 * does not pop (baking LOD 0 makes the impostor fuller than the mesh beside it).
 */
export async function bakeImpostor(model: FoliageModel): Promise<ImpostorBake | null> {
  if (!model.impostor) return null;
  const last = model.levels[model.levels.length - 1];
  const parts: OctahedralBakePart[] = last.parts.map(part => {
    const spec = model.materials[part.material]!;
    const tex = spec.baseColorTexture ? model.textures[spec.baseColorTexture] : undefined;
    return {
      positions: part.buffers.positions, normals: part.buffers.normals, uvs: part.buffers.uvs, indices: part.buffers.indices,
      sample: tex ? rgbaSampler(tex.data, tex.width, tex.height) : null,
      cutoff: spec.alphaCutoff ?? 0,
    };
  });
  const { frames, frameSize } = model.impostor;
  const r = bakeOctahedralImpostor(parts, { frames, frameSize, normalFrameSize: Math.max(32, frameSize / 2), supersample: 2, dilate: 4, roundNormals: 0.6 });
  return {
    info: r.info,
    albedo: await encodePngRgba8(r.albedoSize, r.albedoSize, new Uint8Array(r.albedo.buffer, r.albedo.byteOffset, r.albedo.byteLength)),
    normal: await encodePngRgba8(r.normalSize, r.normalSize, new Uint8Array(r.normal.buffer, r.normal.byteOffset, r.normal.byteLength)),
    albedoSize: r.albedoSize, normalSize: r.normalSize,
  };
}

/** The size a texture slot is generated at -- what a user override is resized to. */
export function overrideSize(doc: FoliageDoc, key: TextureKey): number {
  const d = normaliseFoliage(doc);
  if (key === 'grass') return d.grass.textureSize;
  if (key === 'rockAlbedo' || key === 'rockNormal') return d.rock.textureSize;
  if (key === 'leaves') return d.tree.leafTextureSize;
  return d.tree.barkTextureSize;
}
