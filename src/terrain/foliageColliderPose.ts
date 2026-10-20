import type { FoliageCollision } from '../graphics/material';

/**
 * The world-space shape of one instance's collider: what the physics body is built from, and what the
 * editor draws (the collider preview and the viewport overlay) — one function, so the three cannot
 * disagree. `size` is FULL extents (x, y, z); a sphere's is its diameter on every axis. `offsetY` lifts
 * the shape's centre above the instance base.
 *
 * `FoliageCollision.width`/`depth` are HALF-widths (a box defaults to the radius each side of centre),
 * which is how every saved collider has always been read; only the editor shows them as full sizes.
 */
export function foliageColliderPose(col: FoliageCollision, scale: number):
    { shape: FoliageCollision['shape']; size: [number, number, number]; offsetY: number } {
    const r = (col.radius ?? 0.5) * scale;
    const h = (col.height ?? 2) * scale;
    const offsetY = (col.offsetY ?? (col.shape === 'sphere' ? (col.radius ?? 0.5) : (col.height ?? 2) / 2)) * scale;
    if (col.shape === 'sphere') return { shape: 'sphere', size: [r * 2, r * 2, r * 2], offsetY };
    if (col.shape === 'box') {
        const w = (col.width ?? col.radius ?? 0.5) * 2 * scale;
        const d = (col.depth ?? col.radius ?? 0.5) * 2 * scale;
        return { shape: 'box', size: [w, h, d], offsetY };
    }
    return { shape: 'cylinder', size: [r * 2, h, r * 2], offsetY };
}

