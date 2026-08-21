import { Geometry } from '../core/geometry';
import { Material } from './material';
import { Model, Submesh } from './model';
import { AnimatedModel, Animation, Skin } from './animatedModel';

/**
 * Merging several models into one mesh with one submesh per material.
 *
 * A character exported from most DCC tools arrives split — glTF mandates one primitive per material, and
 * tools additionally split a body across several mesh objects. Each of those becomes its own `ModelNode`,
 * which means its own draw call, its own `Animator`, and its own 100-mat4 bone upload *per pass and per
 * shadow cascade*. Worse for skinned models, the editor binds an animation to the FIRST skinned child it
 * finds, so half a two-part character would sit in bind pose.
 *
 * Merging is only legal under conditions this module enforces rather than assumes:
 *  - **Same skin object.** Joint indices address `skin.joints` order, so parts of one imported character
 *    share an index space and concatenate with no remapping. Parts from different skins do not.
 *  - **Same material `type` and `transparent` flag.** The renderer picks a pass, a shader and a sort key
 *    per NODE from `materials[0]`; a model whose submeshes disagreed on those would have to be in two
 *    passes at once.
 *  - **No per-part transform.** Vertices are concatenated verbatim. glTF gives skinned nodes no node
 *    transform (they are posed by the skeleton), and a skinned part must never have one baked in.
 */

/**
 * The parts of a model {@link mergeBlocker} needs to see.
 *
 * Structural rather than `Model | AnimatedModel` so the rules can be unit-tested: constructing a real
 * `Model` builds a `Mesh`, which needs a GL context the test suite deliberately does not have.
 */
export type MergePart = {
    materials: { type: string; config: { transparent?: boolean } }[];
    hasSubmeshes: boolean;
    /** Present and non-null on a skinned part. */
    skin?: unknown;
};

/** Why a set of models cannot be merged, or null when they can. */
export function mergeBlocker(models: MergePart[]): string | null {
    if (models.length < 2) return 'nothing to merge';

    const firstMat = models[0].materials[0];
    for (const m of models) {
        if (m.hasSubmeshes) return 'a part is already merged';
        const mat = m.materials[0];
        if (mat.type !== firstMat.type)
            return `mixed material types (${firstMat.type} and ${mat.type})`;
        if (!!mat.config.transparent !== !!firstMat.config.transparent)
            return 'mixed opaque and transparent parts';
    }

    // 'skin' in m distinguishes an AnimatedModel from a Model; the value distinguishes a skinned one.
    const skinned = models.filter(m => 'skin' in m && m.skin);
    if (skinned.length && skinned.length !== models.length)
        return 'mixed skinned and static parts';
    if (skinned.length) {
        // Reference equality on purpose: two structurally identical skins parsed separately are still
        // two joint index spaces, and concatenating across them corrupts the binding silently.
        const skin = skinned[0].skin;
        if (skinned.some(m => m.skin !== skin)) return 'parts are bound to different skeletons';
    }
    return null;
}

/** A merged model plus which source model each of its submeshes came from. */
export interface MergedModel {
    model: Model | AnimatedModel;
    /**
     * `sources[i]` is the index in `models` that submesh `i` came from — the first part of its run when
     * consecutive parts were collapsed.
     *
     * Returned because `materials` is NOT a de-duplicated set: a material that recurs non-consecutively
     * appears once per run. A caller building anything parallel to the submeshes (the editor stamps one
     * material-asset link per submesh) cannot reconstruct that by de-duplicating the inputs itself, and
     * silently mis-aligning the two is how links ended up on the wrong ranges.
     */
    sources: number[];
}

/**
 * Concatenate `models` into a single model carrying one submesh per run of parts sharing a material.
 *
 * Returns null when {@link mergeBlocker} rejects them, so callers can report the reason rather than
 * producing a subtly wrong mesh. Materials are kept in input order; only CONSECUTIVE parts that share a
 * material object collapse into one submesh, because only contiguous index ranges can be drawn as one.
 */
export function mergeModels(models: (Model | AnimatedModel)[]): MergedModel | null {
    if (mergeBlocker(models) !== null) return null;

    const { geometry, ranges } = Geometry.merge(models.map(m => m.geometry));

    // CONSECUTIVE parts sharing a material object become one range, which keeps the draw count down
    // without reordering anything. Only the last group can absorb a part: `Geometry.merge` concatenates
    // in order, so any earlier group's range has already been closed off by whatever followed it. A
    // material that recurs later therefore gets a SECOND entry in `materials` — the arrays stay parallel
    // to `submeshes`, they are not a set.
    //
    // This used to test `materials.indexOf(mat)`, the FIRST occurrence, and then require it to be
    // adjacent. That failed both ways round: two consecutive parts sharing a material that had appeared
    // earlier were never merged (an avoidable extra draw call), and — the damaging half — callers read
    // `materials` as if it were de-duplicated. `sources` exists so they no longer have to guess.
    const materials: Material[] = [];
    const submeshes: Submesh[] = [];
    /** Which source model each submesh came from, parallel to `submeshes`. */
    const sources: number[] = [];
    models.forEach((m, i) => {
        const mat = m.materials[0];
        const range = ranges[i];
        const last = submeshes.length - 1;
        if (last >= 0 && materials[last] === mat && submeshes[last].start + submeshes[last].count === range.start) {
            submeshes[last] = { start: submeshes[last].start, count: submeshes[last].count + range.count };
            return;
        }
        materials.push(mat);
        submeshes.push({ start: range.start, count: range.count });
        sources.push(i);
    });

    const animated = models.filter((m): m is AnimatedModel => m instanceof AnimatedModel);
    if (!animated.length) return { model: new Model(geometry, materials, submeshes), sources };

    // Joint attributes are 4 floats per vertex in the same vertex order as the geometry, so they
    // concatenate exactly as the positions did — and, sharing one skin, need no index remapping.
    // Read the counts off `animated`, not `models`: the blocker guarantees they are the same list, and
    // taking them from one array keeps the two from ever drifting out of step.
    const counts = animated.map(m => m.geometry.vertexCount);
    const jointIndices = concatJointAttributes(animated.map(m => m.jointIndices), counts);
    const jointWeights = concatJointAttributes(animated.map(m => m.jointWeights), counts);
    const skin = animated[0].skin as Skin;
    const animations: Animation[] = animated[0].animations ?? [];

    return {
        model: new AnimatedModel(geometry, materials, skin, jointIndices, jointWeights, animations, submeshes),
        sources,
    };
}

/**
 * Concatenate per-vertex 4-float joint attributes, padding any part that is short or absent.
 *
 * The padding matters more than it looks: these arrays are indexed by vertex, so a part that contributed
 * vertices but no joint data would shift every LATER vertex onto another vertex's bones — a silent,
 * scrambled deformation rather than an error. Zeros are the right filler because
 * `AnimatedModel._initializeMesh` already treats an all-zero weight set as "fully weighted to joint 0".
 *
 * Exported for tests: it is the one piece of the merge whose failure mode is invisible.
 */
export function concatJointAttributes(parts: (Float32Array | null)[], vertexCounts: number[]): Float32Array {
    const total = vertexCounts.reduce((n, c) => n + c, 0);
    const out = new Float32Array(total * 4);
    let base = 0;
    for (let i = 0; i < parts.length; i++) {
        const src = parts[i];
        const wanted = vertexCounts[i] * 4;
        if (src && src.length >= wanted) out.set(src.subarray(0, wanted), base * 4);
        else if (src && src.length) out.set(src, base * 4);
        base += vertexCounts[i];
    }
    return out;
}
