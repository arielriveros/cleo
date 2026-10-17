import { Node, ModelNode, Geometry, AnimatedModel, serializeGeometry } from 'cleo'
import type { SimplifyBuffers } from './simplify'
import { MATERIAL_ID_VAR, MATERIAL_IDS_VAR } from './materials'
import { downscaleTextures, levelMaterialJson, levelTextureIds } from './lodTextures'

// Building one generated LOD level of a model: decimate every sub-mesh, give it an INLINE copy of its
// material pointing at smaller textures, and hand back the level's serialized subtree.
//
// A generated level is EMBEDDED in its source model (`ModelLodDef.nodeJson`, `generated: true`), never a
// library asset of its own. So there is nothing to show in the explorer, nothing a level could generate
// levels from, and nothing left behind when the model is deleted. Two rules follow from that:
//
// - The level's materials are its own, inline, and carry NO `__materialId` link: at instantiation
//   `resolveMaterialRefs` overwrites any linked material from the library, which would put the full-size
//   textures straight back.
// - The level is the source subtree with its geometry swapped, not a rebuilt one. The source's root
//   transform, every intermediate group and every nested part keep their transforms and parents, so a
//   model moved 5 units up before generating has every level 5 units up too.

/** What the user asked for, per level. */
export interface LodLevelSpec {
    /** Fraction of LOD0's triangles to keep. */
    ratio: number
    /** Camera distance at which this level takes over. */
    distance: number
}

export interface GeneratedLevel {
    /** The level's subtree, ready to embed as `ModelLodDef.nodeJson`. */
    nodeJson: any
    sourceTriangles: number
    triangles: number
    bytesSaved: number
}

/** Every ModelNode in a subtree, depth-first, self first. */
function modelNodes(root: Node, out: ModelNode[] = []): ModelNode[] {
    if (root instanceof ModelNode) out.push(root)
    for (const child of root.children) modelNodes(child, out)
    return out
}

const buffersOf = (g: Geometry, submeshes?: { start: number; count: number }[]): SimplifyBuffers => ({
    positions: g.positions, normals: g.normals, uvs: g.uvs,
    tangents: g.tangents, bitangents: g.bitangents, indices: g.indices,
    submeshes,
})

/** True when any part of the subtree is skinned. LOD generation refuses those; see generateLodLevel. */
export function hasSkinnedPart(root: Node): boolean {
    return modelNodes(root).some(n => n.model instanceof AnimatedModel)
}

export function subtreeTriangles(root: Node): number {
    return modelNodes(root).reduce((n, m) => n + Math.floor(m.model.geometry.indices.length / 3), 0)
}

/** Serialized node by id, anywhere in a subtree. */
function indexJson(json: any, out = new Map<string, any>()): Map<string, any> {
    if (!json || typeof json !== 'object') return out
    if (typeof json.id === 'string') out.set(json.id, json)
    if (Array.isArray(json.children)) for (const c of json.children) indexJson(c, out)
    return out
}

/** Remove every material-asset link from a serialized subtree (see the header: inline materials only). */
export function stripMaterialLinks(json: any): void {
    if (!json || typeof json !== 'object') return
    if (json.variables) {
        delete json.variables[MATERIAL_ID_VAR]
        delete json.variables[MATERIAL_IDS_VAR]
    }
    if (Array.isArray(json.children)) for (const c of json.children) stripMaterialLinks(c)
}

/**
 * Build one LOD level from a live model subtree.
 *
 * `baseRoot` is LOD0, or the previous level when levels cascade. `decimate` is injected rather than
 * imported so the caller decides whether it runs in the project worker or inline.
 *
 * Skinned models are refused by the caller, not here: decimating one means rebuilding four joint
 * influences per vertex and capping them, and a bad collapse tears the silhouette at a joint.
 */
export async function generateLodLevel(
    baseRoot: Node,
    level: number,
    spec: LodLevelSpec,
    options: {
        downscaleTextures: boolean
        /**
         * Halvings to apply to THIS level's textures, relative to the materials on `baseRoot`.
         *
         * Not the absolute level: when levels cascade, `baseRoot` is the previous level and its materials
         * already point at downscaled twins, so halving by the absolute level again would shrink 1/8 where
         * 1/4 was asked for. Defaults to the level for a non-cascaded call.
         */
        textureHalvings?: number
        decimate: (buffers: SimplifyBuffers, ratio: number) => Promise<SimplifyBuffers>
    },
): Promise<GeneratedLevel> {
    // The level starts as an exact copy of the source subtree — hierarchy, names, transforms, variables.
    const nodeJson = await baseRoot.serialize()
    const byId = indexJson(nodeJson)
    const sources = modelNodes(baseRoot)

    // Smaller twins of every texture this level keeps, made once for the whole level so parts sharing a
    // texture share its twin. From level 2 on only colour, normal and mask survive (DISTANT_LOD_SLOTS).
    const keptIds = new Set<string>()
    for (const source of sources)
        for (const material of source.model.materials) for (const id of levelTextureIds(material.serialize(), level)) keptIds.add(id)
    let ids = new Map<string, string>()
    let bytesSaved = 0
    if (options.downscaleTextures && keptIds.size) {
        const result = await downscaleTextures(keptIds, options.textureHalvings ?? level)
        ids = result.ids
        bytesSaved = result.bytesSaved
    }

    let triangles = 0
    for (const source of sources) {
        const target = byId.get(source.id)
        if (!target) continue // not serialized (editor-owned): nothing to replace
        const model = source.model
        const geometry = model.geometry
        const submeshes = model.hasSubmeshes ? model.submeshes.map(s => ({ start: s.start, count: s.count })) : undefined
        const reduced = await options.decimate(buffersOf(geometry, submeshes), spec.ratio)

        // `calculateTangents: false` — the decimator carries the authored tangent frame through, so the
        // attribute set is stable by construction.
        const reducedGeometry = new Geometry(
            reduced.positions, reduced.normals, reduced.uvs,
            reduced.tangents, reduced.bitangents, reduced.indices, false,
        )

        // A range that decimated to nothing must lose its MATERIAL too: a Model whose submesh and material
        // counts disagree silently drops the whole submesh list and draws everything with materials[0].
        const ranges = reduced.submeshes ?? []
        const keep = ranges.map((r, i) => ({ r, i })).filter(x => x.r.count > 0)
        const sourceMaterials = ranges.length > 1 ? keep.map(x => model.materials[x.i]) : [model.materials[0]]
        const fallback = model.materials[0]
        const materials = sourceMaterials.map(m => levelMaterialJson((m ?? fallback).serialize(), ids, level))

        // Ranges rebuilt contiguously over the kept slices, parallel to the materials above.
        const keptRanges: { start: number; count: number }[] = []
        let at = 0
        for (const { r } of keep) { keptRanges.push({ start: at, count: r.count }); at += r.count }

        // Only the MODEL payload is swapped — written in `Model.serialize`'s own shape, without building a
        // Model (that would allocate a GPU mesh nobody draws) — and the node's transform, name, variables
        // and children stay exactly as serialized.
        const swapped: any = { ...target.model, geometry: serializeGeometry(reducedGeometry), material: materials[0] }
        if (keptRanges.length > 1) { swapped.materials = materials; swapped.submeshes = keptRanges }
        else { delete swapped.materials; delete swapped.submeshes }
        target.model = swapped
        triangles += Math.floor(reduced.indices.length / 3)
    }

    stripMaterialLinks(nodeJson)
    return { nodeJson, sourceTriangles: subtreeTriangles(baseRoot), triangles, bytesSaved }
}
