import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import {
    evaluateCurve, evaluateGradient, linearCurve, constantCurve, fadeGradient, identityLut,
    bakeCurveChannel, bakeGradientRow, sampleLut, parseCurve, parseGradient, LUT_ROW,
} from '../src/particles/curves';
import {
    defaultParticleSystem, parseParticleSystem, makeModule, defaultEmitter, maxLifetime,
    MAX_EMITTER_CAPACITY, particleSystemReferences,
} from '../src/particles/particleSystemAsset';
import { EmitterRuntime, ParticleSystemRuntime, particleTextureLayout, resolveSubEmitters } from '../src/particles/particleRuntime';
import { builtinParticleMesh, particleMeshFromNodeJson, parseParticleMesh } from '../src/particles/particleMesh';
import { composeCustomSim, customCodeKey, validatedCustomCode } from '../src/particles/particleCustomCode';
import { compileParticleCustomCode, setParticleGlslTranslator } from '../src/graphics/particles/particleCustom';
import { packEmitter, stepUniforms, SIM, DRAW } from '../src/particles/particlePack';
import { MODULES, moduleDefinition } from '../src/particles/particleModules';

const I = mat4.create();

function emitterWith(mutate: (e: ReturnType<typeof defaultEmitter>) => void) {
    const e = defaultEmitter();
    e.spawn = [];
    mutate(e);
    return e;
}

describe('curves', () => {
    it('evaluates linear curves exactly at the ends and midpoint', () => {
        const c = linearCurve(2, 4);
        expect(evaluateCurve(c, 0)).toBeCloseTo(2);
        expect(evaluateCurve(c, 1)).toBeCloseTo(4);
        expect(evaluateCurve(c, 0.5)).toBeCloseTo(3);
        expect(evaluateCurve(c, -1)).toBeCloseTo(2);
        expect(evaluateCurve(c, 2)).toBeCloseTo(4);
    });

    it('holds a constant', () => {
        expect(evaluateCurve(constantCurve(0.7), 0.33)).toBeCloseTo(0.7);
    });

    it('evaluates gradients per channel', () => {
        const g = fadeGradient();
        expect(evaluateGradient(g, 0)[3]).toBeCloseTo(0);
        expect(evaluateGradient(g, 0.5)[3]).toBeCloseTo(1);
        expect(evaluateGradient(g, 1)[3]).toBeCloseTo(0);
    });

    it('bakes into the LUT the shader samples the same way', () => {
        const lut = identityLut();
        bakeCurveChannel(lut, LUT_ROW.SCALARS, 0, linearCurve(0, 10));
        bakeGradientRow(lut, LUT_ROW.COLOR_OVER_LIFE, fadeGradient());
        expect(sampleLut(lut, LUT_ROW.SCALARS, 0.5)[0]).toBeCloseTo(5, 1);
        // Other channels untouched.
        expect(sampleLut(lut, LUT_ROW.SCALARS, 0.5)[1]).toBe(1);
        expect(sampleLut(lut, LUT_ROW.COLOR_OVER_LIFE, 1)[3]).toBeCloseTo(0);
    });

    it('parses tolerantly', () => {
        expect(parseCurve({ keys: [{ t: 'x' }, { t: 0.5, v: 2 }, null] }).keys).toEqual([{ t: 0, v: 0 }, { t: 0.5, v: 2 }]);
        expect(parseCurve(null).keys.length).toBeGreaterThan(0);
        expect(parseGradient({ color: [], alpha: [{ t: 2, a: 5 }] }).alpha[0]).toEqual({ t: 1, a: 1 });
    });
});

describe('particle system asset', () => {
    it('round-trips through JSON', () => {
        const def = defaultParticleSystem();
        const back = parseParticleSystem(JSON.parse(JSON.stringify(def)));
        expect(back).toEqual(def);
    });

    it('drops unknown and misplaced modules, fills missing params', () => {
        const parsed = parseParticleSystem({
            emitters: [{
                capacity: 1e9,
                spawn: [{ type: 'gravity', params: {} }, { type: 'spawnRate', params: { rate: 5 } }, { type: 'nope' }],
                init: [{ type: 'lifetime' }],
                update: [],
            }],
        });
        const e = parsed.emitters[0];
        expect(e.capacity).toBe(MAX_EMITTER_CAPACITY);
        expect(e.spawn.map(m => m.type)).toEqual(['spawnRate']);
        expect(e.spawn[0].params.rate).toBe(5);
        expect(e.spawn[0].params.perDistance).toBe(0);
        expect(e.init[0].params.range).toEqual([1, 2]);
        expect(e.update).toEqual([]);
    });

    it('never throws on garbage', () => {
        for (const bad of [null, 1, 'x', { emitters: 'no' }, { emitters: [null, 3] }])
            expect(() => parseParticleSystem(bad)).not.toThrow();
    });

    it('reports referenced assets', () => {
        const def = defaultParticleSystem();
        def.emitters[0].render.textureId = 'tex1';
        expect(particleSystemReferences(def)).toEqual({ textures: ['tex1'], models: [] });
    });

    it('every module has defaults matching its declared params', () => {
        for (const m of MODULES) {
            const d = m.defaults();
            for (const p of m.params) expect(d, `${m.type}.${p.key}`).toHaveProperty(p.key);
            expect(moduleDefinition(m.type)).toBe(m);
        }
    });
});

describe('particle texture layout', () => {
    it('rounds small pools to the workgroup and fills whole rows otherwise', () => {
        expect(particleTextureLayout(10)).toEqual({ width: 64, height: 1, capacity: 64 });
        expect(particleTextureLayout(256)).toEqual({ width: 256, height: 1, capacity: 256 });
        expect(particleTextureLayout(1000)).toEqual({ width: 256, height: 4, capacity: 1024 });
    });
});

describe('emitter runtime', () => {
    it('spawns at the configured rate, carrying fractions', () => {
        const e = emitterWith(d => { d.spawn = [makeModule('spawnRate')]; d.spawn[0].params.rate = 10; });
        const rt = new EmitterRuntime(e);
        rt.play();
        let total = 0;
        for (let i = 0; i < 100; i++) total += rt.advance(1 / 100, I).spawnCount;
        expect(total).toBe(10);
    });

    it('hands out contiguous ring windows that wrap', () => {
        const e = emitterWith(d => {
            d.capacity = 64;
            d.spawn = [makeModule('spawnRate')];
            d.spawn[0].params.rate = 40;
        });
        const rt = new EmitterRuntime(e);
        rt.play();
        const a = rt.advance(1, I);
        const b = rt.advance(1, I);
        expect(a.spawnStart).toBe(0);
        expect(a.spawnCount).toBe(40);
        expect(b.spawnStart).toBe(40);
        expect(rt.cursor).toBe((80) % 64);
        expect(b.serial).toBe(40);
    });

    it('fires bursts once per cycle, including one at t = 0', () => {
        const e = emitterWith(d => {
            d.duration = 1;
            d.spawn = [makeModule('spawnBurst')];
            d.spawn[0].params.bursts = [{ time: 0, count: 5, cycles: 1, interval: 1, probability: 1 },
                                        { time: 0.5, count: 3, cycles: 2, interval: 0.25, probability: 1 }];
        });
        const rt = new EmitterRuntime(e);
        rt.play();
        let total = 0;
        // 0.125 is exact in binary, so sixteen steps end on exactly 2.0 rather than a hair past it.
        for (let i = 0; i < 16; i++) total += rt.advance(0.125, I).spawnCount;   // two cycles
        expect(total).toBe(2 * (5 + 3 + 3));
    });

    it('stops spawning after a non-looping cycle and reports alive until particles die', () => {
        const e = emitterWith(d => {
            d.looping = false;
            d.duration = 0.5;
            d.spawn = [makeModule('spawnRate')];
            d.spawn[0].params.rate = 100;
            d.init = [makeModule('lifetime')];
            d.init[0].params.range = [1, 1];
        });
        const rt = new EmitterRuntime(e);
        rt.play();
        let total = 0;
        for (let i = 0; i < 10; i++) total += rt.advance(0.1, I).spawnCount;
        expect(total).toBe(50);
        expect(rt.state).toBe('stopping');
        expect(rt.isAlive).toBe(true);
        for (let i = 0; i < 12; i++) rt.advance(0.1, I);
        expect(rt.isAlive).toBe(false);
        expect(maxLifetime(e)).toBe(1);
    });

    it('honours the start delay', () => {
        const e = emitterWith(d => { d.startDelay = 1; d.spawn = [makeModule('spawnRate')]; d.spawn[0].params.rate = 10; });
        const rt = new EmitterRuntime(e);
        rt.play();
        let early = 0;
        for (let i = 0; i < 10; i++) early += rt.advance(0.1, I).spawnCount;
        expect(early).toBe(0);
        let late = 0;
        for (let i = 0; i < 10; i++) late += rt.advance(0.1, I).spawnCount;
        expect(late).toBe(10);
    });

    it('spawns per distance travelled', () => {
        const e = emitterWith(d => {
            d.spawn = [makeModule('spawnRate')];
            d.spawn[0].params.rate = 0;
            d.spawn[0].params.perDistance = 2;
        });
        const rt = new EmitterRuntime(e);
        rt.play();
        const m = mat4.create();
        rt.advance(0.1, m);
        let total = 0;
        for (let i = 1; i <= 10; i++) {
            mat4.fromTranslation(m, [i, 0, 0]);
            total += rt.advance(0.1, m).spawnCount;
        }
        expect(total).toBe(20);
    });

    it('clamps a burst to capacity and carries the reset flag', () => {
        const e = emitterWith(d => { d.capacity = 64; });
        const rt = new EmitterRuntime(e);
        rt.burst(1000);
        rt.clear();
        const s = rt.advance(0.01, I);
        expect(s.spawnCount).toBe(64);
        expect(s.reset).toBe(true);
        expect(rt.advance(0.01, I).reset).toBe(false);
    });

    it('splits long frames into bounded steps', () => {
        const rt = new ParticleSystemRuntime([defaultEmitter()]);
        rt.emitters[0].play();
        rt.advance(0.1, I);
        const steps = rt.drain(0);
        expect(steps.length).toBe(3);
        expect(steps.reduce((a, s) => a + s.dt, 0)).toBeCloseTo(0.1);
        expect(rt.drain(0)).toEqual([]);
    });
});

describe('packing', () => {
    it('sets feature bits only for enabled modules', () => {
        const e = defaultEmitter();
        e.update = [makeModule('gravity'), makeModule('collision'), makeModule('colorOverLife')];
        e.update[1].enabled = false;
        const p = packEmitter(e);
        expect(p.simMask & SIM.GRAVITY).toBeTruthy();
        expect(p.simMask & SIM.COLLIDE_DEPTH).toBe(0);
        expect(p.drawMask & DRAW.COLOR_LIFE).toBeTruthy();
        expect(p.drawMask & DRAW.SIZE_LIFE).toBe(0);
    });

    it('moves emitter-space quantities into world space per step', () => {
        const e = defaultEmitter();
        e.update = [makeModule('gravity'), makeModule('attractor'), makeModule('collision')];
        e.update[1].params.position = [0, 1, 0];
        e.update[2].params.planes = [{ point: [0, 0, 0], normal: [0, 1, 0] }];
        const p = packEmitter(e);
        const m = mat4.fromTranslation(mat4.create(), [5, 2, 0]);
        const rt = new EmitterRuntime(e);
        const step = rt.advance(0.016, m);
        const u = stepUniforms(p, step, rt.capacity, rt.width, [0, -9.81, 0], e.seed);
        expect(u.u_gravity.slice(0, 3)).toEqual([0, -9.81, 0]);
        expect(u.u_attractor.slice(0, 3)).toEqual([5, 3, 0]);
        // The ground plane under the emitter: y = 2, so n . p + d = 0 at y = 2.
        expect(Array.from(u.u_planes).slice(0, 4).map(v => +v.toFixed(5))).toEqual([0, 1, 0, -2]);
        expect(p.simMask & SIM.COLLIDE_PLANES).toBeTruthy();
    });

    it('keeps local-space emitters in emitter space and rotates gravity into it', () => {
        const e = defaultEmitter();
        e.simSpace = 'local';
        e.update = [makeModule('gravity')];
        const p = packEmitter(e);
        // Emitter rolled 90° about Z: world down is emitter +X.
        const m = mat4.fromZRotation(mat4.create(), Math.PI / 2);
        const rt = new EmitterRuntime(e);
        const u = stepUniforms(p, rt.advance(0.016, m), rt.capacity, rt.width, [0, -10, 0], 1);
        expect(u.u_gravity[0]).toBeCloseTo(-10);
        expect(u.u_gravity[1]).toBeCloseTo(0);
        expect(p.simMask & SIM.LOCAL).toBeTruthy();
    });
});

describe('in-place adoption', () => {
    it('keeps pools across parameter edits but not across capacity edits', () => {
        const e = defaultEmitter();
        const rt = new ParticleSystemRuntime([e]);
        const tweaked = { ...e, update: [makeModule('gravity')] };
        expect(rt.canAdopt([tweaked])).toBe(true);
        rt.adopt([tweaked]);
        expect(rt.emitters[0].def.update[0].type).toBe('gravity');
        expect(rt.canAdopt([{ ...e, capacity: e.capacity * 4 }])).toBe(false);
        expect(rt.canAdopt([{ ...e, simSpace: 'local' }])).toBe(false);
        expect(rt.canAdopt([e, defaultEmitter()])).toBe(false);
    });
});

describe('sub-emitters', () => {
    it('size the child pool by the parent and silence its own timers', () => {
        const parent = defaultEmitter('Rockets');
        parent.capacity = 256;
        const child = defaultEmitter('Sparks');
        child.spawn = [makeModule('subEmitter'), makeModule('spawnRate')];
        child.spawn[0].params.parent = parent.id;
        child.spawn[0].params.count = 4;
        child.spawn[0].params.event = 'collision';
        const { defs, links } = resolveSubEmitters([parent, child]);
        expect(defs[1].capacity).toBe(1024);
        expect(links).toEqual([null, { parent: 0, event: 'collision', count: 4, inherit: 0.2 }]);

        const rt = new ParticleSystemRuntime([parent, child]);
        rt.emitters.forEach(x => x.play());
        rt.advance(1, mat4.create());
        expect(rt.drain(1).every(s => s.spawnCount === 0)).toBe(true);
    });

    it('ignore a missing, disabled or self parent', () => {
        const a = defaultEmitter();
        a.spawn = [makeModule('subEmitter')];
        a.spawn[0].params.parent = a.id;
        expect(resolveSubEmitters([a]).links).toEqual([null]);
        const b = defaultEmitter();
        b.enabled = false;
        a.spawn[0].params.parent = b.id;
        expect(resolveSubEmitters([a, b]).links).toEqual([null]);
    });
});

describe('particle meshes', () => {
    it('normalizes built-in shapes to a unit diameter', () => {
        for (const kind of ['cube', 'sphere', 'tetrahedron', 'cylinder'] as const) {
            const m = builtinParticleMesh(kind);
            let r = 0;
            for (let i = 0; i < m.positions.length; i += 3)
                r = Math.max(r, Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]));
            expect(r, kind).toBeCloseTo(0.5, 3);
            expect(m.indices.length % 3).toBe(0);
            expect(Math.max(...m.indices)).toBeLessThan(m.positions.length / 3);
        }
    });

    it('flattens a model subtree with its transforms baked in', () => {
        const json = {
            position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            children: [{
                position: [10, 0, 0], rotation: [0, 0, 0], scale: [100, 100, 100],
                model: { geometry: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
                                     texCoords: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2] } },
            }],
        };
        const mesh = particleMeshFromNodeJson(json)!;
        expect(mesh.indices).toEqual([0, 1, 2]);
        let r = 0;
        for (let i = 0; i < mesh.positions.length; i += 3)
            r = Math.max(r, Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
        expect(r).toBeCloseTo(0.5, 3);
        expect(particleMeshFromNodeJson({ children: [] })).toBeNull();
    });

    it('round-trips through the tolerant parser', () => {
        const m = builtinParticleMesh('cube');
        expect(parseParticleMesh(JSON.parse(JSON.stringify(m)))).toEqual(m);
        expect(parseParticleMesh({ positions: [], indices: [] })).toBeNull();
    });
});

describe('custom code', () => {
    it('splices the source between the markers', () => {
        const out = composeCustomSim(`a\n// @particle-custom-begin\nold\n// @particle-custom-end\nb`, 'NEW');
        expect(out).toContain('NEW');
        expect(out).not.toContain('old');
    });

    it('runs only a compile of this exact source', () => {
        const m = makeModule('customCode');
        expect(validatedCustomCode(m)).toBeNull();
        m.params.compiled = { key: customCodeKey(m.params.source), ok: true };
        expect(validatedCustomCode(m)).not.toBeNull();
        m.params.source += ' ';
        expect(validatedCustomCode(m)).toBeNull();
    });

    it('validates through naga and produces a WebGL2 program', async () => {
        const { readFileSync } = await import('fs');
        const naga = await import('../src/graphics/rhi/webgpu/naga/nagaGlsl.js');
        await (naga as any).default({ module_or_path: readFileSync('src/graphics/rhi/webgpu/naga/nagaGlsl_bg.wasm') });
        setParticleGlslTranslator((s, stage, entry) => (naga as any).wgsl_to_glsl(s, stage, entry));
        const good = compileParticleCustomCode('(*p).velocity.y += custom.x * dt;');
        expect(good.ok).toBe(true);
        expect(good.fragment).toMatch(/u_custom/);
        const bad = compileParticleCustomCode('(*p).nope = 1.0;');
        expect(bad.ok).toBe(false);
        expect(bad.error).toBeTruthy();
        setParticleGlslTranslator(null);
    });
});

describe('cycle boundaries', () => {
    it('never stalls on a start that rounds down a cycle', () => {
        const e = defaultEmitter();
        e.duration = 0.1;
        const rt = new EmitterRuntime(e);
        rt.play();
        // 0.1 * 3 = 0.30000000000000004: the classic boundary that rounds the wrong way.
        for (let i = 0; i < 1000; i++) rt.advance(0.1, I);
        expect(rt.time).toBeGreaterThan(99);
    });
});
