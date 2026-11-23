import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { shaderActivity } from '../src/graphics/shaderActivity';
import { PipelineCache, DEPTH_WRITE } from '../src/graphics/render/pipelineCache';
import type { PipelineCacheHost, PipelineOptions, PipelineReflection } from '../src/graphics/render/pipelineCache';
import type { FrameView } from '../src/graphics/render/frameView';
import type { PassEncoder } from '../src/graphics/render/passEncoder';
import { device, setDevice } from '../src/graphics/rhi/deviceHandle';
import { ShaderManager } from '../src/graphics/systems/shaderManager';

// The engine's background shader work as it happens, for the editor's progress popup: a material's pipeline
// built off the main thread, and the warm-up of the pipelines a project used last session. A build must come
// off the feed however it ends, or the editor's "Compiling shaders" card would never close.

beforeEach(() => shaderActivity.reset());

describe('the shader activity feed', () => {
    it('lists builds from begin to end, with a new snapshot only on a change', () => {
        const seen: number[] = [];
        const off = shaderActivity.subscribe(() => seen.push(shaderActivity.snapshot().active.length));
        const first = shaderActivity.snapshot();
        const a = shaderActivity.begin({ program: 'pbr', kind: 'pipeline' });
        const b = shaderActivity.begin({ program: 'customScreen:abc', builtFor: 'customScreen:abc', kind: 'pipeline' });
        expect(shaderActivity.snapshot()).not.toBe(first);
        expect(shaderActivity.snapshot().active.map(x => x.program)).toEqual(['pbr', 'customScreen:abc']);
        shaderActivity.end(a);
        const after = shaderActivity.snapshot();
        shaderActivity.end(a); // twice: nothing happens
        expect(shaderActivity.snapshot()).toBe(after);
        shaderActivity.end(b);
        expect(seen).toEqual([1, 2, 1, 0]);
        off();
    });

    it('carries the warm-up count, and drops it once over', () => {
        shaderActivity.setWarm(0, 40);
        shaderActivity.setWarm(10, 40);
        const mid = shaderActivity.snapshot();
        shaderActivity.setWarm(10, 40);
        expect(shaderActivity.snapshot()).toBe(mid);
        expect(mid.warm).toEqual({ done: 10, total: 40 });
        shaderActivity.setWarm(null);
        expect(shaderActivity.snapshot().warm).toBeNull();
    });
});

describe('the pipeline cache reports what it builds off the main thread', () => {
    let previous: typeof device;
    const pending: { resolve: (p: object) => void; reject: (e: unknown) => void }[] = [];
    beforeEach(() => {
        previous = device;
        pending.length = 0;
        setDevice({
            capabilities: { conventions: { pipelineCreationCompiles: true, originTopLeft: true } },
            createShaderModule: () => ({}),
            createRenderPipeline: (d: { label: string }) => ({ label: d.label, sync: true }),
            createRenderPipelineAsync: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
        } as never);
        vi.spyOn(ShaderManager.Instance, 'getShader').mockReturnValue({ attributes: [] } as never);
        vi.spyOn(ShaderManager.Instance, 'find').mockReturnValue({} as never);
    });
    afterEach(() => { setDevice(previous); vi.restoreAllMocks(); });

    const reflection: PipelineReflection = { resources: [], wgsl: '@fragment fn main() {}' };
    const state: PipelineOptions = { cullMode: 'back', depthStencil: DEPTH_WRITE, targets: 1, vertex: false, builtFor: 'customScreen:abc' };
    const settle = () => new Promise(r => setTimeout(r, 0));
    const cacheWith = (descriptorFor: PipelineCacheHost['descriptorFor'] = () => null) => {
        const host: PipelineCacheHost = { variants: false, filter: () => 0, physicalOf: (n) => n, descriptorFor };
        const view = { cubeFace: false, capturing: false } as unknown as FrameView;
        const passes = { target: { colorViews: [{ texture: { format: 'rgba16float' } }], depthView: null } } as unknown as PassEncoder;
        const cache = new PipelineCache(host, view, passes, []);
        cache.deferMisses = true;
        return cache;
    };

    it('lists a deferred build until it is built, and until it fails', async () => {
        const cache = cacheWith();
        expect(cache.getOrDefer('customScreen:abc', reflection, state)).toBeNull();
        expect(shaderActivity.snapshot().active).toMatchObject([{ program: 'customScreen:abc', builtFor: 'customScreen:abc', kind: 'pipeline' }]);
        pending[0].resolve({ async: true });
        await settle();
        expect(shaderActivity.snapshot().active).toEqual([]);

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(cache.getOrDefer('water', reflection, { ...state, builtFor: null })).toBeNull();
        expect(shaderActivity.snapshot().active).toHaveLength(1);
        pending[1].reject(new Error('validation'));
        await settle();
        expect(shaderActivity.snapshot().active).toEqual([]);
        warn.mockRestore();
    });

    it('counts the warm-up, and clears it when it ends', async () => {
        const cache = cacheWith((n) => (n === 'pbr' || n === 'cel' ? { resources: [], wgsl: reflection.wgsl } as never : null));
        const recipe = (program: string) => ({
            program, cullMode: 'back' as const, targets: 1, topology: 'triangle-list' as const, vertex: false as const, builtFor: null,
            cubeFace: false, colorFormats: ['rgba16float'], blend: null, depthStencil: DEPTH_WRITE,
        });
        const warming = cache.warm(undefined, [recipe('pbr'), recipe('cel')]);
        expect(shaderActivity.snapshot().warm).toEqual({ done: 0, total: 2 });
        await settle();
        pending[0].resolve({});
        await settle();
        expect(shaderActivity.snapshot().warm).toEqual({ done: 1, total: 2 });
        pending[1].resolve({});
        await warming;
        expect(shaderActivity.snapshot().warm).toBeNull();
    });
});
