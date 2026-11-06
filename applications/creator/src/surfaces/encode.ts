// A generated surface as PNG bytes: what the worker hands the main thread, where the bytes go straight
// into the engine's TextureManager (addTextureFromBytes). core/png keeps the bytes a pure function of the
// pixels, so the same kind and seed give the same files in a test as in any browser.

import { encodePngRgba8 } from '../core/png';
import { generateSurface, type SurfaceMaps } from './generate';
import type { SurfaceKind } from './kinds';

export interface SurfacePngs {
  kind: SurfaceKind;
  seed: number;
  size: number;
  /** sRGB base colour. */
  albedo: Uint8Array;
  /** Tangent-space normal, OpenGL convention. */
  normal: Uint8Array;
  /** R occlusion, G roughness, B metallic. */
  orm: Uint8Array;
  /** Grey relief, white = high: the material's displacementMap, which the terrain's height blend reads. */
  height: Uint8Array;
}

export async function encodeSurface(kind: SurfaceKind, seed: number, maps: SurfaceMaps): Promise<SurfacePngs> {
  const png = (img: SurfaceMaps['albedo']) => encodePngRgba8(img.width, img.height, img.data);
  const [albedo, normal, orm, height] = await Promise.all([png(maps.albedo), png(maps.normal), png(maps.orm), png(maps.height)]);
  return { kind, seed, size: maps.size, albedo, normal, orm, height };
}

/** Generate and encode in one step (the worker's whole job). */
export function buildSurfacePngs(kind: SurfaceKind, size: number, seed: number): Promise<SurfacePngs> {
  return encodeSurface(kind, seed, generateSurface(kind, size, seed));
}
