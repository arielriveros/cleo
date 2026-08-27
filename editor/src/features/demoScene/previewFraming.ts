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
