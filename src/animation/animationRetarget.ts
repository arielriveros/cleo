import { mat4, quat, vec3 } from 'gl-matrix';
import { Animation, AnimationChannel, AnimationSampler, Skin } from './animatedModel';
import { normalizeBoneName, humanoidSlotOf } from './boneNames';
import { skeletonTopology } from './skeletonTopology';
import { sampleQuat, sampleVec3, unionKeyTimes } from './samplerSample';

// Retargeting an imported animation clip onto a model's skeleton, in three stages so the editor can put
// a mapping review between them: buildBoneMapping, mappingReport, retargetAnimation.
// remapAnimationToSkin runs all three for callers that do not review.
//
// Matching climbs three tiers — exact name, normalized name, humanoid dictionary (boneNames.ts) — and
// every matched rotation is re-expressed through the two rigs' bind-pose difference. A same-rig clip
// skips all of it and is copied raw, which is exact and keeps translation channels.

export interface HierarchyMismatch {
    bone: string;
    sourceParent: string | null;
    targetParent: string | null;
}

export interface AnimationCompatibility {
    clipName: string;
    /** Distinct bones the clip animates. */
    animatedBones: number;
    /** Distinct animated bones that matched a bone in the target skeleton. */
    matchedBones: number;
    /** Animated bones with no counterpart in the target skeleton, and none merged into one (won't play). */
    missingBones: string[];
    /** Exact-matched bones whose parent (by name) differs between the source and target skeleton. */
    hierarchyMismatches: HierarchyMismatch[];
    targetJointCount: number;
    /** Distinct target skeleton joints the (remapped) clip drives. */
    targetCovered: number;
    /** True when at least one bone matched — the clip will play (fully or partially). */
    compatible: boolean;
    matchMode: 'name' | 'index';
}

/** How a source bone was matched to its target. */
export type BoneMatchKind = 'exact' | 'normalized' | 'humanoid' | 'spine' | 'index' | 'manual' | 'none';

export interface BoneMappingEntry {
    sourceNode: number;
    sourceName: string | null;
    targetNode: number | null;
    kind: BoneMatchKind;
    /**
     * Unmapped ON PURPOSE ("don't animate this bone"), as opposed to nothing matching it. A dropped bone is
     * held at rest; an unmapped one that sits between mapped bones is merged into its mapped descendant
     * instead (see {@link retargetSegments}).
     */
    dropped?: boolean;
}

export interface BoneMapping {
    /** One entry per DISTINCT animated source bone, in the order the clips animate them. */
    entries: BoneMappingEntry[];
    /**
     * Every animated bone maps and every correction is identity, so the clip can be copied verbatim.
     * Judged on the corrections, never on name equality.
     */
    sameRig: boolean;
    /** True when both skins carry the rest data the delta retarget needs (names + local rest transforms). */
    canRetarget: boolean;
    matchMode: 'name' | 'index';
    /**
     * `[sourceNode, targetNode]` for source joints NO clip animates that would still match a target joint.
     * They are not entries (nothing to retarget), but they say two bones correspond: a merge never folds
     * across one, and a share never bends its target, which must stay at rest like its source.
     */
    restMatches?: [number, number][];
}

const IDENTITY_EPS = 0.005; // ~0.3°, below which a bind-rotation correction is treated as no correction

function parentOf(skin: Skin, node: number): number | undefined {
    return skin.nodeParents?.get(node);
}

function nameOf(skin: Skin, node: number): string | null {
    return skin.nodeNames?.get(node) ?? null;
}

/** True when a matrix is (within eps) the identity — i.e. an absent / placeholder inverse bind matrix. */
function isIdentityMatrix(m: mat4, eps = 1e-6): boolean {
    const I = mat4.create();
    for (let i = 0; i < 16; i++) if (Math.abs(m[i] - I[i]) > eps) return false;
    return true;
}

// LOCAL bind rotation of a bone — its rest orientation relative to its parent, so a difference stays
// confined to that bone rather than accumulating down the chain. From the IBMs when present
// (`IBM_parent · inverse(IBM_bone)`), else the node's own local transform.
// Exported because `clipEdit.ts` mirrors and bakes clips in the same bind-relative terms, and it must use
// THIS definition — the IBM-first rule and the `$AssimpFbx$` pivot climb below are not reproducible by
// eye, and a second copy that got either wrong would disagree with the retarget only on FBX rigs.
export function localBindRotation(skin: Skin, node: number): quat {
    const joint = skin.joints.find(j => j.nodeIndex === node);
    if (joint && !isIdentityMatrix(joint.inverseBindMatrix as any)) {
        const worldBone = mat4.invert(mat4.create(), joint.inverseBindMatrix as any);
        if (worldBone) {
            // Nearest ancestor JOINT, not the immediate parent node: on an assimp-converted FBX that
            // parent is a `$AssimpFbx$` pivot, and a one-level lookup would return the world bind.
            const parentJoint = ancestorJointOf(skin, node);
            let local: mat4;
            if (parentJoint && !isIdentityMatrix(parentJoint.inverseBindMatrix as any)) {
                // worldParent⁻¹ = IBM_parent, so localBone = IBM_parent · inverse(IBM_bone).
                local = mat4.multiply(mat4.create(), parentJoint.inverseBindMatrix as any, worldBone);
            } else {
                local = worldBone; // a true root: the armature above it is treated as identity
            }
            return quat.normalize(quat.create(), mat4.getRotation(quat.create(), local));
        }
    }
    const nt = skin.nodeTransforms?.get(node);
    return nt ? quat.normalize(quat.create(), mat4.getRotation(quat.create(), nt as any)) : quat.create();
}

/** WORLD bind rotation of a node from `inverse(IBM)` only, or null when it has no usable IBM. For diagnostics. */
function ibmWorldBindRotation(skin: Skin, node: number): quat | null {
    const joint = skin.joints.find(j => j.nodeIndex === node);
    if (!joint || isIdentityMatrix(joint.inverseBindMatrix as any)) return null;
    const w = mat4.invert(mat4.create(), joint.inverseBindMatrix as any);
    return w ? quat.normalize(quat.create(), mat4.getRotation(quat.create(), w)) : null;
}

/** Local rest translation of a node, or [0,0,0]. */
export function localRestTranslation(skin: Skin, node: number): vec3 {
    const nt = skin.nodeTransforms?.get(node);
    return nt ? mat4.getTranslation(vec3.create(), nt as any) : vec3.create();
}

function nearIdentity(q: quat): boolean {
    // A unit quaternion is identity at w = ±1; the rotation half-angle is acos(|w|).
    return Math.acos(Math.min(1, Math.abs(q[3]))) < IDENTITY_EPS;
}

// Per-skin topology cache, keyed on the Skin object, which is fixed once parsed.
const topoCache = new WeakMap<Skin, ReturnType<typeof skeletonTopology>>();
function topoOf(skin: Skin) {
    let t = topoCache.get(skin);
    if (!t) { t = skeletonTopology(skin); topoCache.set(skin, t); }
    return t;
}

// The nearest ANCESTOR JOINT of a node, climbing through non-joint nodes in between, or undefined.
function ancestorJointOf(skin: Skin, node: number) {
    const topo = topoOf(skin);
    const jointIndex = topo.jointOfNode.get(node);
    if (jointIndex === undefined) return undefined;
    const parent = topo.parentJoint[jointIndex];
    return parent >= 0 ? skin.joints[parent] : undefined;
}

/** Root joints of a skin: a joint with no ancestor joint above it. */
function isRootJoint(skin: Skin, node: number): boolean {
    const topo = topoOf(skin);
    const jointIndex = topo.jointOfNode.get(node);
    if (jointIndex === undefined) return true;
    // `parentJoint < 0` means no JOINT above it; pivots and armature nodes do not make a bone a root.
    return topo.parentJoint[jointIndex] < 0;
}

/** The target skeleton's hips node: the humanoid 'hips' bone if named, else the first root joint. */
function hipsNodeOf(skin: Skin): number | null {
    if (skin.nodeNames) {
        for (const j of skin.joints) {
            const nm = skin.nodeNames.get(j.nodeIndex);
            if (nm && humanoidSlotOf(nm) === 'hips') return j.nodeIndex;
        }
    }
    const root = skin.joints.find(j => isRootJoint(skin, j.nodeIndex));
    return root ? root.nodeIndex : null;
}

/** The target bone the source's hips is mapped onto, when the mapping names one: a hand-mapped custom
 *  skeleton's hips (`hips_01`), which its own names cannot identify, rather than its first root joint. */
function mappedHipsOf(mapping: BoneMapping, sourceSkin: Skin): number | null {
    const srcHips = sourceSkin.nodeNames ? hipsNodeOf(sourceSkin) : null;
    if (srcHips === null) return null;
    const e = mapping.entries.find(x => x.sourceNode === srcHips);
    return e && e.targetNode !== null && !e.dropped ? e.targetNode : null;
}

// The spine chain of a skin: joints strictly between hips and neck, hips-side first, so two rigs can be
// paired by ORDER — spine naming is irreconcilable across conventions. [] when either end is missing.
function spineChain(skin: Skin): number[] {
    const hips = hipsNodeOf(skin);
    let neck: number | null = null;
    if (skin.nodeNames) {
        for (const j of skin.joints) {
            const nm = skin.nodeNames.get(j.nodeIndex);
            if (nm && humanoidSlotOf(nm) === 'neck') { neck = j.nodeIndex; break; }
        }
    }
    if (hips === null || neck === null) return [];
    // Walk up from neck's parent to hips, collecting the joints in between.
    const chain: number[] = [];
    let n = parentOf(skin, neck);
    const jointNodes = new Set(skin.joints.map(j => j.nodeIndex));
    for (let guard = 0; n !== undefined && n !== hips && guard < 64; guard++) {
        if (jointNodes.has(n)) chain.push(n);
        n = parentOf(skin, n);
    }
    if (n !== hips) return []; // neck did not descend from hips through the joints — give up
    chain.reverse(); // hips-side first
    return chain;
}

/**
 * Match every animated source bone to a target joint. Exact name beats normalized beats humanoid; the spine
 * is paired positionally on top of that. Falls back to matching by node index when either skin has no names.
 */
export function buildBoneMapping(clips: Animation[], sourceSkin: Skin, targetSkin: Skin): BoneMapping {
    const haveNames = !!(sourceSkin.nodeNames?.size && targetSkin.nodeNames?.size);
    const matchMode: 'name' | 'index' = haveNames ? 'name' : 'index';
    const canRetarget = matchMode === 'name' && !!sourceSkin.nodeTransforms && !!targetSkin.nodeTransforms;

    const targetJointNodes = new Set(targetSkin.joints.map(j => j.nodeIndex));

    // Most specific first, and first writer wins, so a normalized collision cannot shadow an exact name.
    const byExact = new Map<string, number>();
    const byNormalized = new Map<string, number>();
    const byHumanoid = new Map<string, number>();
    if (haveNames) {
        for (const j of targetSkin.joints) {
            const nm = targetSkin.nodeNames!.get(j.nodeIndex);
            if (!nm) continue;
            if (!byExact.has(nm)) byExact.set(nm, j.nodeIndex);
            const norm = normalizeBoneName(nm);
            if (!byNormalized.has(norm)) byNormalized.set(norm, j.nodeIndex);
            const slot = humanoidSlotOf(nm);
            if (slot && !byHumanoid.has(slot)) byHumanoid.set(slot, j.nodeIndex);
        }
        // Non-joint nodes (assimp `$AssimpFbx$` pivots carry rotation curves) by EXACT name only, and
        // only where no joint claimed it: normalizing would let a pivot capture its own bone's slot.
        for (const [nodeIndex, nm] of targetSkin.nodeNames!) {
            if (targetJointNodes.has(nodeIndex) || !nm) continue;
            if (!byExact.has(nm)) byExact.set(nm, nodeIndex);
        }
    }

    // Distinct animated source bones, in first-seen order.
    const animatedNodes: number[] = [];
    const seen = new Set<number>();
    for (const clip of clips) for (const ch of clip.channels) {
        if (!seen.has(ch.targetNodeIndex)) { seen.add(ch.targetNodeIndex); animatedNodes.push(ch.targetNodeIndex); }
    }

    const matchOne = (node: number): { targetNode: number | null; kind: BoneMatchKind } => {
        if (!haveNames) {
            return targetJointNodes.has(node) ? { targetNode: node, kind: 'index' } : { targetNode: null, kind: 'none' };
        }
        const nm = nameOf(sourceSkin, node);
        if (!nm) return { targetNode: null, kind: 'none' };
        const exact = byExact.get(nm);
        if (exact !== undefined) return { targetNode: exact, kind: 'exact' };
        const norm = byNormalized.get(normalizeBoneName(nm));
        if (norm !== undefined) return { targetNode: norm, kind: 'normalized' };
        const slot = humanoidSlotOf(nm);
        if (slot) { const h = byHumanoid.get(slot); if (h !== undefined) return { targetNode: h, kind: 'humanoid' }; }
        return { targetNode: null, kind: 'none' };
    };

    const entries: BoneMappingEntry[] = animatedNodes.map(node => {
        const { targetNode, kind } = matchOne(node);
        return { sourceNode: node, sourceName: nameOf(sourceSkin, node), targetNode, kind };
    });

    // The same match for every joint NO clip animates: see `restMatches`.
    const rest = new Map<number, number>();
    for (const j of sourceSkin.joints) {
        if (seen.has(j.nodeIndex)) continue;
        const { targetNode } = matchOne(j.nodeIndex);
        if (targetNode !== null) rest.set(j.nodeIndex, targetNode);
    }

    // Spine: pair the two chains positionally, overriding whatever the tiers guessed for those bones.
    // Several source bones landing on one target is fine: they are merged (see retargetSegments).
    if (haveNames) {
        const srcSpine = spineChain(sourceSkin);
        const tgtSpine = spineChain(targetSkin);
        if (srcSpine.length && tgtSpine.length) {
            const byNode = new Map(entries.map(e => [e.sourceNode, e] as const));
            for (let i = 0; i < srcSpine.length; i++) {
                // Distribute source index across the target chain length.
                const ti = srcSpine.length === 1 ? 0 : Math.round((i * (tgtSpine.length - 1)) / (srcSpine.length - 1));
                const target = tgtSpine[Math.min(ti, tgtSpine.length - 1)];
                const e = byNode.get(srcSpine[i]);
                if (e) { e.targetNode = target; e.kind = 'spine'; }
                else rest.set(srcSpine[i], target);
            }
        }
    }
    const restMatches = [...rest.entries()];

    // sameRig: every bone maps, every correction (both factors) is identity, and rest proportions match.
    // Judged on the binds, never on names — a renamed namespace is still the same skeleton.
    let sameRig = canRetarget && entries.length > 0 && entries.every(e => e.targetNode !== null);
    if (sameRig) {
        for (const e of entries) {
            if (e.targetNode === null) { sameRig = false; break; }
            const corr = boneCorrection(sourceSkin, e.sourceNode, targetSkin, e.targetNode);
            const ts = localRestTranslation(sourceSkin, e.sourceNode);
            const tt = localRestTranslation(targetSkin, e.targetNode);
            const post = segmentPost(sourceSkin, [e.sourceNode], targetSkin, e.targetNode);
            if (!nearIdentity(corr) || post || vec3.squaredDistance(ts, tt) > 1e-6) { sameRig = false; break; }
        }
    }

    return { entries, sameRig, canRetarget, matchMode, ...(restMatches.length ? { restMatches } : {}) };
}

// WORLD rotation of a node's ARMATURE: the accumulated rest rotation of every ancestor above it.
// Only valid for a TRUE root joint — an assimp pivot's node transform is a frame-0 pose, not a rest one.
function armatureWorldRotation(skin: Skin, node: number): quat {
    const chain: number[] = [];
    let n = parentOf(skin, node);
    for (let guard = 0; n !== undefined && guard < 256; guard++) { chain.push(n); n = parentOf(skin, n); }
    const q = quat.create();
    const r = quat.create();
    for (let i = chain.length - 1; i >= 0; i--) { // topmost ancestor first
        const nt = skin.nodeTransforms?.get(chain[i]);
        if (!nt) continue;
        mat4.getRotation(r, nt as any);
        quat.normalize(r, r);
        quat.multiply(q, q, r);
    }
    return quat.normalize(q, q);
}

/**
 * The world rotation of the frame a non-root joint is posed in: its parent joint's bind, from that joint's
 * inverse bind matrix (which already carries the armature above it). Falls back to the node chain's rest
 * when the parent has no usable bind.
 */
function parentFrameRotation(skin: Skin, node: number, pose?: RetargetPose): quat {
    const parent = ancestorJointOf(skin, node);
    const aligned = parent ? pose?.world.get(parent.nodeIndex) : undefined;
    if (aligned) return quat.clone(aligned);
    if (parent && !isIdentityMatrix(parent.inverseBindMatrix as any)) {
        const world = mat4.invert(mat4.create(), parent.inverseBindMatrix as any);
        if (world) return quat.normalize(quat.create(), mat4.getRotation(quat.create(), world));
    }
    return armatureWorldRotation(skin, node);
}

// The left factor of a matched bone's retarget, `At = corr · As · post` (see segmentPost for `post`): a
// non-joint node (assimp pivot) copies through; a non-root source with no usable IBM copies through;
// otherwise the parent frames' difference `Pt⁻¹ · Ps` (the armature's, for a root).
function boneCorrection(sourceSkin: Skin, sNode: number, targetSkin: Skin, tNode: number): quat {
    return segmentCorrection(sourceSkin, [sNode], targetSkin, tNode);
}

// The same for a SEGMENT: a chain of source bones (top first) driving one target bone as if it were one bone,
// `At = corr · (A1·A2·…) · post`, bridging the frame above the segment's first bone; a one-bone segment is
// exactly {@link boneCorrection}.
function segmentCorrection(sourceSkin: Skin, segment: number[], targetSkin: Skin, tNode: number, pose?: RetargetPose): quat {
    // A pivot has no inverse bind matrix on EITHER side, so there is no rest to delta against, and
    // `nodeTransforms` is frame 0 for an animation-only file. This makes the armature branch below
    // unreachable for a converted FBX, which only matters cross-rig.
    if (!topoOf(targetSkin).jointOfNode.has(tNode)) return quat.create();

    // The frame each side's bone is posed in: the armature for a root, its parent joint's bind otherwise.
    // When ONE side is a root and the other is not (a Sketchfab export puts a `_rootJoint` above Mixamo's
    // hips, so its hips is a child joint while the mannequin's is the root), the local-bind delta below
    // compares a bone posed under a Z-up armature with one posed under a Y-up parent, and the character
    // lies down. Their parent frames' world rotations are what must be bridged instead.
    //
    // Every bone, root or not, bridges its parent frames, `Pt⁻¹ · Ps`, and {@link segmentPost} its own:
    // the motion is carried relative to each side's bind. (This used to be the local-bind delta
    // `Bt · Bs⁻¹` for a non-root bone, which is the same thing only when both rigs point their bone axes
    // alike, and wrong for a custom skeleton.)
    const sourceRoot = isRootJoint(sourceSkin, segment[0]);
    const targetRoot = isRootJoint(targetSkin, tNode);
    const end = segment[segment.length - 1];
    const sJoint = sourceSkin.joints.find(j => j.nodeIndex === end);
    // No source bind on a non-root bone: nothing to bridge against, so the curve copies through raw.
    if (!sourceRoot && !targetRoot && (!sJoint || isIdentityMatrix(sJoint.inverseBindMatrix as any))) return quat.create();
    const ps = sourceRoot ? armatureWorldRotation(sourceSkin, segment[0]) : parentFrameRotation(sourceSkin, segment[0]);
    const pt = targetRoot ? armatureWorldRotation(targetSkin, tNode) : parentFrameRotation(targetSkin, tNode, pose);
    return quat.normalize(quat.create(), quat.multiply(quat.create(), quat.invert(quat.create(), pt), ps));
}

/**
 * The right-hand factor of a correction, `At = corr · As · post`, or null when it is the identity.
 *
 * `corr` bridges the PARENT frames; `post` bridges the bones' own: the turn from the source bone's bind
 * frame to the target's, both in model space (the target's as {@link retargetPose} aligned it). Together
 * they carry the source's motion relative to its bind onto the target's bind, `Wt = Ws · Bws⁻¹ · Bwt`,
 * whatever way each skeleton points its bone axes. Two rigs whose bones share their axes (Mixamo onto
 * Mixamo, Mixamo onto Unreal in the same pose) get the identity, which the left factor alone always
 * handled. A custom skeleton does not: the Valley's Elite Knight runs every bone's local Z down the limb
 * where Mixamo runs Y, mirrored left to right, and without this its hips laid it down and its arms rose.
 */
function segmentPost(sourceSkin: Skin, segment: number[], targetSkin: Skin, tNode: number, pose?: RetargetPose): quat | null {
    if (!topoOf(targetSkin).jointOfNode.has(tNode)) return null;
    const ws = bindWorldOf(sourceSkin, segment[segment.length - 1]);
    const wt = pose?.world.get(tNode) ?? (() => { const m = bindWorldOf(targetSkin, tNode); return m ? pureRotation(m) : null; })();
    if (!ws || !wt) return null;
    const post = quat.multiply(quat.create(), quat.invert(quat.create(), pureRotation(ws)), wt);
    quat.normalize(post, post);
    return nearIdentity(post) ? null : post;
}

/** A matrix's rotation with its (possibly non-unit) scale divided out. */
function pureRotation(m: mat4): quat {
    const s = mat4.getScaling(vec3.create(), m);
    const pure = mat4.clone(m);
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) pure[c * 4 + k] /= s[c] || 1;
    return quat.normalize(quat.create(), mat4.getRotation(quat.create(), pure));
}

/**
 * The target skeleton re-posed to the SOURCE's bind pose, limb by limb: what the corrections are taken
 * against when the two rigs were bound in different poses.
 *
 * The local-bind delta `Bt·Bs⁻¹` re-applies the source's motion relative to the TARGET's bind. That is right
 * when both were bound in the same pose with different bone axes (a Mixamo T-pose onto an Unreal one), and
 * wrong when they share bone axes but not the pose: an arm the clip lowers 90° from a T-pose was lowered 90°
 * from an A-pose bind as well, 135° in all, into the chest. So each sided limb bone of the target is first
 * turned, by the shortest arc, until it points where its source bone points at the source's bind (the
 * direction to its driven children), with its parent's turn carried down the chain. Same-pose rigs come
 * out unchanged. Centre bones (hips, spine, neck, head) are not turned.
 *
 * `local` / `world`: per target joint node, the aligned local and model-space rest rotations.
 */
export interface RetargetPose { local: Map<number, quat>; world: Map<number, quat> }

function bindWorldOf(skin: Skin, node: number): mat4 | null {
    const joint = skin.joints.find(j => j.nodeIndex === node);
    if (!joint || isIdentityMatrix(joint.inverseBindMatrix as any)) return null;
    return mat4.invert(mat4.create(), joint.inverseBindMatrix as any);
}

export function retargetPose(sourceSkin: Skin, targetSkin: Skin, plan: RetargetPlan, mapping?: BoneMapping): RetargetPose {
    const topo = topoOf(targetSkin);
    const local = new Map<number, quat>(), world = new Map<number, quat>();
    // Driven target node -> the source bone it is mapped from (its segment's end).
    const sourceOf = new Map<number, number>();
    for (const [t, seg] of plan.segments) sourceOf.set(t, seg[seg.length - 1]);
    // Bones no clip animates still say where a limb points (a hand's fingers, an arm's forearm).
    for (const [s, t] of mapping?.restMatches ?? []) if (!sourceOf.has(t)) sourceOf.set(t, s);
    const posOf = (skin: Skin, node: number): vec3 | null => {
        const w = bindWorldOf(skin, node);
        return w ? mat4.getTranslation(vec3.create(), w) : null;
    };
    const turnOf = new Map<number, quat>();
    for (const ji of topo.order) {
        const node = targetSkin.joints[ji].nodeIndex;
        const w = bindWorldOf(targetSkin, node);
        if (!w) continue;
        const pj = topo.parentJoint[ji];
        const parentNode = pj >= 0 ? targetSkin.joints[pj].nodeIndex : undefined;
        let turn = parentNode !== undefined ? quat.clone(turnOf.get(parentNode) ?? quat.create()) : quat.create();

        const src = sourceOf.get(node);
        // A sided limb by its own name, or, for a custom-named skeleton mapped by hand, by the source bone
        // mapped onto it (`L_arm_015` reads as nothing; the mannequin's LeftArm driving it says it is one).
        const name = targetSkin.nodeNames?.get(node) ?? '';
        const srcName = src !== undefined ? sourceSkin.nodeNames?.get(src) ?? '' : '';
        if (src !== undefined && (humanoidSlotOf(name) ?? humanoidSlotOf(srcName) ?? '').includes('.')) {
            // The bone's direction: towards its driven children (the fingers' average, for a hand), on both
            // sides, the target's already carrying its parent's turn.
            const here = posOf(targetSkin, node), hereS = posOf(sourceSkin, src);
            const dt = vec3.create(), ds = vec3.create();
            if (here && hereS) for (const cj of topo.children[ji]) {
                const child = targetSkin.joints[cj].nodeIndex;
                const childSrc = sourceOf.get(child);
                const pt = posOf(targetSkin, child), ps = childSrc !== undefined ? posOf(sourceSkin, childSrc) : null;
                if (!pt || !ps) continue;
                vec3.add(dt, dt, vec3.normalize(vec3.create(), vec3.sub(vec3.create(), pt, here)));
                vec3.add(ds, ds, vec3.normalize(vec3.create(), vec3.sub(vec3.create(), ps, hereS)));
            }
            if (vec3.length(dt) > 1e-6 && vec3.length(ds) > 1e-6) {
                vec3.transformQuat(dt, vec3.normalize(dt, dt), turn);
                const extra = quat.rotationTo(quat.create(), dt, vec3.normalize(ds, ds));
                turn = quat.normalize(quat.create(), quat.multiply(quat.create(), extra, turn));
            }
        }
        turnOf.set(node, turn);

        const rest = quat.normalize(quat.create(), mat4.getRotation(quat.create(), w));
        const aligned = quat.normalize(quat.create(), quat.multiply(quat.create(), turn, rest));
        world.set(node, aligned);
        const parentWorld = parentNode !== undefined ? world.get(parentNode) : undefined;
        local.set(node, parentWorld
            ? quat.normalize(quat.create(), quat.multiply(quat.create(), quat.invert(quat.create(), parentWorld), aligned))
            : localBindRotation(targetSkin, node));
    }
    return { local, world };
}

/** A node's local rest rotation from its node transform, or identity. */
function restRotation(skin: Skin, node: number): quat {
    const nt = skin.nodeTransforms?.get(node);
    return nt ? quat.normalize(quat.create(), mat4.getRotation(quat.create(), nt as any)) : quat.create();
}

// ---------------------------------------------------------------------------------------------------
// Segments: what to do when the two skeletons do not match bone for bone.
//
// Each driven target bone is fed by a SEGMENT of source bones: the source bone mapped to it (the deepest one,
// when several are) plus every source ancestor up to, not including, the nearest one that drives a
// DIFFERENT target bone. Composing the segment as one bone is exact: the target bone's parent corresponds to
// that ancestor, so it must absorb everything in between.
//
//  - MERGE: several source bones mapped to one target (a 3-bone spine onto 2), or an unmapped source bone
//    between mapped ones (a clavicle the target has no counterpart for), compose into one rotation instead
//    of the last one winning or the bone's bend being lost.
//  - SHARE: a target bone nothing drives, sitting in a single chain between two driven bones (a 2-bone spine
//    onto 3), takes an even share of the bend below it instead of staying rigid.
//  - Everything else is left alone: a source leaf with nowhere to go is dropped, and a target bone outside
//    any driven chain (twist, prop, face) holds its rest pose.
// ---------------------------------------------------------------------------------------------------

export interface RetargetPlan {
    /** Driven target node -> its source segment, top first (the mapped end bone last). */
    segments: Map<number, number[]>;
    /** Driven target node -> undriven target joints directly above it that share its bend, top first. */
    shares: Map<number, number[]>;
    /** Animated source node -> the target node its motion reaches (directly, or merged into a segment). */
    contributions: Map<number, number>;
}

/** Bones a share must never bend: they twist or steer, they do not carry a chain's curve. */
const NO_SHARE = /twist|roll|helper|corrective|pole|(^|[_:.\s])ik([_:.\s]|$)|nub|end$/i;

/**
 * How a mapping drives the target: its segments, shares and per-source contributions. The retarget runs on
 * this; the editor colours bones from it. A raw (same-skeleton or index) mapping is one bone per segment.
 */
export function retargetSegments(mapping: BoneMapping, sourceSkin: Skin, targetSkin: Skin): RetargetPlan {
    const segments = new Map<number, number[]>();
    const shares = new Map<number, number[]>();
    const contributions = new Map<number, number>();
    const byNode = new Map(mapping.entries.map(e => [e.sourceNode, e] as const));
    const raw = mapping.sameRig || !mapping.canRetarget;

    const groups = new Map<number, number[]>();
    for (const e of mapping.entries) {
        if (e.targetNode === null) continue;
        let g = groups.get(e.targetNode);
        if (!g) { g = []; groups.set(e.targetNode, g); }
        g.push(e.sourceNode);
    }
    if (raw) {
        for (const [t, g] of groups) { segments.set(t, [g[g.length - 1]]); for (const s of g) contributions.set(s, t); }
        return { segments, shares, contributions };
    }

    const sTopo = topoOf(sourceSkin);
    const tTopo = topoOf(targetSkin);
    const restSource = new Map(mapping.restMatches ?? []);
    const restTargets = new Set((mapping.restMatches ?? []).map(([, t]) => t));
    const depth = (node: number) => {
        let d = 0;
        for (let j = sTopo.jointOfNode.get(node) ?? -1; j >= 0 && d < 256; j = sTopo.parentJoint[j]) d++;
        return d;
    };
    // A static bone (not animated, or dropped on purpose) holds its rest. Where the rest IS its bind it
    // cancels out of a segment exactly, so it only has to be composed when it sits between animated members.
    const isStatic = (node: number) => { const e = byNode.get(node); return !e || !!e.dropped; };
    const restIsBind = (node: number) => {
        const d = quat.multiply(quat.create(), quat.invert(quat.create(), localBindRotation(sourceSkin, node)), restRotation(sourceSkin, node));
        return nearIdentity(quat.normalize(d, d));
    };

    for (const [t, group] of groups) {
        // The deepest mapped source bone ends the segment; another one off its ancestor path is ignored.
        const end = group.reduce((a, b) => (depth(b) > depth(a) ? b : a));
        const chain: number[] = [end];
        const endJoint = sTopo.jointOfNode.get(end);
        if (tTopo.jointOfNode.has(t) && endJoint !== undefined) {
            let jointIdx: number = endJoint;
            for (let guard = 0; guard < 16; guard++) {
                const pj: number = sTopo.parentJoint[jointIdx];
                if (pj < 0) break;
                const pNode = sourceSkin.joints[pj].nodeIndex;
                // A non-joint node in between (an FBX pivot) has its own curves and binds: do not compose across it.
                if (parentOf(sourceSkin, chain[0]) !== pNode) break;
                const pe = byNode.get(pNode);
                if (pe && pe.targetNode !== null && pe.targetNode !== t) break; // drives another bone: the frame
                if (!pe && restSource.has(pNode)) break;                        // corresponds to a static target bone
                chain.unshift(pNode);
                jointIdx = pj;
            }
        }
        // Keep from the topmost bone that must be composed: an animated one, or a static one whose rest is not
        // its bind. Static bones above it cancel exactly and are trimmed, so a matched rig stays one bone.
        let top = chain.length - 1;
        for (let i = 0; i < chain.length - 1; i++) {
            if (!isStatic(chain[i]) || !restIsBind(chain[i])) { top = i; break; }
        }
        const segment = chain.slice(top);
        segments.set(t, segment);
        for (const n of segment) if (!isStatic(n)) contributions.set(n, t);
    }

    // Shares: undriven, unbranched target joints directly above a driven one, bounded by a driven ancestor.
    const driven = new Set(segments.keys());
    for (const t of driven) {
        const ti = tTopo.jointOfNode.get(t);
        if (ti === undefined) continue;
        const gap: number[] = [];
        let child = t;
        let pj = tTopo.parentJoint[ti];
        let ok = true;
        while (pj >= 0 && gap.length <= 3) {
            const pNode = targetSkin.joints[pj].nodeIndex;
            if (parentOf(targetSkin, child) !== pNode) { ok = false; break; } // a pivot in between
            if (driven.has(pNode)) break;
            const name = nameOf(targetSkin, pNode) ?? '';
            if (restTargets.has(pNode) || NO_SHARE.test(name) || tTopo.children[pj].length !== 1) { ok = false; break; }
            gap.unshift(pNode);
            child = pNode;
            pj = tTopo.parentJoint[pj];
        }
        if (ok && gap.length && gap.length <= 3 && pj >= 0 && driven.has(targetSkin.joints[pj].nodeIndex)) shares.set(t, gap);
    }
    return { segments, shares, contributions };
}

/** Return a copy of `mapping` with one source bone re-pointed (or unmapped when targetNode is null). */
export function applyManualMapping(mapping: BoneMapping, sourceNode: number, targetNode: number | null): BoneMapping {
    const entries = mapping.entries.map(e => {
        if (e.sourceNode !== sourceNode) return e;
        const { dropped: _d, ...rest } = e;
        return targetNode === null
            ? { ...rest, targetNode, kind: 'none' as BoneMatchKind, dropped: true }
            : { ...rest, targetNode, kind: 'manual' as BoneMatchKind };
    });
    // A manual edit means the rigs are being treated as different: drop the raw fast path, or the
    // override would be ignored entirely.
    return { ...mapping, entries, sameRig: false };
}

/** Cheap per-clip report from a mapping — set math only, safe to re-run on every dropdown change. */
export function mappingReport(
    clip: Animation, sourceSkin: Skin, targetSkin: Skin, mapping: BoneMapping,
): AnimationCompatibility {
    const byNode = new Map(mapping.entries.map(e => [e.sourceNode, e] as const));
    // A bone merged into a segment plays too, through its mapped descendant: it is not missing.
    const reach = retargetSegments(mapping, sourceSkin, targetSkin).contributions;
    const animated = new Set<string>();
    const matched = new Set<string>();
    const missing = new Set<string>();
    const covered = new Set<number>();
    const hierarchy: HierarchyMismatch[] = [];
    const hierarchyChecked = new Set<number>();

    for (const ch of clip.channels) {
        const e = byNode.get(ch.targetNodeIndex);
        const label = nameOf(sourceSkin, ch.targetNodeIndex) ?? `node ${ch.targetNodeIndex}`;
        animated.add(label);
        if (e && e.targetNode !== null) {
            matched.add(label);
            covered.add(e.targetNode);
            // Only meaningful for an exact match: a humanoid match crosses conventions by design.
            if (e.kind === 'exact' && !hierarchyChecked.has(ch.targetNodeIndex)) {
                hierarchyChecked.add(ch.targetNodeIndex);
                const sp = parentName(sourceSkin, ch.targetNodeIndex);
                const tp = parentName(targetSkin, e.targetNode);
                if (sp !== null && tp !== null && sp !== tp) hierarchy.push({ bone: label, sourceParent: sp, targetParent: tp });
            }
        } else if (reach.has(ch.targetNodeIndex)) {
            matched.add(label);
            covered.add(reach.get(ch.targetNodeIndex)!);
        } else missing.add(label);
    }

    return {
        clipName: clip.name,
        animatedBones: animated.size,
        matchedBones: matched.size,
        missingBones: [...missing],
        hierarchyMismatches: hierarchy,
        targetJointCount: targetSkin.joints.length,
        targetCovered: covered.size,
        compatible: matched.size > 0,
        matchMode: mapping.matchMode,
    };
}

function parentName(skin: Skin, node: number): string | null {
    const p = parentOf(skin, node);
    if (p === undefined) return null;
    return nameOf(skin, p);
}

/**
 * Rebuild a clip's samplers so it drives the target skeleton. `mapping.sameRig` copies verbatim; otherwise
 * rotations go through the local bind delta (`At = Bt·Bs⁻¹·As`) and non-hips translation/scale is dropped.
 * Mismatched skeletons are handled by {@link retargetSegments}: merged source chains compose into one
 * rotation, and undriven target bones between driven ones take a share of the bend.
 */
export function retargetAnimation(
    clip: Animation, sourceSkin: Skin, targetSkin: Skin, mapping: BoneMapping,
): Animation {
    const byNode = new Map(mapping.entries.map(e => [e.sourceNode, e] as const));
    const raw = mapping.sameRig || !mapping.canRetarget;

    const outSamplers: AnimationSampler[] = clip.samplers.slice();
    const outChannels: AnimationChannel[] = [];
    const addSampler = (input: number[], output: number[], interpolation: AnimationSampler['interpolation']) =>
        (outSamplers.push({ input, output, interpolation }), outSamplers.length - 1);

    if (raw) {
        for (const ch of clip.channels) {
            const e = byNode.get(ch.targetNodeIndex);
            if (!e || e.targetNode === null) continue; // unmatched: dropped
            outChannels.push({ samplerIndex: ch.samplerIndex, targetNodeIndex: e.targetNode, targetPath: ch.targetPath });
        }
        return finishClip(clip, outSamplers, outChannels);
    }

    const plan = retargetSegments(mapping, sourceSkin, targetSkin);
    const pose = retargetPose(sourceSkin, targetSkin, plan, mapping);
    const hipsTarget = mappedHipsOf(mapping, sourceSkin) ?? hipsNodeOf(targetSkin);

    // This clip's curves, by source node.
    const rotOf = new Map<number, AnimationSampler>();
    const posOf = new Map<number, AnimationSampler>();
    for (const ch of clip.channels) {
        const smp = clip.samplers[ch.samplerIndex];
        if (!smp) continue;
        if (ch.targetPath === 'rotation' && !rotOf.has(ch.targetNodeIndex)) rotOf.set(ch.targetNodeIndex, smp);
        else if (ch.targetPath === 'translation' && !posOf.has(ch.targetNodeIndex)) posOf.set(ch.targetNodeIndex, smp);
    }
    const dropped = (n: number) => !!byNode.get(n)?.dropped;
    const rotAt = (n: number, t: number, out: quat) => {
        const s = dropped(n) ? undefined : rotOf.get(n);
        return s ? sampleQuat(s, t, out) : quat.copy(out, restRotation(sourceSkin, n));
    };
    const posAt = (n: number, t: number, out: vec3) => {
        const s = dropped(n) ? undefined : posOf.get(n);
        return s ? sampleVec3(s, t, out) : vec3.copy(out, localRestTranslation(sourceSkin, n));
    };

    // Rotation curves emitted per target node, kept so the share pass can split them.
    const rotOut = new Map<number, { input: number[]; output: number[]; channel: AnimationChannel }>();

    for (const [tgt, segment] of plan.segments) {
        const corr = segmentCorrection(sourceSkin, segment, targetSkin, tgt, pose);
        const post = segmentPost(sourceSkin, segment, targetSkin, tgt, pose);
        const end = segment[segment.length - 1];

        // ---- rotation: At = corr · (A1·A2·…) · post. A one-bone segment keeps its own keys and interpolation.
        const rotSamplers = segment.map(n => (dropped(n) ? undefined : rotOf.get(n))).filter((s): s is AnimationSampler => !!s);
        if (rotSamplers.length) {
            const single = segment.length === 1;
            const input = single ? rotSamplers[0].input.slice() : unionKeyTimes(rotSamplers);
            const out: number[] = [];
            const q = quat.create();
            const m = quat.create();
            if (single) {
                const src = rotSamplers[0];
                for (let k = 0; k * 4 < src.output.length; k++) {
                    quat.set(q, src.output[k * 4], src.output[k * 4 + 1], src.output[k * 4 + 2], src.output[k * 4 + 3]);
                    quat.normalize(q, q);
                    quat.normalize(q, quat.multiply(q, corr, q));
                    if (post) quat.normalize(q, quat.multiply(q, q, post));
                    out.push(q[0], q[1], q[2], q[3]);
                }
            } else {
                for (const t of input) {
                    quat.identity(q);
                    for (const n of segment) quat.multiply(q, q, rotAt(n, t, m));
                    quat.normalize(q, quat.multiply(q, corr, quat.normalize(q, q)));
                    if (post) quat.normalize(q, quat.multiply(q, q, post));
                    out.push(q[0], q[1], q[2], q[3]);
                }
            }
            const interpolation = single ? rotSamplers[0].interpolation : 'LINEAR';
            const channel: AnimationChannel = { samplerIndex: addSampler(input, out, interpolation), targetNodeIndex: tgt, targetPath: 'rotation' };
            outChannels.push(channel);
            rotOut.set(tgt, { input, output: out, channel });
        }

        // ---- translation: only the hips carries it (root motion); every other bone keeps its rest length.
        if (tgt !== hipsTarget) continue;
        const posSamplers = segment.map(n => (dropped(n) ? undefined : posOf.get(n))).filter((s): s is AnimationSampler => !!s);
        if (!posSamplers.length) continue;
        // The segment's END position relative to the segment's parent, and the same at rest.
        const chainPos = (t: number | null, out: vec3) => {
            const r = quat.create();
            const a = quat.create();
            const v = vec3.create();
            vec3.set(out, 0, 0, 0);
            for (const n of segment) {
                if (t === null) vec3.copy(v, localRestTranslation(sourceSkin, n));
                else posAt(n, t, v);
                vec3.add(out, out, vec3.transformQuat(v, v, r));
                quat.multiply(r, r, t === null ? restRotation(sourceSkin, n) : rotAt(n, t, a));
            }
            return out;
        };
        const tsRest = segment.length === 1 ? localRestTranslation(sourceSkin, end) : chainPos(null, vec3.create());
        const ttRest = localRestTranslation(targetSkin, tgt);
        // The hips ratio is measured in the SAME SPACE the motion it scales lives in: the LOCAL rest
        // translations. A world figure carries the armature's unit scale, so two rigs disagreeing about units
        // put the offset and the rest it is added to in different spaces (an 86 cm death collapse arrived as
        // 0.8 cm and the character died standing up). Magnitude, not world Y, so a Z-up rig reads its height.
        let heightRatio = 1;
        const sh = vec3.length(tsRest);
        const th = vec3.length(ttRest);
        if (sh > 1e-4 && th > 1e-4) heightRatio = th / sh;

        const single = segment.length === 1;
        const input = single ? posSamplers[0].input.slice() : unionKeyTimes(posSamplers);
        const out: number[] = [];
        const v = vec3.create();
        for (let k = 0; k < input.length; k++) {
            if (single) vec3.set(v, posSamplers[0].output[k * 3], posSamplers[0].output[k * 3 + 1], posSamplers[0].output[k * 3 + 2]);
            else chainPos(input[k], v);
            vec3.scale(v, vec3.sub(v, v, tsRest), heightRatio);
            vec3.transformQuat(v, v, corr); // rotate the source-local motion onto the target hips
            out.push(ttRest[0] + v[0], ttRest[1] + v[1], ttRest[2] + v[2]);
        }
        outChannels.push({ samplerIndex: addSampler(input, out, single ? posSamplers[0].interpolation : 'LINEAR'), targetNodeIndex: tgt, targetPath: 'translation' });
    }

    // ---- shares: undriven target joints above a driven one take an even part of its bend.
    //
    // With gap bones G1..Gn (rest locals R1..Rn) above driven T (rest Bt, retargeted AT), the chain's pose is
    // C = R1·…·Rn·AT. The extra rotation it makes over rest, in the frame above G1, is E = C·(R1·…·Rn·Bt)⁻¹.
    // Split into e = E^(1/(n+1)) and apply e at every joint: Gi = P⁻¹·e·P·Ri with P = R1·…·R(i-1), and T takes
    // what is left, so the chain still ends exactly at C.
    for (const [tgt, gap] of plan.shares) {
        const curve = rotOut.get(tgt);
        if (!curve) continue;
        const rest = gap.map(g => pose.local.get(g) ?? localBindRotation(targetSkin, g));
        const bt = pose.local.get(tgt) ?? localBindRotation(targetSkin, tgt);
        const restAbove = quat.create();
        for (const r of rest) quat.multiply(restAbove, restAbove, r);
        const restAboveInv = quat.invert(quat.create(), restAbove);
        const restChainInv = quat.invert(quat.create(), quat.multiply(quat.create(), restAbove, bt));
        const gapOut: number[][] = gap.map(() => []);
        const at = quat.create(), E = quat.create(), e = quat.create(), P = quat.create(), Pinv = quat.create(), g = quat.create();
        const ident = quat.create();
        for (let k = 0; k * 4 < curve.output.length; k++) {
            quat.set(at, curve.output[k * 4], curve.output[k * 4 + 1], curve.output[k * 4 + 2], curve.output[k * 4 + 3]);
            // E = (R1·…·Rn·AT)·(R1·…·Rn·Bt)⁻¹
            quat.multiply(E, restAbove, at);
            quat.normalize(E, quat.multiply(E, E, restChainInv));
            quat.slerp(e, ident, E, 1 / (gap.length + 1));
            quat.identity(P);
            for (let i = 0; i < gap.length; i++) {
                quat.invert(Pinv, P);
                quat.multiply(g, Pinv, e);
                quat.multiply(g, g, P);
                quat.normalize(g, quat.multiply(g, g, rest[i]));
                gapOut[i].push(g[0], g[1], g[2], g[3]);
                quat.multiply(P, P, rest[i]);
            }
            // T keeps one share: AT' = (R1·…·Rn)⁻¹·e·(R1·…·Rn)·Bt
            quat.multiply(g, restAboveInv, e);
            quat.multiply(g, g, restAbove);
            quat.normalize(g, quat.multiply(g, g, bt));
            curve.output[k * 4] = g[0]; curve.output[k * 4 + 1] = g[1]; curve.output[k * 4 + 2] = g[2]; curve.output[k * 4 + 3] = g[3];
        }
        const interpolation = outSamplers[curve.channel.samplerIndex].interpolation;
        gap.forEach((node, i) => outChannels.push({
            samplerIndex: addSampler(curve.input.slice(), gapOut[i], interpolation), targetNodeIndex: node, targetPath: 'rotation',
        }));
    }

    return finishClip(clip, outSamplers, outChannels);
}

// `rootMotion` is a property of the CLIP, not of the skeleton it is playing on, so it must survive the
// retarget. It used to be dropped, which silently disabled root motion on every shared `.anim` clip that had
// a source skin. `assetId` is deliberately NOT carried: the resolve layer stamps it (see animationResolve.ts),
// and only a clip that came from an asset should have one. Clip-owned event markers are timing, not bones.
function finishClip(clip: Animation, samplers: AnimationSampler[], channels: AnimationChannel[]): Animation {
    return {
        name: clip.name, samplers, channels, rootMotion: clip.rootMotion,
        ...(clip.events?.length ? { events: clip.events.map(e => ({ ...e })) } : {}),
    };
}

/** Match, retarget and report in one call, for callers that do not review the mapping. */
export function remapAnimationToSkin(
    clip: Animation, sourceSkin: Skin, targetSkin: Skin,
): { remapped: Animation; report: AnimationCompatibility } {
    const mapping = buildBoneMapping([clip], sourceSkin, targetSkin);
    return { remapped: retargetAnimation(clip, sourceSkin, targetSkin, mapping), report: mappingReport(clip, sourceSkin, targetSkin, mapping) };
}

// ---------------------------------------------------------------------------------------------------
// Diagnostics. A structured dump of what the retarget decided, logged once per import. Pure, read-only.
// ---------------------------------------------------------------------------------------------------

/** WORLD bind rotation of a node from nodeTransforms accumulation ONLY (never the IBM). For diagnostics. */
function nodeTransformsWorldBindRotation(skin: Skin, node: number): quat {
    const chain: number[] = [];
    let n: number | undefined = node;
    for (let guard = 0; n !== undefined && guard < 256; guard++) { chain.push(n); n = parentOf(skin, n); }
    const q = quat.create();
    const r = quat.create();
    for (let i = chain.length - 1; i >= 0; i--) {
        const nt = skin.nodeTransforms?.get(chain[i]);
        if (!nt) continue;
        mat4.getRotation(r, nt as any);
        quat.normalize(r, r);
        quat.multiply(q, q, r);
    }
    return quat.normalize(q, q);
}

/** Rotation of a unit quaternion in degrees (0 = identity). */
function angleDeg(q: quat): number {
    return Math.acos(Math.min(1, Math.abs(q[3]))) * 2 * 180 / Math.PI;
}

/** Local-transform scale of a node, revealing unit scale and mirrors (a negative axis = reflected). */
function nodeScale(skin: Skin, node: number): [number, number, number] {
    const nt = skin.nodeTransforms?.get(node);
    if (!nt) return [1, 1, 1];
    const s = mat4.getScaling(vec3.create(), nt as any);
    // getScaling returns magnitudes; recover a sign per axis so a mirror shows up as negative.
    const det = mat4.determinant(nt as any);
    return [s[0], s[1], det < 0 ? -s[2] : s[2]];
}

/**
 * The distinct humanoid-slot bones on a skin: NODE index keyed by slot (`hips`, `foot.L`, `hand.R`).
 * Empty for a skin with no `nodeNames`; a missing slot is a normal answer, not a failure.
 */
export function humanoidRigOf(skin: Skin): Map<string, number> {
    const out = new Map<string, number>();
    for (const j of skin.joints) {
        const nm = skin.nodeNames?.get(j.nodeIndex);
        const slot = nm ? humanoidSlotOf(nm) : null;
        if (slot && !out.has(slot)) out.set(slot, j.nodeIndex);
    }
    return out;
}

/** @deprecated Internal alias kept so this module's own call sites read as they did. Use humanoidRigOf. */
const slotIndex = humanoidRigOf;

/**
 * A loggable snapshot of a retarget: the modal's header plus, for key bones, the bind rotation computed
 * both ways. The two disagreeing on the source means its node transforms are not a bind pose.
 */
export function describeRetarget(clips: Animation[], sourceSkin: Skin, targetSkin: Skin, mapping: BoneMapping): any {
    const round = (q: quat) => `${angleDeg(q).toFixed(1)}°`;
    const kinds: Record<string, number> = {};
    for (const e of mapping.entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;

    const hasIbm = (skin: Skin) => skin.joints.some(j => !isIdentityMatrix(j.inverseBindMatrix as any));

    const KEY_SLOTS = ['hips', 'spine', 'upperArm.L', 'foreArm.L', 'upLeg.L'];
    const srcSlots = slotIndex(sourceSkin);
    const tgtSlots = slotIndex(targetSkin);
    const bySource = new Map(mapping.entries.map(e => [e.sourceNode, e] as const));

    const bones = KEY_SLOTS.map(slot => {
        const sNode = srcSlots.get(slot);
        const tNode = tgtSlots.get(slot);
        const probe = (skin: Skin, node: number | undefined) => {
            if (node === undefined) return null;
            const ibm = ibmWorldBindRotation(skin, node);
            return {
                node,
                name: skin.nodeNames?.get(node) ?? `node ${node}`,
                scale: nodeScale(skin, node).map(v => +v.toFixed(3)),
                localBind: round(localBindRotation(skin, node)),
                worldBind_fromIBM: ibm ? round(ibm) : 'none',
                worldBind_fromNodeTransforms: round(nodeTransformsWorldBindRotation(skin, node)),
            };
        };
        // `corr` is what the retarget applies: At = corr·As. ~0° means the bind orientations agree.
        let corr = 'n/a', mapped: number | null = null;
        if (sNode !== undefined) {
            const e = bySource.get(sNode);
            mapped = e?.targetNode ?? null;
            if (mapped !== null) corr = round(boneCorrection(sourceSkin, sNode, targetSkin, mapped));
        }
        return { slot, source: probe(sourceSkin, sNode), target: probe(targetSkin, tNode), mappedTargetNode: mapped, corr };
    });

    return {
        matchMode: mapping.matchMode,
        canRetarget: mapping.canRetarget,
        sameRig: mapping.sameRig,
        entries: mapping.entries.length,
        kinds,
        source: { joints: sourceSkin.joints.length, hasNames: !!sourceSkin.nodeNames?.size, hasTransforms: !!sourceSkin.nodeTransforms?.size, hasIBM: hasIbm(sourceSkin) },
        target: { joints: targetSkin.joints.length, hasNames: !!targetSkin.nodeNames?.size, hasTransforms: !!targetSkin.nodeTransforms?.size, hasIBM: hasIbm(targetSkin) },
        clips: clips.map(c => c.name),
        keyBones: bones,
    };
}
