import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PipelineCache, PipelineMemo, DEPTH_WRITE } from '../src/graphics/render/pipelineCache';
import type { PipelineCacheHost, PipelineOptions, PipelineReflection } from '../src/graphics/render/pipelineCache';
import type { FrameView } from '../src/graphics/render/frameView';
import type { PassEncoder } from '../src/graphics/render/passEncoder';
import { device, setDevice } from '../src/graphics/rhi/deviceHandle';
import { ShaderManager } from '../src/graphics/systems/shaderManager';
import { shaderOptimizerStats } from '../src/graphics/shaderOptimizer';

/**
 * A draw that can go without its pipeline for a while (a material's, the water's) never builds a missing one on
 * the spot on WebGPU, where building it is when its shader compiles: on Windows that froze the whole window for
 * 19 s the first time the Sandbox car's glass came into view. It has it built off the main thread and skips the
 * draw until it is ready. Everything else, and anything that is kept (a probe capture), builds at once.
 */

interface Fake {
    sync: number;
    async: { label: string; resolve: (p: object) => void; reject: (e: unknown) => void }[];
}

function fakeDevice(compiles = true): Fake {
    const f: Fake = { sync: 0, async: [] };
    setDevice({
        capabilities: { conventions: { pipelineCreationCompiles: compiles, originTopLeft: true } },
        createShaderModule: () => ({}),
        createRenderPipeline: (d: { label: string }) => { f.sync++; return { label: d.label, sync: true }; },
        createRenderPipelineAsync: (d: { label: string }) => new Promise((resolve, reject) => {
            f.async.push({ label: d.label, resolve, reject });
        }),
    } as never);
    return f;
}

function setup() {
    const host: PipelineCacheHost = { variants: false, filter: () => 0, physicalOf: (n) => n, descriptorFor: () => null };
    const view = { cubeFace: false, capturing: false } as unknown as FrameView;
    const passes = { target: { colorViews: [{ texture: { format: 'rgba16float' } }], depthView: null } } as unknown as PassEncoder;
    const cache = new PipelineCache(host, view, passes, []);
    return { cache, view };
}

const reflection: PipelineReflection = { resources: [], wgsl: '@fragment fn main() {}' };
const state: PipelineOptions = { cullMode: 'back', depthStencil: DEPTH_WRITE, targets: 1, vertex: false };
const settle = () => new Promise(r => setTimeout(r, 0));

let previous: typeof device;
beforeEach(() => {
    previous = device;
    vi.spyOn(ShaderManager.Instance, 'getShader').mockReturnValue({ attributes: [] } as never);
});
afterEach(() => { setDevice(previous); vi.restoreAllMocks(); });

describe('a pipeline a draw finds missing', () => {
    it('is built off the main thread on WebGPU, the draw skipped until it is ready, then found', async () => {
        const f = fakeDevice();
        const { cache } = setup();
        cache.deferMisses = true;
        const memo = new PipelineMemo(), material = {};
        expect(cache.memoizedOrDefer(memo, material, 'pbr', reflection, state)).toBeNull();
        // Asked again while it builds: still waiting, and not built twice.
        expect(cache.memoizedOrDefer(memo, material, 'pbr', reflection, state)).toBeNull();
        expect([f.sync, f.async.length, cache.pendingBuilds]).toEqual([0, 1, 1]);
        const before = shaderOptimizerStats.pipelinesDeferred;
        f.async[0].resolve({ label: 'pbr', async: true });
        await settle();
        const pipeline = cache.memoizedOrDefer(memo, material, 'pbr', reflection, state);
        expect(pipeline).toEqual({ label: 'pbr', async: true });
        // The same object for every draw that wants it, `get` included: one pipeline per state.
        expect(cache.get('pbr', reflection, state)).toBe(pipeline);
        expect([f.sync, cache.pendingBuilds, shaderOptimizerStats.pipelinesDeferred - before]).toEqual([0, 0, 1]);
        // Recorded like any other, for a publish (and the editor's next session) to warm.
        expect(cache.recipes().map(r => r.program)).toEqual(['pbr']);
    });

    it('is built at once where a frame is kept: no deferring asked, or a probe capture', () => {
        const f = fakeDevice();
        const { cache, view } = setup();
        expect(cache.getOrDefer('pbr', reflection, state)).toMatchObject({ sync: true });
        cache.deferMisses = true;
        (view as unknown as { capturing: boolean }).capturing = true;
        expect(cache.getOrDefer('water', reflection, state)).toMatchObject({ sync: true });
        expect([f.sync, f.async.length]).toEqual([2, 0]);
    });

    it('is built at once on a backend whose pipelines are only state (WebGL2)', () => {
        const f = fakeDevice(false);
        const { cache } = setup();
        cache.deferMisses = true;
        expect(cache.getOrDefer('pbr', reflection, state)).toMatchObject({ sync: true });
        expect(f.async.length).toBe(0);
    });

    it('falls back to building at once when the async build fails', async () => {
        const f = fakeDevice();
        const { cache } = setup();
        cache.deferMisses = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(cache.getOrDefer('pbr', reflection, state)).toBeNull();
        f.async[0].reject(new Error('validation'));
        await settle();
        expect(cache.getOrDefer('pbr', reflection, state)).toMatchObject({ sync: true });
        expect(f.sync).toBe(1);
        warn.mockRestore();
    });

    it('is never built twice: a draw that wants one the warm-up is building waits for it', async () => {
        const f = fakeDevice();
        const host: PipelineCacheHost = {
            variants: false, filter: () => 0, physicalOf: (n) => n,
            descriptorFor: (n) => (n === 'pbr' ? { resources: [], wgsl: reflection.wgsl } as never : null),
        };
        vi.spyOn(ShaderManager.Instance, 'find').mockReturnValue({} as never);
        const view = { cubeFace: false, capturing: false } as unknown as FrameView;
        const passes = { target: { colorViews: [{ texture: { format: 'rgba16float' } }], depthView: null } } as unknown as PassEncoder;
        const cache = new PipelineCache(host, view, passes, []);
        cache.deferMisses = true;
        const warming = cache.warm(undefined, [{
            program: 'pbr', cullMode: 'back', targets: 1, topology: 'triangle-list', vertex: false, builtFor: null,
            cubeFace: false, colorFormats: ['rgba16float'], blend: null, depthStencil: DEPTH_WRITE,
        }]);
        expect(cache.getOrDefer('pbr', reflection, state)).toBeNull();
        expect(f.async.length).toBe(1);
        f.async[0].resolve({ label: 'pbr', warmed: true });
        expect(await warming).toBe(1);
        expect(cache.getOrDefer('pbr', reflection, state)).toEqual({ label: 'pbr', warmed: true });
        expect(f.sync).toBe(0);
    });
});

// Renderer.prepareShaders builds what a scene can draw before the editor shows it: pipelines no frame asks for
// yet (a game camera's screen materials), and a warm-up it has to wait for to the end.
describe('a pipeline built ahead of its draw', () => {
    it('is built off the main thread whatever the frame deferral says, and found by the draw that wants it', async () => {
        const f = fakeDevice();
        const { cache } = setup();
        cache.deferMisses = false;   // between frames, or a kept frame's value: prefetch does not read it
        expect(cache.prefetch('screen', reflection, state)).toBeNull();
        expect([f.sync, f.async.length, cache.pendingBuilds]).toEqual([0, 1, 1]);
        f.async[0].resolve({ label: 'screen', async: true });
        await settle();
        expect(cache.get('screen', reflection, state)).toEqual({ label: 'screen', async: true });
        expect(f.sync).toBe(0);
    });

    it('is built at once on WebGL2, and inside a capture', () => {
        const f = fakeDevice(false);
        const { cache, view } = setup();
        expect(cache.prefetch('screen', reflection, state)).toMatchObject({ sync: true });
        fakeDevice();
        (view as unknown as { capturing: boolean }).capturing = true;
        expect(cache.prefetch('water', reflection, state)).toMatchObject({ sync: true });
        expect(f.async.length).toBe(0);
    });

    it('keys on the target it names, not the pass that ran last: the pass drawing into that shape finds it', async () => {
        const f = fakeDevice();
        const host: PipelineCacheHost = { variants: false, filter: () => 0, physicalOf: (n) => n, descriptorFor: () => null };
        const view = { cubeFace: false, capturing: false } as unknown as FrameView;
        // The last pass drew into the scene buffer, which has depth; the screen material draws into a chain buffer.
        const scene = { colorViews: [{ texture: { format: 'rgba16float' } }], depthView: { texture: { format: 'depth24plus' } } };
        const chainShape = { colorViews: [{ texture: { format: 'rgba16float' } }] };
        const chain = { colorViews: [{ texture: { format: 'rgba16float' } }] };
        const passes = { target: scene } as unknown as PassEncoder;
        const cache = new PipelineCache(host, view, passes, []);
        const screenState: PipelineOptions = { vertex: 'model', builtFor: 'customScreen:1' };
        expect(cache.prefetch('customScreen:1', reflection, { ...screenState, target: chainShape as never })).toBeNull();
        f.async[0].resolve({ label: 'customScreen:1', async: true });
        await settle();
        (passes as unknown as { target: unknown }).target = chain;   // the pass opens on a chain buffer
        expect(cache.get('customScreen:1', reflection, screenState)).toEqual({ label: 'customScreen:1', async: true });
        expect(f.sync).toBe(0);
    });

    it('says a warm-up is under way until its last batch is built, though nothing is building between batches', async () => {
        const f = fakeDevice();
        const host: PipelineCacheHost = {
            variants: false, filter: () => 0, physicalOf: (n) => n,
            descriptorFor: () => ({ resources: [], wgsl: reflection.wgsl } as never),
        };
        vi.spyOn(ShaderManager.Instance, 'find').mockReturnValue({} as never);
        const view = { cubeFace: false, capturing: false } as unknown as FrameView;
        const passes = { target: { colorViews: [{ texture: { format: 'rgba16float' } }], depthView: null } } as unknown as PassEncoder;
        const cache = new PipelineCache(host, view, passes, []);
        const recipe = (program: string) => ({
            program, cullMode: 'back' as const, targets: 1, topology: 'triangle-list' as const, vertex: false as const,
            builtFor: null, cubeFace: false, colorFormats: ['rgba16float'], blend: null, depthStencil: DEPTH_WRITE,
        });
        const batch = PipelineCache.WARM_BATCH;
        PipelineCache.WARM_BATCH = 1;
        try {
            expect(cache.warming).toBe(false);
            const warming = cache.warm(undefined, [recipe('a'), recipe('b')]);
            expect(cache.warming).toBe(true);
            f.async[0].resolve({ label: 'a' });
            await settle();
            // 'a' is in and 'b' not started yet: nothing building, yet the warm-up is not over.
            expect([cache.pendingBuilds, cache.warming]).toEqual([0, true]);
            await new Promise(r => setTimeout(r, PipelineCache.WARM_GAP_MS + 10));
            f.async[1].resolve({ label: 'b' });
            expect(await warming).toBe(2);
            expect(cache.warming).toBe(false);
        } finally {
            PipelineCache.WARM_BATCH = batch;
        }
    });
});
