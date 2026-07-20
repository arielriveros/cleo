import { describe, it, expect } from 'vitest';
import { Geometry } from '../src/core/geometry';

// `calculateTangents = false`: tangent generation needs uvs/indices and is irrelevant here.
const geometryOf = (positions: [number, number, number][]) =>
    new Geometry(positions, [], [], [], [], [], false);

describe('Geometry.boundingBox', () => {
    it('spans the extents of the positions', () => {
        const g = geometryOf([[-1, 0, 3], [2, -4, 0], [0, 5, -6]]);
        expect([...g.boundingBox.min]).toEqual([-1, -4, -6]);
        expect([...g.boundingBox.max]).toEqual([2, 5, 3]);
    });

    it('is memoized', () => {
        const g = geometryOf([[0, 0, 0], [1, 1, 1]]);
        expect(g.boundingBox).toBe(g.boundingBox);
    });

    /**
     * The whole point of computing this from a direct position pass rather than from `bvh.bounds` the
     * way boundingSphere does. A camera rig queries the box every frame; if that could trigger a BVH
     * build, the first probe near any never-picked mesh would hitch — and the symptom (one bad frame,
     * once) is nearly impossible to attribute after the fact.
     */
    it('does not build the BVH', () => {
        const g = geometryOf([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
        void g.boundingBox;
        expect((g as any)._bvh).toBeUndefined();

        // Control: boundingSphere *does* build it, which is what this guard is protecting against.
        void g.boundingSphere;
        expect((g as any)._bvh).toBeDefined();
    });

    it('handles a single vertex as a degenerate box', () => {
        const g = geometryOf([[2, 3, 4]]);
        expect([...g.boundingBox.min]).toEqual([2, 3, 4]);
        expect([...g.boundingBox.max]).toEqual([2, 3, 4]);
    });

    // Must not leave Infinity in the box: an infinite AABB makes every ray "hit" the node.
    it('collapses to the origin when there are no positions', () => {
        const g = geometryOf([]);
        expect([...g.boundingBox.min]).toEqual([0, 0, 0]);
        expect([...g.boundingBox.max]).toEqual([0, 0, 0]);
    });

    it('is invalidated by scale(), which mutates the positions in place', () => {
        const g = geometryOf([[-1, -2, -3], [1, 2, 3]]);
        expect([...g.boundingBox.max]).toEqual([1, 2, 3]);

        g.scale(2);
        expect([...g.boundingBox.min]).toEqual([-2, -4, -6]);
        expect([...g.boundingBox.max]).toEqual([2, 4, 6]);
    });
});
