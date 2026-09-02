import { describe, it, expect } from 'vitest';
import { RenderGraphBuilder } from '../src/graphics/renderGraph/graph';
import { resolveExtent, slotKey } from '../src/graphics/renderGraph/resources';
import type { ResourceDesc } from '../src/graphics/renderGraph/resources';

/**
 * Aliasing is the half of a render graph that can corrupt an image rather than throw.
 *
 * The renderer reuses buffers today by hand, and reasons about it in prose. The clearest case is the
 * god-ray scratch target, which borrows `_blur_FBOs[0]` under the comment "safe to reuse — bloom, its
 * only other consumer, runs after god rays and overwrites it". That is true of the order as written
 * and false the moment anyone reorders the chain, which is precisely the feature being added. These
 * tests pin the property that replaces the comment: two resources share storage only when one is
 * finished before the other starts.
 *
 * The failure mode if this is wrong is not an exception. It is one pass reading another's pixels —
 * a frame that looks slightly wrong, intermittently, depending on which effects happen to be on.
 */

const BASE: Omit<ResourceDesc, 'name'> = {
    size: { kind: 'render' },
    format: 'rgba16float',
    colorAttachments: 1,
    depth: false,
    lifetime: 'transient',
};

function noop() { /* nothing to record */ }

describe('transient aliasing', () => {
    it('reuses one slot for resources whose lifetimes do not overlap', () => {
        const graph = new RenderGraphBuilder<string>();
        const a = graph.declare({ ...BASE, name: 'a' });
        const b = graph.declare({ ...BASE, name: 'b' });
        // a: written by pass 0, last read by pass 1. b: first written by pass 2 — strictly after.
        graph.addPass({ id: 'p0', scope: 's', writes: [a], execute: noop });
        graph.addPass({ id: 'p1', scope: 's', reads: [a], execute: noop });
        graph.addPass({ id: 'p2', scope: 's', writes: [b], execute: noop });
        graph.addPass({ id: 'p3', scope: 's', reads: [b], execute: noop });

        const compiled = graph.compile(128, 128);
        expect(compiled.slotOf(a)).toBe(compiled.slotOf(b));
        expect(compiled.slots).toHaveLength(1);
    });

    it('gives overlapping resources their own slots', () => {
        const graph = new RenderGraphBuilder<string>();
        const a = graph.declare({ ...BASE, name: 'a' });
        const b = graph.declare({ ...BASE, name: 'b' });
        graph.addPass({ id: 'p0', scope: 's', writes: [a], execute: noop });
        graph.addPass({ id: 'p1', scope: 's', writes: [b], execute: noop });
        // Both still live here, so neither may have been given the other's storage.
        graph.addPass({ id: 'p2', scope: 's', reads: [a, b], execute: noop });

        const compiled = graph.compile(128, 128);
        expect(compiled.slotOf(a)).not.toBe(compiled.slotOf(b));
        expect(compiled.slots).toHaveLength(2);
    });

    it('does not hand a slot over in the very pass that still reads it', () => {
        // The off-by-one that matters: `a` is last read by pass 1 and `b` is first written by pass 1.
        // Sharing there is a read/write feedback on one texture, which is undefined on both backends.
        const graph = new RenderGraphBuilder<string>();
        const a = graph.declare({ ...BASE, name: 'a' });
        const b = graph.declare({ ...BASE, name: 'b' });
        graph.addPass({ id: 'p0', scope: 's', writes: [a], execute: noop });
        graph.addPass({ id: 'p1', scope: 's', reads: [a], writes: [b], execute: noop });

        const compiled = graph.compile(128, 128);
        expect(compiled.slotOf(a)).not.toBe(compiled.slotOf(b));
    });

    it('never aliases across formats or sizes', () => {
        // `Renderer._pipelineFor` keys its pipeline cache on the attachment FORMATS it reads back off
        // the live target. A pipeline built for one format handed a target of another is a validation
        // error on WebGPU and a silent mis-render on WebGL2, so the bucket key has to include both.
        const graph = new RenderGraphBuilder<string>();
        const wide = graph.declare({ ...BASE, name: 'wide' });
        const narrow = graph.declare({ ...BASE, name: 'narrow', format: 'rgba8unorm' });
        const half = graph.declare({ ...BASE, name: 'half', size: { kind: 'scaled', scale: 0.5 } });
        graph.addPass({ id: 'p0', scope: 's', writes: [wide], execute: noop });
        graph.addPass({ id: 'p1', scope: 's', reads: [wide], execute: noop });
        graph.addPass({ id: 'p2', scope: 's', writes: [narrow], execute: noop });
        graph.addPass({ id: 'p3', scope: 's', reads: [narrow], execute: noop });
        graph.addPass({ id: 'p4', scope: 's', writes: [half], execute: noop });
        graph.addPass({ id: 'p5', scope: 's', reads: [half], execute: noop });

        const compiled = graph.compile(128, 128);
        // All three lifetimes are disjoint, so a bucket-blind pool would collapse them onto one slot.
        expect(new Set([compiled.slotOf(wide), compiled.slotOf(narrow), compiled.slotOf(half)]).size).toBe(3);
    });

    it('never aliases a persistent resource', () => {
        // A temporal history handed to another pass is not stale, it is uninitialized — which is why
        // `_resizeBuffers` follows a reallocation with `invalidateTemporalHistory()` rather than
        // letting the next frame resolve against it.
        const graph = new RenderGraphBuilder<string>();
        const history = graph.declare({ ...BASE, name: 'taa.history', lifetime: 'persistent' });
        const scratch = graph.declare({ ...BASE, name: 'scratch' });
        graph.addPass({ id: 'p0', scope: 's', writes: [history], execute: ctx => { ctx.target(history); } });
        graph.addPass({ id: 'p1', scope: 's', reads: [history], execute: ctx => { ctx.read(history); } });
        graph.addPass({ id: 'p2', scope: 's', writes: [scratch], execute: ctx => { ctx.target(scratch); } });

        const compiled = graph.compile(128, 128);
        expect(compiled.slotOf(history)).toBe(-1);       // not a transient slot at all
        expect(compiled.slotOf(scratch)).toBe(0);

        // And it reaches the pool by NAME, so reordering the chain cannot move it.
        const seen: string[] = [];
        compiled.execute({
            transient: slot => `slot${slot}`,
            persistent: name => { seen.push(name); return `persist:${name}`; },
        });
        expect(seen).toEqual(['taa.history', 'taa.history']);
    });

    it('regression: the god-ray scratch buffer is not shared with a bloom mip that is still live', () => {
        // The exact shape of the comment this replaces. God rays raymarch into a half-res scratch
        // target and composite it away immediately; bloom then wants its own half-res buffer. Sharing
        // is correct in THAT order and wrong if the user puts bloom first, because bloom's mip is
        // still being read when god rays would start writing over it.
        const half = { ...BASE, size: { kind: 'scaled' as const, scale: 0.5 } };

        const bloomFirst = new RenderGraphBuilder<string>();
        const bloomMip = bloomFirst.declare({ ...half, name: 'bloom.mip0' });
        const godScratch = bloomFirst.declare({ ...half, name: 'godRays.scratch' });
        bloomFirst.addPass({ id: 'bloom.bright', scope: 's', writes: [bloomMip], execute: noop });
        bloomFirst.addPass({ id: 'godRays', scope: 's', writes: [godScratch], execute: noop });
        // Bloom composites LAST here, so its mip is still live while god rays is writing.
        bloomFirst.addPass({ id: 'bloom.composite', scope: 's', reads: [bloomMip, godScratch], execute: noop });

        const compiled = bloomFirst.compile(128, 128);
        expect(compiled.slotOf(bloomMip)).not.toBe(compiled.slotOf(godScratch));
    });
});

describe('extent resolution', () => {
    it('reproduces the rounding the hand-allocated targets already use', () => {
        // Floor for a scaled buffer and ceil for a divided one, both matching `_resizeBuffers`. An odd
        // render width left the blur targets at 645.5 once — a viewport truncated to 645 sampling on a
        // grid computed from 645.5, i.e. every consumer reading slightly off.
        expect(resolveExtent({ kind: 'render' }, 645, 361)).toEqual({ width: 645, height: 361 });
        expect(resolveExtent({ kind: 'scaled', scale: 0.5 }, 645, 361)).toEqual({ width: 322, height: 180 });
        expect(resolveExtent({ kind: 'divided', divisor: 20 }, 645, 361)).toEqual({ width: 33, height: 19 });
        expect(resolveExtent({ kind: 'fixed', width: 1, height: 1 }, 645, 361)).toEqual({ width: 1, height: 1 });
    });

    it('never resolves to zero in either axis', () => {
        // The viewport can be mid-relayout when a panel is docked. Allocating against a 0-sized canvas
        // produces an incomplete framebuffer and a console error for the frame or two before the
        // resize lands, which is what the `Math.max(1, ...)` in the renderer's own mip chain guards.
        expect(resolveExtent({ kind: 'scaled', scale: 0.5 }, 1, 1)).toEqual({ width: 1, height: 1 });
        expect(resolveExtent({ kind: 'render' }, 0, 0)).toEqual({ width: 1, height: 1 });
        expect(resolveExtent({ kind: 'divided', divisor: 20 }, 0, 0)).toEqual({ width: 1, height: 1 });
    });

    it('bucket keys separate every property that makes storage non-interchangeable', () => {
        const base = { format: 'rgba16float' as const, colorAttachments: 1, depth: false,
                       extent: { width: 8, height: 8 } };
        const keys = new Set([
            slotKey(base),
            slotKey({ ...base, format: 'rgba8unorm' }),
            slotKey({ ...base, colorAttachments: 3 }),
            slotKey({ ...base, depth: true }),
            slotKey({ ...base, extent: { width: 4, height: 8 } }),
        ]);
        expect(keys.size).toBe(5);
    });
});
