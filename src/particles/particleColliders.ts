import { bodyTargets, rotate, type OverlapBody } from '../physics/overlap';

// Physics bodies as particle colliders: the bodies near a particle system, reduced to the analytic shapes
// the simulation shader tests every particle against — sparks bouncing off a floor, a magic bolt's embers
// skittering over the ground, cinders sliding off a shield that is moving through them.
//
// The scene-depth collision mode only knows what is on screen; this one knows what the PHYSICS knows, so
// it works off screen, behind other geometry and in the dark. It is the GPU half's input, gathered on the
// CPU once per system per frame: the shader cannot walk cannon's body list.
//
// Shapes are exact for what levels and props are made of: spheres, boxes, capsules (and cylinders, as
// capsules), planes, and convex hulls (as their oriented bounding box). Trimeshes and heightfields are
// left out — combine with Scene depth for terrain.

/** The most colliders one emitter step tests. Four texels each in `u_colliders`. */
export const MAX_PARTICLE_COLLIDERS = 12;
/** Floats per collider in the packed array: four vec4 texels. */
export const COLLIDER_FLOATS = 16;

/** Collider kinds, as `u_colliders[4i].w`. Must match COLLIDER_* in chunks/particleSimCore.wgsl. */
export const COLLIDER_KIND = { CAPSULE: 1, BOX: 2, PLANE: 3 } as const;

type V3 = [number, number, number];

/** The subset of a cannon body this reads, on top of what the overlap queries already need. */
export interface ColliderBody extends OverlapBody {
    velocity?: { x: number; y: number; z: number };
}

interface Candidate { gap: number; write: (out: Float32Array, at: number) => void }

const qmul = (a: readonly number[], b: readonly number[]): [number, number, number, number] => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** Whether a body takes part in collisions at all. A trigger volume is a sensor, not a surface. */
function isSolid(body: ColliderBody): boolean {
    if (body.isTrigger) return false;
    if (body.collisionResponse === false) return false;
    return true;
}

/**
 * Pack the colliders of `bodies` that can reach a sphere at `center` with `radius` (the system's bounds)
 * into `out`, nearest first, at most {@link MAX_PARTICLE_COLLIDERS}. Returns how many were written.
 *
 * Layout per collider (4 texels, WORLD space):
 *   capsule  [a.xyz, 1]  [b.xyz, radius]   [0]             [velocity.xyz, 0]   a sphere is a == b
 *   box      [c.xyz, 2]  [rotation xyzw]  [half.xyz, 0]   [velocity.xyz, 0]
 *   plane    [p.xyz, 3]  [normal.xyz, 0]  [0]             [velocity.xyz, 0]
 *
 * The velocity is the body's linear velocity: a particle bounces off a moving body RELATIVE to it, so a
 * swung shield bats embers away instead of letting them sit on its face.
 */
export function packParticleColliders(bodies: Iterable<ColliderBody>, center: ArrayLike<number>, radius: number,
                                      out: Float32Array): number {
    const c: V3 = [center[0], center[1], center[2]];
    const candidates: Candidate[] = [];

    for (const body of bodies) {
        if (!isSolid(body) || !body.shapes?.length) continue;
        const bp: V3 = [body.position.x, body.position.y, body.position.z];
        const bounding = Number.isFinite(body.boundingRadius) ? body.boundingRadius : Infinity;
        const centerGap = Math.hypot(bp[0] - c[0], bp[1] - c[1], bp[2] - c[2]) - bounding;
        if (centerGap > radius) continue;
        const v: V3 = body.velocity ? [body.velocity.x, body.velocity.y, body.velocity.z] : [0, 0, 0];

        // Spheres, boxes, capsules, cylinders: the same world-space resolution the overlap queries use.
        for (const t of bodyTargets(body)) {
            if (t.kind === 'capsule') {
                const mid: V3 = [(t.a[0] + t.b[0]) / 2, (t.a[1] + t.b[1]) / 2, (t.a[2] + t.b[2]) / 2];
                const half = Math.hypot(t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]) / 2;
                const gap = Math.hypot(mid[0] - c[0], mid[1] - c[1], mid[2] - c[2]) - half - t.radius;
                if (gap > radius) continue;
                candidates.push({ gap, write: (o, at) => {
                    o.set([t.a[0], t.a[1], t.a[2], COLLIDER_KIND.CAPSULE, t.b[0], t.b[1], t.b[2], t.radius,
                           0, 0, 0, 0, v[0], v[1], v[2], 0], at);
                } });
            } else {
                const gap = Math.hypot(t.center[0] - c[0], t.center[1] - c[1], t.center[2] - c[2])
                    - Math.hypot(t.half[0], t.half[1], t.half[2]);
                if (gap > radius) continue;
                candidates.push({ gap, write: (o, at) => boxInto(o, at, t.center, t.rotation, t.half, v) });
            }
        }

        // Planes and convex hulls, which the overlap queries leave out.
        const bq = [body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w];
        for (let i = 0; i < body.shapes.length; i++) {
            const shape = body.shapes[i];
            const o = body.shapeOffsets[i], so = body.shapeOrientations[i];
            const off = rotate(bq, [o.x, o.y, o.z]);
            const sc: V3 = [bp[0] + off[0], bp[1] + off[1], bp[2] + off[2]];
            const q = qmul(bq, [so.x, so.y, so.z, so.w]);
            const type = shape.type;
            if (type === 2 || shape.constructor?.name === 'Plane') {
                // cannon's plane faces its local +Z.
                const n = rotate(q, [0, 0, 1]);
                const gap = Math.max(0, n[0] * (c[0] - sc[0]) + n[1] * (c[1] - sc[1]) + n[2] * (c[2] - sc[2]));
                if (gap > radius) continue;
                candidates.push({ gap: -1, write: (out2, at) => {
                    out2.set([sc[0], sc[1], sc[2], COLLIDER_KIND.PLANE, n[0], n[1], n[2], 0,
                              0, 0, 0, 0, v[0], v[1], v[2], 0], at);
                } });
            } else if ((type === 16 || shape.constructor?.name === 'ConvexPolyhedron') && Array.isArray(shape.vertices)) {
                // A hull as its local bounding box: exact for the boxy props hulls usually are, and a
                // slightly generous shell for the rest — a spark cannot tell.
                const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
                for (const p of shape.vertices) {
                    min[0] = Math.min(min[0], p.x); min[1] = Math.min(min[1], p.y); min[2] = Math.min(min[2], p.z);
                    max[0] = Math.max(max[0], p.x); max[1] = Math.max(max[1], p.y); max[2] = Math.max(max[2], p.z);
                }
                if (!Number.isFinite(min[0])) continue;
                const localMid = rotate(q, [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]);
                const bc: V3 = [sc[0] + localMid[0], sc[1] + localMid[1], sc[2] + localMid[2]];
                const half: V3 = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
                const gap = Math.hypot(bc[0] - c[0], bc[1] - c[1], bc[2] - c[2]) - Math.hypot(half[0], half[1], half[2]);
                if (gap > radius) continue;
                candidates.push({ gap, write: (o2, at) => boxInto(o2, at, bc, q, half, v) });
            }
        }
    }

    // Nearest first, so a crowded scene keeps the surfaces the effect is actually among.
    candidates.sort((a, b) => a.gap - b.gap);
    const count = Math.min(candidates.length, MAX_PARTICLE_COLLIDERS);
    for (let i = 0; i < count; i++) candidates[i].write(out, i * COLLIDER_FLOATS);
    return count;
}

function boxInto(out: Float32Array, at: number, center: readonly number[], q: readonly number[],
                 half: readonly number[], v: readonly number[]): void {
    out.set([center[0], center[1], center[2], COLLIDER_KIND.BOX, q[0], q[1], q[2], q[3],
             half[0], half[1], half[2], 0, v[0], v[1], v[2], 0], at);
}
