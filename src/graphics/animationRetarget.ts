import { mat4, quat, vec3 } from 'gl-matrix';
import { Animation, AnimationChannel, AnimationSampler, Skin } from './animatedModel';
import { normalizeBoneName, humanoidSlotOf } from './boneNames';
import { skeletonTopology } from './skeletonTopology';

// Retargeting an imported animation clip onto a model's skeleton.
//
// The work splits into three stages, deliberately separated so the editor can put a mapping review between
// them: MATCH source bones to target bones (buildBoneMapping), REPORT the result cheaply for the modal
// (mappingReport, re-run on every manual edit), and REBUILD the clip's samplers once on accept
// (retargetAnimation). remapAnimationToSkin ties all three together for callers that don't review.
//
// Two skeletons almost never share bone names OR bind poses. Matching climbs three tiers — exact name,
// normalized name, humanoid dictionary (see boneNames.ts) — and the rotation of every matched bone is
// re-expressed through the bind-pose difference of the two rigs, so a Mixamo clip drives a custom rig
// without limbs sweeping through the body. A clip from the SAME rig skips all of it and is copied raw, which
// is exact and preserves translation channels a cross-rig retarget would drop.

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
    /** Animated bones with no counterpart in the target skeleton (won't play). */
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
}

export interface BoneMapping {
    /** One entry per DISTINCT animated source bone, in the order the clips animate them. */
    entries: BoneMappingEntry[];
    /**
     * Same rig: every animated bone maps AND its retarget correction is identity (bind poses agree,
     * including the armature at the root), so the clip can be copied verbatim. Judged on the corrections,
     * NOT name equality — `mixamorig:` and `mixamorig1:` are the same skeleton renamed.
     */
    sameRig: boolean;
    /** True when both skins carry the rest data the delta retarget needs (names + local rest transforms). */
    canRetarget: boolean;
    matchMode: 'name' | 'index';
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

/**
 * LOCAL bind rotation of a bone — its rest orientation relative to its PARENT.
 *
 * This is what the retarget actually needs. Working in local space keeps a difference in the armature (the
 * non-joint root above the hips) or drift in a source skin's frame-0 node transforms LOCALIZED to the bone
 * it belongs to, instead of accumulating down the whole chain into every descendant — which is what made a
 * same-rig Mixamo import twist every limb.
 *
 * From the inverse bind matrices when present: `localBind = worldParent⁻¹ · worldBone`, and since
 * `worldBind = inverse(IBM)`, that is `IBM_parent · inverse(IBM_bone)` (identity parent at the root). Falls
 * back to the node's OWN local transform otherwise — its own value, never an accumulation, so a source with
 * no IBMs still contributes a usable per-bone local rest.
 */
function localBindRotation(skin: Skin, node: number): quat {
    const joint = skin.joints.find(j => j.nodeIndex === node);
    if (joint && !isIdentityMatrix(joint.inverseBindMatrix as any)) {
        const worldBone = mat4.invert(mat4.create(), joint.inverseBindMatrix as any);
        if (worldBone) {
            // Nearest ancestor JOINT, not the immediate parent node. On an assimp-converted FBX a bone's
            // immediate parent is a `$AssimpFbx$` pivot, so a one-level `joints.find(parentIndex)` misses
            // every time and this silently returned the WORLD bind — reintroducing exactly the accumulation
            // down the chain that working in local space exists to prevent.
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

/** WORLD bind translation of a node (full transforms, scale included — this is a real position). */
function worldBindTranslation(skin: Skin, node: number): vec3 {
    const chain: number[] = [];
    let n: number | undefined = node;
    for (let guard = 0; n !== undefined && guard < 256; guard++) { chain.push(n); n = parentOf(skin, n); }
    const m = mat4.create();
    for (let i = chain.length - 1; i >= 0; i--) {
        const nt = skin.nodeTransforms?.get(chain[i]);
        if (nt) mat4.multiply(m, m, nt as any);
    }
    return mat4.getTranslation(vec3.create(), m);
}

/** Local rest translation of a node, or [0,0,0]. */
function localRestTranslation(skin: Skin, node: number): vec3 {
    const nt = skin.nodeTransforms?.get(node);
    return nt ? mat4.getTranslation(vec3.create(), nt as any) : vec3.create();
}

function nearIdentity(q: quat): boolean {
    // A unit quaternion is identity at w = ±1; the rotation half-angle is acos(|w|).
    return Math.acos(Math.min(1, Math.abs(q[3]))) < IDENTITY_EPS;
}

/**
 * Per-skin topology cache. Keyed on the Skin object, which is fixed once parsed — the same invalidation
 * rule the Animator uses.
 */
const topoCache = new WeakMap<Skin, ReturnType<typeof skeletonTopology>>();
function topoOf(skin: Skin) {
    let t = topoCache.get(skin);
    if (!t) { t = skeletonTopology(skin); topoCache.set(skin, t); }
    return t;
}

/**
 * The nearest ANCESTOR JOINT of a node, climbing through any non-joint nodes in between, or undefined.
 *
 * Everything in this file used to ask `skin.joints.find(j => j.nodeIndex === joint.parentIndex)`, which is
 * a one-level test in NODE space. Rigs routinely have non-joints between bones — assimp's FBX pivots being
 * the case that broke — so the shared topology answers this instead.
 */
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
    // `parentJoint < 0` means no JOINT above it — pivots and armature nodes do not make a bone a root,
    // which is what made every bone take the armature-difference branch of boneCorrection.
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

/**
 * The spine chain of a skin: the joints strictly between hips and neck, hips-side first.
 *
 * Rigs disagree on spine naming irreconcilably (`Spine/Spine1/Spine2` vs `spine_01..03` vs `spine/chest`),
 * so these are paired by ORDER rather than by name — which is only possible if they are collected as an
 * ordered chain. Returns [] when either end can't be located, leaving the tier matcher's guesses in place.
 */
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

    // Target lookups, most specific first. First writer wins so an exact name is never shadowed by a
    // normalized collision.
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
        // Non-joint nodes, by EXACT name only, and only where a joint has not already claimed the name.
        //
        // A clip does not only animate joints. Assimp's FBX importer preserves pivots, so a bone's rotation
        // curve targets `Bone_$AssimpFbx$_Rotation` — not a joint, and so previously unmatchable: every one
        // of those channels mapped to null, which both dropped the curve and made `entries.every(targetNode
        // !== null)` false, so two identical Mixamo rigs could never take the verbatim same-rig path.
        // Exact-name only on purpose: these names are structural, and normalizing or humanoid-matching one
        // would let a pivot capture the slot its own bone should have.
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

    // Spine: pair the two chains positionally, overriding whatever the tiers guessed for those bones.
    if (haveNames) {
        const srcSpine = spineChain(sourceSkin);
        const tgtSpine = spineChain(targetSkin);
        if (srcSpine.length && tgtSpine.length) {
            const byNode = new Map(entries.map(e => [e.sourceNode, e] as const));
            for (let i = 0; i < srcSpine.length; i++) {
                const e = byNode.get(srcSpine[i]);
                if (!e) continue;
                // Distribute source index across the target chain length.
                const ti = srcSpine.length === 1 ? 0 : Math.round((i * (tgtSpine.length - 1)) / (srcSpine.length - 1));
                e.targetNode = tgtSpine[Math.min(ti, tgtSpine.length - 1)];
                e.kind = 'spine';
            }
        }
    }

    // sameRig: every animated bone maps AND its LOCAL-bind correction is identity (same rest orientation)
    // AND its rest proportions match. Judged on LOCAL binds, not names — `mixamorig:` and `mixamorig1:` are
    // the same skeleton under a renamed namespace, so name equality is the wrong test; the correction being
    // identity is the right one. When true a raw copy is exact and preserves translations a retarget drops.
    let sameRig = canRetarget && entries.length > 0 && entries.every(e => e.targetNode !== null);
    if (sameRig) {
        for (const e of entries) {
            if (e.targetNode === null) { sameRig = false; break; }
            const corr = boneCorrection(sourceSkin, e.sourceNode, targetSkin, e.targetNode);
            const ts = localRestTranslation(sourceSkin, e.sourceNode);
            const tt = localRestTranslation(targetSkin, e.targetNode);
            if (!nearIdentity(corr) || vec3.squaredDistance(ts, tt) > 1e-6) { sameRig = false; break; }
        }
    }

    return { entries, sameRig, canRetarget, matchMode };
}

/**
 * WORLD rotation of a node's ARMATURE — the accumulated rest rotation of every ancestor ABOVE it (the node
 * itself excluded). For a root joint this is the non-joint armature/scene rotation the engine applies above
 * the hips. Static (armature nodes are never animated), so `nodeTransforms` is reliable here on both skins.
 *
 * "Never animated" holds only because `isRootJoint` now identifies the TRUE root. It is emphatically false
 * for an assimp `$AssimpFbx$_Rotation` pivot, whose node transform is the clip's frame-0 value rather than a
 * rest pose — while every bone wrongly reported as a root, this walked those and produced a correction that
 * grew with depth, which is what twisted arms and legs.
 */
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
 * The retarget correction for a matched bone: the quaternion `corr` such that `At = corr · As` transfers an
 * animated local rotation onto the target bone.
 *
 * Three regimes:
 *  - The ROOT bone (hips) uses the ARMATURE difference `Awt⁻¹ · Aws`. The engine applies each skin's static
 *    armature above the hips, so making the target's displayed hips world equal the source's is EXACT:
 *    `displayed = Awt·At = Awt·Awt⁻¹·Aws·As = Aws·As = source`. This keeps a Mixamo clip upright instead of
 *    lying down — the two rigs' armatures differ by ~90° (Z-up FBX → Y-up glTF).
 *  - A non-root bone whose SOURCE has no usable inverse bind matrix is copied straight through (`identity`).
 *    MEASURE THIS BEFORE CHANGING IT. The claim that used to sit here — "without an IBM the source's node
 *    transforms are the animation's FRAME-0 pose, not the bind" — is FALSE for assimp's FBX conversion, and
 *    believing it cost a wrong fix. `tools/dump-rig.mjs` compares each node's authored glTF TRS (folded
 *    through its `$AssimpFbx$` chain) against the local bind derived from the inverse bind matrices, and
 *    they agree on 52 of 52 joints in a Mixamo animation file and 65 of 65 in a character: the node
 *    transforms ARE the bind. A rest delta against them would therefore be valid.
 *    It is left as a raw copy anyway, because a bind-less import is necessarily the same skeleton (so the
 *    raw rotation is already right) and because no bind-less file was on hand to verify a change against —
 *    not because the delta is unsound. Both Mixamo exports we have carry a real skin and never reach here.
 *  - Otherwise (both skins have real binds) a non-root bone uses the LOCAL bind delta `Bt · Bs⁻¹`, which
 *    keeps a genuine cross-rig difference confined to the bone it belongs to.
 *
 * A matched node that is not a JOINT at all — an assimp `$AssimpFbx$` pivot carrying the bone's rotation
 * curve — is handled before any of that, from the two nodes' local rest rotations. It has no inverse bind
 * matrix and is not a root; without this it fell into the armature branch and got an accumulated world
 * delta applied as if it were local.
 */
function boneCorrection(sourceSkin: Skin, sNode: number, targetSkin: Skin, tNode: number): quat {
    // A matched node that is not a JOINT — an assimp `$AssimpFbx$` pivot carrying the bone's rotation
    // curve. Copied straight through, for the same reason as the bind-less case below and more strongly:
    // a pivot has no inverse bind matrix on EITHER side, so there is no rest to take a delta against.
    //
    // Deriving one from `nodeTransforms` is actively wrong, and was the bug: an animation-only file
    // (Mixamo "Without Skin") has no skin at all, so gltfLoader synthesizes its joints from the animated
    // nodes with identity IBMs and its node transforms are the clip's FRAME 0. Every channel of such a
    // clip targets a pivot, so every one took that branch and none reached the guard below — deltaing the
    // character file's bind against the animation file's frame-0 value, which twists each limb by an
    // arbitrary amount. Mixamo's own T-Pose clip, which should be a visual no-op, rotated the model.
    //
    // Known limitation, worth knowing before touching this: with pivots present the hips curve lands on
    // `Hips_$AssimpFbx$_Rotation`, so the armature branch below never runs for a converted FBX and its
    // "keeps a Mixamo clip upright" compensation is inert. Harmless same-rig (both files convert
    // identically, so the armature delta is identity anyway); a genuinely cross-rig import would need it
    // applied to the highest mapped node above the hips, which is not this function's shape today.
    if (!topoOf(targetSkin).jointOfNode.has(tNode)) return quat.create();

    if (isRootJoint(targetSkin, tNode)) {
        const aws = armatureWorldRotation(sourceSkin, sNode);
        const awt = armatureWorldRotation(targetSkin, tNode);
        return quat.normalize(quat.create(), quat.multiply(quat.create(), quat.invert(quat.create(), awt), aws));
    }
    const sJoint = sourceSkin.joints.find(j => j.nodeIndex === sNode);
    if (!sJoint || isIdentityMatrix(sJoint.inverseBindMatrix as any)) return quat.create(); // no source bind → raw
    const bs = localBindRotation(sourceSkin, sNode);
    const bt = localBindRotation(targetSkin, tNode);
    return quat.normalize(quat.create(), quat.multiply(quat.create(), bt, quat.invert(quat.create(), bs)));
}

/** Return a copy of `mapping` with one source bone re-pointed (or unmapped when targetNode is null). */
export function applyManualMapping(mapping: BoneMapping, sourceNode: number, targetNode: number | null): BoneMapping {
    const entries = mapping.entries.map(e =>
        e.sourceNode === sourceNode ? { ...e, targetNode, kind: (targetNode === null ? 'none' : 'manual') as BoneMatchKind } : e);
    // A manual edit means the rig is being treated as different; drop the raw fast-path so the delta
    // retarget actually runs (it also stops a same-rig raw copy from ignoring the override entirely).
    return { ...mapping, entries, sameRig: false };
}

/** Cheap per-clip report from a mapping — set math only, safe to re-run on every dropdown change. */
export function mappingReport(
    clip: Animation, sourceSkin: Skin, targetSkin: Skin, mapping: BoneMapping,
): AnimationCompatibility {
    const byNode = new Map(mapping.entries.map(e => [e.sourceNode, e] as const));
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
            // Parent-mismatch is only meaningful for an exact match — a humanoid/normalized match crosses
            // naming conventions by design, so its parents differing is expected, not a warning.
            if (e.kind === 'exact' && !hierarchyChecked.has(ch.targetNodeIndex)) {
                hierarchyChecked.add(ch.targetNodeIndex);
                const sp = parentName(sourceSkin, ch.targetNodeIndex);
                const tp = parentName(targetSkin, e.targetNode);
                if (sp !== null && tp !== null && sp !== tp) hierarchy.push({ bone: label, sourceParent: sp, targetParent: tp });
            }
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

interface Correction {
    corr: quat;         // Bt · Bs⁻¹ — left-multiplies an animated local rotation onto the target bone
    isHips: boolean;
    tsRest: vec3;       // source local rest translation (root translation re-basing)
    ttRest: vec3;       // target local rest translation
    heightRatio: number;
}

/**
 * Rebuild a clip's samplers so it drives the target skeleton. When `mapping.sameRig` (or rest data is
 * missing) the channels are copied verbatim; otherwise every matched bone's ROTATION is transferred through
 * its LOCAL bind-orientation difference (`At = Bt·Bs⁻¹·As`), the hips translation is re-based and
 * height-scaled, and all other translation and scale channels are dropped (bone lengths differ between rigs,
 * so copying them stretches the target).
 *
 * Working in LOCAL space is deliberate: a difference in the armature above the hips, or drift in a source
 * skin whose node transforms are its animation's frame-0 pose, stays confined to the bone it belongs to
 * instead of accumulating down the chain and twisting every descendant limb.
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

    const hipsTarget = raw ? null : hipsNodeOf(targetSkin);
    const corrections = new Map<number, Correction>();
    const correctionFor = (srcNode: number, tgtNode: number): Correction => {
        const cached = corrections.get(tgtNode);
        if (cached) return cached;
        const corr = boneCorrection(sourceSkin, srcNode, targetSkin, tgtNode);
        const isHips = tgtNode === hipsTarget;
        let heightRatio = 1;
        if (isHips) {
            const sy = Math.abs(worldBindTranslation(sourceSkin, srcNode)[1]);
            const ty = Math.abs(worldBindTranslation(targetSkin, tgtNode)[1]);
            if (sy > 1e-4 && ty > 1e-4) heightRatio = ty / sy;
        }
        const c: Correction = {
            corr, isHips,
            tsRest: localRestTranslation(sourceSkin, srcNode),
            ttRest: localRestTranslation(targetSkin, tgtNode),
            heightRatio,
        };
        corrections.set(tgtNode, c);
        return c;
    };

    for (const ch of clip.channels) {
        const e = byNode.get(ch.targetNodeIndex);
        if (!e || e.targetNode === null) continue; // unmatched: dropped
        const tgt = e.targetNode;
        const src = clip.samplers[ch.samplerIndex];

        if (raw || !src) {
            outChannels.push({ samplerIndex: ch.samplerIndex, targetNodeIndex: tgt, targetPath: ch.targetPath });
            continue;
        }

        const corr = correctionFor(ch.targetNodeIndex, tgt);

        if (ch.targetPath === 'scale') continue; // dropped — bone scale does not transfer across rigs
        if (ch.targetPath === 'translation') {
            if (!corr.isHips) continue; // only the hips carries root motion; other bone translations stretch
            const out: number[] = [];
            const v = vec3.create();
            for (let k = 0; k * 3 < src.output.length; k++) {
                vec3.set(v,
                    (src.output[k * 3] - corr.tsRest[0]) * corr.heightRatio,
                    (src.output[k * 3 + 1] - corr.tsRest[1]) * corr.heightRatio,
                    (src.output[k * 3 + 2] - corr.tsRest[2]) * corr.heightRatio);
                vec3.transformQuat(v, v, corr.corr); // rotate the source-local motion onto the target hips
                out.push(corr.ttRest[0] + v[0], corr.ttRest[1] + v[1], corr.ttRest[2] + v[2]);
            }
            outChannels.push({ samplerIndex: addSampler(src.input.slice(), out, src.interpolation), targetNodeIndex: tgt, targetPath: 'translation' });
            continue;
        }

        // rotation: At = corr · As = (Bt·Bs⁻¹) · As  (unit quaternions — cannot blow up).
        const out: number[] = [];
        const q = quat.create();
        for (let k = 0; k * 4 < src.output.length; k++) {
            quat.set(q, src.output[k * 4], src.output[k * 4 + 1], src.output[k * 4 + 2], src.output[k * 4 + 3]);
            quat.normalize(q, q);
            quat.multiply(q, corr.corr, q);
            quat.normalize(q, q);
            out.push(q[0], q[1], q[2], q[3]);
        }
        outChannels.push({ samplerIndex: addSampler(src.input.slice(), out, src.interpolation), targetNodeIndex: tgt, targetPath: 'rotation' });
    }

    return { name: clip.name, samplers: outSamplers, channels: outChannels };
}

/**
 * Match, retarget and report in one call, for callers that don't review the mapping. Kept as the original
 * entry point so nothing outside the import flow has to change.
 */
export function remapAnimationToSkin(
    clip: Animation, sourceSkin: Skin, targetSkin: Skin,
): { remapped: Animation; report: AnimationCompatibility } {
    const mapping = buildBoneMapping([clip], sourceSkin, targetSkin);
    return { remapped: retargetAnimation(clip, sourceSkin, targetSkin, mapping), report: mappingReport(clip, sourceSkin, targetSkin, mapping) };
}

// ---------------------------------------------------------------------------------------------------
// Diagnostics. A single structured dump of what the retarget decided and why — logged once per import so a
// broken retarget can be diagnosed from a user's console without their asset files. Pure and read-only.
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
 * The DISTINCT humanoid-slot bones on a skin, NODE index keyed by slot (`hips`, `foot.L`, `hand.R`, ...).
 *
 * Retargeting needs this to pair two skeletons; anything that has to find a body part by meaning rather than
 * by name needs exactly the same answer. That is why it is public: it is the "where are this character's
 * feet" query, and re-deriving it elsewhere would mean a second bone-naming heuristic that could disagree
 * with the one retargeting already uses.
 *
 * Empty for a skin with no `nodeNames` (an animation-only file, or a rig whose bones are named nothing
 * recognizable) — absence of a slot is a normal answer, not a failure.
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
 * A plain, loggable snapshot of a retarget: the header the modal shows plus, for a handful of key bones, the
 * bind rotation computed BOTH ways (inverse-IBM vs nodeTransforms accumulation) and the per-pair corrections.
 *
 * The IBM-vs-nodeTransforms disagreement is the direct signal for the frame-0-pose bug: when they differ on
 * the source skin, the animation file's node transforms are not its bind pose.
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
        // `corr` is what the retarget actually applies for this pair: At = corr·As. ~0° means "no correction
        // needed" (same bind orientation); a large value on a limb bone is the twist.
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
