import { describe, it, expect } from 'vitest';
import { GpuOcclusion, GPU_OCCLUSION_BUDGET, LIGHT_OCCLUSION_BUDGET, MAX_AGE, MIN_RADIUS, MIN_TRIANGLES } from '../src/graphics/gpuOcclusion';
import type { OcclusionQuerySet } from '../src/graphics/rhi/resources';
import type { ModelNode } from '../src/core/scene/nodes/modelNode';

// GPU occlusion's verdicts: a node is skipped only on a FRESH "hidden" result about it, results land on
// the nodes that were queried in the frame they describe, and a camera cut forgets everything.

const node = (name: string) => ({ name }) as unknown as ModelNode;
const EYE = [0, 0, 0], FWD = [0, 0, -1];

/** A query set whose results the test hands over by tag, the way a readback completes frames later. */
class FakeQueries implements OcclusionQuerySet {
    public readonly capacity = GPU_OCCLUSION_BUDGET;
    public readonly label = 'fake';
    public readonly ready: { tag: number; count: number; visible: Uint8Array }[] = [];
    public resolve(): void {}
    public poll() { return this.ready.shift() ?? null; }
    public destroy(): void {}
}

describe('GpuOcclusion', () => {
    it('only takes nodes worth a query, up to the budget', () => {
        const o = new GpuOcclusion();
        o.beginFrame(null, EYE, FWD);
        expect(o.consider(node('pebble'), MIN_RADIUS / 2, MIN_TRIANGLES / 2)).toBe(false);
        expect(o.consider(node('house'), MIN_RADIUS * 2, 10)).toBe(true);
        expect(o.consider(node('statue'), 0.5, MIN_TRIANGLES * 2)).toBe(true);
        for (let i = 0; i < GPU_OCCLUSION_BUDGET; i++) o.consider(node(`n${i}`), 5, 5000);
        expect(o.candidates.length).toBe(GPU_OCCLUSION_BUDGET);
    });

    it('hides a node only on a fresh hidden result about it', () => {
        const set = new FakeQueries();
        const o = new GpuOcclusion();
        const cart = node('cart'), barn = node('barn');
        o.beginFrame(set, EYE, FWD);
        o.consider(cart, 3, 5000);
        o.consider(barn, 3, 5000);
        const tag = o.submitted();
        // Nothing back yet: everything is visible.
        o.beginFrame(set, EYE, FWD);
        expect(o.isHidden(cart)).toBe(false);
        // The result arrives: cart hidden, barn visible.
        set.ready.push({ tag, count: 2, visible: new Uint8Array([0, 1]) });
        o.beginFrame(set, EYE, FWD);
        expect(o.isHidden(cart)).toBe(true);
        expect(o.isHidden(barn)).toBe(false);
        // And it goes stale: past MAX_AGE frames without a newer result, it no longer hides anything.
        for (let i = 0; i < MAX_AGE; i++) o.beginFrame(set, EYE, FWD);
        expect(o.isHidden(cart)).toBe(false);
    });

    it('forgets every verdict on a camera cut, and ignores results from before it', () => {
        const set = new FakeQueries();
        const o = new GpuOcclusion();
        const cart = node('cart');
        o.beginFrame(set, EYE, FWD);
        o.consider(cart, 3, 5000);
        const tag = o.submitted();
        set.ready.push({ tag, count: 1, visible: new Uint8Array([0]) });
        o.beginFrame(set, EYE, FWD);
        expect(o.isHidden(cart)).toBe(true);
        // A jump.
        o.beginFrame(set, [100, 0, 0], FWD);
        expect(o.isHidden(cart)).toBe(false);
        // A fast turn.
        const o2 = new GpuOcclusion();
        o2.beginFrame(set, EYE, FWD);
        o2.consider(cart, 3, 5000);
        const t2 = o2.submitted();
        set.ready.push({ tag: t2, count: 1, visible: new Uint8Array([0]) });
        o2.beginFrame(set, EYE, [1, 0, 0]);
        expect(o2.isHidden(cart)).toBe(false);
    });

    it('counts what it hid this frame', () => {
        const set = new FakeQueries();
        const o = new GpuOcclusion();
        const a = node('a'), b = node('b');
        o.beginFrame(set, EYE, FWD);
        o.consider(a, 3, 5000); o.consider(b, 3, 5000);
        set.ready.push({ tag: o.submitted(), count: 2, visible: new Uint8Array([0, 0]) });
        o.beginFrame(set, EYE, FWD);
        o.isHidden(a); o.isHidden(b);
        expect(o.hiddenThisFrame).toBe(2);
    });

    it('queries lights by their influence sphere, within a budget of their own', () => {
        const set = new FakeQueries();
        const o = new GpuOcclusion();
        const torch = {}, lamp = {};
        o.beginFrame(set, EYE, FWD);
        expect(o.considerLight(torch, [1, 2, 3], 7)).toBe(true);
        expect(o.considerLight(torch, [1, 2, 3], 7)).toBe(false);   // once a frame
        expect(o.considerLight(lamp, [0, 0, 0], 0)).toBe(false);    // reaches nothing: nothing to ask
        expect(Array.from(o.lightSpheres.get(torch)!)).toEqual([1, 2, 3, 7]);
        for (let i = 0; i < LIGHT_OCCLUSION_BUDGET * 2; i++) o.considerLight({}, [0, 0, 0], 5);
        expect(o.candidates.length).toBe(LIGHT_OCCLUSION_BUDGET);
        // Nodes still get the rest of the total budget.
        expect(o.consider(node('house'), MIN_RADIUS * 2, 10)).toBe(true);

        const tag = o.submitted();
        const visible = new Uint8Array(o.candidates.length).fill(1);
        visible[0] = 0;                                              // the torch's reach is hidden
        set.ready.push({ tag, count: visible.length, visible });
        o.beginFrame(set, EYE, FWD);
        expect(o.isLightHidden(torch)).toBe(true);
        expect(o.hiddenLightsThisFrame).toBe(1);
        // A camera cut forgets it.
        o.beginFrame(set, [100, 0, 0], FWD);
        expect(o.isLightHidden(torch)).toBe(false);
    });
});
