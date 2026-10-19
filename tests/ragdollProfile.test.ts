import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Body, Plane, Vec3 } from 'cannon-es';
import { mat4, quat, vec3 } from 'gl-matrix';
import { AnimatedModel } from '../src/animation/animatedModel';
import type { Skin } from '../src/animation/animatedModel';
import { ModelNode } from '../src/core/scene/nodes/modelNode';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import type { Ragdoll } from '../src/physics/ragdoll';
import { autoHumanoidProfile, parseRagdollProfile, ragdollLayout } from '../src/physics/ragdollProfile';
import type { RagdollLayoutPart } from '../src/physics/ragdollProfile';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';

// The REAL mannequin skeleton from the Hollow Keep example: a Mixamo rig scaled 0.01, standing in its
// bind (T) pose. Earlier ragdoll bugs were only ever found against a real skeleton and the engine's
// own world config, never a synthetic one.

let modelJson: any;
beforeAll(() => {
    // The stub context celMaterial.test.ts uses: building an AnimatedModel touches the device.
    let n = 0;
    const constants: Record<string, number> = {
        UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
    };
    const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
    const gl = new Proxy({}, {
        get: (_t, key: string) => (key in constants ? constants[key] : objects.has(key) ? () => ({ id: ++n }) : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));

    const lib = JSON.parse(readFileSync('editor/public/examples/souls-demo/libraries/models.json', 'utf8'));
    const find = (n: any): any => n.model?.skin ? n : (n.children ?? []).map(find).find(Boolean);
    modelJson = find(lib[0].nodeJson).model;
});

function mannequin(): ModelNode {
    const node = new ModelNode('mannequin', AnimatedModel.parse(JSON.parse(JSON.stringify(modelJson))));
    // In a scene, as far as the ragdoll's lifetime check cares (a node with no scene ends its ragdoll).
    node.scene = {} as any;
    return node;
}
const skinOf = (n: ModelNode) => (n.model as AnimatedModel).skin as Skin;

function world(): PhysicsSystem {
    const p = new PhysicsSystem({ gravity: [0, -9.82, 0] });
    p.initialize();
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
    const ground = new Body({ mass: 0, shape: new Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    p.addBody(ground);
    return p;
}

const yAxis = (b: Body) => { const v = b.quaternion.vmult(new Vec3(0, 1, 0)); return vec3.fromValues(v.x, v.y, v.z); };

describe('the automatic humanoid profile', () => {
    it('fits sixteen segments to the mannequin with a 70 kg body', () => {
        const profile = autoHumanoidProfile(skinOf(mannequin()))!;
        expect(profile).not.toBeNull();
        expect(profile.parts.map(p => p.name).sort()).toEqual([
            'Chest', 'Foot L', 'Foot R', 'Forearm L', 'Forearm R', 'Hand L', 'Hand R', 'Head', 'Pelvis', 'Shin L', 'Shin R',
            'Spine', 'Thigh L', 'Thigh R', 'Upper Arm L', 'Upper Arm R',
        ].sort());
        const layout = ragdollLayout(skinOf(mannequin()), profile);
        expect(layout.parts).toHaveLength(profile.parts.length);
        expect(layout.parts.reduce((s, p) => s + p.mass, 0)).toBeCloseTo(1, 6);
        const byName = new Map(layout.parts.map(p => [p.part.name, p]));
        // The trunk carries half the body; a hand is a fraction of a forearm.
        const trunk = ['Pelvis', 'Spine', 'Chest'].reduce((s, n) => s + byName.get(n)!.mass, 0);
        expect(trunk).toBeGreaterThan(0.45);
        expect(byName.get('Hand L')!.mass).toBeLessThan(byName.get('Forearm L')!.mass);
        // Segments the size of a person (metres: the mannequin is ~1.8 m).
        expect(byName.get('Thigh L')!.length).toBeGreaterThan(0.3);
        expect(byName.get('Thigh L')!.radius).toBeGreaterThan(0.05);
        expect(byName.get('Head')!.radius).toBeGreaterThan(0.07);
        // Every part hangs from the one above it, and only the pelvis is a root.
        expect(layout.parts.filter(p => p.parent < 0).map(p => p.part.name)).toEqual(['Pelvis']);
        expect(layout.parts[byName.get('Shin L')!.parent].part.name).toBe('Thigh L');
        expect(layout.parts[byName.get('Upper Arm R')!.parent].part.name).toBe('Chest');
    });

    it('bends knees backwards and elbows forwards', () => {
        const layout = ragdollLayout(skinOf(mannequin()), autoHumanoidProfile(skinOf(mannequin()))!);
        const p = (n: string) => layout.parts.find(x => x.part.name === n)!;
        // A positive bend turns the shin toward the back, the forearm toward the front.
        const bent = (name: string) => {
            const lp = p(name);
            return vec3.transformQuat(vec3.create(), lp.childAxis, quat.setAxisAngle(quat.create(), lp.hingeAxis!, Math.PI / 2));
        };
        expect(vec3.dot(bent('Shin L'), layout.forward)).toBeLessThan(-0.9);
        expect(vec3.dot(bent('Forearm R'), layout.forward)).toBeGreaterThan(0.9);
    });

    it('is not invented for a skeleton that is not a person', () => {
        const skin = { joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create(), parentIndex: -1 }],
            nodeNames: new Map([[0, 'Tail']]) } as unknown as Skin;
        expect(autoHumanoidProfile(skin)).toBeNull();
    });

    it('round-trips through the tolerant reader', () => {
        const profile = autoHumanoidProfile(skinOf(mannequin()))!;
        const json = JSON.parse(JSON.stringify(profile));
        expect(parseRagdollProfile(json)).toEqual(json);
        expect(parseRagdollProfile({ parts: 'nope' })).toBeUndefined();
    });
});

describe('a profile ragdoll falling', () => {
    function setup() {
        const p = world();
        const node = mannequin();
        const layout = ragdollLayout(skinOf(node), autoHumanoidProfile(skinOf(node))!);
        const r = p.startRagdoll(node);
        const body = (n: string) => r.bodies.get(layout.parts.find(x => x.part.name === n)!.node)!;
        return { p, node, layout, r, body };
    }

    /** Signed hinge angle of `child` relative to its bind, degrees, positive toward the bend. */
    function hingeAngle(layout: ReturnType<typeof setup>['layout'], r: Ragdoll, child: string): number {
        const lp = layout.parts.find(x => x.part.name === child)!;
        const pp = layout.parts[lp.parent];
        const parentBody = r.bodies.get(pp.node)!, childBody = r.bodies.get(lp.node)!;
        // Axis and both segment directions, all taken into the PARENT body's bind frame.
        const toParent = (q: quat) => quat.multiply(quat.create(), quat.invert(quat.create(), [parentBody.quaternion.x, parentBody.quaternion.y, parentBody.quaternion.z, parentBody.quaternion.w]), q);
        const cq = toParent([childBody.quaternion.x, childBody.quaternion.y, childBody.quaternion.z, childBody.quaternion.w]);
        // Child segment direction now, in bind space: parentBind * (parent^-1 * child) * (0,1,0).
        const now = vec3.transformQuat(vec3.create(), vec3.transformQuat(vec3.create(), [0, 1, 0], cq), pp.rotation);
        const bind = lp.childAxis;
        const axis = lp.hingeAxis!;
        return Math.atan2(vec3.dot(vec3.cross(vec3.create(), bind, now), axis), vec3.dot(bind, now)) * 180 / Math.PI;
    }

    it('builds shaped segment bodies weighing a person, not 1 kg beads on the joints', () => {
        const { r } = setup();
        expect(r.bodies.size).toBe(16);
        let mass = 0;
        for (const b of r.bodies.values()) mass += b.mass;
        expect(mass).toBeCloseTo(70, 0);
    });

    it('falls, stays finite, keeps knees and elbows inside their hinge ranges, and ends up lying down', () => {
        const { p, layout, r, body } = setup();
        let lo = Infinity, hi = -Infinity, maxSpeed = 0;
        for (let i = 0; i < 240; i++) {
            p.update(1 / 60);
            for (const b of r.bodies.values()) {
                expect(Number.isFinite(b.position.x + b.position.y + b.position.z)).toBe(true);
                maxSpeed = Math.max(maxSpeed, b.velocity.length());
            }
            for (const c of ['Shin L', 'Shin R', 'Forearm L', 'Forearm R']) {
                const a = hingeAngle(layout, r, c);
                lo = Math.min(lo, a); hi = Math.max(hi, a);
            }
        }
        expect(lo).toBeGreaterThan(-12);   // never hyperextends (a little solver give)
        expect(hi).toBeLessThan(155);
        expect(maxSpeed).toBeLessThan(12);  // nothing launched
        const head = body('Head');
        expect(head.position.y).toBeLessThan(0.5);
        expect(head.position.y).toBeGreaterThan(-0.05);
    });

    it('keeps its joints together', () => {
        const { p, layout, r } = setup();
        for (let i = 0; i < 180; i++) p.update(1 / 60);
        const at = (b: Body, owner: RagdollLayoutPart, pivot: vec3) => {
            const off = vec3.transformQuat(vec3.create(), vec3.sub(vec3.create(), pivot, owner.center), quat.invert(quat.create(), owner.rotation));
            return b.pointToWorldFrame(new Vec3(off[0], off[1], off[2]));
        };
        for (const lp of layout.parts) {
            if (lp.parent < 0) continue;
            const pp = layout.parts[lp.parent];
            const gap = at(r.bodies.get(lp.node)!, lp, lp.pivot).distanceTo(at(r.bodies.get(pp.node)!, pp, lp.pivot));
            expect(gap, lp.part.name).toBeLessThan(0.03);
        }
    });

    it('raises the solver iterations while it moves and restores them once it rests', () => {
        const p = world();
        const before = p.solverIterations;
        const r = p.startRagdoll(mannequin());
        expect(p.solverIterations).toBe(20);
        for (let i = 0; i < 60 * 10 && !r.frozen; i++) p.update(1 / 60);
        expect(r.frozen).toBe(true);
        expect(p.solverIterations).toBe(before);
    });

    // A death clip ends lying on the floor, so limb capsules spawn partly inside it; the solver used to
    // push the buried body out at whatever speed cleared it -- the corpse leapt metres into the air.
    it('starts resting on the ground instead of being shot out of it', () => {
        const p = new PhysicsSystem({ gravity: [0, -9.82, 0] });
        p.initialize();
        (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
        p.addGroundPlane(0.5);                     // half a metre above the feet: the legs start buried
        p.update(1 / 60);                          // a live world: the ground's bounds are current
        const r = p.startRagdoll(mannequin());
        for (const b of r.bodies.values()) { b.updateAABB(); expect(b.aabb.lowerBound.y).toBeGreaterThan(0.49); }
        let fastestUp = 0;
        for (let i = 0; i < 60; i++) {
            p.update(1 / 60);
            for (const b of r.bodies.values()) fastestUp = Math.max(fastestUp, b.velocity.y);
        }
        expect(fastestUp).toBeLessThan(1.5);
    });

    it('still builds the generic ragdoll when asked to', () => {
        const p = world();
        const r = p.startRagdoll(mannequin(), { profile: null });
        expect(r.bodies.size).toBeGreaterThan(16);
    });
});
