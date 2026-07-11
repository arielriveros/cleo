import { Animation, AnimationChannel, Skin } from './animatedModel';

// Retargeting an imported animation clip onto a model's skeleton. Animations bind to skeletons by
// numeric GLTF node index, which differs across files, so we remap each channel's targetNodeIndex by
// BONE NAME (Skin.nodeNames) and report which bones don't line up. Falls back to index matching when
// names are unavailable (e.g. a model saved before bone-name capture existed).

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

/**
 * Remap an imported clip's channels onto `targetSkin` (by bone name when possible) and produce a
 * compatibility report. The remapped clip contains only the channels that matched the target skeleton
 * (so it plays cleanly); its samplers are carried through unchanged.
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

    // name -> target node index (over the target's joints)
    const targetNameToIndex = new Map<string, number>();
    if (haveNames) {
        for (const j of targetSkin.joints) {
            const n = targetSkin.nodeNames!.get(j.nodeIndex);
            if (n && !targetNameToIndex.has(n)) targetNameToIndex.set(n, j.nodeIndex);
        }
    }

    const remappedChannels: AnimationChannel[] = [];
    const animatedBones = new Set<string>();
    const matched = new Set<string>();
    const missing = new Set<string>();
    const coveredTarget = new Set<number>();
    const hierarchy: HierarchyMismatch[] = [];
    const hierarchyChecked = new Set<string>();

    for (const ch of clip.channels) {
        const srcName = sourceSkin.nodeNames?.get(ch.targetNodeIndex) ?? null;
        const label = srcName ?? `node ${ch.targetNodeIndex}`;
        animatedBones.add(label);

        if (matchMode === 'name') {
            if (srcName && targetNameToIndex.has(srcName)) {
                const targetIdx = targetNameToIndex.get(srcName)!;
                remappedChannels.push({ ...ch, targetNodeIndex: targetIdx });
                matched.add(srcName);
                coveredTarget.add(targetIdx);
                if (!hierarchyChecked.has(srcName)) {
                    hierarchyChecked.add(srcName);
                    const sp = parentName(sourceSkin, ch.targetNodeIndex);
                    const tp = parentName(targetSkin, targetIdx);
                    if (sp !== null && tp !== null && sp !== tp) {
                        hierarchy.push({ bone: srcName, sourceParent: sp, targetParent: tp });
                    }
                }
            } else {
                missing.add(label);
            }
        } else {
            // index mode: keep channels that already target a skeleton joint index
            if (targetJointNodes.has(ch.targetNodeIndex)) {
                remappedChannels.push({ ...ch });
                matched.add(label);
                coveredTarget.add(ch.targetNodeIndex);
            } else {
                missing.add(label);
            }
        }
    }

    const remapped: Animation = { name: clip.name, samplers: clip.samplers, channels: remappedChannels };
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
