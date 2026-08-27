import { mat4, quat, vec3 } from 'gl-matrix';
import { Animation, AnimationChannel, AnimationSampler, Skin } from './animatedModel';
import { normalizeBoneName, humanoidSlotOf } from './boneNames';
import { skeletonTopology } from './skeletonTopology';

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
     * Every animated bone maps and every correction is identity, so the clip can be copied verbatim.
     * Judged on the corrections, never on name equality.
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

// LOCAL bind rotation of a bone — its rest orientation relative to its parent, so a difference stays
// confined to that bone rather than accumulating down the chain. From the IBMs when present
// (`IBM_parent · inverse(IBM_bone)`), else the node's own local transform.
function localBindRotation(skin: Skin, node: number): quat {
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

    // sameRig: every bone maps, every LOCAL-bind correction is identity, and rest proportions match.
    // Judged on the binds, never on names — a renamed namespace is still the same skeleton.
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

// The retarget correction for a matched bone: `corr` such that `At = corr · As`. Four regimes, in order:
// a non-joint node (assimp pivot) copies through; the ROOT bone uses the armature difference
// `Awt⁻¹ · Aws`; a source with no usable IBM copies through; otherwise the local bind delta `Bt · Bs⁻¹`.
function boneCorrection(sourceSkin: Skin, sNode: number, targetSkin: Skin, tNode: number): quat {
    // A pivot has no inverse bind matrix on EITHER side, so there is no rest to delta against, and
    // `nodeTransforms` is frame 0 for an animation-only file. This makes the armature branch below
    // unreachable for a converted FBX, which only matters cross-rig.
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
    // A manual edit means the rigs are being treated as different: drop the raw fast path, or the
    // override would be ignored entirely.
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
            // Only meaningful for an exact match: a humanoid match crosses conventions by design.
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
 * Rebuild a clip's samplers so it drives the target skeleton. `mapping.sameRig` copies verbatim; otherwise
 * rotations go through the local bind delta (`At = Bt·Bs⁻¹·As`) and non-hips translation/scale is dropped.
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
