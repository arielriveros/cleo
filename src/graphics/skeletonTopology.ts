import type { Skin } from './animatedModel';

// ---------------------------------------------------------------------------
// Skeleton topology.
//
// A Skin describes its hierarchy in GLTF NODE indices — `Joint.parentIndex` is a node index, not an index
// into `joints[]` — while everything that consumes a skeleton works in JOINT indices, because that is what
// indexes `getFinalBoneMatrices()`. Bridging the two is three lines, which is why five places in this repo
// each grew their own copy: the Animator (three times over), the ragdoll, and the editor's skeleton tree.
//
// This is that bridge, computed once per skin. It also answers the two questions the ad-hoc copies never
// did — who are a joint's CHILDREN, and in what order can joints be visited so that every parent comes
// before its children — which is what turns pose accumulation from a memoized recursion into a flat loop.
//
// Pure data: types only from animatedModel, so this stays unit-testable with no GL context.
// ---------------------------------------------------------------------------

export interface SkeletonTopology {
    /** GLTF node index -> index into `skin.joints`. The lookup every consumer was re-deriving. */
    jointOfNode: Map<number, number>;
    /** Per joint: its parent's JOINT index, or -1 when the parent is absent or outside the skin. */
    parentJoint: number[];
    /**
     * Per joint: its parent's NODE index, or undefined.
     *
     * Kept alongside `parentJoint` because a skin's root is routinely parented to a node that is NOT itself a
     * joint — an armature or an empty — and its transform still has to be applied. Collapsing the two would
     * silently drop that.
     */
    parentNode: (number | undefined)[];
    /**
     * NODE index -> parent NODE index, for the several walks that work in node space throughout (root-motion
     * chains, nearest-bodied-ancestor searches, the ragdoll's pruning). Same information as `parentNode`,
     * keyed the way those callers already think.
     */
    parentNodeOfNode: Map<number, number | undefined>;
    /** Per joint: the joint indices directly beneath it. */
    children: number[][];
    /** Joints with no parent inside the skin. Usually one; a synthetic skin can have several. */
    roots: number[];
    /** Every joint index, parents strictly before children. Safe to accumulate transforms along. */
    order: number[];
}

/**
 * Build the topology of a skin.
 *
 * Tolerant of the malformed input a real asset pipeline produces: a parent that is not a joint, a joint whose
 * parent index points at itself, and even a cycle. Nothing here throws — a skeleton that cannot be ordered
 * still yields every joint in `order`, just in an arbitrary position, because posing a character wrongly is
 * recoverable and refusing to pose it at all is not.
 */
export function skeletonTopology(skin: Skin): SkeletonTopology {
    const joints = skin.joints ?? [];
    const count = joints.length;

    const jointOfNode = new Map<number, number>();
    for (let i = 0; i < count; i++) jointOfNode.set(joints[i].nodeIndex, i);

    const parentJoint = new Array<number>(count).fill(-1);
    const parentNode = new Array<number | undefined>(count).fill(undefined);
    const parentNodeOfNode = new Map<number, number | undefined>();
    const children: number[][] = Array.from({ length: count }, () => []);
    const roots: number[] = [];

    for (let i = 0; i < count; i++) {
        const p = joints[i].parentIndex;
        parentNode[i] = p;
        parentNodeOfNode.set(joints[i].nodeIndex, p);
        const pj = p === undefined ? undefined : jointOfNode.get(p);
        // Self-parenting is not a hierarchy, it is a one-node cycle; treat it as a root rather than looping.
        if (pj === undefined || pj === i) { roots.push(i); continue; }
        parentJoint[i] = pj;
        children[pj].push(i);
    }

    // Breadth-first from the roots, so a parent is always emitted before its children.
    const order: number[] = [];
    const seen = new Array<boolean>(count).fill(false);
    const queue = [...roots];
    for (const r of roots) seen[r] = true;
    for (let head = 0; head < queue.length; head++) {
        const j = queue[head];
        order.push(j);
        for (const c of children[j]) {
            if (seen[c]) continue;   // a cycle would otherwise re-enqueue forever
            seen[c] = true;
            queue.push(c);
        }
    }
    // Anything unreached sits in a cycle. Append it so callers can still iterate every joint exactly once.
    for (let i = 0; i < count; i++) if (!seen[i]) order.push(i);

    return { jointOfNode, parentJoint, parentNode, parentNodeOfNode, children, roots, order };
}
