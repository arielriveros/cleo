import { mat4, quat, vec3 } from 'gl-matrix';
import { Animation, AnimationChannel, AnimationSampler, Skin } from './animatedModel';
import { humanoidSlotOf, mirrorBoneName, normalizeBoneName } from './boneNames';
import { skeletonTopology, SkeletonTopology } from './skeletonTopology';
import { humanoidRigOf, localBindRotation, localRestTranslation } from './animationRetarget';
import { Logger } from '../core/logger';

// ---------------------------------------------------------------------------
// Non-destructive clip edits: mirror, in-place bake, additive pose offset, trim, retime.
//
// A `.anim` asset stores its clips ONCE, in the source rig's space, and every character retargets them at
// use. That is what makes an edit stack worth having: an edit recorded here is re-applied on every resolve,
// so one entry changes the clip for every character built on the rig, and removing it puts the original
// keyframes back untouched. The alternative — rewriting 30 clips' keyframes in place — is irreversible and
// has to be redone from a backup the moment the artist wants the arm two degrees higher.
//
// So this module is PURE: clip in, clip out, no GL, no Scene, no editor imports. It runs in three places
// that must agree exactly — the editor's resolve (`animationResolve.ts`), the published game's resolve
// (`player/animations.ts`), and the Bake command that collapses a stack into keyframes.
//
// It runs BEFORE `buildBoneMapping`/`retargetAnimation`, in source-rig space. That ordering is load-bearing
// twice over: mirroring needs the source skeleton's own bone names, and the mapping is built by scanning
// the clips for animated nodes — so a pose offset that adds a channel for a bone the clip never drove has
// to exist before the scan, or the mapping has no entry for it and the retarget silently drops the curve.
//
// Two invariants worth stating up front:
//
//  - **Identity in, identity out.** An empty or fully-disabled stack returns the SAME OBJECT. Object
//    identity is what the resolve cache and `Animator._fieldClip` compare on, so this is not merely a
//    micro-optimization: every clip in every existing project must come out of here untouched.
//  - **Nothing is mutated.** Sampler `output` arrays are shared with the resolve cache and with every
//    retargeted copy, so an in-place write would corrupt every cached resolve of that asset for the rest
//    of the session — and the symptom would appear on a DIFFERENT character. Every op allocates.
//
// One structural note: an EDITED clip comes out with exactly one sampler per channel. glTF permits two
// channels to share a sampler and `gltfLoader.parseAnimation` copies the indices verbatim, so editing a
// sampler in a shared clip would silently change a curve the artist was not looking at. Un-edited clips
// keep whatever shape they were imported with, because they are returned unchanged.
// ---------------------------------------------------------------------------

/** Which world axis the mirror plane is normal to — i.e. the rig's left/right axis. */
export type MirrorAxis = 'x' | 'y' | 'z';

/**
 * One bone's contribution to a pose, as a DELTA FROM ITS REST, not an absolute local transform.
 * Absolute values would pin the bone and be useless across clips; a delta rides on top of whatever the
 * clip is already doing, which is what "raise the right arm to hold a torch, while still walking" needs.
 */
export interface PoseBone {
    /** Bone name on the SOURCE rig — never a node index, which is stable only per export. */
    name: string;
    /** Local rotation delta, xyzw. Applied in the bone's PARENT frame (see {@link applyPoseOffset}). */
    rotation?: number[];
    /** Local translation delta. */
    translation?: number[];
}

export type ClipEdit =
    /** Keep `[start, end]` (seconds); `rebase` (default true) moves the kept range back to t=0. */
    | { kind: 'trim'; start: number; end: number; rebase?: boolean; enabled?: boolean }
    /** Swap left and right. `axis` omitted = auto-detect from the rig ({@link mirrorAxisOf}). */
    | { kind: 'mirror'; axis?: MirrorAxis; enabled?: boolean }
    /** Add a pose on top: a shared one by `poseId`, inline `bones`, or both (inline wins per bone). */
    | { kind: 'poseOffset'; poseId?: string; bones?: PoseBone[]; mask?: string[]; weight?: number; enabled?: boolean }
    /** Strip the root bone's travel so the character animates on the spot. */
    | { kind: 'inPlace'; strip?: 'xz' | 'all' | 'y'; keepYaw?: boolean; upAxis?: MirrorAxis; enabled?: boolean }
    /** Retime. `duration` (seconds) wins over `scale` when both are given. */
    | { kind: 'timeScale'; scale?: number; duration?: number; enabled?: boolean };

export interface ClipEditContext {
    /** The SOURCE rig's skeleton — the space the stored clip is in. */
    skin: Skin;
    /** Optional, purely to reuse a cached topology; computed on demand otherwise. */
    topo?: SkeletonTopology;
    /** Shared poses on the source rig, by id. A `poseId` naming nothing is skipped and reported. */
    poses?: Map<string, PoseBone[]>;
}

/**
 * The order edits are APPLIED in, regardless of the order they sit in the array.
 *
 * The array is the UI's stack and the artist reorders it freely; making the result depend on that order
 * would produce a clip that changes when nothing about it changed. Each rank is forced:
 *
 *  - `trim` first, because it defines the clip's real frame 0 — which `inPlace` pins to.
 *  - `mirror` before `poseOffset`, or a pose authored for the right arm lands on the left.
 *  - `inPlace` after `mirror`: stripping and mirroring do not commute once `keepYaw` is in play, since
 *    the yaw being kept is measured about an axis the mirror reflects.
 *  - `timeScale` last: a pure `input` remap, which commutes with everything.
 */
const EDIT_ORDER: Record<ClipEdit['kind'], number> = { trim: 0, mirror: 1, poseOffset: 2, inPlace: 3, timeScale: 4 };

/** Values per keyframe for each animated property. `weights` is declared by glTF but never played. */
const STRIDE: Record<string, number> = { translation: 3, rotation: 4, scale: 3, weights: 1 };

const EPS = 1e-6;
/** ~0.3 degrees. Mirrors `animationRetarget.ts`'s IDENTITY_EPS, and for the same reason. */
const ANGLE_EPS = 0.005;
/** ~2.9 degrees: how far a looping clip may drift per cycle before anyone would see it. */
const LOOP_RESIDUAL_EPS = 0.05;

const AXIS_INDEX: Record<MirrorAxis, number> = { x: 0, y: 1, z: 2 };

// ---------------------------------------------------------------------------
// Sampling
//
// These MATCH PLAYBACK rather than the glTF spec, deliberately. `Bone.addRotationChannel` reads
// `sampler.output` at stride 1 per key and always lerps/slerps, ignoring `sampler.interpolation`
// entirely — so a STEP clip is already played as LINEAR and a CUBICSPLINE clip is already misread. An
// edit that sampled by the spec would produce a clip that does not match what the engine plays, which is
// a worse bug than the one it would be working around. The interpolation string is carried through
// verbatim and CUBICSPLINE is reported once, so the underlying gap stays visible.
// ---------------------------------------------------------------------------

/** The clip's length: the largest time any sampler reaches. Mirrors `Animator._getAnimationDuration`. */
export function clipDuration(clip: Animation): number {
    let max = 0;
    for (const s of clip.samplers) if (s.input.length) max = Math.max(max, s.input[s.input.length - 1]);
    return max;
}

/** Index of the key at or before `t`, clamped so `i` and `i+1` are both in range. */
function keyIndexAt(input: number[], t: number): number {
    if (input.length < 2) return 0;
    for (let i = 0; i < input.length - 1; i++) if (t < input[i + 1]) return i;
    return input.length - 2;
}

/** Blend factor between key `i` and `i+1`, clamped to [0,1] so sampling past the end holds, never extrapolates. */
function keyFactor(input: number[], i: number, t: number): number {
    if (input.length < 2) return 0;
    const span = input[i + 1] - input[i];
    if (span <= EPS) return 0;
    return Math.min(1, Math.max(0, (t - input[i]) / span));
}

function sampleVec3(s: AnimationSampler, t: number, out = vec3.create()): vec3 {
    if (!s.input.length) return vec3.set(out, 0, 0, 0);
    if (s.input.length < 2) return vec3.set(out, s.output[0] ?? 0, s.output[1] ?? 0, s.output[2] ?? 0);
    const i = keyIndexAt(s.input, t);
    const a = vec3.fromValues(s.output[i * 3], s.output[i * 3 + 1], s.output[i * 3 + 2]);
    const b = vec3.fromValues(s.output[(i + 1) * 3], s.output[(i + 1) * 3 + 1], s.output[(i + 1) * 3 + 2]);
    return vec3.lerp(out, a, b, keyFactor(s.input, i, t));
}

function sampleQuat(s: AnimationSampler, t: number, out = quat.create()): quat {
    if (!s.input.length) return quat.identity(out);
    const i = keyIndexAt(s.input, t);
    const a = quat.fromValues(s.output[i * 4], s.output[i * 4 + 1], s.output[i * 4 + 2], s.output[i * 4 + 3]);
    quat.normalize(a, a);
    if (s.input.length < 2) return quat.copy(out, a);
    const b = quat.fromValues(
        s.output[(i + 1) * 4], s.output[(i + 1) * 4 + 1], s.output[(i + 1) * 4 + 2], s.output[(i + 1) * 4 + 3]);
    quat.normalize(b, b);
    return quat.normalize(out, quat.slerp(out, a, b, keyFactor(s.input, i, t)));
}

// ---------------------------------------------------------------------------
// Bind frames
// ---------------------------------------------------------------------------

function isIdentityMatrix(m: mat4, eps = 1e-6): boolean {
    const I = mat4.create();
    for (let i = 0; i < 16; i++) if (Math.abs(m[i] - I[i]) > eps) return false;
    return true;
}

const topoCache = new WeakMap<Skin, SkeletonTopology>();
function topoOf(skin: Skin, given?: SkeletonTopology): SkeletonTopology {
    if (given) return given;
    let t = topoCache.get(skin);
    if (!t) { t = skeletonTopology(skin); topoCache.set(skin, t); }
    return t;
}

/**
 * A node's MODEL-space bind transform: from `inverse(IBM)` when the joint has a real one, else by
 * accumulating `nodeTransforms` from the root down.
 *
 * The IBM is preferred because it is the authoritative bind — `nodeTransforms` can legitimately hold
 * frame 0 rather than the bind pose (the Mixamo case `skinWithIBM` in the retarget tests encodes), and
 * mirroring against frame 0 would fold the first frame's pose into every other one.
 */
const modelBindCache = new WeakMap<Skin, Map<number, mat4>>();
function modelBindMatrix(skin: Skin, node: number, topo: SkeletonTopology): mat4 {
    let per = modelBindCache.get(skin);
    if (!per) { per = new Map(); modelBindCache.set(skin, per); }
    const hit = per.get(node);
    if (hit) return hit;

    let out = mat4.create();
    const joint = skin.joints.find(j => j.nodeIndex === node);
    const inv = joint && !isIdentityMatrix(joint.inverseBindMatrix as any)
        ? mat4.invert(mat4.create(), joint.inverseBindMatrix as any) : null;
    if (inv) {
        out = inv;
    } else {
        // Walk to the root collecting locals, then multiply top-down.
        const chain: number[] = [node];
        let p = topo.parentNodeOfNode.get(node);
        for (let guard = 0; p !== undefined && guard < 256; guard++) { chain.push(p); p = topo.parentNodeOfNode.get(p); }
        for (let i = chain.length - 1; i >= 0; i--) {
            const local = skin.nodeTransforms?.get(chain[i]);
            if (local) mat4.multiply(out, out, local as any);
        }
    }
    per.set(node, out);
    return out;
}

/** Model-space bind ROTATION of a node's parent — identity at a root. The frame a local channel lives in. */
function parentBindRotation(skin: Skin, node: number, topo: SkeletonTopology): quat {
    const parent = topo.parentNodeOfNode.get(node);
    if (parent === undefined) return quat.create();
    const q = mat4.getRotation(quat.create(), modelBindMatrix(skin, parent, topo));
    return quat.normalize(q, q);
}

/** Model-space bind POSITION of a node. Used only to work out which axis is left/right. */
function modelBindPosition(skin: Skin, node: number, topo: SkeletonTopology): vec3 {
    return mat4.getTranslation(vec3.create(), modelBindMatrix(skin, node, topo));
}

/** The angle of a unit quaternion, in radians. `acos(|w|)` is the half-angle. */
function angleOf(q: quat): number {
    return 2 * Math.acos(Math.min(1, Math.abs(q[3])));
}

// ---------------------------------------------------------------------------
// Mirroring
// ---------------------------------------------------------------------------

/**
 * Reflect a rotation across the plane normal to `n`, in the frame the quaternion is expressed in.
 *
 * A reflection `M` is improper (det = -1) and has no quaternion of its own, but the conjugate `M R M`
 * (`M` is its own inverse) has det `(-1)(1)(-1) = +1` and IS a rotation: the one about the reflected axis
 * `H a` by the NEGATED angle `-t`. Negating the angle is the same as negating the axis, so:
 *
 *     v' = 2(v.n)n - v      (reflect the vector part, then negate it)   w' = w
 *
 * For n = x that is the familiar `(qx, -qy, -qz, qw)`; for n = y, `(-qx, qy, -qz, qw)`.
 *
 * NOTE the asymmetry with {@link reflectVec3}: a rotation reflects AND negates, a translation only
 * reflects. Getting that wrong is the classic mirror bug where the hips slide the wrong way while the
 * pelvis rotation looks right.
 */
function mirrorQuat(out: quat, q: quat, n: vec3): quat {
    const d = q[0] * n[0] + q[1] * n[1] + q[2] * n[2];
    out[0] = 2 * d * n[0] - q[0];
    out[1] = 2 * d * n[1] - q[1];
    out[2] = 2 * d * n[2] - q[2];
    out[3] = q[3];
    return out;
}

/** Householder reflection of a vector across the plane normal to `n`: `v - 2(v.n)n`. No negation. */
function reflectVec3(out: vec3, v: vec3, n: vec3): vec3 {
    const d = vec3.dot(v, n) * 2;
    out[0] = v[0] - d * n[0];
    out[1] = v[1] - d * n[1];
    out[2] = v[2] - d * n[2];
    return out;
}

/**
 * The rig's left/right axis, measured rather than assumed.
 *
 * Hardcoding X is wrong often enough to matter: a Z-up import, a rig authored along another axis, or an
 * armature the FBX conversion left rotated all break it, and the failure is a mirrored clip that looks
 * subtly wrong rather than obviously broken. So find a bone that exists on both sides and see which axis
 * actually separates them. Legs first — they are the furthest apart and the least likely to be missing.
 */
export function mirrorAxisOf(skin: Skin, topo?: SkeletonTopology): MirrorAxis {
    const t = topoOf(skin, topo);
    const rig = humanoidRigOf(skin);
    for (const slot of ['upLeg', 'foot', 'shoulder', 'upperArm', 'hand']) {
        const l = rig.get(`${slot}.L`);
        const r = rig.get(`${slot}.R`);
        if (l === undefined || r === undefined) continue;
        const d = vec3.subtract(vec3.create(), modelBindPosition(skin, l, t), modelBindPosition(skin, r, t));
        const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
        if (Math.max(ax, ay, az) < 1e-4) continue; // coincident: a degenerate rig, try the next pair
        return ax >= ay && ax >= az ? 'x' : ay >= az ? 'y' : 'z';
    }
    return 'x';
}

/**
 * Each node's mirror partner, by node index. A node mapping to ITSELF is a centre bone (or one with no
 * side marker) and mirrors in place; a node ABSENT from the map is sided but has no partner, and its
 * channels are dropped.
 *
 * Dropping is deliberate. Self-mirroring a sided bone reflects a left-arm curve back onto the left arm,
 * which is a plausible-looking pose that is simply wrong; leaving the bone at rest is obviously wrong and
 * is reported. "Obviously wrong and named" beats "subtly wrong and silent" every time here.
 *
 * Every NAMED node is considered, not just joints: an assimp-converted FBX animates `$AssimpFbx$` pivot
 * nodes that are not in `skin.joints`, and skipping them would drop half the motion on those rigs.
 */
export function mirrorPairs(skin: Skin): Map<number, number> {
    const out = new Map<number, number>();
    const names = skin.nodeNames;
    if (!names?.size) return out;

    const byExact = new Map<string, number>();
    const byNormalized = new Map<string, number>();
    const bySlot = new Map<string, number>();
    for (const [node, name] of names) {
        if (!byExact.has(name)) byExact.set(name, node);
        const norm = normalizeBoneName(name);
        if (!byNormalized.has(norm)) byNormalized.set(norm, node);
        const slot = humanoidSlotOf(name);
        if (slot && !bySlot.has(slot)) bySlot.set(slot, node);
    }

    for (const [node, name] of names) {
        const slot = humanoidSlotOf(name);
        const sided = slot ? slot.endsWith('.L') || slot.endsWith('.R') : false;

        // A recognised centre bone mirrors onto itself: hips, spine, chest, neck, head.
        if (slot && !sided) { out.set(node, node); continue; }

        // Humanoid slot first — it is the only tier that pairs across naming conventions, so a rig whose
        // sides are spelled differently (`arm_l` / `RightArm`) still pairs.
        if (slot) {
            const other = slot.slice(0, -2) + (slot.endsWith('.L') ? '.R' : '.L');
            const partner = bySlot.get(other);
            if (partner !== undefined) { out.set(node, partner); continue; }
        }

        // Then the raw name with its side token swapped. This is what pairs everything the humanoid
        // dictionary does not know: twist bones, roll bones, finger variants, prop and IK helpers.
        const swapped = mirrorBoneName(name);
        if (swapped) {
            const partner = byExact.get(swapped) ?? byNormalized.get(normalizeBoneName(swapped));
            if (partner !== undefined) { out.set(node, partner); continue; }
            continue; // sided with no partner -> no entry -> dropped, see the doc comment
        }

        // No side marker anywhere: a centre bone the dictionary did not recognise. Mirror in place.
        out.set(node, node);
    }
    return out;
}

/** Per-bone constants for one mirror pair. Built once per source node, not once per keyframe. */
type MirrorFrame = {
    parentSrc: quat; parentSrcInv: quat;
    parentDstInv: quat; parentDst: quat;
    bindSrcInv: quat; bindDst: quat;
    restSrc: vec3; restDst: vec3;
};

function mirrorFrameOf(skin: Skin, src: number, dst: number, topo: SkeletonTopology): MirrorFrame {
    const parentSrc = parentBindRotation(skin, src, topo);
    const parentDst = parentBindRotation(skin, dst, topo);
    return {
        parentSrc,
        parentSrcInv: quat.invert(quat.create(), parentSrc),
        parentDst,
        parentDstInv: quat.invert(quat.create(), parentDst),
        bindSrcInv: quat.invert(quat.create(), localBindRotation(skin, src)),
        bindDst: localBindRotation(skin, dst),
        restSrc: localRestTranslation(skin, src),
        restDst: localRestTranslation(skin, dst),
    };
}

/**
 * Mirror a clip left-to-right.
 *
 * A clip stores LOCAL transforms relative to each bone's parent. Reflecting world transforms gives
 * `W' = M W M`, and since `L = W_parent^-1 W_bone` the local transform obeys the same law — but only when
 * the bone's parent maps to the partner's parent, which is what makes a humanoid chain work at all.
 *
 * That gives the familiar shortcut: negate two quaternion components and one translation component. It is
 * correct ONLY when the two bones' bind frames are themselves exact mirror images. Mixamo rigs very nearly
 * are; Rigify, Unreal and hand-authored FBX rigs routinely are not, because of per-side bone roll. On
 * those, copying the left curve onto the right starts the limb from a different rest and the whole arm
 * sits twisted — the same failure `retargetAnimation`'s bind-delta correction exists to fix.
 *
 * So this does the robust thing instead, and does it unconditionally rather than switching between a fast
 * and a slow path (two paths that must agree are two chances to disagree):
 *
 *     D = A_s . Rb_s^-1                 pose delta from bind, in the source bone's PARENT frame
 *     D_model = P_s . D . P_s^-1        conjugate into model space, where the mirror plane is defined
 *     D_mir   = mirrorQuat(D_model, n)  reflect
 *     D_dst   = P_d^-1 . D_mir . P_d    into the DESTINATION bone's parent frame
 *     A_d     = D_dst . Rb_d            re-seat on the destination's own rest
 *
 * When the binds really are mirror images this reduces exactly to the shortcut, so nothing is lost.
 *
 * Translation mirrors as a delta from LOCAL REST — `t_d = tb_d + P_d^-1 . H(P_s . (t_s - tb_s))`.
 * Reflecting the absolute local translation would reflect the bone's rest offset as well, so a right arm
 * whose rest already points +X gets a doubled mirror and detaches from the shoulder. The delta form also
 * means a rig whose sagittal plane misses the armature origin still mirrors correctly: the constant
 * offset cancels.
 *
 * Scale is copied across unreflected. An exact mirror of a scale needs a negative determinant, which
 * `mat4.fromRotationTranslationScale` cannot express without inverting winding — and `retargetAnimation`
 * drops scale channels cross-rig anyway, so this only ever shows on the same-rig path.
 */
export function mirrorClip(clip: Animation, skin: Skin, axis?: MirrorAxis, topo?: SkeletonTopology): Animation {
    const t = topoOf(skin, topo);
    const pairs = mirrorPairs(skin);
    if (!pairs.size) {
        warnOnce(clip, 'mirror-no-names', `Cannot mirror "${clip.name}": its rig has no bone names, so left and right cannot be told apart.`);
        return clip;
    }

    const n = vec3.create();
    n[AXIS_INDEX[axis ?? mirrorAxisOf(skin, t)]] = 1;

    const samplers: AnimationSampler[] = [];
    const channels: AnimationChannel[] = [];
    const frames = new Map<number, MirrorFrame>();
    const dropped: string[] = [];
    let asymmetric: { bone: string; deg: number } | null = null;

    for (const ch of clip.channels) {
        const src = clip.samplers[ch.samplerIndex];
        if (!src) continue;
        const dst = pairs.get(ch.targetNodeIndex);
        if (dst === undefined) {
            const nm = skin.nodeNames?.get(ch.targetNodeIndex);
            if (nm && !dropped.includes(nm)) dropped.push(nm);
            continue;
        }

        let frame = frames.get(ch.targetNodeIndex);
        if (!frame) {
            frame = mirrorFrameOf(skin, ch.targetNodeIndex, dst, t);
            frames.set(ch.targetNodeIndex, frame);
            // Diagnostic only — the maths above does not branch on it. `E` is how far this pair's binds
            // are from being mirror images; a large value is exactly the rig on which the naive
            // component-negation mirror would have visibly twisted the limb.
            const lhs = quat.multiply(quat.create(), frame.parentDst, frame.bindDst);
            const rhs = mirrorQuat(quat.create(), quat.multiply(quat.create(), frame.parentSrc, localBindRotation(skin, ch.targetNodeIndex)), n);
            const e = quat.multiply(quat.create(), quat.invert(quat.create(), lhs), rhs);
            const deg = angleOf(quat.normalize(e, e)) * 180 / Math.PI;
            if (deg > ANGLE_EPS * 180 / Math.PI && (!asymmetric || deg > asymmetric.deg)) {
                asymmetric = { bone: skin.nodeNames?.get(ch.targetNodeIndex) ?? String(ch.targetNodeIndex), deg };
            }
        }

        const stride = STRIDE[ch.targetPath] ?? 1;
        const count = Math.floor(src.output.length / stride);
        const out: number[] = [];

        if (ch.targetPath === 'rotation') {
            const q = quat.create(), tmp = quat.create();
            for (let k = 0; k < count; k++) {
                quat.set(q, src.output[k * 4], src.output[k * 4 + 1], src.output[k * 4 + 2], src.output[k * 4 + 3]);
                quat.normalize(q, q);
                quat.multiply(tmp, q, frame.bindSrcInv);                 // D
                quat.multiply(tmp, frame.parentSrc, tmp);
                quat.multiply(tmp, tmp, frame.parentSrcInv);             // D_model
                mirrorQuat(tmp, tmp, n);                                 // D_mir
                quat.multiply(tmp, frame.parentDstInv, tmp);
                quat.multiply(tmp, tmp, frame.parentDst);                // D_dst
                quat.multiply(tmp, tmp, frame.bindDst);                  // A_d
                quat.normalize(tmp, tmp);
                out.push(tmp[0], tmp[1], tmp[2], tmp[3]);
            }
        } else if (ch.targetPath === 'translation') {
            const v = vec3.create();
            for (let k = 0; k < count; k++) {
                vec3.set(v, src.output[k * 3] - frame.restSrc[0], src.output[k * 3 + 1] - frame.restSrc[1], src.output[k * 3 + 2] - frame.restSrc[2]);
                vec3.transformQuat(v, v, frame.parentSrc);
                reflectVec3(v, v, n);
                vec3.transformQuat(v, v, frame.parentDstInv);
                out.push(frame.restDst[0] + v[0], frame.restDst[1] + v[1], frame.restDst[2] + v[2]);
            }
        } else {
            out.push(...src.output);
        }

        channels.push({ samplerIndex: samplers.length, targetNodeIndex: dst, targetPath: ch.targetPath });
        samplers.push({ input: src.input.slice(), output: out, interpolation: src.interpolation });
    }

    if (dropped.length) {
        warnOnce(clip, 'mirror-unpaired',
            `Mirroring "${clip.name}" dropped ${dropped.length} bone${dropped.length === 1 ? '' : 's'} with no ` +
            `opposite-side partner on the rig (${dropped.slice(0, 5).join(', ')}). They stay at rest.`);
    }
    if (asymmetric) {
        warnOnce(clip, 'mirror-asymmetric',
            `"${clip.name}" was mirrored on a rig whose sides do not have mirrored rest poses (worst: ` +
            `${asymmetric.bone}, ${asymmetric.deg.toFixed(1)} degrees). The motion is re-seated on each bone's ` +
            'own rest, which is correct, but a pose authored against one side will not match the other exactly.');
    }

    return withChannels(clip, samplers, channels);
}

// ---------------------------------------------------------------------------
// Root motion / in place
// ---------------------------------------------------------------------------

/**
 * The clip's root-motion bone, as a NODE index: the HIGHEST joint the clip actually animates.
 *
 * This is the same rule `Animator._findRootMotionBone` applies at runtime, and it lives here so there is
 * exactly ONE of it. If the editor's bake and the runtime's strip ever disagreed about which bone carries
 * the motion, the bake would leave residual travel that the editor cannot show — the preview drives the
 * animator directly, so it would look right there and only be wrong in the published game.
 */
export function rootMotionNodeOf(clip: Animation, skin: Skin, topo?: SkeletonTopology): number | null {
    const t = topoOf(skin, topo);
    const animated = new Set(clip.channels.map(c => c.targetNodeIndex));
    const parentOf = t.parentNodeOfNode;

    const isHighestAnimated = (node: number): boolean => {
        let p = parentOf.get(node);
        for (let guard = 0; p !== undefined && guard < 256; guard++) {
            if (animated.has(p)) return false;
            p = parentOf.get(p);
        }
        return true;
    };

    // Prefer the declared skeleton root when the clip animates it directly.
    const skel = skin.skeleton;
    if (skel !== undefined && animated.has(skel) && isHighestAnimated(skel)) return skel;
    for (const j of skin.joints) if (animated.has(j.nodeIndex) && isHighestAnimated(j.nodeIndex)) return j.nodeIndex;
    return null;
}

/**
 * Accumulated rest rotation of the nodes ABOVE `rootNode` — the axis basis the root bone's channels are
 * expressed in. Those nodes are static, so their bind pose is their live pose.
 *
 * Ported from `Animator._rootParentRotation` for the same reason as {@link rootMotionNodeOf}. It matters
 * more than it looks: on an FBX import the armature above the root carries the Z-up to Y-up conversion, so
 * omitting this term turns an authored yaw into a roll and "strip the horizontal travel" strips the
 * character's height instead.
 */
export function rootParentRotation(skin: Skin, rootNode: number, topo?: SkeletonTopology): quat {
    const t = topoOf(skin, topo);
    const out = quat.create();
    const chain: number[] = [];
    let p = t.parentNodeOfNode.get(rootNode);
    for (let guard = 0; p !== undefined && guard < 256; guard++) { chain.push(p); p = t.parentNodeOfNode.get(p); }

    const acc = mat4.create();
    for (let i = chain.length - 1; i >= 0; i--) {
        const local = skin.nodeTransforms?.get(chain[i]);
        if (local) mat4.multiply(acc, acc, local as any);
    }
    mat4.getRotation(out, acc);
    return quat.normalize(out, out);
}

/** Split `q` into the part that rotates about `axis` (twist) and the rest (swing), with `q = swing * twist`. */
function twistAbout(q: quat, axis: vec3): quat {
    const d = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
    const twist = quat.fromValues(axis[0] * d, axis[1] * d, axis[2] * d, q[3]);
    // A 180-degree swing leaves the projection and w both at zero, and normalizing that is a divide by
    // zero -> NaN quaternions -> a collapsed skeleton. Identity is the right answer: there is no twist.
    if (quat.length(twist) < EPS) return quat.create();
    return quat.normalize(twist, twist);
}

/**
 * Bake a clip in place: remove the root bone's travel so the character animates on the spot and something
 * else (a script, a controller) drives its movement.
 *
 * The counterpart to `Animation.rootMotion`, which does the opposite at runtime — extracts the same delta
 * and applies it to the character. The two are mutually exclusive, so this CLEARS `rootMotion` on its
 * output; a clip carrying both would otherwise have its motion removed twice.
 *
 * The reference pose is the clip SAMPLED AT t = 0, not `output[0]`: a clip whose first key sits at 0.033 s
 * exists, and `Animator._setupRootMotion` uses `bone.sampleTR(0)`, so anything else would disagree with the
 * runtime. Pinning to the bone's REST instead would teleport a clip that legitimately starts crouched.
 *
 * `strip: 'xz'` (the default) keeps the vertical axis. That is what preserves a jump's arc, a crouch, and
 * the bob of a walk cycle; an "in place" clip that also loses its vertical motion reads as a slide.
 *
 * The loop point needs no special handling for translation — keys 0 and N both land on the reference, so a
 * looping clip still loops. Rotation can leave a residual, and that is REPORTED rather than forced: a
 * residual means the source clip does not loop, which is an asset problem, and snapping the last key onto
 * the first would trade a diagnosable warning for a visible pop.
 */
export function bakeInPlace(
    clip: Animation, skin: Skin,
    opts: { strip?: 'xz' | 'all' | 'y'; keepYaw?: boolean; upAxis?: MirrorAxis } = {},
    topo?: SkeletonTopology,
): Animation {
    const t = topoOf(skin, topo);
    const root = rootMotionNodeOf(clip, skin, t);
    if (root === null) {
        warnOnce(clip, 'inplace-no-root', `Cannot bake "${clip.name}" in place: it animates no joint of this rig.`);
        return clip;
    }

    const strip = opts.strip ?? 'xz';
    const up = vec3.create();
    up[AXIS_INDEX[opts.upAxis ?? 'y']] = 1;
    const parent = rootParentRotation(skin, root, t);
    const parentInv = quat.invert(quat.create(), parent);

    const samplers = clip.samplers.map(s => ({ input: s.input.slice(), output: s.output.slice(), interpolation: s.interpolation }));
    const channels = clip.channels.map(c => ({ ...c }));
    let loopResidual = 0;

    for (const ch of channels) {
        if (ch.targetNodeIndex !== root) continue;
        const s = samplers[ch.samplerIndex];
        if (!s || !s.input.length) continue;

        if (ch.targetPath === 'translation') {
            const ref = sampleVec3(s, 0);
            const v = vec3.create();
            for (let k = 0; k * 3 < s.output.length; k++) {
                vec3.set(v, s.output[k * 3] - ref[0], s.output[k * 3 + 1] - ref[1], s.output[k * 3 + 2] - ref[2]);
                vec3.transformQuat(v, v, parent);
                const upComponent = vec3.dot(v, up);
                if (strip === 'all') vec3.set(v, 0, 0, 0);
                else if (strip === 'xz') vec3.scale(v, up, upComponent);        // keep only the vertical part
                else vec3.subtract(v, v, vec3.scale(vec3.create(), up, upComponent)); // 'y': keep only the horizontal
                vec3.transformQuat(v, v, parentInv);
                s.output[k * 3] = ref[0] + v[0];
                s.output[k * 3 + 1] = ref[1] + v[1];
                s.output[k * 3 + 2] = ref[2] + v[2];
            }
        } else if (ch.targetPath === 'rotation' && !opts.keepYaw) {
            const ref = sampleQuat(s, 0);
            const refInv = quat.invert(quat.create(), ref);
            const q = quat.create(), d = quat.create();
            for (let k = 0; k * 4 < s.output.length; k++) {
                quat.set(q, s.output[k * 4], s.output[k * 4 + 1], s.output[k * 4 + 2], s.output[k * 4 + 3]);
                quat.normalize(q, q);
                quat.multiply(d, q, refInv);                       // delta from frame 0, parent frame
                quat.multiply(d, parent, d);
                quat.multiply(d, d, parentInv);                    // ...in model space
                quat.multiply(d, d, quat.invert(quat.create(), twistAbout(d, up))); // drop the yaw
                quat.multiply(d, parentInv, d);
                quat.multiply(d, d, parent);                       // back to the parent frame
                quat.multiply(d, d, ref);
                quat.normalize(d, d);
                s.output[k * 4] = d[0]; s.output[k * 4 + 1] = d[1];
                s.output[k * 4 + 2] = d[2]; s.output[k * 4 + 3] = d[3];
            }
            const n = s.input.length;
            if (n > 1) {
                const first = quat.fromValues(s.output[0], s.output[1], s.output[2], s.output[3]);
                const last = quat.fromValues(s.output[(n - 1) * 4], s.output[(n - 1) * 4 + 1], s.output[(n - 1) * 4 + 2], s.output[(n - 1) * 4 + 3]);
                loopResidual = angleOf(quat.normalize(last, quat.multiply(last, last, quat.invert(quat.create(), first))));
            }
        }
    }

    // Only worth reporting once it would actually drift on screen. Translation needs no such check — keys
    // 0 and N both land on the reference, so it loops by construction — but rotation can leave a residual,
    // and that is REPORTED rather than forced: a residual means the SOURCE clip does not loop, and snapping
    // the last key onto the first would trade a diagnosable warning for a visible pop at the loop point.
    // Plenty of clips legitimately do not loop (a jump, a death), hence a threshold well above ANGLE_EPS.
    if (loopResidual > LOOP_RESIDUAL_EPS) {
        warnOnce(clip, 'inplace-loop',
            `"${clip.name}" ends ${(loopResidual * 180 / Math.PI).toFixed(1)} degrees away from where it ` +
            'started after the in-place bake. Harmless if the clip is not meant to loop; if it is, the source ' +
            'does not, so re-export it or trim it to a whole number of cycles.');
    }

    // `rootMotion` and `inPlace` are the two halves of one decision, so applying this settles it.
    const { rootMotion: _dropped, ...rest } = clip;
    return { ...rest, samplers, channels };
}

// ---------------------------------------------------------------------------
// Pose offset
// ---------------------------------------------------------------------------

/**
 * Add a pose on top of a clip: the feature that makes "hold a torch in all thirty locomotion clips" one
 * decision instead of thirty edits.
 *
 * The pose is an ADDITIVE DELTA in each bone's parent frame, and it is LEFT-multiplied:
 *
 *     A' = slerp(identity, Qp, w) . A          t' = t + w . Tp
 *
 * Left-multiplication is the whole point. In the parent's frame the offset is fixed relative to the
 * shoulder, so "rotate the arm outward by twenty degrees" holds regardless of where the arm is in its
 * swing, and the swing rides on top of it. Right-multiplying would express the offset in the bone's own
 * animated frame, so it would rotate WITH the arm and read as a twist that changes through the cycle.
 *
 * A bone the pose names but the clip never animates gets a NEW channel holding `Qp . Rb` (the offset on
 * the bone's own rest) — with TWO keys, at 0 and at the clip's duration, never one. `Bone._getRotationIndex`
 * returns `length - 2`, which is -1 for a single-key sampler, and a negative index reads undefined out of
 * `output` and poses the bone with NaNs.
 *
 * Adding a channel has a consequence worth knowing: `buildBoneMapping` collects its source bones by
 * scanning the clips, so a new bone joins the mapping — and if the target rig has no counterpart for it,
 * `sameRig` flips from true to false. That switches the whole asset from the exact verbatim-copy path to
 * the bind-delta path, which drops scale channels and every non-hips translation. So masks should default
 * to bones the clip already drives, and adding one it does not should be a deliberate act.
 */
export function applyPoseOffset(
    clip: Animation, skin: Skin, pose: PoseBone[],
    opts: { weight?: number; mask?: string[] } = {}, topo?: SkeletonTopology,
): Animation {
    if (!pose.length) return clip;
    const t = topoOf(skin, topo);
    const weight = Math.max(0, Math.min(1, opts.weight ?? 1));
    if (weight < EPS) return clip;

    const nodeOf = new Map<string, number>();
    const normOf = new Map<string, number>();
    for (const [node, name] of skin.nodeNames ?? []) {
        if (!nodeOf.has(name)) nodeOf.set(name, node);
        const n = normalizeBoneName(name);
        if (!normOf.has(n)) normOf.set(n, node);
    }
    const resolve = (name: string): number | undefined =>
        nodeOf.get(name) ?? normOf.get(normalizeBoneName(name)) ?? humanoidNode(skin, name);

    const allowed = opts.mask?.length ? maskNodes(skin, opts.mask, t) : null;

    // node -> the offset to apply. Resolved up front so a name that matches nothing is reported once.
    const offsets = new Map<number, { rotation?: quat; translation?: vec3 }>();
    const unresolved: string[] = [];
    for (const b of pose) {
        const node = resolve(b.name);
        if (node === undefined) { unresolved.push(b.name); continue; }
        if (allowed && !allowed.has(node)) continue;
        const entry: { rotation?: quat; translation?: vec3 } = {};
        if (b.rotation?.length === 4) {
            const q = quat.normalize(quat.create(), quat.fromValues(b.rotation[0], b.rotation[1], b.rotation[2], b.rotation[3]));
            // Scale the offset by slerping away from identity, not by scaling components: a component
            // scale de-normalizes the quaternion and the bone shears.
            entry.rotation = weight >= 1 - EPS ? q : quat.normalize(q, quat.slerp(quat.create(), quat.create(), q, weight));
        }
        if (b.translation?.length === 3) {
            entry.translation = vec3.scale(vec3.create(), vec3.fromValues(b.translation[0], b.translation[1], b.translation[2]), weight);
        }
        if (entry.rotation || entry.translation) offsets.set(node, entry);
    }
    if (unresolved.length) {
        warnOnce(clip, 'pose-unresolved',
            `A pose applied to "${clip.name}" names ${unresolved.length} bone${unresolved.length === 1 ? '' : 's'} ` +
            `this rig does not have (${unresolved.slice(0, 5).join(', ')}). They were skipped.`);
    }
    if (!offsets.size) return clip;

    const samplers: AnimationSampler[] = [];
    const channels: AnimationChannel[] = [];
    const covered = new Set<string>(); // `${node}:${path}` the clip already drives

    for (const ch of clip.channels) {
        const src = clip.samplers[ch.samplerIndex];
        if (!src) continue;
        covered.add(`${ch.targetNodeIndex}:${ch.targetPath}`);
        const off = offsets.get(ch.targetNodeIndex);
        const stride = STRIDE[ch.targetPath] ?? 1;
        const count = Math.floor(src.output.length / stride);
        let out = src.output.slice();

        if (off?.rotation && ch.targetPath === 'rotation') {
            out = [];
            const q = quat.create();
            for (let k = 0; k < count; k++) {
                quat.set(q, src.output[k * 4], src.output[k * 4 + 1], src.output[k * 4 + 2], src.output[k * 4 + 3]);
                quat.normalize(q, q);
                quat.multiply(q, off.rotation, q);
                quat.normalize(q, q);
                out.push(q[0], q[1], q[2], q[3]);
            }
        } else if (off?.translation && ch.targetPath === 'translation') {
            out = [];
            for (let k = 0; k < count; k++) {
                out.push(src.output[k * 3] + off.translation[0], src.output[k * 3 + 1] + off.translation[1], src.output[k * 3 + 2] + off.translation[2]);
            }
        }

        channels.push({ samplerIndex: samplers.length, targetNodeIndex: ch.targetNodeIndex, targetPath: ch.targetPath });
        samplers.push({ input: src.input.slice(), output: out, interpolation: src.interpolation });
    }

    // Bones the pose moves that the clip never touched: hold the offset for the clip's whole length.
    const duration = clipDuration(clip) || 1;
    for (const [node, off] of offsets) {
        if (off.rotation && !covered.has(`${node}:rotation`)) {
            const q = quat.multiply(quat.create(), off.rotation, localBindRotation(skin, node));
            quat.normalize(q, q);
            channels.push({ samplerIndex: samplers.length, targetNodeIndex: node, targetPath: 'rotation' });
            samplers.push({ input: [0, duration], output: [q[0], q[1], q[2], q[3], q[0], q[1], q[2], q[3]], interpolation: 'LINEAR' });
        }
        if (off.translation && !covered.has(`${node}:translation`)) {
            const r = localRestTranslation(skin, node);
            const v = vec3.add(vec3.create(), r, off.translation);
            channels.push({ samplerIndex: samplers.length, targetNodeIndex: node, targetPath: 'translation' });
            samplers.push({ input: [0, duration], output: [v[0], v[1], v[2], v[0], v[1], v[2]], interpolation: 'LINEAR' });
        }
    }

    return withChannels(clip, samplers, channels);
}

/** A humanoid-slot name (`'foreArm.R'`) resolved to a node, so a pose can be written in slot terms. */
function humanoidNode(skin: Skin, name: string): number | undefined {
    return humanoidRigOf(skin).get(name);
}

/**
 * The nodes a mask selects. An entry is a bone name, a humanoid slot, or the root of a SUBTREE — naming
 * `RightArm` selects the whole arm below it, which is the "pose the arm" gesture rather than "pose one
 * bone and leave the forearm behind".
 */
function maskNodes(skin: Skin, mask: string[], topo: SkeletonTopology): Set<number> {
    const out = new Set<number>();
    const byName = new Map<string, number>();
    const byNorm = new Map<string, number>();
    for (const [node, name] of skin.nodeNames ?? []) {
        if (!byName.has(name)) byName.set(name, node);
        const n = normalizeBoneName(name);
        if (!byNorm.has(n)) byNorm.set(n, node);
    }
    const rig = humanoidRigOf(skin);

    for (const entry of mask) {
        const node = byName.get(entry) ?? byNorm.get(normalizeBoneName(entry)) ?? rig.get(entry);
        if (node === undefined) continue;
        out.add(node);
        const joint = topo.jointOfNode.get(node);
        if (joint === undefined) continue;
        const stack = [joint];
        for (let guard = 0; stack.length && guard < 4096; guard++) {
            const j = stack.pop()!;
            for (const child of topo.children[j] ?? []) { out.add(skin.joints[child].nodeIndex); stack.push(child); }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Trim and retime
// ---------------------------------------------------------------------------

/**
 * Keep only `[start, end]`.
 *
 * Boundary keys are INSERTED by sampling at exactly `start` and `end` rather than by keeping whichever
 * keys happen to fall inside: without them a trim starting between two keys snaps to the earlier one, so
 * the clip visibly jumps at frame 0 by however far the two keys were apart.
 *
 * `rebase` (default true) moves the kept range back to t = 0. Leaving it off keeps the original times,
 * which is what a caller wants when it is going to stitch ranges back together.
 */
export function trimClip(clip: Animation, start: number, end: number, rebase = true): Animation {
    const duration = clipDuration(clip);
    const a = Math.max(0, Math.min(start, duration));
    const b = Math.max(a, Math.min(end, duration));
    if (b - a <= EPS) {
        warnOnce(clip, 'trim-empty', `Trim on "${clip.name}" keeps no time (${a.toFixed(3)}s to ${b.toFixed(3)}s) and was skipped.`);
        return clip;
    }

    const samplers: AnimationSampler[] = [];
    const channels: AnimationChannel[] = [];
    const shift = rebase ? a : 0;

    for (const ch of clip.channels) {
        const src = clip.samplers[ch.samplerIndex];
        if (!src?.input.length) continue;
        const stride = STRIDE[ch.targetPath] ?? 1;
        const isRot = ch.targetPath === 'rotation';
        const input: number[] = [];
        const output: number[] = [];

        const pushSampled = (time: number) => {
            input.push(time - shift);
            if (isRot) { const q = sampleQuat(src, time); output.push(q[0], q[1], q[2], q[3]); }
            else if (stride === 3) { const v = sampleVec3(src, time); output.push(v[0], v[1], v[2]); }
            else { const i = keyIndexAt(src.input, time); for (let c = 0; c < stride; c++) output.push(src.output[i * stride + c]); }
        };

        pushSampled(a);
        for (let k = 0; k < src.input.length; k++) {
            const time = src.input[k];
            if (time <= a + EPS || time >= b - EPS) continue;
            input.push(time - shift);
            for (let c = 0; c < stride; c++) output.push(src.output[k * stride + c]);
        }
        pushSampled(b);

        channels.push({ samplerIndex: samplers.length, targetNodeIndex: ch.targetNodeIndex, targetPath: ch.targetPath });
        samplers.push({ input, output, interpolation: src.interpolation });
    }
    return withChannels(clip, samplers, channels);
}

/**
 * Scale the clip's timing. Values are untouched — only `input` moves — so root-motion speed scales with
 * it, which is what "play this walk 20% slower" means.
 *
 * Duration is derived from the samplers (`Animator._getAnimationDuration`), so nothing else has to be told.
 */
export function timeScaleClip(clip: Animation, scale: number): Animation {
    if (!(scale > EPS) || Math.abs(scale - 1) < EPS) return clip;
    const samplers = clip.samplers.map(s => ({ input: s.input.map(t => t * scale), output: s.output.slice(), interpolation: s.interpolation }));
    return { ...clip, samplers, channels: clip.channels.map(c => ({ ...c })) };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** A rebuilt clip, keeping everything about the original that is not its curves (name, flags, origin). */
function withChannels(clip: Animation, samplers: AnimationSampler[], channels: AnimationChannel[]): Animation {
    return { ...clip, samplers, channels };
}

// Reported problems, keyed by clip name + reason. A clip is re-resolved once per target rig and the
// result is cached, so without this a rig with six characters logs the same line six times on load.
const warned = new Set<string>();

function warnOnce(clip: Animation, reason: string, message: string): void {
    const key = `${clip.name}:${reason}`;
    if (warned.has(key)) return;
    warned.add(key);
    Logger.warn(message, 'Animation');
}

/** Drop the reported-problem memo. For tests, and for a project reload. */
export function resetClipEditWarnings(): void {
    warned.clear();
}

/**
 * Apply a clip's edit stack. The single entry point; everything above is exported for tests and for the
 * editor's Bake command.
 *
 * Returns the SAME OBJECT when there is nothing to do. Object identity is what the resolve cache and
 * `Animator._fieldClip` compare on, so this is the difference between "existing projects are untouched"
 * and "every clip in every project is silently rebuilt on load".
 */
export function applyClipEdits(clip: Animation, edits: ClipEdit[] | undefined | null, ctx: ClipEditContext): Animation {
    if (!edits?.length) return clip;
    const active = edits.filter(e => e.enabled !== false);
    if (!active.length) return clip;

    if (clip.samplers.some(s => s.interpolation === 'CUBICSPLINE')) {
        warnOnce(clip, 'cubicspline',
            `"${clip.name}" has CUBICSPLINE keyframes. The engine plays every sampler as LINEAR, so its edits ` +
            'are computed the same way and will match playback — but neither matches what the file intended.');
    }

    const ordered = [...active].sort((a, b) => EDIT_ORDER[a.kind] - EDIT_ORDER[b.kind]);
    const topo = topoOf(ctx.skin, ctx.topo);
    let out = clip;

    for (const edit of ordered) {
        switch (edit.kind) {
            case 'trim':
                out = trimClip(out, edit.start, edit.end, edit.rebase !== false);
                break;
            case 'mirror':
                out = mirrorClip(out, ctx.skin, edit.axis, topo);
                break;
            case 'poseOffset': {
                // A shared pose provides the base; inline bones override it PER BONE, so a clip can carry
                // a local tweak on top of the rig's "Torch grip" without forking the whole pose.
                const shared = edit.poseId ? ctx.poses?.get(edit.poseId) : undefined;
                if (edit.poseId && !shared) {
                    warnOnce(out, `pose-missing-${edit.poseId}`,
                        `"${out.name}" references a shared pose that no longer exists on its rig, so that offset ` +
                        'was skipped. Re-point or remove it in the clip editor.');
                }
                const merged = new Map<string, PoseBone>();
                for (const b of shared ?? []) merged.set(b.name, b);
                for (const b of edit.bones ?? []) merged.set(b.name, b);
                if (merged.size) out = applyPoseOffset(out, ctx.skin, [...merged.values()], { weight: edit.weight, mask: edit.mask }, topo);
                break;
            }
            case 'inPlace':
                out = bakeInPlace(out, ctx.skin, { strip: edit.strip, keepYaw: edit.keepYaw, upAxis: edit.upAxis }, topo);
                break;
            case 'timeScale': {
                const scale = edit.duration && edit.duration > EPS
                    ? edit.duration / (clipDuration(out) || edit.duration)
                    : (edit.scale ?? 1);
                out = timeScaleClip(out, scale);
                break;
            }
        }
    }
    return out;
}
