import { Camera } from "../../camera";
import { aimFromDirection, boomOffset, collisionRatio, shakeOffsets } from "../../cameraRigMath";
import { Logger } from "../../logger";
import { RAD2DEG, clamp, dampAngleDeg, dampTime, dampVec3Time, wrapDegrees } from "../../math";
import type { Scene } from "../scene";
import { unwrapScriptNode } from "./nodeScripting";
import { mat4, quat, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { CameraNode } from "./cameraNode";
import { Node } from "./node";

/**
 * The follow/aim/spring-arm camera rig, driven from the scene late pass.
 */

export type FollowSpace = 'world' | 'targetYaw' | 'targetFull';
/** What drives the rig's aim. */
export type AimMode = 'orbit' | 'lookAt' | 'none';

/**
 * Drives a child CameraNode: follow, aim, spring arm, collision, shake.
 *
 * Hierarchy contract — the rig sits ABOVE a CameraNode and may itself be nested under anything (a
 * vehicle, a bone). The rig node carries the *pivot* (its position) and the *aim* (its rotation);
 * the camera child carries only the boom as a local offset with identity rotation, so it inherits
 * the aim. That split is what makes a local offset of `(0, 0, -armLength)` actually mean "behind".
 *
 * Consequence: **the camera child's local position and rotation become rig-derived state** and are
 * overwritten every frame. They still serialize; the rig just reasserts them on the next pass.
 *
 * Terminology follows the industry split (Cinemachine, Unreal's Cine Camera): `follow` drives
 * position, `lookAt` drives aim, and they are independent — a camera can orbit a player while
 * staring at a boss.
 *
 * Driven by `Scene.update`'s late pass (see `lateUpdate`), NOT by the normal `update` loop.
 *
 * Angles are DEGREES; damping values are time constants in SECONDS where 0 means rigid.
 */
export class CameraRigNode extends Node {
    // --- targets (serialized as ids; the node handles are resolution caches) ---------------------
    private _followId: string | null = null;
    private _lookAtId: string | null = null;
    private _followNode: Node | null = null;
    private _lookAtNode: Node | null = null;

    // --- follow ----------------------------------------------------------------------------------
    /** Pivot offset from the follow target. Y is the "height" above it. */
    public followOffset: vec3 = vec3.fromValues(0, 1.6, 0);
    public followSpace: FollowSpace = 'world';
    /** Per-axis time constants. Separate axes are what allow "loose horizontally, tight vertically". */
    public followDamping: vec3 = vec3.fromValues(0.15, 0.25, 0.15);
    /** Whether `followDamping`'s axes are world axes or the rig's own yaw-aligned axes. */
    public followDampingSpace: 'world' | 'rig' = 'world';

    // --- aim -------------------------------------------------------------------------------------
    public aimMode: AimMode = 'orbit';
    public lookAtOffset: vec3 = vec3.fromValues(0, 1.6, 0);
    public aimDamping: number = 0.1;
    public yawSensitivity: number = 0.2;
    public pitchSensitivity: number = 0.2;
    public invertPitch: boolean = false;
    /** +/-Infinity leaves yaw free (wrapped at the seam) rather than clamped. */
    public yawMin: number = -Infinity;
    public yawMax: number = Infinity;
    public pitchMin: number = -80;
    public pitchMax: number = 80;
    private _yaw: number = 0;
    private _pitch: number = 12;    // positive pitch looks DOWN

    // --- spring arm ------------------------------------------------------------------------------
    public armLength: number = 4;
    public socketOffset: vec3 = vec3.create();

    // --- fov -------------------------------------------------------------------------------------
    /** Opt-in: while false the rig leaves `camera.fov` alone, so the Camera inspector stays authoritative. */
    public fovEnabled: boolean = false;
    public fov: number = 60;
    public fovDamping: number = 0.2;

    // --- collision -------------------------------------------------------------------------------
    public collisionEnabled: boolean = true;
    public collisionRadius: number = 0.2;
    /** Floor on the boom scale. Never 0 — see `collisionRatio`. */
    public collisionMinRatio: number = 0.05;
    /** 0 snaps the camera in instantly, which is correct: easing in leaves it inside the wall. */
    public collisionPullTime: number = 0;
    public collisionReturnTime: number = 0.35;
    /** Nodes (by id) whose bodies the probe ignores, alongside the follow/lookAt targets. */
    public collisionIgnoreIds: string[] = [];

    // --- shake -----------------------------------------------------------------------------------
    public shakePositionAmplitude: vec3 = vec3.fromValues(0.15, 0.15, 0.05);
    /** Degrees, [pitch, yaw, roll]. */
    public shakeRotationAmplitude: vec3 = vec3.fromValues(1.5, 1.5, 2.5);
    public shakeFrequency: number = 22;
    public shakeDecay: number = 1.4;
    /** Non-decaying 0..1 channel a script holds during a rumble; impulses still spike above it. */
    public shakeSustained: number = 0;
    private _trauma: number = 0;
    private _shakeTime: number = 0;
    // Per-instance, and deliberately NOT serialized: a fixed seed would make every rig in a scene
    // shake in perfect unison.
    private readonly _shakeSeed: number = (Math.random() * 0x7fffffff) | 0;

    // --- camera child ----------------------------------------------------------------------------
    /** Optional explicit pin; otherwise the rig finds the nearest CameraNode below it. */
    public cameraNodeId: string | null = null;
    private _cameraChild: CameraNode | null = null;

    // --- runtime state (never serialized) --------------------------------------------------------
    private _pivot: vec3 = vec3.create();
    private _armRatio: number = 1;
    private _currentFov: number = 60;
    private _initialized: boolean = false;
    private _warnedNoCamera: boolean = false;
    private _warnedDanglingFollow: boolean = false;
    private _warnedDanglingLookAt: boolean = false;

    // Scratch, to keep the per-frame path allocation-free.
    private static readonly _v0: vec3 = vec3.create();
    private static readonly _v1: vec3 = vec3.create();
    private static readonly _v2: vec3 = vec3.create();
    private static readonly _v3: vec3 = vec3.create();
    private static readonly _q0: quat = quat.create();
    private static readonly _q1: quat = quat.create();
    private static readonly _m0: mat4 = mat4.create();
    // Separate from _v0.._v3: the collision probe runs while the boom vectors are still live.
    private static readonly _probeDir: vec3 = vec3.create();
    private static readonly _probeRight: vec3 = vec3.create();
    private static readonly _probeUp: vec3 = vec3.create();
    private static readonly _rayFrom: vec3 = vec3.create();
    private static readonly _rayTo: vec3 = vec3.create();
    private static readonly _shake = { position: vec3.create(), rotation: vec3.create() };

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'cameraRig', id);
    }

    // --- target accessors ------------------------------------------------------------------------

    /** The node whose position the rig follows, or null. */
    public get follow(): Node | null { return this._resolveFollow(); }
    public set follow(node: Node | null) {
        // The script proxy's `set` trap forwards values untouched, so a script assigning
        // `rig.follow = this.findNode('Player')` would otherwise store a Proxy that never compares
        // equal to the real node.
        const raw = node ? unwrapScriptNode(node) : null;
        this._followNode = raw;
        this._followId = raw ? raw.id : null;
        this._warnedDanglingFollow = false;
    }

    /** The node the rig aims at while `aimMode` is 'lookAt', or null. */
    public get lookAt(): Node | null { return this._resolveLookAt(); }
    public set lookAt(node: Node | null) {
        const raw = node ? unwrapScriptNode(node) : null;
        this._lookAtNode = raw;
        this._lookAtId = raw ? raw.id : null;
        this._warnedDanglingLookAt = false;
    }

    public get followId(): string | null { return this._followId; }
    public set followId(id: string | null) {
        this._followId = id || null;
        this._followNode = null;
        this._warnedDanglingFollow = false;
    }

    public get lookAtId(): string | null { return this._lookAtId; }
    public set lookAtId(id: string | null) {
        this._lookAtId = id || null;
        this._lookAtNode = null;
        this._warnedDanglingLookAt = false;
    }

    // --- orbit ------------------------------------------------------------------------------------

    public get yaw(): number { return this._yaw; }
    public set yaw(degrees: number) { this._yaw = this._clampYaw(degrees); }
    public get pitch(): number { return this._pitch; }
    public set pitch(degrees: number) { this._pitch = clamp(degrees, this.pitchMin, this.pitchMax); }

    /**
     * Adds RAW input (a mouse delta in pixels, a stick axis) to yaw, scaled by `yawSensitivity`.
     *
     * Deliberately does not multiply by frame delta: mouse deltas are already per-frame quantities,
     * and scaling them by dt makes the camera speed depend on frame rate. Analog-stick callers, whose
     * input is a rate, should multiply by delta themselves.
     */
    public addYaw(raw: number): CameraRigNode {
        this._yaw = this._clampYaw(this._yaw + raw * this.yawSensitivity);
        return this;
    }

    /** Adds RAW input to pitch, scaled by `pitchSensitivity` and honouring `invertPitch`. See `addYaw`. */
    public addPitch(raw: number): CameraRigNode {
        const delta = raw * this.pitchSensitivity * (this.invertPitch ? -1 : 1);
        this._pitch = clamp(this._pitch + delta, this.pitchMin, this.pitchMax);
        return this;
    }

    /** Sets both angles at once, clamped but WITHOUT the sensitivity scaling. */
    public setOrbit(yawDegrees: number, pitchDegrees: number): CameraRigNode {
        this._yaw = this._clampYaw(yawDegrees);
        this._pitch = clamp(pitchDegrees, this.pitchMin, this.pitchMax);
        return this;
    }

    private _clampYaw(degrees: number): number {
        return isFinite(this.yawMin) || isFinite(this.yawMax)
            ? clamp(degrees, this.yawMin, this.yawMax)
            : wrapDegrees(degrees);
    }

    // --- shake -------------------------------------------------------------------------------------

    /** Adds trauma (0..1). Impulses stack but saturate, so a burst of hits cannot exceed a full shake. */
    public shake(amount: number): CameraRigNode {
        this._trauma = clamp(this._trauma + amount, 0, 1);
        return this;
    }

    public stopShake(): CameraRigNode {
        this._trauma = 0;
        this.shakeSustained = 0;
        return this;
    }

    public get trauma(): number { return this._trauma; }

    // --- introspection -----------------------------------------------------------------------------

    /** The damped world-space pivot. Live reference — clone it to keep it across frames. */
    public get pivotPosition(): vec3 { return this._pivot; }
    /** Arm length after collision pullback. */
    public get currentArmLength(): number { return this.armLength * this._armRatio; }

    /**
     * Kills damping for the next pass, so the camera teleports rather than flying across the level.
     * Call it after moving the follow target discontinuously.
     */
    public snapToTarget(): CameraRigNode {
        this._initialized = false;
        return this;
    }

    // --- camera child resolution ---------------------------------------------------------------------

    /** The CameraNode this rig drives, or null. */
    public get camera(): CameraNode | null {
        const cached = this._cameraChild;
        if (cached && cached.parent && !cached.markForRemoval && cached.isDescendantOf(this)) return cached;
        return (this._cameraChild = this._resolveCamera());
    }

    private _resolveCamera(): CameraNode | null {
        if (this.cameraNodeId) {
            const pinned = this._scene?.getNodeById(this.cameraNodeId);
            if (pinned instanceof CameraNode && pinned.isDescendantOf(this)) return pinned;
        }

        // Depth-first so a plain offset node may sit between the rig and its camera, but stopping at
        // the first camera on each branch so a camera nested under a camera does not confuse it.
        const found: CameraNode[] = [];
        const visit = (node: Node) => {
            for (const child of node.children) {
                if (child.name.startsWith('__editor__') || child.name.startsWith('__debug__')) continue;
                if (child instanceof CameraNode) { found.push(child); continue; }
                visit(child);
            }
        };
        visit(this);

        if (found.length === 0) return null;
        if (found.length > 1 && !this._warnedNoCamera)
            Logger.warn(`Camera rig '${this._name}' has ${found.length} camera children; driving the active one.`, 'Scene');
        return found.find(c => c.active) ?? found[0];
    }

    // --- reference resolution -------------------------------------------------------------------------

    private _resolveRef(id: string | null, cache: Node | null): Node | null {
        if (!id) return null;
        // `scene` is nulled on detach, which is how a despawned target is caught without a map lookup
        // on the common path.
        if (cache && cache.id === id && cache.scene && !cache.markForRemoval) return cache;
        return this._scene?.getNodeById(id) ?? null;
    }

    private _resolveFollow(): Node | null {
        return (this._followNode = this._resolveRef(this._followId, this._followNode));
    }

    private _resolveLookAt(): Node | null {
        return (this._lookAtNode = this._resolveRef(this._lookAtId, this._lookAtNode));
    }

    // --- the per-frame pass ----------------------------------------------------------------------------

    /**
     * Drives the camera child. Called by `Scene.update` AFTER every node's `onUpdate` has run and the
     * whole tree's transforms have been re-synced — a rig cannot do this work from its own `update()`,
     * because a follow target that sorts later in the traversal would not have moved yet and the rig
     * would trail it by a frame (visible as shimmer during fast movement).
     *
     * `snap` (editor-stopped or paused) makes every damper instant and skips collision and shake, so
     * the viewport previews the rig's resting pose live while its properties are being edited.
     */
    public lateUpdate(delta: number, snap: boolean): void {
        const cam = this.camera;
        if (!cam) {
            if (!this._warnedNoCamera) {
                Logger.warn(`Camera rig '${this._name}' has no CameraNode child; it will not drive anything.`, 'Scene');
                this._warnedNoCamera = true;
            }
            return;
        }
        this._warnedNoCamera = false;

        const dt = Math.max(0, delta);
        const rigid = snap || !this._initialized;

        this._updatePivot(dt, rigid);
        this._updateAim(dt, rigid);

        // The rig's world orientation; its local orientation is this relative to the parent.
        const worldRotation = quat.fromEuler(CameraRigNode._q0, this._pitch, this._yaw, 0);
        this._applyRigTransform(worldRotation);

        // Boom, in rig-local space, then rotated into the world for the collision probe.
        const boomLocal = boomOffset(CameraRigNode._v1, this.socketOffset, this.armLength);
        const boomWorld = vec3.transformQuat(CameraRigNode._v2, boomLocal, worldRotation);
        const boomDistance = vec3.length(boomWorld);

        this._updateCollision(dt, snap, boomWorld, boomDistance, worldRotation);

        cam.setPosition(vec3.scale(CameraRigNode._v3, boomLocal, this._armRatio));
        cam.setQuaternion(quat.identity(CameraRigNode._q1));

        // Recurses into the camera child, so its world cache is correct for the writes below. The
        // parent's own world transform is already fresh from the Scene's pre-pass.
        this.updateTransforms(this._parent ? this._parent.worldTransform : null);

        this._updateFov(cam, dt, rigid);
        this._writeCamera(cam, dt, snap);

        this._initialized = true;
    }

    private _updatePivot(dt: number, rigid: boolean): void {
        const target = this._resolveFollow();

        if (!target) {
            if (this._followId) {
                // Dangling: hold the last pivot rather than snapping to the origin. A target dying
                // mid-frame should park the camera where it was, which is what a death-cam wants.
                if (!this._warnedDanglingFollow) {
                    Logger.warn(`Camera rig '${this._name}' follows a node that no longer exists (${this._followId}); holding position.`, 'Scene');
                    this._warnedDanglingFollow = true;
                }
                if (!this._initialized) vec3.copy(this._pivot, this.worldPosition);
                return;
            }
            // No target set at all is a legitimate authoring state: the rig's own authored position
            // is the pivot, which makes a static orbit camera work with zero configuration.
            vec3.copy(this._pivot, this.worldPosition);
            return;
        }
        this._warnedDanglingFollow = false;

        const desired = vec3.copy(CameraRigNode._v0, target.worldPosition);
        const offset = CameraRigNode._v1;
        if (this.followSpace === 'world') {
            vec3.copy(offset, this.followOffset);
        } else if (this.followSpace === 'targetFull') {
            vec3.transformQuat(offset, this.followOffset, target.worldQuaternion);
        } else {
            // targetYaw: heading only, so the pivot does not tilt when the target pitches or rolls.
            const forward = target.worldForward;
            const yaw = Math.atan2(forward[0], forward[2]) * RAD2DEG;
            vec3.transformQuat(offset, this.followOffset, quat.fromEuler(CameraRigNode._q1, 0, yaw, 0));
        }
        vec3.add(desired, desired, offset);

        if (rigid) { vec3.copy(this._pivot, desired); return; }

        if (this.followDampingSpace === 'world') {
            dampVec3Time(this._pivot, this._pivot, desired, this.followDamping, dt);
            return;
        }

        // Rig space: damp the error in the rig's own yaw-aligned frame so "behind" and "sideways"
        // can lag differently, then bring it back to world.
        const toRig = quat.invert(CameraRigNode._q1, quat.fromEuler(CameraRigNode._q1, 0, this._yaw, 0));
        const currentLocal = vec3.transformQuat(CameraRigNode._v2, this._pivot, toRig);
        const desiredLocal = vec3.transformQuat(CameraRigNode._v3, desired, toRig);
        dampVec3Time(currentLocal, currentLocal, desiredLocal, this.followDamping, dt);
        vec3.transformQuat(this._pivot, currentLocal, quat.fromEuler(CameraRigNode._q1, 0, this._yaw, 0));
    }

    private _updateAim(dt: number, rigid: boolean): void {
        if (this.aimMode === 'lookAt') {
            const target = this._resolveLookAt();
            if (target) {
                this._warnedDanglingLookAt = false;
                // Aim from the PIVOT, not from the camera: aiming from the camera is circular, since
                // the camera's position depends on the very rotation being solved for. The camera sits
                // behind the pivot on the boom and so looks through it at the target.
                const focus = vec3.add(CameraRigNode._v0, target.worldPosition, this.lookAtOffset);
                const direction = vec3.subtract(CameraRigNode._v0, focus, this._pivot);
                const { yaw, pitch } = aimFromDirection(direction);
                // Written back into the same state orbit mode uses, so switching aimMode at runtime
                // never jumps.
                this._yaw = rigid ? yaw : dampAngleDeg(this._yaw, yaw, this.aimDamping, dt);
                this._pitch = rigid ? pitch : dampTime(this._pitch, pitch, this.aimDamping, dt);
            } else if (this._lookAtId && !this._warnedDanglingLookAt) {
                Logger.warn(`Camera rig '${this._name}' aims at a node that no longer exists (${this._lookAtId}); holding aim.`, 'Scene');
                this._warnedDanglingLookAt = true;
            }
        }
        // 'orbit' and 'none' leave _yaw/_pitch as the script (or the inspector) last set them.
        this._yaw = this._clampYaw(this._yaw);
        this._pitch = clamp(this._pitch, this.pitchMin, this.pitchMax);
    }

    private _applyRigTransform(worldRotation: quat): void {
        const parent = this._parent;

        if (parent) {
            const parentRotation = quat.invert(CameraRigNode._q1, parent.worldQuaternion);
            this.setQuaternion(quat.multiply(CameraRigNode._q1, parentRotation, worldRotation));
        } else {
            this.setQuaternion(worldRotation);
        }

        // With no follow target the rig's authored position IS the pivot, so writing it back would be
        // a no-op that also fights the transform gizmo.
        if (!this._followNode) return;

        if (parent && mat4.invert(CameraRigNode._m0, parent.worldTransform))
            this.setPosition(vec3.transformMat4(CameraRigNode._v0, this._pivot, CameraRigNode._m0));
        else
            this.setPosition(this._pivot);
    }

    private _updateCollision(dt: number, snap: boolean, boomWorld: vec3, boomDistance: number, worldRotation: quat): void {
        if (!this.collisionEnabled || snap || boomDistance < 1e-4) {
            this._armRatio = 1;
            return;
        }

        const direction = vec3.scale(CameraRigNode._probeDir, boomWorld, 1 / boomDistance);
        const hit = this._probe(direction, boomDistance, worldRotation);
        const target = collisionRatio(hit, boomDistance, this.collisionRadius, this.collisionMinRatio);

        // Fast in, slow out. Easing the pull-in would leave the camera inside the wall for several
        // frames, which reads as a rendering bug; easing the return stops it popping backwards the
        // instant a corner clears.
        this._armRatio = target < this._armRatio
            ? dampTime(this._armRatio, target, this.collisionPullTime, dt)
            : dampTime(this._armRatio, target, this.collisionReturnTime, dt);
    }

    /**
     * Nearest obstruction between the pivot and the camera, or null.
     *
     * Probes the PHYSICS world, not render geometry. Raycasting the meshes meant testing their
     * axis-aligned bounding boxes, which is hopeless for an imported asset carrying a rotation: a
     * 0.2-thick wall rotated 45 degrees measures 7.2 deep as an AABB, so the boom stopped ~3.6 units
     * short of the surface and registered phantom hits against empty corners. Collider shapes are
     * convex and exact, they are what the character already collides with, and cannon brings a
     * broadphase the engine otherwise lacks for rays. It also subsumes terrain, whose heightfield
     * body lives in the same world — hence no separate analytic terrain march here any more.
     *
     * Takes `worldRotation` rather than reading `this.worldQuaternion`: the rig's world cache is not
     * refreshed until step 8 of `lateUpdate`, so reading it here would offset the probe rays by the
     * PREVIOUS frame's orientation.
     *
     * Uses its own scratch vectors — `_v0.._v3` still hold the caller's boom, which is read again
     * after this returns.
     */
    private _probe(direction: vec3, distance: number, worldRotation: quat): number | null {
        const physics = this._scene?.physics;
        if (!physics) return null;

        // cannon has no sphere-cast, so approximate the probe sphere with four rays offset around
        // the centre one.
        const right = vec3.transformQuat(CameraRigNode._probeRight, vec3.set(CameraRigNode._probeRight, 1, 0, 0), worldRotation);
        const up = vec3.transformQuat(CameraRigNode._probeUp, vec3.set(CameraRigNode._probeUp, 0, 1, 0), worldRotation);
        const from = CameraRigNode._rayFrom;
        const to = CameraRigNode._rayTo;

        // Floored so the four offset rays never collapse onto the centre one. At collisionRadius 0
        // that would fire five identical queries — wasteful, and it removes the redundancy that
        // covers a cannon Heightfield quirk: a ray originating exactly on a terrain grid line and
        // running almost exactly along an axis misses the surface entirely (erratically, depending
        // on the float epsilon). Measured over a hilly terrain: 1-in-8 sample points missed with the
        // rays collapsed, 0-in-8 once they are spread. A millimetre of spread is imperceptible next
        // to any real probe radius and makes the degenerate case unreachable.
        const spread = Math.max(this.collisionRadius, 1e-3);

        let nearest: number | null = null;
        for (let i = 0; i < 5; i++) {
            vec3.copy(from, this._pivot);
            if (i === 1) vec3.scaleAndAdd(from, from, right, spread);
            else if (i === 2) vec3.scaleAndAdd(from, from, right, -spread);
            else if (i === 3) vec3.scaleAndAdd(from, from, up, spread);
            else if (i === 4) vec3.scaleAndAdd(from, from, up, -spread);

            // A cannon ray is a segment, so the boom length goes into the endpoint.
            vec3.scaleAndAdd(to, from, direction, distance);

            const hit = physics.raycastCamera(from, to, this._rejectHit);
            if (hit !== null && (nearest === null || hit < nearest)) nearest = hit;
        }
        return nearest;
    }

    /**
     * Which bodies the probe must ignore, by owning node. Bound once (not per ray) so handing it to
     * the physics system allocates nothing per frame.
     *
     * The ancestor check is the load-bearing one: a rig is typically a CHILD of the character, and the
     * character is what carries the body, so the pivot sits inside its own capsule. Excluding only
     * descendants — which is all the old mesh-based path needed — would leave the probe hitting the
     * character on frame one and pinning the camera to its head.
     *
     * `owner` is null for bodies the engine did not create, notably the terrain heightfield; those are
     * kept, which is what lets terrain collide through this same path.
     */
    private readonly _rejectHit = (owner: Node | null): boolean => {
        if (!owner) return false;
        if (owner === this || owner.isDescendantOf(this) || this.isDescendantOf(owner)) return true;

        const follow = this._followNode;
        if (follow && (owner === follow || owner.isDescendantOf(follow))) return true;
        const lookAt = this._lookAtNode;
        if (lookAt && (owner === lookAt || owner.isDescendantOf(lookAt))) return true;

        for (const id of this.collisionIgnoreIds) {
            if (owner.id === id) return true;
            const ignored = this._scene?.getNodeById(id);
            if (ignored && owner.isDescendantOf(ignored)) return true;
        }
        return false;
    };

    private _updateFov(cam: CameraNode, dt: number, rigid: boolean): void {
        if (!this.fovEnabled || cam.camera.type !== 'perspective') return;
        this._currentFov = rigid ? this.fov : dampTime(this._currentFov, this.fov, this.fovDamping, dt);
        cam.camera.fov = this._currentFov;
    }

    /**
     * Writes the final view to the Camera, with shake applied as a pure post-offset.
     *
     * Shake never touches `_pivot`, `_yaw`, `_pitch`, `_armRatio` or the camera node's transform, so
     * it cannot feed back into a damper, and gameplay code reading `cameraNode.worldPosition` (to
     * spawn a projectile, say) still sees stable values. The Camera's setters copy, so handing it
     * scratch vectors is safe.
     */
    private _writeCamera(cam: CameraNode, dt: number, snap: boolean): void {
        const position = vec3.copy(CameraRigNode._v0, cam.worldPosition);
        const rotation = quat.copy(CameraRigNode._q0, cam.worldQuaternion);

        if (!snap) {
            this._shakeTime += dt;
            this._trauma = Math.max(0, this._trauma - this.shakeDecay * dt);
        }

        // Quadratic falloff: trauma decays linearly but reads as a smooth settle.
        const effective = snap ? 0 : clamp(this._trauma + this.shakeSustained, 0, 1);
        const strength = effective * effective;

        if (strength > 0) {
            const shake = shakeOffsets(
                CameraRigNode._shake, this._shakeTime, this._shakeSeed, this.shakeFrequency,
                strength, this.shakePositionAmplitude, this.shakeRotationAmplitude
            );
            vec3.transformQuat(CameraRigNode._v1, shake.position, rotation);
            vec3.add(position, position, CameraRigNode._v1);
            // Post-multiply so the shake is expressed in camera space, not world space.
            quat.multiply(rotation, rotation, quat.fromEuler(CameraRigNode._q1, shake.rotation[0], shake.rotation[1], shake.rotation[2]));
        }

        const camera = cam.camera;
        camera.position = position;
        camera.eye = vec3.add(CameraRigNode._v2, position,
            vec3.transformQuat(CameraRigNode._v2, vec3.set(CameraRigNode._v2, 0, 0, 1), rotation));
        // Camera.up is otherwise pinned to world +Y, which would make shake roll invisible. At rest
        // this resolves back to world +Y, matching a plain CameraNode exactly.
        camera.up = vec3.transformQuat(CameraRigNode._v3, vec3.set(CameraRigNode._v3, 0, 1, 0), rotation);
    }

    // --- serialization ------------------------------------------------------------------------------

    protected _serializePayload(): any {
        return {

                    followId: this._followId,
                    lookAtId: this._lookAtId,
                    cameraNodeId: this.cameraNodeId,

                    followOffset: [...this.followOffset],
                    followSpace: this.followSpace,
                    followDamping: [...this.followDamping],
                    followDampingSpace: this.followDampingSpace,

                    aimMode: this.aimMode,
                    lookAtOffset: [...this.lookAtOffset],
                    aimDamping: this.aimDamping,
                    yaw: this._yaw,
                    pitch: this._pitch,
                    yawSensitivity: this.yawSensitivity,
                    pitchSensitivity: this.pitchSensitivity,
                    invertPitch: this.invertPitch,
                    // JSON has no Infinity; null round-trips through it as "unclamped".
                    yawMin: isFinite(this.yawMin) ? this.yawMin : null,
                    yawMax: isFinite(this.yawMax) ? this.yawMax : null,
                    pitchMin: this.pitchMin,
                    pitchMax: this.pitchMax,

                    armLength: this.armLength,
                    socketOffset: [...this.socketOffset],

                    fovEnabled: this.fovEnabled,
                    fov: this.fov,
                    fovDamping: this.fovDamping,

                    collisionEnabled: this.collisionEnabled,
                    collisionRadius: this.collisionRadius,
                    collisionMinRatio: this.collisionMinRatio,
                    collisionPullTime: this.collisionPullTime,
                    collisionReturnTime: this.collisionReturnTime,
                    collisionIgnoreIds: [...this.collisionIgnoreIds],

                    shakePositionAmplitude: [...this.shakePositionAmplitude],
                    shakeRotationAmplitude: [...this.shakeRotationAmplitude],
                    shakeFrequency: this.shakeFrequency,
                    shakeDecay: this.shakeDecay,
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new CameraRigNode(json.name, json.id);

        const num = (value: any, fallback: number) => typeof value === 'number' && isFinite(value) ? value : fallback;
        const bool = (value: any, fallback: boolean) => typeof value === 'boolean' ? value : fallback;
        const v3 = (out: vec3, value: any) => { if (Array.isArray(value) && value.length >= 3) vec3.set(out, +value[0], +value[1], +value[2]); };

        // Target ids are stored raw and resolved lazily: parse is depth-first over the JSON tree, so
        // the follow target very often does not exist yet at this point.
        node._followId = typeof json.followId === 'string' ? json.followId : null;
        node._lookAtId = typeof json.lookAtId === 'string' ? json.lookAtId : null;
        node.cameraNodeId = typeof json.cameraNodeId === 'string' ? json.cameraNodeId : null;

        v3(node.followOffset, json.followOffset);
        if (json.followSpace === 'world' || json.followSpace === 'targetYaw' || json.followSpace === 'targetFull')
            node.followSpace = json.followSpace;
        v3(node.followDamping, json.followDamping);
        if (json.followDampingSpace === 'world' || json.followDampingSpace === 'rig')
            node.followDampingSpace = json.followDampingSpace;

        if (json.aimMode === 'orbit' || json.aimMode === 'lookAt' || json.aimMode === 'none')
            node.aimMode = json.aimMode;
        v3(node.lookAtOffset, json.lookAtOffset);
        node.aimDamping = num(json.aimDamping, node.aimDamping);
        node.yawSensitivity = num(json.yawSensitivity, node.yawSensitivity);
        node.pitchSensitivity = num(json.pitchSensitivity, node.pitchSensitivity);
        node.invertPitch = bool(json.invertPitch, node.invertPitch);
        node.yawMin = typeof json.yawMin === 'number' ? json.yawMin : -Infinity;
        node.yawMax = typeof json.yawMax === 'number' ? json.yawMax : Infinity;
        node.pitchMin = num(json.pitchMin, node.pitchMin);
        node.pitchMax = num(json.pitchMax, node.pitchMax);
        node._yaw = num(json.yaw, node._yaw);
        node._pitch = num(json.pitch, node._pitch);

        node.armLength = num(json.armLength, node.armLength);
        v3(node.socketOffset, json.socketOffset);

        node.fovEnabled = bool(json.fovEnabled, node.fovEnabled);
        node.fov = num(json.fov, node.fov);
        node.fovDamping = num(json.fovDamping, node.fovDamping);
        node._currentFov = node.fov;

        node.collisionEnabled = bool(json.collisionEnabled, node.collisionEnabled);
        node.collisionRadius = num(json.collisionRadius, node.collisionRadius);
        node.collisionMinRatio = num(json.collisionMinRatio, node.collisionMinRatio);
        node.collisionPullTime = num(json.collisionPullTime, node.collisionPullTime);
        node.collisionReturnTime = num(json.collisionReturnTime, node.collisionReturnTime);
        node.collisionIgnoreIds = Array.isArray(json.collisionIgnoreIds)
            ? json.collisionIgnoreIds.filter((id: any) => typeof id === 'string') : [];

        v3(node.shakePositionAmplitude, json.shakePositionAmplitude);
        v3(node.shakeRotationAmplitude, json.shakeRotationAmplitude);
        node.shakeFrequency = num(json.shakeFrequency, node.shakeFrequency);
        node.shakeDecay = num(json.shakeDecay, node.shakeDecay);

        // _commonParse adds the node to its parent — do not addChild again.
        Node.finishParse(node, parent, json);
    }

    /** Inflated a little so the rig is easy to click in the viewport, like CameraNode. */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const radius = 0.35;
        return {
            min: vec3.fromValues(position[0] - radius, position[1] - radius, position[2] - radius),
            max: vec3.fromValues(position[0] + radius, position[1] + radius, position[2] + radius),
        };
    }
}
