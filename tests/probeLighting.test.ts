import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { LightProbeNode } from '../src/core/scene/nodes/lightProbeNode';
import {
    MAX_LIGHTING_PROBES, boxProjectedDirection, createLightingProbeArrays, createReflectionProbeArrays, orderLightingProbes,
    orderReflectionProbes, packLightingProbes, packReflectionProbes, probeAmbientAt, probeLightingAt,
} from '../src/graphics/render/probeLighting';
import { skyAmbient } from '../src/graphics/particles/particleLighting';
import {
    SH_FLOATS, encodeRGBE, projectEquirectToSH, shEvalIrradiance,
} from '../src/graphics/shProject';
import type { Texture } from '../src/graphics/texture';

/** Stand-in baked maps: nothing here samples them. No GL context. */
const fakeCube = () => ({ delete() {} }) as unknown as Texture;

/** A flat (direction-free) radiance-form SH set of irradiance E/pi = `level`, per channel. */
function flatSH(level: [number, number, number]): Float32Array {
    // shEval's DC term is c4 L00 = E, and the pass divides by pi: L00 = pi level / c4.
    const sh = new Float32Array(SH_FLOATS);
    for (let c = 0; c < 3; c++) sh[c] = Math.PI * level[c] / 0.886227;
    return sh;
}

let layerCounter = 0;
function lightingProbe(name: string, position: [number, number, number], options: ConstructorParameters<typeof LightProbeNode>[1] = {},
                       level: [number, number, number] = [1, 1, 1]): LightProbeNode {
    const probe = new LightProbeNode(name, options, `id-${name}`);
    probe.setPosition(vec3.fromValues(...position));
    probe.updateTransforms();
    probe.setBakedMaps(fakeCube());
    probe.setIrradianceSH(flatSH(level));
    probe.reflectionLayer = layerCounter++;
    return probe;
}

describe('light probe lighting order (orderLightingProbes)', () => {
    it('puts the most specific volume first, unbounded last, the same from anywhere', () => {
        const hamlet = lightingProbe('hamlet', [0, 0, 0], { size: [100, 30, 70] });
        const room = lightingProbe('room', [30, 0, 10], { size: [10, 5, 18] });
        const global = lightingProbe('global', [0, 0, 0]);
        const probes = [global, hamlet, room];
        const fromStreet = orderLightingProbes(probes, vec3.fromValues(-40, 2, 0));
        const fromRoom = orderLightingProbes(probes, vec3.fromValues(31, 1, 12));
        expect(fromStreet).toEqual([room, hamlet, global]);
        expect(fromRoom).toEqual(fromStreet);
    });

    it('leaves out probes that do not light, have no coefficients yet, or are out of view', () => {
        const reflectionsOnly = lightingProbe('reflections', [0, 0, 0], { size: [10, 10, 10], affectsLighting: false });
        const pending = new LightProbeNode('pending', { size: [10, 10, 10] });
        pending.setBakedMaps(fakeCube());   // baked, not projected yet
        const behind = lightingProbe('behind', [0, 0, -50], { size: [4, 4, 4] });
        const ahead = lightingProbe('ahead', [0, 0, 50], { size: [4, 4, 4] });
        const visible = (min: vec3, max: vec3) => max[2] > 0;
        expect(orderLightingProbes([reflectionsOnly, pending, behind, ahead], vec3.create(), visible)).toEqual([ahead]);
    });

    it('keeps the volumes nearest the camera past the cap, then orders them by claim', () => {
        const probes: LightProbeNode[] = [];
        for (let i = 0; i < MAX_LIGHTING_PROBES + 4; i++)
            probes.push(lightingProbe(`p${i}`, [i * 10, 0, 0], { size: [2 + (i % 3), 2, 2] }));
        const out = orderLightingProbes(probes, vec3.fromValues(0, 0, 0));
        expect(out).toHaveLength(MAX_LIGHTING_PROBES);
        // The four farthest are the ones dropped.
        for (let i = MAX_LIGHTING_PROBES; i < probes.length; i++) expect(out).not.toContain(probes[i]);
        for (let i = 1; i < out.length; i++) expect(out[i - 1].volumeSize).toBeLessThanOrEqual(out[i].volumeSize);
    });
});

describe('packing for the deferred pass (packLightingProbes)', () => {
    it('scales the coefficients by intensity and pre-exposure and flags unbounded probes', () => {
        const room = lightingProbe('room', [0, 0, 0], { size: [10, 4, 10], blendDistance: 1, intensity: 2 });
        const global = lightingProbe('global', [0, 0, 0]);
        const arrays = createLightingProbeArrays();
        expect(packLightingProbes([room, global], 4, arrays)).toBe(2);
        expect(arrays.sh[0]).toBeCloseTo(room.irradianceSH![0] * 2 * 4, 5);
        expect(arrays.sh[SH_FLOATS]).toBeCloseTo(global.irradianceSH![0] * 4, 5);
        expect(Array.from(arrays.blend.subarray(0, 4))).toEqual([0.1, 0.25, 0.1, 0].map(v => Math.fround(v)));
        expect(arrays.blend[7]).toBe(1);
        // The bounded probe's matrix maps its box to the unit cube: the far corner lands on 0.5.
        const m = arrays.invVolume;
        expect(m[0] * 5 + m[12]).toBeCloseTo(0.5, 5);
    });
});

describe('the probes\' light at a point (probeLightingAt / probeAmbientAt)', () => {
    const room = () => lightingProbe('room', [0, 0, 0], { size: [10, 4, 10], blendDistance: 1 }, [0.1, 0.1, 0.1]);
    const street = () => lightingProbe('street', [0, 0, 0], { size: [60, 20, 60], blendDistance: 2 }, [1, 1, 1]);

    it('takes the room inside the room and the street outside it, nested', () => {
        const list = orderLightingProbes([street(), room()], vec3.create());
        const sh = new Float32Array(SH_FLOATS);
        expect(probeLightingAt(list, vec3.fromValues(0, 0, 0), sh)).toBeCloseTo(1, 5);
        expect(sh[0]).toBeCloseTo(flatSH([0.1, 0.1, 0.1])[0], 5);
        expect(probeLightingAt(list, vec3.fromValues(15, 0, 0), sh)).toBeCloseTo(1, 5);
        expect(sh[0]).toBeCloseTo(flatSH([1, 1, 1])[0], 5);
    });

    it('feathers the room into the street over its blend distance', () => {
        const list = orderLightingProbes([street(), room()], vec3.create());
        const sh = new Float32Array(SH_FLOATS);
        probeLightingAt(list, vec3.fromValues(4.5, 0, 0), sh);   // half way through the room's 1 m feather
        const mid = sh[0] / flatSH([1, 1, 1])[0];
        expect(mid).toBeGreaterThan(0.1);
        expect(mid).toBeLessThan(1);
    });

    it('leaves a point outside every probe to the ambient and sky light', () => {
        const list = orderLightingProbes([room()], vec3.create());
        const sh = new Float32Array(SH_FLOATS);
        expect(probeLightingAt(list, vec3.fromValues(40, 0, 0), sh)).toBe(0);
        expect(Array.from(sh).every(v => v === 0)).toBe(true);
        expect(probeAmbientAt(list, vec3.fromValues(40, 0, 0), [3, 2, 1])).toEqual([3, 2, 1]);
    });

    it('does not depend on where the camera is', () => {
        const probes = [street(), room()];
        const a = orderLightingProbes(probes, vec3.fromValues(0, 1, 0));
        const b = orderLightingProbes(probes, vec3.fromValues(25, 1, 25));
        const sha = new Float32Array(SH_FLOATS), shb = new Float32Array(SH_FLOATS);
        for (const p of [[0, 0, 0], [4.5, 0, 0], [15, 0, 2]] as const) {
            expect(probeLightingAt(a, vec3.fromValues(...p), sha)).toBe(probeLightingAt(b, vec3.fromValues(...p), shb));
            expect(Array.from(sha)).toEqual(Array.from(shb));
        }
    });

    it('gives a flat ambient of the probe\'s mean irradiance inside it', () => {
        const r = room();
        const list = orderLightingProbes([r], vec3.create());
        const out = probeAmbientAt(list, vec3.fromValues(0, 0, 0), [5, 5, 5]);
        const mean = skyAmbient(r.irradianceSH, 1);
        for (let c = 0; c < 3; c++) expect(out[c]).toBeCloseTo(mean[c], 3);
        expect(mean[0]).toBeCloseTo(0.1, 4);
    });
});

describe('a probe\'s irradiance as spherical harmonics (shProject)', () => {
    /** An equirect readback of a field, through skyProject.wgsl's direction mapping and RGBE encoding. */
    function equirect(field: (x: number, y: number, z: number) => number, w: number, h: number): Uint8Array {
        const px = new Uint8Array(w * h * 4);
        for (let row = 0; row < h; row++) {
            const lat = ((row + 0.5) / h - 0.5) * Math.PI;
            for (let col = 0; col < w; col++) {
                const lon = ((col + 0.5) / w - 0.5) * 2 * Math.PI;
                const x = Math.cos(lat) * Math.sin(lon), y = Math.sin(lat), z = -Math.cos(lat) * Math.cos(lon);
                const v = field(x, y, z);
                px.set(encodeRGBE(v, v * 0.5, v * 0.25), (row * w + col) * 4);
            }
        }
        return px;
    }

    it('decodes RGBE across a wide range at 8-bit precision', () => {
        for (const v of [3e4, 1, 0.37, 1e-2, 2e-6]) {
            const [r, , , a] = encodeRGBE(v, 0, 0);
            const decoded = (r / 255) * Math.pow(2, a - 128);
            expect(Math.abs(decoded - v) / v).toBeLessThan(0.01);
        }
    });

    it('turns a probe capture\'s radiance into the irradiance the lighting applies', () => {
        // A capture's radiance L(n) = a + b n_y + c (3 n_z^2 - 1): its irradiance over the cosine lobe is
        // pi (a + 2/3 b n_y + 1/4 c (3 n_z^2 - 1)) (Ramamoorthi & Hanrahan's band factors), and the deferred
        // pass applies E / pi. The projection is of the radiance; the evaluation does the convolution.
        const a = 0.06, b = 0.03, c = 0.012;
        const radiance = (x: number, y: number, z: number) => a + b * y + c * (3 * z * z - 1);
        const sh = projectEquirectToSH(equirect(radiance, 64, 32), 64, 32, [1, 1, 1], 'rgbe');
        for (const n of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0.577, 0.577, 0.577]] as [number, number, number][]) {
            const len = Math.hypot(...n);
            const d: [number, number, number] = [n[0] / len, n[1] / len, n[2] / len];
            const want = a + (2 / 3) * b * d[1] + 0.25 * c * (3 * d[2] * d[2] - 1);
            const got = shEvalIrradiance(sh, d, 0) / Math.PI;
            expect(Math.abs(got - want) / want).toBeLessThan(0.02);
            // The other channels carry their own colour.
            expect(shEvalIrradiance(sh, d, 2) / Math.PI / want).toBeCloseTo(0.25, 1);
        }
    });

    it('keeps the sky\'s RGBM projection as it was', () => {
        // A uniform sky: its L00 is the radiance x Y00 x 4 pi, and nothing above the first band.
        const w = 32, h = 16;
        const px = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) px.set([128, 128, 128, 8], i * 4);
        const r = (128 / 255) * (8 / 255 * 64);
        const sh = projectEquirectToSH(px, w, h, [1, 1, 1], 'rgbm');
        expect(sh[0]).toBeCloseTo(r * 0.282095 * 4 * Math.PI, 3);
        expect(Math.abs(sh[4])).toBeLessThan(1e-4);
    });
});

describe('light probe reflections per pixel (orderReflectionProbes / packReflectionProbes)', () => {
    it('orders reflecting probes like the lighting ones, the same from anywhere, and skips those without a layer', () => {
        const hamlet = lightingProbe('r-hamlet', [0, 0, 0], { size: [100, 30, 70], affectsLighting: false });
        const room = lightingProbe('r-room', [30, 0, 10], { size: [10, 5, 18] });
        const global = lightingProbe('r-global', [0, 0, 0], { affectsLighting: false });
        const lightingOnly = lightingProbe('r-lit', [0, 0, 0], { size: [4, 4, 4], affectsReflections: false });
        const unfiltered = lightingProbe('r-none', [0, 0, 0], { size: [3, 3, 3] });
        unfiltered.reflectionLayer = -1;
        const probes = [global, hamlet, room, lightingOnly, unfiltered];
        const a = orderReflectionProbes(probes, vec3.fromValues(-40, 2, 0));
        const b = orderReflectionProbes(probes, vec3.fromValues(31, 1, 12));
        expect(a).toEqual([room, hamlet, global]);
        expect(b).toEqual(a);
    });

    it('packs each probe\'s layer, intensity x pre-exposure, box projection and capture point', () => {
        const room = lightingProbe('p-room', [3, 1, 2], { size: [10, 4, 10], intensity: 2, boxProjection: true });
        const open = lightingProbe('p-open', [0, 0, 0], { size: [40, 20, 40], boxProjection: false });
        const global = lightingProbe('p-global', [0, 0, 0], { boxProjection: true });
        const arrays = createReflectionProbeArrays();
        expect(packReflectionProbes([room, open, global], 8, arrays)).toBe(3);
        expect(arrays.params[0]).toBe(room.reflectionLayer);
        expect(arrays.params[1]).toBeCloseTo(16, 5);
        expect(arrays.params[2]).toBe(1);
        expect(arrays.params[6]).toBe(0);                   // flagged off
        expect(arrays.params[10]).toBe(0);                  // unbounded: never box-projected
        expect(arrays.blend[11]).toBe(1);                   // unbounded flag
        expect(Array.from(arrays.capture.subarray(0, 3))).toEqual([3, 1, 2]);
    });
});

describe('box projection (boxProjectedDirection)', () => {
    const roomProbe = () => lightingProbe('box', [0, 0, 0], { size: [10, 4, 10] });

    it('is the reflection itself seen from the capture point', () => {
        const probe = roomProbe();
        const d = boxProjectedDirection([1, 0, 0], [0, 0, 0], probe.invVolumeMatrix, [0, 0, 0]);
        expect(d[0]).toBeCloseTo(1, 5);
        expect(Math.abs(d[1]) + Math.abs(d[2])).toBeCloseTo(0, 5);
    });

    it('turns toward where the ray leaves the box, from a point off centre', () => {
        // Standing 4 m along +z and looking along +x: the ray meets the x = 5 wall at (5, 0, 4), which the
        // probe at the centre saw toward (5, 0, 4), not straight along +x.
        const probe = roomProbe();
        const d = boxProjectedDirection([1, 0, 0], [0, 0, 4], probe.invVolumeMatrix, [0, 0, 0]);
        const len = Math.hypot(5, 0, 4);
        expect(d[0]).toBeCloseTo(5 / len, 4);
        expect(d[2]).toBeCloseTo(4 / len, 4);
    });

    it('exits through the nearest wall of a turned box', () => {
        const probe = lightingProbe('turned', [0, 0, 0], { size: [20, 4, 4] });
        probe.setRotation(vec3.fromValues(0, 90, 0));
        probe.updateTransforms();
        // Turned 90 degrees, the long axis runs along z: looking along +x from 1 m off the axis meets the
        // x = 2 wall.
        const d = boxProjectedDirection([1, 0, 0], [0, 0, 1], probe.invVolumeMatrix, [0, 0, 0]);
        const len = Math.hypot(2, 1);
        expect(d[0]).toBeCloseTo(2 / len, 3);
        expect(d[2]).toBeCloseTo(1 / len, 3);
    });
});
