// The Foliage Creator's pipeline: document -> levels, materials and textures -> .glb per level.
//
// Pure and DOM-free (PNG encoding uses CompressionStream, present in workers and Node), so the same code
// runs in the generation worker, in the export and in the tests. The live preview imports the very
// .glb files the export writes, through the engine's own glTF importer, so what the viewport shows is
// exactly what the Editor will get.

import { bakeOctahedralImpostor, rgbaSampler, type OctahedralBakePart } from 'cleo/terrain/octahedralBake';
import type { OctahedralImpostorInfo } from 'cleo/terrain/octahedralImpostor';
import { encodePngRgba8 } from '../core/png';
import { buildBushSkeleton, bushLevels } from './bush';
import { normaliseFoliage, type FoliageDoc, type FoliageKind, type Rgba, type TreeParams } from './foliageParams';
import { writeGlb, type GlbImage, type GlbMaterial, type GlbMesh } from './glb';
import { buildGrass } from './grass';
import { DEFAULT_CUTOFF } from './materials';
import { boundsOf, triangles, vertices, type FoliageLevel, type MaterialKey, type V3 } from './mesh';
import { buildRock } from './rock';
import { barkTextures } from './textures/bark';
import { leafTextures } from './textures/leaves';
import { ormMap } from './textures/orm';
import { resample, type Image } from './textures/image';
import { buildSkeleton } from './tree/skeleton';
import { treeLevels } from './tree/treeMesh';

/** Every texture a foliage asset can carry. */
export type TextureKey = 'grass' | 'grassCard' | 'rockAlbedo' | 'rockNormal' | 'bark' | 'barkNormal' | 'barkOrm' | 'leaves' | 'leavesNormal'
  // Override-only: single channels of the bark's ORM map, packed into `barkOrm` (textures/orm.ts).
  | 'barkAo' | 'barkRoughness' | 'barkMetallic';

type OverrideSlot = { key: TextureKey; label: string; hint: string };

const PLANT_SLOTS: OverrideSlot[] = [
  { key: 'bark', label: 'Bark', hint: 'Tiles around and along every branch.' },
  { key: 'barkNormal', label: 'Bark normal', hint: 'Tangent space, OpenGL (+Y up), tiling.' },
  { key: 'barkOrm', label: 'Bark ARM', hint: 'Packed: red = ambient occlusion, green = roughness, blue = metallic (a scan’s _arm / _orm map).' },
  { key: 'barkAo', label: 'Bark AO', hint: 'Ambient occlusion, greyscale. Replaces the ARM map’s red channel.' },
  { key: 'barkRoughness', label: 'Bark roughness', hint: 'Greyscale. Replaces the ARM map’s green channel; Roughness above scales it.' },
  { key: 'barkMetallic', label: 'Bark metallic', hint: 'Greyscale. Replaces the ARM map’s blue channel.' },
  { key: 'leaves', label: 'Leaves', hint: 'A 2×2 atlas of sprig cards with alpha; each card is anchored at the middle of its bottom edge.' },
  { key: 'leavesNormal', label: 'Leaves normal', hint: 'Tangent space, OpenGL (+Y up), laid out like the leaf atlas.' },
];

/** The textures a user may replace with an image of their own, per kind. */
export const OVERRIDE_SLOTS: Record<FoliageKind, OverrideSlot[]> = {
  grass: [{ key: 'grass', label: 'Blades', hint: 'Four blade variants side by side, tip at the top. The last column is the dry variant.' }],
  rock: [
    { key: 'rockAlbedo', label: 'Albedo', hint: 'Baked into the rock\'s six-chart layout; a tiling photo also works.' },
    { key: 'rockNormal', label: 'Normal', hint: 'Tangent space, OpenGL (+Y up).' },
  ],
  tree: PLANT_SLOTS,
  bush: PLANT_SLOTS,
};

export const TEXTURE_LABELS: Record<TextureKey, string> = {
  grass: 'Blades', grassCard: 'Clump card', rockAlbedo: 'Albedo', rockNormal: 'Normal', bark: 'Bark', barkNormal: 'Bark normal', barkOrm: 'Bark ARM',
  barkAo: 'Bark AO', barkRoughness: 'Bark roughness', barkMetallic: 'Bark metallic', leaves: 'Leaves', leavesNormal: 'Leaves normal',
};

export interface MaterialSpec {
  name: string;
  baseColor: Rgba;
  roughness: number;
  metallic?: number;
  emissive?: [number, number, number];
  emissiveIntensity?: number;
  baseColorTexture?: TextureKey;
  normalTexture?: TextureKey;
  /** Packed AO / roughness / metallic (glTF layout), whose channels are the surface's values. */
  ormTexture?: TextureKey;
  alphaCutoff?: number;
  doubleSided?: boolean;
  translucency?: number;
  /** [r, g, b, blend]: the colour transmitted light blends toward. */
  translucencyTint?: [number, number, number, number];
  wind?: GlbMaterial['wind'];
  interaction?: GlbMaterial['interaction'];
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

/**
 * Build the model for a document. `overrides` replace generated textures (resized to the slot's size);
 * the kind's material overrides (the Materials tab) are laid over the generated materials.
 */
export function buildFoliage(raw: FoliageDoc, overrides: Overrides = {}): FoliageModel {
  const doc = normaliseFoliage(raw);
  const model = generate(doc, overrides);
  const params = doc[doc.kind];
  for (const [key, o] of Object.entries(params.materials ?? {}) as [MaterialKey, NonNullable<NonNullable<typeof params.materials>[MaterialKey]>][]) {
    const spec = model.materials[key];
    if (!spec || !o) continue;
    if (o.baseColor) spec.baseColor = [o.baseColor[0], o.baseColor[1], o.baseColor[2], spec.baseColor[3]];
    if (o.metallic !== undefined) spec.metallic = o.metallic;
    if (o.emissive) spec.emissive = o.emissive;
    if (o.emissiveIntensity !== undefined) spec.emissiveIntensity = o.emissiveIntensity;
    // Only a material generated with a cutout has one to tune: the others have no alpha to cut.
    if (o.alphaCutoff !== undefined && DEFAULT_CUTOFF[key] !== undefined) spec.alphaCutoff = o.alphaCutoff;
    if (o.windRole && spec.wind && o.windRole !== spec.wind.windRole) {
      const flutter = 'windFlutter' in params ? params.windFlutter : 0;
      spec.wind = { ...spec.wind, windRole: o.windRole, windFlutter: o.windRole === 'leaves' ? flutter : 0 };
    }
  }
  return model;
}

function generate(doc: FoliageDoc, overrides: Overrides): FoliageModel {
  const seed = doc.seed;
  const sized = (key: TextureKey, size: number) => overrides[key] ? resample(overrides[key]!, size, size) : undefined;

  if (doc.kind === 'grass') {
    const p = doc.grass;
    const g = buildGrass(seed, p, sized('grass', p.textureSize));
    const wind = { windStrength: p.windStrength, windStiffness: p.windStiffness, windRole: 'plant' as const, windFlutter: p.windFlutter };
    const interaction = { interactBend: p.interactBend, interactRecovery: p.interactRecovery };
    const tint: [number, number, number, number] = [p.translucencyColor[0], p.translucencyColor[1], p.translucencyColor[2], p.translucencyBlend];
    const all = g.levels.flatMap(l => l.parts);
    return {
      kind: 'grass', name: doc.name, levels: g.levels,
      materials: {
        grass: { name: 'Grass', baseColor: WHITE, roughness: p.roughness, baseColorTexture: 'grass', doubleSided: true, translucency: p.translucency, translucencyTint: tint, wind, interaction },
        ...(g.cardTexture ? { grassCard: { name: 'Grass card', baseColor: WHITE, roughness: p.roughness, baseColorTexture: 'grassCard' as const, alphaCutoff: 0.5, doubleSided: true, translucency: p.translucency, translucencyTint: tint, wind, interaction } } : {}),
      },
      textures: { grass: g.bladeTexture, ...(g.cardTexture ? { grassCard: g.cardTexture } : {}) },
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

  if (doc.kind === 'bush') {
    const p = doc.bush;
    const skeleton = buildBushSkeleton(seed, p);
    const levels = bushLevels(skeleton, p);
    return {
      ...plantLook(seed, p, p.materials?.bark?.metallic ?? 0, sized), kind: 'bush', name: doc.name, levels,
      cullDistance: p.cullDistance, impostor: null,
      // Bushes are walked through: no collider.
      collider: null,
      bounds: boundsOf(levels[0].parts),
    };
  }

  const p = doc.tree;
  const skeleton = buildSkeleton(seed, p);
  const levels = treeLevels(skeleton, p);
  const trunk = skeleton.stems[0];
  return {
    ...plantLook(seed, p, p.materials?.bark?.metallic ?? 0, sized), kind: 'tree', name: doc.name, levels,
    cullDistance: p.cullDistance,
    impostor: p.impostor ? { distance: p.impostorDistance, frames: p.impostorFrames, frameSize: p.impostorFrameSize } : null,
    // The Editor's trunk fit: the base radius, 60% of the height (foliageColliderFit.ts).
    collider: { shape: 'cylinder', radius: trunk.radii[Math.min(1, trunk.radii.length - 1)], height: p.height * 0.6 },
    bounds: boundsOf(levels[0].parts),
  };
}

type PlantLook = Pick<TreeParams, 'barkTextureSize' | 'barkPattern' | 'barkColor' | 'barkRoughness' | 'leafKind' | 'leafTextureSize' | 'leafShape'
  | 'leafColor' | 'leafColorVariation' | 'autumn' | 'leafRoughness' | 'leafTranslucency' | 'leafTranslucencyColor' | 'leafTranslucencyBlend' | 'windStrength' | 'windStiffness' | 'windFlutter' | 'interactBend' | 'interactRecovery'>;

/** How deep the generated bark's cavities occlude: deep in plated and furrowed bark, shallow in smooth skin. */
const BARK_AO = { plated: 0.6, furrowed: 0.65, smooth: 0.25, papery: 0.3 } as const;

/** A tree's or a bush's bark and leaf materials and textures. */
function plantLook(seed: number, p: PlantLook, barkMetallic: number,
                   sized: (key: TextureKey, size: number) => Image | undefined): Pick<FoliageModel, 'materials' | 'textures'> {
  const size = p.barkTextureSize;
  const bark = cached(JSON.stringify(['bark', seed, size, p.barkPattern, p.barkColor]),
                      () => barkTextures(seed, size, p.barkPattern, p.barkColor));
  // Every channel of the bark: colour, normal, and AO / roughness / metallic packed into one map.
  const orm = { packed: sized('barkOrm', size), ao: sized('barkAo', size), roughness: sized('barkRoughness', size), metallic: sized('barkMetallic', size) };
  const ormSettings = { roughness: p.barkRoughness, metallic: barkMetallic, aoStrength: BARK_AO[p.barkPattern] ?? 0.5 };
  const textures: Overrides = {
    bark: sized('bark', size) ?? bark.albedo,
    barkNormal: sized('barkNormal', size) ?? bark.normal,
    // A generated map is a pure function of its key, so it caches; one with an image in it does not.
    barkOrm: orm.packed || orm.ao || orm.roughness || orm.metallic
      ? ormMap(size, { height: bark.height, ...orm }, ormSettings)
      : cached(JSON.stringify(['barkOrm', seed, size, p.barkPattern, p.barkColor, ormSettings]), () => ormMap(size, { height: bark.height }, ormSettings)),
  };
  // Bark and leaves bend with ONE wind shape (the prototype's bounds), so they share strength and
  // stiffness; only the leaves flutter.
  // A plant gives way as one too: bark and leaves carry the same interaction response.
  const interaction = { interactBend: p.interactBend, interactRecovery: p.interactRecovery };
  const materials: FoliageModel['materials'] = {
    bark: { name: 'Bark', baseColor: WHITE, roughness: p.barkRoughness, metallic: barkMetallic,
            baseColorTexture: 'bark', normalTexture: 'barkNormal', ormTexture: 'barkOrm',
            wind: { windStrength: p.windStrength, windStiffness: p.windStiffness, windRole: 'plant', windFlutter: 0 }, interaction },
  };
  if (p.leafKind !== 'none') {
    const atlas = {
      seed, size: p.leafTextureSize, kind: p.leafKind, shape: p.leafShape, color: p.leafColor,
      variation: p.leafColorVariation, autumn: p.leafKind === 'broadleaf' ? p.autumn : 0,
    };
    const generated = cached(JSON.stringify(['leaves', atlas]), () => leafTextures(atlas));
    textures.leaves = sized('leaves', p.leafTextureSize) ?? generated.albedo;
    textures.leavesNormal = sized('leavesNormal', p.leafTextureSize) ?? generated.normal;
    materials.leaves = { name: p.leafKind === 'needles' ? 'Needles' : 'Leaves', baseColor: WHITE, roughness: p.leafRoughness, baseColorTexture: 'leaves', normalTexture: 'leavesNormal', alphaCutoff: 0.5,
                         doubleSided: true, translucency: p.leafTranslucency,
                         translucencyTint: [p.leafTranslucencyColor[0], p.leafTranslucencyColor[1], p.leafTranslucencyColor[2], p.leafTranslucencyBlend],
                         wind: { windStrength: p.windStrength, windStiffness: p.windStiffness, windRole: 'leaves', windFlutter: p.windFlutter }, interaction };
  }
  return { materials, textures };
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
      const orm = image(spec.ormTexture);
      materials.push({
        // The ORM map carries roughness and metallic already (textures/orm.ts bakes the sliders in), so
        // its factors are 1: glTF multiplies them in, the engine reads the map alone; both agree.
        name: spec.name, baseColor: spec.baseColor,
        roughness: orm !== undefined ? 1 : spec.roughness, metallic: orm !== undefined ? 1 : spec.metallic,
        emissive: spec.emissive, emissiveIntensity: spec.emissiveIntensity,
        baseColorImage: image(spec.baseColorTexture), normalImage: image(spec.normalTexture), ormImage: orm,
        alphaCutoff: spec.alphaCutoff, doubleSided: spec.doubleSided, translucency: spec.translucency, translucencyTint: spec.translucencyTint, wind: spec.wind, interaction: spec.interaction,
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
  const plant = d.kind === 'bush' ? d.bush : d.tree;
  if (key === 'leaves' || key === 'leavesNormal') return plant.leafTextureSize;
  // Every bark map -- colour, normal, ARM and its single channels -- is resized to the bark's size.
  return plant.barkTextureSize;
}
