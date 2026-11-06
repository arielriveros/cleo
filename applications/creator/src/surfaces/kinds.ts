// The generated surface materials' kinds: what the World Creator shows a terrain layer with (sand,
// rock, snow...). They are preview materials only -- never exported -- so the table carries what the
// preview and the export's hints need: a label, the linear colour the kind reads as (Map swatches, the
// manifest's colour hint), how many metres one texture repeat covers, and a height-blend default.

export type SurfaceKind = 'grass' | 'forest' | 'dirt' | 'mud' | 'sand' | 'gravel' | 'pebbles' | 'rock' | 'cliff' | 'snow';

export interface SurfaceKindInfo {
  id: SurfaceKind;
  label: string;
  /** Linear RGB the kind reads as from a distance: the generated albedo's mean. */
  color: [number, number, number];
  /** Metres one texture repeat covers on the ground. */
  tiling: number;
  /** 0..1: how strongly the kind's relief decides its transitions (stones and rock poke through, sand and snow fill in). */
  heightBlend: number;
}

export const SURFACE_KINDS: readonly SurfaceKindInfo[] = [
  { id: 'grass', label: 'Grass', color: [0.115, 0.152, 0.038], tiling: 3, heightBlend: 0.4 },
  { id: 'forest', label: 'Forest floor', color: [0.127, 0.074, 0.032], tiling: 4, heightBlend: 0.35 },
  { id: 'dirt', label: 'Dirt', color: [0.141, 0.099, 0.062], tiling: 4, heightBlend: 0.4 },
  { id: 'mud', label: 'Mud', color: [0.059, 0.043, 0.029], tiling: 5, heightBlend: 0.3 },
  { id: 'sand', label: 'Sand', color: [0.552, 0.465, 0.325], tiling: 6, heightBlend: 0.3 },
  { id: 'gravel', label: 'Gravel', color: [0.253, 0.253, 0.254], tiling: 2, heightBlend: 0.65 },
  { id: 'pebbles', label: 'Pebbles', color: [0.28, 0.253, 0.211], tiling: 3, heightBlend: 0.7 },
  { id: 'rock', label: 'Rock', color: [0.3, 0.292, 0.274], tiling: 8, heightBlend: 0.6 },
  { id: 'cliff', label: 'Cliff', color: [0.264, 0.225, 0.188], tiling: 12, heightBlend: 0.6 },
  { id: 'snow', label: 'Snow', color: [0.801, 0.83, 0.882], tiling: 10, heightBlend: 0.2 },
];

const BY_ID = new Map(SURFACE_KINDS.map(k => [k.id, k]));

/** The table row for `kind` (grass for an unknown id, so an old document still draws). */
export const surfaceKindInfo = (kind: SurfaceKind): SurfaceKindInfo => BY_ID.get(kind) ?? SURFACE_KINDS[0];
