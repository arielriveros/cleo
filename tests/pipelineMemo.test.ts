import { describe, it, expect } from 'vitest';
import { PipelineCache, PipelineMemo, DEPTH_TEST, DEPTH_WRITE } from '../src/graphics/render/pipelineCache';
import type { PipelineCacheHost, PipelineOptions, PipelineReflection } from '../src/graphics/render/pipelineCache';
import type { FrameView } from '../src/graphics/render/frameView';
import type { PassEncoder } from '../src/graphics/render/passEncoder';

/**
 * PipelineCache.memoized answers a draw that asks with the same inputs as last time from its call site's
 * memo, without building the key string `get` looks pipelines up by. Every input `get` would build a
 * different pipeline for has to send it back to `get`.
 */
function setup() {
    let filter: 0 | 1 = 0;
    const host: PipelineCacheHost = {
        variants: false,
        filter: () => filter,
        physicalOf: (name) => name,
        descriptorFor: () => null,
    };
    const view = { cubeFace: false } as unknown as FrameView;
    const passes = { target: { label: 'a' } } as unknown as PassEncoder;
    const cache = new PipelineCache(host, view, passes, []);
    let built = 0;
    (cache as unknown as { get: () => unknown }).get = () => ({ id: ++built });
    return { cache, passes, setFilter: (f: 0 | 1) => { filter = f; }, builds: () => built };
}

const reflection: PipelineReflection = { resources: [] };
const material = {};
const state = (over: Partial<PipelineOptions> = {}): PipelineOptions =>
    ({ cullMode: 'back', depthStencil: DEPTH_WRITE, targets: 3, topology: 'triangle-list', vertex: 'model', builtFor: 'pbr', ...over });

describe('PipelineCache.memoized', () => {
    it('asks get once while nothing changes', () => {
        const { cache, builds } = setup();
        const memo = new PipelineMemo();
        const first = cache.memoized(memo, material, 'pbrGeometry', reflection, state());
        for (let i = 0; i < 5; i++) expect(cache.memoized(memo, material, 'pbrGeometry', reflection, state())).toBe(first);
        expect(builds()).toBe(1);
    });

    it('asks again for any input get keys on', () => {
        const { cache, passes, setFilter, builds } = setup();
        const memo = new PipelineMemo();
        cache.memoized(memo, material, 'pbrGeometry', reflection, state());
        cache.memoized(memo, material, 'pbrGeometryOpaque', reflection, state());          // program
        cache.memoized(memo, material, 'pbrGeometryOpaque', reflection, state({ cullMode: 'none' }));
        cache.memoized(memo, material, 'pbrGeometryOpaque', reflection, state({ cullMode: 'none', depthStencil: DEPTH_TEST }));
        cache.memoized(memo, material, 'pbrGeometryOpaque', reflection, state({ cullMode: 'none', depthStencil: DEPTH_TEST, vertex: 'model+skin' }));
        expect(builds()).toBe(5);
        (passes as unknown as { target: object }).target = { label: 'b' };                 // the pass's target
        cache.memoized(memo, material, 'pbrGeometryOpaque', reflection, state({ cullMode: 'none', depthStencil: DEPTH_TEST, vertex: 'model+skin' }));
        expect(builds()).toBe(6);
        setFilter(1);                                                                       // the variant filter
        cache.memoized(memo, material, 'pbrGeometryOpaque', reflection, state({ cullMode: 'none', depthStencil: DEPTH_TEST, vertex: 'model+skin' }));
        expect(builds()).toBe(7);
    });

    it('compares state objects by identity, so a fresh literal per draw never hits', () => {
        const { cache, builds } = setup();
        const memo = new PipelineMemo();
        const literal = () => state({ depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' } });
        cache.memoized(memo, material, 'pbr', reflection, literal());
        cache.memoized(memo, material, 'pbr', reflection, literal());
        expect(builds()).toBe(2);
    });

    it('keeps one slot per owner', () => {
        const { cache, builds } = setup();
        const memo = new PipelineMemo();
        const a = {}, b = {};
        cache.memoized(memo, a, 'pbr', reflection, state());
        cache.memoized(memo, b, 'pbr', reflection, state({ cullMode: 'front' }));
        cache.memoized(memo, a, 'pbr', reflection, state());
        cache.memoized(memo, b, 'pbr', reflection, state({ cullMode: 'front' }));
        expect(builds()).toBe(2);
    });
});
