import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
// @ts-expect-error -- plain .mjs shared with the bundler config; it has no declarations.
import { translateWgsl } from '../tools/wgslTranslate.mjs';
// @ts-expect-error -- same.
import { resolveIncludes } from '../tools/shaderIncludes.mjs';
import { MaterialSync, MATERIAL_VIEW_SIZE } from '../src/graphics/shaderOptimizer/materialSync';
import { DrawSortKeys, depthBucket } from '../src/graphics/shaderOptimizer/drawSort';
import { ProgramCompileQueue } from '../src/graphics/shaderOptimizer/compileQueue';
import { parseRecipes } from '../src/graphics/shaderOptimizer/pipelineRecipes';
import { shaderOptimizerStats, resetShaderOptimizerFrame } from '../src/graphics/shaderOptimizer/stats';
import { opaqueEligible, physicalFor, EXTRA_LOGICAL_NAMES } from '../src/graphics/programVariants';

// The shader optimizer (src/graphics/shaderOptimizer): each piece removes a specific cost, and each has a
// way of being quietly wrong — a skipped material write that leaves stale values, a sort that splits a
// state group, a stand-in that never gets replaced. These pin the rules.

describe('MaterialSync', () => {
    const view = (seed = 0) => Float64Array.from({ length: MATERIAL_VIEW_SIZE }, (_, i) => i + seed);
    let sync: MaterialSync;
    beforeEach(() => { sync = new MaterialSync(); sync.beginFrame(); resetShaderOptimizerFrame(); });

    it('skips a second write of the same material on the same program, same frame and view', () => {
        const program = {}, material = {};
        expect(sync.needsWrite(program, material, view())).toBe(true);
        expect(sync.needsWrite(program, material, view())).toBe(false);
        expect(shaderOptimizerStats.materialSkips).toBe(1);
    });

    it('writes again for another material, another program, a new frame or a changed view', () => {
        const program = {}, other = {}, a = {}, b = {};
        sync.needsWrite(program, a, view());
        expect(sync.needsWrite(program, b, view())).toBe(true);
        expect(sync.needsWrite(other, b, view())).toBe(true);
        expect(sync.needsWrite(program, b, view(1))).toBe(true);    // a probe face turned the camera
        sync.beginFrame();
        expect(sync.needsWrite(program, b, view(1))).toBe(true);    // the editor may have edited it
    });

    it('writes after the program block was invalidated by a hand-written uniform', () => {
        const program = {}, material = {};
        sync.needsWrite(program, material, view());
        sync.invalidate(program);
        expect(sync.needsWrite(program, material, view())).toBe(true);
    });

    it('interns uniform names', () => {
        expect(sync.uniformName('baseColor')).toBe('u_material.baseColor');
        expect(sync.uniformName('baseColor')).toBe(sync.uniformName('baseColor'));
    });
});

describe('DrawSortKeys', () => {
    it('orders by program, then material, then nearest first', () => {
        const keys = new DrawSortKeys();
        const m1 = {}, m2 = {};
        const draws = [
            { p: 'b', m: m1, d: 5 }, { p: 'a', m: m2, d: 50 }, { p: 'a', m: m1, d: 90 },
            { p: 'a', m: m1, d: 2 }, { p: 'b', m: m1, d: 1 },
        ];
        // Intern in a fixed order so the expectation does not depend on first-seen order.
        keys.programId('a'); keys.programId('b'); keys.materialId(m1); keys.materialId(m2);
        const sorted = draws.slice().sort((x, y) => keys.key(x.p, x.m, x.d, 100) - keys.key(y.p, y.m, y.d, 100));
        expect(sorted.map(d => `${d.p}${d.m === m1 ? 1 : 2}@${d.d}`)).toEqual(['a1@2', 'a1@90', 'a2@50', 'b1@1', 'b1@5']);
    });

    it('buckets depth monotonically', () => {
        let last = -1;
        for (const d of [0, 0.05, 0.5, 2, 10, 50, 99, 100, 5000]) {
            const b = depthBucket(d, 100);
            expect(b).toBeGreaterThanOrEqual(last);
            last = b;
        }
    });
});

describe('ProgramCompileQueue', () => {
    function fakeDevice() {
        const ready = new Set<string>();
        const prepared: string[] = [];
        return {
            ready, prepared,
            prepareShaderProgram: (d: { label: string }) => { prepared.push(d.label); },
            isShaderProgramReady: (d: { label: string }) => ready.has(d.label),
            createShaderProgram: (d: { label: string }) => ({ built: d.label }),
        };
    }

    it('submits once, hands over only finished compiles, and reports them', () => {
        const dev = fakeDevice();
        const queue = new ProgramCompileQueue(dev, () => true);
        const got: unknown[] = [];
        expect(queue.request('pbrGeometry~opaque', { label: 'pbrGeometry~opaque' }, p => got.push(p))).toBe(true);
        expect(queue.request('pbrGeometry~opaque', { label: 'pbrGeometry~opaque' }, p => got.push(p))).toBe(true);
        expect(dev.prepared).toEqual(['pbrGeometry~opaque']);
        expect(queue.poll()).toBe(0);
        expect(queue.isPending('pbrGeometry~opaque')).toBe(true);
        dev.ready.add('pbrGeometry~opaque');
        expect(queue.poll()).toBe(1);
        expect(got).toEqual([{ built: 'pbrGeometry~opaque' }]);
        expect(queue.pendingCount).toBe(0);
    });

    it('declines without parallel compile, so the caller builds synchronously', () => {
        const queue = new ProgramCompileQueue(fakeDevice(), () => false);
        expect(queue.request('x~y', { label: 'x~y' }, () => {})).toBe(false);
    });
});

describe('pipeline recipes', () => {
    it('parses what publish writes and drops what it cannot use', () => {
        const good = {
            program: 'pbrGeometry~opaque', cullMode: 'back', targets: 3, topology: 'triangle-list',
            vertex: 'model', builtFor: 'pbr', cubeFace: false, colorFormats: ['rgba16float', 'rgba16float', 'rgba8unorm'],
            blend: null, depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
        };
        const out = parseRecipes([good, good, { program: '' }, { ...good, cullMode: 'sideways' }, 7, null]);
        expect(out).toHaveLength(1);
        expect(out[0].program).toBe('pbrGeometry~opaque');
        expect(parseRecipes('nope')).toEqual([]);
    });
});

describe('opaque G-buffer variants', () => {
    const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
    const compose = (file: string, defines: object) => translateWgsl(resolveIncludes(readFileSync(file, 'utf-8'), dirname(file), {
        read: (p: string) => readFileSync(p, 'utf-8'), resolve: (d: string, r: string) => join(d, r), defines,
    }), file);

    it('compile with no discard at all, while the plain programs keep their cutouts', async () => {
        // The whole point of the permutation: a fragment stage that CAN discard costs early-Z for every
        // fragment of every draw, so the opaque variant must not contain one anywhere.
        for (const name of ['geometryPBR.wgsl', 'geometryPBRSkinned.wgsl', 'geometryPBRInstanced.wgsl']) {
            const file = join(WGSL, name);
            const opaque = await compose(file, { CLEO_POM: 0, CLEO_OPAQUE: 1 });
            const flat = await compose(file, { CLEO_POM: 0 });
            expect(opaque.fragment, `${name} opaque`).not.toMatch(/\bdiscard\b/);
            expect(flat.fragment, `${name} flat`).toMatch(/\bdiscard\b/);
        }
    });

    it('are always reached through their logical names', () => {
        for (const name of ['pbrGeometryOpaque', 'pbrGeometrySkinnedOpaque', 'pbrGeometryInstancedOpaque']) {
            expect(EXTRA_LOGICAL_NAMES[name]).toBeDefined();
            expect(physicalFor(name, 0)).toMatch(/~opaque$/);
        }
    });

    it('are chosen only for materials with no cutout', () => {
        const mat = (props: Record<string, unknown>) => ({ properties: new Map(Object.entries(props)) });
        expect(opaqueEligible([mat({ alphaCutoff: 0 }), mat({})])).toBe(true);
        expect(opaqueEligible([mat({ alphaCutoff: 0 }), mat({ alphaCutoff: 0.5 })])).toBe(false);
    });
});
