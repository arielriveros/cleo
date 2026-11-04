// FX Creator's parameters: the schema the panel draws, and the defaults and presets built from it.
// One flat record, so ParamForm can draw it and the export sidecar can store it as-is.

import type { Gradient } from 'cleo/particles/curves';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import type { Preset } from '../core/generator';

export type FxView = 'front' | 'side' | 'top' | 'angle';

/** How hard the live 3D preview works. Bakes always use the authored values. */
export type FxPreviewQuality = 'low' | 'medium' | 'high';

export type FxAdvection = 'semi-lagrangian' | 'maccormack';
export type FxPressureSolver = 'jacobi' | 'sor';
export type FxFireColorMode = 'gradient' | 'blackbody';
export type FxBoundaries = 'closed' | 'open';
/** What the effect is made of: smoke and fire on the voxel grid, or a liquid of particles. */
export type FxMedium = 'gas' | 'liquid';
/** A flipbook tile's shape: square, twice as tall as wide, or twice as wide as tall. */
export type FxTileAspect = 'square' | 'tall' | 'wide';
/** Where a liquid starts: a small ball, a ball of `sourceRadius`, a disc across the aim, a ring on the floor. */
export type FxSourceShape = 'point' | 'sphere' | 'disc' | 'ring';
/** All at once, or poured over `jetDuration`. */
export type FxSourceMode = 'burst' | 'jet';
/** The region floor: liquid lands and pools on it, sinks into it (a water surface), or falls through. */
export type FxFloorMode = 'solid' | 'absorb' | 'none';

export interface FxParams {
  /** Gas (smoke and fire, the voxel solver) or liquid (particles, liquidCpu.ts). Missing = gas. */
  medium: FxMedium;
  // --- Domain ---
  /** The simulation region: width, height and depth in metres. The box stands on its own floor. */
  regionSize: [number, number, number];
  /** Metres per voxel: the detail. The grid is the region divided by this, so cost grows with the cube. */
  voxelSize: number;
  /**
   * @deprecated Before the region box: voxels across X and Z (at 0.1 m), and height over width. Read only
   * by `normaliseFx`, which turns them into `regionSize`; never written.
   */
  resolution?: number;
  /** @deprecated See `resolution`. */
  heightRatio?: number;
  /** The parameters' format: 2 is metres (see `normaliseFx`, which reads a save without it as 1). */
  version?: number;
  // --- Emitter ---
  emitterShape: 'sphere' | 'disc';
  /**
   * Where the effect comes from, metres: the gas emitter's centre or the liquid source's. Across (x) and
   * deep (z) from the centre of the region's floor, up (y) from the floor. The region is room around it:
   * resizing the region leaves the effect where it is and as big as it is. Set with the move gizmo.
   */
  emitterPosition: [number, number, number];
  /** The gas emitter's radius, metres. Set with the scale gizmo. */
  emitterRadius: number;
  /** @deprecated Format 1: across, deep and height as fractions of the region; read only by `normaliseFx`. */
  emitterX?: number;
  /** @deprecated See `emitterX`. */
  emitterZ?: number;
  /** @deprecated See `emitterX`. */
  emitterHeight?: number;
  /** Fuel the emitter holds its volume at, per voxel. */
  fuel: number;
  /** Temperature the emitter holds its volume at (ignites the fuel above `ignition`). */
  heat: number;
  /** Smoke added per second inside the emitter, without burning. */
  smoke: number;
  /** Upward speed the emitter imposes, voxels per second. */
  emitSpeed: number;
  /** Noise velocity added inside and above the emitter, voxels per second. */
  turbulence: number;
  /** The turbulence's eddies, metres across. */
  turbulenceSize: number;
  /** @deprecated Format 1: noise features across the region; read only by `normaliseFx`. */
  turbulenceScale?: number;
  /** 0..1: turbulence also stirs cooled smoke, not only hot gas. */
  turbulenceOnSmoke: number;
  /** A second, finer turbulence octave (strength relative to the first). */
  turbulenceDetail: number;
  /** Seconds the emitter runs from the start of the simulation; 0 runs it throughout (a burst vs a flame). */
  emitDuration: number;
  /** 0..1: per-voxel, time-varying jitter of the emitted fuel, heat and speed (flicker, a ragged source). */
  emitterNoise: number;
  // --- Combustion ---
  ignition: number;
  /** Fuel burned per second once ignited. */
  burnRate: number;
  /** Temperature released per unit of fuel burned. */
  heatRelease: number;
  /** Smoke left per unit of fuel burned. */
  smokeYield: number;
  /** Gas expansion per unit of fuel burned: burning pushes outward, so a fireball blooms. */
  expansion: number;
  /** Nguyen et al. 2002: burning heats gas TOWARD this temperature instead of without limit. 0 is off. */
  maxTemperature: number;
  /** The surrounding air's temperature: buoyancy and radiative cooling are measured from it. */
  ambientTemperature: number;
  /** 0..1: how much fire is the thin burning sheet (the flame field) rather than all hot gas. */
  flameShape: number;
  /** Seconds the flame field lasts after the fuel at a point stops burning. */
  flameLifetime: number;
  /** Fuel pulses per second (0 = steady): a candle's rhythm. */
  flicker: number;
  /** A pressure pulse at the emitter for the first 0.1 s: an explosion's shock. */
  blast: number;
  // --- Forces ---
  buoyancy: number;
  /** Downward pull per unit of smoke density. */
  weight: number;
  /** Vorticity confinement strength: restores the swirls the grid smooths out. */
  vorticity: number;
  /** Sideways drift, voxels per second along +X. */
  wind: number;
  /** Block-noise velocity kicks in hot or smoky gas: breaks smooth sheets into tongues and billows. */
  disturbance: number;
  /** Disturbance block size, metres. */
  disturbanceScale: number;
  /** Seconds between disturbance re-seeds. */
  disturbanceInterval: number;
  /** Stretches gas along hot edges into thin licks and wisps. */
  shredding: number;
  /** Dust falling through the air at its own speed, m/s. */
  settling: number;
  /** Drag on the bottom voxels: makes ground-level gas spread and hug the floor. */
  groundDrag: number;
  // --- Dissipation ---
  cooling: number;
  /** Radiative cooling (proportional to T^4): short, sharp, ragged flame tips. */
  coolingT4: number;
  /** Smoke and heat spreading into the air around them. */
  diffusion: number;
  /** Visible vapour condenses below the dew point and evaporates above it (steam). 0 is off. */
  condensation: number;
  /** The temperature below which vapour becomes visible. */
  dewPoint: number;
  smokeDissipation: number;
  velocityDamping: number;
  // --- Simulation ---
  /** Simulation seconds per flipbook frame. */
  frameTime: number;
  substeps: number;
  pressureIterations: number;
  /** How the fields are carried by the flow: plain semi-Lagrangian, or MacCormack (sharper detail). */
  advection: FxAdvection;
  /** Jacobi, or warm-started red-black SOR (converges in far fewer iterations). */
  pressureSolver: FxPressureSolver;
  /** Closed: walls on the sides. Open: gas leaves through the sides and top as in open air. */
  boundaries: FxBoundaries;
  /** Frames simulated before the first captured one, so the flame is established. */
  warmup: number;
  // --- Flipbook ---
  frames: number;
  /** Pixels along the tile's SHORT side; `tileAspect` doubles the other for a tall or wide tile. */
  tileSize: number;
  tileAspect: FxTileAspect;
  view: FxView;
  /** Camera yaw for the `angle` view, degrees around the vertical axis. */
  yaw: number;
  /** Frames at the end cross-faded into the start so the cycle loops; 0 for no loop. */
  loopBlend: number;
  /**
   * 0..0.25: the share of the tile at each edge over which coverage fades to nothing, so an effect that
   * reaches its region's edge never shows the frame's border as a hard line on a sprite.
   */
  edgeFade: number;
  /** Also bake six-way lightmaps: the smoke lit from right, top, back, left, bottom and front. */
  bakeSixWay: boolean;
  /** Also bake motion vectors, for flipbook frame blending that morphs instead of cross-fading. */
  bakeMotion: boolean;
  /** Also bake the fire's emission alone, for additive particles. */
  bakeEmission: boolean;
  /** Motion-vector encoding: tile widths per frame at full scale (R/G = 0.5 + motion x scale). */
  motionScale: number;
  // --- Look ---
  smokeColor: [number, number, number, number];
  /** Extinction per unit smoke density per voxel. */
  absorption: number;
  /** Fire colour by temperature (0 at ignition, 1 at `emissionRange` above it). */
  fireGradient: Gradient;
  /** Where the fire's colour comes from: the gradient, or black-body radiation between two temperatures. */
  fireColorMode: FxFireColorMode;
  /** Black-body temperatures (kelvin) at ignition and at the top of the emission range. */
  blackbodyMin: number;
  blackbodyMax: number;
  emission: number;
  emissionRange: number;
  /** Light direction (from the light toward the volume): yaw and elevation, degrees. */
  lightYaw: number;
  lightElevation: number;
  ambient: number;
  /** Henyey-Greenstein anisotropy: > 0 scatters forward (bright rims against the light), < 0 back. */
  anisotropy: number;
  /** Multiple-scattering octaves (1 = single scattering). More lightens the core of thick smoke. */
  scatterOctaves: number;
  /** How much the fire lights the smoke around it. */
  fireGlow: number;
  /** Sub-voxel detail: procedural noise eroding the density at render time. */
  detailStrength: number;
  /** Detail noise features per 10 voxels. */
  detailScale: number;
  /** Scattering albedo: 1 bright steam, low values dark soot that absorbs more than it scatters. */
  albedo: number;
  /** Dark edges on dense smoke facing the light (Beer-Powder). */
  powder: number;
  /** How much the smoke above shades the sky light below: darker plume undersides. */
  skyOcclusion: number;
  /** Fire brightness relative to the smoke: above 1 drives bloom in the viewport. */
  fireIntensity: number;
  /** How much the fire hides what is behind it. Real flames are nearly transparent (about 0.05). */
  fireOpacity: number;
  /** A thin blue emission at the reaction zone where fuel first ignites (Nguyen et al. 2002). */
  blueCore: number;
  blueCoreColor: [number, number, number, number];
  /** Per-channel smoke extinction tint: below white, thin smoke turns warm brown, thick smoke dark. */
  absorptionColor: [number, number, number, number];
  /** Fire seen through smoke is dimmed by it: glow shows through the gaps. */
  fireSootMask: number;
  /** 0..1 of the emission range: only fire hotter than this lights the smoke around it. */
  glowThreshold: number;
  /** Tricubic (B-spline) sampling of the voxels: smooth, unblocky gas. */
  smoothSampling: boolean;
  /** Density contrast: denser cores, crisper edges. */
  sharpen: number;
  seed: number;
  // --- Splash source (liquid) ---
  sourceShape: FxSourceShape;
  /** Metres: the ball's or disc's radius, the ring's radius. */
  sourceRadius: number;
  /** @deprecated Format 1: metres above the floor, now `emitterPosition[1]`; read only by `normaliseFx`. */
  sourceHeight?: number;
  /** Litres released in all. */
  sourceVolume: number;
  sourceMode: FxSourceMode;
  /** Seconds a jet pours for; 0 pours throughout (a looping stream). */
  jetDuration: number;
  /** m/s, slowest to fastest. */
  sourceSpeed: [number, number];
  /** The aim: degrees around the vertical from +Z toward +X, and up from the horizontal. */
  sourceYaw: number;
  sourcePitch: number;
  /** Degrees off the aim a drop may leave at; 180 sprays every way. */
  sourceSpread: number;
  /** 0..1: coherent noise on the release velocity, so a sheet tears into fingers and drops. */
  sourceBreakup: number;
  /** Ring only, 0..1: the share released straight up from the ring's centre (the Worthington jet). */
  ringCore: number;
  // --- Liquid ---
  /** Metres between particles at rest: the liquid's detail. Cost grows with (volume / size^3). */
  dropletSize: number;
  /** 0..1: thick liquids hold together and smear; 0 is water. */
  viscosity: number;
  /** 0..1: how hard the liquid pulls into drops and threads. */
  surfaceTension: number;
  /** 0..1: the share of drops that stick where they first land instead of bouncing. */
  stickiness: number;
  /** m/s^2 downward. */
  gravity: number;
  /** Per second: air slowing the drops. */
  airDrag: number;
  /** Density relaxation passes per step: more is less compressible. */
  liquidIterations: number;
  // --- Floor (liquid) ---
  floorMode: FxFloorMode;
  /** 0..1: how much of a drop's speed into the floor it keeps on a bounce. */
  floorBounce: number;
  /** 0..1: how much of a drop's speed along the floor a bounce takes away. */
  floorFriction: number;
  /** 0..1: how far the liquid on the floor flows out before it stops. */
  flow: number;
  /** Millimetres: a film edge thinner than this holds where it is (contact-line pinning). */
  pinning: number;
  /** 0..1: how much the edge hold varies across the floor: ragged pool edges. */
  edgeNoise: number;
  /** Per second: the share of the wet film the floor soaks up into a matte stain. */
  soak: number;
  // --- Liquid look ---
  /** What the liquid scatters (its body colour). */
  liquidColor: [number, number, number, number];
  /** The colour light keeps after one absorption length (1 / `liquidAbsorption`) of liquid. */
  liquidTint: [number, number, number, number];
  /** Per metre: how quickly the liquid takes the light passing through it. Blood ~150, water ~2. */
  liquidAbsorption: number;
  /** Surface roughness: 0 a mirror, the GGX alpha's square root. */
  liquidRoughness: number;
  /**
   * 0..1: a metal (mercury, molten metal). A metal is opaque and has no body colour of its own: its
   * colour tints what it reflects, the sun's highlight and the sky.
   */
  liquidMetallic: number;
  /** Strength of the sun's highlight and the sky's reflection. */
  specular: number;
  /** 0..1: fast-moving liquid turns white (aerated spray, whitewater). */
  foam: number;
  /** The surface's smoothing radius in droplet sizes: blobby above 2, beaded below 1.5. */
  surfaceSmoothing: number;
  // --- Outputs (liquid) ---
  /** Also bake the liquid that reaches the floor, seen from above, as a decal flipbook. */
  bakeDecal: boolean;
  /** Most pixels a side of a decal frame: it is drawn at the film's own cells (half a droplet) over where the liquid lies, coarsened only past this. */
  decalTileSize: number;
  decalFrames: number;
  /** Seconds the floor keeps flowing after the last captured sprite frame. */
  decalSettle: number;
  /** Normal-map strength of the decal's film relief. */
  decalNormalStrength: number;
  /**
   * Also bake the sprite's surface for a lit particle: base colour (unlit), a tangent-space normal map and
   * an ORM map (roughness, metallic), so the engine lights it with the scene's own lights.
   */
  bakeSurfaceMaps: boolean;
  // --- Preview ---
  previewQuality: FxPreviewQuality;
}

export const FIRE_GRADIENT: Gradient = {
  color: [
    { t: 0, c: [0.35, 0.03, 0.0] },
    { t: 0.35, c: [0.95, 0.25, 0.02] },
    { t: 0.7, c: [1.0, 0.65, 0.15] },
    { t: 1, c: [1.0, 0.95, 0.75] },
  ],
  alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }],
};

/**
 * Every liquid parameter's default, also what a gas effect carries for them. A liquid effect is
 * `medium: 'liquid'` plus these, re-tuned: a blood splash by default.
 */
export const LIQUID_DEFAULTS = {
  medium: 'gas' as FxMedium,
  sourceShape: 'point' as FxSourceShape, sourceRadius: 0.04, sourceVolume: 0.12, sourceMode: 'burst' as FxSourceMode,
  jetDuration: 0.12, sourceSpeed: [1.5, 3.5] as [number, number], sourceYaw: 0, sourcePitch: 20, sourceSpread: 35, sourceBreakup: 0.4, ringCore: 0.2,
  dropletSize: 0.008, viscosity: 0.15, surfaceTension: 0.5, stickiness: 0.6, gravity: 9.81, airDrag: 0.3, liquidIterations: 2,
  floorMode: 'solid' as FxFloorMode, floorBounce: 0.15, floorFriction: 0.5, flow: 0.4, pinning: 1.2, edgeNoise: 0.5, soak: 0.02,
  liquidColor: [0.42, 0.03, 0.03, 1] as [number, number, number, number], liquidTint: [0.55, 0.04, 0.04, 1] as [number, number, number, number],
  liquidAbsorption: 150, liquidRoughness: 0.12, liquidMetallic: 0, specular: 1, foam: 0, surfaceSmoothing: 2,
  bakeDecal: true, decalTileSize: 512, decalFrames: 16, decalSettle: 1.2, decalNormalStrength: 1, bakeSurfaceMaps: false,
};

export const DEFAULT_FX: FxParams = {
  version: 2,
  regionSize: [4.8, 7.2, 4.8], voxelSize: 0.1, emitterPosition: [0, 0.76, 0],
  emitterShape: 'sphere', emitterRadius: 0.576,
  fuel: 1.2, heat: 1.2, smoke: 0.2, emitSpeed: 6, turbulence: 8, turbulenceSize: 1.2, emitDuration: 0, emitterNoise: 0, turbulenceOnSmoke: 0, turbulenceDetail: 0,
  ignition: 0.25, burnRate: 1.6, heatRelease: 1.4, smokeYield: 0.6, expansion: 0, maxTemperature: 0, ambientTemperature: 0, flameShape: 0, flameLifetime: 0.25, flicker: 0, blast: 0,
  buoyancy: 14, weight: 1.5, vorticity: 0.35, wind: 0,
  disturbance: 0, disturbanceScale: 0.3, disturbanceInterval: 0.25, shredding: 0, settling: 0, groundDrag: 0,
  cooling: 1.1, smokeDissipation: 0.25, velocityDamping: 0.05, coolingT4: 0, diffusion: 0, condensation: 0, dewPoint: 0.35,
  frameTime: 1 / 24, substeps: 2, pressureIterations: 30, warmup: 24, advection: 'semi-lagrangian', pressureSolver: 'jacobi', boundaries: 'closed',
  frames: 32, tileSize: 128, tileAspect: 'square', view: 'front', yaw: 30, loopBlend: 8, edgeFade: 0,
  smokeColor: [0.32, 0.31, 0.3, 1], absorption: 2.2, fireGradient: FIRE_GRADIENT, emission: 2.2, emissionRange: 1.2,
  fireColorMode: 'gradient', blackbodyMin: 900, blackbodyMax: 2200,
  lightYaw: 35, lightElevation: 50, ambient: 0.35,
  anisotropy: 0, scatterOctaves: 1, fireGlow: 0, detailStrength: 0, detailScale: 6,
  albedo: 1, powder: 0, skyOcclusion: 0, fireIntensity: 1,
  fireOpacity: 0.6, blueCore: 0, blueCoreColor: [0.3, 0.45, 1, 1], absorptionColor: [1, 1, 1, 1], fireSootMask: 0, glowThreshold: 0,
  smoothSampling: false, sharpen: 0,
  bakeSixWay: false, bakeMotion: false, bakeEmission: false, motionScale: 4,
  seed: 1,
  ...LIQUID_DEFAULTS,
  previewQuality: 'medium',
};

const views = [
  { value: 'front', label: 'Front' }, { value: 'side', label: 'Side' }, { value: 'top', label: 'Top' }, { value: 'angle', label: 'Angle (yaw)' },
];

const isLiquid = (p: Record<string, unknown>) => p.medium === 'liquid';
const isGas = (p: Record<string, unknown>) => p.medium !== 'liquid';

/** One section of the panel. `medium` limits it to gas or liquid effects; `side: 'bake'` puts it in the Bake tab. */
/**
 * A parameter field. `gizmo`: set in the viewport (a gizmo moves, turns or scales it), so the panels draw
 * no field for it -- it stays in the schema for the docs and the presets' key contracts.
 */
export type FxSpec = GenericParamSpec & { gizmo?: boolean };

export interface FxSchemaGroup { title: string; specs: FxSpec[]; side?: 'bake'; medium?: FxMedium }

/** Grouped so the panel can show one section per group. */
export const FX_SCHEMA: readonly FxSchemaGroup[] = [
  {
    title: 'Domain', specs: [
      { key: 'medium', label: 'Medium', kind: 'enum', options: [{ value: 'gas', label: 'Gas (smoke and fire)' }, { value: 'liquid', label: 'Liquid' }] },
      // A liquid's voxels follow its droplets (`liquidVoxelSize`).
      { key: 'voxelSize', label: 'Voxel size', kind: 'float', min: 0.001, max: 0.5, step: 0.001, unit: 'm', when: isGas },
    ],
  },
  {
    title: 'Splash source', medium: 'liquid', specs: [
      { key: 'sourceShape', label: 'Source shape', kind: 'enum', options: [
        { value: 'point', label: 'Point' }, { value: 'sphere', label: 'Ball' }, { value: 'disc', label: 'Disc (nozzle)' }, { value: 'ring', label: 'Ring (crown)' },
      ] },
      { key: 'sourceRadius', label: 'Source radius', kind: 'float', min: 0.005, max: 1, step: 0.005, unit: 'm', when: p => p.sourceShape !== 'point', gizmo: true },
      { key: 'emitterPosition', label: 'Source position', kind: 'vec3', unit: 'm', gizmo: true },
      { key: 'sourceVolume', label: 'Volume', kind: 'float', min: 0.001, max: 20, step: 0.005, unit: 'L' },
      { key: 'sourceMode', label: 'Release', kind: 'enum', options: [{ value: 'burst', label: 'Burst (all at once)' }, { value: 'jet', label: 'Jet (poured)' }] },
      { key: 'jetDuration', label: 'Jet duration', kind: 'float', min: 0, max: 5, step: 0.01, unit: 's', when: p => p.sourceMode === 'jet' },
      { key: 'sourceSpeed', label: 'Source speed', kind: 'range', min: 0, max: 20, step: 0.1, unit: 'm/s' },
      { key: 'sourceYaw', label: 'Aim yaw', kind: 'float', min: -180, max: 180, step: 1, unit: '°', when: p => p.sourceShape !== 'ring', gizmo: true },
      { key: 'sourcePitch', label: 'Aim pitch', kind: 'float', min: -90, max: 90, step: 1, unit: '°', gizmo: true },
      { key: 'sourceSpread', label: 'Spray angle', kind: 'float', min: 0, max: 180, step: 1, unit: '°' },
      { key: 'sourceBreakup', label: 'Break-up', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'ringCore', label: 'Crown core', kind: 'float', min: 0, max: 1, step: 0.01, when: p => p.sourceShape === 'ring' },
    ],
  },
  {
    title: 'Liquid', medium: 'liquid', specs: [
      { key: 'dropletSize', label: 'Droplet size', kind: 'float', min: 0.001, max: 0.05, step: 0.0005, unit: 'm' },
      { key: 'viscosity', label: 'Viscosity', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'surfaceTension', label: 'Surface tension', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'stickiness', label: 'Stickiness', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'gravity', label: 'Gravity', kind: 'float', min: 0, max: 30, step: 0.05, unit: 'm/s²' },
      { key: 'airDrag', label: 'Air drag', kind: 'float', min: 0, max: 10, step: 0.05 },
      { key: 'liquidIterations', label: 'Relaxation passes', kind: 'int', min: 1, max: 8 },
    ],
  },
  {
    title: 'Floor', medium: 'liquid', specs: [
      { key: 'floorMode', label: 'Floor', kind: 'enum', options: [
        { value: 'solid', label: 'Solid (pools)' }, { value: 'absorb', label: 'Water surface (sinks in)' }, { value: 'none', label: 'None (falls through)' },
      ] },
      { key: 'floorBounce', label: 'Bounce', kind: 'float', min: 0, max: 1, step: 0.01, when: p => p.floorMode === 'solid' },
      { key: 'floorFriction', label: 'Friction', kind: 'float', min: 0, max: 1, step: 0.01, when: p => p.floorMode === 'solid' },
      { key: 'flow', label: 'Flow', kind: 'float', min: 0, max: 1, step: 0.01, when: p => p.floorMode === 'solid' },
      { key: 'pinning', label: 'Edge hold', kind: 'float', min: 0, max: 6, step: 0.05, unit: 'mm', when: p => p.floorMode === 'solid' },
      { key: 'edgeNoise', label: 'Edge noise', kind: 'float', min: 0, max: 1, step: 0.01, when: p => p.floorMode === 'solid' },
      { key: 'soak', label: 'Soak', kind: 'float', min: 0, max: 2, step: 0.01, unit: '/s', when: p => p.floorMode === 'solid' },
    ],
  },
  {
    title: 'Liquid look', medium: 'liquid', specs: [
      { key: 'liquidColor', label: 'Liquid colour', kind: 'color' },
      { key: 'liquidTint', label: 'Tint', kind: 'color' },
      { key: 'liquidAbsorption', label: 'Absorption', kind: 'float', min: 0, max: 2000, step: 0.5, unit: '/m' },
      { key: 'liquidRoughness', label: 'Roughness', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'liquidMetallic', label: 'Metallic', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'specular', label: 'Specular', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'foam', label: 'Foam', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'surfaceSmoothing', label: 'Smoothing', kind: 'float', min: 1, max: 4, step: 0.05 },
    ],
  },
  {
    title: 'Emitter', medium: 'gas', specs: [
      { key: 'emitterShape', label: 'Shape', kind: 'enum', options: [{ value: 'sphere', label: 'Sphere' }, { value: 'disc', label: 'Disc' }] },
      { key: 'emitterRadius', label: 'Radius', kind: 'float', min: 0.01, max: 10, step: 0.01, unit: 'm', gizmo: true },
      { key: 'emitterPosition', label: 'Position', kind: 'vec3', unit: 'm', gizmo: true },
      { key: 'fuel', label: 'Fuel', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'heat', label: 'Heat', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'smoke', label: 'Smoke', kind: 'float', min: 0, max: 4, step: 0.05, hint: 'Smoke emitted directly, before any burning.' },
      { key: 'emitSpeed', label: 'Speed', kind: 'float', min: 0, max: 40, step: 0.5, unit: 'vox/s' },
      { key: 'turbulence', label: 'Turbulence', kind: 'float', min: 0, max: 40, step: 0.5 },
      { key: 'turbulenceSize', label: 'Turbulence size', kind: 'float', min: 0.02, max: 10, step: 0.01, unit: 'm' },
      { key: 'turbulenceOnSmoke', label: 'Turbulence on smoke', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'turbulenceDetail', label: 'Turbulence detail', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'emitDuration', label: 'Duration', kind: 'float', min: 0, max: 10, step: 0.05, unit: 's', hint: 'How long the emitter runs. 0 keeps it on (a flame); a short burst makes an explosion.' },
      { key: 'emitterNoise', label: 'Noise', kind: 'float', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: 'Combustion', medium: 'gas', specs: [
      { key: 'ignition', label: 'Ignition', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'burnRate', label: 'Burn rate', kind: 'float', min: 0, max: 8, step: 0.05 },
      { key: 'heatRelease', label: 'Heat release', kind: 'float', min: 0, max: 6, step: 0.05 },
      { key: 'smokeYield', label: 'Smoke yield', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'expansion', label: 'Expansion', kind: 'float', min: 0, max: 20, step: 0.1 },
      { key: 'maxTemperature', label: 'Max temperature', kind: 'float', min: 0, max: 6, step: 0.05 },
      { key: 'ambientTemperature', label: 'Ambient temperature', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'flameShape', label: 'Flame shape', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'flameLifetime', label: 'Flame lifetime', kind: 'float', min: 0.02, max: 2, step: 0.01, unit: 's', when: p => Number(p.flameShape) > 0 },
      { key: 'flicker', label: 'Flicker', kind: 'float', min: 0, max: 12, step: 0.1, unit: 'Hz' },
      { key: 'blast', label: 'Blast', kind: 'float', min: 0, max: 60, step: 0.5 },
    ],
  },
  {
    title: 'Forces', medium: 'gas', specs: [
      { key: 'buoyancy', label: 'Buoyancy', kind: 'float', min: 0, max: 60, step: 0.5 },
      { key: 'weight', label: 'Smoke weight', kind: 'float', min: 0, max: 20, step: 0.1 },
      { key: 'vorticity', label: 'Vorticity', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'wind', label: 'Wind', kind: 'float', min: -20, max: 20, step: 0.25, unit: 'vox/s' },
      { key: 'disturbance', label: 'Disturbance', kind: 'float', min: 0, max: 40, step: 0.5 },
      { key: 'disturbanceScale', label: 'Disturbance size', kind: 'float', min: 0.02, max: 3, step: 0.01, unit: 'm', when: p => Number(p.disturbance) > 0 },
      { key: 'disturbanceInterval', label: 'Disturbance interval', kind: 'float', min: 0.02, max: 2, step: 0.01, unit: 's', when: p => Number(p.disturbance) > 0 },
      { key: 'shredding', label: 'Shredding', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'settling', label: 'Settling', kind: 'float', min: 0, max: 3, step: 0.01, unit: 'm/s' },
      { key: 'groundDrag', label: 'Ground drag', kind: 'float', min: 0, max: 10, step: 0.1 },
    ],
  },
  {
    title: 'Dissipation', medium: 'gas', specs: [
      { key: 'cooling', label: 'Cooling', kind: 'float', min: 0, max: 6, step: 0.05 },
      { key: 'smokeDissipation', label: 'Smoke fade', kind: 'float', min: 0, max: 4, step: 0.01 },
      { key: 'velocityDamping', label: 'Velocity damping', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'coolingT4', label: 'Radiative cooling', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'diffusion', label: 'Diffusion', kind: 'float', min: 0, max: 0.15, step: 0.005 },
      { key: 'condensation', label: 'Condensation', kind: 'float', min: 0, max: 20, step: 0.1 },
      { key: 'dewPoint', label: 'Dew point', kind: 'float', min: 0.02, max: 2, step: 0.01, when: p => Number(p.condensation) > 0 },
    ],
  },
  {
    title: 'Simulation', specs: [
      { key: 'frameTime', label: 'Frame time', kind: 'float', min: 1 / 120, max: 0.25, step: 0.001, unit: 's' },
      { key: 'substeps', label: 'Substeps', kind: 'int', min: 1, max: 8 },
      { key: 'pressureIterations', label: 'Pressure iterations', kind: 'int', min: 4, max: 120, when: isGas },
      { key: 'pressureSolver', label: 'Pressure solver', kind: 'enum', options: [{ value: 'jacobi', label: 'Jacobi' }, { value: 'sor', label: 'Red-black SOR' }], when: isGas },
      { key: 'boundaries', label: 'Boundaries', kind: 'enum', options: [{ value: 'closed', label: 'Closed walls' }, { value: 'open', label: 'Open air' }], when: isGas },
      { key: 'advection', label: 'Advection', kind: 'enum', options: [{ value: 'semi-lagrangian', label: 'Semi-Lagrangian' }, { value: 'maccormack', label: 'MacCormack (sharper)' }], when: isGas },
      { key: 'seed', label: 'Seed', kind: 'int', min: 0 },
    ],
  },
  {
    title: 'Flipbook', side: 'bake', specs: [
      { key: 'warmup', label: 'Warm-up frames', kind: 'int', min: 0, max: 240 },
      { key: 'frames', label: 'Frames', kind: 'int', min: 1, max: 256 },
      { key: 'tileSize', label: 'Tile size', kind: 'enum', options: ['64', '128', '256', '512'].map(v => ({ value: v, label: `${v} px` })) },
      { key: 'tileAspect', label: 'Tile shape', kind: 'enum', options: [
        { value: 'square', label: 'Square' }, { value: 'tall', label: 'Tall (1:2)' }, { value: 'wide', label: 'Wide (2:1)' },
      ] },
      { key: 'view', label: 'View', kind: 'enum', options: views },
      { key: 'yaw', label: 'Yaw', kind: 'float', min: -180, max: 180, step: 1, unit: '°', when: p => p.view === 'angle' },
      { key: 'loopBlend', label: 'Loop blend', kind: 'int', min: 0, max: 64, hint: 'Frames cross-faded into the start so the flipbook loops seamlessly. 0 plays once.' },
      { key: 'edgeFade', label: 'Edge fade', kind: 'float', min: 0, max: 0.25, step: 0.01 },
    ],
  },
  {
    title: 'Outputs', side: 'bake', specs: [
      { key: 'bakeSixWay', label: 'Six-way lightmaps', kind: 'bool', when: isGas },
      { key: 'bakeMotion', label: 'Motion vectors', kind: 'bool' },
      { key: 'motionScale', label: 'Motion scale', kind: 'float', min: 0.5, max: 32, step: 0.5, when: p => !!p.bakeMotion },
      { key: 'bakeEmission', label: 'Emission only', kind: 'bool', when: isGas },
      { key: 'bakeSurfaceMaps', label: 'Surface maps', kind: 'bool', when: isLiquid },
      { key: 'bakeDecal', label: 'Floor decal', kind: 'bool', when: p => isLiquid(p) && p.floorMode === 'solid' },
      { key: 'decalTileSize', label: 'Decal max size', kind: 'enum', options: ['64', '128', '256', '512', '1024'].map(v => ({ value: v, label: `${v} px` })), when: p => isLiquid(p) && !!p.bakeDecal && p.floorMode === 'solid' },
      { key: 'decalFrames', label: 'Decal frames', kind: 'int', min: 1, max: 64, when: p => isLiquid(p) && !!p.bakeDecal && p.floorMode === 'solid' },
      { key: 'decalSettle', label: 'Settle time', kind: 'float', min: 0, max: 10, step: 0.05, unit: 's', when: p => isLiquid(p) && !!p.bakeDecal && p.floorMode === 'solid' },
      { key: 'decalNormalStrength', label: 'Decal relief', kind: 'float', min: 0, max: 4, step: 0.05, when: p => isLiquid(p) && !!p.bakeDecal && p.floorMode === 'solid' },
    ],
  },
  {
    title: 'Look', medium: 'gas', specs: [
      { key: 'smokeColor', label: 'Smoke colour', kind: 'color' },
      { key: 'absorption', label: 'Density', kind: 'float', min: 0, max: 12, step: 0.05 },
      { key: 'fireColorMode', label: 'Fire colour from', kind: 'enum', options: [{ value: 'gradient', label: 'Gradient' }, { value: 'blackbody', label: 'Black body' }] },
      { key: 'fireGradient', label: 'Fire colour', kind: 'gradient', when: p => p.fireColorMode !== 'blackbody' },
      { key: 'blackbodyMin', label: 'Coolest flame', kind: 'float', min: 500, max: 4000, step: 10, unit: 'K', when: p => p.fireColorMode === 'blackbody' },
      { key: 'blackbodyMax', label: 'Hottest flame', kind: 'float', min: 800, max: 6000, step: 10, unit: 'K', when: p => p.fireColorMode === 'blackbody' },
      { key: 'emission', label: 'Emission', kind: 'float', min: 0, max: 10, step: 0.05 },
      { key: 'emissionRange', label: 'Emission range', kind: 'float', min: 0.1, max: 6, step: 0.05 },
      { key: 'ambient', label: 'Ambient', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'anisotropy', label: 'Anisotropy', kind: 'float', min: -0.9, max: 0.9, step: 0.01 },
      { key: 'scatterOctaves', label: 'Scattering octaves', kind: 'int', min: 1, max: 3 },
      { key: 'fireGlow', label: 'Fire glow', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'fireIntensity', label: 'Fire intensity', kind: 'float', min: 0.2, max: 32, step: 0.1 },
      { key: 'fireOpacity', label: 'Flame opacity', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'blueCore', label: 'Blue core', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'blueCoreColor', label: 'Blue core colour', kind: 'color', when: p => Number(p.blueCore) > 0 },
      { key: 'fireSootMask', label: 'Soot mask', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'glowThreshold', label: 'Glow threshold', kind: 'float', min: 0, max: 0.95, step: 0.01, when: p => Number(p.fireGlow) > 0 },
      { key: 'albedo', label: 'Albedo', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'absorptionColor', label: 'Absorption colour', kind: 'color' },
      { key: 'smoothSampling', label: 'Smooth sampling', kind: 'bool' },
      { key: 'sharpen', label: 'Sharpen', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'powder', label: 'Powder', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'skyOcclusion', label: 'Sky occlusion', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'detailStrength', label: 'Detail', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'detailScale', label: 'Detail scale', kind: 'float', min: 1, max: 20, step: 0.1, when: p => Number(p.detailStrength) > 0 },
    ],
  },
];

/** The groups an effect of `medium` shows on `side` (the Parameters tab, or the Bake tab). */
export function schemaGroupsFor(medium: FxMedium | undefined, side: 'parameters' | 'bake'): FxSchemaGroup[] {
  const m = medium === 'liquid' ? 'liquid' : 'gas';
  return FX_SCHEMA.filter(g => (side === 'bake') === (g.side === 'bake') && (!g.medium || g.medium === m))
    .map(g => ({ ...g, specs: g.specs.filter(s => !s.gizmo) }));
}

/**
 * The effect values that belong to the scene's composition, drawn in the LEFT (Scene) panel by section:
 * the region's size, the sun's direction (the one light the preview AND the bake are shaded with), and
 * the preview's quality. Stored with the effect -- the bake needs the first two -- but edited with the stage.
 */
export const FX_SCENE_SPECS: Record<'Region' | 'Sun & sky' | 'Rendering', FxSpec[]> = {
  // The region's face handles resize it, its move gizmo places it.
  Region: [
    { key: 'regionSize', label: 'Region size', kind: 'vec3', unit: 'm', gizmo: true },
  ],
  'Sun & sky': [
    { key: 'lightYaw', label: 'Sun yaw', kind: 'float', min: -180, max: 180, step: 1, unit: '°' },
    { key: 'lightElevation', label: 'Sun elevation', kind: 'float', min: -10, max: 90, step: 1, unit: '°' },
  ],
  Rendering: [
    { key: 'previewQuality', label: 'Quality', kind: 'enum', options: [
      { value: 'low', label: 'Low (fastest)' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
    ] },
  ],
};

/** Above this many voxels the voxel size is raised to fit: the grid's memory and step cost run away. */
export const MAX_VOXELS = 2_500_000;
/** Smallest region side, metres. */
export const MIN_REGION = 0.05;

/**
 * The parameters every consumer reads: `tileSize` is drawn as an enum (a string) and stored as a number;
 * a pre-region save (`resolution` / `heightRatio`) becomes the region it described; and the voxel size is
 * raised when the region would need more than {@link MAX_VOXELS}.
 */
export function normaliseFx(raw: FxParams): FxParams {
  // Every liquid key a save from before liquids lacks takes its default: such a save is a gas effect.
  const p: FxParams = { ...LIQUID_DEFAULTS, ...raw, tileSize: Number(raw.tileSize) || 128 };
  p.medium = raw.medium === 'liquid' ? 'liquid' : 'gas';
  p.tileAspect = raw.tileAspect === 'tall' || raw.tileAspect === 'wide' ? raw.tileAspect : 'square';
  p.decalTileSize = Number(raw.decalTileSize) || LIQUID_DEFAULTS.decalTileSize;
  if (!Array.isArray(p.sourceSpeed) || p.sourceSpeed.length < 2) p.sourceSpeed = [...LIQUID_DEFAULTS.sourceSpeed];
  if (raw.resolution !== undefined || raw.heightRatio !== undefined) {
    const n = Math.max(8, Math.round(raw.resolution ?? 48));
    p.voxelSize = 0.1;
    p.regionSize = [n * 0.1, n * 0.1 * (raw.heightRatio ?? 1.5), n * 0.1];
    delete p.resolution;
    delete p.heightRatio;
  }
  const size = (Array.isArray(p.regionSize) ? p.regionSize : DEFAULT_FX.regionSize).map(v => Math.max(MIN_REGION, Number(v) || MIN_REGION)) as [number, number, number];
  p.regionSize = size;
  p.voxelSize = fitVoxelSize(size, Number(p.voxelSize) || 0.1);
  if ((Number(raw.version) || 1) < 2) toMetres(p, raw);
  p.version = 2;
  // The emitter stays inside its region.
  const e = Array.isArray(p.emitterPosition) ? p.emitterPosition : DEFAULT_FX.emitterPosition;
  const inside = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : 0));
  p.emitterPosition = [inside(e[0], -size[0] / 2, size[0] / 2), inside(e[1], 0, size[1]), inside(e[2], -size[2] / 2, size[2] / 2)];
  p.emitterRadius = Math.max(0.005, Number(p.emitterRadius) || DEFAULT_FX.emitterRadius);
  p.turbulenceSize = Math.max(0.01, Number(p.turbulenceSize) || DEFAULT_FX.turbulenceSize);
  p.dropletSize = fitDropletSize(p, Math.max(0.0005, Number(p.dropletSize) || LIQUID_DEFAULTS.dropletSize));
  return p;
}

/**
 * Format 1 -> 2: where the effect comes from, how big its emitter is and how big its eddies are, from
 * fractions of the region (which made a bigger region a bigger effect) to the metres they meant in it --
 * exactly the voxels the format-1 solver placed them on. The format-1 keys go.
 */
function toMetres(p: FxParams, raw: FxParams): void {
  const r = p.regionSize, v = p.voxelSize;
  const n = r.map(s => Math.max(8, Math.round(s / v)));
  const fx = clamp01(raw.emitterX ?? 0.5), fz = clamp01(raw.emitterZ ?? 0.5);
  // The gas emitter's: its centre on the format-1 grid's voxel centres, its radius in voxels.
  p.emitterRadius = Math.max(1, (raw.emitterRadius ?? 0.12) * n[0]) * v;
  p.turbulenceSize = (n[0] * v) / Math.max(0.01, raw.turbulenceScale ?? 4);
  p.emitterPosition = p.medium === 'liquid'
    // A liquid's source: fractions of the region in metres, its height as it was.
    ? [fx * r[0] - r[0] / 2, Math.min(r[1], Math.max(0, raw.sourceHeight ?? 1)), fz * r[2] - r[2] / 2]
    : [(fx * (n[0] - 1) + 0.5) * v - (n[0] * v) / 2, ((raw.emitterHeight ?? 0.1) * (n[1] - 1) + 0.5) * v, (fz * (n[2] - 1) + 0.5) * v - (n[2] * v) / 2];
  delete p.emitterX; delete p.emitterZ; delete p.emitterHeight; delete p.turbulenceScale; delete p.sourceHeight;
}

/** A liquid's voxels, metres: from its droplets, so its detail follows them rather than the region. */
export function liquidVoxelSize(p: Pick<FxParams, 'dropletSize'>): number {
  return p.dropletSize * 0.75;
}

/** A tile's pixel width and height: `tileSize` on the short side, doubled on the long one for a tall or wide tile. */
export function tileDims(p: Pick<FxParams, 'tileSize' | 'tileAspect'>): { width: number; height: number } {
  const s = Number(p.tileSize) || 128;
  return p.tileAspect === 'tall' ? { width: s, height: s * 2 } : p.tileAspect === 'wide' ? { width: s * 2, height: s } : { width: s, height: s };
}

/** Above this many particles the droplet size is raised to fit (the liquid's cost and memory). */
export const MAX_PARTICLES = 60_000;

/** The droplets a liquid releases: its volume over one droplet's cube. */
export function particleCount(p: Pick<FxParams, 'sourceVolume' | 'dropletSize'>): number {
  return Math.max(1, Math.round((Math.max(0, p.sourceVolume) / 1000) / Math.pow(p.dropletSize, 3)));
}

/** `size`, raised just enough that the liquid's volume fits in {@link MAX_PARTICLES}. */
function fitDropletSize(p: Pick<FxParams, 'sourceVolume'>, size: number): number {
  const count = (Math.max(0, p.sourceVolume) / 1000) / Math.pow(size, 3);
  return count > MAX_PARTICLES ? size * Math.cbrt(count / MAX_PARTICLES) * 1.0001 : size;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));

/** `voxelSize`, raised just enough that `size` fits in {@link MAX_VOXELS}. */
export function fitVoxelSize(size: readonly [number, number, number], voxelSize: number): number {
  const v = Math.max(0.001, voxelSize);
  const count = (size[0] / v) * (size[1] / v) * (size[2] / v);
  return count > MAX_VOXELS ? v * Math.cbrt(count / MAX_VOXELS) * 1.0001 : v;
}

/** Whether `fitVoxelSize` had to raise the authored voxel size (for a note in the panel). */
export function voxelSizeRaised(raw: FxParams): boolean {
  const p = normaliseFx(raw);
  return Math.abs(p.voxelSize - (Number(raw.voxelSize) || 0.1)) > 1e-9 && raw.resolution === undefined;
}

/** One line each, for the effect preset menu. */
const PRESET_DESCRIPTIONS: Record<string, string> = {
  campfire: 'A small wood fire with grey smoke.',
  'campfire-hq': 'The campfire with every realism setting on.',
  torch: 'A tall, narrow flame with little smoke.',
  'smoke-plume': 'A rising column of grey smoke, no fire.',
  explosion: 'A short fuel burst that blooms and rises.',
  candle: 'A tiny, steady flame.',
  bonfire: 'A large, roaring outdoor fire.',
  'gas-burner': 'A clean blue gas flame.',
  brazier: 'A fire in a raised bowl, very smoky.',
  chimney: 'Slow, wispy dark smoke.',
  steam: 'A white jet of steam from a vent.',
  embers: 'Glowing embers with thin smoke.',
  'magic-fire': 'A stylised green-cyan fire.',
  fireball: 'A rising ball of fire.',
  'big-explosion': 'A wide, heavy blast with dark smoke.',
  'muzzle-flash': 'A tiny, very fast sideways flash.',
  dust: 'A brown puff that settles.',
  'blood-burst': 'Liquid: blood bursting out of a hit, for a particle sprite.',
  'blood-droplet': 'Liquid: a stream of blood drops, looping, for velocity-aligned particles.',
  'blood-splash': 'Liquid: a jet of blood thrown along +Z that spatters the floor, with its decal.',
  'blood-pool': 'Liquid: blood pouring down and spreading into a pool, with its decal.',
  'water-splash': 'Liquid: the crown splash of something entering water.',
  'water-droplet': 'Liquid: a stream of water drops, looping, for velocity-aligned particles.',
  'mercury-splash': 'Liquid: a foot coming down in mercury -- beads thrown low and rolling, with surface maps and its decal.',
};

/** The liquid presets' shared base: a liquid, played once, no loop, nothing gas-only baked. */
const LIQUID_BASE: FxParams = {
  ...DEFAULT_FX, medium: 'liquid', warmup: 0, loopBlend: 0, frames: 24, frameTime: 1 / 30, substeps: 1,
  view: 'front', bakeSixWay: false, bakeEmission: false, bakeMotion: false, ambient: 0.45, lightElevation: 55,
};
const BLOOD_LOOK: Partial<FxParams> = {
  liquidColor: [0.42, 0.03, 0.03, 1], liquidTint: [0.55, 0.04, 0.04, 1], liquidAbsorption: 900, liquidRoughness: 0.12, specular: 1, foam: 0,
  viscosity: 0.15, surfaceTension: 0.5,
};
const WATER_LOOK: Partial<FxParams> = {
  liquidColor: [0.86, 0.92, 0.95, 1], liquidTint: [0.8, 0.92, 0.95, 1], liquidAbsorption: 8, liquidRoughness: 0.05, specular: 1.4, foam: 0.9,
  viscosity: 0, surfaceTension: 0.55,
};
/** Mercury: a liquid metal, heavy and very tense, that beads and rolls rather than wets. */
const MERCURY_LOOK: Partial<FxParams> = {
  liquidColor: [0.83, 0.83, 0.85, 1], liquidTint: [0.83, 0.83, 0.85, 1], liquidAbsorption: 500, liquidRoughness: 0.05, liquidMetallic: 1,
  specular: 1, foam: 0, viscosity: 0.05, surfaceTension: 1, stickiness: 0,
};

export const FX_PRESETS: readonly Preset<FxParams>[] = [
  { id: 'campfire', label: 'Campfire', params: DEFAULT_FX },
  {
    id: 'campfire-hq', label: 'Campfire (realistic)',
    params: {
      ...DEFAULT_FX, emitterNoise: 0.45, expansion: 1.5, advection: 'maccormack', pressureSolver: 'sor',
      fireColorMode: 'blackbody', anisotropy: 0.35, scatterOctaves: 2, fireGlow: 1.2, detailStrength: 0.35,
    },
  },
  {
    id: 'torch', label: 'Torch flame',
    params: { ...DEFAULT_FX, emitterPosition: [0, 1, 0], emitterRadius: 0.336, regionSize: [4.8, 9.6, 4.8], emitSpeed: 10, turbulence: 5, smoke: 0.05, smokeYield: 0.25, cooling: 1.8, frames: 32 },
  },
  {
    id: 'smoke-plume', label: 'Smoke plume',
    params: {
      ...DEFAULT_FX, emitterPosition: [0, 1, 0], emitterRadius: 0.672, fuel: 0, heat: 0.6, smoke: 2.2, emission: 0, buoyancy: 9, weight: 0.4, smokeDissipation: 0.12,
      cooling: 0.4, regionSize: [4.8, 9.6, 4.8], turbulence: 10, absorption: 1.6, smokeColor: [0.55, 0.55, 0.57, 1],
    },
  },
  {
    id: 'explosion', label: 'Explosion burst',
    params: {
      ...DEFAULT_FX, emitterPosition: [0, 1.695, 0], emitterRadius: 0.768, regionSize: [4.8, 4.8, 4.8], fuel: 3, heat: 2.5, emitSpeed: 2,
      turbulence: 24, emitDuration: 0.2, buoyancy: 20, vorticity: 0.6, burnRate: 4, heatRelease: 2.4, smokeYield: 1.2, warmup: 0, frames: 48, loopBlend: 0,
      expansion: 6, emitterNoise: 0.5, advection: 'maccormack', anisotropy: 0.3, scatterOctaves: 2, fireGlow: 1.5, detailStrength: 0.3,
    },
  },
  {
    id: 'candle', label: 'Candle',
    params: {
      ...DEFAULT_FX, emitterPosition: [0, 0.1516, 0], emitterRadius: 0.036, turbulenceSize: 0.3, regionSize: [0.6, 1.2, 0.6], voxelSize: 0.02, fuel: 1, heat: 1.1,
      smoke: 0.02, smokeYield: 0.05, emitSpeed: 4, turbulence: 1.5, buoyancy: 10, vorticity: 0.15, cooling: 2.6,
      emitterNoise: 0.2, fireColorMode: 'blackbody', blackbodyMin: 1300, blackbodyMax: 1900, emission: 2.6, fireGlow: 0.6,
    },
  },
  {
    id: 'bonfire', label: 'Bonfire',
    params: {
      ...DEFAULT_FX, emitterPosition: [0, 0.549, 0], emitterRadius: 1.98, turbulenceSize: 1.8, regionSize: [9, 12, 9], voxelSize: 0.15, emitterShape: 'disc', fuel: 1.6, heat: 1.4, smoke: 0.3, smokeYield: 0.9, emitSpeed: 7, turbulence: 14, buoyancy: 16, vorticity: 0.45,
      expansion: 1, emitterNoise: 0.55, advection: 'maccormack', pressureSolver: 'sor', fireColorMode: 'blackbody', blackbodyMin: 950, blackbodyMax: 1600,
      anisotropy: 0.35, scatterOctaves: 2, fireGlow: 1.4, detailStrength: 0.3,
    },
  },
  {
    id: 'gas-burner', label: 'Gas burner',
    params: {
      ...DEFAULT_FX, emitterPosition: [0, 0.2088, 0], emitterRadius: 0.288, turbulenceSize: 0.4, regionSize: [1.6, 2.4, 1.6], voxelSize: 0.04, emitterShape: 'disc', fuel: 0.8, heat: 1.6, smoke: 0, smokeYield: 0, emitSpeed: 9, turbulence: 2, buoyancy: 12, cooling: 3.2, ignition: 0.2,
      fireColorMode: 'blackbody', blackbodyMin: 2400, blackbodyMax: 6000, emission: 1.8, emissionRange: 0.9, fireGlow: 0.4,
    },
  },
  {
    id: 'brazier', label: 'Brazier',
    params: {
      ...DEFAULT_FX, emitterPosition: [0, 1.515, 0], emitterRadius: 0.6, turbulenceSize: 0.75, regionSize: [3, 6, 3], voxelSize: 0.06, emitterShape: 'disc', fuel: 1.3, heat: 1.2, smoke: 0.5, smokeYield: 1.4, turbulence: 9, smokeColor: [0.22, 0.21, 0.2, 1], absorption: 2.8,
      emitterNoise: 0.4, fireColorMode: 'blackbody', blackbodyMin: 900, blackbodyMax: 1500, anisotropy: 0.3, scatterOctaves: 2, fireGlow: 1,
    },
  },
  {
    id: 'chimney', label: 'Chimney smoke',
    params: {
      ...DEFAULT_FX, emitterPosition: [0, 0.645, 0], emitterRadius: 0.4, turbulenceSize: 1, regionSize: [4, 12, 4], voxelSize: 0.1, fuel: 0, heat: 0.45, smoke: 1.4,
      emission: 0, emitSpeed: 5, buoyancy: 6, weight: 0.3, turbulence: 6, vorticity: 0.5, cooling: 0.25, smokeDissipation: 0.06,
      smokeColor: [0.3, 0.3, 0.31, 1], absorption: 1.8, anisotropy: 0.25, scatterOctaves: 2, detailStrength: 0.45, detailScale: 8,
    },
  },
  {
    id: 'steam', label: 'Steam vent',
    params: {
      ...DEFAULT_FX, emitterPosition: [0, 0.2676, 0], emitterRadius: 0.24, turbulenceSize: 0.75, regionSize: [3, 6, 3], voxelSize: 0.06, emitterShape: 'disc', fuel: 0, heat: 1.2,
      smoke: 3, emission: 0, emitSpeed: 18, buoyancy: 8, weight: 0, turbulence: 12, cooling: 1.5, smokeDissipation: 1.1,
      smokeColor: [0.92, 0.93, 0.95, 1], absorption: 0.9, ambient: 0.6, anisotropy: 0.55, scatterOctaves: 3, detailStrength: 0.5,
    },
  },
  {
    id: 'embers', label: 'Smouldering embers',
    params: {
      ...DEFAULT_FX, emitterPosition: [0, 0.1362, 0], emitterRadius: 0.9, turbulenceSize: 0.75, regionSize: [3, 3.6, 3], voxelSize: 0.06, emitterShape: 'disc', fuel: 0.5,
      heat: 0.55, ignition: 0.4, emissionRange: 0.4, smoke: 0.4, smokeYield: 0.8, emitSpeed: 1.5, turbulence: 3, buoyancy: 5,
      emitterNoise: 0.9, smokeDissipation: 0.5, fireColorMode: 'blackbody', blackbodyMin: 800, blackbodyMax: 1200, fireGlow: 1.2,
    },
  },
  {
    id: 'magic-fire', label: 'Magic fire',
    params: {
      ...DEFAULT_FX, smoke: 0, smokeYield: 0.1, turbulence: 12, vorticity: 0.7, emitterNoise: 0.5, fireGlow: 1.6,
      fireGradient: {
        color: [{ t: 0, c: [0.02, 0.18, 0.12] }, { t: 0.4, c: [0.1, 0.85, 0.45] }, { t: 0.75, c: [0.35, 1, 0.9] }, { t: 1, c: [0.9, 1, 1] }],
        alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }],
      },
    },
  },
  {
    id: 'fireball', label: 'Fireball',
    params: {
      ...DEFAULT_FX, emitterPosition: [0, 1.536, 0], emitterRadius: 0.84, turbulenceSize: 1.5, regionSize: [6, 10, 6], voxelSize: 0.12, fuel: 3, heat: 2.4, emitSpeed: 6,
      emitDuration: 0.3, buoyancy: 26, expansion: 4, vorticity: 0.6, turbulence: 18, burnRate: 3, smokeYield: 1, warmup: 0, frames: 48,
      loopBlend: 0, emitterNoise: 0.5, advection: 'maccormack', fireColorMode: 'blackbody', blackbodyMin: 1000, blackbodyMax: 2000,
      anisotropy: 0.3, scatterOctaves: 2, fireGlow: 1.6, detailStrength: 0.25,
    },
  },
  {
    id: 'big-explosion', label: 'Large explosion',
    params: {
      ...DEFAULT_FX, emitterPosition: [0, 1.568, 0], emitterRadius: 1.44, turbulenceSize: 3, regionSize: [12, 10, 12], voxelSize: 0.16, fuel: 4, heat: 3, emitSpeed: 3,
      emitDuration: 0.15, buoyancy: 18, expansion: 8, vorticity: 0.8, turbulence: 30, burnRate: 5, heatRelease: 2.6, smokeYield: 1.8,
      smokeColor: [0.18, 0.17, 0.16, 1], absorption: 3, warmup: 0, frames: 64, loopBlend: 0, emitterNoise: 0.6, advection: 'maccormack',
      pressureSolver: 'sor', anisotropy: 0.3, scatterOctaves: 3, fireGlow: 2, detailStrength: 0.35,
    },
  },
  {
    id: 'muzzle-flash', label: 'Muzzle flash',
    params: {
      ...DEFAULT_FX, emitterPosition: [-0.5985, 0.4, 0], emitterRadius: 0.096, turbulenceSize: 0.4, regionSize: [1.6, 0.8, 0.8], voxelSize: 0.025, fuel: 3, heat: 3,
      emitSpeed: 0, wind: 60, emitDuration: 0.05, burnRate: 8, heatRelease: 2, smokeYield: 0.4, buoyancy: 4, expansion: 10, cooling: 5,
      frameTime: 1 / 60, warmup: 0, frames: 12, loopBlend: 0, emitterNoise: 0.4, fireGlow: 1,
    },
  },
  {
    id: 'dust', label: 'Dust puff',
    params: {
      ...DEFAULT_FX, emitterPosition: [0, 0.083, 0], emitterRadius: 0.45, turbulenceSize: 0.75, regionSize: [3, 1.5, 3], voxelSize: 0.05, emitterShape: 'disc', fuel: 0, heat: 0.3,
      smoke: 6, emission: 0, emitSpeed: 2, emitDuration: 0.15, buoyancy: 2, weight: 1.2, expansion: 6, turbulence: 10, cooling: 2,
      smokeDissipation: 0.5, smokeColor: [0.55, 0.45, 0.34, 1], absorption: 1.6, warmup: 0, frames: 32, loopBlend: 0, detailStrength: 0.4,
    },
  },
  {
    id: 'blood-burst', label: 'Blood burst',
    params: {
      ...LIQUID_BASE, ...BLOOD_LOOK, emitterPosition: [0, 0.45, 0], regionSize: [0.8, 0.8, 0.8], voxelSize: 0.006, dropletSize: 0.003, sourceShape: 'sphere', sourceVolume: 0.06,
      sourceMode: 'burst', sourceSpeed: [0.6, 3], sourcePitch: 15, sourceSpread: 150, sourceBreakup: 0.8, surfaceTension: 0.85,
      floorMode: 'none', airDrag: 0.4, frames: 16, tileSize: 128, bakeDecal: false,
    },
  },
  {
    id: 'blood-droplet', label: 'Blood droplets (loop)',
    params: {
      ...LIQUID_BASE, ...BLOOD_LOOK, emitterPosition: [0, 0.005, 0], regionSize: [0.06, 0.12, 0.06], voxelSize: 0.001, dropletSize: 0.002, sourceShape: 'disc', sourceRadius: 0.004,
      sourceMode: 'jet', jetDuration: 0, sourceVolume: 0.003, sourceSpeed: [0.45, 0.6], sourcePitch: 90, sourceSpread: 3,
      sourceBreakup: 0.25, surfaceTension: 0.95, gravity: 0, airDrag: 0, floorMode: 'none', warmup: 20, frames: 24, loopBlend: 8,
      tileSize: 64, tileAspect: 'tall', bakeDecal: false,
    },
  },
  {
    id: 'blood-splash', label: 'Blood spatter',
    params: {
      ...LIQUID_BASE, ...BLOOD_LOOK, emitterPosition: [0, 1, -0.6], regionSize: [2, 1.3, 2], voxelSize: 0.014, dropletSize: 0.005, sourceShape: 'point', sourceVolume: 0.12,
      sourceMode: 'burst', sourceSpeed: [1, 4], sourcePitch: 10, sourceSpread: 30, sourceBreakup: 0.6, surfaceTension: 0.45,
      floorMode: 'solid', floorBounce: 0.1, stickiness: 0.7, flow: 0.25, pinning: 1.4, edgeNoise: 0.6, soak: 0.03, view: 'side',
      bakeDecal: true, decalTileSize: 256, decalFrames: 16, decalSettle: 1.2,
    },
  },
  {
    id: 'blood-pool', label: 'Blood pool',
    params: {
      ...LIQUID_BASE, ...BLOOD_LOOK, emitterPosition: [0, 0.5, 0], regionSize: [1.2, 1, 1.2], voxelSize: 0.012, dropletSize: 0.006, sourceShape: 'disc', sourceRadius: 0.02,
      sourceMode: 'jet', jetDuration: 0.6, sourceVolume: 0.25, sourceSpeed: [0.3, 0.6], sourcePitch: -90, sourceSpread: 15,
      sourceBreakup: 0.3, stickiness: 0.3, floorMode: 'solid', flow: 0.6, pinning: 1.6, edgeNoise: 0.6, soak: 0.01, frames: 24,
      bakeDecal: true, decalTileSize: 256, decalFrames: 16, decalSettle: 2,
    },
  },
  {
    id: 'water-splash', label: 'Water splash',
    params: {
      ...LIQUID_BASE, ...WATER_LOOK, emitterPosition: [0, 0.02, 0], regionSize: [0.8, 0.6, 0.8], voxelSize: 0.006, dropletSize: 0.005, sourceShape: 'ring', sourceRadius: 0.1,
      sourceMode: 'burst', sourceVolume: 0.6, sourceSpeed: [1.2, 2.8], sourcePitch: 72, sourceSpread: 12, sourceBreakup: 0.7,
      ringCore: 0.25, floorMode: 'absorb', tileSize: 128, bakeDecal: false,
    },
  },
  {
    id: 'water-droplet', label: 'Water droplets (loop)',
    params: {
      ...LIQUID_BASE, ...WATER_LOOK, emitterPosition: [0, 0.005, 0], regionSize: [0.06, 0.12, 0.06], voxelSize: 0.001, dropletSize: 0.002, sourceShape: 'disc', sourceRadius: 0.004,
      sourceMode: 'jet', jetDuration: 0, sourceVolume: 0.003, sourceSpeed: [0.45, 0.6], sourcePitch: 90, sourceSpread: 3,
      sourceBreakup: 0.25, surfaceTension: 0.95, gravity: 0, airDrag: 0, floorMode: 'none', warmup: 20, frames: 24, loopBlend: 8,
      tileSize: 64, tileAspect: 'tall', foam: 0.3, bakeDecal: false,
    },
  },
  {
    id: 'mercury-splash', label: 'Mercury splash',
    params: {
      ...LIQUID_BASE, ...MERCURY_LOOK, emitterPosition: [0, 0.01, 0], regionSize: [0.4, 0.3, 0.4], voxelSize: 0.003, dropletSize: 0.003, sourceShape: 'ring', sourceRadius: 0.04,
      sourceMode: 'burst', sourceVolume: 0.05, sourceSpeed: [1, 2.2], sourcePitch: 65, sourceSpread: 20, sourceBreakup: 0.6,
      ringCore: 0, floorMode: 'solid', floorBounce: 0.3, floorFriction: 0.2, flow: 0.03, pinning: 4, edgeNoise: 0.1, soak: 0,
      surfaceSmoothing: 1.6, view: 'side', tileSize: 128, bakeDecal: true, decalTileSize: 256, decalFrames: 16, decalSettle: 1,
      bakeSurfaceMaps: true,
    },
  },
];
for (const preset of FX_PRESETS) (preset as Preset<FxParams>).description ??= PRESET_DESCRIPTIONS[preset.id] ?? preset.label;

/**
 * The realism models (realism.ts) layered over each preset: open air, the flame sheet, radiative
 * cooling, disturbance and shredding for fires; condensation for steam; the blast for explosions;
 * settling and ground drag for dust; diffusion, albedo, powder and sky occlusion for every smoke. The
 * plain Campfire stays the solver's reference (the determinism tests run it).
 */
// From the research pass (docs/creator/fx.md, References): flames nearly transparent (only soot hides
// what is behind them) and brighter than the smoke; chromatic, warm smoke extinction (Pyro's suggested
// absorption colour); fire dimmed inside dense soot; glow only from the hot core; smooth tricubic
// sampling with a little contrast; turbulence on the smoke as well as the hot gas, with a finer octave.
const FIRE_REALISM: Partial<FxParams> = {
  boundaries: 'open', flameShape: 0.85, flameLifetime: 0.18, coolingT4: 0.12, disturbance: 10, disturbanceScale: 0.25,
  disturbanceInterval: 0.2, shredding: 0.8, diffusion: 0.01, albedo: 0.7, powder: 0.5, skyOcclusion: 0.6, fireIntensity: 3.2,
  fireOpacity: 0.05, absorptionColor: [0.425, 0.36, 0.3, 1], fireSootMask: 1, glowThreshold: 0.3, blueCore: 1,
  smoothSampling: true, sharpen: 0.25, turbulenceOnSmoke: 0.5, turbulenceDetail: 0.5,
};
const SMOKE_REALISM: Partial<FxParams> = {
  boundaries: 'open', disturbance: 6, disturbanceScale: 0.4, disturbanceInterval: 0.35, shredding: 0.3, diffusion: 0.02,
  powder: 0.6, skyOcclusion: 0.7, detailStrength: 0.45, detailScale: 7,
  absorptionColor: [0.6, 0.55, 0.5, 1], smoothSampling: true, sharpen: 0.2, turbulenceOnSmoke: 0.8, turbulenceDetail: 0.6,
};
const REALISM: Record<string, Partial<FxParams>> = {
  'campfire-hq': { ...FIRE_REALISM, flicker: 1.5, albedo: 0.55 },
  torch: { ...FIRE_REALISM, flicker: 3, flameLifetime: 0.12, shredding: 1.2 },
  candle: { ...FIRE_REALISM, flicker: 5, flameShape: 0.95, flameLifetime: 0.1, disturbance: 3, disturbanceScale: 0.04, shredding: 1.4, fireIntensity: 3 },
  bonfire: { ...FIRE_REALISM, flicker: 1, disturbance: 16, disturbanceScale: 0.5, albedo: 0.45, fireIntensity: 3 },
  brazier: { ...FIRE_REALISM, flicker: 1.2, albedo: 0.35 },
  'gas-burner': { ...FIRE_REALISM, flameShape: 1, flameLifetime: 0.08, coolingT4: 0.3, disturbance: 4, disturbanceScale: 0.06, shredding: 0.5, fireIntensity: 2 },
  embers: { ...FIRE_REALISM, flameShape: 0.5, flicker: 0.6, disturbance: 3, fireIntensity: 2 },
  'magic-fire': { ...FIRE_REALISM, fireIntensity: 3 },
  'smoke-plume': { ...SMOKE_REALISM, albedo: 0.85 },
  chimney: { ...SMOKE_REALISM, albedo: 0.4, disturbance: 8 },
  steam: { ...SMOKE_REALISM, condensation: 8, dewPoint: 0.55, albedo: 0.97, powder: 0.3, skyOcclusion: 0.3, heat: 1.4, smokeDissipation: 0.2, absorptionColor: [1, 1, 1, 1] },
  explosion: { ...FIRE_REALISM, blast: 25, flameShape: 0.6, flameLifetime: 0.3, albedo: 0.4, fireIntensity: 3.5 },
  fireball: { ...FIRE_REALISM, blast: 12, flameShape: 0.6, flameLifetime: 0.35, albedo: 0.45, fireIntensity: 3.5 },
  'big-explosion': { ...FIRE_REALISM, blast: 40, flameShape: 0.55, flameLifetime: 0.35, albedo: 0.3, disturbance: 20, disturbanceScale: 0.8, fireIntensity: 4 },
  'muzzle-flash': { ...FIRE_REALISM, blast: 20, flameShape: 0.7, flameLifetime: 0.05, coolingT4: 0.6, fireIntensity: 5 },
  dust: { ...SMOKE_REALISM, settling: 0.35, groundDrag: 3, albedo: 0.8, anisotropy: 0.4, scatterOctaves: 2 },
};
for (const preset of FX_PRESETS) {
  const p = Object.assign(preset.params as FxParams, REALISM[preset.id] ?? {});
  // Nguyen et al. 2002: burning heats toward a maximum temperature -- set just above the top of the
  // fire's colour range, so the core reaches white-hot and no further -- and the radiative T^4 term is
  // measured over that range, so it is scaled to keep the same strength.
  if (REALISM[preset.id] && p.fuel > 0 && p.emission > 0) {
    p.maxTemperature = Math.round((p.ignition + p.emissionRange * 1.15) * 100) / 100;
    p.coolingT4 = Math.round((p.coolingT4 ?? 0) * 3 * 1000) / 1000;
  }
}

