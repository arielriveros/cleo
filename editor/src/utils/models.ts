import { Node, ModelNode, AnimatedModel, Logger, TextureManager, mergeBlocker, mergeModels } from 'cleo'
import { cryptoRandomId } from './ids'
import { parseByType, stripDebug, collectTextureIds, regenerateIds } from './nodeSubtree'
import { resolveMaterialRefs, applyMaterialAsset, applyMaterialAssets, serializedVar, getMaterialIdsOf, MATERIAL_ID_VAR, MaterialAsset } from './materials'
import { skinnedModelJsonOf as skinnedJson, flattenModelAsset } from './modelClips'
import type { AnimationAsset } from './animationAssets'
import { applyModelAnimations } from './animationResolve'

// A note on vocabulary, because the editor used to get this wrong:
//
//   Mesh  — the GPU-side structure (VAO/VBO/index buffers holding vertices, indices, UVs). Internal to
//           the engine. This is not a modelling tool, so a mesh is never something the user authors.
//   Model — one Geometry + one Material (src/graphics/model.ts). This is the reusable, placeable thing.
//
// What this module defines is therefore a MODEL asset: a named, thumbnailed subtree of ModelNodes that
// share a material, with optional LOD levels and a cull distance. An imported .gltf/.glb/.obj/.fbx is a
// model (geometry *and* material), not a mesh.

// Node variable linking a placed instance back to its source model asset (mirrors TEMPLATE_ID_VAR /
// MATERIAL_ID_VAR). Saving a model asset re-instantiates every scene node carrying it
// (syncModelInstances in EngineContext), the same way template edits propagate.
//
// NOTE: this string is serialized into every placed instance. It was '__meshId' before the model
// rename; readers still accept the old spelling (see LEGACY_MODEL_ID_VAR) so older data keeps resolving.
export const MODEL_ID_VAR = '__modelId'

/** The pre-rename spelling of MODEL_ID_VAR, still read so unmigrated data keeps resolving. */
export const LEGACY_MODEL_ID_VAR = '__meshId'

/**
 * Walk up to the placed model-instance root — the nearest ancestor (or self) carrying `__modelId`.
 *
 * The walk is not optional. A model asset instantiates as *a parent Node holding one ModelNode per
 * sub-mesh* (see parseBundleToRoot), so `__modelId` lands on the HOLDER while the skinned ModelNode — the
 * only node the animation UI applies to — is a child of it. Reading the variable off the selected node
 * alone finds nothing for every normally-imported character.
 *
 * Mirrors templateInstanceRootOf (templates.ts) in shape and purpose.
 */
export function modelInstanceRootOf(node: Node | null | undefined): Node | null {
  let n: Node | null | undefined = node
  while (n) {
    if (n.getVariable(MODEL_ID_VAR) ?? n.getVariable(LEGACY_MODEL_ID_VAR)) return n
    n = n.parent
  }
  return null
}

/** The model asset id a node belongs to (its own or an ancestor's), or undefined. */
export function modelIdOf(node: Node | null | undefined): string | undefined {
  const root = modelInstanceRootOf(node)
  if (!root) return undefined
  return root.getVariable(MODEL_ID_VAR) ?? root.getVariable(LEGACY_MODEL_ID_VAR)
}

/**
 * The first skinned ModelNode AT or BENEATH `node` (depth-first, self first), or null.
 *
 * Walks DOWN, the mirror of modelInstanceRootOf's walk up: an imported character is a holder Node with the
 * skinned ModelNode as a CHILD, so any inspector that keys off "is there an animation to edit here" has to
 * look into the subtree of whatever the user selected — the holder, a template root, or the model node itself.
 * The gate matches the one the animation UI needs: an AnimatedModel with a skin AND a live animator (the
 * ModelNode constructor creates the animator for exactly this case). First match on purpose, the same choice
 * skinnedModelJsonOf makes for a multi-part model.
 */
export function skinnedModelNodeOf(node: Node | null | undefined): ModelNode | null {
  if (!node) return null
  if (node instanceof ModelNode && node.model instanceof AnimatedModel && node.model.hasSkin && !!node.animator)
    return node
  for (const child of node.children) {
    const found = skinnedModelNodeOf(child)
    if (found) return found
  }
  return null
}

/**
 * One extra LOD level of a model asset: a **reference** to another model asset, plus the camera distance
 * at which it takes over.
 *
 * Levels used to embed a copy of their subtree (`nodeJson`). Referencing instead means a level is authored
 * and re-authored like any other model — edit the low-poly asset once and every model using it as a LOD
 * follows — rather than being a frozen copy that could only be replaced by re-importing a file.
 */
export type ModelLodDef = {
  distance: number
  /** The model asset rendered at this level. */
  modelId?: string
  /** Legacy: an embedded copy of the level's subtree, written before levels became references. Still
   *  read so existing assets keep working; never written. */
  nodeJson?: any
}

/**
 * The subtree a LOD level renders, or null if it cannot be resolved — a reference whose model asset was
 * deleted, or a legacy level with no embedded copy.
 *
 * Only the referenced asset's OWN subtree is used, never its LOD levels, so a chain of references cannot
 * recurse (and a model referencing itself degrades to a duplicate level rather than hanging).
 */
export function lodLevelJson(lod: ModelLodDef, models?: ModelAsset[]): any | null {
  if (lod.modelId) return models?.find(m => m.id === lod.modelId)?.nodeJson ?? null
  return lod.nodeJson ?? null
}

/** Resolved LOD levels, dangling references dropped (with their distances) so indices stay aligned. */
export function resolvedLods(asset: ModelAsset, models?: ModelAsset[]): { nodeJson: any; distance: number }[] {
  const out: { nodeJson: any; distance: number }[] = []
  for (const lod of asset.lods ?? []) {
    const nodeJson = lodLevelJson(lod, models)
    if (nodeJson) out.push({ nodeJson, distance: lod.distance })
  }
  return out
}

// A reusable, named model imported from file(s): a serialized node subtree (the parent Node with its
// child ModelNodes) plus every texture it embeds and a rendered thumbnail. Materials are embedded in
// the subtree (self-contained) and additionally linked to Material library assets via __materialId.
export type ModelAsset = {
  id: string
  name: string
  nodeJson: any          // serialized parent Node subtree (child ModelNodes; materials embedded + __materialId)
  /** TextureManager ids this subtree references. The payloads live in the texture store (textureStore.ts). */
  textureIds?: string[]
  /** Legacy: textures embedded as base64 ([{ id, data, config }]). Still read; never written. */
  textures?: any[]
  materialIds: string[]  // MaterialAsset ids this model references (informational)
  thumbnail: string      // base64 PNG data URL
  /** Extra LOD levels (ascending distance). Absent/empty = single-level model. */
  lods?: ModelLodDef[]
  /** Hide placed instances beyond this camera distance; 0/absent = never cull. */
  cullDistance?: number
  /**
   * Shared animation assets this model plays, by id (see utils/animationAssets.ts).
   *
   * The clips themselves are NOT stored here: they live once in the animation library, in their source
   * rig's space, and are retargeted onto this model's skeleton when it is instantiated. That is what lets
   * two characters on the same rig share one stored walk. Clips embedded directly in `nodeJson` still
   * play — importing one no longer puts it there, but nothing removes an existing one.
   */
  animationIds?: string[]
}

/**
 * Snapshot a live node subtree into a saveable model asset.
 *
 * Records only the texture IDS the subtree uses; the payloads live once in the texture store. Embedding
 * them here duplicated every map the model's materials had already embedded themselves.
 */
export async function buildModelAsset(
  root: Node,
  materialIds: string[],
  thumbnail: string,
  id?: string,
  lods?: ModelLodDef[],
  cullDistance?: number,
): Promise<ModelAsset> {
  const nodeJson = await root.serialize()
  stripDebug(nodeJson)
  // A definition must never carry an instance back-link; strip it so it isn't baked in.
  if (nodeJson.variables) {
    delete nodeJson.variables[MODEL_ID_VAR]
    delete nodeJson.variables[LEGACY_MODEL_ID_VAR]
  }

  const texIds = new Set<string>()
  collectTextureIds(nodeJson, texIds)

  const asset: ModelAsset = { id: id ?? cryptoRandomId(), name: root.name, nodeJson, textureIds: [...texIds], materialIds, thumbnail }

  if (lods?.length) {
    // Reference levels carry no subtree of their own — the model they point at owns it, and owns its
    // textures, so there is nothing here to strip or collect. Only legacy embedded levels need cleaning.
    for (const lod of lods) {
      if (!lod.nodeJson) continue
      stripDebug(lod.nodeJson)
      if (lod.nodeJson.variables) {
        delete lod.nodeJson.variables[MODEL_ID_VAR]
        delete lod.nodeJson.variables[LEGACY_MODEL_ID_VAR]
      }
      collectTextureIds(lod.nodeJson, texIds)
    }
    asset.lods = lods
    asset.textureIds = [...texIds]
  }
  if (cullDistance && cullDistance > 0) asset.cullDistance = cullDistance

  return asset
}

/** True if a serialized subtree contains a skinned/animated model (LOD + foliage baking are static-only). */
export function nodeJsonHasSkinnedModel(nodeJson: any): boolean {
  if (!nodeJson || typeof nodeJson !== 'object') return false
  const m = nodeJson.model
  if (m && (m.skin || m.animations || m.jointIndices)) return true
  return Array.isArray(nodeJson.children) && nodeJson.children.some(nodeJsonHasSkinnedModel)
}

/**
 * True if a serialized subtree contains at least one model — i.e. there is actually geometry in it.
 *
 * A model asset with no ModelNodes renders as nothing. Saving one is nearly always the result of the save
 * reading the wrong subtree (an emptied parent, a node pending deletion) rather than something the user
 * meant, and persisting it silently destroys the previous content.
 */
export function nodeJsonHasModel(nodeJson: any): boolean {
  if (!nodeJson || typeof nodeJson !== 'object') return false
  if (nodeJson.model) return true
  return Array.isArray(nodeJson.children) && nodeJson.children.some(nodeJsonHasModel)
}

/** True if the asset carries LOD levels or a cull distance (i.e. it instantiates as a LodGroupNode). */
export function modelAssetHasLodBehavior(asset: ModelAsset): boolean {
  return !!asset.lods?.length || (asset.cullDistance ?? 0) > 0
}

// Skeleton + animation clips belong to the MODEL ASSET. The serialized half of that lives in modelClips.ts
// (engine-free, so it can be unit-tested); re-exported here so call sites have one import for model assets.
export {
  skinnedModelJsonOf, assetWithClipAdded, assetWithClipRenamed, assetWithClipRemoved,
  assetWithClipRootMotion, assetWithBoneNames, assetClipNames, assetWithIkRig, assetIkRig,
  flattenModelJson, flattenModelAsset, assetWithoutEmbeddedClips,
} from './modelClips'

/**
 * Bring a live subtree's skinned models up to date with their model asset: replace the clip list and merge
 * in any bone names the asset has.
 *
 * Ids, transforms, materials, scripts and bodies are untouched — this exists precisely because
 * re-instantiating the subtree (what resyncScene does for scenes) would churn node ids and break a
 * template's script/body/trigger re-keying. Returns how many models were refreshed.
 *
 * Clips and bone names ONLY. `ModelNode.model` is read-only, so geometry and sub-mesh structure cannot be
 * swapped in place; a re-imported character with different sub-meshes still has to be re-placed.
 */
export function refreshModelClips(root: Node, models: ModelAsset[], animations?: AnimationAsset[]): number {
  let count = 0
  const walk = (node: Node) => {
    const modelId = modelIdOf(node)
    const asset = modelId ? models.find(m => m.id === modelId) : undefined
    const model: any = (node as any).model
    if (asset && model instanceof AnimatedModel && model.hasSkin) {
      const json = skinnedJson(asset.nodeJson)
      if (json) {
        // Replace wholesale rather than diffing: the asset is the source of truth, so a clip deleted there
        // must disappear here too, and a rename must not leave the old name behind.
        for (const name of model.animations.map((a: any) => a.name)) model.removeAnimation(name)
        for (const clip of json.animations ?? []) model.addAnimation(clip)
        // Shared clips are not in `json` (serialize drops them), so re-resolve them from the library or a
        // refresh would silently strip every asset-backed animation off the node.
        if (animations?.length && asset.animationIds?.length) applyModelAnimations(node, asset, animations)

        const names = json.skin?.nodeNames
        if (Array.isArray(names) && names.length && model.skin) {
          const merged: Map<number, string> = model.skin.nodeNames ?? new Map<number, string>()
          for (const entry of names) merged.set(Number(entry[0]), String(entry[1]))
          model.skin.nodeNames = merged
        }
        count++
      }
    }
    for (const child of node.children) walk(child)
  }
  walk(root)
  return count
}

/** Every texture id a model asset references, whichever format it was saved in. */
export function modelAssetTextureIds(asset: ModelAsset): string[] {
  if (asset.textureIds?.length) return asset.textureIds
  return (asset.textures ?? []).map((t: any) => t?.id).filter(Boolean)
}

/**
 * The material every ModelNode in a subtree shares, or null when they disagree (or there are none).
 *
 * A model is one Geometry + one Material, so a model asset composed of several ModelNodes is only
 * coherent while they all carry the same material — that is also what lets the renderer draw the whole
 * asset in a single material batch. The model editor uses this to decide which material to hand a newly
 * added part, and to warn when an asset has drifted.
 */
export function sharedMaterialIdOf(nodeJson: any): string | null {
  // The link lives in the node's serialized `variables`, not inside model.material — the embedded
  // material is only the fallback copy (see resolveMaterialRefs).
  const ids: (string | undefined)[] = []
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (n.model) ids.push(serializedVar(n, MATERIAL_ID_VAR))
    if (Array.isArray(n.children)) n.children.forEach(walk)
  }
  walk(nodeJson)
  if (!ids.length) return null
  return ids.every(id => id && id === ids[0]) ? (ids[0] as string) : null
}

/** Every ModelNode at or beneath `node`, in tree order. */
function modelNodesOf(node: Node): Node[] {
  const out: Node[] = []
  const walk = (n: Node) => {
    if (n instanceof ModelNode) out.push(n)
    for (const child of n.children) walk(child)
  }
  walk(node)
  return out
}

/**
 * The material asset shared by the ModelNodes already under `host`, ignoring anything inside `added`.
 *
 * Used by the model editor to decide what a newly dropped part should adopt. Returns null when the host
 * has no linked material to adopt (an empty model, or one whose parts are on ad-hoc materials rather than
 * a library asset) — in which case the part keeps whatever it arrived with.
 */
function hostMaterialId(host: Node, added: Node): string | null {
  const ignore = new Set(modelNodesOf(added))
  let found: string | null = null
  for (const n of modelNodesOf(host)) {
    if (ignore.has(n)) continue
    // A MERGED node carries one material per submesh, so it is mixed by construction. Reading its scalar
    // link would report the first submesh's material as "the" host material and then overwrite the added
    // part with it — the same slot-0-only mistake that made editing a second submesh do nothing.
    const ids = getMaterialIdsOf(n).filter((x): x is string => !!x)
    if (ids.length > 1) return null
    const id = ids[0]
    if (typeof id !== 'string') continue
    if (found && found !== id) return null // host is already mixed; adopting would be arbitrary
    found = id
  }
  return found
}

/**
 * Make every ModelNode in `added` use the material the rest of `host` already shares.
 *
 * This is what keeps a model asset to ONE material: the renderer batches by material, so a model whose
 * parts disagree cannot be drawn as a single batch. Returns the adopted material's NAME when it changed
 * something (for the caller's notice), else null.
 */
export function adoptModelMaterial(added: Node, host: Node, materials: MaterialAsset[]): string | null {
  const wanted = hostMaterialId(host, added)
  if (!wanted) return null
  const asset = materials.find(m => m.id === wanted)
  if (!asset) return null

  let changed = false
  for (const n of modelNodesOf(added)) {
    // Never flatten a merged part onto one material: that would silently discard the other submeshes'
    // links. Such a part keeps what it has, and the caller's "adopted" notice simply does not fire for it.
    if (getMaterialIdsOf(n).filter(Boolean).length > 1) continue
    if (n.getVariable(MATERIAL_ID_VAR) === wanted) continue
    applyMaterialAsset(n, asset)
    changed = true
  }
  return changed ? asset.name : null
}

/**
 * Collapse an imported model's sub-meshes into ONE ModelNode carrying one submesh per material.
 *
 * An importer splits a model per material (glTF mandates one primitive per material) and per source mesh
 * object, so a character routinely arrives as several nodes over one skeleton. That costs a draw call, an
 * `Animator` and a full 100-mat4 bone upload *per pass and per shadow cascade* each — and, worse, the
 * editor binds an animation to the FIRST skinned child it finds, so half a two-part character would sit
 * in bind pose.
 *
 * Returns the merged children (a single node) or null with the reason logged when the parts are not
 * mergeable — mixed skeletons, or materials the renderer would route to different passes.
 */
export function mergeSubModels(
  root: Node,
  children: ModelNode[],
  materialAssetOfChild: Map<ModelNode, MaterialAsset>,
): ModelNode[] | null {
  if (children.length < 2) return null

  const models = children.map(c => c.model)
  const blocker = mergeBlocker(models)
  if (blocker) {
    Logger.warn(`Kept "${root.name}" split across ${children.length} parts: ${blocker}`, 'Import')
    return null
  }
  // Vertices are concatenated verbatim, so a part sitting at its own transform would land in the wrong
  // place. Skinned parts never carry one (they are posed by the skeleton); static ones can.
  const moved = children.filter(c => !isIdentityTransform(c))
  if (moved.length) {
    Logger.warn(`Kept "${root.name}" split across ${children.length} parts: a part has its own transform`, 'Import')
    return null
  }

  const merged = mergeModels(models)
  if (!merged) return null

  // One asset per SUBMESH, taken from the child that submesh came from. This used to de-duplicate the
  // assets itself and assume the result lined up — but `mergeModels` collapses only CONSECUTIVE parts, so
  // a material used again later legitimately gets a second submesh while the de-duplicated asset list did
  // not. The lists then drifted: every link after the first repeat landed on the wrong range, and the
  // trailing submeshes got none at all — so editing those materials appeared to do nothing. With 2 parts
  // the two rules agree, which is why it only showed up on a model with many sub-meshes.
  const assets = merged.sources.map(i => materialAssetOfChild.get(children[i]))

  const name = root.name
  const node = new ModelNode(name, merged.model)
  for (const child of [...children]) root.removeChild(child)
  root.addChild(node)
  root.updateTransforms()
  if (assets.some(Boolean)) applyMaterialAssets(node, assets)

  const distinct = new Set(assets.filter(Boolean)).size
  Logger.info(`Merged ${children.length} parts of "${name}" into one mesh (${assets.length} submesh${assets.length === 1 ? '' : 'es'}, ${distinct || 1} material${distinct === 1 ? '' : 's'})`, 'Import')
  return [node]
}

/** True when a node sits at its parent's origin unrotated and unscaled. */
function isIdentityTransform(node: Node): boolean {
  const near = (v: number, target: number) => Math.abs(v - target) < 1e-6
  const p = node.position, r = node.rotation, sc = node.scale
  return near(p[0], 0) && near(p[1], 0) && near(p[2], 0)
    && near(r[0], 0) && near(r[1], 0) && near(r[2], 0)
    && near(sc[0], 1) && near(sc[1], 1) && near(sc[2], 1)
}

/**
 * Turn one imported subtree into a separate ModelAsset per sub-mesh (the import modal's "Separate parts"
 * option). Each asset is re-centred on its own bounds, so dragging it into the scene drops it where you
 * point instead of wherever it happened to sit in the source file.
 *
 * The re-centring is done with the NODE TRANSFORM, never by translating vertices: a skinned model's
 * vertices are bound to its skeleton and moving them would break the binding (the same reason
 * normalizeRootScale falls back to transform-space scaling for skinned subtrees).
 *
 * Rotation and scale are deliberately KEPT — those are the part's authored size and orientation. Only
 * its position (the file's layout) is dropped.
 */
export async function separateSubModels(
  root: Node,
  children: ModelNode[],
  bundleName: string,
  materialIdOfChild: Map<ModelNode, string>,
): Promise<ModelAsset[]> {
  const assets: ModelAsset[] = []
  const rootScale = root.scale

  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    const name = child.name?.trim() || `${bundleName}_${i + 1}`

    const holder = new Node(name)
    // normalizeRootScale scales a SKINNED subtree through the root's transform (it cannot bake into the
    // vertices), so a separated skinned child would silently lose its normalization without this.
    holder.setScale([rootScale[0], rootScale[1], rootScale[2]])

    child.setPosition([0, 0, 0]) // drop the file's authored layout; keep rotation + scale
    holder.addChild(child)
    holder.updateTransforms()

    // Shift the child so its bounds land on the origin. getBoundingSphere is WORLD space, and the holder
    // sits at the origin with only a scale, so dividing that scale back out converts it to the child's
    // local space.
    const center = child.getBoundingSphere().center
    const sx = rootScale[0] || 1, sy = rootScale[1] || 1, sz = rootScale[2] || 1
    child.setPosition([-center[0] / sx, -center[1] / sy, -center[2] / sz])
    holder.updateTransforms()

    const materialId = materialIdOfChild.get(child)
    assets.push(flattenModelAsset(await buildModelAsset(holder, materialId ? [materialId] : [], '')))
  }

  return assets
}

/** Instantiate a model asset under `parent`, regenerating ids and restoring embedded textures. Returns the new root id.
 *  Assets with LOD levels or a cull distance instantiate as a LodGroupNode wrapping one child subtree
 *  per level (level 0 = the base nodeJson); plain assets keep the original single-subtree shape.
 *  `materials` re-resolves the subtree's __materialId links against the library — see resolveMaterialRefs. */
export function instantiateModelAsset(asset: ModelAsset, parent: Node, materials?: MaterialAsset[], models?: ModelAsset[], animations?: AnimationAsset[]): string {
  // LOD levels are references, so the library is needed to resolve them. A level whose model has been
  // deleted is dropped rather than instantiated as a hole — the instance simply keeps the levels that
  // still resolve, and `resolvedLods` drops the matching distance so the two arrays stay aligned.
  const lods = resolvedLods(asset, models)
  const clone = (lods.length || (asset.cullDistance ?? 0) > 0)
    ? {
        id: cryptoRandomId(),
        name: asset.name,
        type: 'lodGroup',
        distances: [0, ...lods.map(l => l.distance)],
        cullDistance: asset.cullDistance ?? 0,
        children: [
          JSON.parse(JSON.stringify(asset.nodeJson)),
          ...lods.map(l => JSON.parse(JSON.stringify(l.nodeJson))),
        ],
      } as any
    : JSON.parse(JSON.stringify(asset.nodeJson))

  if (materials) resolveMaterialRefs(clone, materials)
  const idMap = new Map<string, string>()
  regenerateIds(clone, idMap)

  // Tag the instance root so it can be recognized as a placed model instance. Persists via the node's
  // serialized `variables`.
  clone.variables = { ...(clone.variables || {}), [MODEL_ID_VAR]: { type: 'string', value: asset.id } }

  // Restore any embedded textures not already present.
  for (const t of asset.textures || []) {
    if (t?.id && !TextureManager.Instance.getTexture(t.id))
      TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id)
  }

  parseByType(parent, clone)

  // Shared animation clips are applied to the LIVE node, never spliced into `clone`: a resolved clip
  // carries an `assetId` and AnimatedModel.serialize drops those, so putting them in the JSON would only
  // get them stripped on the next save. Retargeting happens here because the target rig is this asset's.
  if (animations?.length && asset.animationIds?.length) {
    const placed = parent.children.find(c => c.id === clone.id)
    if (placed) applyModelAnimations(placed, asset, animations)
  }
  return clone.id
}
