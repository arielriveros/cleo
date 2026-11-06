// How the World's preview water looks: colours, clarity, waves, foam. Preview only -- the water plane and
// its material are never exported (the sea level and the lakes travel in the manifest as plain numbers).
// Colours are linear RGB.

export type Rgb = [number, number, number];

export interface WaterLook {
  preset: string;
  /** Colour of the water body in shallow, lit water. */
  shallowColor: Rgb;
  /** Colour it tends to where it is deep (what scattering adds back once the bottom is gone). */
  deepColor: Rgb;
  /** Per-metre absorption of red, green and blue at clarity 1 (red goes first, as in real water). */
  absorption: Rgb;
  /** Metres of visibility: divides the absorption, so 8 is twice as clear as 4. */
  clarity: number;
  /** Metres across the main wave pattern. */
  waveScale: number;
  /** 0..1: how strongly the waves bend the surface. */
  waveStrength: number;
  /** Compass degrees the wind blows toward (0 north = -Z, 90 east = +X). */
  windDirection: number;
  /** How fast the waves travel, m/s. */
  windSpeed: number;
  /** 0..1: foam at the shore and on crests. */
  foam: number;
  roughness: number;
  /** The reflected sky, horizon and zenith (the Creator binds no environment map). */
  skyHorizon: Rgb;
  skyZenith: Rgb;
}

const base: Omit<WaterLook, 'preset' | 'shallowColor' | 'deepColor' | 'absorption' | 'clarity'> = {
  waveScale: 9, waveStrength: 0.25, windDirection: 120, windSpeed: 1.2, foam: 0.6, roughness: 0.05,
  skyHorizon: [0.62, 0.72, 0.82], skyZenith: [0.18, 0.34, 0.62],
};

export const WATER_LOOKS: { id: string; label: string; look: WaterLook }[] = [
  { id: 'ocean', label: 'Ocean', look: { ...base, preset: 'ocean', shallowColor: [0.05, 0.22, 0.24], deepColor: [0.004, 0.03, 0.07], absorption: [0.45, 0.09, 0.05], clarity: 2, waveScale: 14, waveStrength: 0.3, windSpeed: 1.8, foam: 0.75 } },
  { id: 'tropical', label: 'Tropical', look: { ...base, preset: 'tropical', shallowColor: [0.1, 0.55, 0.5], deepColor: [0.0, 0.08, 0.16], absorption: [0.4, 0.06, 0.05], clarity: 4.5, waveScale: 10, waveStrength: 0.24, foam: 0.7 } },
  { id: 'alpine', label: 'Alpine lake', look: { ...base, preset: 'alpine', shallowColor: [0.06, 0.28, 0.22], deepColor: [0.004, 0.04, 0.05], absorption: [0.42, 0.1, 0.08], clarity: 3.5, waveScale: 6, waveStrength: 0.16, windSpeed: 0.7, foam: 0.35, skyHorizon: [0.7, 0.76, 0.82], skyZenith: [0.2, 0.36, 0.6] } },
  { id: 'murky', label: 'Murky', look: { ...base, preset: 'murky', shallowColor: [0.12, 0.13, 0.06], deepColor: [0.02, 0.025, 0.012], absorption: [0.6, 0.45, 0.5], clarity: 0.8, waveScale: 5, waveStrength: 0.14, windSpeed: 0.5, foam: 0.25, roughness: 0.08 } },
];

export const DEFAULT_WATER_LOOK: WaterLook = WATER_LOOKS[0].look;

const isRgb = (v: unknown): v is Rgb => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x));

export function normaliseWaterLook(raw: unknown): WaterLook {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<WaterLook>;
  const out: WaterLook = { ...DEFAULT_WATER_LOOK };
  for (const k of Object.keys(out) as (keyof WaterLook)[]) {
    const v = r[k];
    if (v === undefined) continue;
    if (k === 'preset') { if (typeof v === 'string') out.preset = v; continue; }
    if (isRgb(out[k])) { if (isRgb(v)) (out as unknown as Record<string, unknown>)[k] = v; continue; }
    if (typeof v === 'number' && Number.isFinite(v)) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}
