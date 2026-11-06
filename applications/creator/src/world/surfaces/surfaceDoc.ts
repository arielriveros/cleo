// The World's surfaces: an ordered stack of layers (Sand, Grass, Rock, Snow...), each placed by rules over
// the terrain's own values and what happened to it. The outputs say only WHERE each surface is (splat
// and weight maps); the material that represents it is the user's choice in whatever engine reads them.
// Each layer's `preview` (a generated PBR material, its tint and tiling) is only for the Creator's view
// and is never exported.
//
// Order: index 0 is the base (it covers everything; it has no rules), later layers composite over the
// earlier ones -- the engine's terrain stack convention (`compositeWeights`, bottom to top).
//
// Every rule parameter is in world units (metres, degrees, m²), so a rule reads the same on the 257² live
// preview as on a 4097² export.

import type { SurfaceKind } from '../../surfaces/kinds';

/** What a condition reads. */
export type SurfaceInput =
  | 'height' | 'heightAboveWater' | 'relativeHeight'
  | 'slope' | 'aspect' | 'curvature' | 'cavity'
  | 'flowArea' | 'wetness' | 'waterDepth' | 'shoreDistance'
  | 'deposits' | 'wear' | 'talus'
  | 'layer' | 'noise';

/** How a condition joins the mask built by the conditions above it. */
export type CombineMode = 'multiply' | 'add' | 'subtract' | 'max' | 'min';

/** Feature size for the inputs measured over a neighbourhood (curvature, cavity). */
export type FieldScale = 'fine' | 'medium' | 'broad';

export interface NoiseSpec {
  /** Feature size, m. */
  scale: number;
  octaves: number;
  seed: number;
  /** Domain warp, 0..1: bends the blobs into folds. */
  warp: number;
}

export interface SurfaceCondition {
  id: string;
  enabled: boolean;
  input: SurfaceInput;
  /** The range that passes fully, in the input's unit (aspect: unused, see goal/spread). */
  min: number;
  max: number;
  /** How far below `min` / above `max` the condition fades out, in the input's unit. */
  falloffLow: number;
  falloffHigh: number;
  /** Aspect: the compass direction the slope faces that passes fully, degrees (0 = north = -Z, 90 = east = +X). */
  goal?: number;
  /** Aspect: degrees either side of `goal` that pass fully; `falloffHigh` fades beyond. */
  spread?: number;
  /** Curvature, cavity: the neighbourhood the input is measured over. */
  scale?: FieldScale;
  /** Layer: the (lower) surface whose coverage this reads. */
  layerId?: string;
  /** Noise: the noise sampled. */
  noise?: NoiseSpec;
  invert: boolean;
  /** Ignored on the first enabled condition (it starts the mask). */
  combine: CombineMode;
}

export interface SurfaceBreakup {
  /** 0..1: how far the noise moves a soft edge. Solid coverage stays solid. */
  amount: number;
  scale: number;
  octaves: number;
  seed: number;
  warp: number;
}

export interface SurfacePost {
  /** Grows (positive) or shrinks (negative) the mask, m. */
  expand: number;
  /** Softens the mask, m. */
  blur: number;
  /** 0..1: sharpens soft edges toward a hard line. */
  contrast: number;
  /** 0..1: the layer's strength. */
  opacity: number;
}

/** How the Creator shows the surface. Never exported. */
export interface SurfacePreview {
  kind: SurfaceKind;
  /** Linear RGB multiplier over the generated albedo. */
  tint: [number, number, number];
  /** Metres one texture repeat covers. */
  tiling: number;
  /** 0..1: transitions follow the material's height (pebbles poke through sand). */
  heightBlend: number;
}

export interface SurfaceLayer {
  id: string;
  name: string;
  enabled: boolean;
  conditions: SurfaceCondition[];
  breakup: SurfaceBreakup;
  post: SurfacePost;
  preview: SurfacePreview;
}

/** The engine's terrain stack draws at most this many surfaces (base included). */
export const MAX_SURFACES = 16;

export interface InputInfo {
  label: string;
  unit: string;
  /** The range a histogram and the sliders span. */
  domain: [number, number];
  /** A new condition's pass band and falloffs. */
  defaults: { min: number; max: number; falloffLow: number; falloffHigh: number };
  step: number;
  /** One line for the docs card and the picker. */
  hint: string;
  scaled?: boolean;
}

export const INPUT_INFO: Record<SurfaceInput, InputInfo> = {
  height: { label: 'Height', unit: 'm', domain: [-200, 3000], defaults: { min: 0, max: 200, falloffLow: 10, falloffHigh: 10 }, step: 1, hint: 'Ground height above the world origin.' },
  heightAboveWater: { label: 'Height above water', unit: 'm', domain: [-50, 500], defaults: { min: 0, max: 4, falloffLow: 0.5, falloffHigh: 2 }, step: 0.1, hint: 'Ground height above the nearest sea or lake surface: beaches, banks, flood plains.' },
  relativeHeight: { label: 'Relative height', unit: '', domain: [0, 1], defaults: { min: 0.6, max: 1, falloffLow: 0.05, falloffHigh: 0 }, step: 0.005, hint: 'Height as a fraction of the map\'s lowest to highest point.' },
  slope: { label: 'Slope', unit: '°', domain: [0, 90], defaults: { min: 30, max: 90, falloffLow: 5, falloffHigh: 0 }, step: 0.5, hint: 'Steepness in degrees: 0 is flat, 90 a vertical wall.' },
  aspect: { label: 'Aspect', unit: '°', domain: [0, 360], defaults: { min: 0, max: 0, falloffLow: 0, falloffHigh: 40 }, step: 1, hint: 'The compass direction a slope faces (0 north = -Z, 90 east = +X). Flat ground reads as half.' },
  curvature: { label: 'Curvature', unit: '', domain: [-1, 1], defaults: { min: 0.15, max: 1, falloffLow: 0.1, falloffHigh: 0 }, step: 0.01, hint: 'Convex (ridges, crests: positive) to concave (gullies, hollows: negative), over the chosen scale.', scaled: true },
  cavity: { label: 'Cavity', unit: '', domain: [0, 1], defaults: { min: 0.3, max: 1, falloffLow: 0.1, falloffHigh: 0 }, step: 0.01, hint: 'How enclosed the ground is by terrain around it: 0 open sky, 1 deep in a hollow.', scaled: true },
  flowArea: { label: 'Flow area', unit: 'log₁₀ m²', domain: [1, 9], defaults: { min: 5, max: 9, falloffLow: 0.5, falloffHigh: 0 }, step: 0.05, hint: 'The area that drains through the ground, as a power of ten: 4 = a hectare (rills), 6 = a square kilometre (streams).' },
  wetness: { label: 'Wetness', unit: '', domain: [0, 1], defaults: { min: 0.5, max: 1, falloffLow: 0.1, falloffHigh: 0 }, step: 0.01, hint: 'Where water collects and lingers: high flow, flat and low ground.' },
  waterDepth: { label: 'Water depth', unit: 'm', domain: [0, 100], defaults: { min: 0.01, max: 100, falloffLow: 0, falloffHigh: 0 }, step: 0.1, hint: 'Depth of the sea or lake over the ground; 0 on dry land.' },
  shoreDistance: { label: 'Shore distance', unit: 'm', domain: [-200, 500], defaults: { min: -5, max: 20, falloffLow: 2, falloffHigh: 10 }, step: 0.5, hint: 'Distance to the nearest water edge: positive on land, negative under water.' },
  deposits: { label: 'Deposits', unit: '', domain: [0, 1], defaults: { min: 0.2, max: 1, falloffLow: 0.1, falloffHigh: 0 }, step: 0.01, hint: 'Where hydraulic erosion laid sediment down: fans, valley floors, river bars.' },
  wear: { label: 'Wear', unit: '', domain: [0, 1], defaults: { min: 0.2, max: 1, falloffLow: 0.1, falloffHigh: 0 }, step: 0.01, hint: 'Where hydraulic erosion cut the ground away: channels, gullies, scoured rock.' },
  talus: { label: 'Talus', unit: '', domain: [0, 1], defaults: { min: 0.15, max: 1, falloffLow: 0.1, falloffHigh: 0 }, step: 0.01, hint: 'Where thermal erosion piled loose material at the foot of slopes: scree.' },
  layer: { label: 'Layer', unit: '', domain: [0, 1], defaults: { min: 0.5, max: 1, falloffLow: 0.3, falloffHigh: 0 }, step: 0.01, hint: 'The coverage of a surface below this one: require it, or (inverted) avoid it.' },
  noise: { label: 'Noise', unit: '', domain: [0, 1], defaults: { min: 0.5, max: 1, falloffLow: 0.15, falloffHigh: 0 }, step: 0.01, hint: 'Seeded fractal noise in world space: patches, clearings, variety.' },
};

export const SURFACE_INPUTS = Object.keys(INPUT_INFO) as SurfaceInput[];

/** Curvature and cavity neighbourhoods, m. */
export const FIELD_SCALE_METRES: Record<FieldScale, { curvature: number; cavity: number }> = {
  fine: { curvature: 8, cavity: 15 },
  medium: { curvature: 30, cavity: 50 },
  broad: { curvature: 120, cavity: 150 },
};

let counter = 0;
const newSurfaceId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export const DEFAULT_BREAKUP: SurfaceBreakup = { amount: 0.5, scale: 25, octaves: 4, seed: 1, warp: 0.3 };
export const DEFAULT_POST: SurfacePost = { expand: 0, blur: 0, contrast: 0, opacity: 1 };
export const DEFAULT_NOISE: NoiseSpec = { scale: 60, octaves: 4, seed: 1, warp: 0.3 };

export function newCondition(input: SurfaceInput, patch: Partial<SurfaceCondition> = {}): SurfaceCondition {
  const d = INPUT_INFO[input].defaults;
  return {
    id: newSurfaceId('c'), enabled: true, input, ...d, invert: false, combine: 'multiply',
    ...(input === 'aspect' ? { goal: 0, spread: 45 } : {}),
    ...(INPUT_INFO[input].scaled ? { scale: 'medium' as FieldScale } : {}),
    ...(input === 'noise' ? { noise: { ...DEFAULT_NOISE } } : {}),
    ...patch,
  };
}

export function newSurface(name: string, preview: Partial<SurfacePreview> & { kind: SurfaceKind }, conditions: SurfaceCondition[] = [],
                           patch: Partial<Omit<SurfaceLayer, 'id' | 'preview'>> = {}): SurfaceLayer {
  return {
    id: newSurfaceId('s'), name, enabled: true, conditions,
    breakup: { ...DEFAULT_BREAKUP }, post: { ...DEFAULT_POST },
    preview: { tint: [1, 1, 1], tiling: 6, heightBlend: 0.4, ...preview },
    ...patch,
  };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const COMBINES: readonly CombineMode[] = ['multiply', 'add', 'subtract', 'max', 'min'];
const SCALES: readonly FieldScale[] = ['fine', 'medium', 'broad'];

/** A stored surface stack brought up to the current shape: unknown inputs dropped, missing fields filled. */
export function normaliseSurfaces(raw: unknown, fallback: () => SurfaceLayer[]): SurfaceLayer[] {
  if (!Array.isArray(raw) || !raw.length) return fallback();
  const out: SurfaceLayer[] = [];
  for (const s of raw.slice(0, MAX_SURFACES) as Partial<SurfaceLayer>[]) {
    if (!s || typeof s !== 'object') continue;
    const preview = (s.preview ?? {}) as Partial<SurfacePreview>;
    out.push({
      id: typeof s.id === 'string' ? s.id : newSurfaceId('s'),
      name: typeof s.name === 'string' ? s.name : 'Surface',
      enabled: s.enabled !== false,
      conditions: (Array.isArray(s.conditions) ? s.conditions : []).filter(c => c && INPUT_INFO[c.input]).map(c => ({
        ...newCondition(c.input), ...c,
        min: num(c.min, INPUT_INFO[c.input].defaults.min), max: num(c.max, INPUT_INFO[c.input].defaults.max),
        falloffLow: Math.max(0, num(c.falloffLow, 0)), falloffHigh: Math.max(0, num(c.falloffHigh, 0)),
        combine: COMBINES.includes(c.combine) ? c.combine : 'multiply',
        scale: c.scale && SCALES.includes(c.scale) ? c.scale : (INPUT_INFO[c.input].scaled ? 'medium' : undefined),
        invert: !!c.invert, enabled: c.enabled !== false,
      })),
      breakup: { ...DEFAULT_BREAKUP, ...(s.breakup ?? {}) },
      post: { ...DEFAULT_POST, ...(s.post ?? {}) },
      preview: {
        kind: (preview.kind ?? 'grass') as SurfaceKind,
        tint: Array.isArray(preview.tint) && preview.tint.length === 3 ? preview.tint as [number, number, number] : [1, 1, 1],
        tiling: Math.max(0.25, num(preview.tiling, 6)),
        heightBlend: Math.min(1, Math.max(0, num(preview.heightBlend, 0.4))),
      },
    });
  }
  return out.length ? out : fallback();
}

/** The parts of a surface that change the exported maps (everything but `preview`). */
export function surfaceExportKey(s: SurfaceLayer): unknown {
  const { preview: _preview, ...rest } = s;
  return rest;
}
