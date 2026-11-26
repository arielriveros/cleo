import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './helpers/features';
import { ParticleRenderer } from '../src/graphics/particles/particleRenderer';
import { device, setDevice } from '../src/graphics/rhi/deviceHandle';
import { parseRecipes, particlePipelineRecipe } from '../src/graphics/shaderOptimizer';
import { PipelineCache } from '../src/graphics/render/pipelineCache';
import type { PipelineCacheHost } from '../src/graphics/render/pipelineCache';
import type { FrameView } from '../src/graphics/render/frameView';
import type { PassEncoder } from '../src/graphics/render/passEncoder';
import { shaderActivity } from '../src/graphics/shaderActivity';

/**
 * The particle renderer builds its own pipelines (its simulation is compute, its draws a state of their own), so the
 * cache's deferral never reached them: the first muzzle flash of a session held the window on WebGPU while its
 * simulation and its lit draw compiled. Now a pipeline a frame finds missing is built off the main thread and the
 * frame goes without it (the system's steps wait queued, the emitter is not drawn), as a material's does; a kept frame
 * builds it at once; and it is recorded as a recipe the next session warms.
 */

interface Fake {
    sync: string[];
    async: { label: string; kind: 'render' | 'compute'; resolve: (p: object) => void; reject: (e: unknown) => void }[];
}

function fakeDevice(compiles = true): Fake {
    const f: Fake = { sync: [], async: [] };
    const later = (kind: 'render' | 'compute') => (d: { label: string }) => new Promise((resolve, reject) => {
        f.async.push({ label: d.label, kind, resolve, reject });
    });
    setDevice({
        capabilities: { hasCompute: true, floatRenderable: true, conventions: { pipelineCreationCompiles: compiles, originTopLeft: true } },
        createShaderModule: (d: { label: string }) => ({ label: d.label }),
        createRenderPipeline: (d: { label: string }) => { f.sync.push(d.label); return { label: d.label, sync: true }; },
        createComputePipeline: (d: { label: string }) => { f.sync.push(d.label); return { label: d.label, sync: true }; },
        createRenderPipelineAsync: later('render'),
        createComputePipelineAsync: later('compute'),
    } as never);
    return f;
}

const target = (color = 'rgba16float', depth: string | null = 'depth32float') =>
    ({ colorViews: [{ texture: { format: color } }], depthView: depth ? { texture: { format: depth } } : null }) as never;
const smoke = { blend: 'alpha', mode: 'billboard' } as never;
const settle = () => new Promise(r => setTimeout(r, 0));

let previous: typeof device;
beforeEach(() => { previous = device; shaderActivity.reset(); });
afterEach(() => { setDevice(previous); vi.restoreAllMocks(); });

describe('a particle pipeline a frame finds missing', () => {
    it('is built off the main thread on WebGPU, the draw left out until it is in, then found', async () => {
        const f = fakeDevice();
        const r = new ParticleRenderer() as any;
        expect(r._drawPipeline(target(), smoke, false, false, true)).toBeNull();
        // Asked again while it builds: still waiting, never built twice, and counted as a build.
        expect(r._drawPipeline(target(), smoke, false, false, true)).toBeNull();
        expect([f.sync.length, f.async.length, r.pendingBuilds]).toEqual([0, 1, 1]);
        expect(shaderActivity.snapshot().active.length).toBe(1);
        f.async[0].resolve({ label: 'async' });
        await settle();
        expect(r._drawPipeline(target(), smoke, false, false, true)).toEqual({ label: 'async' });
        expect([f.sync.length, r.pendingBuilds, shaderActivity.snapshot().active.length]).toEqual([0, 0, 0]);
    });

    it('holds a simulation until its compute pipeline is in, then steps with it', async () => {
        const f = fakeDevice();
        const r = new ParticleRenderer() as any;
        expect(r._obtainCompute('sim', 'particleSim', { wgsl: '', resources: [], entryPoints: {} }, true, { kind: 'sim', strip: 0 })).toBeNull();
        expect(f.async.map(a => a.kind)).toEqual(['compute']);
        f.async[0].resolve({ label: 'sim-async' });
        await settle();
        // The step itself asks without deferring: what it gets is the one built off the thread, not a new one.
        expect(r._obtainCompute('sim', 'particleSim', { wgsl: '', resources: [], entryPoints: {} }, false, { kind: 'sim', strip: 0 }))
            .toEqual({ label: 'sim-async' });
        expect(f.sync).toEqual([]);
    });

    it('is built at once in a kept frame (no deferring), on WebGL2, and after an off-thread build failed', async () => {
        const f = fakeDevice();
        const r = new ParticleRenderer() as any;
        expect(r._drawPipeline(target(), smoke, false, false, false)).toMatchObject({ sync: true });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(r._drawPipeline(target('rgba8unorm'), smoke, false, false, true)).toBeNull();
        f.async[0].reject(new Error('validation'));
        await settle();
        expect(r._drawPipeline(target('rgba8unorm'), smoke, false, false, true)).toMatchObject({ sync: true });
        warn.mockRestore();

        const g = fakeDevice(false);
        const gl = new ParticleRenderer() as any;
        expect(gl._drawPipeline(target(), smoke, false, false, true)).toMatchObject({ sync: true });
        expect(g.async.length).toBe(0);
    });

    it('lets a kept frame build one still building, and the late one does not replace it', async () => {
        const f = fakeDevice();
        const r = new ParticleRenderer() as any;
        expect(r._drawPipeline(target(), smoke, false, false, true)).toBeNull();
        const now = r._drawPipeline(target(), smoke, false, false, false);
        expect(now).toMatchObject({ sync: true });
        f.async[0].resolve({ label: 'late' });
        await settle();
        expect(r._drawPipeline(target(), smoke, false, false, true)).toBe(now);
    });

    it('drops a build started on a device since replaced', async () => {
        const f = fakeDevice();
        const r = new ParticleRenderer() as any;
        expect(r._drawPipeline(target(), smoke, false, false, true)).toBeNull();
        r.resetPipelines();
        f.async[0].resolve({ label: 'old device' });
        await settle();
        expect(r._drawPipeline(target(), smoke, false, false, true)).toBeNull();
        expect(f.async.length).toBe(2);
    });
});

describe('particle pipeline recipes', () => {
    it('records what was built, keeps it through a config, and warms it the next session', async () => {
        fakeDevice();
        const first = new ParticleRenderer() as any;
        first._drawPipeline(target(), smoke, false, true, false);
        first._obtainCompute('vc:5', 'particleSim~s5', { wgsl: '', resources: [], entryPoints: {} }, false, { kind: 'sim', strip: 5 });
        // Custom code has no name a later build could look up: never recorded.
        first._obtainCompute('c:abc', 'particleSim#abc', { wgsl: '', resources: [], entryPoints: {} }, false, null);
        const saved = JSON.parse(JSON.stringify(first.recipes()));
        const parsed = parseRecipes(saved);
        expect(parsed.map(p => p.particle)).toEqual([
            { kind: 'draw', mesh: false, lit: true, blend: 'alpha', color: 'rgba16float', depth: 'depth32float' },
            { kind: 'sim', strip: 5 },
        ]);

        const f = fakeDevice();
        const next = new ParticleRenderer() as any;
        const warmed = next.warmRecipe(parsed[0].particle!);
        expect(warmed).toBeInstanceOf(Promise);
        // A draw that wants it meanwhile waits for the warm-up's build rather than starting its own.
        expect(next._drawPipeline(target(), smoke, false, true, true)).toBeNull();
        expect(f.async.length).toBe(1);
        f.async[0].resolve({ label: 'warmed' });
        expect(await warmed).toBe(true);
        expect(next._drawPipeline(target(), smoke, false, true, true)).toEqual({ label: 'warmed' });
    });

    it('are handed to the particle renderer by the cache\'s warm-up', async () => {
        fakeDevice();
        const host: PipelineCacheHost = { variants: false, filter: () => 0, physicalOf: (n) => n, descriptorFor: () => null };
        const view = { cubeFace: false, capturing: false } as unknown as FrameView;
        const passes = { target: null } as unknown as PassEncoder;
        const cache = new PipelineCache(host, view, passes, []);
        const asked: unknown[] = [];
        cache.particleWarmer = recipe => { asked.push(recipe); return Promise.resolve(true); };
        const warmed = await cache.warm(undefined, [particlePipelineRecipe('particleSort', { kind: 'sort' })]);
        expect(asked).toEqual([{ kind: 'sort' }]);
        expect(warmed).toBe(1);
    });
});
