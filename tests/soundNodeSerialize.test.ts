import { describe, it, expect } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { SoundNode } from '../src/core/scene/nodes/soundNode';
import { DEFAULT_SPATIAL_SETTINGS } from '../src/audio/soundSettings';

// A SoundNode's payload is the only record of where a sound is and how it falls off — the sample asset
// holds everything else. So the property worth pinning is that a placement survives a save/load exactly,
// and that a payload from an older or hand-edited project resolves to something audible rather than NaN.
//
// GL-free and howler-free by construction: nothing here plays, and `_sample()` resolves to undefined
// because no sample is registered, which is the same path a scene with a missing asset takes.

/** Round-trip a node through serialize -> parse, returning the reconstructed one. */
async function roundTrip(node: SoundNode): Promise<SoundNode> {
    const json = await node.serialize();
    const parent = new Node('parent');
    SoundNode.parse(parent, json);
    const parsed = parent.children[0];
    expect(parsed).toBeInstanceOf(SoundNode);
    return parsed as SoundNode;
}

describe('SoundNode serialization', () => {
    it('round-trips a fully authored spatial emitter', async () => {
        const node = new SoundNode('waterfall', {
            mode: 'spatial',
            sampleId: 'sample-abc',
            volume: 0.6,
            loopMode: 'on',
            playOnStart: false,
            distanceModel: 'exponential',
            refDistance: 3,
            maxDistance: 60,
            rolloffFactor: 1.5,
        });

        const parsed = await roundTrip(node);
        expect(parsed.name).toBe('waterfall');
        expect(parsed.nodeType).toBe('sound');
        expect(parsed.mode).toBe('spatial');
        expect(parsed.sampleId).toBe('sample-abc');
        expect(parsed.volume).toBeCloseTo(0.6);
        expect(parsed.loopMode).toBe('on');
        expect(parsed.playOnStart).toBe(false);
        expect(parsed.spatial).toEqual({
            distanceModel: 'exponential', refDistance: 3, maxDistance: 60, rolloffFactor: 1.5,
        });
    });

    it('round-trips an ambient emitter, keeping its spatial fields', async () => {
        // The spatial settings are preserved rather than dropped, so flipping a node to ambient and back
        // does not silently reset a falloff the user tuned.
        const node = new SoundNode('music', { mode: 'ambient', sampleId: 's', maxDistance: 42 });
        const parsed = await roundTrip(node);
        expect(parsed.mode).toBe('ambient');
        expect(parsed.maxDistance).toBe(42);
    });

    it('preserves the node id and transform through the round trip', async () => {
        const node = new SoundNode('emitter', { sampleId: 's' }, 'fixed-id');
        node.setPosition([1, 2, 3]);
        const parsed = await roundTrip(node);
        expect(parsed.id).toBe('fixed-id');
        expect(Array.from(parsed.position)).toEqual([1, 2, 3]);
    });

    it('parses a payload with no `sound` key to defaults', async () => {
        // What a node written by an older build, or by hand, looks like.
        const parent = new Node('parent');
        SoundNode.parse(parent, { name: 'bare', id: 'x', type: 'sound' });
        const parsed = parent.children[0] as SoundNode;
        expect(parsed.mode).toBe('spatial');
        expect(parsed.sampleId).toBeNull();
        expect(parsed.volume).toBe(1);
        expect(parsed.loopMode).toBe('inherit');
        expect(parsed.playOnStart).toBe(true);
        expect(parsed.spatial).toEqual(DEFAULT_SPATIAL_SETTINGS);
    });

    it('repairs a hostile payload instead of carrying it into the panner', async () => {
        const parent = new Node('parent');
        SoundNode.parse(parent, {
            name: 'broken', id: 'x', type: 'sound',
            sound: {
                mode: 'quadraphonic', volume: 12, loopMode: 'sometimes',
                distanceModel: 'magic', refDistance: -4, maxDistance: -9, rolloffFactor: 1e9,
            },
        });
        const parsed = parent.children[0] as SoundNode;
        // An unrecognised mode is spatial, which is the placeable one — an emitter you can see and move.
        expect(parsed.mode).toBe('spatial');
        expect(parsed.volume).toBe(1);
        expect(parsed.loopMode).toBe('inherit');
        expect(parsed.distanceModel).toBe('inverse');
        expect(parsed.refDistance).toBeGreaterThan(0);
        // The linear model divides by (max - ref); these must never come back equal or inverted.
        expect(parsed.maxDistance).toBeGreaterThan(parsed.refDistance);
        expect(parsed.rolloffFactor).toBeLessThanOrEqual(10);
    });

    it('clamps through the setters, not just the constructor', () => {
        const node = new SoundNode('emitter');
        node.volume = 99;
        expect(node.volume).toBe(1);
        node.volume = -1;
        expect(node.volume).toBe(0);
        node.maxDistance = -5;
        expect(node.maxDistance).toBeGreaterThan(node.refDistance);
        node.loopMode = 'whenever' as never;
        expect(node.loopMode).toBe('inherit');
    });

    it('is inert with no sample registered, rather than throwing', () => {
        // The missing-asset path: a scene referencing a sample that was deleted must still load and run.
        const node = new SoundNode('emitter', { sampleId: 'does-not-exist' });
        expect(() => node.play()).not.toThrow();
        expect(node.isPlaying).toBe(false);
        expect(() => node.syncSpatial()).not.toThrow();
        expect(() => node.stop()).not.toThrow();
        expect(() => node.fadeTo(0.5, 1)).not.toThrow();
    });

    it('gives the editor a selectable box around its origin', () => {
        const node = new SoundNode('emitter');
        node.setPosition([5, 0, 0]);
        node.updateTransforms();
        const box = node.getBoundingBox();
        expect(box.min[0]).toBeLessThan(5);
        expect(box.max[0]).toBeGreaterThan(5);
    });
});
