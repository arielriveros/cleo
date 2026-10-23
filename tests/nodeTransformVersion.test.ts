import { describe, expect, it } from 'vitest';
import { Geometry } from '../src/core/geometry';
import { Node } from '../src/core/scene/nodes/node';
import { ModelNode } from '../src/core/scene/nodes/modelNode';
import { Model } from '../src/graphics/model';

// `calculateTangents = false`: tangent generation needs uvs/indices and is irrelevant here.
const geometryOf = (positions: [number, number, number][]) =>
    new Geometry(positions, [], [], [], [], [], false);

describe('Node.transformVersion', () => {
    it('moves only when the world matrix does', () => {
        const node = new Node('n');
        node.updateTransforms();
        const v = node.transformVersion;
        node.updateTransforms();
        node.updateTransforms();
        expect(node.transformVersion).toBe(v);
        node.setPosition([1, 2, 3]);
        node.updateTransforms();
        expect(node.transformVersion).toBeGreaterThan(v);
    });

    it('follows a parent that moved, with the child itself untouched', () => {
        const parent = new Node('p');
        const child = new Node('c');
        parent.addChild(child);
        parent.updateTransforms();
        const v = child.transformVersion;
        parent.setPosition([0, 5, 0]);
        parent.updateTransforms();
        expect(child.transformVersion).toBeGreaterThan(v);
    });

    it('compares against its own snapshot, not the live matrix', () => {
        const node = new Node('n');
        node.updateTransforms();
        const v = node.transformVersion;
        // A write into the live matrix is overwritten by the next update, which recomputes it from the
        // unchanged local transform: nothing moved, and the version agrees. A real move after it counts.
        node.worldTransform[12] = 99;
        node.updateTransforms();
        expect(node.transformVersion).toBe(v);
        node.setPosition([99, 0, 0]);
        node.updateTransforms();
        expect(node.transformVersion).toBeGreaterThan(v);
    });
});

describe('ModelNode.getBoundingSphere across frames', () => {
    // A Model shell carrying only its geometry: no GL context here, and the sphere needs nothing more.
    const make = () => {
        const model = Object.create(Model.prototype);
        model._geometry = geometryOf([[-1, -1, -1], [1, 1, 1]]);
        model._materials = [];
        return new ModelNode('m', model);
    };

    it('is the same sphere for an unmoved node, and a new one once it moves or scales', () => {
        const node = make();
        node.updateTransforms();
        const a = { center: [...node.getBoundingSphere().center], radius: node.getBoundingSphere().radius };
        node.updateTransforms();
        expect([...node.getBoundingSphere().center]).toEqual(a.center);
        expect(node.getBoundingSphere().radius).toBe(a.radius);

        node.setPosition([10, 0, 0]);
        node.setScale([2, 3, 2]);
        node.updateTransforms();
        const s = node.getBoundingSphere();
        expect(s.center[0]).toBeCloseTo(10, 6);
        expect(s.radius).toBeCloseTo(a.radius * 3, 5);
    });

    it('follows an edit of its vertices, which moves no transform', () => {
        const node = make();
        node.updateTransforms();
        const before = node.getBoundingSphere().radius;
        const g = node.model.geometry;
        g.positions[0] = -5;   // stretch the box along x
        g.invalidateBounds();
        node.invalidateWorldBounds();
        node.updateTransforms();
        expect(node.getBoundingSphere().radius).toBeGreaterThan(before);
    });
});
