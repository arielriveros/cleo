import { describe, it, expect } from 'vitest';
import { convexHull, hullFromPositions, HULL_BUDGETS, type Hull, type HullQuality } from '../src/physics/convexHull';

const CUBE = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];

/**
 * Every input point must lie inside (or on) every face plane. This is the invariant the half-space
 * carve must never break: degradation toward the bounding box is allowed, a vertex outside is not.
 *
 * Hull vertices are centroid-recentred, so source points are compared in hull-local space (p - center).
 * Face loops are CCW from outside, so the cross product gives an outward normal and "inside" is <= 0.
 */
function containsAll(hull: Hull, points: number[][], tol = 1e-4): boolean {
    for (const p of points) {
        const local = sub(p, hull.center);
        for (const face of hull.faces) {
            if (face.length < 3) continue;
            const a = hull.vertices[face[0]], b = hull.vertices[face[1]], c = hull.vertices[face[2]];
            const n = cross(sub(b, a), sub(c, a));
            const len = Math.hypot(n[0], n[1], n[2]);
            if (len < 1e-12) continue; // degenerate face, nothing to test against
            const unit = [n[0] / len, n[1] / len, n[2] / len];
            if (dot(unit, sub(local, a)) > tol) return false;
        }
    }
    return true;
}

describe('convexHull', () => {
    it('returns null for degenerate input (fewer than 4 points)', () => {
        expect(convexHull([[0, 0, 0], [1, 0, 0], [0, 1, 0]])).toBeNull();
        expect(convexHull([])).toBeNull();
    });

    it('hulls a cube and contains every input point', () => {
        const hull = convexHull(CUBE);
        expect(hull).not.toBeNull();
        expect(containsAll(hull!, CUBE)).toBe(true);
    });

    it('ignores points interior to the hull', () => {
        const withInterior = [...CUBE, [0.5, 0.5, 0.5], [0.4, 0.6, 0.5]];
        const hull = convexHull(withInterior);
        expect(hull).not.toBeNull();
        // A cube's hull is 6 planes regardless of how many interior points are thrown at it.
        expect(hull!.faces.length).toBe(6);
        expect(containsAll(hull!, withInterior)).toBe(true);
    });

    it('contains duplicated points without degenerating', () => {
        const dupes = [...CUBE, ...CUBE];
        const hull = convexHull(dupes);
        expect(hull).not.toBeNull();
        expect(containsAll(hull!, dupes)).toBe(true);
    });
});

describe('hullFromPositions', () => {
    const qualities: HullQuality[] = ['low', 'medium', 'high', 'veryHigh'];

    it('returns null for degenerate input', () => {
        expect(hullFromPositions([[0, 0, 0]], 'medium')).toBeNull();
    });

    // The whole point of the half-space carve: containment is exact at EVERY quality, because offsets
    // are measured against the full point set. A carve that clips real geometry is a physics bug that
    // shows up as objects sinking through their own collider.
    it.each(qualities)('contains every input point at quality=%s', (quality) => {
        const hull = hullFromPositions(CUBE, quality);
        expect(hull).not.toBeNull();
        expect(containsAll(hull!, CUBE)).toBe(true);
    });

    it.each(qualities)('respects the plane budget at quality=%s', (quality) => {
        const hull = hullFromPositions(CUBE, quality);
        expect(hull!.faces.length).toBeLessThanOrEqual(HULL_BUDGETS[quality]);
    });

    // 'low' is documented as "the bounding box, untouched".
    it('produces exactly the bounding box at quality=low', () => {
        const hull = hullFromPositions(CUBE, 'low');
        expect(hull!.faces.length).toBe(6);
    });

    it('contains a point cloud that is not axis-aligned', () => {
        const cloud: number[][] = [];
        // Deterministic pseudo-random cloud - a fixed lattice rotated off-axis.
        for (let i = 0; i < 60; i++) {
            const a = i * 0.7;
            cloud.push([Math.cos(a) * (1 + (i % 3)), Math.sin(a) * 2, Math.cos(a * 1.3) * 1.5]);
        }
        for (const quality of qualities) {
            const hull = hullFromPositions(cloud, quality);
            expect(hull, `quality=${quality}`).not.toBeNull();
            expect(containsAll(hull!, cloud), `quality=${quality} containment`).toBe(true);
        }
    });
});

// Negative control: proves containsAll() can actually fail. Without this, a bug that made the helper
// vacuously true would silently disarm every containment assertion above.
describe('containsAll (test helper sanity)', () => {
    it('rejects a point outside the hull', () => {
        const hull = convexHull(CUBE)!;
        expect(containsAll(hull, [[5, 5, 5]])).toBe(false);
        expect(containsAll(hull, [[0.5, 0.5, 1.5]])).toBe(false);
    });

    it('accepts a point on the surface', () => {
        const hull = convexHull(CUBE)!;
        expect(containsAll(hull, [[0.5, 0.5, 1]])).toBe(true);
    });
});
