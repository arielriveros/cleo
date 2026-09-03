import type { Skin } from './animatedModel';

// ---------------------------------------------------------------------------
// Skeleton topology: the bridge between a Skin's GLTF NODE indices and the JOINT indices everything
// that consumes a skeleton works in. Pure data — types only, so it needs no GL context.
// ---------------------------------------------------------------------------

export interface SkeletonTopology {
    /** GLTF node index -> index into `skin.joints`. */
    jointOfNode: Map<number, number>;
    /** Per joint: its parent's JOINT index, or -1 when the parent is absent or outside the skin. */
    parentJoint: number[];
    /** Per joint: its parent's NODE index, or undefined. A skin root is often parented to a non-joint. */
    parentNode: (number | undefined)[];
    /**
     * Per joint: the NON-JOINT node indices between it and `parentJoint[i]`, top-down, so a pose
     * accumulates as `parentGlobal × chain[0] × … × local`. Empty when the parent is already a joint.
     */
    parentChain: number[][];
    /** NODE index -> parent NODE index, for the walks that stay in node space throughout. */
    parentNodeOfNode: Map<number, number | undefined>;
    /** Per joint: the joint indices directly beneath it. */
    children: number[][];
    /** Joints with no parent inside the skin. Usually one; a synthetic skin can have several. */
    roots: number[];
    /** Every joint index, parents strictly before children. Safe to accumulate transforms along. */
    order: number[];
}

/**
 * Build the topology of a skin. Never throws: non-joint parents, self-parenting and cycles are all
 * tolerated, and every joint still appears exactly once in `order`.
 */
export function skeletonTopology(skin: Skin): SkeletonTopology {
    const joints = skin.joints ?? [];
    const count = joints.length;

    const jointOfNode = new Map<number, number>();
    for (let i = 0; i < count; i++) jointOfNode.set(joints[i].nodeIndex, i);

    const parentJoint = new Array<number>(count).fill(-1);
    const parentNode = new Array<number | undefined>(count).fill(undefined);
    const parentChain: number[][] = Array.from({ length: count }, () => []);
    const parentNodeOfNode = new Map<number, number | undefined>();
    const children: number[][] = Array.from({ length: count }, () => []);
    const roots: number[] = [];

    // `Joint.parentIndex` is only the immediate parent node, often not a joint. Climb `skin.nodeParents`
    // to the real ancestor joint, recording the non-joint nodes in between. Bounded against cycles.
    const nodeParents = skin.nodeParents;
    const ancestorJointOf = (from: number | undefined): { joint: number; chain: number[] } => {
        const chain: number[] = [];
        const seenNodes = new Set<number>();
        let node = from;
        for (let guard = 0; node !== undefined && guard < 256; guard++) {
            if (seenNodes.has(node)) break;
            seenNodes.add(node);
            const asJoint = jointOfNode.get(node);
            if (asJoint !== undefined) return { joint: asJoint, chain: chain.reverse() };
            chain.push(node); // a non-joint ancestor: keep it, its transform still applies
            node = nodeParents?.get(node);
        }
        return { joint: -1, chain: chain.reverse() };
    };

    for (let i = 0; i < count; i++) {
        const p = joints[i].parentIndex;
        parentNode[i] = p;
        parentNodeOfNode.set(joints[i].nodeIndex, p);

        const { joint: pj, chain } = ancestorJointOf(p);
        parentChain[i] = chain;
        // Self-parenting is a one-node cycle; treat it as a root.
        if (pj < 0 || pj === i) { roots.push(i); continue; }
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

    return { jointOfNode, parentJoint, parentNode, parentChain, parentNodeOfNode, children, roots, order };
}

/**
 * Whether `ancestor` (a JOINT index) is above `descendant` in the skeleton. Strict — a joint is not its
 * own ancestor — and bounded, so a cyclic skin cannot hang the walk.
 */
export function isAncestorJoint(topo: SkeletonTopology, ancestor: number, descendant: number): boolean {
    if (ancestor < 0 || descendant < 0 || ancestor === descendant) return false;
    let n = topo.parentJoint[descendant];
    for (let guard = 0; n >= 0 && guard < 256; guard++) {
        if (n === ancestor) return true;
        n = topo.parentJoint[n];
    }
    return false;
}

/** The deepest joint that is an ancestor of every joint given, or -1 when they do not share one. */
export function nearestCommonAncestor(topo: SkeletonTopology, joints: number[]): number {
    const valid = joints.filter(j => j >= 0 && j < topo.parentJoint.length);
    if (valid.length === 0) return -1;

    // The joint and everything above it, deepest first.
    const lineage = (j: number): number[] => {
        const out = [j];
        let n = topo.parentJoint[j];
        for (let guard = 0; n >= 0 && guard < 256; guard++) { out.push(n); n = topo.parentJoint[n]; }
        return out;
    };

    // Bottom-up, so the first shared entry is the deepest one.
    const others = valid.slice(1).map(lineage).map(l => new Set(l));
    for (const candidate of lineage(valid[0])) {
        if (others.every(set => set.has(candidate))) return candidate;
    }
    return -1;
}
