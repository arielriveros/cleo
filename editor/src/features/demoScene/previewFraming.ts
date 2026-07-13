/**
 * Shared camera framing for asset-thumbnail preview scenes (mesh previews, the material preview sphere).
 *
 * Thumbnails are captured through `Renderer.screenshotOffscreen`, which renders into a **square** target —
 * so the camera's aspect is 1 and the vertical FOV governs both axes. That means fitting the subject's
 * bounding *sphere* against the vertical FOV is enough to guarantee the whole object is inside the frustum,
 * on every axis, at any scale.
 */

/** Vertical FOV used by every preview camera. */
export const PREVIEW_FOV = 60;

/** Breathing room around the subject so it doesn't touch the edges of the frame. */
export const PREVIEW_MARGIN = 1.4;

/** Radius of the material editor's preview sphere (`Geometry.Sphere(48)` — the default unit sphere). */
export const MATERIAL_SPHERE_RADIUS = 1;

/**
 * Distance at which a sphere of `radius` is fully inside a `fovDeg` vertical FOV (tangent to the frustum),
 * times a margin. With a square render this fits it horizontally too.
 */
export function fitDistance(radius: number, fovDeg: number = PREVIEW_FOV, margin: number = PREVIEW_MARGIN): number {
  const r = Math.max(radius, 1e-6);
  return (r / Math.sin((fovDeg / 2) * Math.PI / 180)) * margin;
}

/**
 * Near/far planes derived from the framing, so the subject can't be clipped at either end. Camera defaults
 * (near 0.1 / far 100) only suit human-scale objects: a small enough mesh sits entirely inside the default
 * near plane and a large enough one runs past the default far plane, and either way the thumbnail comes out
 * empty or cut. Both planes scale with the subject instead.
 */
export function previewClipPlanes(distance: number, radius: number): { near: number; far: number } {
  return {
    near: Math.max(distance - radius * 2, distance * 1e-3),
    far: distance + radius * 4,
  };
}
