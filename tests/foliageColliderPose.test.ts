import { describe, it, expect } from 'vitest';
import { Cylinder } from 'cannon-es';
import { foliageColliderPose, buildFoliageColliderBody } from '../src/terrain/foliageColliders';

// A foliage collider's shape is computed ONCE (foliageColliderPose) and used by the physics body, the
// editor's collider preview and its viewport overlay, so what you see is what you bump into.

const extent = (body: ReturnType<typeof buildFoliageColliderBody>) => {
    body.updateAABB();
    const { lowerBound: lo, upperBound: hi } = body.aabb;
    return [hi.x - lo.x, hi.y - lo.y, hi.z - lo.z, (hi.y + lo.y) / 2];
};

describe('foliage collider shape', () => {
    it("cannon-es's Cylinder is Y-up — the premise of dropping the old -90° turn", () => {
        const c = new Cylinder(0.5, 0.5, 4, 8);
        const ys = c.vertices.map(v => v.y);
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(4, 6);
    });

    it('a cylinder trunk stands upright, centred at half its height by default', () => {
        const [x, y, z, cy] = extent(buildFoliageColliderBody({ shape: 'cylinder', radius: 0.4, height: 6 }, 1));
        expect(y).toBeCloseTo(6, 4);
        expect(x).toBeLessThan(1);
        expect(z).toBeLessThan(1);
        expect(cy).toBeCloseTo(3, 4);
    });

    it('scales with the instance and honours an explicit centre height', () => {
        const pose = foliageColliderPose({ shape: 'cylinder', radius: 0.4, height: 6, offsetY: 1 }, 2);
        expect(pose).toEqual({ shape: 'cylinder', size: [1.6, 12, 1.6], offsetY: 2 });
        const [, y, , cy] = extent(buildFoliageColliderBody({ shape: 'cylinder', radius: 0.4, height: 6, offsetY: 1 }, 2));
        expect(y).toBeCloseTo(12, 4);
        expect(cy).toBeCloseTo(2, 4);
    });

    it('box width/depth are HALF-widths (how every saved collider has been read); the pose gives full sizes', () => {
        const pose = foliageColliderPose({ shape: 'box', width: 1, depth: 0.5, height: 2 }, 1);
        expect(pose.size).toEqual([2, 2, 1]);
        const [x, y, z] = extent(buildFoliageColliderBody({ shape: 'box', width: 1, depth: 0.5, height: 2 }, 1));
        expect([x, y, z].map(v => +v.toFixed(4))).toEqual([2, 2, 1]);
    });

    it('a sphere sits on the ground by default', () => {
        const pose = foliageColliderPose({ shape: 'sphere', radius: 0.7 }, 1);
        expect(pose.size).toEqual([1.4, 1.4, 1.4]);
        expect(pose.offsetY).toBeCloseTo(0.7, 6);
    });
});
