import { mat4, vec3, quat } from 'gl-matrix';
import { PhysicsBody } from './physicsBody';
import { ALL_LAYERS, LAYER } from './collisionLayers';
import type { BodyPin, JointDrive, JointHandle } from './pal/types';
import type { JointSpec } from './physicsSystem';
import { AnimatedModel, type Skin } from '../animation/animatedModel';
import type { Animator, PhysicsMappingSource } from '../animation/animator';
import type { ModelNode } from '../core/scene/nodes/modelNode';
import type { PhysicsSystem } from './physicsSystem';
import { skeletonTopology } from '../animation/skeletonTopology';
import { humanoidRigOf } from '../animation/animationRetarget';
import {
    autoHumanoidProfile, parseRagdollProfile, ragdollLayout, ragdollPartPose, ragdollPartPoseInto, rigidRotation,
    type RagdollProfile, type RagdollLayoutPart,
} from './ragdollProfile';
import { DEG2RAD } from '../core/math';

/** What a ragdoll part is, for the muscles and reflexes that move it. */
export type RagdollRegion = 'pelvis' | 'spine' | 'neck' | 'arms' | 'hands' | 'legs' | 'feet';

/** One body of a profile ragdoll, with what a powered ragdoll's controller needs to know of it. */
export interface RagdollPartInfo {
    readonly index: number;
    readonly name: string;
    /** The humanoid slot of its bone ('upperArm.L', 'head', 'hips'...), or null for a bone that has none. */
    readonly role: string | null;
    readonly region: RagdollRegion;
    readonly side: 'L' | 'R' | null;
    readonly body: PhysicsBody;
    /** Its parent part's index, -1 for the root (the pelvis). */
    readonly parent: number;
    readonly children: number[];
    /** The joint its muscle drives (a knee's or an elbow's hinge, else its cone), null for the root or a fixed one. */
    joint: JointHandle | null;
    readonly hinge: boolean;
    /** This part and every part below it: what its joint holds up. */
    readonly subtree: PhysicsBody[];
    /** The joint's pivot in this part's frame and in its parent's (from each body's centre). */
    readonly pivotSelf: [number, number, number];
    readonly pivotParent: [number, number, number];
    /** World units: half the segment's length along its Y, and its radius. */
    readonly halfLength: number;
    readonly radius: number;
    readonly mass: number;
    readonly layout: RagdollLayoutPart;
}

/** Where a hit landed on a ragdoll: the part and how far from its surface. */
export interface RagdollPartHit { part: number; distance: number }

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
    /** Joint strength (the most force a joint may apply) — higher = stiffer joints. */
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
    /**
     * 'passive' (default): a body with no will of its own, the skeleton drawn from it. 'powered': joints carry
     * muscles (setMuscle) and the animation keeps running underneath as their target, the skeleton drawn by
     * how much of each part the simulation owns (setMapping). A powered ragdoll spawns with no push of its own
     * unless `impulse` is given. Profile ragdolls only; a generic one is always passive.
     */
    mode?: 'passive' | 'powered';
    /** The model's reactions (physics/reactive/): which set, its strength, its health. Kept with the rest of the node's ragdoll config. */
    reactions?: import('./reactive/reactionController').ModelReactionConfig;
}

/** Shared default ragdoll simulation parameters — single source of truth for the engine and editor UI. */
export const RAGDOLL_DEFAULTS: Required<Omit<RagdollOptions, 'inheritVelocity' | 'profile' | 'massScale' | 'hitDirection' | 'hitPoint' | 'mode' | 'reactions'>> = {
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

/** Ragdoll bodies' collision layer (collisionLayers.ts): layer 2, Ragdoll. */
const RAGDOLL_GROUP = LAYER.RAGDOLL;
/**
 * What a ragdoll bone collides with: every layer but the other bones' own, unless the ragdoll collides with
 * itself. Every layer, not just Default: a corpse must land on stairs, pillars and props whatever layer the
 * level put them on.
 */
const boneMask = (selfCollision: boolean | undefined): number => selfCollision ? ALL_LAYERS : ALL_LAYERS & ~RAGDOLL_GROUP;
/** Fastest a part may start, so a teleport or a hitch in the last frame cannot launch a corpse. */
const MAX_HANDOFF_SPEED = 5;
/** Fastest a part may start moving UP (m/s). */
const MAX_HANDOFF_RISE = 0.5;

/**
 * Hands a skinned ModelNode's skeleton over to physics: every joint becomes a sphere-collider rigid
 * body at the bone's current animated world pose, linked to its parent's body by a cone-twist or ball
 * joint. Switches the owning Animator to ragdoll mode so it reads bone matrices back from the bodies.
 */
export class Ragdoll implements PhysicsMappingSource {
    private _physics: PhysicsSystem;
    private _animator: Animator | null = null;
    private _bodies: Map<number, PhysicsBody> = new Map();   // GLTF nodeIndex -> body
    private _joints: JointHandle[] = [];
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
    /** Muscles and a running animation underneath (RagdollOptions.mode). */
    public readonly powered: boolean;
    /** Freeze once at rest (updateSettle). A reaction controller keeps a living body awake to get up. */
    public autoFreeze = true;
    private _skin: Skin | null = null;
    private _parts: RagdollPartInfo[] = [];
    private _mapping = new Float32Array(0);
    private _bindOf: mat4[] = [];
    /** The joints as made: kept so a frozen ragdoll can be put back (unfreeze). */
    private _jointSpecs: { a: PhysicsBody; b: PhysicsBody; spec: JointSpec; drivePart: number }[] = [];
    public partOfJoint = new Int32Array(0);

    /** Bone speed (m/s, linear and angular) under which a ragdoll counts as at rest. */
    public static readonly SETTLE_SPEED = 0.15;
    /** Seconds at rest before a ragdoll is frozen. */
    public static readonly SETTLE_SECONDS = 1.5;

    constructor(modelNode: ModelNode, physics: PhysicsSystem, options: RagdollOptions = {}) {
        this._physics = physics;
        this.node = modelNode;
        this.powered = options.mode === 'powered';

        const model = modelNode.model;
        const animator = modelNode.animator;
        if (!(model instanceof AnimatedModel) || !model.skin || !animator) {
            // Not a skinned model — nothing to ragdoll.
            return;
        }
        this._animator = animator;

        // Merge: shared defaults < node's persisted config (editor tuning) < explicit call options. A powered
        // ragdoll is pushed only by what its caller says (a reaction's own hit), never by the death push.
        const cfg = { ...RAGDOLL_DEFAULTS, ...(modelNode.ragdollConfig || {}), ...options };
        if (this.powered) cfg.impulse = options.impulse ?? [0, 0, 0];

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
        // A powered ragdoll needs a profile's segments: the generic one is passive.
        (this as { powered: boolean }).powered = false;

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

            const body = new PhysicsBody({
                name: 'ragdoll',
                mass: boneMass,
                position: pos,
                quaternion: q,
                linearDamping: cfg.linearDamping,
                angularDamping: cfg.angularDamping,
                // Bones live on the Ragdoll layer and collide with every other; the Ragdoll layer too
                // enables bone-vs-bone collision.
                group: RAGDOLL_GROUP,
                mask: boneMask(cfg.selfCollision),
            });
            body.addCollider({ shape: { kind: 'sphere', radius } });
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
            const pivotChild: [number, number, number] = [0, 0, 0];
            // Pivot in parent local = parentQuat^-1 * (childPos - parentPos).
            vec3.set(rel, childPos[0] - parentPos[0], childPos[1] - parentPos[1], childPos[2] - parentPos[2]);
            quat.set(pq, parentBody.quaternion.x, parentBody.quaternion.y, parentBody.quaternion.z, parentBody.quaternion.w);
            quat.invert(pq, pq);
            vec3.transformQuat(rel, rel, pq);
            const pivotParent: [number, number, number] = [rel[0], rel[1], rel[2]];

            let link: JointSpec;
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

                link = {
                    kind: 'coneTwist',
                    anchorA: pivotChild,
                    anchorB: pivotParent,
                    axisA: [axisChild[0], axisChild[1], axisChild[2]],
                    axisB: [axisParent[0], axisParent[1], axisParent[2]],
                    coneAngle: coneRad,
                    twistAngle: twistRad,
                    maxForce: cfg.stiffness,
                    collideConnected: false, // connected bones overlap at the joint — never collide them
                };
            } else {
                link = { kind: 'ball', anchorA: pivotChild, anchorB: pivotParent, collideConnected: false };
            }
            this._add(childBody, parentBody, link);
        }

        // 4) Optional knockback on the root bone(s) (kept bones with no kept ancestor).
        if (cfg.impulse) {
            const imp = [cfg.impulse[0], cfg.impulse[1], cfg.impulse[2]];
            for (const joint of joints) {
                const body = this._bodies.get(joint.nodeIndex);
                if (!body) continue;
                if (nearestKeptAncestor(joint.nodeIndex) === undefined) body.applyImpulse(imp, [0, 0, 0]);
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

        const bodies: PhysicsBody[] = [];
        const scales: number[] = [];
        for (const lp of layout.parts) {
            const { center, rotation, scale } = placeOf(lp, modelWorld, fbm[lp.joint]);
            scales.push(scale);
            const body = new PhysicsBody({
                name: 'ragdoll',
                mass: Math.max(0.05, lp.mass * totalMass),
                position: center,
                quaternion: rotation,
                linearDamping: profile.linearDamping,
                // Hands and feet are light, short and round: on the ground they rock on their caps for
                // seconds after everything else is still. Damping their spin costs nothing visible.
                angularDamping: lp.mass < 0.02 ? Math.max(profile.angularDamping, 0.6) : profile.angularDamping,
                friction: profile.friction ?? 0.8,
                restitution: profile.restitution ?? 0.05,
                group: RAGDOLL_GROUP,
                mask: boneMask(profile.selfCollision),
            });
            const r = lp.radius * scale, len = lp.length * scale, depth = lp.depth * scale;
            switch (lp.part.shape) {
                case 'box':
                    body.addCollider({ shape: { kind: 'box', halfExtents: [r, len / 2, depth / 2] } });
                    break;
                case 'sphere':
                    body.addCollider({ shape: { kind: 'sphere', radius: r } });
                    break;
                default:
                    // Y along the segment; `height` is the straight part between the two cap centres.
                    body.addCollider({ shape: { kind: 'capsule', radius: r, height: Math.max(1e-3, len - 2 * r), segments: 10 } });
            }

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
            if (cfg.inheritVelocity) body.velocity.vadd({ x: cfg.inheritVelocity[0], y: cfg.inheritVelocity[1], z: cfg.inheritVelocity[2] }, body.velocity);
            if (push && lp.parent >= 0 && lp.center[1] > rootY) body.velocity.vadd({ x: push[0], y: push[1], z: push[2] }, body.velocity);

            bodies.push(body);
            this._bodies.set(lp.node, body);
            this._physics.addBody(body);
        }
        this._physics._registerRagdollParts(this, bodies);

        // A hit lands on the part nearest it, and half of it on that part's parent.
        if (cfg.hitDirection && cfg.hitPoint) {
            const [hx, hy, hz] = cfg.hitPoint;
            let best = -1, bestD = Infinity;
            bodies.forEach((b, i) => {
                const d = (b.position.x - hx) ** 2 + (b.position.y - hy) ** 2 + (b.position.z - hz) ** 2;
                if (d < bestD) { bestD = d; best = i; }
            });
            if (best >= 0) {
                const kick = { x: cfg.hitDirection[0], y: cfg.hitDirection[1], z: cfg.hitDirection[2] };
                bodies[best].velocity.vadd(kick, bodies[best].velocity);
                const parent = layout.parts[best].parent;
                if (parent >= 0) bodies[parent].velocity.vadd({ x: 0.5 * kick.x, y: 0.5 * kick.y, z: 0.5 * kick.z }, bodies[parent].velocity);
            }
        }

        // Joints, in each body's own frame. A body's live orientation is (bone's bind->live turn) * its
        // bind frame, so a bind-space vector's local form is just inverse(bind frame) * vector.
        const local = (q: quat, v: vec3, origin: vec3 | null, scale: number): [number, number, number] => {
            const out = origin ? vec3.sub(vec3.create(), v, origin) : vec3.clone(v);
            if (origin) vec3.scale(out, out, scale);
            vec3.transformQuat(out, out, quat.invert(quat.create(), q));
            return [out[0], out[1], out[2]];
        };
        const driveJoint: (JointHandle | null)[] = layout.parts.map(() => null);
        const pivots: { self: [number, number, number]; parent: [number, number, number] }[] = layout.parts.map(() => ({ self: [0, 0, 0], parent: [0, 0, 0] }));
        for (const lp of layout.parts) {
            if (lp.parent < 0) continue;
            const pp = layout.parts[lp.parent];
            const a = bodies[lp.index], b = bodies[lp.parent];
            const sA = scales[lp.index], sB = scales[lp.parent];
            const pivotA = local(lp.rotation, lp.pivot, lp.center, sA);
            const pivotB = local(pp.rotation, lp.pivot, pp.center, sB);
            pivots[lp.index] = { self: pivotA, parent: pivotB };
            const type = lp.part.joint?.type ?? 'cone';
            if (type === 'fixed') {
                this._add(a, b, { kind: 'fixed', maxForce, collideConnected: false });
                continue;
            }
            if (type === 'hinge' && lp.hingeAxis) {
                // A knee's or an elbow's muscle turns it about its hinge; the cone below only limits it.
                driveJoint[lp.index] = this._add(a, b, {
                    kind: 'hinge', anchorA: pivotA, anchorB: pivotB,
                    axisA: local(lp.rotation, lp.hingeAxis, null, 1),
                    axisB: local(pp.rotation, lp.hingeAxis, null, 1),
                    maxForce, collideConnected: false,
                }, lp.index);
            }
            // The limit: a cone around the neutral direction (for a hinge, around mid-bend, half the range
            // wide). The twist stays loose for hinges -- the hinge already holds it.
            const cone = this._add(a, b, {
                kind: 'coneTwist', anchorA: pivotA, anchorB: pivotB,
                axisA: local(lp.rotation, lp.childAxis, null, 1),
                axisB: local(pp.rotation, lp.parentAxis, null, 1),
                coneAngle: lp.coneAngle,
                twistAngle: type === 'hinge' ? Math.PI : Math.max(lp.twistAngle, 5 * DEG2RAD),
                maxForce, collideConnected: false,
                // A muscle turns a joint to where the animation has it, and the twist that pose starts with must
                // not read as past the limit (cannon's own reference is arbitrary).
                ...(this.powered ? { matchTwist: true } : {}),
            }, driveJoint[lp.index] === null ? lp.index : -1);
            if (driveJoint[lp.index] === null) driveJoint[lp.index] = cone;
        }

        this.solverIterations = Math.max(0, Math.round(profile.solverIterations));
        this._skin = skin;
        this._buildParts(skin, layout.parts, bodies, scales, driveJoint, pivots);
        if (this.powered) animator.enablePhysicsMapping(this);
        else animator.enableRagdoll(this._bodies);
        // AFTER the skin is bound to the bodies, so the mesh rises with them rather than staying buried. Not a
        // powered one: it starts from a live pose standing on the ground, which a lift would pop off it, and its
        // pins and muscles hold it while the contacts settle the few centimetres a foot sits in the floor.
        if (!this.powered) this._liftOutOfGround(bodies);
        return true;
    }

    /**
     * Lift the whole ragdoll so no part starts inside the ground. A death clip ends lying ON the floor, so
     * capsules sized to the limbs spawn partly beneath it -- and the solver pushes a buried body out at
     * whatever speed clears it, which threw the corpse metres into the air. One rigid lift for every part,
     * by the deepest penetration found straight under each one, keeps the pose and starts it resting.
     */
    private _liftOutOfGround(bodies: PhysicsBody[]): void {
        let lift = 0;
        const box = [0, 0, 0, 0, 0, 0];
        for (const body of bodies) {
            body.getAabb(box);
            const loY = box[1], hiY = box[4];
            const x = body.position.x, z = body.position.z;
            let hit = null;
            try {
                // Only what the part would land on: a stair ramp meant for characters' capsules is not.
                hit = this._physics.raycast([x, hiY + 1, z], [x, loY - 1, z], { groundOnly: true, collidingWith: body });
            } catch { hit = null; }
            if (hit) lift = Math.max(lift, hit.point[1] - loY);
        }
        if (lift <= 0) return;
        lift += 0.01;
        for (const body of bodies) body.position.y += lift;
    }

    private _add(a: PhysicsBody, b: PhysicsBody, joint: JointSpec, drivePart = -1): JointHandle | null {
        const handle = this._physics.addJoint(a, b, joint);
        if (handle !== null) this._joints.push(handle);
        this._jointSpecs.push({ a, b, spec: joint, drivePart });
        return handle;
    }

    /** The parts' table, and which part carries each joint of the skin (what the animator's mapping reads). */
    private _buildParts(
        skin: Skin, layout: RagdollLayoutPart[], bodies: PhysicsBody[], scales: number[],
        driveJoint: (JointHandle | null)[], pivots: { self: [number, number, number]; parent: [number, number, number] }[],
    ): void {
        const roleOf = new Map<number, string>();
        for (const [slot, node] of humanoidRigOf(skin)) if (!roleOf.has(node)) roleOf.set(node, slot);
        const children: number[][] = layout.map(() => []);
        for (const lp of layout) if (lp.parent >= 0) children[lp.parent].push(lp.index);
        const below = (i: number, out: PhysicsBody[]): PhysicsBody[] => { out.push(bodies[i]); for (const c of children[i]) below(c, out); return out; };
        this._parts = layout.map(lp => {
            const role = roleOf.get(lp.node) ?? null;
            const side = role?.endsWith('.L') ? 'L' : role?.endsWith('.R') ? 'R' : sideFromName(lp.part.name);
            return {
                index: lp.index, name: lp.part.name, role, region: regionOf(role, lp.part.name, lp.parent < 0), side,
                body: bodies[lp.index], parent: lp.parent, children: children[lp.index],
                joint: lp.parent >= 0 ? driveJoint[lp.index] : null, hinge: (lp.part.joint?.type ?? 'cone') === 'hinge' && !!lp.hingeAxis,
                subtree: below(lp.index, []), pivotSelf: pivots[lp.index].self, pivotParent: pivots[lp.index].parent,
                halfLength: lp.length * scales[lp.index] / 2, radius: lp.radius * scales[lp.index], mass: bodies[lp.index].mass, layout: lp,
            };
        });
        this._mapping = new Float32Array(layout.length).fill(1);
        this._bindOf = layout.map(lp => {
            const m = mat4.create();
            if (!mat4.invert(m, skin.joints[lp.joint].inverseBindMatrix as mat4)) mat4.identity(m);
            return m;
        });
        // Each joint is carried by the nearest part at or above it.
        const partOfNode = new Map<number, number>();
        for (const lp of layout) partOfNode.set(lp.node, lp.index);
        const parentOf = skeletonTopology(skin).parentNodeOfNode;
        this.partOfJoint = new Int32Array(skin.joints.length).fill(-1);
        for (let j = 0; j < skin.joints.length; j++) {
            for (let n: number | undefined = skin.joints[j].nodeIndex; n !== undefined; n = parentOf.get(n)) {
                const p = partOfNode.get(n);
                if (p !== undefined) { this.partOfJoint[j] = p; break; }
            }
        }
    }

    // ---- parts, muscles and pins (powered) ----

    /** The bodies, as parts (profile ragdolls; empty for a generic one). */
    public get parts(): readonly RagdollPartInfo[] { return this._parts; }

    /** The part a body is, or -1. */
    public partOf(body: PhysicsBody): number {
        for (const p of this._parts) if (p.body === body) return p.index;
        return -1;
    }

    /** The part by its name ("Forearm L") or humanoid role ('foreArm.L'), or -1. */
    public findPart(nameOrRole: string): number {
        for (const p of this._parts) if (p.name === nameOrRole || p.role === nameOrRole) return p.index;
        return -1;
    }

    /** The part whose surface is nearest a world point, and how far it is from it (negative inside). */
    public partAt(point: ArrayLike<number>): RagdollPartHit | null {
        let best: RagdollPartHit | null = null;
        const seg = [0, 0, 0], y = [0, 0, 0];
        for (const p of this._parts) {
            const b = p.body, q = b.quaternion;
            vec3.transformQuat(y as vec3, [0, 1, 0], [q.x, q.y, q.z, q.w]);
            const dx = point[0] - b.position.x, dy = point[1] - b.position.y, dz = point[2] - b.position.z;
            const along = Math.max(-p.halfLength + p.radius, Math.min(p.halfLength - p.radius, dx * y[0] + dy * y[1] + dz * y[2]));
            seg[0] = dx - y[0] * along; seg[1] = dy - y[1] * along; seg[2] = dz - y[2] * along;
            const d = Math.hypot(seg[0], seg[1], seg[2]) - p.radius;
            if (!best || d < best.distance) best = { part: p.index, distance: d };
        }
        return best;
    }

    /** Give part `i`'s joint a muscle (null: none). The root part has no joint. */
    public setMuscle(i: number, drive: JointDrive | null): void {
        const p = this._parts[i];
        if (!p || p.joint === null || this._frozen) return;
        this._physics.setJointDrive(p.joint, drive, p.subtree);
    }

    /** Where part `i`'s muscle turns it: its rotation in its parent's frame, inv(qParent)·qPart, and that target's spin. */
    public setTarget(i: number, rotation: ArrayLike<number>, angularVelocity?: ArrayLike<number> | null): void {
        const p = this._parts[i];
        if (!p || p.joint === null || this._frozen) return;
        this._physics.setJointTarget(p.joint, rotation, angularVelocity);
    }

    /** What part `i`'s muscle did in the last substep: [torque N·m, saturation 0..1, angle to go rad]. */
    public readMuscle(i: number, out: number[]): number[] {
        const p = this._parts[i];
        if (!p || p.joint === null) { out[0] = out[1] = out[2] = 0; return out; }
        this._physics.readJointDrive(p.joint, out);
        return out;
    }

    /** Puppet strings on part `i` (null: none), pulling it toward setPinTarget's pose. */
    public setPin(i: number, pin: BodyPin | null): void {
        const p = this._parts[i];
        if (!p || this._frozen) return;
        this._physics.setBodyPin(p.body, pin);
    }

    public setPinTarget(i: number, pose: ArrayLike<number>, velocity?: ArrayLike<number> | null): void {
        const p = this._parts[i];
        if (!p || this._frozen) return;
        this._physics.setBodyPinTarget(p.body, pose, velocity);
    }

    /** How much of part `i` is drawn as simulated, 0..1 (1 by default); see PhysicsMappingSource. */
    public setMapping(i: number, weight: number): void {
        if (i >= 0 && i < this._mapping.length) this._mapping[i] = Math.max(0, Math.min(1, weight));
    }

    /** Push part `i` (or the one nearest `point`) by `impulse` (N·s, world) at `point` (default its centre). */
    public applyImpulse(impulse: ArrayLike<number>, point?: ArrayLike<number> | null, part?: number): number {
        const i = part ?? (point ? this.partAt(point)?.part ?? -1 : 0);
        const p = this._parts[i];
        if (!p || this._frozen) return -1;
        const b = p.body;
        const rel = point ? [point[0] - b.position.x, point[1] - b.position.y, point[2] - b.position.z] : undefined;
        b.applyImpulse([impulse[0], impulse[1], impulse[2]], rel);
        b.wakeUp?.();
        return i;
    }

    /**
     * Every part's world pose as the ANIMATION poses it now ([px py pz qx qy qz qw] each) into `out`, which grows
     * to the part count: what muscles and pins reach for.
     */
    public animatedPartPoses(out: number[][]): number[][] {
        const animator = this._animator;
        while (out.length < this._parts.length) out.push([0, 0, 0, 0, 0, 0, 1]);
        if (!animator || !this._skin) return out;
        const bones = animator.getTargetBoneMatrices(), nodeWorld = this.node.worldTransform as mat4;
        for (let i = 0; i < this._parts.length; i++) this.animatedPose(i, bones, nodeWorld, out[i]);
        return out;
    }

    /** Part `i`'s rotation in its parent's frame, inv(qParent)·qPart, from part poses (animatedPartPoses), into `out`. */
    public relativeRotation(poses: readonly number[][], i: number, out: number[]): number[] {
        const p = this._parts[i];
        const c = poses[i];
        if (!p || p.parent < 0) { out[0] = c[3]; out[1] = c[4]; out[2] = c[5]; out[3] = c[6]; return out; }
        const q = poses[p.parent];
        const ax = -q[3], ay = -q[4], az = -q[5], aw = q[6], bx = c[3], by = c[4], bz = c[5], bw = c[6];
        out[0] = aw * bx + ax * bw + ay * bz - az * by;
        out[1] = aw * by - ax * bz + ay * bw + az * bx;
        out[2] = aw * bz + ax * by - ay * bx + az * bw;
        out[3] = aw * bw - ax * bx - ay * by - az * bz;
        return out;
    }

    private readonly _trackPoses: number[][] = [];
    private readonly _trackQ = [0, 0, 0, 1];

    /**
     * The simplest will a powered ragdoll can have: every muscle (`muscle`, null leaves them as they are) reaching
     * for the animation, every part pinned to it by `pin` (null: no pins). What a controller does with no
     * reflexes at all; ReactionController builds its targets the same way and then edits them.
     */
    public followAnimation(muscle: JointDrive | null, pin: BodyPin | null): void {
        if (!this.powered || this._frozen || this._destroyed) return;
        const poses = this.animatedPartPoses(this._trackPoses);
        for (const p of this._parts) {
            if (p.joint !== null) {
                if (muscle) this.setMuscle(p.index, muscle);
                this.setTarget(p.index, this.relativeRotation(poses, p.index, this._trackQ));
            }
            this.setPin(p.index, pin);
            if (pin) this.setPinTarget(p.index, poses[p.index]);
        }
    }

    /** Part `i`'s world pose as the ANIMATION poses it now, [px py pz qx qy qz qw] into `out`. */
    public animatedPartPose(i: number, out: number[]): number[] {
        const animator = this._animator, p = this._parts[i];
        if (!animator || !p || !this._skin) return out;
        this.animatedPose(i, animator.getTargetBoneMatrices(), this.node.worldTransform as mat4, out);
        return out;
    }

    // PhysicsMappingSource
    public get partCount(): number { return this._parts.length; }
    public mappingWeight(i: number): number { return this._mapping[i] ?? 0; }
    public simulatedPose(i: number, out: number[]): void {
        const b = this._parts[i].body, p = b.position, q = b.quaternion;
        out[0] = p.x; out[1] = p.y; out[2] = p.z; out[3] = q.x; out[4] = q.y; out[5] = q.z; out[6] = q.w;
    }
    public animatedPose(i: number, finalBones: readonly mat4[], nodeWorld: mat4, out: number[]): void {
        const lp = this._parts[i].layout;
        ragdollPartPoseInto(this._skin!, lp, nodeWorld, finalBones[lp.joint] as mat4, out, this._bindOf[i]);
    }

    /** Underlying bone bodies keyed by GLTF node index. */
    public get bodies(): Map<number, PhysicsBody> { return this._bodies; }

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
        if (this._frozen || this._destroyed || this._bodies.size === 0 || this.autoFreeze === false) return false;
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
        for (const joint of this._joints) this._physics.removeJoint(joint);
        this._joints = [];
        for (const p of this._parts ?? []) p.joint = null;
        for (const body of this._bodies.values()) {
            body.velocity.set(0, 0, 0);
            body.angularVelocity.set(0, 0, 0);
            this._physics.removeBody(body);
        }
    }

    /** Put a frozen ragdoll back into the world where it lies (a corpse kicked, a knocked-out body getting up). */
    public unfreeze(): void {
        if (!this._frozen || this._destroyed) return;
        this._frozen = false;
        this._stillFor = 0;
        for (const body of this._bodies.values()) this._physics.addBody(body);
        for (const j of this._jointSpecs) {
            const handle = this._physics.addJoint(j.a, j.b, j.spec);
            if (handle === null) continue;
            this._joints.push(handle);
            if (j.drivePart >= 0 && this._parts[j.drivePart]) this._parts[j.drivePart].joint = handle;
        }
        this._physics._registerRagdollParts(this, [...this._bodies.values()]);
    }

    /** Remove all bodies + constraints from physics and return the skeleton to animation. */
    public destroy(): void {
        if (this._destroyed) return;
        this._destroyed = true;
        for (const joint of this._joints) this._physics.removeJoint(joint);
        this._joints = [];
        for (const body of this._bodies.values()) this._physics.removeBody(body);
        this._bodies.clear();
        if (this._ownerBody) { this._ownerBody.collisionFilterMask = this._ownerMask; this._ownerBody = null; }
        if (this._animator) {
            if (this.powered) this._animator.disablePhysicsMapping?.();
            else this._animator.disableRagdoll();
        }
    }
}

/** A part's region, from its humanoid role, else its name ("Thigh L"). */
function regionOf(role: string | null, name: string, root: boolean): RagdollRegion {
    if (root) return 'pelvis';
    const r = (role ?? '').replace(/\.[LR]$/, '');
    switch (r) {
        case 'hips': return 'pelvis';
        case 'spine': case 'chest': return 'spine';
        case 'neck': case 'head': return 'neck';
        case 'shoulder': case 'upperArm': case 'foreArm': return 'arms';
        case 'hand': return 'hands';
        case 'upLeg': case 'leg': return 'legs';
        case 'foot': case 'toe': return 'feet';
    }
    const n = name.toLowerCase();
    if (/head|neck/.test(n)) return 'neck';
    if (/hand/.test(n)) return 'hands';
    if (/arm|shoulder|elbow/.test(n)) return 'arms';
    if (/foot|toe/.test(n)) return 'feet';
    if (/thigh|shin|leg|knee/.test(n)) return 'legs';
    if (/pelvis|hip/.test(n)) return 'pelvis';
    return 'spine';
}

function sideFromName(name: string): 'L' | 'R' | null {
    if (/(^|\s|_)L$|left/i.test(name)) return 'L';
    if (/(^|\s|_)R$|right/i.test(name)) return 'R';
    return null;
}
