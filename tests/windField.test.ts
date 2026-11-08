import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    WIND_FIELD_CONSTANTS, WIND_REFERENCE_SPEED, MAX_WIND_SOURCES, WIND_SOURCE_FLOATS,
    windPcg, windLatticeHash, windPerlin, windPerlinGrad, windGustAt, windVeerAt, sampleWindField,
    packWindSources, WindFieldSnapshot, sampleSceneWind, windFieldClock,
} from '../src/core/wind/windField';
import { WindNode } from '../src/core/scene/nodes/windNode';
import { ForceFieldNode, type ForceFieldOptions } from '../src/core/scene/nodes/forceFieldNode';
import { FORCE_FIELD_PRESETS } from '../src/core/scene/nodes/forceFieldPresets';
import { Scene } from '../src/core/scene/scene';
import { packFrameFields } from '../src/particles/particleFields';
import { packEmitter, SIM } from '../src/particles/particlePack';
import { defaultEmitter, makeModule } from '../src/particles/particleSystemAsset';
import { windGust } from '../src/physics/cloth/xpbdCloth';

// The wind as a vector field (Ghost of Tsushima's): one function on the CPU (core/wind/windField.ts) and
// in chunks/windField.wgsl. There is no GPU here, so the WGSL is held to the TS by its literals and its
// shape, and the TS is held to what the field must do.

const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks');
const chunk = readFileSync(join(WGSL, 'windField.wgsl'), 'utf-8');

/** [dirX, dirZ, strength, wavelength, time, gustSpeed, gustiness, veer(rad)] */
const P = (o: Partial<{ dir: [number, number]; strength: number; lambda: number; t: number; speed: number; gustiness: number; veer: number }> = {}) => {
    const dir = o.dir ?? [1, 0];
    return [dir[0], dir[1], o.strength ?? 1, o.lambda ?? 18, o.t ?? 0, o.speed ?? 4, o.gustiness ?? 0.8, (o.veer ?? 0) * Math.PI / 180];
};

function pack(...options: ForceFieldOptions[]): { sources: Float32Array; count: number } {
    const fields = options.map((o, i) => new ForceFieldNode(`f${i}`, { affectsWind: true, ...o }));
    const sources = new Float32Array(MAX_WIND_SOURCES * WIND_SOURCE_FLOATS);
    return { sources, count: packWindSources(fields, sources) };
}

const v = (params: number[], src: { sources: Float32Array; count: number } | null, x: number, y: number, z: number) =>
    sampleWindField(params, src?.sources ?? [], src?.count ?? 0, x, y, z).velocity;

// ---- Noise ------------------------------------------------------------------------------------------

describe('the noise both sides share', () => {
    it('the PCG hash is the u32 one, bit for bit (the vectors particleCommon.wgsl pcgHash gives)', () => {
        expect(windPcg(0)).toBe(129708002);
        expect(windPcg(1)).toBe(2831084092);
        expect(windPcg(0xffffffff)).toBe(windPcg(-1));
        for (const x of [0, 1, 7, 123456, 0x7fffffff, 0x80000000, 0xffffffff]) {
            const h = windPcg(x);
            expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
        }
        // Negative lattice coordinates wrap like WGSL's u32(i32).
        expect(windLatticeHash(-3, 5)).toBe(windLatticeHash(-3 + 2 ** 32, 5));
    });

    it('Perlin is 0 on every lattice point and stays within its range', () => {
        for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) expect(Math.abs(windPerlin(i, j))).toBe(0);
        let most = 0;
        for (let i = 0; i < 4000; i++) most = Math.max(most, Math.abs(windPerlin(i * 0.731 - 900, i * 0.377 + 41)));
        expect(most).toBeLessThan(1);
        expect(most).toBeGreaterThan(0.3);
    });

    it('the analytic gradient is the derivative of the value', () => {
        const e = 1e-5;
        for (const [x, y] of [[0.3, 0.7], [-5.21, 3.9], [102.5, -77.25], [12.01, 12.99]]) {
            const [n, dx, dy] = windPerlinGrad(x, y);
            expect(n).toBeCloseTo(windPerlin(x, y), 12);
            expect(dx).toBeCloseTo((windPerlin(x + e, y) - windPerlin(x - e, y)) / (2 * e), 5);
            expect(dy).toBeCloseTo((windPerlin(x, y + e) - windPerlin(x, y - e)) / (2 * e), 5);
        }
    });
});

// ---- The base wind ----------------------------------------------------------------------------------

describe('the base wind (GoT: one vector, Perlin gusts scrolled along it)', () => {
    it('gusts stay in 0..1, centred, with the spread of the value noise they replaced', () => {
        let sum = 0, sq = 0, n = 0, lo = 1, hi = 0;
        for (let x = -400; x < 400; x += 3.7) for (let z = -400; z < 400; z += 5.3) {
            const g = windGustAt(x, z, P());
            sum += g; sq += g * g; n++; lo = Math.min(lo, g); hi = Math.max(hi, g);
        }
        const mean = sum / n, std = Math.sqrt(sq / n - mean * mean);
        expect(lo).toBeGreaterThanOrEqual(0);
        expect(hi).toBeLessThanOrEqual(1);
        expect(Math.abs(mean - 0.5)).toBeLessThan(0.03);
        // Value noise 0.7·n + 0.3·n over [0, 1] had a std of 0.163.
        expect(std).toBeGreaterThan(0.163 * 0.85);
        expect(std).toBeLessThan(0.163 * 1.15);
    });

    it('the gust pattern travels downwind at the gust speed', () => {
        const p0 = P({ t: 0 }), p1 = P({ t: 2.5 });
        for (const [x, z] of [[3, 1], [-20, 7], [55, -30]])
            expect(windGustAt(x + 4 * 2.5, z, p1)).toBeCloseTo(windGustAt(x, z, p0), 9);
    });

    it('without veer the air points exactly along the wind; with it, within the veer either way, and varied', () => {
        expect(windVeerAt(10, 20, P())).toEqual([1, 0]);
        const veer = 25 * Math.PI / 180;
        let lo = Infinity, hi = -Infinity;
        for (let x = -300; x < 300; x += 7) for (let z = -300; z < 300; z += 11) {
            const [dx, dz] = windVeerAt(x, z, P({ veer: 25 }));
            expect(Math.hypot(dx, dz)).toBeCloseTo(1, 9);
            const a = Math.atan2(dz, dx);
            lo = Math.min(lo, a); hi = Math.max(hi, a);
        }
        expect(lo).toBeGreaterThanOrEqual(-veer - 1e-9);
        expect(hi).toBeLessThanOrEqual(veer + 1e-9);
        expect(hi - lo).toBeGreaterThan(veer);
    });

    it('strength 1 is a 7 m/s full gust; gustiness 0 is a steady stream, 1 is all gust', () => {
        for (const [x, z] of [[0.5, 0.5], [13, -7], [-40, 22]]) {
            const steady = v(P({ gustiness: 0 }), null, x, 0, z);
            expect(Math.hypot(...steady)).toBeCloseTo(WIND_REFERENCE_SPEED, 9);
            const g = windGustAt(x, z, P());
            expect(Math.hypot(...v(P({ gustiness: 1, strength: 2 }), null, x, 0, z))).toBeCloseTo(2 * 7 * g, 9);
            expect(Math.hypot(...v(P(), null, x, 0, z))).toBeCloseTo(7 * (0.2 + 0.8 * g), 9);
        }
    });

    it('no base wind is still air, whatever the gust parameters say', () => {
        expect(v(P({ strength: 0, veer: 40 }), null, 4, 1, 9)).toEqual([0, 0, 0]);
    });
});

// ---- Local wind ---------------------------------------------------------------------------------------

describe('local wind: the Force Fields that move the air (GoT\'s vorticles)', () => {
    const calm = P({ strength: 0 });

    it('a directional field blows along its +Y at its strength, fading out at its edge', () => {
        const src = pack({ kind: 'directional', shape: 'sphere', radius: 10, strength: 6, falloff: 0.5 });
        expect(v(calm, src, 0, 0, 0)).toEqual([0, 6, 0]);
        expect(v(calm, src, 0, 0, 11)).toEqual([0, 0, 0]);
        const edge = v(calm, src, 0, 0, 8)[1];
        expect(edge).toBeGreaterThan(0);
        expect(edge).toBeLessThan(6);
    });

    it('radial: positive draws air in, negative blasts it out; still at the very centre', () => {
        const blast = pack({ kind: 'radial', shape: 'sphere', radius: 10, strength: -8, falloff: 0.3 });
        expect(v(calm, blast, 4, 0, 0)[0]).toBeCloseTo(8, 6);
        const inflow = pack({ kind: 'radial', shape: 'sphere', radius: 10, strength: 8, falloff: 0.3 });
        expect(v(calm, inflow, 4, 0, 0)[0]).toBeCloseTo(-8, 6);
        expect(Math.hypot(...v(calm, inflow, 1e-6, 0, 0))).toBeLessThan(1e-3);
    });

    it('a vortex spins counter-clockwise (seen from +Y) for positive strength, with a calm eye', () => {
        const whirl = pack({ kind: 'vortex', shape: 'sphere', radius: 10, strength: 5, falloff: 0.5 });
        const at = v(calm, whirl, 4, 0, 0);   // on +X: CCW from above is toward -Z
        expect(at[0]).toBeCloseTo(0, 9);
        expect(at[2]).toBeLessThan(0);
        expect(Math.hypot(...at)).toBeCloseTo(5, 6);
        // The core (a fifth of the radius) turns as a solid body: slower toward the eye.
        expect(Math.hypot(...v(calm, whirl, 1, 0, 0))).toBeCloseTo(2.5, 6);
    });

    it('turbulence is divergence-free eddies about as fast as its strength', () => {
        const eddies = pack({ kind: 'turbulence', shape: 'global', strength: 4, frequency: 0.2 });
        const e = 1e-3;
        let speed = 0, n = 0;
        for (let x = -50; x < 50; x += 3.3) for (let z = -50; z < 50; z += 4.1) {
            const div = (v(calm, eddies, x + e, 0, z)[0] - v(calm, eddies, x - e, 0, z)[0]
                       + v(calm, eddies, x, 0, z + e)[2] - v(calm, eddies, x, 0, z - e)[2]) / (2 * e);
            expect(Math.abs(div)).toBeLessThan(1e-4);
            speed += Math.hypot(...v(calm, eddies, x, 0, z)); n++;
        }
        expect(speed / n).toBeGreaterThan(4 * 0.6);
        expect(speed / n).toBeLessThan(4 * 1.4);
    });

    it('drag is a shelter: the fraction of the wind it blocks, base and local alike', () => {
        const lee = pack({ kind: 'drag', shape: 'box', extents: [5, 5, 5], strength: 0.75, falloff: 0.1 },
                         { kind: 'directional', shape: 'global', strength: 4 });
        const open = v(P(), { ...lee, count: 0 }, 1, 0, 1);
        const sheltered = v(P(), lee, 1, 0, 1);
        const unsheltered = [open[0], open[1] + 4, open[2]];
        for (let i = 0; i < 3; i++) expect(sheltered[i]).toBeCloseTo(unsheltered[i] * 0.25, 9);
    });

    it('a field that does not affect the wind is not wind', () => {
        const field = new ForceFieldNode('particles only', { kind: 'directional', shape: 'global', strength: 9 });
        const out = new Float32Array(16);
        field.packInto(out, 0);
        expect(out[15]).toBe(0);
        expect(sampleWindField(P({ strength: 0 }), out, 1, 0, 0, 0).velocity).toEqual([0, 0, 0]);
        field.affectsWind = true;
        field.packInto(out, 0);
        expect(out[15]).toBe(1);
        expect(sampleWindField(P({ strength: 0 }), out, 1, 0, 0, 0).velocity).toEqual([0, 9, 0]);
    });

    it('the wind presets move the air; the particle presets do not', () => {
        for (const p of FORCE_FIELD_PRESETS)
            expect(p.options.affectsWind, p.id).toBe(p.label.startsWith('Wind:'));
    });

    it('affectsWind survives a save', async () => {
        const f = new ForceFieldNode('f', { affectsWind: true, kind: 'vortex' });
        const json = JSON.parse(JSON.stringify(await f.serialize()));
        expect(new ForceFieldNode('copy', json.forceField).affectsWind).toBe(true);
        expect(new ForceFieldNode('old', { kind: 'vortex' }).affectsWind).toBe(false);
    });
});

// ---- The scene's field ----------------------------------------------------------------------------

describe('the scene\'s field', () => {
    it('only enabled, visible, wind-affecting fields are sources, at most MAX_WIND_SOURCES', () => {
        const fields = Array.from({ length: 12 }, (_, i) => new ForceFieldNode(`f${i}`, { affectsWind: i !== 1 }));
        fields[2].enabled = false;
        fields[3].visible = false;
        const out = new Float32Array(MAX_WIND_SOURCES * WIND_SOURCE_FLOATS);
        expect(packWindSources(fields, out)).toBe(MAX_WIND_SOURCES);
    });

    it('a hidden or calm WindNode gives no base wind; a source alone still makes the field active', () => {
        const scene = new Scene();
        const wind = new WindNode('wind', { strength: 1 });
        scene.addNode(wind);
        const snap = new WindFieldSnapshot();
        expect(snap.capture(scene, 0).baseOn).toBe(true);
        wind.visible = false;
        expect(snap.capture(scene, 0).active).toBe(false);
        scene.addNode(new ForceFieldNode('whirl', { kind: 'vortex', affectsWind: true }));
        expect(snap.capture(scene, 0).active).toBe(true);
        expect(snap.params[2]).toBe(0);
    });

    it('scripts read the field where they stand: WindNode.sampleAt and Scene.windAt agree', () => {
        const scene = new Scene();
        const wind = new WindNode('wind', { direction: 0, strength: 1, gustiness: 0, veer: 0 });
        scene.addNode(wind);
        scene.addNode(new ForceFieldNode('lift', { kind: 'directional', shape: 'sphere', radius: 5, strength: 3, affectsWind: true }));
        const a = wind.sampleAt([0, 0, 0], [0, 0, 0], 1.5);
        const b = scene.windAt([0, 0, 0], [0, 0, 0], 1.5);
        expect(Array.from(a)).toEqual(Array.from(b));
        expect(a[0]).toBeCloseTo(7, 9);
        expect(a[1]).toBeCloseTo(3, 9);
        // Without a WindNode, the local wind alone.
        const bare = new Scene();
        bare.addNode(new ForceFieldNode('lift', { kind: 'directional', shape: 'global', strength: 2, affectsWind: true }));
        expect(Array.from(bare.windAt([9, 9, 9], [0, 0, 0], 0))).toEqual([0, 2, 0]);
    });

    it('the default time is the frame\'s wind clock', () => {
        const scene = new Scene();
        scene.addNode(new WindNode('wind', { gustiness: 1 }));
        windFieldClock.time = 12.5;
        expect(Array.from(scene.windAt([3, 0, 4]))).toEqual(Array.from(sampleSceneWind(scene, [3, 0, 4], [0, 0, 0], 12.5)));
        windFieldClock.time = 0;
    });

    it('cloth catches the same gusts the foliage does', () => {
        for (const [x, z, t] of [[1, 2, 0.5], [-30, 8, 4]])
            expect(windGust(x, z, t, 0.6, -0.8, 20, 5)).toBe(windGustAt(x, z, [0.6, -0.8, 1, 20, t, 5, 0.8, 0]));
    });
});

// ---- Particles ----------------------------------------------------------------------------------------

describe('particles in the same air', () => {
    it('the particle field list carries the wind sources first, then the rest, sixteen in all', () => {
        const fields = [
            new ForceFieldNode('push0'), new ForceFieldNode('wind0', { affectsWind: true }),
            ...Array.from({ length: 20 }, (_, i) => new ForceFieldNode(`f${i}`, { affectsWind: i % 3 === 0 })),
        ];
        const out = new Float32Array(16 * 16);
        const count = packFrameFields(fields, out);
        expect(count).toBe(16);
        const flags = Array.from({ length: count }, (_, i) => out[i * 16 + 15]);
        expect(flags.slice(0, MAX_WIND_SOURCES).every(f => f === 1)).toBe(true);
        expect(flags.slice(MAX_WIND_SOURCES).every(f => f === 0)).toBe(true);
    });

    it('a Wind module on the scene wind sets its bit and multiplier; an old one is unchanged', () => {
        const e = defaultEmitter();
        e.update = [makeModule('wind')];
        const custom = packEmitter(e);
        expect(custom.simMask & SIM.WIND).toBeTruthy();
        expect(custom.simMask & SIM.SCENE_WIND).toBe(0);
        expect(custom.sim.u_windScene).toEqual([0, 0, 0, 0]);
        e.update[0].params.source = 'scene';
        e.update[0].params.scale = 0.6;
        const scene = packEmitter(e);
        expect(scene.simMask & SIM.SCENE_WIND).toBeTruthy();
        expect(scene.sim.u_windScene).toEqual([0.6, 0, 0, 0]);
        // A module saved before the option has no `source`: its own velocity, as before.
        e.update[0].params = { velocity: [1, 0, 0], influence: 1 };
        expect(packEmitter(e).simMask & SIM.SCENE_WIND).toBe(0);
    });

    it('the sim reads the scene wind through the shared chunk and skips the wind records as forces', () => {
        const sim = readFileSync(join(WGSL, 'particleSimCore.wgsl'), 'utf-8');
        expect(sim).toContain('#include "./windField.wgsl"');
        expect(sim).toContain(`const SIM_SCENE_WIND: u32     = ${SIM.SCENE_WIND}u;`);
        expect(sim).toContain('if (windFieldsAsWind && d.w > 0.5) { continue; }');
        expect(sim).toMatch(/windFieldAt\(wp, WindFieldParams\(u_sim\.u_windBase, u_sim\.u_windMotion\)\)/);
    });
});

// ---- The WGSL twin ------------------------------------------------------------------------------------

describe('chunks/windField.wgsl carries the same field', () => {
    const lit = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

    it('declares every shared constant with the same value', () => {
        const C = WIND_FIELD_CONSTANTS;
        expect(chunk).toContain(`const WIND_REFERENCE_SPEED: f32 = ${lit(C.WIND_REFERENCE_SPEED)};`);
        expect(chunk).toContain(`const WIND_GUST_GAIN: f32 = ${lit(C.WIND_GUST_GAIN)};`);
        expect(chunk).toContain(`const WIND_VEER_GAIN: f32 = ${lit(C.WIND_VEER_GAIN)};`);
        expect(chunk).toContain(`const WIND_CURL_GAIN: f32 = ${lit(C.WIND_CURL_GAIN)};`);
        expect(chunk).toContain(`windPerlin(p) * ${C.GUST_OCTAVE_WEIGHTS[0]} + windPerlin(p * ${C.GUST_OCTAVE_SCALE} + vec2<f32>(${lit(C.GUST_OCTAVE_OFFSET[0])}, ${lit(C.GUST_OCTAVE_OFFSET[1])})) * ${C.GUST_OCTAVE_WEIGHTS[1]}`);
        expect(chunk).toContain(`let lambda = ${lit(C.VEER_SCALE)} * max(f.base.w, 0.5);`);
        expect(chunk).toContain(`vec2<f32>(${C.VEER_OFFSET[0]}, ${C.VEER_OFFSET[1]})`);
        expect(chunk).toContain(`let core = max(${C.CORE} * reach, 1e-3);`);
        expect(chunk).toContain(`vec2<f32>(${C.EDDY_DRIFT[0]}, ${C.EDDY_DRIFT[1]}) * t`);
    });

    it('hashes with the same PCG and lattice primes', () => {
        expect(chunk).toContain('let state = v * 747796405u + 2891336453u;');
        expect(chunk).toContain('let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;');
        expect(chunk).toContain('return windPcg((u32(ix) * 1597334677u) ^ (u32(iy) * 3812015801u));');
    });

    it('every includer holds MAX_WIND_SOURCES records the way the TS packs them', () => {
        for (const file of ['instancedVertex.wgsl', 'instancedDepthVertex.wgsl']) {
            const src = readFileSync(join(WGSL, file), 'utf-8');
            expect(src, file).toContain(`u_windSources: array<vec4<f32>, ${MAX_WIND_SOURCES * 4}>,`);
            expect(src, file).toContain(`const WIND_SOURCE_SLOTS: i32 = ${MAX_WIND_SOURCES};`);
            expect(src, file).toMatch(/let plant = windPlantAt\(/);
        }
    });

    it('foliage leans by the air, sampled once per plant', () => {
        const foliage = readFileSync(join(WGSL, 'foliageWind.wgsl'), 'utf-8');
        expect(foliage).toContain('#include "./windField.wgsl"');
        expect(foliage).toContain('let n = s.velocity.xz / WIND_REFERENCE_SPEED;');
        expect(foliage).toContain('let lean = (n + dir * (0.2 * strength * sway)) * (w.response.x / stiffness * fade);');
    });
});
