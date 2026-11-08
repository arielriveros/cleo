import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { GIVolumeNode } from '../src/core/scene/nodes/giVolumeNode';
import { GI_PROBE_ACTIVE, GI_PROBE_INACTIVE } from '../src/graphics/render/gi/giClassify';
import {
    GI_AMBIENT_CUBE_FLOATS, GI_SH_FLOATS, addAmbientCubeSH, ambientCubeAt, evalAmbientCube, giAmbientAt,
    giLightingAt, giShEval, orderGiVolumes, type GiVolumeCpu,
} from '../src/graphics/render/gi/giLighting';

/** A CPU volume over a node, every probe active, its cube from `cubeOf(probe)`. */
function cpuVolume(node: GIVolumeNode, cubeOf: (p: number) => number[]): GiVolumeCpu {
    node.updateTransforms();
    const n = node.probeCount;
    const ambient = new Float32Array(n * GI_AMBIENT_CUBE_FLOATS);
    for (let p = 0; p < n; p++) ambient.set(cubeOf(p), p * GI_AMBIENT_CUBE_FLOATS);
    return {
        counts: node.probeCounts, worldToGrid: node.worldToGrid(mat4.create()),
        weightAt: (q) => node.weightAt(q as vec3), intensity: node.intensity, additive: node.additive,
        states: new Uint8Array(n).fill(GI_PROBE_ACTIVE), ambient,
    };
}

const uniform = (c: number) => Array(18).fill(c);
/** A cube lit from +Y only: up-facing irradiance `up`, the rest 0. */
const fromAbove = (up: number) => { const c = Array(18).fill(0); c[6] = c[7] = c[8] = up; return c; };

describe('ambient cube to SH', () => {
    it('gives back a uniform cube as the same value in every direction', () => {
        const sh = new Float32Array(GI_SH_FLOATS);
        addAmbientCubeSH(uniform(0.7), 1, sh);
        for (const n of [[0, 0, 1], [1, 0, 0], [0, -1, 0], [0.6, 0.48, -0.64]]) {
            for (let c = 0; c < 3; c++) expect(giShEval(sh, n, c) / Math.PI).toBeCloseTo(0.7, 4);
        }
    });

    it('keeps a one-sided cube one-sided: bright facing it, dark facing away', () => {
        const sh = new Float32Array(GI_SH_FLOATS);
        const cube = fromAbove(1);
        addAmbientCubeSH(cube, 1, sh);
        const up = giShEval(sh, [0, 1, 0], 0) / Math.PI;
        const side = giShEval(sh, [1, 0, 0], 0) / Math.PI;
        const down = giShEval(sh, [0, -1, 0], 0) / Math.PI;
        expect(up).toBeGreaterThan(0.8);
        expect(up).toBeLessThan(1.15);
        expect(Math.abs(side)).toBeLessThan(0.15);
        // L2 cannot hold a hard edge: what faces away rings up to about an eighth (light probes' SH does too).
        expect(down).toBeLessThan(0.15);
        // The L2 fit tracks the cube's own evaluation closely in between.
        const n = [0.6, 0.8, 0];
        const ref = [0, 0, 0];
        evalAmbientCube(cube, n, ref);
        expect(Math.abs(giShEval(sh, n, 0) / Math.PI - ref[0])).toBeLessThan(0.15);
    });

    it('accumulates with a scale', () => {
        const sh = new Float32Array(GI_SH_FLOATS);
        addAmbientCubeSH(uniform(1), 0.25, sh);
        addAmbientCubeSH(uniform(1), 0.5, sh);
        expect(giShEval(sh, [0, 0, 1], 1) / Math.PI).toBeCloseTo(0.75, 4);
    });
});

describe('ambient cubes in a volume', () => {
    it('blends the cage trilinearly', () => {
        const node = new GIVolumeNode('v', { size: [2, 2, 2], probeCounts: [2, 2, 2], blendDistance: 0 });
        // Probes with i = 1 (the +x side) are twice as bright.
        const v = cpuVolume(node, p => uniform(p % 2 === 1 ? 2 : 1));
        const out = new Float32Array(18);
        expect(ambientCubeAt(v, [0, 0, 0], out)).toBe(1);
        expect(out[0]).toBeCloseTo(1.5, 5);
        ambientCubeAt(v, [0.5, 0, 0], out);
        expect(out[0]).toBeCloseTo(1.75, 5);
    });

    it('leaves inactive probes out and renormalizes, with less coverage when few are left', () => {
        const node = new GIVolumeNode('v', { size: [2, 2, 2], probeCounts: [2, 2, 2] });
        const v = cpuVolume(node, p => uniform(p % 2 === 1 ? 2 : 1));
        const states = v.states as Uint8Array;
        for (let p = 0; p < 8; p += 2) states[p] = GI_PROBE_INACTIVE;   // only the bright side is left
        const out = new Float32Array(18);
        const coverage = ambientCubeAt(v, [0, 0, 0], out);
        expect(out[0]).toBeCloseTo(2, 5);
        expect(coverage).toBe(1);   // half the weight is left, over the full-coverage threshold
        states.fill(GI_PROBE_INACTIVE);
        expect(ambientCubeAt(v, [0, 0, 0], out)).toBe(0);
        // One probe left, at the far corner from the point: a sliver of weight, part coverage.
        states[7] = GI_PROBE_ACTIVE;
        const sliver = ambientCubeAt(v, [-0.5, -0.5, -0.5], out);
        expect(sliver).toBeGreaterThan(0);
        expect(sliver).toBeLessThan(0.25);
    });
});

describe('giLightingAt', () => {
    it('lets the smaller volume claim first and the rest fall through', () => {
        const room = new GIVolumeNode('room', { size: [4, 4, 4], probeCounts: [2, 2, 2], blendDistance: 0 });
        const hamlet = new GIVolumeNode('hamlet', { size: [40, 40, 40], probeCounts: [3, 3, 3], blendDistance: 0 });
        const volumes = orderGiVolumes([hamlet, room], [0, 0, 0]);
        expect(volumes.map(v => v.name)).toEqual(['room', 'hamlet']);
        const cpu = volumes.map(v => cpuVolume(v, () => uniform(v === room ? 0.1 : 5)));
        const sh = new Float32Array(GI_SH_FLOATS);
        expect(giLightingAt(cpu, [0, 0, 0], sh)).toBeCloseTo(1, 6);
        expect(giShEval(sh, [0, 1, 0], 0) / Math.PI).toBeCloseTo(0.1, 3);
        expect(giLightingAt(cpu, [10, 0, 0], sh)).toBeCloseTo(1, 6);
        expect(giShEval(sh, [0, 1, 0], 0) / Math.PI).toBeCloseTo(5, 3);
        expect(giLightingAt(cpu, [100, 0, 0], sh)).toBe(0);
        expect(sh.every(x => x === 0)).toBe(true);
    });

    it('never claims more than the whole point across overlapping feathers', () => {
        const a = new GIVolumeNode('a', { size: [4, 4, 4], probeCounts: [2, 2, 2], blendDistance: 2 });
        const b = new GIVolumeNode('b', { size: [6, 6, 6], probeCounts: [2, 2, 2], blendDistance: 3 });
        const cpu = orderGiVolumes([a, b], [0, 0, 0]).map(v => cpuVolume(v, () => uniform(1)));
        const sh = new Float32Array(GI_SH_FLOATS);
        for (const x of [0, 0.5, 1, 1.5, 1.9, 2.5]) {
            const share = giLightingAt(cpu, [x, 0, 0], sh);
            expect(share).toBeLessThanOrEqual(1 + 1e-6);
            // A uniform 1 everywhere, so the blend evaluates to exactly the share it took.
            expect(giShEval(sh, [0, 0, 1], 0) / Math.PI).toBeCloseTo(share, 4);
        }
    });

    it('scales by the volume intensity and the caller scale', () => {
        const node = new GIVolumeNode('v', { size: [2, 2, 2], probeCounts: [2, 2, 2], intensity: 2 });
        const cpu = [cpuVolume(node, () => uniform(1))];
        const sh = new Float32Array(GI_SH_FLOATS);
        giLightingAt(cpu, [0, 0, 0], sh, 0.5);
        expect(giShEval(sh, [1, 0, 0], 2) / Math.PI).toBeCloseTo(1, 4);
        const flat = [0, 0, 0];
        expect(giAmbientAt(cpu, [0, 0, 0], flat, 0.5)).toBeCloseTo(1, 6);
        expect(flat[0]).toBeCloseTo(1, 5);
    });

    it('gives a one-sided cube its mean as the flat ambient', () => {
        const node = new GIVolumeNode('v', { size: [2, 2, 2], probeCounts: [2, 2, 2] });
        const cpu = [cpuVolume(node, () => fromAbove(6))];
        const flat = [0, 0, 0];
        giAmbientAt(cpu, [0, 0, 0], flat);
        expect(flat[0]).toBeCloseTo(1, 5);
    });

    it('gives an additive volume its light without taking the fill from under it', () => {
        const outer = cpuVolume(new GIVolumeNode('v', { size: [2, 2, 2], probeCounts: [2, 2, 2], additive: true }), () => uniform(1));
        const flat = [0, 0, 0];
        expect(giAmbientAt([outer], [0, 0, 0], flat)).toBe(0);
        expect(flat).toEqual([1, 1, 1]);
        const sh = new Float32Array(GI_SH_FLOATS);
        expect(giLightingAt([outer], [0, 0, 0], sh)).toBe(0);
        expect(giShEval(sh, [0, 1, 0], 0) / Math.PI).toBeCloseTo(1, 4);
        // A replacing volume nested in it claims first, and replaces its share.
        const inner = cpuVolume(new GIVolumeNode('in', { size: [1, 1, 1], probeCounts: [2, 2, 2], blendDistance: 0 }), () => uniform(3));
        expect(giAmbientAt([inner, outer], [0, 0, 0], flat)).toBeCloseTo(1, 6);
        expect(flat[0]).toBeCloseTo(3, 5);
    });
});

describe('orderGiVolumes', () => {
    it('skips disabled and unseen volumes and keeps the nearest past the cap', () => {
        const vols = Array.from({ length: 5 }, (_, i) => {
            const v = new GIVolumeNode(`v${i}`, { size: [2 + i, 2, 2] });
            v.setPosition([i * 10, 0, 0]);
            v.updateTransforms();
            return v;
        });
        vols[1].enabled = false;
        const seen = orderGiVolumes(vols, [0, 0, 0], (min) => min[0] < 35);
        expect(seen.map(v => v.name)).toEqual(['v0', 'v2', 'v3']);
        const capped = orderGiVolumes(vols, [40, 0, 0], undefined, 2);
        expect(capped.map(v => v.name).sort()).toEqual(['v3', 'v4']);
        // Claim order is by size, whatever the distance cut kept.
        expect(capped[0].volumeSize).toBeLessThan(capped[1].volumeSize);
    });
});
