// The stage floors' PBR sets: the manifest the build serves (vite.floors.ts) and their maps decoded to
// pixels. Worker-safe -- floorWorker.ts decodes in a background thread.

import type { FloorMaps } from './floorComposite';

export interface FloorSet {
  id: string;
  name: string;
  /** File names relative to `floors/<id>/`. */
  diff: string;
  nor?: string;
  arm?: string;
  disp?: string;
}

/** The set the snow is taken from, when the build has it. */
export const SNOW_SET_ID = 'snow_02_1k';

/** Where the floors are served, ending in a slash: the app's base plus `floors/`. */
export function floorsBase(baseUrl: string): string {
  return `${baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'}floors/`;
}

export async function loadFloorManifest(base: string): Promise<FloorSet[]> {
  try {
    const res = await fetch(`${base}index.json`);
    if (!res.ok) return [];
    const json = await res.json() as { sets?: FloorSet[] };
    return Array.isArray(json.sets) ? json.sets : [];
  } catch {
    return [];
  }
}

/** RGBA8 pixels of an image, as stored: maps are data, so no colour conversion and no premultiplication. */
async function decode(url: string): Promise<{ size: number; data: Uint8ClampedArray } | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const size = bitmap.width;
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  bitmap.close();
  return { size, data };
}

/** A set's maps. Maps of another size than the colour map's are left out (they would not line up). */
export async function loadFloorMaps(base: string, set: FloorSet): Promise<FloorMaps> {
  const diff = await decode(`${base}${set.id}/${set.diff}`);
  if (!diff) throw new Error(`floor set ${set.id}: no colour map`);
  const maps: FloorMaps = { size: diff.size, diff: diff.data };
  for (const role of ['nor', 'arm', 'disp'] as const) {
    const file = set[role];
    if (!file) continue;
    const m = await decode(`${base}${set.id}/${file}`);
    if (m && m.size === diff.size) maps[role] = m.data;
  }
  return maps;
}
