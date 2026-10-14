import { Geometry } from '../core/geometry';
import { Model, Submesh } from './model';
import { AnimatedModel } from '../animation/animatedModel';

// Splitting a merged mesh: the reverse of modelMerge.ts. A merged model is ONE geometry drawn in index
// ranges (`submeshes`), one material each; cutting a range out means keeping only the vertices its
// triangles reference, renumbered, with every per-vertex attribute — joint weights included — compacted
// the same way. A skinned piece keeps its skin as is: joint indices are skin-space, never per-part.

const EMPTY = new Float32Array(0);

/** The ranges a model draws: its submeshes, or the whole index buffer as one. */
export function drawRanges(model: { geometry: Geometry; submeshes: Submesh[] }): Submesh[] {
    return model.submeshes.length ? model.submeshes : [{ start: 0, count: model.geometry.indices.length }];
}

/** The plain arrays of a compacted geometry. GL-free, so the arithmetic is testable on its own. */
export interface CompactedRanges {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    tangents: Float32Array;
    bitangents: Float32Array;
    indices: Uint32Array;
    jointIndices: Float32Array | null;
    jointWeights: Float32Array | null;
    /** The kept ranges' new positions in `indices`, in the order given. */
    submeshes: Submesh[];
}

/**
 * Keep only `ranges` of `geometry`: the vertices their triangles use, renumbered in first-use order (so
 * a vertex two kept ranges share stays shared), every attribute carried, and the ranges laid end to end.
 */
export function compactRanges(geometry: Geometry, ranges: Submesh[],
                              jointIndices: Float32Array | null = null,
                              jointWeights: Float32Array | null = null): CompactedRanges {
    const src = geometry.indices;
    const remap = new Map<number, number>();
    const order: number[] = [];
    let total = 0;
    for (const r of ranges) total += r.count;
    const indices = new Uint32Array(total);
    const submeshes: Submesh[] = [];
    let w = 0;
    for (const r of ranges) {
        submeshes.push({ start: w, count: r.count });
        for (let i = r.start; i < r.start + r.count; i++) {
            const old = src[i];
            let fresh = remap.get(old);
            if (fresh === undefined) { fresh = order.length; remap.set(old, fresh); order.push(old); }
            indices[w++] = fresh;
        }
    }
    const gather = (attr: ArrayLike<number> | null | undefined, size: number): Float32Array => {
        if (!attr || attr.length === 0) return EMPTY;
        const out = new Float32Array(order.length * size);
        for (let v = 0; v < order.length; v++)
            for (let k = 0; k < size; k++) out[v * size + k] = attr[order[v] * size + k] ?? 0;
        return out;
    };
    return {
        positions: gather(geometry.positions, 3),
        normals: gather(geometry.normals, 3),
        uvs: gather(geometry.uvs, 2),
        tangents: gather(geometry.tangents, 3),
        bitangents: gather(geometry.bitangents, 3),
        indices,
        jointIndices: jointIndices ? gather(jointIndices, 4) : null,
        jointWeights: jointWeights ? gather(jointWeights, 4) : null,
        submeshes,
    };
}

/** Build a model of the same kind as `source` from kept range indices `keep` (into `drawRanges`). */
function rebuild(source: Model | AnimatedModel, keep: number[]): Model | AnimatedModel {
    const ranges = drawRanges(source);
    const animated = source instanceof AnimatedModel;
    const c = compactRanges(source.geometry, keep.map(i => ranges[i]),
        animated ? (source as AnimatedModel).jointIndices : null,
        animated ? (source as AnimatedModel).jointWeights : null);
    // Tangents were carried, not recomputed: the source's are already right for these vertices.
    const haveTangents = c.tangents.length > 0 && c.bitangents.length > 0;
    const geometry = new Geometry(c.positions, c.normals, c.uvs, c.tangents, c.bitangents, c.indices, !haveTangents);
    const materials = keep.map(i => source.materials[i] ?? source.materials[0]);
    // One range is a whole-buffer draw: no submesh list, exactly as an unmerged model has.
    const submeshes = keep.length > 1 ? c.submeshes : [];
    if (animated) {
        const a = source as AnimatedModel;
        return new AnimatedModel(geometry, materials, a.skin ?? undefined, c.jointIndices ?? undefined,
            c.jointWeights ?? undefined, a.animations, submeshes);
    }
    return new Model(geometry, materials, submeshes);
}

function checkIndex(model: Model | AnimatedModel, index: number): void {
    const n = drawRanges(model).length;
    if (!Number.isInteger(index) || index < 0 || index >= n)
        throw new RangeError(`sub-mesh ${index} does not exist (the model has ${n})`);
}

/** Sub-mesh `index` of `model` as a model of its own: its material, only its vertices. */
export function extractSubmesh(model: Model | AnimatedModel, index: number): Model | AnimatedModel {
    checkIndex(model, index);
    return rebuild(model, [index]);
}

/** `model` without sub-mesh `index`; the others keep their order and materials. Needs two or more. */
export function withoutSubmesh(model: Model | AnimatedModel, index: number): Model | AnimatedModel {
    checkIndex(model, index);
    const n = drawRanges(model).length;
    if (n < 2) throw new RangeError('cannot remove the only sub-mesh');
    return rebuild(model, Array.from({ length: n }, (_, i) => i).filter(i => i !== index));
}
