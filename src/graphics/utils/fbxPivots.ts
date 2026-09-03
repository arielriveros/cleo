import { mat4, quat, vec3 } from 'gl-matrix';
import { Animation, AnimationSampler, Joint } from '../../animation/animatedModel';

// Collapsing assimp's FBX pivot decomposition. Assimp wraps every bone in a chain of synthetic
// `$AssimpFbx$` nodes, and emits each one only when its FBX property is non-default — so two files
// from one rig can get different chains, which a name-matching retarget then drops or double-applies.
//
// The fold needs no FBX knowledge: for `parent -> p1 -> ... -> pn -> bone` the bone's world transform
// is `parentWorld * T(p1) * ... * T(bone)`, so folding the product in is an identity by associativity.

/** Assimp's own marker for a node it synthesized from an FBX pivot property. */
const PIVOT_MARKER = '$AssimpFbx$';

export function isFbxPivotName(name: string | undefined): boolean {
    return !!name && name.includes(PIVOT_MARKER);
}

/** The node graph a skin carries, independent of its joint list. */
export interface NodeGraph {
    nodeParents: Map<number, number>;
    nodeTransforms: Map<number, mat4>;
    nodeNames: Map<number, string>;
}

export interface CollapseResult extends NodeGraph {
    animations: Animation[];
    /** The pivot nodes that were folded away, so a caller can drop joints that pointed at them. */
    removed: Set<number>;
}

/** The three animation channels a node can carry, gathered per clip. */
type NodeChannels = { translation?: AnimationSampler; rotation?: AnimationSampler; scale?: AnimationSampler };

/**
 * Fold every `$AssimpFbx$` node into the node beneath it, rewriting animation channels to match. A graph
 * with none is returned untouched. `joints` has its `parentIndex` refreshed in place; the joint ORDER is
 * never changed, since JOINTS_0 indexes it, and world-space inverse bind matrices stay valid.
 */
export function collapseFbxPivots(graph: NodeGraph, animations: Animation[], joints?: Joint[]): CollapseResult {
    const pivots = new Set<number>();
    for (const [node, name] of graph.nodeNames) if (isFbxPivotName(name)) pivots.add(node);

    if (pivots.size === 0) return { ...graph, animations, removed: pivots };

    // A pivot with more than one child is not assimp's linear decomposition; folding it moves siblings.
    const childCount = new Map<number, number>();
    for (const [, parent] of graph.nodeParents) childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
    const foldable = (node: number) => pivots.has(node) && (childCount.get(node) ?? 0) === 1;

    /** The pivots between `node` and its nearest non-pivot ancestor, top-down, plus that ancestor. */
    const chainOf = (node: number): { chain: number[]; parent: number | undefined } => {
        const chain: number[] = [];
        const seen = new Set<number>([node]);
        let p = graph.nodeParents.get(node);
        while (p !== undefined && foldable(p) && !seen.has(p)) {
            seen.add(p);
            chain.push(p);
            p = graph.nodeParents.get(p);
        }
        chain.reverse(); // top-down, so the product reads parent -> ... -> bone
        return { chain, parent: p };
    };

    const nodeParents = new Map<number, number>();
    const nodeTransforms = new Map<number, mat4>();
    const nodeNames = new Map<number, string>();
    /** Bone node -> the pivots folded into it, top-down. Needed again when rewriting the clips. */
    const foldedInto = new Map<number, number[]>();

    for (const [node, name] of graph.nodeNames) {
        if (pivots.has(node) && foldable(node)) continue; // folded away below
        nodeNames.set(node, name);
    }
    for (const node of graph.nodeTransforms.keys()) {
        if (pivots.has(node) && foldable(node)) continue;
        const { chain, parent } = chainOf(node);
        if (parent !== undefined) nodeParents.set(node, parent);
        foldedInto.set(node, chain);

        const composed = mat4.create();
        for (const p of chain) {
            const t = graph.nodeTransforms.get(p);
            if (t) mat4.multiply(composed, composed, t);
        }
        const own = graph.nodeTransforms.get(node);
        if (own) mat4.multiply(composed, composed, own);
        nodeTransforms.set(node, composed);
    }

    if (joints) {
        for (const j of joints) {
            if (!nodeTransforms.has(j.nodeIndex)) continue; // a joint that WAS a pivot; caller re-derives
            j.parentIndex = nodeParents.get(j.nodeIndex);
        }
    }

    const rewritten = animations.map(clip => rewriteClip(clip, graph, foldedInto, nodeTransforms));
    return { nodeParents, nodeTransforms, nodeNames, animations: rewritten, removed: pivots };
}

// Move every channel that targeted a folded pivot onto its bone, sampling the composed local at the
// union of the chain's keyframe times. Exact for the rigid, uniformly-scaled transforms a skeleton uses.
function rewriteClip(
    clip: Animation,
    graph: NodeGraph,
    foldedInto: Map<number, number[]>,
    /** The FOLDED rests — what a bone falls back to at playback, so what a dropped channel must match. */
    foldedRests: Map<number, mat4>,
): Animation {
    // Gather the clip's channels per node, so a chain can be sampled as a unit.
    const perNode = new Map<number, NodeChannels>();
    for (const ch of clip.channels) {
        const sampler = clip.samplers[ch.samplerIndex];
        if (!sampler) continue;
        const entry = perNode.get(ch.targetNodeIndex) ?? {};
        if (ch.targetPath === 'translation') entry.translation = sampler;
        else if (ch.targetPath === 'rotation') entry.rotation = sampler;
        else if (ch.targetPath === 'scale') entry.scale = sampler;
        else continue; // 'weights' — morph targets, nothing to do with the skeleton
        perNode.set(ch.targetNodeIndex, entry);
    }

    const samplers: AnimationSampler[] = [];
    const channels: Animation['channels'] = [];
    const addChannel = (node: number, path: 'translation' | 'rotation' | 'scale', input: number[], output: number[]) => {
        samplers.push({ input, output, interpolation: 'LINEAR' });
        channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: node, targetPath: path });
    };

    for (const [node, chain] of foldedInto) {
        const all = [...chain, node];
        // An assimp channel carries the node's COMPLETE local, pivot chain included, so the deepest
        // keyed node SUPERSEDES everything above it and those must not be composed in again.
        // The REST fold below is different and stays a full composition.
        let deepest = -1;
        for (let i = 0; i < all.length; i++) if (perNode.has(all[i])) deepest = i;
        const involved = deepest < 0 ? all : all.slice(deepest);
        const times = unionTimes(involved, perNode);
        if (times.length === 0) continue; // nothing in this chain is animated; the folded rest covers it

        // A component nothing in the chain keys means "stays at bind", so it must come from the FOLDED
        // rest — the pre-fold one is half a transform once the pivots above it are superseded.
        const rest = graph.nodeTransforms.get(node) ?? mat4.create();
        const foldedRest = foldedRests.get(node) ?? rest;
        const restT = mat4.getTranslation(vec3.create(), foldedRest);
        const restS = mat4.getScaling(vec3.create(), foldedRest);
        const restR = quat.normalize(quat.create(), mat4.getRotation(quat.create(), foldedRest));
        const keyed = { t: false, r: false, s: false };
        for (const n of involved) {
            const ch = perNode.get(n);
            if (ch?.translation) keyed.t = true;
            if (ch?.rotation) keyed.r = true;
            if (ch?.scale) keyed.s = true;
        }

        const out = { t: [] as number[], r: [] as number[], s: [] as number[] };
        const m = mat4.create();
        const step = mat4.create();
        const t = vec3.create(), s = vec3.create(), r = quat.create();
        const prev = quat.create();
        let havePrev = false;

        for (const time of times) {
            mat4.identity(m);
            for (const n of involved) {
                sampleLocal(step, n, time, perNode.get(n), graph.nodeTransforms.get(n));
                mat4.multiply(m, m, step);
            }
            mat4.getTranslation(t, m);
            mat4.getScaling(s, m);
            mat4.getRotation(r, m);
            quat.normalize(r, r);
            // Keep the track continuous: an independently decomposed key can flip sign, and slerp
            // would then take the long way round.
            if (havePrev && quat.dot(prev, r) < 0) quat.scale(r, r, -1);
            quat.copy(prev, r);
            havePrev = true;

            if (keyed.t) out.t.push(t[0], t[1], t[2]); else out.t.push(restT[0], restT[1], restT[2]);
            if (keyed.s) out.s.push(s[0], s[1], s[2]); else out.s.push(restS[0], restS[1], restS[2]);
            if (keyed.r) out.r.push(r[0], r[1], r[2], r[3]); else out.r.push(restR[0], restR[1], restR[2], restR[3]);
        }

        // Emit only what moves or differs from the rest: on the retarget's raw path a translation
        // channel passes straight through, overwriting the target's own bone offsets.
        if (varies(out.t, 3, restT)) addChannel(node, 'translation', times.slice(), out.t);
        if (varies(out.r, 4, restR)) addChannel(node, 'rotation', times.slice(), out.r);
        if (varies(out.s, 3, restS)) addChannel(node, 'scale', times.slice(), out.s);
    }

    return { ...clip, samplers, channels };
}

// Whether a sampled track is worth a channel: false when every key equals `rest`, which the bone's
// fallback already produces. A track holding a constant OFFSET is kept.
function varies(out: number[], size: number, rest: ArrayLike<number>): boolean {
    const EPS = 1e-5;
    for (let i = 0; i < out.length; i += size) {
        for (let k = 0; k < size; k++) if (Math.abs(out[i + k] - rest[k]) > EPS) {
            // A quaternion and its negation are the same rotation; only a real difference counts.
            if (size !== 4) return true;
            let opposite = true;
            for (let j = 0; j < 4; j++) if (Math.abs(out[i + j] + rest[j]) > EPS) { opposite = false; break; }
            if (!opposite) return true;
            break;
        }
    }
    return false;
}

/** Every keyframe time any of `nodes` is keyed at, sorted and de-duplicated. */
function unionTimes(nodes: number[], perNode: Map<number, NodeChannels>): number[] {
    const set = new Set<number>();
    for (const n of nodes) {
        const ch = perNode.get(n);
        if (!ch) continue;
        for (const sampler of [ch.translation, ch.rotation, ch.scale])
            if (sampler) for (const time of sampler.input) set.add(time);
    }
    return [...set].sort((a, b) => a - b);
}

/** A node's local matrix at `time`: its keyed channels where it has them, its rest where it does not. */
function sampleLocal(out: mat4, _node: number, time: number, channels: NodeChannels | undefined, rest: mat4 | undefined): mat4 {
    const t = vec3.create(), s = vec3.fromValues(1, 1, 1), r = quat.create();
    if (rest) {
        mat4.getTranslation(t, rest);
        mat4.getScaling(s, rest);
        mat4.getRotation(r, rest);
        quat.normalize(r, r);
    }
    if (channels?.translation) sampleVec(t, channels.translation, time, 3);
    if (channels?.scale) sampleVec(s, channels.scale, time, 3);
    if (channels?.rotation) sampleQuat(r, channels.rotation, time);
    return mat4.fromRotationTranslationScale(out, r, t, s);
}

// Where `time` sits in a sampler's keys. CUBICSPLINE is read at a stride of three and interpolated
// LINEARLY — an approximation, and one assimp's glTF2 exporter never produces.
function locate(sampler: AnimationSampler, time: number): { i: number; f: number; stride: number } {
    const stride = sampler.interpolation === 'CUBICSPLINE' ? 3 : 1;
    const input = sampler.input;
    if (input.length === 0) return { i: 0, f: 0, stride };
    if (time <= input[0]) return { i: 0, f: 0, stride };
    if (time >= input[input.length - 1]) return { i: input.length - 1, f: 0, stride };
    let i = 0;
    while (i < input.length - 1 && input[i + 1] <= time) i++;
    const span = input[i + 1] - input[i];
    return { i, f: span > 1e-9 ? (time - input[i]) / span : 0, stride };
}

function sampleVec(out: vec3, sampler: AnimationSampler, time: number, size: number): void {
    const { i, f, stride } = locate(sampler, time);
    const base = (i * stride + (stride === 3 ? 1 : 0)) * size;
    const next = ((i + 1) * stride + (stride === 3 ? 1 : 0)) * size;
    const step = sampler.interpolation === 'STEP' || f === 0 || next + size > sampler.output.length;
    for (let c = 0; c < size; c++) {
        const a = sampler.output[base + c] ?? out[c];
        out[c] = step ? a : a + ((sampler.output[next + c] ?? a) - a) * f;
    }
}

function sampleQuat(out: quat, sampler: AnimationSampler, time: number): void {
    const { i, f, stride } = locate(sampler, time);
    const base = (i * stride + (stride === 3 ? 1 : 0)) * 4;
    const next = ((i + 1) * stride + (stride === 3 ? 1 : 0)) * 4;
    const a = quat.fromValues(
        sampler.output[base] ?? out[0], sampler.output[base + 1] ?? out[1],
        sampler.output[base + 2] ?? out[2], sampler.output[base + 3] ?? out[3]);
    if (sampler.interpolation === 'STEP' || f === 0 || next + 4 > sampler.output.length) {
        quat.normalize(out, a);
        return;
    }
    const b = quat.fromValues(
        sampler.output[next], sampler.output[next + 1], sampler.output[next + 2], sampler.output[next + 3]);
    quat.slerp(out, quat.normalize(a, a), quat.normalize(b, b), f);
    quat.normalize(out, out);
}
