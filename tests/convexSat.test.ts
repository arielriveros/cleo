import { describe, it, expect } from 'vitest';
import { Box, ConvexPolyhedron, Cylinder, Quaternion, Vec3 } from 'cannon-es';
import { fastFindSeparatingAxis, stockFindSeparatingAxis } from '../src/physics/convexSat';

// The fast separating-axis test must give cannon's answer: the same verdict, and an axis along which the
// pair overlaps by the same minimum depth, pointing the same way. Parallel axes are the only thing it
// skips, and those project identically — this is what checks that claim.

function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hulls(r: () => number): ConvexPolyhedron[] {
    const box = new Box(new Vec3(0.2 + r(), 0.2 + r(), 0.2 + r())).convexPolyhedronRepresentation;
    // A random hull: a jittered octahedron, which cannon's ConvexPolyhedron takes as faces directly.
    const s = 0.4 + r();
    const vertices = [[s, 0, 0], [-s, 0, 0], [0, s, 0], [0, -s, 0], [0, 0, s], [0, 0, -s]]
        .map(([x, y, z]) => new Vec3(x * (0.8 + 0.4 * r()), y * (0.8 + 0.4 * r()), z * (0.8 + 0.4 * r())));
    const octa = new ConvexPolyhedron({
        vertices,
        faces: [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]],
    });
    return [
        box,
        new Cylinder(0.3, 0.3, 1.2, 16),
        new Cylinder(0.35, 0.35, 0.9, 12),
        new Cylinder(0.25, 0.25, 2.4, 8),
        octa,
    ];
}

function randomQuat(r: () => number, upright: boolean): Quaternion {
    const q = new Quaternion();
    if (upright) q.setFromAxisAngle(new Vec3(0, 1, 0), r() * Math.PI * 2);
    else {
        const axis = new Vec3(r() - 0.5, r() - 0.5, r() - 0.5);
        axis.normalize();
        q.setFromAxisAngle(axis, r() * Math.PI * 2);
    }
    return q;
}

const maxmin: number[] = [];
function overlapAlong(a: ConvexPolyhedron, b: ConvexPolyhedron, axis: Vec3, pa: Vec3, qa: Quaternion, pb: Vec3, qb: Quaternion): number {
    ConvexPolyhedron.project(a, axis, pa, qa, maxmin);
    const [maxA, minA] = maxmin;
    ConvexPolyhedron.project(b, axis, pb, qb, maxmin);
    const [maxB, minB] = maxmin;
    return Math.min(maxA - minB, maxB - minA);
}

describe('fast findSeparatingAxis', () => {
    it('matches cannon on random convex pairs, upright and tumbling', () => {
        const r = rng(11);
        let overlapping = 0, separated = 0;
        for (let k = 0; k < 4000; k++) {
            const set = hulls(r);
            const a = set[Math.floor(r() * set.length)], b = hulls(r)[Math.floor(r() * set.length)];
            const upright = r() < 0.5;
            const pa = new Vec3((r() - 0.5) * 0.5, (r() - 0.5) * 0.5, (r() - 0.5) * 0.5);
            const pb = new Vec3((r() - 0.5) * 2.4, (r() - 0.5) * 2.4, (r() - 0.5) * 2.4);
            const qa = randomQuat(r, upright), qb = randomQuat(r, upright);
            const want = new Vec3(), got = new Vec3();
            const stock = stockFindSeparatingAxis.call(a, b, pa, qa, pb, qb, want);
            const fast = fastFindSeparatingAxis.call(a, b, pa, qa, pb, qb, got);
            expect(fast, `pair ${k}`).toBe(stock);
            if (!stock) { separated++; continue; }
            overlapping++;
            expect(Math.abs(got.length() - 1)).toBeLessThan(1e-9);
            expect(overlapAlong(a, b, got, pa, qa, pb, qb)).toBeCloseTo(overlapAlong(a, b, want, pa, qa, pb, qb), 9);
            // Both point from B toward A.
            const d = new Vec3(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
            expect(Math.sign(got.dot(d))).toBe(Math.sign(want.dot(d)));
        }
        expect(overlapping).toBeGreaterThan(500);
        expect(separated).toBeGreaterThan(500);
    });

    it('respects the face lists cannon passes for a hull against a heightfield pillar', () => {
        const a = new Cylinder(0.3, 0.3, 1.2, 16), b = new Box(new Vec3(1, 0.5, 1)).convexPolyhedronRepresentation;
        const pa = new Vec3(0.2, 0.9, 0), pb = new Vec3(0, 0, 0), q = new Quaternion();
        const want = new Vec3(), got = new Vec3();
        const lists: [number[], number[]] = [[0, 3, 5], [1, 2]];
        expect(fastFindSeparatingAxis.call(a, b, pa, q, pb, q, got, ...lists))
            .toBe(stockFindSeparatingAxis.call(a, b, pa, q, pb, q, want, ...lists));
        expect(got.dot(want)).toBeCloseTo(1, 9);
    });
});
