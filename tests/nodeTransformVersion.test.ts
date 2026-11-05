import { describe, expect, it } from 'vitest';
import { mat4 } from 'gl-matrix';
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

// `updateTransforms` skips recomposing a node whose position/rotation/scale and parent matrix are what it
// last composed from. These pin that the world matrices stay exactly what a from-scratch compose gives,
// whatever the edit — and that the skip never trusts a parent it did not compose against.
describe('Node.updateTransforms skipping unchanged nodes', () => {
    /** The world matrix composed from scratch: every ancestor's local TRS, root first. */
    const fromScratch = (node: Node): mat4 => {
        const chain: Node[] = [];
        for (let n: Node | null = node; n; n = n.parent) chain.unshift(n);
        const out = mat4.create(), local = mat4.create();
        for (const n of chain) {
            mat4.fromRotationTranslationScale(local, n.quaternion, n.position, n.scale);
            mat4.multiply(out, out, local);
        }
        return out;
    };
    const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

    it('keeps every world matrix equal to a from-scratch compose under random edits and reparenting', () => {
        const r = rng(7);
        const root = new Node('root');
        const nodes: Node[] = [];
        for (let i = 0; i < 40; i++) {
            const n = new Node(`n${i}`);
            (nodes.length && r() < 0.8 ? nodes[Math.floor(r() * nodes.length)] : root).addChild(n);
            nodes.push(n);
        }
        root.updateTransforms();
        for (let frame = 0; frame < 60; frame++) {
            for (let e = 0; e < 4; e++) {
                const n = nodes[Math.floor(r() * nodes.length)];
                const kind = r();
                if (kind < 0.3) n.setPosition([r() * 10, r() * 10, r() * 10]);
                else if (kind < 0.55) n.setRotation([r() * 360, r() * 360, r() * 360]);
                else if (kind < 0.7) n.setScale([0.5 + r(), 0.5 + r(), 0.5 + r()]);
                else if (kind < 0.85) {
                    // Reparent onto a node outside its own subtree.
                    const target = nodes[Math.floor(r() * nodes.length)];
                    let inside = false;
                    for (let p: Node | null = target; p; p = p.parent) if (p === n) inside = true;
                    if (!inside) { n.parent?.removeChild(n); target.addChild(n); }
                }
            }
            root.updateTransforms();
            for (const n of nodes) {
                const expected = fromScratch(n);
                for (let i = 0; i < 16; i++) expect(n.worldTransform[i]).toBeCloseTo(expected[i], 4);
            }
        }
    });

    it('recomposes after a reparent even when the new parent carries the same version', () => {
        const a = new Node('a'), b = new Node('b'), child = new Node('child');
        a.setPosition([1, 0, 0]);
        b.setPosition([0, 7, 0]);
        a.addChild(child);
        a.updateTransforms();
        b.updateTransforms();
        expect(a.transformVersion).toBe(b.transformVersion);   // both moved once
        a.removeChild(child);
        b.addChild(child);
        b.updateTransforms();
        expect(Array.from(child.worldTransform.slice(12, 15))).toEqual([0, 7, 0]);
    });

    it('composes as a root when told so, then follows its parent again', () => {
        const parent = new Node('p'), child = new Node('c');
        parent.setPosition([0, 5, 0]);
        child.setPosition([1, 0, 0]);
        parent.addChild(child);
        parent.updateTransforms();
        expect(Array.from(child.worldTransform.slice(12, 15))).toEqual([1, 5, 0]);
        child.updateTransforms(null);
        expect(Array.from(child.worldTransform.slice(12, 15))).toEqual([1, 0, 0]);
        parent.updateTransforms();
        expect(Array.from(child.worldTransform.slice(12, 15))).toEqual([1, 5, 0]);
    });

    it('overwrites a direct write into the world matrix at the next update', () => {
        const node = new Node('n');
        node.setPosition([2, 0, 0]);
        node.updateTransforms();
        node.worldTransform[12] = 99;
        node.updateTransforms();
        expect(node.worldTransform[12]).toBe(2);
    });

    it('notices a write straight into the live position array', () => {
        const node = new Node('n');
        node.updateTransforms();
        node.position[1] = 3;   // discouraged, but it has to work
        node.updateTransforms();
        expect(node.worldTransform[13]).toBe(3);
        expect(node.worldPosition[1]).toBe(3);
    });
});
