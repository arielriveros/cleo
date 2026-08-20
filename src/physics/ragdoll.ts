import { Body, Sphere, Vec3, Quaternion, PointToPointConstraint, ConeTwistConstraint } from 'cannon-es';
import { mat4, vec3, quat } from 'gl-matrix';
import { AnimatedModel } from '../graphics/animatedModel';
import type { Animator } from '../graphics/animator';
import type { ModelNode } from '../core/scene/nodes/modelNode';
import type { PhysicsSystem } from './physicsSystem';
import { skeletonTopology } from '../graphics/skeletonTopology';

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
}

/** Shared default ragdoll simulation parameters — single source of truth for the engine and editor UI. */
export const RAGDOLL_DEFAULTS: Required<Omit<RagdollOptions, 'inheritVelocity'>> = {
    // Cone-twist by default: the cone (swing) limit keeps limbs from bending the wrong way, while the
    // twist limit is kept LOOSE — cannon-es's twist equation jitters badly when tight (bones spin in
    // place), whereas free twist settles cleanly. So limit swing, leave twist relaxed.
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
    impulse: [0, 1.5, -2],
};

const DEG2RAD = Math.PI / 180;

/**
 * Ragdoll: hands a skinned ModelNode's skeleton over to physics.
 *
 * Every skeleton joint becomes a sphere-collider rigid body spawned at the bone's current
 * animated world pose; each body is linked to its parent bone's body by a swing/twist-limited
 * cone-twist joint (or a free ball joint), configurable via RagdollOptions / the node's ragdollConfig.
 * The owning Animator is switched to ragdoll mode so it reads bone matrices back from these bodies
 * each frame instead of from animation.
 *
 * Fully generic — works on any skinned GLTF, no per-model tuning.
 */
export class Ragdoll {
    private _physics: PhysicsSystem;
    private _animator: Animator | null = null;
    private _bodies: Map<number, Body> = new Map();   // GLTF nodeIndex -> body
    private _constraints: PointToPointConstraint[] = [];

    constructor(modelNode: ModelNode, physics: PhysicsSystem, options: RagdollOptions = {}) {
        this._physics = physics;

        const model = modelNode.model;
        const animator = modelNode.animator;
        if (!(model instanceof AnimatedModel) || !model.skin || !animator) {
            // Not a skinned model — nothing to ragdoll.
            return;
        }
        this._animator = animator;

        // Merge: shared defaults < node's persisted config (editor tuning) < explicit call options.
        const cfg = { ...RAGDOLL_DEFAULTS, ...(modelNode.ragdollConfig || {}), ...options };

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
        //
        // `joint.parentIndex` is the immediate parent NODE, which on many rigs is not a joint at all —
        // assimp's FBX importer preserves pivots, so `Bone_$AssimpFbx$_Rotation` sits between every pair
        // of bones. Keying off it directly made `childrenOf` keyed by pivots, so every joint looked
        // childless (no branch detection, fallback radii everywhere) and `nearestKeptAncestor` terminated
        // on the first pivot — meaning no cone-twist constraints at all, and a ragdoll of loose spheres.
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

        // Prune tiny bones (fingers/toes/twist helpers): only substantial segments get a physics body.
        // A 1kg body on a 3cm sphere has near-zero rotational inertia, so cone-twist torques spin it
        // violently and the whole ragdoll blows up. Pruned bones ride rigidly on the nearest kept
        // ancestor (handled in Animator.enableRagdoll). Keep roots, branch points, and long segments.
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

        // 2) A sphere body per joint. Orientation is built cleanly from the bone direction (a
        //    shortest-arc rotation of local +Y onto it) rather than extracted from the bone matrix,
        //    which can be sheared/non-uniformly-scaled on skinned rigs and yield garbage quaternions
        //    that make cone-twist joints explode. The Animator's relative-delta hand-off is invariant
        //    to the body frame, so any consistent rigid orientation renders correctly.
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
            // Bones live in group 2. Mask includes the static world (group 1); add group 2 to enable
            // bone-vs-bone collision when requested (off by default — avoids jitter).
            body.collisionFilterGroup = 2;
            body.collisionFilterMask = cfg.selfCollision ? (1 | 2) : 1;
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

    /** Underlying bone bodies keyed by GLTF node index. */
    public get bodies(): Map<number, Body> { return this._bodies; }

    /** Remove all bodies + constraints from physics and return the skeleton to animation. */
    public destroy(): void {
        for (const constraint of this._constraints) this._physics.removeConstraint(constraint);
        this._constraints = [];
        for (const body of this._bodies.values()) this._physics.removeBody(body);
        this._bodies.clear();
        if (this._animator) this._animator.disableRagdoll();
    }
}
