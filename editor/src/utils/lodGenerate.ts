import { Node, ModelNode, Model, Geometry, AnimatedModel } from 'cleo'
import type { SimplifyBuffers } from './simplify'
import { buildModelAsset, flattenModelAsset, type ModelAsset } from './models'
import { getMaterialIdsOf, applyMaterialAssets, type MaterialAsset } from './materials'
import { downscaleTextures, materialAssetWithTextures } from './lodTextures'

// Building one generated LOD level of a model: decimate every sub-mesh, point it at half-resolution
// copies of its textures, and hand back a ModelAsset ready for the library.
//
// A level is a REFERENCE to its own model asset (`ModelLodDef.modelId`), not embedded geometry, so this
// mints a first-class library asset. Two rules that come with that: the generated asset must carry no
// `lods`/`cullDistance` of its own (the viewport refuses to nest LOD-bearing assets inside a model being
// edited), and it needs its OWN materials — at instantiation `resolveMaterialRefs` overwrites a
// subtree's embedded material from the library via `__materialId`, so a level sharing the source's
// material ids would silently draw at full texture resolution.

/** What the user asked for, per level. */
export interface LodLevelSpec {
    /** Fraction of LOD0's triangles to keep. */
    ratio: number
    /** Camera distance at which this level takes over. */
    distance: number
}

export interface GeneratedLevel {
    asset: ModelAsset
    materials: MaterialAsset[]
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

/**
 * Build one LOD level from a live model subtree.
 *
 * `decimate` is injected rather than imported so the caller decides whether it runs in the project
 * worker or inline — the algorithm itself is deliberately free of both.
 *
 * Skinned models are refused by the caller, not here: decimating one means rebuilding four joint
 * influences per vertex and capping them, and a bad collapse tears the silhouette at a joint. The model
 * editor already refuses LOD authoring for skinned assets, so this inherits that rather than widening it.
 */
export async function generateLodLevel(
    baseRoot: Node,
    level: number,
    spec: LodLevelSpec,
    options: {
        modelName: string
        sourceModelId: string
        materials: MaterialAsset[]
        downscaleTextures: boolean
        /**
         * Halvings to apply to THIS level's textures, relative to the materials on `baseRoot`.
         *
         * Not the absolute level: when levels cascade, `baseRoot` is the previous level and its
         * materials already point at downscaled twins, so halving by the absolute level again would
         * shrink 1/8 where 1/4 was asked for. Defaults to the level for a non-cascaded call.
         */
        textureHalvings?: number
        decimate: (buffers: SimplifyBuffers, ratio: number) => Promise<SimplifyBuffers>
        existingId?: string
    },
): Promise<GeneratedLevel> {
    const sources = modelNodes(baseRoot)
    const holder = new Node(`${options.modelName} LOD${level}`)
    holder.setPosition([0, 0, 0])

    // One derived material per SOURCE material, shared by every part that used it — two sub-meshes on
    // one material must not end up on two copies of it.
    const derivedMaterials = new Map<string, MaterialAsset>()
    const materialIds: string[] = []
    let bytesSaved = 0
    let triangles = 0

    for (const source of sources) {
        const model = source.model
        const geometry = model.geometry
        const submeshes = model.hasSubmeshes ? model.submeshes.map(s => ({ start: s.start, count: s.count })) : undefined
        const reduced = await options.decimate(buffersOf(geometry, submeshes), spec.ratio)

        // `calculateTangents: false` — the decimator carries the authored tangent frame through, so the
        // attribute set is stable by construction. Recomputing here would need full-length normals AND
        // uvs already in hand and would smooth the frame the source was authored with.
        const reducedGeometry = new Geometry(
            reduced.positions, reduced.normals, reduced.uvs,
            reduced.tangents, reduced.bitangents, reduced.indices, false,
        )

        // A range that decimated to nothing must lose its MATERIAL too: a Model whose submesh and
        // material counts disagree silently drops the whole submesh list and draws everything with
        // materials[0].
        const sourceMatIds = getMaterialIdsOf(source)
        const ranges = reduced.submeshes ?? []
        const keep = ranges.map((r, i) => ({ r, i })).filter(x => x.r.count > 0)
        const usedMatIds = ranges.length > 1 ? keep.map(x => sourceMatIds[x.i]) : sourceMatIds.slice(0, 1)

        const levelMaterials: (MaterialAsset | undefined)[] = []
        for (const matId of usedMatIds) {
            if (!matId) { levelMaterials.push(undefined); continue }
            let derived = derivedMaterials.get(matId)
            if (!derived) {
                const sourceAsset = options.materials.find(m => m.id === matId)
                if (!sourceAsset) { levelMaterials.push(undefined); continue }
                let ids = new Map<string, string>()
                if (options.downscaleTextures) {
                    const result = await downscaleTextures(sourceAsset.textureIds ?? [], options.textureHalvings ?? level)
                    ids = result.ids
                    bytesSaved += result.bytesSaved
                }
                derived = materialAssetWithTextures(sourceAsset, ids, `${sourceAsset.name} LOD${level}`)
                derivedMaterials.set(matId, derived)
            }
            levelMaterials.push(derived)
            if (!materialIds.includes(derived.id)) materialIds.push(derived.id)
        }

        // Rebuild the ranges contiguously over the kept slices only, so they stay parallel to the
        // materials above and still tile the index buffer.
        const keptRanges: { start: number; count: number }[] = []
        let at = 0
        for (const { r } of keep) { keptRanges.push({ start: at, count: r.count }); at += r.count }

        const placeholder = model.materials[0]
        const node = new ModelNode(source.name, new Model(
            reducedGeometry,
            levelMaterials.map((m, i) => (m ? model.materials[i] ?? placeholder : placeholder)),
            keptRanges.length > 1 ? keptRanges : [],
        ))
        node.setPosition(source.position as any)
        node.setRotation(source.rotation as any)
        node.setScale(source.scale as any)
        holder.addChild(node)
        // Stamps __materialId/__materialIds and rebuilds the node's live materials from the assets.
        if (levelMaterials.some(Boolean)) applyMaterialAssets(node, levelMaterials)
        triangles += Math.floor(reduced.indices.length / 3)
    }

    holder.updateTransforms()
    const asset = flattenModelAsset(await buildModelAsset(holder, materialIds, '', options.existingId))
    asset.name = `${options.modelName} LOD${level}`
    // Provenance, so a later regeneration updates these instead of minting a second set.
    asset.lodSource = { modelId: options.sourceModelId, level }
    // A generated level must never carry levels of its own.
    delete asset.lods
    delete asset.cullDistance

    return {
        asset,
        materials: [...derivedMaterials.values()],
        sourceTriangles: subtreeTriangles(baseRoot),
        triangles,
        bytesSaved,
    }
}
