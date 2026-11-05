import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Node } from '../src/core/scene/nodes/node';
import { LandscapeHistory } from '../src/graphics/render/landscapeHistory';

/**
 * Terrain chunks take their motion history from their landscape's: a chunk's previous world matrix is the
 * landscape's previous one times the chunk's local transform. That has to equal, bit for bit, the snapshot
 * a per-chunk history would have copied from the chunk's own world matrix — and a chunk "moved" exactly
 * when its landscape did.
 */
function rig() {
    const landscape = new Node('landscape');
    const chunk = new Node('chunk');
    chunk.setPosition([12.5, 0, -37.25]);
    landscape.addChild(chunk);
    landscape.setPosition([3.1, -2.2, 7.7]);
    landscape.setQuaternion(quat.setAxisAngle(quat.create(), vec3.normalize(vec3.create(), [0.2, 1, 0.1]), 0.7));
    landscape.updateTransforms();
    return { landscape, chunk };
}

describe('LandscapeHistory', () => {
    it("derives a chunk's previous world matrix exactly as a per-chunk snapshot would hold it", () => {
        const { landscape, chunk } = rig();
        const h = new LandscapeHistory();
        h.capture(landscape, 10);
        const snapshot = mat4.clone(chunk.worldTransform);   // what per-chunk history copied
        landscape.setPosition([4, -2.2, 7.7]);
        landscape.updateTransforms();
        expect(snapshot.every(Number.isFinite)).toBe(true);
        const out = mat4.create();
        expect(h.prevWorld(landscape, chunk, 11, out)).toBe(out);
        expect(Array.from(out)).toEqual(Array.from(snapshot));
        expect(h.moved(landscape, 11)).toBe(true);
    });

    it('reports no motion while the landscape stays put, and no history unless it is from the frame before', () => {
        const { landscape, chunk } = rig();
        const h = new LandscapeHistory();
        expect(h.prevWorld(landscape, chunk, 1, mat4.create())).toBeNull();
        expect(h.moved(landscape, 1)).toBe(false);
        h.capture(landscape, 1);
        landscape.updateTransforms();               // nothing changed: the version stays
        expect(h.fresh(landscape, 2)).toBe(true);
        expect(h.moved(landscape, 2)).toBe(false);
        expect(Array.from(h.prevWorld(landscape, chunk, 2, mat4.create())!)).toEqual(Array.from(chunk.worldTransform));
        // A stale entry (skipped frames) is no history at all.
        expect(h.fresh(landscape, 4)).toBe(false);
        expect(h.prevWorld(landscape, chunk, 4, mat4.create())).toBeNull();
        landscape.setPosition([9, 9, 9]); landscape.updateTransforms();
        expect(h.moved(landscape, 4)).toBe(false);
    });
});
