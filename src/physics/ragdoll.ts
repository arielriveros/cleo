import {
    Body, Sphere, Box, Cylinder, Vec3, Quaternion, PointToPointConstraint, ConeTwistConstraint, HingeConstraint,
    LockConstraint, Constraint,
} from 'cannon-es';
import { mat4, vec3, quat } from 'gl-matrix';
import { AnimatedModel } from '../animation/animatedModel';
import type { Animator } from '../animation/animator';
import type { ModelNode } from '../core/scene/nodes/modelNode';
import type { PhysicsSystem } from './physicsSystem';
import { skeletonTopology } from '../animation/skeletonTopology';
import {
    autoHumanoidProfile, parseRagdollProfile, ragdollLayout, ragdollPartPose, rigidRotation,
    type RagdollProfile, type RagdollLayoutPart,
} from './ragdollProfile';

export interface RagdollOptions {
    /**
     * Joint type linking each bone to its parent:
     *  - 'coneTwist' (default): swing + twist limited around the bone's rest direction — natural, body-like.
     *  - 'ball': free ball joint (no angular limits) — floppy.
     */
    jointType?: 'ball' | 'coneTwist';
    /** Cone (swing) half-angle limit in degrees for cone-twist joints. */
    coneAngle?: number;
    /** Twist limit in degrees for cone-twist joints. */
    twistAngle?: number;
    /** Constraint strength (cannon-es maxForce) — higher = stiffer joints. */
    stiffness?: number;
    /** Per-bone angular damping — higher resists spinning (less floppy). */
    angularDamping?: number;
    /** Per-bone linear damping. */
    linearDamping?: number;
    /** Per-bone mass. */
    boneMass?: number;
    /** Multiplier applied to the auto-computed bone collider radius. */
    radiusScale?: number;
    /** Sphere collider radius clamp in world units. */
    minRadius?: number;
    maxRadius?: number;
    /** Let bones collide with each other (default false — avoids jitter). */
    selfCollision?: boolean;
    /** Extra impulse applied to the root bone body on creation (world space) for a dramatic collapse. */
    impulse?: number[];
    /** Initial linear velocity given to every bone body (world space), e.g. inherited from the character. */
    inheritVelocity?: number[];
    /**
     * The anatomical profile to build from. Omitted: the skin's own (authored on the rig), else the
     * automatic humanoid one. `null` forces the generic per-bone ragdoll (spheres on joints).
     */
    profile?: RagdollProfile | null;
    /** Multiplies the profile's total mass. */
    massScale?: number;
    /** A hit: this velocity change (m/s, world) goes to the part nearest `hitPoint` (half to its parent). */
    hitDirection?: number[];
    hitPoint?: number[];
}

/** Shared default ragdoll simulation parameters — single source of truth for the engine and editor UI. */
export const RAGDOLL_DEFAULTS: Required<Omit<RagdollOptions, 'inheritVelocity' | 'profile' | 'massScale' | 'hitDirection' | 'hitPoint'>> = {
    // Cone-twist by default. The twist limit must stay LOOSE: cannon-es's twist equation jitters badly
    // when tight and bones spin in place. Limit swing, leave twist relaxed.
    jointType: 'coneTwist',
    coneAngle: 45,
    twistAngle: 90,
    stiffness: 1e5,
    angularDamping: 0.5,
    linearDamping: 0.05,
    boneMass: 1,
    radiusScale: 1,
    minRadius: 0.05,
    maxRadius: 0.15,
    selfCollision: false,
    // For a profile ragdoll this is a velocity change (m/s) on the upper body in the CHARACTER's frame
    // [left, up, forward]: a slight push back. For the generic one, a world impulse on the root bone.
    impulse: [0, 0.3, -1.2],
};

const DEG2RAD = Math.PI / 180;
/** Ragdoll bodies' collision group (the static world is group 1). Matches `overlap.ts`. */
const RAGDOLL_GROUP = 2;
/** Fastest a part may start, so a teleport or a hitch in the last frame cannot launch a corpse. */
const MAX_HANDOFF_SPEED = 5;
/** Fastest a part may start moving UP (m/s). */
const MAX_HANDOFF_RISE = 0.5;

/**
 * Hands a skinned ModelNode's skeleton over to physics: every joint becomes a sphere-collider rigid
 * body at the bone's current animated world pose, linked to its parent's body by a cone-twist or ball
 * joint. Switches the owning Animator to ragdoll mode so it reads bone matrices back from the bodies.
 */
export class Ragdoll {
    private _physics: PhysicsSystem;
    private _animator: Animator | null = null;
    private _bodies: Map<number, Body> = new Map();   // GLTF nodeIndex -> body
    private _constraints: Constraint[] = [];
    /** Solver iterations this ragdoll wants while it is alive (0: no preference). */
    public solverIterations = 0;
    /** The dying character's capsule, and its collision mask before this ragdoll took it out of the way. */
    private _ownerBody: { collisionFilterMask: number } | null = null;
    private _ownerMask = 0;
    /** The model this ragdoll drives. Its removal from the scene is what ends the ragdoll. */
    public readonly node: ModelNode;
    /** Seconds every bone has stayed below the settle speed; see {@link updateSettle}. */
    private _stillFor = 0;
    private _frozen = false;
    private _destroyed = false;

    /** Bone speed (m/s, linear and angular) under which a ragdoll counts as at rest. */
    public static readonly SETTLE_SPEED = 0.15;
    /** Seconds at rest before a ragdoll is frozen. */
    public static readonly SETTLE_SECONDS = 1.5;

    constructor(modelNode: ModelNode, physics: PhysicsSystem, options: RagdollOptions = {}) {
        this._physics = physics;
        this.node = modelNode;

        const model = modelNode.model;
        const animator = modelNode.animator;
        if (!(model instanceof AnimatedModel) || !model.skin || !animator) {
            // Not a skinned model — nothing to ragdoll.
            return;
        }
        this._animator = animator;

        // Merge: shared defaults < node's persisted config (editor tuning) < explicit call options.
        const cfg = { ...RAGDOLL_DEFAULTS, ...(modelNode.ragdollConfig || {}), ...options };

        // The dying character's own capsule is invisible and frictionless: limbs that land on it drape
        // over thin air. It stops colliding with ragdolls (it keeps standing on the floor).
        for (let n = modelNode.parent; n; n = n.parent) {
            if ((n as { nodeType?: string }).nodeType !== 'character') continue;
            const body = (n as unknown as { body?: { collisionFilterMask: number } | null }).body;
            if (body) {
                this._ownerBody = body;
                this._ownerMask = body.collisionFilterMask;
                body.collisionFilterMask = body.collisionFilterMask & ~RAGDOLL_GROUP;
            }
            break;
        }

        const chosen = options.profile === null ? null
            : parseRagdollProfile(options.profile ?? model.skin.ragdollProfile ?? autoHumanoidProfile(model.skin));
        if (chosen && chosen.parts.length >= 2 && this._buildProfile(modelNode, animator, chosen, cfg)) return;

        const skin = model.skin;
        const joints = skin.joints;
        const boneMass = cfg.boneMass;
        const minRadius = cfg.minRadius;
        const maxRadius = cfg.maxRadius;
        const inheritVel = cfg.inheritVelocity;

        const finalBoneMatrices = animator.getFinalBoneMatrices();
        const modelWorld = modelNode.worldTransform;

        // 1) Current world position of each bone, derived from the live pose:
        //    globalModelSpace = finalBoneMatrix * inverse(inverseBindMatrix);  world = modelWorld * globalModelSpace
        const bonePos = new Map<number, vec3>();
        const invBind = mat4.create();
        const globalModel = mat4.create();
        const world = mat4.create();
        for (let j = 0; j < joints.length; j++) {
            const joint = joints[j];
            if (!mat4.invert(invBind, joint.inverseBindMatrix)) continue;
            mat4.multiply(globalModel, finalBoneMatrices[j], invBind);
            mat4.multiply(world, modelWorld, globalModel);
            const pos = vec3.create();
            mat4.getTranslation(pos, world);
            bonePos.set(joint.nodeIndex, pos);
        }

        // Children lists + parent lookup, in NODE space but resolved through the shared topology.
        // `joint.parentIndex` is the immediate parent NODE, which on many rigs is a pivot rather than a
        // joint (assimp's FBX importer preserves them), so it must not be used directly.
        const topo = skeletonTopology(skin);
        const childrenOf = new Map<number, number[]>();
        const parentIndexOf = new Map<number, number | undefined>();
        for (let j = 0; j < joints.length; j++) {
            const parentJoint = topo.parentJoint[j];
            const parentNode = parentJoint >= 0 ? joints[parentJoint].nodeIndex : undefined;
            parentIndexOf.set(joints[j].nodeIndex, parentNode);
            if (parentNode !== undefined) {
                const arr = childrenOf.get(parentNode) || [];
                arr.push(joints[j].nodeIndex);
                childrenOf.set(parentNode, arr);
            }
        }
        /** The parent NODE of a joint, skipping any non-joint nodes between them. */
        const parentNodeOf = (nodeIndex: number): number | undefined => parentIndexOf.get(nodeIndex);

        // Prune tiny bones (fingers/toes/twist helpers): a body on a 3cm sphere has near-zero rotational
        // inertia and cone-twist torques blow the ragdoll up. Pruned bones ride rigidly on the nearest
        // kept ancestor (see Animator.enableRagdoll). Keep roots, branch points and long segments.
        let maxSeg = 0;
        const segLen = new Map<number, number>();
        for (const joint of joints) {
            const parentNode = parentNodeOf(joint.nodeIndex);
            if (parentNode === undefined) continue;
            const p = bonePos.get(joint.nodeIndex), pp = bonePos.get(parentNode);
            if (!p || !pp) continue;
            const d = vec3.distance(p, pp);
            segLen.set(joint.nodeIndex, d);
            if (d > maxSeg) maxSeg = d;
        }
        const minSeg = maxSeg * 0.18;
        const kept = new Set<number>();
        for (const joint of joints) {
            const isRoot = parentNodeOf(joint.nodeIndex) === undefined;
            const isBranch = (childrenOf.get(joint.nodeIndex)?.length ?? 0) >= 2;
            const longEnough = (segLen.get(joint.nodeIndex) ?? Infinity) >= minSeg;
            if (isRoot || isBranch || longEnough) kept.add(joint.nodeIndex);
        }
        if (kept.size < 3) for (const joint of joints) kept.add(joint.nodeIndex); // odd rig: keep all

        // Nearest ancestor (exclusive) that is kept — the body a kept bone constrains to.
        const nearestKeptAncestor = (nodeIndex: number): number | undefined => {
            let n = parentIndexOf.get(nodeIndex);
            while (n !== undefined && !kept.has(n)) n = parentIndexOf.get(n);
            return n;
        };

        // Bone direction per joint (toward its child(ren); leaf/branch fall back to the incoming
        // segment). Used to orient bodies cleanly and to derive cone-twist axes.
        const up: vec3 = [0, 1, 0];
        const boneDir = new Map<number, vec3>();
        const dirOf = (nodeIndex: number, parentIndex?: number): vec3 => {
            const pos = bonePos.get(nodeIndex)!;
            const out = vec3.create();
            const kids = childrenOf.get(nodeIndex);
            if (kids) for (const k of kids) {
                const kp = bonePos.get(k);
                if (kp) vec3.add(out, out, [kp[0] - pos[0], kp[1] - pos[1], kp[2] - pos[2]]);
            }
            if (vec3.length(out) < 1e-6 && parentIndex !== undefined) {
                const pp = bonePos.get(parentIndex);
                if (pp) vec3.set(out, pos[0] - pp[0], pos[1] - pp[1], pos[2] - pp[2]);
            }
            if (vec3.length(out) < 1e-6) vec3.set(out, 0, 1, 0);
            return vec3.normalize(out, out);
        };

        // 2) A sphere body per joint. Orientation must come from the bone DIRECTION (shortest-arc
        //    rotation of local +Y onto it), not the bone matrix, which can be sheared or non-uniformly
        //    scaled on skinned rigs and yield quaternions that explode the cone-twist joints.
        for (const joint of joints) {
            const nodeIndex = joint.nodeIndex;
            if (!kept.has(nodeIndex)) continue; // pruned bone: no body (rides on nearest kept ancestor)
            const pos = bonePos.get(nodeIndex);
            if (!pos) continue;

            // Radius from the distance to the nearest child bone (fallback: parent distance, then min).
            let dist = Number.POSITIVE_INFINITY;
            const kids = childrenOf.get(nodeIndex);
            if (kids) {
                for (const kid of kids) {
                    const kp = bonePos.get(kid);
                    if (kp) dist = Math.min(dist, vec3.distance(pos, kp));
                }
            }
            const parentNode = parentNodeOf(nodeIndex);
            if (!isFinite(dist) && parentNode !== undefined) {
                const pp = bonePos.get(parentNode);
                if (pp) dist = vec3.distance(pos, pp);
            }
            if (!isFinite(dist)) dist = minRadius * 2;
            const radius = Math.min(maxRadius, Math.max(minRadius, dist * 0.5 * cfg.radiusScale));

            const dir = dirOf(nodeIndex, parentNode);
            boneDir.set(nodeIndex, dir);
            const q = quat.rotationTo(quat.create(), up, dir);

            const body = new Body({
                mass: boneMass,
                position: new Vec3(pos[0], pos[1], pos[2]),
                quaternion: new Quaternion(q[0], q[1], q[2], q[3]),
                linearDamping: cfg.linearDamping,
                angularDamping: cfg.angularDamping,
            });
            body.addShape(new Sphere(radius));
            body.updateMassProperties();
            // Bones live in group 2. The mask includes the static world (group 1); adding group 2
            // enables bone-vs-bone collision.
            body.collisionFilterGroup = RAGDOLL_GROUP;
            body.collisionFilterMask = cfg.selfCollision ? (1 | RAGDOLL_GROUP) : 1;
            if (inheritVel) body.velocity.set(inheritVel[0], inheritVel[1], inheritVel[2]);

            this._bodies.set(nodeIndex, body);
            physics.addBody(body);
        }

        // 3) Link each bone body to its parent, pivoted at the child's (joint) origin.
        const rel = vec3.create();
        const pq = quat.create();
        const worldAxis = vec3.create();
        const axisChild = vec3.create();
        const axisParent = vec3.create();
        const coneRad = cfg.coneAngle * DEG2RAD;
        const twistRad = cfg.twistAngle * DEG2RAD;
        for (const joint of joints) {
            const childBody = this._bodies.get(joint.nodeIndex);
            if (!childBody) continue;                          // only kept bones have bodies
            const ancestorIndex = nearestKeptAncestor(joint.nodeIndex);
            if (ancestorIndex === undefined) continue;         // root bone: nothing above it
            const parentBody = this._bodies.get(ancestorIndex);
            if (!parentBody) continue;

            const childPos = bonePos.get(joint.nodeIndex)!;
            const parentPos = bonePos.get(ancestorIndex)!;

            // Child body sits AT the joint origin -> pivot in child = origin.
            const pivotChild = new Vec3(0, 0, 0);
            // Pivot in parent local = parentQuat^-1 * (childPos - parentPos).
            vec3.set(rel, childPos[0] - parentPos[0], childPos[1] - parentPos[1], childPos[2] - parentPos[2]);
            quat.set(pq, parentBody.quaternion.x, parentBody.quaternion.y, parentBody.quaternion.z, parentBody.quaternion.w);
            quat.invert(pq, pq);
            vec3.transformQuat(rel, rel, pq);
            const pivotParent = new Vec3(rel[0], rel[1], rel[2]);

            let constraint: PointToPointConstraint;
            if (cfg.jointType === 'coneTwist') {
                // Cone rest axis = this bone's (child's) world direction, already computed cleanly.
                vec3.copy(worldAxis, boneDir.get(joint.nodeIndex) || up);

                // World rest axis expressed in each body's local frame (bodyQuat^-1 * worldAxis).
                quat.set(pq, childBody.quaternion.x, childBody.quaternion.y, childBody.quaternion.z, childBody.quaternion.w);
                quat.invert(pq, pq);
                vec3.transformQuat(axisChild, worldAxis, pq);
                quat.set(pq, parentBody.quaternion.x, parentBody.quaternion.y, parentBody.quaternion.z, parentBody.quaternion.w);
                quat.invert(pq, pq);
                vec3.transformQuat(axisParent, worldAxis, pq);

                constraint = new ConeTwistConstraint(childBody, parentBody, {
                    pivotA: pivotChild,
                    pivotB: pivotParent,
                    axisA: new Vec3(axisChild[0], axisChild[1], axisChild[2]),
                    axisB: new Vec3(axisParent[0], axisParent[1], axisParent[2]),
                    angle: coneRad,
                    twistAngle: twistRad,
                    maxForce: cfg.stiffness,
                    collideConnected: false, // connected bones overlap at the joint — never collide them
                });
            } else {
                constraint = new PointToPointConstraint(childBody, pivotChild, parentBody, pivotParent);
                constraint.collideConnected = false;
            }
            this._constraints.push(constraint);
            physics.addConstraint(constraint);
        }

        // 4) Optional knockback on the root bone(s) (kept bones with no kept ancestor).
        if (cfg.impulse) {
            const imp = new Vec3(cfg.impulse[0], cfg.impulse[1], cfg.impulse[2]);
            for (const joint of joints) {
                const body = this._bodies.get(joint.nodeIndex);
                if (!body) continue;
                if (nearestKeptAncestor(joint.nodeIndex) === undefined) body.applyImpulse(imp, new Vec3(0, 0, 0));
            }
        }

        // 5) Hand the skeleton to the animator.
        this._animator.enableRagdoll(this._bodies);
    }

    /**
     * Build from an anatomical profile: one shaped body per segment, masses from the profile, joints
     * framed in the BIND pose so every limit is centred on an anatomical neutral. False when the profile
     * names too few bones on this skin, so the caller falls back to the generic ragdoll.
     */
    private _buildProfile(
        modelNode: ModelNode, animator: Animator, profile: RagdollProfile,
        cfg: RagdollOptions & typeof RAGDOLL_DEFAULTS,
    ): boolean {
        const skin = (modelNode.model as AnimatedModel).skin!;
        const layout = ragdollLayout(skin, profile);
        if (layout.parts.length < 2) return false;

        const fbm = animator.getFinalBoneMatrices();
        const modelWorld = modelNode.worldTransform;
        const prev = animator.previousPose();
        const totalMass = Math.max(1, profile.totalMass * (cfg.massScale ?? 1));
        const maxForce = (modelNode.ragdollConfig as RagdollOptions | undefined)?.stiffness ?? 1e6;

        const placeOf = (lp: RagdollLayoutPart, nodeWorld: mat4, bone: mat4) => ragdollPartPose(skin, lp, nodeWorld, bone);

        // Upper body = parts whose bind centre is above the root's: what a push topples.
        const rootY = layout.parts.find(p => p.parent < 0)?.center[1] ?? 0;
        const modelRot = rigidRotation(quat.create(), modelWorld);
        // Scenes saved before profiles carry the OLD default impulse, [0, 1.5, -2], meant as a world
        // impulse on a 1 kg root sphere. As a velocity on a 70 kg body's upper half it would launch it,
        // so that exact value reads as "the default".
        const legacy = cfg.impulse && cfg.impulse.length === 3 && cfg.impulse[0] === 0 && cfg.impulse[1] === 1.5 && cfg.impulse[2] === -2;
        if (legacy) cfg = { ...cfg, impulse: RAGDOLL_DEFAULTS.impulse };
        const push = cfg.impulse && cfg.impulse.length === 3 ? (() => {
            // [left, up, forward] in the character's frame -> world.
            const local = vec3.create();
            vec3.scaleAndAdd(local, local, layout.left, cfg.impulse![0]);
            vec3.scaleAndAdd(local, local, layout.up, cfg.impulse![1]);
            vec3.scaleAndAdd(local, local, layout.forward, cfg.impulse![2]);
            return vec3.transformQuat(local, local, modelRot);
        })() : null;

        const bodies: Body[] = [];
        const scales: number[] = [];
        for (const lp of layout.parts) {
            const { center, rotation, scale } = placeOf(lp, modelWorld, fbm[lp.joint]);
            scales.push(scale);
            const body = new Body({
                mass: Math.max(0.05, lp.mass * totalMass),
                position: new Vec3(center[0], center[1], center[2]),
                quaternion: new Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]),
                linearDamping: profile.linearDamping,
                // Hands and feet are light, short and round: on the ground they rock on their caps for
                // seconds after everything else is still. Damping their spin costs nothing visible.
                angularDamping: lp.mass < 0.02 ? Math.max(profile.angularDamping, 0.6) : profile.angularDamping,
            });
            const r = lp.radius * scale, len = lp.length * scale, depth = lp.depth * scale;
            switch (lp.part.shape) {
                case 'box':
                    body.addShape(new Box(new Vec3(r, len / 2, depth / 2)));
                    break;
                case 'sphere':
                    body.addShape(new Sphere(r));
                    break;
                default: {
                    // Capsule: a cylinder between two caps (cannon has no capsule). Y along the segment.
                    const cyl = Math.max(1e-3, len - 2 * r);
                    body.addShape(new Cylinder(r, r, cyl, 10));
                    body.addShape(new Sphere(r), new Vec3(0, cyl / 2, 0));
                    body.addShape(new Sphere(r), new Vec3(0, -cyl / 2, 0));
                }
            }
            body.updateMassProperties();
            body.collisionFilterGroup = RAGDOLL_GROUP;
            body.collisionFilterMask = profile.selfCollision ? (1 | RAGDOLL_GROUP) : 1;

            // Hand-off: keep moving the way the animation was moving this part.
            if (prev && prev.dt > 1e-4) {
                const before = placeOf(lp, prev.nodeWorld, prev.bones[lp.joint]);
                const v = vec3.scale(vec3.create(), vec3.sub(vec3.create(), center, before.center), 1 / prev.dt);
                const speed = vec3.length(v);
                if (speed > MAX_HANDOFF_SPEED) vec3.scale(v, v, MAX_HANDOFF_SPEED / speed);
                // Never upward faster than a stumble: a death clip settling onto the floor reads as
                // the hips springing up for a frame, and that was enough to throw the body in the air.
                v[1] = Math.min(v[1], MAX_HANDOFF_RISE);
                if (Number.isFinite(speed)) body.velocity.set(v[0], v[1], v[2]);
            }
            if (cfg.inheritVelocity) body.velocity.vadd(new Vec3(cfg.inheritVelocity[0], cfg.inheritVelocity[1], cfg.inheritVelocity[2]), body.velocity);
            if (push && lp.parent >= 0 && lp.center[1] > rootY) body.velocity.vadd(new Vec3(push[0], push[1], push[2]), body.velocity);

            bodies.push(body);
            this._bodies.set(lp.node, body);
            this._physics.addBody(body);
        }

        // A hit lands on the part nearest it, and half of it on that part's parent.
        if (cfg.hitDirection && cfg.hitPoint) {
            const [hx, hy, hz] = cfg.hitPoint;
            let best = -1, bestD = Infinity;
            bodies.forEach((b, i) => {
                const d = (b.position.x - hx) ** 2 + (b.position.y - hy) ** 2 + (b.position.z - hz) ** 2;
                if (d < bestD) { bestD = d; best = i; }
            });
            if (best >= 0) {
                const kick = new Vec3(cfg.hitDirection[0], cfg.hitDirection[1], cfg.hitDirection[2]);
                bodies[best].velocity.vadd(kick, bodies[best].velocity);
                const parent = layout.parts[best].parent;
                if (parent >= 0) bodies[parent].velocity.vadd(kick.scale(0.5), bodies[parent].velocity);
            }
        }

        // Joints, in each body's own frame. A body's live orientation is (bone's bind->live turn) * its
        // bind frame, so a bind-space vector's local form is just inverse(bind frame) * vector.
        const local = (q: quat, v: vec3, origin: vec3 | null, scale: number) => {
            const out = origin ? vec3.sub(vec3.create(), v, origin) : vec3.clone(v);
            if (origin) vec3.scale(out, out, scale);
            vec3.transformQuat(out, out, quat.invert(quat.create(), q));
            return new Vec3(out[0], out[1], out[2]);
        };
        for (const lp of layout.parts) {
            if (lp.parent < 0) continue;
            const pp = layout.parts[lp.parent];
            const a = bodies[lp.index], b = bodies[lp.parent];
            const sA = scales[lp.index], sB = scales[lp.parent];
            const pivotA = local(lp.rotation, lp.pivot, lp.center, sA);
            const pivotB = local(pp.rotation, lp.pivot, pp.center, sB);
            const type = lp.part.joint?.type ?? 'cone';
            if (type === 'fixed') {
                const lock = new LockConstraint(a, b, { maxForce });
                lock.collideConnected = false;
                this._add(lock);
                continue;
            }
            if (type === 'hinge' && lp.hingeAxis) {
                const hinge = new HingeConstraint(a, b, {
                    pivotA, pivotB,
                    axisA: local(lp.rotation, lp.hingeAxis, null, 1),
                    axisB: local(pp.rotation, lp.hingeAxis, null, 1),
                    maxForce, collideConnected: false,
                });
                this._add(hinge);
            }
            // The limit: a cone around the neutral direction (for a hinge, around mid-bend, half the range
            // wide). The twist stays loose for hinges -- the hinge already holds it.
            const cone = new ConeTwistConstraint(a, b, {
                pivotA, pivotB,
                axisA: local(lp.rotation, lp.childAxis, null, 1),
                axisB: local(pp.rotation, lp.parentAxis, null, 1),
                angle: lp.coneAngle,
                twistAngle: type === 'hinge' ? Math.PI : Math.max(lp.twistAngle, 5 * DEG2RAD),
                maxForce, collideConnected: false,
            });
            this._add(cone);
        }

        this.solverIterations = Math.max(0, Math.round(profile.solverIterations));
        animator.enableRagdoll(this._bodies);
        // AFTER the skin is bound to the bodies, so the mesh rises with them rather than staying buried.
        this._liftOutOfGround(bodies);
        return true;
    }

    /**
     * Lift the whole ragdoll so no part starts inside the ground. A death clip ends lying ON the floor, so
     * capsules sized to the limbs spawn partly beneath it -- and the solver pushes a buried body out at
     * whatever speed clears it, which threw the corpse metres into the air. One rigid lift for every part,
     * by the deepest penetration found straight under each one, keeps the pose and starts it resting.
     */
    private _liftOutOfGround(bodies: Body[]): void {
        let lift = 0;
        for (const body of bodies) {
            body.updateAABB();
            const lo = body.aabb.lowerBound, hi = body.aabb.upperBound;
            const x = body.position.x, z = body.position.z;
            let hit = null;
            try {
                hit = this._physics.raycast([x, hi.y + 1, z], [x, lo.y - 1, z], { groundOnly: true });
            } catch { hit = null; }
            if (hit) lift = Math.max(lift, hit.point[1] - lo.y);
        }
        if (lift <= 0) return;
        lift += 0.01;
        for (const body of bodies) {
            body.position.y += lift;
            body.previousPosition.y += lift;
            body.interpolatedPosition.y += lift;
            body.updateAABB();
        }
    }

    private _add(constraint: Constraint): void {
        this._constraints.push(constraint);
        this._physics.addConstraint(constraint);
    }

    /** Underlying bone bodies keyed by GLTF node index. */
    public get bodies(): Map<number, Body> { return this._bodies; }

    /** Frozen: at rest, its bodies out of the world (see {@link updateSettle}). */
    public get frozen(): boolean { return this._frozen; }
    public get destroyed(): boolean { return this._destroyed; }

    /**
     * Freeze the ragdoll once it has come to rest. A corpse lying still costs the solver nothing to
     * look at, but a live ragdoll is ~20 bodies and joints stepped every substep and tested by every
     * raycast, and a game that kills things keeps adding them. Frozen, the bodies and joints leave the
     * world while the Body objects stay — the animator keeps reading their last transforms, so the
     * pose holds exactly where it fell.
     *
     * Returns true when this call froze it.
     */
    public updateSettle(dt: number): boolean {
        if (this._frozen || this._destroyed || this._bodies.size === 0) return false;
        // Mass-weighted: a 0.4 kg hand rocking on its knuckles must not keep a 70 kg body awake. Light,
        // round extremities on the ground twitch at a few tenths of a rad/s for many seconds after the
        // body is still, and freezing them where they lie is invisible.
        const limit = Ragdoll.SETTLE_SPEED;
        let mass = 0, lin = 0, ang = 0, worst = 0;
        for (const body of this._bodies.values()) {
            const m = body.mass || 1;
            const v = body.velocity.length(), w = body.angularVelocity.length();
            mass += m; lin += m * v * v; ang += m * w * w;
            worst = Math.max(worst, v);
        }
        const rmsLin = Math.sqrt(lin / (mass || 1)), rmsAng = Math.sqrt(ang / (mass || 1));
        if (rmsLin > limit || rmsAng > limit * 4 || worst > limit * 4) {
            this._stillFor = 0;
            return false;
        }
        this._stillFor += dt;
        if (this._stillFor < Ragdoll.SETTLE_SECONDS) return false;
        this.freeze();
        return true;
    }

    /** Take the bodies and joints out of the world, keeping the pose. */
    public freeze(): void {
        if (this._frozen || this._destroyed) return;
        this._frozen = true;
        for (const constraint of this._constraints) this._physics.removeConstraint(constraint);
        for (const body of this._bodies.values()) {
            body.velocity.set(0, 0, 0);
            body.angularVelocity.set(0, 0, 0);
            this._physics.removeBody(body);
        }
    }

    /** Remove all bodies + constraints from physics and return the skeleton to animation. */
    public destroy(): void {
        if (this._destroyed) return;
        this._destroyed = true;
        for (const constraint of this._constraints) this._physics.removeConstraint(constraint);
        this._constraints = [];
        for (const body of this._bodies.values()) this._physics.removeBody(body);
        this._bodies.clear();
        if (this._ownerBody) { this._ownerBody.collisionFilterMask = this._ownerMask; this._ownerBody = null; }
        if (this._animator) this._animator.disableRagdoll();
    }
}
