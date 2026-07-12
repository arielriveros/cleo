import { mat4, quat, vec3 } from 'gl-matrix';
import { Animation, AnimationChannel, AnimationSampler, Skin } from './animatedModel';

// Retargeting an imported animation clip onto a model's skeleton. Two problems are handled:
//  1. Bone identity — animations bind by numeric node index (differs across files), so channels are
//     remapped to the target skeleton BY BONE NAME (Skin.nodeNames); mismatches are reported.
//  2. Orientation — an FBX/glTF conversion (assimp) usually leaves the source skeleton's ARMATURE (the
//     non-joint node above the root bone) rotated ~90°X vs the engine model, so raw local rotations play
//     rotated. We correct the ROOT bone by the source-vs-target armature-rest difference; the rest of
//     the (same-name) rig copies directly. Falls back to a plain index/name remap when rest data or
//     bone names are missing.

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
    /** Matched bones whose parent (by name) differs between the source and target skeleton. */
    hierarchyMismatches: HierarchyMismatch[];
    targetJointCount: number;
    /** Distinct target skeleton joints the (remapped) clip drives. */
    targetCovered: number;
    /** True when at least one bone matched — the clip will play (fully or partially). */
    compatible: boolean;
    matchMode: 'name' | 'index';
}

function parentName(skin: Skin, nodeIndex: number): string | null {
    const p = skin.nodeParents?.get(nodeIndex);
    if (p === undefined) return null;
    return skin.nodeNames?.get(p) ?? null;
}

/** Accumulated rest matrix of the NON-joint ancestors above `jointIndex` (the "armature"), or identity. */
function armatureRest(skin: Skin, jointIndex: number, jointNodes: Set<number>): mat4 {
    const chain: number[] = [];
    let p = skin.nodeParents?.get(jointIndex);
    while (p !== undefined && !jointNodes.has(p)) { chain.push(p); p = skin.nodeParents?.get(p); }
    const m = mat4.create();
    for (let i = chain.length - 1; i >= 0; i--) {          // topmost ancestor first
        const nt = skin.nodeTransforms?.get(chain[i]);
        if (nt) mat4.multiply(m, m, nt as any);
    }
    return m;
}

/**
 * Remap an imported clip's channels onto `targetSkin` (by bone name when possible), correct the root
 * orientation for armature differences, and produce a compatibility report.
 */
export function remapAnimationToSkin(
    clip: Animation,
    sourceSkin: Skin,
    targetSkin: Skin,
): { remapped: Animation; report: AnimationCompatibility } {
    const haveNames = !!(sourceSkin.nodeNames && sourceSkin.nodeNames.size > 0
        && targetSkin.nodeNames && targetSkin.nodeNames.size > 0);
    const matchMode: 'name' | 'index' = haveNames ? 'name' : 'index';

    const targetJointNodes = new Set(targetSkin.joints.map(j => j.nodeIndex));
    const sourceJointNodes = new Set(sourceSkin.joints.map(j => j.nodeIndex));
    const targetJointByNode = new Map(targetSkin.joints.map(j => [j.nodeIndex, j] as const));

    const targetNameToIndex = new Map<string, number>();
    if (haveNames) {
        for (const j of targetSkin.joints) {
            const n = targetSkin.nodeNames!.get(j.nodeIndex);
            if (n && !targetNameToIndex.has(n)) targetNameToIndex.set(n, j.nodeIndex);
        }
    }

    // Can we do orientation-correct retargeting (needs names + rest transforms on both skins)?
    const canRetarget = matchMode === 'name' && !!sourceSkin.nodeTransforms && !!targetSkin.nodeTransforms;

    // --- pass 1: match channels to target bones + build the report ---
    const animatedBones = new Set<string>();
    const matched = new Set<string>();
    const missing = new Set<string>();
    const coveredTarget = new Set<number>();
    const hierarchy: HierarchyMismatch[] = [];
    const hierarchyChecked = new Set<string>();
    const matchedChannels: { ch: AnimationChannel; srcIdx: number; tgtIdx: number }[] = [];

    for (const ch of clip.channels) {
        const srcName = sourceSkin.nodeNames?.get(ch.targetNodeIndex) ?? null;
        const label = srcName ?? `node ${ch.targetNodeIndex}`;
        animatedBones.add(label);
        let tgtIdx: number | null = null;
        if (matchMode === 'name') {
            if (srcName && targetNameToIndex.has(srcName)) {
                tgtIdx = targetNameToIndex.get(srcName)!;
                matched.add(srcName);
                if (!hierarchyChecked.has(srcName)) {
                    hierarchyChecked.add(srcName);
                    const sp = parentName(sourceSkin, ch.targetNodeIndex);
                    const tp = parentName(targetSkin, tgtIdx);
                    if (sp !== null && tp !== null && sp !== tp) hierarchy.push({ bone: srcName, sourceParent: sp, targetParent: tp });
                }
            } else missing.add(label);
        } else {
            if (targetJointNodes.has(ch.targetNodeIndex)) { tgtIdx = ch.targetNodeIndex; matched.add(label); }
            else missing.add(label);
        }
        if (tgtIdx !== null) { coveredTarget.add(tgtIdx); matchedChannels.push({ ch, srcIdx: ch.targetNodeIndex, tgtIdx }); }
    }

    // --- pass 2: build the remapped clip ---
    // Everything is a raw channel remap (which already plays correctly, just possibly rotated) EXCEPT
    // the skeleton-root bone's ROTATION, which we correct by the source-vs-target armature-rotation
    // difference. We use ONLY the rotation part (a normalized quaternion) — the armature rest matrices
    // often carry scale (FBX units), so using the full matrix would blow up positions and collapse the
    // mesh. Translation/scale and all non-root bones are left exactly as the (working) raw remap.
    const outSamplers: AnimationSampler[] = clip.samplers.slice();
    const outChannels: AnimationChannel[] = [];
    const addSampler = (input: number[], output: number[], interpolation: AnimationSampler['interpolation']) =>
        (outSamplers.push({ input, output, interpolation }), outSamplers.length - 1);

    // Per skeleton-root bone: the armature rotation correction (a normalized quat) plus each skeleton's
    // root-bone LOCAL rest translation, so the root's animated position can be re-based onto the target
    // skeleton (fixes the static offset) while keeping the motion (rotation-only, scale-free → no blow-up).
    interface RootCorr { q: quat; tsRest: vec3; ttRest: vec3; }
    const rootCorr = new Map<number, RootCorr | null>();
    const rootCorrectionFor = (srcIdx: number, tgtIdx: number): RootCorr | null => {
        if (!canRetarget) return null;
        if (rootCorr.has(tgtIdx)) return rootCorr.get(tgtIdx)!;
        const j = targetJointByNode.get(tgtIdx);
        const isRoot = !j || j.parentIndex === undefined || !targetJointNodes.has(j.parentIndex);
        let c: RootCorr | null = null;
        if (isRoot) {
            const Rs = quat.normalize(quat.create(), mat4.getRotation(quat.create(), armatureRest(sourceSkin, srcIdx, sourceJointNodes) as any));
            const Rt = quat.normalize(quat.create(), mat4.getRotation(quat.create(), armatureRest(targetSkin, tgtIdx, targetJointNodes) as any));
            const q = quat.normalize(quat.create(), quat.multiply(quat.create(), quat.invert(quat.create(), Rt), Rs));
            const tsRest = mat4.getTranslation(vec3.create(), (sourceSkin.nodeTransforms!.get(srcIdx) ?? mat4.create()) as any);
            const ttRest = mat4.getTranslation(vec3.create(), (targetSkin.nodeTransforms!.get(tgtIdx) ?? mat4.create()) as any);
            c = { q, tsRest, ttRest };
        }
        rootCorr.set(tgtIdx, c);
        return c;
    };

    for (const { ch, srcIdx, tgtIdx } of matchedChannels) {
        const corr = (ch.targetPath === 'rotation' || ch.targetPath === 'translation') ? rootCorrectionFor(srcIdx, tgtIdx) : null;
        const src = clip.samplers[ch.samplerIndex];
        if (!corr || !src) { // raw: reference the original sampler untouched
            outChannels.push({ samplerIndex: ch.samplerIndex, targetNodeIndex: tgtIdx, targetPath: ch.targetPath });
            continue;
        }
        const out: number[] = [];
        if (ch.targetPath === 'rotation') {
            // Root rotation → pre-multiply the armature correction (unit quaternions, cannot blow up).
            const q = quat.create();
            for (let k = 0; k * 4 < src.output.length; k++) {
                quat.set(q, src.output[k * 4], src.output[k * 4 + 1], src.output[k * 4 + 2], src.output[k * 4 + 3]);
                quat.normalize(q, q);
                quat.multiply(q, corr.q, q);
                quat.normalize(q, q);
                out.push(q[0], q[1], q[2], q[3]);
            }
        } else {
            // Root translation → target rest + rotated motion delta: Tt = ttRest + rotate(q, Ts - tsRest).
            const v = vec3.create();
            for (let k = 0; k * 3 < src.output.length; k++) {
                vec3.set(v, src.output[k * 3] - corr.tsRest[0], src.output[k * 3 + 1] - corr.tsRest[1], src.output[k * 3 + 2] - corr.tsRest[2]);
                vec3.transformQuat(v, v, corr.q);
                out.push(corr.ttRest[0] + v[0], corr.ttRest[1] + v[1], corr.ttRest[2] + v[2]);
            }
        }
        outChannels.push({ samplerIndex: addSampler(src.input.slice(), out, src.interpolation), targetNodeIndex: tgtIdx, targetPath: ch.targetPath });
    }

    const remapped: Animation = { name: clip.name, samplers: outSamplers, channels: outChannels };
    const report: AnimationCompatibility = {
        clipName: clip.name,
        animatedBones: animatedBones.size,
        matchedBones: matched.size,
        missingBones: [...missing],
        hierarchyMismatches: hierarchy,
        targetJointCount: targetSkin.joints.length,
        targetCovered: coveredTarget.size,
        compatible: matched.size > 0,
        matchMode,
    };
    return { remapped, report };
}
