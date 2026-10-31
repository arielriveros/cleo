import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Geometry } from '../src/core/geometry';
import { SkinnedCloth } from '../src/physics/cloth/skinnedCloth';
import { parseSkinnedCloth } from '../src/physics/cloth/skinnedClothData';
import { gridIndices } from '../src/physics/cloth/xpbdCloth';

// Cloth that is part of a skinned mesh: a 3 x 8 strip hanging from a "hip" bone, sewn along its top row.
// The model, node and animator are stand-ins with just what SkinnedCloth reads; nothing here draws.

const COLS = 3, ROWS = 8, H = 0.7;

function rig() {
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        positions.push((c / (COLS - 1) - 0.5) * 0.4, 1 - r / (ROWS - 1) * H, 0);
        normals.push(0, 0, 1); uvs.push(c / (COLS - 1), r / (ROWS - 1));
    }
    const geometry = new Geometry(positions, normals, uvs, [], [], gridIndices(COLS, ROWS), false);
    const n = COLS * ROWS;
    // Everything on joint 0, fully weighted.
    const jointIndices = new Float32Array(n * 4), jointWeights = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) jointWeights[i * 4] = 1;
    const uploads: { first: number; stride: number; data: Float32Array }[] = [];
    const model = {
        geometry, jointIndices, jointWeights, skin: null,
        mesh: { updateVertexRange: (first: number, stride: number, data: Float32Array) => uploads.push({ first, stride, data: data.slice() }) },
    };
    const bone = mat4.create();
    const node: any = {
        model, initialized: true, vertexAttributes: ['position', 'normal', 'uv'], scene: null,
        worldTransform: mat4.create(), worldPosition: vec3.create(),
        animator: { getFinalBoneMatrices: () => [bone] },
    };
    const vertices = [...Array(n).keys()];
    const weights = vertices.map(v => Math.floor(v / COLS) === 0 ? 0 : Math.floor(v / COLS) / (ROWS - 1));
    const data = parseSkinnedCloth({ vertices, weights, maxDistance: 0.3 })!;
    return { node, bone, uploads, cloth: new SkinnedCloth(node, data) };
}

const run = (cloth: SkinnedCloth, seconds: number, each?: (t: number) => void) => {
    for (let t = 0; t < seconds; t += 1 / 60) { each?.(t); cloth.step(1 / 60, true); }
};

describe('skinned cloth', () => {
    it('reads its data tolerantly', () => {
        expect(parseSkinnedCloth(null)).toBeNull();
        expect(parseSkinnedCloth({ vertices: [1, 2], weights: [0.5] })).toBeNull();
        expect(parseSkinnedCloth({ vertices: [1], weights: [3] })!.weights).toEqual([1]);
    });

    it('keeps its sewn edge on the skin and lets the hem swing, within its max distance', () => {
        const { bone, cloth } = rig();
        expect(cloth.particleCount).toBe(COLS * ROWS);
        // The hip swings sideways for a second, then stops.
        run(cloth, 1, t => mat4.fromTranslation(bone, [Math.min(t, 0.5) * 1.2, 0, 0]));
        const p = cloth.positions!;
        const shift = 0.6;
        // Top row exactly where the bone carries it.
        for (let c = 0; c < COLS; c++) expect(p[c * 3]).toBeCloseTo((c / (COLS - 1) - 0.5) * 0.4 + shift, 4);
        // Every particle within weight × maxDistance of its skinned position (plus a little solver slack).
        for (let r = 1; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
            const i = r * COLS + c;
            const target = [(c / (COLS - 1) - 0.5) * 0.4 + shift, 1 - r / (ROWS - 1) * H, 0];
            const d = Math.hypot(p[i * 3] - target[0], p[i * 3 + 1] - target[1], p[i * 3 + 2] - target[2]);
            expect(d).toBeLessThanOrEqual(r / (ROWS - 1) * 0.3 + 1e-3);
        }
    });

    it('uploads bind positions that the bone carries onto the simulated ones', () => {
        const { bone, uploads, cloth } = rig();
        mat4.fromTranslation(bone, [0.25, 0, 0]);
        run(cloth, 0.5);
        const last = uploads[uploads.length - 1];
        expect(last.first).toBe(0);
        expect(last.stride).toBe(8);   // position, normal, uv
        const p = cloth.positions!;
        for (let v = 0; v < COLS * ROWS; v++) {
            const bind = last.data.subarray(v * 8, v * 8 + 3);
            // bone * bind = simulated (the bone is a pure translation here).
            expect(bind[0] + 0.25).toBeCloseTo(p[v * 3], 4);
            expect(bind[1]).toBeCloseTo(p[v * 3 + 1], 4);
        }
    });

    it('goes back on the skin when play stops', () => {
        const { uploads, cloth } = rig();
        run(cloth, 0.3);
        cloth.step(1 / 60, false);
        expect(cloth.positions).toBeNull();
        const restored = uploads[uploads.length - 1].data;
        // The authored bind positions again: the hem at y = 1 - H.
        expect(restored[(ROWS - 1) * COLS * 8 + 1]).toBeCloseTo(1 - H, 5);
    });
});

describe('skinned cloth: backstop and fitted colliders', () => {
    /** The strip again, with its data carrying a backstop and/or fitted colliders. */
    function rigWith(extra: Record<string, unknown>) {
        const base = rig();
        const n = COLS * ROWS;
        const vertices = [...Array(n).keys()];
        const weights = vertices.map(v => Math.floor(v / COLS) === 0 ? 0 : 1);
        const data = parseSkinnedCloth({ vertices, weights, maxDistance: 0.5, ...extra })!;
        return { ...base, cloth: new SkinnedCloth(base.node, data) };
    }

    it('never lets the cloth sink behind where the skin holds it by more than the backstop', () => {
        // A capsule behind the strip (at -z) that the cloth hangs in front of; wind blowing it backward.
        const { node, cloth } = rigWith({ backstop: 0.01, colliders: [{ joint: 0, a: [-1, 0.6, -0.2], b: [1, 0.6, -0.2], radius: 0.1 }] });
        node.scene = { wind: { directionXZ: [0, -1], strength: 3, gustScale: 18, gustSpeed: 4 } };
        run(cloth, 1.5);
        const p = cloth.positions!;
        // The outward direction is away from the capsule axis (towards +z here, near the strip's middle):
        // no particle may end up more than 1 cm behind its rest plane, z = 0.
        for (let i = COLS; i < COLS * ROWS; i++) expect(p[i * 3 + 2]).toBeGreaterThan(-0.0101 - 0.02);
    });

    it('carries fitted colliders with their joint', () => {
        const { bone, cloth } = rigWith({ colliders: [{ joint: 0, a: [0, 0.5, 0.15], b: [0, 0.9, 0.15], radius: 0.12 }] });
        mat4.fromTranslation(bone, [0.3, 0, 0]);
        run(cloth, 0.5);
        const p = cloth.positions!;
        // Every free particle stays outside the moved capsule (axis now at x = 0.3, z = 0.15).
        for (let i = COLS; i < COLS * ROWS; i++) {
            const y = Math.min(0.9, Math.max(0.5, p[i * 3 + 1]));
            const d = Math.hypot(p[i * 3] - 0.3, p[i * 3 + 1] - y, p[i * 3 + 2] - 0.15);
            expect(d).toBeGreaterThan(0.12 - 1e-3);
        }
    });
});

describe('skinned cloth: no spikes', () => {
    it('keeps every edge near its rest length while a tight backstop and max distance hold it', () => {
        const base = rig();
        const n = COLS * ROWS;
        const vertices = [...Array(n).keys()];
        const weights = vertices.map(v => Math.floor(v / COLS) === 0 ? 0 : Math.floor(v / COLS) / (ROWS - 1));
        const cloth = new SkinnedCloth(base.node, parseSkinnedCloth({ vertices, weights, maxDistance: 0.06, backstop: 0.002, gravityScale: 1.5, substeps: 10 })!);
        run(cloth, 1.5, t => mat4.fromTranslation(base.bone, [Math.sin(t * 6) * 0.3, 0, Math.cos(t * 5) * 0.2]));
        const p = cloth.positions!;
        const rest = (a: number, b: number) => {
            const ra = [(a % COLS / (COLS - 1) - 0.5) * 0.4, 1 - Math.floor(a / COLS) / (ROWS - 1) * H];
            const rb = [(b % COLS / (COLS - 1) - 0.5) * 0.4, 1 - Math.floor(b / COLS) / (ROWS - 1) * H];
            return Math.hypot(ra[0] - rb[0], ra[1] - rb[1]);
        };
        let worst = 0;
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
            const i = r * COLS + c;
            for (const j of [c + 1 < COLS ? i + 1 : -1, r + 1 < ROWS ? i + COLS : -1]) {
                if (j < 0) continue;
                const d = Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]);
                worst = Math.max(worst, d / rest(i, j));
            }
        }
        expect(worst).toBeLessThan(1.1);
    });
});
