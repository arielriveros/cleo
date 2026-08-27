import { Geometry } from '../core/geometry';
import { Material } from './material';
import { Model, Submesh } from './model';
import { AnimatedModel, Animation, Skin } from './animatedModel';

// Merging several models into one mesh with one submesh per material. Legal only when the parts share a
// skin object, a material `type` and `transparent` flag, and carry no per-part transform.

/** The parts of a model {@link mergeBlocker} needs to see. Structural, so it is testable without a GL context. */
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

    const skinned = models.filter(m => 'skin' in m && m.skin);
    if (skinned.length && skinned.length !== models.length)
        return 'mixed skinned and static parts';
    if (skinned.length) {
        // Reference equality: two structurally identical skins are still two joint index spaces.
        const skin = skinned[0].skin;
        if (skinned.some(m => m.skin !== skin)) return 'parts are bound to different skeletons';
    }
    return null;
}

/** A merged model plus which source model each of its submeshes came from. */
export interface MergedModel {
    model: Model | AnimatedModel;
    /**
     * `sources[i]` is the index in `models` that submesh `i` came from. Needed because `materials` is
     * not de-duplicated: a material recurring non-consecutively appears once per run.
     */
    sources: number[];
}

/**
 * Concatenate `models` into a single model with one submesh per run of parts sharing a material, or
 * null when {@link mergeBlocker} rejects them. Only consecutive parts collapse; input order is kept.
 */
export function mergeModels(models: (Model | AnimatedModel)[]): MergedModel | null {
    if (mergeBlocker(models) !== null) return null;

    const { geometry, ranges } = Geometry.merge(models.map(m => m.geometry));

    // Only the LAST group can absorb a part, so a material recurring later gets a second entry:
    // `materials` stays parallel to `submeshes` rather than being a set.
    const materials: Material[] = [];
    const submeshes: Submesh[] = [];
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

    // Joint attributes are 4 floats per vertex in geometry order and share one skin, so they
    // concatenate with no index remapping.
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
 * Concatenate per-vertex 4-float joint attributes, zero-padding any part that is short or absent so
 * later vertices keep their alignment.
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
