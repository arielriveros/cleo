import { describe, it, expect } from 'vitest';
import { clothParts, fitCapsule, pieceWeights } from '../tools/exampleKit/clothFit.mjs';

// The generator side of skinned cloth (tools/exampleKit/clothFit.mjs): which pieces of a cloth material
// simulate, how free each vertex is, and the capsules fitted to the armour around them.

describe('cloth fitting', () => {
    it('fits a capsule to points around a segment', () => {
        const pts: number[] = [];
        for (let i = 0; i < 400; i++) {
            const y = (i % 40) / 39 * 0.6, a = (i * 2.399) % (Math.PI * 2);
            pts.push(Math.cos(a) * 0.1, y, Math.sin(a) * 0.1);
        }
        const c = fitCapsule(pts)!;
        // Vertical axis through the origin, radius about 0.1 (less the shrink), the caps inside the extent.
        expect(Math.abs(c.a[0]) + Math.abs(c.a[2])).toBeLessThan(0.01);
        expect(Math.abs(c.b[1] - c.a[1])).toBeGreaterThan(0.3);
        expect(c.radius).toBeGreaterThan(0.09);
        expect(c.radius).toBeLessThan(0.1);
    });

    it('weights a strap 0 where it is sewn on and 1 at its free end', () => {
        // A strap along +x: vertex 0 touches the armour.
        const positions: number[] = [];
        for (let i = 0; i < 10; i++) positions.push(i * 0.02, 1, 0);
        const verts = [...Array(10).keys()];
        const w = pieceWeights(positions, verts, v => v === 0)!;
        expect(w[0]).toBe(0);
        expect(w[9]).toBe(1);
        for (let i = 1; i < 10; i++) expect(w[i]).toBeGreaterThanOrEqual(w[i - 1]);
        // Lying on the armour (nearly every vertex in contact): not simulated.
        expect(pieceWeights(positions, verts, v => v < 9)).toBeNull();
    });

    it('keeps cloth lying on the armour skinned, and fits a capsule per armour bone', () => {
        // Submesh 0 "armour": a ring of points round a hip joint. Submesh 1 "cloth": a skirt strip hanging
        // free below it, and a patch lying flat on the armour.
        const positions: number[] = [], indices: number[] = [], ji: number[] = [], jw: number[] = [];
        const vert = (x: number, y: number, z: number) => { positions.push(x, y, z); ji.push(0, 0, 0, 0); jw.push(1, 0, 0, 0); return positions.length / 3 - 1; };
        const armour: number[] = [];
        for (let i = 0; i < 24; i++) for (let k = 0; k < 4; k++) { const a = i / 24 * Math.PI * 2; armour.push(vert(Math.cos(a) * 0.15, 1 + k * 0.05, Math.sin(a) * 0.15)); }
        for (let t = 0; t + 2 < armour.length; t += 3) indices.push(armour[t], armour[t + 1], armour[t + 2]);
        const armourCount = indices.length;
        const quad = (pts: number[][]) => { const v = pts.map(p => vert(p[0], p[1], p[2])); indices.push(v[0], v[1], v[2], v[0], v[2], v[3]); };
        // The patch: sits on the armour at z = 0.15.
        quad([[-0.004, 1.05, 0.152], [0.004, 1.05, 0.152], [0.004, 1.1, 0.152], [-0.004, 1.1, 0.152]]);
        // The skirt: from the armour's foot down, two quads.
        quad([[-0.1, 1.0, 0.16], [0.1, 1.0, 0.16], [0.1, 0.8, 0.17], [-0.1, 0.8, 0.17]]);
        const skin = { joints: [{ nodeIndex: 0, inverseBindMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1] }], nodeNames: [[0, 'mixamorig:Hips_01']] };
        const submeshes = [{ start: 0, count: armourCount }, { start: armourCount, count: indices.length - armourCount }];
        const { data, report } = clothParts({ positions, indices, submeshes, jointIndices: ji, jointWeights: jw, skin },
            { clothSubmesh: 1, hangsFrom: /Hips/, colliderBones: /Hips/, settings: { maxDistance: 0.2 } });
        expect(report).toMatch(/1 pieces simulated/);
        expect(report).toMatch(/1 lying on armour/);
        expect(data!.colliders).toHaveLength(1);
        // Only the skirt's four vertices simulate; its top touches the armour, its hem is free.
        expect(data!.vertices).toHaveLength(4);
        const hem = data!.weights.filter((_, i) => positions[data!.vertices[i] * 3 + 1] < 0.9);
        expect(Math.min(...hem)).toBeGreaterThan(0.5);
    });
});
