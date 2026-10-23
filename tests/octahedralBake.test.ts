import { describe, it, expect } from 'vitest';
import { bakeOctahedralImpostor, impostorSphere, rgbaSampler, type OctahedralBakePart } from '../src/terrain/octahedralBake';
import { frameDirection, frameBlend, type V3 } from '../src/terrain/octahedralImpostor';

// The CPU impostor baker: every frame must be the view the shader will look it up as. A cube with a
// different colour (and normal) per face makes that checkable texel by texel.

const FACES: { n: V3; color: [number, number, number, number] }[] = [
    { n: [1, 0, 0], color: [1, 0, 0, 1] },
    { n: [-1, 0, 0], color: [0, 1, 1, 1] },
    { n: [0, 1, 0], color: [0, 1, 0, 1] },
    { n: [0, 0, 1], color: [0, 0, 1, 1] },
    { n: [0, 0, -1], color: [1, 1, 0, 1] },
    { n: [0, -1, 0], color: [1, 0, 1, 1] },
];

/** A unit cube centred on `c`, one part per face, wound outward. */
function cube(c: V3 = [0, 1, 0], h = 0.5): OctahedralBakePart[] {
    return FACES.map(({ n, color }) => {
        // Two axes spanning the face.
        const u: V3 = Math.abs(n[1]) > 0.5 ? [1, 0, 0] : [0, 1, 0];
        const v: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        const corner = (a: number, b: number): number[] =>
            [0, 1, 2].map(k => c[k] + (n[k] + u[k] * a + v[k] * b) * h);
        const positions = [...corner(-1, -1), ...corner(1, -1), ...corner(1, 1), ...corner(-1, 1)];
        const normals = [...n, ...n, ...n, ...n];
        return { positions, normals, indices: [0, 1, 2, 0, 2, 3], color };
    });
}

const at = (data: Uint8ClampedArray, size: number, x: number, y: number) => {
    const o = (Math.floor(y) * size + Math.floor(x)) * 4;
    return [data[o], data[o + 1], data[o + 2], data[o + 3]];
};
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('impostorSphere', () => {
    it('centres on the box and reaches every vertex', () => {
        const { center, radius } = impostorSphere(cube([2, 3, 4]));
        expect(center).toEqual([2, 3, 4]);
        expect(radius).toBeGreaterThanOrEqual(Math.sqrt(3) * 0.5);
        expect(radius).toBeLessThan(Math.sqrt(3) * 0.5 * 1.05);
    });
});

describe('bakeOctahedralImpostor', () => {
    const frames = 6, F = 32;
    // Unrounded normals: a cube's faces are what is being checked, not a canopy's light.
    const bake = bakeOctahedralImpostor(cube(), { frames, frameSize: F, normalFrameSize: 16, supersample: 2, roundNormals: 0 });

    it('describes the sphere it captured', () => {
        expect(bake.info.frames).toBe(frames);
        expect(bake.info.center).toEqual([0, 1, 0]);
        expect(bake.albedoSize).toBe(frames * F);
        expect(bake.normalSize).toBe(frames * 16);
    });

    it('puts at each frame centre the face that frame looks at, with its normal', () => {
        for (let j = 0; j < frames; j++) {
            for (let i = 0; i < frames; i++) {
                const d = frameDirection(i, j, frames);
                // The face most squarely toward the frame's camera. Skip near-ties (a corner-on view),
                // where which face covers the centre texel is decided by a hair.
                const scores = FACES.map(f => dot(f.n, d)).sort((a, b) => b - a);
                if (scores[0] - scores[1] < 0.15) continue;
                const face = FACES.reduce((best, f) => dot(f.n, d) > dot(best.n, d) ? f : best);
                const c = at(bake.albedo, bake.albedoSize, i * F + F / 2, j * F + F / 2);
                expect(c, `frame ${i},${j}`).toEqual(face.color.map(v => v * 255));
                const n = at(bake.normal, bake.normalSize, i * 16 + 8, j * 16 + 8).slice(0, 3).map(v => v / 255 * 2 - 1);
                expect(dot(n, face.n), `frame ${i},${j} normal`).toBeGreaterThan(0.98);
            }
        }
    });

    it('frames the image with right = t and up = b (seen from above, the top face is up)', () => {
        // The frame nearest a view from 35 degrees up, toward +Z.
        let best = [0, 0], bestScore = -1;
        for (let j = 0; j < frames; j++) for (let i = 0; i < frames; i++) {
            const s = dot(frameDirection(i, j, frames), [0, 0.7, 1]);
            if (s > bestScore) { bestScore = s; best = [i, j]; }
        }
        const [i, j] = best;
        const d = frameDirection(i, j, frames);
        expect(d[1]).toBeGreaterThan(0.2);
        // Down the frame's centre column: the green top face, then the blue +Z face below it.
        const rows = (want: number[]) => {
            const out: number[] = [];
            for (let y = 0; y < F; y++) {
                const c = at(bake.albedo, bake.albedoSize, i * F + F / 2, j * F + y);
                if (c[0] === want[0] && c[1] === want[1] && c[2] === want[2] && c[3] === 255) out.push(y);
            }
            return out;
        };
        const green = rows([0, 255, 0]), blue = rows([0, 0, 255]);
        expect(green.length).toBeGreaterThan(2);
        expect(blue.length).toBeGreaterThan(2);
        expect(Math.max(...green)).toBeLessThan(Math.min(...blue));
        // And right = t, so the image is not mirrored: from between +X and +Z, red (+X) is right of blue (+Z).
        let k = [0, 0], ks = -1;
        for (let jj = 0; jj < frames; jj++) for (let ii = 0; ii < frames; ii++) {
            const s = dot(frameDirection(ii, jj, frames), [0.7, 0.2, 0.7]);
            if (s > ks) { ks = s; k = [ii, jj]; }
        }
        const cols = (want: number[]) => {
            const out: number[] = [];
            for (let x = 0; x < F; x++) {
                const c = at(bake.albedo, bake.albedoSize, k[0] * F + x, k[1] * F + F / 2);
                if (c[0] === want[0] && c[1] === want[1] && c[2] === want[2] && c[3] === 255) out.push(x);
            }
            return out;
        };
        expect(Math.max(...cols([0, 0, 255]))).toBeLessThan(Math.min(...cols([255, 0, 0])));
    });

    it('leaves the corners empty and dilates colour into them without covering them', () => {
        const [r, g, b, a] = at(bake.albedo, bake.albedoSize, 1, 1);
        expect(a).toBe(0);
        // Frame (0, 0)'s border is beyond any dilation from the cube, but the texels just outside the
        // silhouette carry its colour.
        expect(r + g + b).toBe(0);
        let dilated = 0;
        for (let y = 0; y < F; y++) for (let x = 0; x < F; x++) {
            const [rr, gg, bb, aa] = at(bake.albedo, bake.albedoSize, x, y);
            if (aa === 0 && rr + gg + bb > 0) dilated++;
        }
        expect(dilated).toBeGreaterThan(0);
    });

    it('reports the share the runtime cutout keeps', () => {
        expect(bake.coverage).toBeGreaterThan(0.2);
        expect(bake.coverage).toBeLessThan(0.9);
    });

    it('lets the blended lookup recover the facing colour from any direction', () => {
        // The shader's lookup at the impostor centre: the three nearest frames' centre texels, weighted.
        for (const view of [[0.2, 0.4, 0.9], [0.9, 0.3, 0.1], [0.05, 0.99, 0.1]] as V3[]) {
            const l = Math.hypot(...view);
            const v: V3 = [view[0] / l, view[1] / l, view[2] / l];
            const { cells, weights } = frameBlend(v, frames);
            const mix = [0, 0, 0];
            cells.forEach(([i, j], k) => {
                const c = at(bake.albedo, bake.albedoSize, i * F + F / 2, j * F + F / 2);
                for (let ch = 0; ch < 3; ch++) mix[ch] += c[ch] * weights[k];
            });
            const face = FACES.reduce((best, f) => dot(f.n, v) > dot(best.n, v) ? f : best);
            const want = face.color.slice(0, 3).map(x => x * 255);
            expect(Math.hypot(mix[0] - want[0], mix[1] - want[1], mix[2] - want[2]), `view ${view}`).toBeLessThan(80);
        }
    });
});

describe('normal rounding', () => {
    it('leans a face normal toward the outward direction, by the amount asked', () => {
        const at4 = (b: ReturnType<typeof bakeOctahedralImpostor>, i: number, j: number, x: number, y: number) => {
            const o = ((j * 16 + y) * b.normalSize + i * 16 + x) * 4;
            return [0, 1, 2].map(k => b.normal[o + k] / 255 * 2 - 1);
        };
        const opts = { frames: 6, frameSize: 32, normalFrameSize: 16 };
        const flat = bakeOctahedralImpostor(cube(), { ...opts, roundNormals: 0 });
        const round = bakeOctahedralImpostor(cube(), { ...opts, roundNormals: 1 });
        // Near the top of a level frame looking along +Z-ish: the face says +Z, the sphere says up-ish.
        let best = [0, 0], s = -1;
        for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) {
            const v = dot(frameDirection(i, j, 6), [0, 0, 1]);
            if (v > s) { s = v; best = [i, j]; }
        }
        const f = at4(flat, best[0], best[1], 8, 5), r = at4(round, best[0], best[1], 8, 5);
        expect(f[1]).toBeLessThan(r[1]);
    });
});

describe('alpha cutout', () => {
    it('treats texels below the cutoff as holes the far side shows through', () => {
        // A 2x1 texture: left texel transparent, right texel opaque white.
        const tex = new Uint8ClampedArray([255, 255, 255, 0, 255, 255, 255, 255]);
        const sample = rgbaSampler(tex, 2, 1);
        const quad: OctahedralBakePart = {
            positions: [-1, 0, 0, 1, 0, 0, 1, 2, 0, -1, 2, 0],
            normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
            uvs: [0, 1, 1, 1, 1, 0, 0, 0],
            indices: [0, 1, 2, 0, 2, 3],
            sample, cutoff: 0.5,
        };
        const solid = bakeOctahedralImpostor([{ ...quad, sample: null }], { frames: 4, frameSize: 32 });
        const cut = bakeOctahedralImpostor([quad], { frames: 4, frameSize: 32 });
        expect(cut.coverage).toBeGreaterThan(solid.coverage * 0.3);
        expect(cut.coverage).toBeLessThan(solid.coverage * 0.7);
    });
});
