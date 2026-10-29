import { describe, it, expect } from 'vitest';
import { quat, vec3 } from 'gl-matrix';
import { Node } from '../src/core/scene/nodes/node';

// A physics body lives in WORLD space. These pin the node side of that for a bodied node under a moved,
// turned parent: it is created where it is drawn, a local write puts the body at `parentWorld · local`,
// and the world setters solve the local pose back out (what the physics write-back uses).

const box = { type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] };

function parentedCrate(mass: number) {
    const root = new Node('root');
    Node.parse(root, {
        name: 'group', nodeType: 'node', id: 'group',
        position: [10, 0, 5], rotation: [0, 90, 0], scale: [1, 1, 1],
    } as any);
    root.updateTransforms();
    const group = root.getChildByName('group')[0];
    Node.parse(group, {
        name: 'crate', nodeType: 'node', id: 'crate',
        position: [2, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        body: { mass, shapes: [box] },
    } as any);
    root.updateTransforms();
    const crate = group.getChildByName('crate')[0];
    return { root, group, crate };
}

describe('a body under a moved, turned parent', () => {
    it('is created where its node is drawn', () => {
        const { crate } = parentedCrate(0);
        const w = crate.worldPosition;
        // Local (2, 1, 0) turned 90° about Y is (0, 1, -2), plus the group's (10, 0, 5).
        expect([w[0], w[1], w[2]].map(v => +v.toFixed(4))).toEqual([10, 1, 3]);
        const b = crate.body!.position;
        expect([b.x, b.y, b.z].map(v => +v.toFixed(4))).toEqual([10, 1, 3]);
    });

    it('a local setPosition puts the body at parentWorld · local', () => {
        const { crate } = parentedCrate(2);
        crate.setPosition(vec3.fromValues(0, 2, 3));
        const b = crate.body!.originPosition([0, 0, 0]);
        // (0, 2, 3) turned 90° about Y is (3, 2, 0); plus (10, 0, 5).
        expect(Array.from(b).map(v => +v.toFixed(4))).toEqual([13, 2, 5]);
    });

    it('a local rotation turns the body by the parent\'s world rotation too', () => {
        const { crate } = parentedCrate(2);
        crate.setRotation([0, 0, 0]);
        const q = crate.body!.quaternion;
        const yaw90 = quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2);
        expect(Math.abs(quat.dot(quat.fromValues(q.x, q.y, q.z, q.w), yaw90))).toBeGreaterThan(0.9999);
    });

    it('setWorldPosition / setWorldQuaternion solve the local pose under the parent', () => {
        const { root, crate } = parentedCrate(2);
        crate.setWorldPosition([12, 3, 5]);
        const yaw180 = quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI);
        crate.setWorldQuaternion(yaw180);
        root.updateTransforms();
        const w = crate.worldPosition;
        expect([w[0], w[1], w[2]].map(v => +v.toFixed(4))).toEqual([12, 3, 5]);
        expect(Math.abs(quat.dot(crate.worldQuaternion, yaw180))).toBeGreaterThan(0.9999);
        // ...and the body agrees with where the node now is.
        const b = crate.body!.originPosition([0, 0, 0]);
        expect(Array.from(b).map(v => +v.toFixed(4))).toEqual([12, 3, 5]);
        const q = crate.body!.quaternion;
        expect(Math.abs(quat.dot(quat.fromValues(q.x, q.y, q.z, q.w), yaw180))).toBeGreaterThan(0.9999);
    });

    it('at the root, world and local agree as they always did', () => {
        const root = new Node('root');
        Node.parse(root, {
            name: 'crate', nodeType: 'node', id: 'c', position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1],
            body: { mass: 1, shapes: [box] },
        } as any);
        root.updateTransforms();
        const crate = root.getChildByName('crate')[0];
        crate.setWorldPosition([4, 5, 6]);
        expect(Array.from(crate.position)).toEqual([4, 5, 6]);
        expect(Array.from(crate.body!.originPosition([0, 0, 0])).map(v => +v.toFixed(5))).toEqual([4, 5, 6]);
    });
});
