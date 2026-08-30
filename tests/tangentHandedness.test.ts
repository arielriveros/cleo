import { describe, expect, it } from 'vitest';
import { Geometry } from '../src/core/geometry';

/**
 * A uv chart's HANDEDNESS is a fact about the mesh, and the bitangent has to measure it.
 *
 * `_calculateTangents` forced `B = -(N x T)` on every mesh it touched. The engine's own primitives
 * supply explicit tangents AND bitangents so they never reach it; meshes that arrive without a full
 * frame do, which in practice means imported ones. A mesh whose chart runs the other way came out
 * MIRRORED IN V, which decodes a normal map's green channel backwards — so its relief lit from the
 * wrong side while the parallax march, which derives its own basis from screen-space derivatives,
 * shifted the other way. That disagreement is what "the parallax is inverted" looks like, and it is
 * why it showed in the scene but not in the material preview, whose subject is `Geometry.Sphere`.
 */
describe('the bitangent follows the uv chart, not a fixed convention', () => {
    // Two quads in the XY plane, identical except that the second mirrors V. Their charts therefore
    // have OPPOSITE handedness, and nothing else about them differs.
    const quad = (mirrorV: boolean) => {
        const v = (t: number) => (mirrorV ? 1 - t : t);
        return new Geometry(
            [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]],
            [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
            [[0, v(0)], [1, v(0)], [1, v(1)], [0, v(1)]],
            [], [],                                   // no tangents, no bitangents -> derived
            [0, 1, 2, 0, 2, 3],
        );
    };
    const handedness = (g: Geometry) => {
        const t = g.tangents, b = g.bitangents, n = g.normals;
        // sign of dot(cross(N, T), B), per vertex
        const out: number[] = [];
        for (let i = 0; i < g.vertexCount; i++) {
            const i3 = i * 3;
            const cx = n[i3 + 1] * t[i3 + 2] - n[i3 + 2] * t[i3 + 1];
            const cy = n[i3 + 2] * t[i3] - n[i3] * t[i3 + 2];
            const cz = n[i3] * t[i3 + 1] - n[i3 + 1] * t[i3];
            out.push(Math.sign(cx * b[i3] + cy * b[i3 + 1] + cz * b[i3 + 2]));
        }
        return out;
    };

    it('two charts of opposite handedness get opposite bitangents', () => {
        const a = handedness(quad(false)), m = handedness(quad(true));
        expect(a.every(s => s !== 0), 'a degenerate frame proves nothing').toBe(true);
        for (let i = 0; i < a.length; i++) expect(m[i], `vertex ${i}`).toBe(-a[i]);
    });

    it('and the bitangent really is the chart dP/dv, up to sign', () => {
        // On the un-mirrored quad, V runs with +Y, so the bitangent must have a non-zero Y and no X.
        const g = quad(false);
        expect(Math.abs(g.bitangents[1])).toBeCloseTo(1, 6);
        expect(Math.abs(g.bitangents[0])).toBeCloseTo(0, 6);
    });

    it('an explicit frame is never recomputed', () => {
        // The engine's primitives rely on this: they author both arrays, so the derivation above must
        // not run and cannot change how they look.
        const g = new Geometry(
            [[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
            [[0, 0], [1, 0], [0, 1]],
            [[1, 0, 0], [1, 0, 0], [1, 0, 0]], [[0, 7, 0], [0, 7, 0], [0, 7, 0]],
            [0, 1, 2],
        );
        expect(Array.from(g.bitangents.slice(0, 3))).toEqual([0, 7, 0]);
    });
});
