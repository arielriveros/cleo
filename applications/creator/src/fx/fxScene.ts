// The FX Creator's stage: what the effect is previewed IN, as opposed to the effect itself (fxParams.ts).
// Sun, sky, wind, ground and placed bodies. Preview only -- none of it reaches a bake or the export
// sidecar -- and stored on its own, so a preset or a new effect never resets the stage.

import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';

export type FxBodyKind = 'sphere' | 'box' | 'capsule' | 'wall';

/** A static body the gas flows around. World metres; the effect's box stands on the origin. */
export interface FxBody {
  id: string;
  kind: FxBodyKind;
  position: [number, number, number];
  /** Degrees around the vertical axis, then around the body's own X. */
  yaw: number;
  pitch: number;
  /** Full extents. Sphere: x is the diameter. Capsule: x the diameter, y the overall height. */
  size: [number, number, number];
  visible: boolean;
}

export interface FxScene {
  // --- Sun & sky ---
  // The sun's DIRECTION is the effect's `lightYaw` / `lightElevation`: one light shades the preview and
  // the bake. Only its strength and colour, and the sky, are the stage's.
  /** Illuminance, lux. */
  sunLux: number;
  /** Colour temperature, kelvin. */
  sunKelvin: number;
  /** Flat ambient illuminance, lux. */
  ambientLux: number;
  /** A physical sky (atmosphere + sky light) behind the effect instead of the flat backdrop. */
  sky: boolean;
  autoExposure: boolean;
  ev100: number;
  // --- Fire light ---
  /** A point light at the flame that lights the ground and bodies. */
  fireLight: boolean;
  /** Lumens at full emission. */
  fireLightLumens: number;
  /** 0..1 random brightness flicker. */
  fireLightFlicker: number;
  // --- Wind ---
  wind: boolean;
  /** Compass direction the wind blows toward, degrees counter-clockwise from +X (WindNode's convention). */
  windDirection: number;
  /** Metres per second. */
  windStrength: number;
  /** Metres between gust crests. */
  windGustScale: number;
  /** Gust travel speed, metres per second. */
  windGustSpeed: number;
  /** 0..1: how much of the wind comes and goes with the gusts. */
  windGustiness: number;
  // --- Viewport visibility (the viewport's eye menu; VIEW_KEYS) ---
  grid: boolean;
  groundPlane: boolean;
  /** The simulation region's wireframe box, drawn whenever the region is not selected. */
  showRegion: boolean;
  /** The emitter marker, drawn always rather than only while the emitter is selected. */
  showEmitter: boolean;
  /** The placed bodies' models. Hidden bodies still shape the flow. */
  showBodies: boolean;
  // --- Region ---
  /** Where the simulation region stands in the stage, metres: the centre of its floor. Preview only. */
  regionOffset: [number, number, number];
  // --- Rendering ---
  /** Temporal reconstruction: cheaper rays each frame, accumulated over frames. */
  temporal: boolean;
  /** The effect casts a shadow on the ground (a projected decal). */
  effectShadow: boolean;
  /** How dark that shadow can get, 0..1. */
  effectShadowStrength: number;
  // --- Bodies ---
  bodies: FxBody[];
}

export const DEFAULT_SCENE: FxScene = {
  sunLux: 60000, sunKelvin: 5800,
  ambientLux: 8000, sky: false, autoExposure: true, ev100: 13,
  fireLight: true, fireLightLumens: 6000, fireLightFlicker: 0.35,
  wind: false, windDirection: 0, windStrength: 1.5, windGustScale: 3, windGustSpeed: 2, windGustiness: 0.5,
  grid: true, groundPlane: true, showRegion: true, showEmitter: false, showBodies: true,
  temporal: true,
  effectShadow: true,
  effectShadowStrength: 0.85,
  regionOffset: [0, 0, 0],
  bodies: [],
};

/** What the viewport's eye menu shows and hides, rather than the Scene panel. */
export const VIEW_KEYS = ['grid', 'groundPlane', 'sky', 'effectShadow', 'showRegion', 'showEmitter', 'showBodies'] as const;

const STORAGE_KEY = 'cleo_creator_fx_scene_v1';

export function loadScene(): FxScene {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const { sunFollowsLook: _f, sunYaw: _y, sunElevation: _e, ...rest } = JSON.parse(raw);
      return { ...DEFAULT_SCENE, ...rest };
    }
  } catch { /* fall through */ }
  return DEFAULT_SCENE;
}

/**
 * A save from when the stage's sun could point its own way: that direction, to be written into the
 * effect's light once (the sun is now the effect's one light). Null when there is nothing to carry over.
 */
export function legacySunDirection(): { lightYaw: number; lightElevation: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (raw && raw.sunFollowsLook === false && Number.isFinite(raw.sunYaw) && Number.isFinite(raw.sunElevation))
      return { lightYaw: raw.sunYaw, lightElevation: raw.sunElevation };
  } catch { /* nothing to carry */ }
  return null;
}

export function saveScene(scene: FxScene): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(scene)); } catch { /* quota */ }
}

/** A new body of `kind`, placed beside or above the effect so it is visible at once. */
export function newBody(kind: FxBodyKind, domainHeight: number): FxBody {
  const id = Math.random().toString(36).slice(2, 10);
  const h = Math.max(1, domainHeight);
  switch (kind) {
    case 'sphere': return { id, kind, position: [0, h * 0.55, 0], yaw: 0, pitch: 0, size: [h * 0.18, h * 0.18, h * 0.18], visible: true };
    case 'capsule': return { id, kind, position: [h * 0.12, h * 0.5, 0], yaw: 0, pitch: 90, size: [h * 0.1, h * 0.4, h * 0.1], visible: true };
    case 'wall': return { id, kind, position: [h * 0.18, h * 0.3, 0], yaw: 0, pitch: 0, size: [0.15, h * 0.6, h * 0.6], visible: true };
    default: return { id, kind: 'box', position: [0, h * 0.6, 0], yaw: 0, pitch: 0, size: [h * 0.3, 0.2, h * 0.3], visible: true };
  }
}

/**
 * Approximate linear RGB of a black body at `kelvin` (Tanner Helland's fit, then sRGB-decoded and
 * normalised so the brightest channel is 1). Good to a few percent from 1000 K to 40000 K.
 */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const lin = (c: number) => Math.pow(Math.min(255, Math.max(0, c)) / 255, 2.2);
  const out: [number, number, number] = [lin(r), lin(g), lin(b)];
  const m = Math.max(out[0], out[1], out[2], 1e-6);
  return [out[0] / m, out[1] / m, out[2] / m];
}

/** The panel's sections. Bodies are drawn by the panel itself (a list), not from a schema. */
export const SCENE_SCHEMA: readonly { title: string; specs: GenericParamSpec[] }[] = [
  {
    title: 'Sun & sky', specs: [
      { key: 'sunLux', label: 'Sun illuminance', kind: 'float', min: 0, max: 120000, step: 500, unit: 'lx' },
      { key: 'sunKelvin', label: 'Sun temperature', kind: 'float', min: 1500, max: 12000, step: 50, unit: 'K' },
      { key: 'ambientLux', label: 'Ambient light', kind: 'float', min: 0, max: 40000, step: 100, unit: 'lx' },
      { key: 'autoExposure', label: 'Auto exposure', kind: 'bool' },
      { key: 'ev100', label: 'Exposure', kind: 'float', min: -2, max: 18, step: 0.1, unit: 'EV', when: s => !s.autoExposure },
    ],
  },
  {
    title: 'Fire light', specs: [
      { key: 'fireLight', label: 'Fire lights the scene', kind: 'bool' },
      { key: 'fireLightLumens', label: 'Brightness', kind: 'float', min: 0, max: 50000, step: 100, unit: 'lm', when: s => !!s.fireLight },
      { key: 'fireLightFlicker', label: 'Flicker', kind: 'float', min: 0, max: 1, step: 0.01, when: s => !!s.fireLight },
    ],
  },
  {
    title: 'Wind', specs: [
      { key: 'wind', label: 'Scene wind', kind: 'bool' },
      { key: 'windDirection', label: 'Direction', kind: 'float', min: -180, max: 180, step: 1, unit: '°', when: s => !!s.wind },
      { key: 'windStrength', label: 'Strength', kind: 'float', min: 0, max: 15, step: 0.1, unit: 'm/s', when: s => !!s.wind },
      { key: 'windGustiness', label: 'Gustiness', kind: 'float', min: 0, max: 1, step: 0.01, when: s => !!s.wind },
      { key: 'windGustScale', label: 'Gust size', kind: 'float', min: 0.5, max: 20, step: 0.1, unit: 'm', when: s => !!s.wind },
      { key: 'windGustSpeed', label: 'Gust speed', kind: 'float', min: 0, max: 15, step: 0.1, unit: 'm/s', when: s => !!s.wind },
    ],
  },
  {
    title: 'Rendering', specs: [
      { key: 'temporal', label: 'Temporal accumulation', kind: 'bool' },
      { key: 'effectShadowStrength', label: 'Shadow strength', kind: 'float', min: 0, max: 1, step: 0.01, when: s => !!s.effectShadow },
    ],
  },
];
