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
     * Per joint: the NON-JOINT node indices standing between it and `parentJoint[i]`, ordered top-down —
     * so accumulating a pose is `parentGlobal × chain[0] × chain[1] × … × local`.
     *
     * Real rigs put nodes between bones. Assimp's FBX importer preserves pivots by default and emits
     * `Bone_$AssimpFbx$_Translation` / `_Rotation` / `_PreRotation` / `_Scaling` chains between every pair
     * of joints, and its glTF2 exporter adds an `<armature>_node` wrapper above the root joint carrying
     * the file's unit scale. Treating each such joint as a fresh root — which is what this module used to
     * do, and what the Animator's own one-level walk did — flattens the tree, draws no bones at all, and
     * poses every limb relative to the model origin instead of its parent.
     *
     * Empty for the common case where a joint's parent is already a joint, so a clean glTF rig pays
     * nothing and behaves exactly as before.
     */
    parentChain: number[][];
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
    const parentChain: number[][] = Array.from({ length: count }, () => []);
    const parentNodeOfNode = new Map<number, number | undefined>();
    const children: number[][] = Array.from({ length: count }, () => []);
    const roots: number[] = [];

    // `Joint.parentIndex` is only the IMMEDIATE parent node, which on many rigs is not a joint. Climbing
    // `skin.nodeParents` finds the real ancestor joint and records what sits in between, so the caller can
    // apply those transforms instead of losing them. Bounded and visited-guarded: a malformed skin may
    // contain a cycle, and this module's contract is that bad input never throws or hangs.
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
        // No joint above: everything walked is the root joint's chain up to the scene root.
        return { joint: -1, chain: chain.reverse() };
    };

    for (let i = 0; i < count; i++) {
        const p = joints[i].parentIndex;
        parentNode[i] = p;
        parentNodeOfNode.set(joints[i].nodeIndex, p);

        const { joint: pj, chain } = ancestorJointOf(p);
        parentChain[i] = chain;
        // Self-parenting is not a hierarchy, it is a one-node cycle; treat it as a root rather than looping.
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
 * Whether `ancestor` is somewhere above `descendant` in the skeleton. STRICT: a joint is not its own ancestor.
 *
 * Both arguments are JOINT indices. Exists because a chain of bones is only a chain if the hierarchy says so
 * — three bones can carry the right names, sit in the right slots, and belong to three unrelated parts of the
 * rig, at which point solving them produces a pose with no relation to the character. Names cannot answer
 * that question; only the parent links can.
 *
 * Bounded rather than trusting the data: a malformed skin can contain a cycle (skeletonTopology tolerates
 * one), and an unbounded walk up would hang the render loop rather than report a bad rig.
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

/**
 * The deepest joint that is an ancestor of every joint given, or -1 when they do not share one.
 *
 * This is how you find a pelvis without believing a name: the nearest common ancestor of the two thighs IS
 * the pelvis, on every rig, whatever it is called and whatever else in the skeleton also answers to "hips".
 */
export function nearestCommonAncestor(topo: SkeletonTopology, joints: number[]): number {
    const valid = joints.filter(j => j >= 0 && j < topo.parentJoint.length);
    if (valid.length === 0) return -1;

    /** The joint and everything above it, deepest first. */
    const lineage = (j: number): number[] => {
        const out = [j];
        let n = topo.parentJoint[j];
        for (let guard = 0; n >= 0 && guard < 256; guard++) { out.push(n); n = topo.parentJoint[n]; }
        return out;
    };

    // Walk the first joint's lineage from the joint upwards and take the first entry every other joint also
    // descends from — "first" from the bottom being the DEEPEST such joint, which is what "nearest" means.
    const others = valid.slice(1).map(lineage).map(l => new Set(l));
    for (const candidate of lineage(valid[0])) {
        if (others.every(set => set.has(candidate))) return candidate;
    }
    return -1;
}
