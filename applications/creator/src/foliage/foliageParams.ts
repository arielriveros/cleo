// Foliage Creator's parameters: one record per kind (grass, rock, tree, bush), the schemas the panels
// draw, and the document that holds all four.
//
// Separate records rather than one flat record gated by `when:` -- the kinds share little, and switching
// kind keeps each one's edits. Each schema group carries a `side`: unset groups are the Parameters panel's,
// 'material' groups the Materials tab's (the procedural texture of the material named by `material`),
// 'lod' groups the LOD tab's and 'export' groups the Export tab's (the FX Creator's `side: 'bake'` split).
// Roughness, translucency and wind are not in any group: the Materials tab edits them through the shared
// material editor (materials.ts links them). Group titles and field labels double as docs anchors
// (docs/creator/foliage.md).

import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import type { MaterialKey } from './mesh';
import { normaliseOverrides, type MaterialOverrides } from './materials';

export type FoliageKind = 'grass' | 'rock' | 'tree' | 'bush';
export type FoliageSide = 'material' | 'lod' | 'export';
export interface FoliageGroup { title: string; specs: GenericParamSpec[]; side?: FoliageSide; material?: MaterialKey }

/** [r, g, b, a], linear 0..1 -- what ParamForm's colour field edits. */
export type Rgba = [number, number, number, number];

// --- Grass ---------------------------------------------------------------------------------------

export interface GrassParams {
  // Clump
  blades: number;
  clumpRadius: number;
  /** 0..1: blades lean away from the clump centre (Ghost of Tsushima's clump facing). */
  clumpFacing: number;
  // Blade
  height: number;
  heightVariance: number;
  width: number;
  /** 0..1: how much of the base width is gone at the tip (1 = pointed). */
  taper: number;
  /** Tip offset as a fraction of height. */
  bend: number;
  /** Exponent of the bend: 1 a straight lean, 2+ a curve that droops near the tip. */
  curvature: number;
  /** Random tilt from vertical, degrees. */
  tilt: number;
  segments: number;
  /** Radians the normal is turned across the blade's width, so a flat blade shades round. */
  normalRounding: number;
  // Look
  baseColor: Rgba;
  tipColor: Rgba;
  /** 0..1: share of blades that are dry. */
  dryness: number;
  dryColor: Rgba;
  /** 0..1: darkening at the root (ambient occlusion baked into the blade texture). */
  rootShade: number;
  roughness: number;
  translucency: number;
  // Wind
  windStrength: number;
  windStiffness: number;
  windFlutter: number;
  // LOD
  lod1Distance: number;
  /** Share of blades LOD 1 keeps (each widened to cover the gap). */
  lod1Blades: number;
  lod2Distance: number;
  cullDistance: number;
  // Export
  textureSize: number;
  /** The Materials tab's overrides (materials.ts). */
  materials?: MaterialOverrides;
}

export const DEFAULT_GRASS: GrassParams = {
  blades: 48, clumpRadius: 0.22, clumpFacing: 0.4,
  height: 0.5, heightVariance: 0.35, width: 0.03, taper: 0.9, bend: 0.3, curvature: 1.8, tilt: 14, segments: 4,
  normalRounding: 0.45,
  baseColor: [0.09, 0.2, 0.04, 1], tipColor: [0.33, 0.45, 0.12, 1], dryness: 0.12, dryColor: [0.52, 0.45, 0.22, 1],
  rootShade: 0.6, roughness: 0.8, translucency: 0.45,
  windStrength: 0.25, windStiffness: 1, windFlutter: 0.3,
  lod1Distance: 6, lod1Blades: 0.45, lod2Distance: 15, cullDistance: 25,
  textureSize: 256,
};

// --- Rock ----------------------------------------------------------------------------------------

export interface RockParams {
  // Shape
  size: number;
  /** Width, height, depth relative to `size`. */
  proportions: [number, number, number];
  /** Icosphere subdivisions before decimation: the detail the noise can carve. */
  detail: number;
  /** Triangles LOD 0 is decimated to. */
  triangles: number;
  // Surface
  noiseAmount: number;
  noiseScale: number;
  /** 0..1: blend from rolling fBm to sharp ridged noise. */
  sharpness: number;
  /** Planar fracture cuts. */
  cuts: number;
  /** How deep each cut bites, as a fraction of the size. */
  cutDepth: number;
  /** 0..1: sedimentary layering. */
  strata: number;
  strataFrequency: number;
  /** 0..1: how much of the base is flattened to sit on the ground. */
  flattenBottom: number;
  // Look
  color: Rgba;
  colorVariation: number;
  /** 0..1: lighter worn edges on convex crests. */
  edgeWear: number;
  /** 0..1: darker dirt in cavities and at the base. */
  cavityDirt: number;
  /** 0..1: moss on upward faces. */
  moss: number;
  mossColor: Rgba;
  roughness: number;
  /** Strength of the baked normal map. */
  bumpiness: number;
  // LOD
  lod1Ratio: number;
  lod1Distance: number;
  lod2Ratio: number;
  lod2Distance: number;
  cullDistance: number;
  // Export
  textureSize: number;
  /** The Materials tab's overrides (materials.ts). */
  materials?: MaterialOverrides;
}

export const DEFAULT_ROCK: RockParams = {
  size: 1.2, proportions: [1, 0.72, 0.9], detail: 5, triangles: 2400,
  noiseAmount: 0.16, noiseScale: 1.6, sharpness: 0.35, cuts: 3, cutDepth: 0.14, strata: 0, strataFrequency: 7,
  flattenBottom: 0.22,
  color: [0.22, 0.21, 0.19, 1], colorVariation: 0.35, edgeWear: 0.45, cavityDirt: 0.5, moss: 0, mossColor: [0.17, 0.25, 0.07, 1],
  roughness: 0.88, bumpiness: 1,
  lod1Ratio: 0.4, lod1Distance: 25, lod2Ratio: 0.12, lod2Distance: 60, cullDistance: 120,
  textureSize: 512,
};

// --- Tree ----------------------------------------------------------------------------------------

export type CrownShape = 'conical' | 'spherical' | 'hemispherical' | 'cylindrical' | 'tapered' | 'flame' | 'inverse' | 'tendFlame';
export type LeafKind = 'broadleaf' | 'needles' | 'none';
export type LeafShape = 'ovate' | 'elliptic' | 'lanceolate' | 'round' | 'lobed';
export type BarkPattern = 'furrowed' | 'plated' | 'smooth' | 'papery';

export interface TreeParams {
  // Trunk
  height: number;
  trunkRadius: number;
  /** Fraction of the height with no branches. */
  baseSize: number;
  /** Root flare: how much wider the base gets. */
  flare: number;
  /** 0..1: the trunk's wander. */
  gnarliness: number;
  /** Whether the trunk splits once into two leaders (a deciduous habit). */
  trunkSplit: number;
  // Crown
  crownShape: CrownShape;
  /** Number of branch levels below the trunk. */
  levels: number;
  /** Phyllotaxis: the turn between successive branches, degrees (137.5 is the golden angle). */
  rotate: number;
  /** Branches bend toward the sky (positive) or the ground (negative). */
  attractionUp: number;
  /** Radius of a child relative to its parent at the fork. */
  ratio: number;
  // Per level (1..3)
  branches1: number; length1: number; angle1: number; curve1: number;
  branches2: number; length2: number; angle2: number; curve2: number;
  branches3: number; length3: number; angle3: number; curve3: number;
  // Leaves
  leafKind: LeafKind;
  leafShape: LeafShape;
  /** Leaf cards per end branch. */
  leavesPerBranch: number;
  /** Card size in metres (a card is a sprig of several leaves). */
  leafSize: number;
  leafSizeVariance: number;
  /** Leaves start this far along an end branch, 0..1. */
  leafStart: number;
  /** 0..1: how far card normals are bent outward from the crown centre (shades the canopy as a volume). */
  leafNormalBend: number;
  leafColor: Rgba;
  leafColorVariation: number;
  /** 0..1: blend toward autumn colours. */
  autumn: number;
  leafTranslucency: number;
  leafRoughness: number;
  // Bark
  barkPattern: BarkPattern;
  barkColor: Rgba;
  barkRoughness: number;
  /** Metres of trunk circumference one bark texture repeat covers. */
  barkScale: number;
  // Wind
  windStrength: number;
  windStiffness: number;
  windFlutter: number;
  // LOD
  lod1Distance: number;
  /** Share of leaf cards LOD 1 keeps (grown to cover). */
  lod1Leaves: number;
  lod2Distance: number;
  lod2Leaves: number;
  impostor: boolean;
  impostorDistance: number;
  cullDistance: number;
  impostorFrames: number;
  impostorFrameSize: number;
  // Export
  barkTextureSize: number;
  leafTextureSize: number;
  /** The Materials tab's overrides (materials.ts). */
  materials?: MaterialOverrides;
}

export const DEFAULT_TREE: TreeParams = {
  height: 9, trunkRadius: 0.24, baseSize: 0.28, flare: 0.5, gnarliness: 0.25, trunkSplit: 0,
  crownShape: 'tendFlame', levels: 2, rotate: 137.5, attractionUp: 0.25, ratio: 0.55,
  branches1: 26, length1: 0.42, angle1: 52, curve1: 18,
  branches2: 8, length2: 0.45, angle2: 42, curve2: 14,
  branches3: 4, length3: 0.4, angle3: 40, curve3: 10,
  leafKind: 'broadleaf', leafShape: 'ovate', leavesPerBranch: 9, leafSize: 0.55, leafSizeVariance: 0.25, leafStart: 0.25,
  leafNormalBend: 0.6, leafColor: [0.12, 0.26, 0.05, 1], leafColorVariation: 0.3, autumn: 0,
  leafTranslucency: 0.5, leafRoughness: 0.7,
  barkPattern: 'furrowed', barkColor: [0.23, 0.18, 0.14, 1], barkRoughness: 0.92, barkScale: 1.2,
  windStrength: 0.1, windStiffness: 1.4, windFlutter: 0.45,
  lod1Distance: 15, lod1Leaves: 0.45, lod2Distance: 35, lod2Leaves: 0.16,
  impostor: true, impostorDistance: 60, cullDistance: 450, impostorFrames: 8, impostorFrameSize: 128,
  barkTextureSize: 512, leafTextureSize: 512,
};

// --- Bush ----------------------------------------------------------------------------------------

/**
 * A bush: several stems rising from one root crown, each a small tree skeleton (the tree's branching,
 * leaves and bark), leaning out from the centre. Field names match the tree's wherever the meaning is
 * the same, so the tree generator grows each stem unchanged.
 */
export interface BushParams {
  // Stems
  stems: number;
  /** Radius of the root crown the stems rise from. */
  spread: number;
  height: number;
  heightVariance: number;
  /** How far the outer stems lean out from vertical, degrees. */
  lean: number;
  stemRadius: number;
  /** Fraction of each stem's height with no branches. */
  baseSize: number;
  gnarliness: number;
  // Crown
  crownShape: CrownShape;
  levels: number;
  rotate: number;
  attractionUp: number;
  ratio: number;
  branches1: number; length1: number; angle1: number; curve1: number;
  branches2: number; length2: number; angle2: number; curve2: number;
  branches3: number; length3: number; angle3: number; curve3: number;
  // Leaves
  leafKind: LeafKind;
  leafShape: LeafShape;
  leavesPerBranch: number;
  leafSize: number;
  leafSizeVariance: number;
  leafStart: number;
  leafNormalBend: number;
  leafColor: Rgba;
  leafColorVariation: number;
  autumn: number;
  leafTranslucency: number;
  leafRoughness: number;
  // Bark
  barkPattern: BarkPattern;
  barkColor: Rgba;
  barkRoughness: number;
  barkScale: number;
  // Wind
  windStrength: number;
  windStiffness: number;
  windFlutter: number;
  // LOD
  lod1Distance: number;
  lod1Leaves: number;
  lod2Distance: number;
  lod2Leaves: number;
  cullDistance: number;
  // Export
  barkTextureSize: number;
  leafTextureSize: number;
  /** The Materials tab's overrides (materials.ts). */
  materials?: MaterialOverrides;
}

export const DEFAULT_BUSH: BushParams = {
  stems: 7, spread: 0.18, height: 1.4, heightVariance: 0.3, lean: 28, stemRadius: 0.025, baseSize: 0.12, gnarliness: 0.3,
  crownShape: 'spherical', levels: 2, rotate: 137.5, attractionUp: 0.2, ratio: 0.6,
  branches1: 7, length1: 0.42, angle1: 48, curve1: 10,
  branches2: 3, length2: 0.5, angle2: 42, curve2: 8,
  branches3: 3, length3: 0.4, angle3: 40, curve3: 6,
  leafKind: 'broadleaf', leafShape: 'elliptic', leavesPerBranch: 6, leafSize: 0.36, leafSizeVariance: 0.25, leafStart: 0.15,
  leafNormalBend: 0.7, leafColor: [0.1, 0.22, 0.05, 1], leafColorVariation: 0.3, autumn: 0,
  leafTranslucency: 0.45, leafRoughness: 0.7,
  barkPattern: 'smooth', barkColor: [0.24, 0.19, 0.14, 1], barkRoughness: 0.9, barkScale: 0.4,
  windStrength: 0.18, windStiffness: 1.2, windFlutter: 0.5,
  lod1Distance: 8, lod1Leaves: 0.45, lod2Distance: 20, lod2Leaves: 0.18, cullDistance: 70,
  barkTextureSize: 256, leafTextureSize: 512,
};

// --- Document ------------------------------------------------------------------------------------

export interface FoliageDoc {
  kind: FoliageKind;
  seed: number;
  /** The export's file-name stem. */
  name: string;
  grass: GrassParams;
  rock: RockParams;
  tree: TreeParams;
  bush: BushParams;
}

export const DEFAULT_DOC: FoliageDoc = {
  kind: 'tree', seed: 1, name: 'tree',
  grass: DEFAULT_GRASS, rock: DEFAULT_ROCK, tree: DEFAULT_TREE, bush: DEFAULT_BUSH,
};

export const KIND_LABELS: Record<FoliageKind, string> = { grass: 'Grass', rock: 'Rock', tree: 'Tree', bush: 'Bush' };

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};
const int = (v: unknown, lo: number, hi: number, fallback: number) => Math.round(clamp(v, lo, hi, fallback));
const pow2 = (v: unknown, fallback: number) => {
  const n = Number(v);
  return [128, 256, 512, 1024, 2048].includes(n) ? n : fallback;
};

/**
 * A stored or edited document made safe to generate from: missing fields filled from the defaults,
 * enums from strings, counts rounded and clamped to what the generators can take, and the LOD ladder
 * forced ascending. The clamps are also the guard against a pasted document that would build a
 * million-triangle tree.
 */
export function normaliseFoliage(raw: Partial<FoliageDoc> | null | undefined): FoliageDoc {
  const d = raw ?? {};
  const kind: FoliageKind = d.kind === 'grass' || d.kind === 'rock' || d.kind === 'tree' || d.kind === 'bush' ? d.kind : DEFAULT_DOC.kind;
  const g: GrassParams = { ...DEFAULT_GRASS, ...(d.grass ?? {}) };
  g.blades = int(g.blades, 1, 400, DEFAULT_GRASS.blades);
  g.segments = int(g.segments, 1, 8, DEFAULT_GRASS.segments);
  g.textureSize = pow2(g.textureSize, DEFAULT_GRASS.textureSize);
  g.lod1Distance = clamp(g.lod1Distance, 0.5, 1000, DEFAULT_GRASS.lod1Distance);
  g.lod2Distance = Math.max(g.lod1Distance + 0.5, clamp(g.lod2Distance, 0.5, 2000, DEFAULT_GRASS.lod2Distance));
  g.cullDistance = Math.max(g.lod2Distance + 0.5, clamp(g.cullDistance, 1, 5000, DEFAULT_GRASS.cullDistance));
  g.lod1Blades = clamp(g.lod1Blades, 0.05, 1, DEFAULT_GRASS.lod1Blades);
  g.materials = normaliseOverrides(g.materials, 'grass');

  const r: RockParams = { ...DEFAULT_ROCK, ...(d.rock ?? {}) };
  r.detail = int(r.detail, 2, 6, DEFAULT_ROCK.detail);
  r.triangles = int(r.triangles, 60, 40000, DEFAULT_ROCK.triangles);
  r.cuts = int(r.cuts, 0, 8, DEFAULT_ROCK.cuts);
  r.textureSize = pow2(r.textureSize, DEFAULT_ROCK.textureSize);
  if (!Array.isArray(r.proportions) || r.proportions.length !== 3) r.proportions = DEFAULT_ROCK.proportions;
  r.proportions = r.proportions.map(v => clamp(v, 0.1, 4, 1)) as [number, number, number];
  r.lod1Ratio = clamp(r.lod1Ratio, 0.02, 1, DEFAULT_ROCK.lod1Ratio);
  r.lod2Ratio = Math.min(r.lod1Ratio, clamp(r.lod2Ratio, 0.01, 1, DEFAULT_ROCK.lod2Ratio));
  r.lod1Distance = clamp(r.lod1Distance, 0.5, 2000, DEFAULT_ROCK.lod1Distance);
  r.lod2Distance = Math.max(r.lod1Distance + 0.5, clamp(r.lod2Distance, 0.5, 4000, DEFAULT_ROCK.lod2Distance));
  r.cullDistance = Math.max(r.lod2Distance + 0.5, clamp(r.cullDistance, 1, 10000, DEFAULT_ROCK.cullDistance));
  r.materials = normaliseOverrides(r.materials, 'rock');

  const t: TreeParams = { ...DEFAULT_TREE, ...(d.tree ?? {}) };
  t.levels = int(t.levels, 1, 3, DEFAULT_TREE.levels);
  t.branches1 = int(t.branches1, 0, 120, DEFAULT_TREE.branches1);
  t.branches2 = int(t.branches2, 0, 40, DEFAULT_TREE.branches2);
  t.branches3 = int(t.branches3, 0, 20, DEFAULT_TREE.branches3);
  t.leavesPerBranch = int(t.leavesPerBranch, 0, 60, DEFAULT_TREE.leavesPerBranch);
  t.impostorFrames = int(t.impostorFrames, 4, 16, DEFAULT_TREE.impostorFrames);
  t.impostorFrameSize = pow2(t.impostorFrameSize, DEFAULT_TREE.impostorFrameSize);
  t.barkTextureSize = pow2(t.barkTextureSize, DEFAULT_TREE.barkTextureSize);
  t.leafTextureSize = pow2(t.leafTextureSize, DEFAULT_TREE.leafTextureSize);
  t.impostor = !!t.impostor;
  t.lod1Leaves = clamp(t.lod1Leaves, 0.02, 1, DEFAULT_TREE.lod1Leaves);
  t.lod2Leaves = Math.min(t.lod1Leaves, clamp(t.lod2Leaves, 0.01, 1, DEFAULT_TREE.lod2Leaves));
  t.lod1Distance = clamp(t.lod1Distance, 0.5, 2000, DEFAULT_TREE.lod1Distance);
  t.lod2Distance = Math.max(t.lod1Distance + 0.5, clamp(t.lod2Distance, 0.5, 4000, DEFAULT_TREE.lod2Distance));
  t.impostorDistance = Math.max(t.lod2Distance + 0.5, clamp(t.impostorDistance, 1, 8000, DEFAULT_TREE.impostorDistance));
  t.cullDistance = Math.max((t.impostor ? t.impostorDistance : t.lod2Distance) + 0.5, clamp(t.cullDistance, 1, 20000, DEFAULT_TREE.cullDistance));
  t.materials = normaliseOverrides(t.materials, 'tree');

  const b: BushParams = { ...DEFAULT_BUSH, ...(d.bush ?? {}) };
  b.stems = int(b.stems, 1, 24, DEFAULT_BUSH.stems);
  b.levels = int(b.levels, 1, 3, DEFAULT_BUSH.levels);
  b.branches1 = int(b.branches1, 0, 40, DEFAULT_BUSH.branches1);
  b.branches2 = int(b.branches2, 0, 20, DEFAULT_BUSH.branches2);
  b.branches3 = int(b.branches3, 0, 12, DEFAULT_BUSH.branches3);
  b.leavesPerBranch = int(b.leavesPerBranch, 0, 40, DEFAULT_BUSH.leavesPerBranch);
  b.barkTextureSize = pow2(b.barkTextureSize, DEFAULT_BUSH.barkTextureSize);
  b.leafTextureSize = pow2(b.leafTextureSize, DEFAULT_BUSH.leafTextureSize);
  b.lod1Leaves = clamp(b.lod1Leaves, 0.02, 1, DEFAULT_BUSH.lod1Leaves);
  b.lod2Leaves = Math.min(b.lod1Leaves, clamp(b.lod2Leaves, 0.01, 1, DEFAULT_BUSH.lod2Leaves));
  b.lod1Distance = clamp(b.lod1Distance, 0.5, 1000, DEFAULT_BUSH.lod1Distance);
  b.lod2Distance = Math.max(b.lod1Distance + 0.5, clamp(b.lod2Distance, 0.5, 2000, DEFAULT_BUSH.lod2Distance));
  b.cullDistance = Math.max(b.lod2Distance + 0.5, clamp(b.cullDistance, 1, 5000, DEFAULT_BUSH.cullDistance));
  b.materials = normaliseOverrides(b.materials, 'bush');

  const seed = int(d.seed, 0, 0x7fffffff, DEFAULT_DOC.seed);
  const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim().replace(/[^\w\- ]+/g, '').slice(0, 64) || kind : kind;
  return { kind, seed, name, grass: g, rock: r, tree: t, bush: b };
}

// --- Schemas -------------------------------------------------------------------------------------

const enumOf = <T extends string>(entries: [T, string][]) => entries.map(([value, label]) => ({ value, label }));
const SIZES = enumOf([['128', '128'], ['256', '256'], ['512', '512'], ['1024', '1024'], ['2048', '2048']]);

export const GRASS_SCHEMA: FoliageGroup[] = [
  { title: 'Clump', specs: [
    { key: 'blades', label: 'Blades', kind: 'int', min: 1, max: 400, hint: 'Blades in one clump. Each is a few triangles; the clump is one foliage instance.' },
    { key: 'clumpRadius', label: 'Clump radius', kind: 'float', min: 0.02, max: 2, step: 0.01, unit: 'm' },
    { key: 'clumpFacing', label: 'Clump facing', kind: 'float', min: 0, max: 1, step: 0.01, hint: 'How much blades lean away from the clump centre.' },
  ] },
  { title: 'Blade', specs: [
    { key: 'height', label: 'Height', kind: 'float', min: 0.02, max: 3, step: 0.01, unit: 'm' },
    { key: 'heightVariance', label: 'Height variance', kind: 'float', min: 0, max: 0.9, step: 0.01 },
    { key: 'width', label: 'Width', kind: 'float', min: 0.002, max: 0.2, step: 0.001, unit: 'm' },
    { key: 'taper', label: 'Taper', kind: 'float', min: 0, max: 1, step: 0.01 },
    { key: 'bend', label: 'Bend', kind: 'float', min: 0, max: 1, step: 0.01 },
    { key: 'curvature', label: 'Curvature', kind: 'float', min: 1, max: 4, step: 0.05 },
    { key: 'tilt', label: 'Tilt', kind: 'float', min: 0, max: 60, step: 1, unit: '°' },
    { key: 'segments', label: 'Segments', kind: 'int', min: 1, max: 8 },
    { key: 'normalRounding', label: 'Normal rounding', kind: 'float', min: 0, max: 1.2, step: 0.01, unit: 'rad' },
  ] },
  { title: 'Blade texture', side: 'material', material: 'grass', specs: [
    { key: 'baseColor', label: 'Base colour', kind: 'color' },
    { key: 'tipColor', label: 'Tip colour', kind: 'color' },
    { key: 'dryness', label: 'Dryness', kind: 'float', min: 0, max: 1, step: 0.01 },
    { key: 'dryColor', label: 'Dry colour', kind: 'color' },
    { key: 'rootShade', label: 'Root shade', kind: 'float', min: 0, max: 1, step: 0.01 },
  ] },
  { title: 'Levels', side: 'lod', specs: [
    { key: 'lod1Distance', label: 'LOD 1 distance', kind: 'float', min: 0.5, max: 200, step: 0.5, unit: 'm' },
    { key: 'lod1Blades', label: 'LOD 1 blades', kind: 'float', min: 0.05, max: 1, step: 0.01 },
    { key: 'lod2Distance', label: 'LOD 2 distance', kind: 'float', min: 0.5, max: 400, step: 0.5, unit: 'm', hint: 'LOD 2 is three crossed cards carrying a picture of the clump.' },
    { key: 'cullDistance', label: 'Cull distance', kind: 'float', min: 1, max: 1000, step: 1, unit: 'm' },
  ] },
  { title: 'Textures', side: 'export', specs: [
    { key: 'textureSize', label: 'Texture size', kind: 'enum', options: SIZES },
  ] },
];

export const ROCK_SCHEMA: FoliageGroup[] = [
  { title: 'Shape', specs: [
    { key: 'size', label: 'Size', kind: 'float', min: 0.05, max: 20, step: 0.05, unit: 'm' },
    { key: 'proportions', label: 'Proportions', kind: 'vec3' },
    { key: 'detail', label: 'Detail', kind: 'int', min: 2, max: 6, hint: 'Subdivisions carved by the noise before decimation.' },
    { key: 'triangles', label: 'Triangles', kind: 'int', min: 60, max: 40000, hint: 'LOD 0 is decimated to this many triangles.' },
  ] },
  { title: 'Surface', specs: [
    { key: 'noiseAmount', label: 'Noise amount', kind: 'float', min: 0, max: 0.6, step: 0.01 },
    { key: 'noiseScale', label: 'Noise scale', kind: 'float', min: 0.2, max: 8, step: 0.05 },
    { key: 'sharpness', label: 'Sharpness', kind: 'float', min: 0, max: 1, step: 0.01 },
    { key: 'cuts', label: 'Cuts', kind: 'int', min: 0, max: 8 },
    { key: 'cutDepth', label: 'Cut depth', kind: 'float', min: 0, max: 0.5, step: 0.01, when: p => Number(p.cuts) > 0 },
    { key: 'strata', label: 'Strata', kind: 'float', min: 0, max: 1, step: 0.01 },
    { key: 'strataFrequency', label: 'Strata frequency', kind: 'float', min: 1, max: 30, step: 0.5, when: p => Number(p.strata) > 0 },
    { key: 'flattenBottom', label: 'Flatten bottom', kind: 'float', min: 0, max: 0.8, step: 0.01 },
  ] },
  { title: 'Rock texture', side: 'material', material: 'rock', specs: [
    { key: 'color', label: 'Colour', kind: 'color' },
    { key: 'colorVariation', label: 'Colour variation', kind: 'float', min: 0, max: 1, step: 0.01 },
    { key: 'edgeWear', label: 'Edge wear', kind: 'float', min: 0, max: 1, step: 0.01 },
    { key: 'cavityDirt', label: 'Cavity dirt', kind: 'float', min: 0, max: 1, step: 0.01 },
    { key: 'moss', label: 'Moss', kind: 'float', min: 0, max: 1, step: 0.01 },
    { key: 'mossColor', label: 'Moss colour', kind: 'color', when: p => Number(p.moss) > 0 },
    { key: 'bumpiness', label: 'Bumpiness', kind: 'float', min: 0, max: 3, step: 0.05 },
  ] },
  { title: 'Levels', side: 'lod', specs: [
    { key: 'lod1Ratio', label: 'LOD 1 triangles', kind: 'float', min: 0.02, max: 1, step: 0.01, hint: 'Fraction of LOD 0.' },
    { key: 'lod1Distance', label: 'LOD 1 distance', kind: 'float', min: 0.5, max: 500, step: 0.5, unit: 'm' },
    { key: 'lod2Ratio', label: 'LOD 2 triangles', kind: 'float', min: 0.01, max: 1, step: 0.01, hint: 'Fraction of LOD 0.' },
    { key: 'lod2Distance', label: 'LOD 2 distance', kind: 'float', min: 0.5, max: 1000, step: 0.5, unit: 'm' },
    { key: 'cullDistance', label: 'Cull distance', kind: 'float', min: 1, max: 5000, step: 1, unit: 'm' },
  ] },
  { title: 'Textures', side: 'export', specs: [
    { key: 'textureSize', label: 'Texture size', kind: 'enum', options: SIZES },
  ] },
];

const level = (n: 1 | 2 | 3, title: string, max = n === 1 ? 120 : n === 2 ? 40 : 20, first = 'Along the trunk.'): FoliageGroup => ({
  title, specs: [
    { key: `branches${n}`, label: 'Branches', kind: 'int', min: 0, max, hint: n === 1 ? first : 'On each parent branch.', when: p => Number(p.levels) >= n },
    { key: `length${n}`, label: 'Length', kind: 'float', min: 0.05, max: 1.5, step: 0.01, hint: 'Relative to the parent.', when: p => Number(p.levels) >= n },
    { key: `angle${n}`, label: 'Angle', kind: 'float', min: 0, max: 150, step: 1, unit: '°', hint: 'Down from the parent\'s direction.', when: p => Number(p.levels) >= n },
    { key: `curve${n}`, label: 'Curve', kind: 'float', min: -90, max: 90, step: 1, unit: '°', when: p => Number(p.levels) >= n },
  ],
});

const CROWN_SHAPES = enumOf<CrownShape>([
  ['conical', 'Conical'], ['spherical', 'Spherical'], ['hemispherical', 'Hemispherical'], ['cylindrical', 'Cylindrical'],
  ['tapered', 'Tapered cylinder'], ['flame', 'Flame'], ['inverse', 'Inverse conical'], ['tendFlame', 'Tend flame']]);

/** Leaves and the leaf and bark textures: the same fields on a tree and a bush. */
const PLANT_LOOK: FoliageGroup[] = [
  { title: 'Leaves', specs: [
    { key: 'leafKind', label: 'Leaf kind', kind: 'enum', options: enumOf<LeafKind>([['broadleaf', 'Broadleaf'], ['needles', 'Needles'], ['none', 'None']]) },
    { key: 'leavesPerBranch', label: 'Cards per branch', kind: 'int', min: 0, max: 60, when: p => p.leafKind !== 'none' },
    { key: 'leafSize', label: 'Card size', kind: 'float', min: 0.05, max: 3, step: 0.01, unit: 'm', when: p => p.leafKind !== 'none' },
    { key: 'leafSizeVariance', label: 'Size variance', kind: 'float', min: 0, max: 0.9, step: 0.01, when: p => p.leafKind !== 'none' },
    { key: 'leafStart', label: 'Leaf start', kind: 'float', min: 0, max: 0.95, step: 0.01, when: p => p.leafKind !== 'none' },
    { key: 'leafNormalBend', label: 'Normal bend', kind: 'float', min: 0, max: 1, step: 0.01, when: p => p.leafKind !== 'none' },
  ] },
  { title: 'Leaf texture', side: 'material', material: 'leaves', specs: [
    { key: 'leafShape', label: 'Leaf shape', kind: 'enum', when: p => p.leafKind === 'broadleaf', options: enumOf<LeafShape>([
      ['ovate', 'Ovate'], ['elliptic', 'Elliptic'], ['lanceolate', 'Lanceolate'], ['round', 'Round'], ['lobed', 'Lobed']]) },
    { key: 'leafColor', label: 'Leaf colour', kind: 'color' },
    { key: 'leafColorVariation', label: 'Colour variation', kind: 'float', min: 0, max: 1, step: 0.01 },
    { key: 'autumn', label: 'Autumn', kind: 'float', min: 0, max: 1, step: 0.01, when: p => p.leafKind === 'broadleaf' },
  ] },
  { title: 'Bark texture', side: 'material', material: 'bark', specs: [
    { key: 'barkPattern', label: 'Pattern', kind: 'enum', options: enumOf<BarkPattern>([
      ['furrowed', 'Furrowed'], ['plated', 'Plated'], ['smooth', 'Smooth'], ['papery', 'Papery (birch)']]) },
    { key: 'barkColor', label: 'Bark colour', kind: 'color' },
    { key: 'barkScale', label: 'Bark scale', kind: 'float', min: 0.1, max: 6, step: 0.05, unit: 'm' },
  ] },
];

export const TREE_SCHEMA: FoliageGroup[] = [
  { title: 'Trunk', specs: [
    { key: 'height', label: 'Height', kind: 'float', min: 0.5, max: 60, step: 0.1, unit: 'm' },
    { key: 'trunkRadius', label: 'Trunk radius', kind: 'float', min: 0.01, max: 2, step: 0.01, unit: 'm' },
    { key: 'baseSize', label: 'Bare trunk', kind: 'float', min: 0, max: 0.95, step: 0.01, hint: 'Fraction of the height with no branches.' },
    { key: 'flare', label: 'Root flare', kind: 'float', min: 0, max: 2, step: 0.01 },
    { key: 'gnarliness', label: 'Gnarliness', kind: 'float', min: 0, max: 1, step: 0.01 },
    { key: 'trunkSplit', label: 'Trunk split', kind: 'float', min: 0, max: 0.9, step: 0.01, hint: 'Where the trunk forks into two leaders, as a fraction of the height; 0 never.' },
  ] },
  { title: 'Crown', specs: [
    { key: 'crownShape', label: 'Crown shape', kind: 'enum', options: CROWN_SHAPES },
    { key: 'levels', label: 'Branch levels', kind: 'int', min: 1, max: 3 },
    { key: 'rotate', label: 'Rotation', kind: 'float', min: 0, max: 360, step: 0.5, unit: '°', hint: '137.5° is the golden angle.' },
    { key: 'attractionUp', label: 'Attraction up', kind: 'float', min: -1, max: 1, step: 0.01 },
    { key: 'ratio', label: 'Branch thickness', kind: 'float', min: 0.1, max: 0.95, step: 0.01 },
  ] },
  level(1, 'Branches'),
  level(2, 'Sub-branches'),
  level(3, 'Twigs'),
  ...PLANT_LOOK,
  { title: 'Levels', side: 'lod', specs: [
    { key: 'lod1Distance', label: 'LOD 1 distance', kind: 'float', min: 0.5, max: 500, step: 0.5, unit: 'm' },
    { key: 'lod1Leaves', label: 'LOD 1 leaves', kind: 'float', min: 0.02, max: 1, step: 0.01 },
    { key: 'lod2Distance', label: 'LOD 2 distance', kind: 'float', min: 0.5, max: 1000, step: 0.5, unit: 'm' },
    { key: 'lod2Leaves', label: 'LOD 2 leaves', kind: 'float', min: 0.01, max: 1, step: 0.01 },
    { key: 'cullDistance', label: 'Cull distance', kind: 'float', min: 1, max: 20000, step: 1, unit: 'm' },
  ] },
  { title: 'Impostor', side: 'lod', specs: [
    { key: 'impostor', label: 'Impostor', kind: 'bool', hint: 'An octahedral impostor replaces the last mesh level beyond its distance.' },
    { key: 'impostorDistance', label: 'Impostor distance', kind: 'float', min: 1, max: 4000, step: 1, unit: 'm', when: p => !!p.impostor },
    { key: 'impostorFrames', label: 'Frames', kind: 'int', min: 4, max: 16, when: p => !!p.impostor },
    { key: 'impostorFrameSize', label: 'Frame size', kind: 'enum', options: SIZES.slice(0, 3), when: p => !!p.impostor },
  ] },
  { title: 'Textures', side: 'export', specs: [
    { key: 'barkTextureSize', label: 'Bark texture size', kind: 'enum', options: SIZES },
    { key: 'leafTextureSize', label: 'Leaf texture size', kind: 'enum', options: SIZES },
  ] },
];

export const BUSH_SCHEMA: FoliageGroup[] = [
  { title: 'Stems', specs: [
    { key: 'stems', label: 'Stems', kind: 'int', min: 1, max: 24, hint: 'Stems rising from the root crown; each grows like a small tree.' },
    { key: 'spread', label: 'Spread', kind: 'float', min: 0, max: 2, step: 0.01, unit: 'm', hint: 'Radius of the root crown.' },
    { key: 'height', label: 'Height', kind: 'float', min: 0.1, max: 8, step: 0.05, unit: 'm' },
    { key: 'heightVariance', label: 'Height variance', kind: 'float', min: 0, max: 0.9, step: 0.01 },
    { key: 'lean', label: 'Lean', kind: 'float', min: 0, max: 80, step: 1, unit: '°', hint: 'How far the outer stems lean out from vertical.' },
    { key: 'stemRadius', label: 'Stem radius', kind: 'float', min: 0.003, max: 0.3, step: 0.001, unit: 'm' },
    { key: 'baseSize', label: 'Bare stem', kind: 'float', min: 0, max: 0.9, step: 0.01, hint: 'Fraction of each stem with no branches.' },
    { key: 'gnarliness', label: 'Gnarliness', kind: 'float', min: 0, max: 1, step: 0.01 },
  ] },
  { title: 'Crown', specs: [
    { key: 'crownShape', label: 'Crown shape', kind: 'enum', options: CROWN_SHAPES },
    { key: 'levels', label: 'Branch levels', kind: 'int', min: 1, max: 3 },
    { key: 'rotate', label: 'Rotation', kind: 'float', min: 0, max: 360, step: 0.5, unit: '°', hint: '137.5° is the golden angle.' },
    { key: 'attractionUp', label: 'Attraction up', kind: 'float', min: -1, max: 1, step: 0.01 },
    { key: 'ratio', label: 'Branch thickness', kind: 'float', min: 0.1, max: 0.95, step: 0.01 },
  ] },
  level(1, 'Branches', 40, 'Along each stem.'),
  level(2, 'Sub-branches', 20),
  level(3, 'Twigs', 12),
  ...PLANT_LOOK,
  { title: 'Levels', side: 'lod', specs: [
    { key: 'lod1Distance', label: 'LOD 1 distance', kind: 'float', min: 0.5, max: 300, step: 0.5, unit: 'm' },
    { key: 'lod1Leaves', label: 'LOD 1 leaves', kind: 'float', min: 0.02, max: 1, step: 0.01 },
    { key: 'lod2Distance', label: 'LOD 2 distance', kind: 'float', min: 0.5, max: 600, step: 0.5, unit: 'm' },
    { key: 'lod2Leaves', label: 'LOD 2 leaves', kind: 'float', min: 0.01, max: 1, step: 0.01 },
    { key: 'cullDistance', label: 'Cull distance', kind: 'float', min: 1, max: 2000, step: 1, unit: 'm' },
  ] },
  { title: 'Textures', side: 'export', specs: [
    { key: 'barkTextureSize', label: 'Bark texture size', kind: 'enum', options: SIZES },
    { key: 'leafTextureSize', label: 'Leaf texture size', kind: 'enum', options: SIZES },
  ] },
];

export const FOLIAGE_SCHEMAS: Record<FoliageKind, FoliageGroup[]> = { grass: GRASS_SCHEMA, rock: ROCK_SCHEMA, tree: TREE_SCHEMA, bush: BUSH_SCHEMA };

/** Enum fields that are numbers in the record but strings in the form. */
const NUMERIC_ENUMS = new Set(['textureSize', 'barkTextureSize', 'leafTextureSize', 'impostorFrameSize']);

/** A kind's record as ParamForm's values: numeric enums as strings. */
export function formValues(params: object): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  for (const k of NUMERIC_ENUMS) if (k in out) out[k] = String(out[k]);
  return out;
}

/** A ParamForm patch back into a kind's record: numeric enums back to numbers. */
export function fromForm<P extends object>(params: P, patch: Record<string, unknown>): P {
  const out: Record<string, unknown> = { ...params, ...patch };
  for (const k of NUMERIC_ENUMS) if (k in patch) out[k] = Number(patch[k]);
  return out as P;
}
