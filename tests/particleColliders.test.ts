import { describe, it, expect } from 'vitest';
import {
    packParticleColliders, COLLIDER_KIND, COLLIDER_FLOATS, MAX_PARTICLE_COLLIDERS, type ColliderBody,
} from '../src/particles/particleColliders';
import { SIM, packEmitter } from '../src/particles/particlePack';
import { defaultEmitter, makeModule } from '../src/particles/particleSystemAsset';

// The CPU half of particles bouncing off physics bodies: which bodies around an effect are handed to the
// simulation, and in what layout. The GPU half (collideBodies in particleSimCore.wgsl) reads exactly this.

let nextId = 1;
const ident = { x: 0, y: 0, z: 0, w: 1 };
function body(position: [number, number, number], shapes: any[], extra: Partial<ColliderBody> = {}): ColliderBody {
    return {
        id: nextId++,
        position: { x: position[0], y: position[1], z: position[2] },
        quaternion: { ...ident },
        shapes,
        shapeOffsets: shapes.map(() => ({ x: 0, y: 0, z: 0 })),
        shapeOrientations: shapes.map(() => ({ ...ident })),
        boundingRadius: 2,
        ...extra,
    };
}
const box = (hx: number, hy: number, hz: number) => ({ type: 4, halfExtents: { x: hx, y: hy, z: hz } });
const sphere = (r: number) => ({ type: 1, radius: r });

const pack = (bodies: ColliderBody[], center: [number, number, number] = [0, 0, 0], radius = 5) => {
    const out = new Float32Array(MAX_PARTICLE_COLLIDERS * COLLIDER_FLOATS);
    const count = packParticleColliders(bodies, center, radius, out);
    const at = (i: number) => Array.from(out.subarray(i * COLLIDER_FLOATS, (i + 1) * COLLIDER_FLOATS));
    return { count, at };
};

describe('packParticleColliders', () => {
    it('packs a floor box with its centre, rotation, half extents and velocity', () => {
        const floor = body([0, -0.5, 0], [box(10, 0.5, 10)], { velocity: { x: 1, y: 0, z: 0 } });
        const { count, at } = pack([floor]);
        expect(count).toBe(1);
        expect(at(0)).toEqual([0, -0.5, 0, COLLIDER_KIND.BOX, 0, 0, 0, 1, 10, 0.5, 10, 0, 1, 0, 0, 0]);
    });

    it('packs a sphere as a capsule whose two ends coincide', () => {
        const { at } = pack([body([1, 2, 3], [sphere(0.5)])]);
        expect(at(0).slice(0, 8)).toEqual([1, 2, 3, COLLIDER_KIND.CAPSULE, 1, 2, 3, 0.5]);
    });

    it('packs a cannon plane by its +Z normal, and a convex hull as its bounding box', () => {
        const ground = body([0, 0, 0], [{ type: 2 }], { boundingRadius: Infinity });
        // Rotate the plane -90 deg about X so its +Z normal points up.
        const s = Math.SQRT1_2;
        ground.quaternion = { x: -s, y: 0, z: 0, w: s };
        const hull = body([3, 0, 0], [{ type: 16, vertices: [{ x: -1, y: 0, z: -1 }, { x: 1, y: 2, z: 1 }] }]);
        const { count, at } = pack([ground, hull]);
        expect(count).toBe(2);
        const plane = at(0);
        expect(plane[3]).toBe(COLLIDER_KIND.PLANE);
        expect(plane[5]).toBeCloseTo(1, 5);   // normal +Y
        const b = at(1);
        expect(b[3]).toBe(COLLIDER_KIND.BOX);
        expect(b.slice(0, 3)).toEqual([3, 1, 0]);  // local AABB centre (0,1,0) moved to the body
        expect(b.slice(8, 11)).toEqual([1, 1, 1]);
    });

    it('leaves out triggers and bodies out of reach', () => {
        const trigger = body([0, 0, 0], [box(1, 1, 1)], { isTrigger: true });
        const sensor = body([0, 0, 0], [box(1, 1, 1)], { collisionResponse: false });
        const far = body([100, 0, 0], [box(1, 1, 1)]);
        expect(pack([trigger, sensor, far]).count).toBe(0);
    });

    it('keeps the nearest when more than the cap are in reach', () => {
        const bodies = Array.from({ length: 20 }, (_, i) => body([i * 0.2, 0, 0], [sphere(0.1)]));
        const { count, at } = pack(bodies.slice().reverse(), [0, 0, 0], 10);
        expect(count).toBe(MAX_PARTICLE_COLLIDERS);
        expect(at(0)[0]).toBeCloseTo(0, 5);
        expect(at(MAX_PARTICLE_COLLIDERS - 1)[0]).toBeCloseTo((MAX_PARTICLE_COLLIDERS - 1) * 0.2, 5);
    });
});

describe('collision module: physics bodies', () => {
    const emitter = (params: Record<string, unknown>) => {
        const e = defaultEmitter();
        const m = makeModule('collision');
        m.params = params as any;
        e.update = [m];
        return e;
    };
    it('is opt-in, so assets authored before it collide exactly as they did', () => {
        expect(packEmitter(emitter({ depth: true })).simMask & SIM.COLLIDE_BODIES).toBe(0);
        expect(packEmitter(emitter({ depth: true, bodies: true })).simMask & SIM.COLLIDE_BODIES).toBe(SIM.COLLIDE_BODIES);
    });
    it('is on for a collision module added now', () => {
        expect(makeModule('collision').params.bodies).toBe(true);
    });
});
