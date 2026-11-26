import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PipelineCache } from '../src/graphics/render/pipelineCache';
import type { PipelineCacheHost, PipelineReflection } from '../src/graphics/render/pipelineCache';
import type { FrameView } from '../src/graphics/render/frameView';
import type { PassEncoder } from '../src/graphics/render/passEncoder';
import { EffectPrefetch } from '../src/graphics/render/effectPrefetch';
import { device, setDevice } from '../src/graphics/rhi/deviceHandle';
import { ShaderManager } from '../src/graphics/systems/shaderManager';

/**
 * An effect a script switches on in play (reflections, TAA, fog) keeps buffers it never gives back, so the loading
 * step does not run it: it asks for its pipelines by key instead. That only helps if the key is the one the effect's
 * own pass then asks for: the same program, state and target formats.
 */

function fakeDevice() {
    const f = { sync: 0, async: [] as { label: string; resolve: (p: object) => void }[] };
    setDevice({
        capabilities: { conventions: { pipelineCreationCompiles: true, originTopLeft: true } },
        createShaderModule: () => ({}),
        createRenderPipeline: (d: { label: string }) => { f.sync++; return { label: d.label, sync: true }; },
        createRenderPipelineAsync: (d: { label: string }) => new Promise(resolve => { f.async.push({ label: d.label, resolve }); }),
    } as never);
    return f;
}

const reflection: PipelineReflection = { resources: [], wgsl: '@fragment fn main() {}' };
const halfFloat = { colorViews: [{ texture: { format: 'rgba16float' } }], depthView: null } as never;
const settle = () => new Promise(r => setTimeout(r, 0));
const host: PipelineCacheHost = { variants: false, filter: () => 0, physicalOf: (n) => n, descriptorFor: () => null };

let previous: typeof device;
beforeEach(() => {
    previous = device;
    vi.spyOn(ShaderManager.Instance, 'getShader').mockReturnValue({ attributes: [] } as never);
});
afterEach(() => { setDevice(previous); vi.restoreAllMocks(); });

describe('an effect\'s pipeline asked for ahead of its first run', () => {
    it('is the one its pass finds: built once, off the main thread, under the key the pass makes', async () => {
        const f = fakeDevice();
        const view = { cubeFace: false, capturing: false } as unknown as FrameView;
        const passes = { target: null } as unknown as PassEncoder;
        const cache = new PipelineCache(host, view, passes, []);
        new EffectPrefetch(cache).fullscreen('ssrResolve', reflection, halfFloat);
        expect([f.sync, f.async.length, cache.pendingBuilds]).toEqual([0, 1, 1]);
        f.async[0].resolve({ label: 'ssrResolve', async: true });
        await settle();
        // The effect switched on: its pass opens on a target of that shape and asks as FullscreenPasses.bind does.
        (passes as unknown as { target: unknown }).target = halfFloat;
        expect(cache.fullscreen('ssrResolve', reflection)).toEqual({ label: 'ssrResolve', async: true });
        expect(f.sync).toBe(0);
    });

    it('keys a pipeline by its target\'s formats: another shape is another pipeline, the same shape the same', () => {
        const f = fakeDevice();
        const cache = new PipelineCache(host, { cubeFace: false, capturing: false } as unknown as FrameView,
                                        { target: null } as unknown as PassEncoder, []);
        const prefetch = new EffectPrefetch(cache);
        prefetch.fullscreen('exposureMeter', reflection, halfFloat);
        prefetch.fullscreen('exposureMeter', reflection, { colorViews: [{ texture: { format: 'rgba8unorm' } }], depthView: null } as never);
        prefetch.fullscreen('exposureMeter', reflection, halfFloat);
        expect(f.async.length).toBe(2);
    });
});
