import { Geometry } from 'cleo'

/**
 * Shared camera framing for asset-thumbnail preview scenes.
 * Thumbnails render into a square target, so aspect is 1 and the vertical FOV governs both axes; fitting
 * the subject's bounding sphere against it frames the whole object on every axis.
 */

/** Vertical FOV used by every preview camera. */
export const PREVIEW_FOV = 60;

/** Breathing room around the subject so it doesn't touch the edges of the frame. */
export const PREVIEW_MARGIN = 1.4;

/** Radius of the material editor's preview sphere (`Geometry.Sphere(48)` — the default unit sphere). */
export const MATERIAL_SPHERE_RADIUS = 1;

/**
 * Side length of the terrain-material preview patch, in metres, and the radius that frames it.
 *
 * A terrain material cannot be previewed on a sphere any more. Its relief is GEOMETRY — the layer
 * displaces the terrain's own vertices and the parallax march is switched off for it — so a sphere
 * carrying the composite terrain material shows the albedo and nothing else. The preview has to be an
 * actual patch of terrain, which is also the only way it can be honest: it is then the same code path
 * the landscape runs, and cannot drift from it.
 */
export const PREVIEW_TERRAIN_SIZE = 8;
/**
 * The landscape a terrain material is previewed AGAINST when the scene has none yet.
 *
 * The patch's own size is not enough to make a preview honest. A terrain material's relief depth is
 * world metres and its tiling is a count across the whole terrain, so an 8 m patch tiled the same
 * number of times as a 200 m landscape puts one repeat at 0.4 m instead of 10 — and the same authored
 * depth then reads twenty-five times more pronounced here than on the ground. `buildTerrainPreviewSubject`
 * matches metres-per-repeat and metres-per-vertex to these instead of matching the tile count.
 *
 * Mirrors the default landscape `addCatalog.ts` creates (200 m, resolution 129) and the density that
 * config derives; `previewTerrainScale.test.ts` pins the density against a real `Terrain` so this
 * cannot quietly drift from the engine's own answer.
 */
export const REFERENCE_LANDSCAPE = { size: 200, resolution: 129, density: 4 };
/** Half-diagonal of the patch, which is what the orbit camera has to clear. */
export const PREVIEW_TERRAIN_RADIUS = (PREVIEW_TERRAIN_SIZE * Math.SQRT2) / 2;

/**
 * Distance at which a sphere of `radius` is tangent to a `fovDeg` vertical FOV, times a margin.
 */
export function fitDistance(radius: number, fovDeg: number = PREVIEW_FOV, margin: number = PREVIEW_MARGIN): number {
  const r = Math.max(radius, 1e-6);
  return (r / Math.sin((fovDeg / 2) * Math.PI / 180)) * margin;
}

/**
 * Near/far planes derived from the framing so the subject cannot be clipped at either end. Both scale
 * with the subject; the camera defaults (near 0.1 / far 100) only suit human-scale objects.
 */
export function previewClipPlanes(distance: number, radius: number): { near: number; far: number } {
  return {
    near: Math.max(distance - radius * 2, distance * 1e-3),
    far: distance + radius * 4,
  };
}

/**
 * How many times the preview sphere repeats its texture around itself.
 *
 * The sphere used to carry `Geometry.Sphere`'s raw UVs, which wrap 0->1 exactly once — and that made it
 * a misleading preview of the one parameter it exists to show. `dispScale` (and every tiling-relative
 * judgement a texture invites) is in UV UNITS, so on an untiled sphere 0.05 is five percent of the whole
 * circumference: an enormous, smeared offset that looks nothing like the same material on a wall tiled
 * eight times, where it is a few millimetres. Repeating the UVs makes the number mean roughly on the
 * sphere what it will mean in the scene.
 *
 * Changing this re-scales every material thumbnail, which is why it is one shared constant rather than a
 * literal at each of the four sphere-construction sites (two editor tabs, two thumbnail renderers). The
 * tab and its thumbnail must agree, or the gallery stops predicting what opening the asset will show.
 */
export const PREVIEW_SPHERE_TILING = 4;

/**
 * `Geometry.Sphere(48)` with its UVs repeated PREVIEW_SPHERE_TILING times.
 *
 * Scaled in place after construction, which is safe for the tangents the constructor already derived:
 * multiplying every uv by k divides dP/du by k and leaves its DIRECTION untouched, and direction is all
 * a normal-map decode uses. Parallax does not even use them — `parallaxFrame` builds its own basis from
 * screen-space derivatives.
 *
 * Must run BEFORE the Model is built: `Mesh` allocates its VAO and uploads in its constructor, so a uv
 * edited afterwards would never reach the GPU.
 */
export function previewSphereGeometry(): Geometry {
  const g = Geometry.Sphere(48);
  const uvs = g.uvs;
  for (let i = 0; i < uvs.length; i++) uvs[i] *= PREVIEW_SPHERE_TILING;
  return g;
}
