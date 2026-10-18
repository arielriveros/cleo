import { Node, ModelNode, AnimatedModel, Logger, TextureManager, mergeBlocker, mergeModels, isEditorOwnedName, extractSubmesh, withoutSubmesh, decomposeTRS } from 'cleo'
import { mat4, quat, vec3 } from 'gl-matrix'
import { cryptoRandomId } from './ids'
import { parseByType, stripDebug, collectTextureIds, regenerateIds } from './nodeSubtree'
import { resolveMaterialRefs, applyMaterialAsset, applyMaterialAssets, serializedVar, getMaterialIdsOf, MATERIAL_ID_VAR, MATERIAL_IDS_VAR, LOD_MATERIAL_ID_VAR, LOD_MATERIAL_IDS_VAR, LOD_LEVEL_VAR, MaterialAsset } from './materials'
import { skinnedModelJsonOf as skinnedJson, flattenModelAsset, nodeJsonTrs, modelTransformDelta, carryModelAssetFields } from './modelClips'
import type { AnimationAsset } from './animationAssets'
import { applyModelAnimations, modelAnimationIds } from './animationResolve'
import { deepClone } from './deepClone'

// MODEL assets: a named, thumbnailed subtree of ModelNodes sharing a material, with optional LOD levels
// and a cull distance. Vocabulary: a "mesh" is the GPU-side structure, internal to the engine and never
// user-authored; a "model" is one Geometry + one Material (src/graphics/model.ts) — the placeable thing.

// Node variable linking a placed instance back to its source model asset. Saving the asset
// re-instantiates every scene node carrying it (syncModelInstances in EngineContext).
// This string is serialized into every placed instance, so it cannot be changed; see LEGACY_MODEL_ID_VAR.
export const MODEL_ID_VAR = '__modelId'

/** The pre-rename spelling of MODEL_ID_VAR, still read so unmigrated data keeps resolving. */
export const LEGACY_MODEL_ID_VAR = '__meshId'

/**
 * The model asset's OWN root transform at the moment this instance was built, as a flat
 * `[px,py,pz, rx,ry,rz, sx,sy,sz]`.
 *
 * A placement's transform and the asset root's transform occupy the same slot, so this baseline is what
 * lets a rebuild tell "the user moved this copy" from "the model itself moved" (applyModelTransformDelta).
 * A placement without it keeps its transform verbatim and gains a baseline on its next rebuild.
 */
export const MODEL_BASE_TRS_VAR = '__modelBaseTRS'

/**
 * The MODEL_BASE_TRS_VAR baseline off a live node, or null when it has none.
 * Stored as JSON — a node variable has only number/string/boolean/vec3 — but a raw array also reads.
 */
export function readModelBaseTrs(node: Node | null | undefined): number[] | null {
  const raw = node?.getVariable(MODEL_BASE_TRS_VAR)
  const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return null } })() : raw
  return Array.isArray(parsed) && parsed.length >= 9 ? parsed.map(Number) : null
}

/**
 * Re-apply a placement's own transform on top of a model whose root transform has moved since.
 * The arithmetic lives in modelTransformDelta; this is the half that touches a live Node.
 * Returns true when something moved.
 */
export function applyModelTransformDelta(node: Node, base: number[] | null | undefined, assetRootJson: any): boolean {
  const next = modelTransformDelta(node, base, nodeJsonTrs(assetRootJson))
  if (!next) return false
  node.setPosition(next.position).setRotation(next.rotation).setScale(next.scale)
  return true
}

/**
 * Walk up to the placed model-instance root — the nearest ancestor (or self) carrying `__modelId`.
 * The walk is mandatory: a model asset instantiates as a holder Node with one ModelNode per sub-mesh, so
 * `__modelId` sits on the HOLDER and reading it off the selected node alone finds nothing.
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
 * Editor chrome, which is a real engine child of whatever it annotates and must never be mistaken for
 * user content. Tests the name contract, `isEditorOwnedName`, as `SceneInspector`'s `isHiddenInTree` and
 * `nodeSubtree`'s `stripDebug` do. Deliberately not `Node.isEditorOwned`: its flag covers a preview tab's
 * holder and, inherited, the very model under it that these walks are looking for.
 *
 * The walks below forgot this and it mattered: a camera's frustum gizmo and a sound's falloff sphere
 * are both `ModelNode` children, so every Camera and every spatial Sound reported that it "contained
 * geometry" and grew a Model section in the inspector.
 */
const isHelper = (node: Node): boolean => isEditorOwnedName(node.name)

/**
 * The first skinned ModelNode AT or BENEATH `node` (depth-first, self first), or null.
 * Matches what the animation UI needs: an AnimatedModel with a skin AND a live animator. First match on
 * purpose for a multi-part model, as skinnedModelJsonOf also does.
 */
export function skinnedModelNodeOf(node: Node | null | undefined): ModelNode | null {
  if (!node) return null
  if (node instanceof ModelNode && node.model instanceof AnimatedModel && node.model.hasSkin && !!node.animator)
    return node
  for (const child of node.children) {
    if (isHelper(child)) continue
    const found = skinnedModelNodeOf(child)
    if (found) return found
  }
  return null
}

/**
 * The first ModelNode AT or BENEATH `node` (depth-first, self first), or null.
 * The unskinned sibling of skinnedModelNodeOf.
 */
export function modelNodeOf(node: Node | null | undefined): ModelNode | null {
  if (!node) return null
  if (node instanceof ModelNode) return node
  for (const child of node.children) {
    if (isHelper(child)) continue
    const found = modelNodeOf(child)
    if (found) return found
  }
  return null
}

/**
 * The model a node's INSPECTOR should speak for: itself, or the one it holds as a model-instance root.
 *
 * The distinction the plain `modelNodeOf` walk lost. A section is about the SELECTED node, and
 * "contains a model somewhere below" is far too generous a reading of that — it lit up every holder,
 * Character, Controller and LodGroup standing above a mesh, and (because a template instance draws as
 * a leaf row) made the panel look like it was keying off the scene rather than the selection.
 *
 * The holder case is still honoured, because it is not incidental: a model asset instantiates as a
 * plain `Node` carrying `__modelId` with one `ModelNode` per sub-mesh, and that holder is what an
 * author clicks. But only the ROOT of such an instance stands in for what is beneath it.
 */
export function ownModelNodeOf(node: Node | null | undefined): ModelNode | null {
  if (!node) return null
  if (node instanceof ModelNode) return node
  return modelInstanceRootOf(node) === node ? modelNodeOf(node) : null
}

/** {@link ownModelNodeOf} for skinned models — what the Animation section applies to. */
export function ownSkinnedModelNodeOf(node: Node | null | undefined): ModelNode | null {
  if (!node) return null
  if (node instanceof ModelNode) return skinnedModelNodeOf(node)
  return modelInstanceRootOf(node) === node ? skinnedModelNodeOf(node) : null
}

/**
 * One extra LOD level of a model asset, plus the camera distance at which it takes over. Either:
 * - GENERATED (`generated: true`): the level's own subtree, embedded here — decimated geometry with an
 *   inline material on smaller textures, no library asset behind it (see utils/lodGenerate.ts). Its root
 *   transform always mirrors the model's (saveModelTab keeps them equal).
 * - HAND-PICKED (`modelId`): a reference to another model asset, rendered at this level.
 */
export type ModelLodDef = {
  distance: number
  /** Hand-picked level: the model asset rendered at this level. */
  modelId?: string
  /** Generated level: the embedded subtree. (Also how levels were stored before references existed.) */
  nodeJson?: any
  /** Set on a level LOD generation produced — replaced, never kept, by the next generate. */
  generated?: true
}

/** The model asset's generated levels — the ones it owns and deletes with itself. */
export function generatedLodCount(asset: Pick<ModelAsset, 'lods'>): number {
  return (asset.lods ?? []).filter(l => l.generated || (!l.modelId && l.nodeJson)).length
}

/**
 * The Material assets a model's GENERATED levels derive their materials from, with the levels that use
 * each (`__lodMaterialId(s)` + `__lodLevel`, see lodGenerate.ts). An edit to one of these has to rebuild
 * the model's placed copies: those levels resolve the material at instantiation, not in place.
 */
export function lodLevelMaterialLinks(asset: Pick<ModelAsset, 'lods'>): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  const add = (id: unknown, level: number) => {
    if (typeof id !== 'string' || !id) return
    let set = out.get(id)
    if (!set) out.set(id, set = new Set())
    set.add(level)
  }
  const walk = (json: any) => {
    if (!json || typeof json !== 'object') return
    const level = Number(serializedVar(json, LOD_LEVEL_VAR))
    if (level > 0) {
      add(serializedVar(json, LOD_MATERIAL_ID_VAR), level)
      const list = serializedVar(json, LOD_MATERIAL_IDS_VAR)
      if (list) { try { for (const id of JSON.parse(list)) add(id, level) } catch { /* corrupt link */ } }
    }
    for (const child of json.children ?? []) walk(child)
  }
  for (const lod of asset.lods ?? []) if (lod.nodeJson) walk(lod.nodeJson)
  return out
}

/**
 * How many LOD levels deleting model `id` deletes with it: its embedded (generated) levels, plus any
 * old-scheme level assets minted for it (`lodSource`). Hand-picked levels are other models and survive.
 */
export function modelLodLevelCount(id: string, models: readonly ModelAsset[]): number {
  const asset = models.find(m => m.id === id)
  return (asset ? generatedLodCount(asset) : 0) + models.filter(m => m.lodSource?.modelId === id).length
}

/**
 * The subtree a LOD level renders, or null if it cannot be resolved — a reference whose model asset was
 * deleted, or a legacy level with no embedded copy.
 * Only the referenced asset's OWN subtree is used, never its LOD levels, so references cannot recurse.
 */
export function lodLevelJson(lod: ModelLodDef, models?: ModelAsset[]): any | null {
  if (lod.modelId) return models?.find(m => m.id === lod.modelId)?.nodeJson ?? null
  return lod.nodeJson ?? null
}

/** Resolved LOD levels, dangling references dropped (with their distances) so indices stay aligned. */
export function resolvedLods(asset: ModelAsset, models?: ModelAsset[]): { nodeJson: any; distance: number }[] {
  const out: { nodeJson: any; distance: number }[] = []
  ;(asset.lods ?? []).forEach((lod, i) => {
    let nodeJson = lodLevelJson(lod, models)
    if (nodeJson && lod.generated) nodeJson = withLevelLinks(nodeJson, asset.nodeJson, i + 1)
    if (nodeJson) out.push({ nodeJson, distance: lod.distance })
  })
  return out
}

/**
 * A generated level made before levels kept their material links (`__lodMaterialId`), given them back:
 * copied from the matching LOD0 part, found by walking both trees together (a level is LOD0's tree with
 * its meshes swapped, so the shapes agree). Without them the level draws the inline copy frozen at
 * generation — which an edit to the material leaves stale, or textureless once the edit replaces the
 * texture it pointed at. Returns `levelJson` untouched when it already has links or the trees differ.
 */
export function withLevelLinks(levelJson: any, lod0Json: any, level: number): any {
  let linked = false
  const scan = (j: any): void => { if (!j || linked) return; if (serializedVar(j, LOD_LEVEL_VAR)) linked = true; (j.children ?? []).forEach(scan) }
  scan(levelJson)
  if (linked) return levelJson
  const copy = deepClone(levelJson)
  const walk = (lvl: any, src: any) => {
    if (!lvl || !src || lvl.name !== src.name) return
    if (lvl.model) {
      const one = serializedVar(src, MATERIAL_ID_VAR)
      const list = serializedVar(src, MATERIAL_IDS_VAR)
      const vars = lvl.variables = lvl.variables ?? {}
      const levelParts = Array.isArray(lvl.model.materials) ? lvl.model.materials.length : 1
      let ids: unknown[] = []
      try { ids = list ? JSON.parse(list) : [] } catch { ids = [] }
      if (Array.isArray(ids) && ids.length > 1 && ids.length === levelParts)
        vars[LOD_MATERIAL_IDS_VAR] = { type: 'string', value: JSON.stringify(ids) }
      else if (one || (Array.isArray(ids) && typeof ids[0] === 'string'))
        vars[LOD_MATERIAL_ID_VAR] = { type: 'string', value: one ?? ids[0] }
      if (vars[LOD_MATERIAL_ID_VAR] || vars[LOD_MATERIAL_IDS_VAR]) vars[LOD_LEVEL_VAR] = { type: 'string', value: String(level) }
    }
    const a = lvl.children ?? [], b = src.children ?? []
    for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i])
  }
  walk(copy, lod0Json)
  return copy
}

// A reusable, named model imported from file(s): a serialized node subtree plus its texture ids and a
// thumbnail. Materials are embedded in the subtree AND linked to Material library assets via __materialId.
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
   * Shared animation assets this model plays, by id (see utils/animationAssets.ts). The clips themselves
   * live once in the animation library in their SOURCE rig's space, and are retargeted onto this model's
   * skeleton at instantiation. Clips embedded directly in `nodeJson` also still play.
   */
  animationIds?: string[]
  /**
   * The `.rig` asset holding this character's skeleton (utils/rigAssets.ts).
   *
   * The subtree still embeds its own `skin` — the renderer needs it at parse time — but that copy is found
   * by taking the FIRST sub-mesh carrying one, which silently misses. `rigId` is the DECLARED identity, and
   * it is what decides which `.anim` assets retarget onto this model cleanly.
   */
  rigId?: string
  /**
   * LEGACY — present only on a LOD level generated before levels were embedded: which model it was
   * decimated from, and which level it is. Generated levels now live inside their source (`lods`), so
   * nothing writes this any more; it is read so the source's next generate/save, and its deletion, can
   * clear these assets out of the library.
   */
  lodSource?: { modelId: string; level: number }
}

/**
 * Snapshot a live node subtree into a saveable model asset.
 * Records only the texture IDS the subtree uses; the payloads live once in the texture store.
 *
 * `previous` is the record being REPLACED, when there is one. Everything this function cannot read out of
 * the live subtree is carried over from it — see MODEL_ASSET_PRESERVED_KEYS. Without it, re-saving a model
 * silently dropped its animation links, because a linked clip is filtered out of `serialize` and so exists
 * nowhere in `nodeJson`.
 */
export async function buildModelAsset(
  root: Node,
  materialIds: string[],
  thumbnail: string,
  id?: string,
  lods?: ModelLodDef[],
  cullDistance?: number,
  previous?: ModelAsset | null,
): Promise<ModelAsset> {
  const nodeJson = await root.serialize()
  stripDebug(nodeJson)
  // A definition must never carry an instance back-link; strip it so it isn't baked in.
  if (nodeJson.variables) {
    delete nodeJson.variables[MODEL_ID_VAR]
    delete nodeJson.variables[LEGACY_MODEL_ID_VAR]
    delete nodeJson.variables[MODEL_BASE_TRS_VAR]
  }

  const texIds = new Set<string>()
  collectTextureIds(nodeJson, texIds)

  const asset: ModelAsset = { id: id ?? cryptoRandomId(), name: root.name, nodeJson, textureIds: [...texIds], materialIds, thumbnail }

  if (lods?.length) {
    // Reference levels carry no subtree of their own; only legacy embedded levels need cleaning.
    for (const lod of lods) {
      if (!lod.nodeJson) continue
      stripDebug(lod.nodeJson)
      if (lod.nodeJson.variables) {
        delete lod.nodeJson.variables[MODEL_ID_VAR]
        delete lod.nodeJson.variables[LEGACY_MODEL_ID_VAR]
        delete lod.nodeJson.variables[MODEL_BASE_TRS_VAR]
      }
      collectTextureIds(lod.nodeJson, texIds)
    }
    asset.lods = lods
    asset.textureIds = [...texIds]
  }
  if (cullDistance && cullDistance > 0) asset.cullDistance = cullDistance

  return carryModelAssetFields(asset, previous)
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
 * A save must refuse an empty subtree: it renders as nothing and destroys the asset's previous content.
 */
export function nodeJsonHasModel(nodeJson: any): boolean {
  if (!nodeJson || typeof nodeJson !== 'object') return false
  if (nodeJson.model) return true
  return Array.isArray(nodeJson.children) && nodeJson.children.some(nodeJsonHasModel)
}

/** True if the asset carries LOD levels or a cull distance (i.e. it instantiates as a LodGroupNode). */
/**
 * The tree `instantiateModelAsset` builds for `asset`, as names and nesting only: the LOD wrapper with the
 * asset root and each level under it, or the asset root alone. What `detachForeignChildren` compares a
 * placed copy against to tell the asset's nodes from the ones the user added.
 */
export function modelInstanceShape(asset: ModelAsset, models?: ModelAsset[]): { name?: string; children?: any[] } {
  if (!modelAssetHasLodBehavior(asset)) return asset.nodeJson
  return { name: asset.name, children: [asset.nodeJson, ...resolvedLods(asset, models).map(l => l.nodeJson)] }
}

export function modelAssetHasLodBehavior(asset: ModelAsset): boolean {
  return !!asset.lods?.length || (asset.cullDistance ?? 0) > 0
}

// Skeleton + animation clips belong to the MODEL ASSET; the engine-free serialized half lives in
// modelClips.ts and is re-exported here so call sites have one import.
export {
  skinnedModelJsonOf, skinnedModelJsonsOf, assetWithClipAdded, assetWithClipRenamed, assetWithClipRemoved,
  assetWithClipRootMotion, assetWithBoneNames, assetClipNames, assetWithIkRig, assetIkRig,
  assetWithSockets, assetSockets,
  flattenModelJson, flattenModelAsset, assetWithoutEmbeddedClips,
  carryModelAssetFields, MODEL_ASSET_PRESERVED_KEYS,
} from './modelClips'

/**
 * Bring a live subtree's skinned models up to date with their model asset: replace the clip list and merge
 * in any bone names the asset has. Returns how many models were refreshed.
 *
 * Clips and bone names ONLY — ids, transforms, materials, scripts and bodies must stay untouched, and
 * `ModelNode.model` is read-only so geometry and sub-mesh structure cannot be swapped in place.
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
        // Replace wholesale rather than diffing: a clip deleted or renamed on the asset must not survive here.
        for (const name of model.animations.map((a: any) => a.name)) model.removeAnimation(name)
        for (const clip of json.animations ?? []) model.addAnimation(clip)
        // Shared clips are not in `json` (serialize drops them), so re-resolve them from the library.
        // Guarded on the RESOLVED ids, not the model's own list: clips live on the rig now, so the
        // model's `animationIds` is empty for any project that has run the v4 migration.
        if (animations?.length && modelAnimationIds(asset).length) applyModelAnimations(node, asset, animations)

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

/**
 * Bounding diameter of a model asset, in the asset's own units.
 *
 * Read straight off the SERIALIZED subtree rather than by instantiating it: this is wanted while
 * choosing LOD distances, where spinning up a scene, a device and a mesh set to measure a number would
 * be absurd. Positions are flat `[x,y,z, x,y,z, ...]` (see `serializeGeometry`).
 *
 * Node ROTATION is ignored, and deliberately: an axis-aligned box around a rotated child can only come
 * out too large, and the consumer is a distance ladder where a slightly generous estimate is the safe
 * direction. Translation and scale ARE applied, because a model whose parts are laid out around the
 * origin is exactly the case a per-child bound would get wrong.
 *
 * 0 for an empty or geometry-less asset, which callers must treat as "unknown" rather than "tiny".
 */
export function modelAssetDiameter(nodeJson: any): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  const walk = (node: any, ox: number, oy: number, oz: number,
                sx: number, sy: number, sz: number) => {
    if (!node || typeof node !== 'object') return
    const p = node.position ?? [0, 0, 0]
    const k = node.scale ?? [1, 1, 1]
    const nx = ox + (Number(p[0]) || 0) * sx
    const ny = oy + (Number(p[1]) || 0) * sy
    const nz = oz + (Number(p[2]) || 0) * sz
    const kx = sx * (Number(k[0]) || 1)
    const ky = sy * (Number(k[1]) || 1)
    const kz = sz * (Number(k[2]) || 1)

    const positions = node.model?.geometry?.positions
    if (positions && positions.length >= 3) {
      for (let i = 0; i + 2 < positions.length; i += 3) {
        const x = nx + positions[i] * kx
        const y = ny + positions[i + 1] * ky
        const z = nz + positions[i + 2] * kz
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (z < minZ) minZ = z
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        if (z > maxZ) maxZ = z
      }
    }
    for (const child of node.children ?? []) walk(child, nx, ny, nz, kx, ky, kz)
  }
  walk(nodeJson, 0, 0, 0, 1, 1, 1)

  if (!Number.isFinite(minX)) return 0
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ)
}

/**
 * How far past the last LOD band a seeded cull distance sits.
 *
 * The coarsest level needs a band of its own to be worth generating. Culling exactly at the last
 * band means the level the user waited for is never drawn — which is what happened when nothing
 * seeded a cull distance and the renderer's 65 m global took over a ladder ending at 64 m.
 */
export const LOD_CULL_MARGIN = 1.6

/**
 * Where an impostor takes over when the model has no LOD ladder to end.
 *
 * Only a fallback: with bands present the card starts past the last of them, so the mesh ladder plays
 * out in full. The renderer's impostor test short-circuits level selection, so a distance INSIDE the
 * ladder retires every level beyond it instead of extending the view.
 */
export const DEFAULT_IMPOSTOR_DISTANCE = 60

/** Every texture id a model asset references, whichever format it was saved in. */
export function modelAssetTextureIds(asset: ModelAsset): string[] {
  if (asset.textureIds?.length) return asset.textureIds
  return (asset.textures ?? []).map((t: any) => t?.id).filter(Boolean)
}

/**
 * The material every ModelNode in a subtree shares, or null when they disagree (or there are none).
 * A multi-node model asset is only coherent while all its parts carry the same material — that is what
 * lets the renderer draw the whole asset in one batch.
 */
export function sharedMaterialIdOf(nodeJson: any): string | null {
  // The link lives in the node's serialized `variables`; model.material is only the fallback copy.
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
 * Returns null when the host has no linked material to adopt, in which case the newly dropped part keeps
 * whatever it arrived with.
 */
function hostMaterialId(host: Node, added: Node): string | null {
  const ignore = new Set(modelNodesOf(added))
  let found: string | null = null
  for (const n of modelNodesOf(host)) {
    if (ignore.has(n)) continue
    // A MERGED node carries one material per submesh, so it is mixed by construction; its scalar link
    // would report only submesh 0's material.
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
 * Make every ModelNode in `added` use the material the rest of `host` already shares, keeping the asset
 * to ONE material so the renderer can batch it. Returns the adopted material's NAME on a change, else null.
 */
export function adoptModelMaterial(added: Node, host: Node, materials: MaterialAsset[]): string | null {
  const wanted = hostMaterialId(host, added)
  if (!wanted) return null
  const asset = materials.find(m => m.id === wanted)
  if (!asset) return null

  let changed = false
  for (const n of modelNodesOf(added)) {
    // Never flatten a merged part onto one material; that would discard the other submeshes' links.
    if (getMaterialIdsOf(n).filter(Boolean).length > 1) continue
    if (n.getVariable(MATERIAL_ID_VAR) === wanted) continue
    applyMaterialAsset(n, asset)
    changed = true
  }
  return changed ? asset.name : null
}

/**
 * Collapse an imported model's sub-meshes into as FEW ModelNodes as the renderer allows, each carrying one
 * submesh per material. Ideally that is one node; parts that cannot share a mesh — materials the renderer
 * routes to different passes (an opaque trunk and alpha-blended needles), different skeletons, different
 * transforms — land in separate merged nodes instead of keeping every part split. Returns the resulting
 * children, or null (reason logged) when nothing could be merged at all.
 */
export function mergeSubModels(
  root: Node,
  children: ModelNode[],
  materialAssetOfChild: Map<ModelNode, MaterialAsset>,
): ModelNode[] | null {
  if (children.length < 2) return null

  // Parts sharing a material ASSET each carry their own Material instance, and mergeModels collapses
  // consecutive parts only on the same instance — so a pine's eight needle splits stayed eight submeshes
  // (eight draws) of one material. Give them one instance first.
  const canonical = new Map<MaterialAsset, unknown>()
  for (const child of children) {
    const asset = materialAssetOfChild.get(child)
    const mats = (child.model as any).materials as unknown[] | undefined
    if (!asset || !mats?.length) continue
    if (!canonical.has(asset)) canonical.set(asset, mats[0])
    else mats[0] = canonical.get(asset)
  }

  // Greedy buckets in file order: a part joins the first bucket it can merge with.
  const buckets: ModelNode[][] = []
  let firstReason: string | null = null
  for (const child of children) {
    const home = buckets.find(b => {
      if (!sameTransform(b[0], child)) { firstReason ??= 'the parts sit at different transforms'; return false }
      const blocker = mergeBlocker([...b.map(c => c.model), child.model])
      if (blocker) { firstReason ??= blocker; return false }
      return true
    })
    if (home) home.push(child)
    else buckets.push([child])
  }
  if (buckets.length === children.length) {
    Logger.warn(`Kept "${root.name}" split across ${children.length} parts: ${firstReason ?? 'not mergeable'}`, 'Import')
    return null
  }

  const result: ModelNode[] = []
  let submeshes = 0
  const distinct = new Set<MaterialAsset>()
  for (const bucket of buckets) {
    if (bucket.length === 1) { result.push(bucket[0]); submeshes++; continue }
    const merged = mergeModels(bucket.map(c => c.model))
    if (!merged) { result.push(...bucket); submeshes += bucket.length; continue }

    // One asset per SUBMESH, taken from the child that submesh came from — never de-duplicated by
    // material: `mergeModels` collapses only CONSECUTIVE parts, so a repeated material legitimately gets
    // two submeshes and a de-duplicated list would misalign every link after the first repeat.
    const assets = merged.sources.map(i => materialAssetOfChild.get(bucket[i]))
    for (const a of assets) if (a) distinct.add(a)
    submeshes += assets.length

    // Vertices are concatenated verbatim, so the merged node carries the transform its parts shared.
    // Exporters commonly put one root matrix on every split of a big mesh (65k-vertex Uint16 splits).
    const shared = bucket[0]
    const node = new ModelNode(buckets.length === 1 ? root.name : (shared.name || root.name), merged.model)
    node.setPosition([...shared.position] as [number, number, number])
    node.setRotation([...shared.rotation] as [number, number, number])
    node.setScale([...shared.scale] as [number, number, number])
    if (assets.some(Boolean)) applyMaterialAssets(node, assets)
    result.push(node)
  }

  // Swap in place, keeping the file's part order.
  for (const child of [...children]) root.removeChild(child)
  for (const node of result) root.addChild(node)
  root.updateTransforms()

  const parts = result.length === 1 ? 'one mesh' : `${result.length} meshes${firstReason ? ` (${firstReason})` : ''}`
  Logger.info(`Merged ${children.length} parts of "${root.name}" into ${parts}: ${submeshes} submesh${submeshes === 1 ? '' : 'es'}, ${distinct.size || 1} material${distinct.size === 1 ? '' : 's'}`, 'Import')
  return result
}

/** True when two nodes carry the same local position, rotation and scale. */
function sameTransform(a: Node, b: Node): boolean {
  const near = (x: ArrayLike<number>, y: ArrayLike<number>, eps: number) =>
    Math.abs(x[0] - y[0]) < eps && Math.abs(x[1] - y[1]) < eps && Math.abs(x[2] - y[2]) < eps
  return near(a.position, b.position, 1e-5) && near(a.rotation, b.rotation, 1e-4) && near(a.scale, b.scale, 1e-6)
}

/**
 * Bring an imported model whose file places it far from the origin back to it — the import modal's plain
 * and merge-only paths, which (unlike separate/grouped) used to keep the file's layout verbatim. A
 * Sketchfab export routinely bakes its scene placement into the root matrix: a 20 m pine sat 365 m below
 * and 367 m away, so its model tab and every placement showed nothing.
 *
 * Only when the origin lies OUTSIDE the bounds: a model authored around its own pivot (a character
 * with its feet at 0, a door hinged on an edge) keeps that pivot exactly as before. All children shift
 * by one delta, so the parts' layout survives. Returns true when it moved anything.
 */
export function recenterIfOffOrigin(root: Node, children: Node[]): boolean {
  root.updateTransforms()
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const child of children) {
    const s = child.getBoundingSphere()
    if (!s || !isFinite(s.radius)) continue
    minX = Math.min(minX, s.center[0] - s.radius); maxX = Math.max(maxX, s.center[0] + s.radius)
    minY = Math.min(minY, s.center[1] - s.radius); maxY = Math.max(maxY, s.center[1] + s.radius)
    minZ = Math.min(minZ, s.center[2] - s.radius); maxZ = Math.max(maxZ, s.center[2] + s.radius)
  }
  if (!isFinite(minX)) return false
  const inside = minX <= 0 && maxX >= 0 && minY <= 0 && maxY >= 0 && minZ <= 0 && maxZ >= 0
  if (inside) return false

  recenterGroupOnBounds(root, children, root.scale)
  return true
}

/**
 * Sit `child` on its holder's origin, centred on its own bounds, so the asset drops where the user points.
 *
 * Re-centre with the NODE TRANSFORM, never by translating vertices: a skinned model's vertices are bound
 * to its skeleton. Rotation and scale are kept — only the position (the file's layout) is dropped.
 * `holder` must be at the origin carrying only `rootScale`, which is what makes the division below the
 * whole world→local conversion.
 */
function recenterOnBounds(holder: Node, child: Node, rootScale: ArrayLike<number>): void {
  child.setPosition([0, 0, 0]) // drop the file's authored layout; keep rotation + scale
  holder.updateTransforms()

  // getBoundingSphere is WORLD space; the holder is at the origin with only a scale, so dividing that
  // scale back out converts the centre to the child's local space.
  const center = child.getBoundingSphere().center
  const sx = rootScale[0] || 1, sy = rootScale[1] || 1, sz = rootScale[2] || 1
  child.setPosition([-center[0] / sx, -center[1] / sy, -center[2] / sz])
  holder.updateTransforms()
}

/**
 * Centre a holder's SEVERAL children on their combined bounds — the multi-node case of
 * {@link recenterOnBounds}, reached when a group's parts could not be merged into one mesh. Every child
 * moves by the same delta so the layout the file gave them survives.
 *
 * The bounds are the box around the members' world bounding spheres, which is enough to put the asset's
 * origin in the middle of it; the exact enclosing sphere (combineBounds) lives in modelThumbnails and
 * pulling it in here would mean a GL-side import in a module the headless tests load.
 */
function recenterGroupOnBounds(holder: Node, children: Node[], rootScale: ArrayLike<number>): void {
  holder.updateTransforms()

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const child of children) {
    const s = child.getBoundingSphere()
    if (!s || !isFinite(s.radius)) continue
    minX = Math.min(minX, s.center[0] - s.radius); maxX = Math.max(maxX, s.center[0] + s.radius)
    minY = Math.min(minY, s.center[1] - s.radius); maxY = Math.max(maxY, s.center[1] + s.radius)
    minZ = Math.min(minZ, s.center[2] - s.radius); maxZ = Math.max(maxZ, s.center[2] + s.radius)
  }
  if (!isFinite(minX)) return

  // World → the children's local space: the holder is at the origin carrying only rootScale.
  const sx = rootScale[0] || 1, sy = rootScale[1] || 1, sz = rootScale[2] || 1
  const dx = (minX + maxX) / 2 / sx, dy = (minY + maxY) / 2 / sy, dz = (minZ + maxZ) / 2 / sz
  for (const child of children) {
    const p = child.position
    child.setPosition([p[0] - dx, p[1] - dy, p[2] - dz])
  }
  holder.updateTransforms()
}

/** A holder Node carrying the import root's scale, ready to receive sub-meshes destined for one asset. */
function assetHolder(name: string, rootScale: ArrayLike<number>): Node {
  const holder = new Node(name)
  // normalizeRootScale scales a SKINNED subtree through the root's transform, so a child pulled out of
  // that subtree loses its normalization without this.
  holder.setScale([rootScale[0], rootScale[1], rootScale[2]])
  return holder
}

/**
 * Turn one imported subtree into a separate ModelAsset per sub-mesh (the import modal's "Separate parts"
 * option), each re-centred on its own bounds so it drops where the user points.
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

    const holder = assetHolder(name, rootScale)
    holder.addChild(child)
    recenterOnBounds(holder, child, rootScale)

    const materialId = materialIdOfChild.get(child)
    assets.push(flattenModelAsset(await buildModelAsset(holder, materialId ? [materialId] : [], '')))
  }

  return assets
}

/**
 * Turn one imported subtree into a ModelAsset per GROUP of sub-meshes — the general case of which
 * {@link separateSubModels} (a group per part) and {@link mergeSubModels} (one group of everything) are
 * the two ends. Used when the import modal's separate + merge toggles are BOTH on and the user has
 * partitioned the parts (see utils/submeshGroups).
 *
 * Each group's members are merged into a single mesh carrying one submesh per material. A group the
 * merge rejects — mixed material types, mixed opaque/transparent, different skeletons, a part with its
 * parts at different transforms — still becomes ONE asset, just with its parts as separate nodes; the reason is logged
 * by mergeSubModels.
 *
 * `groups[].parts` index into `children`; callers must validate them (isValidGrouping) first.
 */
export async function groupSubModels(
  root: Node,
  children: ModelNode[],
  bundleName: string,
  groups: { name: string; parts: number[] }[],
  materialIdOfChild: Map<ModelNode, string>,
  materialAssetOfChild: Map<ModelNode, MaterialAsset>,
): Promise<ModelAsset[]> {
  const assets: ModelAsset[] = []
  const rootScale = root.scale

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]
    // File order, not drag order: merged geometry is concatenated in the order the parts are passed.
    const members = [...group.parts].sort((a, b) => a - b).map(i => children[i]).filter(Boolean)
    if (!members.length) continue

    const name = group.name?.trim() || `${bundleName}_${g + 1}`
    const holder = assetHolder(name, rootScale)
    for (const child of members) holder.addChild(child)
    holder.updateTransforms()

    // Merge BEFORE re-centring: mergeSubModels requires its children at ONE shared transform, and
    // re-centring per part could break that. On a blocker it returns null and the group keeps its parts as nodes.
    const merged = members.length > 1 ? mergeSubModels(holder, members, materialAssetOfChild) : null
    const content = merged ?? members

    // One node collapses onto the holder's origin; several must keep their relative layout, so every
    // part shifts by the SAME delta instead of each centring on itself.
    if (content.length === 1) recenterOnBounds(holder, content[0], rootScale)
    else recenterGroupOnBounds(holder, content, rootScale)

    // Only the materials THIS asset's mesh uses, deduped but in submesh order.
    const ids: string[] = []
    for (const child of members) {
      const id = materialIdOfChild.get(child)
      if (id && !ids.includes(id)) ids.push(id)
    }

    assets.push(flattenModelAsset(await buildModelAsset(holder, ids, '')))
  }

  return assets
}

/** Instantiate a model asset under `parent`, regenerating ids and restoring embedded textures. Returns the new root id.
 *  Assets with LOD levels or a cull distance instantiate as a LodGroupNode wrapping one child subtree
 *  per level (level 0 = the base nodeJson); plain assets keep the original single-subtree shape.
 *  `materials` re-resolves the subtree's __materialId links against the library — see resolveMaterialRefs. */
export function instantiateModelAsset(asset: ModelAsset, parent: Node, materials?: MaterialAsset[], models?: ModelAsset[], animations?: AnimationAsset[]): string {
  // LOD levels are references, so the library is needed to resolve them. `resolvedLods` drops a dangling
  // level together with its distance so the two arrays stay aligned.
  const lods = resolvedLods(asset, models)
  const clone = (lods.length || (asset.cullDistance ?? 0) > 0)
    ? {
        id: cryptoRandomId(),
        name: asset.name,
        type: 'lodGroup',
        distances: [0, ...lods.map(l => l.distance)],
        cullDistance: asset.cullDistance ?? 0,
        children: [
          deepClone(asset.nodeJson),
          ...lods.map(l => deepClone(l.nodeJson)),
        ],
      } as any
    : deepClone(asset.nodeJson)

  if (materials) resolveMaterialRefs(clone, materials)
  const idMap = new Map<string, string>()
  regenerateIds(clone, idMap)

  // Tag the instance root; this persists via the node's serialized `variables`.
  clone.variables = { ...(clone.variables || {}), [MODEL_ID_VAR]: { type: 'string', value: asset.id } }

  // Record the asset's own root transform so a later edit to it applies as a delta (applyModelTransformDelta).
  // A LOD-wrapped instance must NOT get a baseline: the asset root sits inside the identity wrapper as
  // child 0, so a transform edit already arrives through the child and recording one here would double it.
  if (!(lods.length || (asset.cullDistance ?? 0) > 0))
    clone.variables[MODEL_BASE_TRS_VAR] = { type: 'string', value: JSON.stringify(nodeJsonTrs(asset.nodeJson)) }

  // Restore any embedded textures not already present.
  for (const t of asset.textures || []) {
    if (t?.id && !TextureManager.Instance.getTexture(t.id))
      TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id)
  }

  parseByType(parent, clone)

  // Shared animation clips must be applied to the LIVE node, never spliced into `clone`: a resolved clip
  // carries an `assetId` and AnimatedModel.serialize drops those.
  if (animations?.length && modelAnimationIds(asset).length) {
    const placed = parent.children.find(c => c.id === clone.id)
    if (placed) applyModelAnimations(placed, asset, animations)
  }
  return clone.id
}

// =====================================================================================================
// Parts of a model, saved on their own (the model tab's Parts section)
// =====================================================================================================

/** One piece of a model the Parts section can pick: a mesh node, or one material range of a merged one. */
export interface ModelPart {
  nodeId: string
  /** A material sub-mesh of a merged mesh node; absent = the whole node. */
  submesh?: number
}

/**
 * A mesh node's serialized form with ONE of its material sub-meshes kept (`'only'`) or removed
 * (`'without'`). The geometry is compacted to what the kept ranges use (engine `extractSubmesh` /
 * `withoutSubmesh`), and the per-sub-mesh material links follow, so the result is a node like any other.
 * `'only'` drops the node's children: they hang off the whole mesh, not off one material of it.
 */
export async function submeshNodeJson(node: ModelNode, submesh: number, mode: 'only' | 'without'): Promise<any> {
  const json = await node.serialize()
  const model = mode === 'only' ? extractSubmesh(node.model, submesh) : withoutSubmesh(node.model, submesh)
  json.model = model.serialize()
  const ids = getMaterialIdsOf(node)
  const kept = mode === 'only' ? [ids[submesh]] : ids.filter((_, i) => i !== submesh)
  const vars = { ...(json.variables ?? {}) }
  const access = vars[MATERIAL_ID_VAR]?.access
  delete vars[MATERIAL_IDS_VAR]
  delete vars[MATERIAL_ID_VAR]
  if (kept.length > 1) vars[MATERIAL_IDS_VAR] = { type: 'string', value: JSON.stringify(kept), ...(access ? { access } : {}) }
  if (kept[0]) vars[MATERIAL_ID_VAR] = { type: 'string', value: kept[0], ...(access ? { access } : {}) }
  json.variables = vars
  if (mode === 'only') json.children = []
  return json
}

/**
 * A new model asset made of one part of `source` — a mesh node of the open model, or one material
 * sub-mesh of it. The part keeps the orientation and size it has IN the model (its transform relative to
 * `frame`, the model root's parent, so the root's own rotation/scale are baked in) and is re-centred on
 * its own bounds, so it drops where the user points. A skinned part keeps the source's rig and clips
 * (`rigId`/`animationIds` carried from `source`); LOD levels and cull distance are the source's and stay.
 */
export async function buildPartAsset(source: ModelAsset, part: Node, frame: Node | null, submesh: number | undefined,
                                     name: string): Promise<ModelAsset> {
  const json = submesh === undefined ? await part.serialize() : await submeshNodeJson(part as ModelNode, submesh, 'only')
  // Its links back to the source are not the new asset's.
  if (json.variables) delete json.variables[MODEL_ID_VAR]
  const holder = new Node(name)
  parseByType(holder, json)
  const child = holder.children[holder.children.length - 1]
  if (!child) throw new Error('the part produced no node')

  // Where the part sits inside the model, as one transform: everything from the model's frame down.
  const rel = mat4.create()
  if (frame) {
    const inv = mat4.invert(mat4.create(), frame.worldTransform)
    if (inv) mat4.multiply(rel, inv, part.worldTransform)
    else mat4.copy(rel, part.worldTransform)
  } else mat4.copy(rel, part.worldTransform)
  const t = vec3.create(), r = quat.create(), sc = vec3.create()
  decomposeTRS(rel, t, r, sc)
  child.setPosition([t[0], t[1], t[2]])
  child.setQuaternion(r)
  child.setScale([sc[0], sc[1], sc[2]])
  recenterOnBounds(holder, child, [1, 1, 1])

  const materialIds = new Set<string>()
  const collect = (n: Node) => { for (const id of getMaterialIdsOf(n)) if (id) materialIds.add(id); n.children.forEach(collect) }
  collect(child)
  const asset = flattenModelAsset(await buildModelAsset(holder, [...materialIds], '', undefined, undefined, undefined, source))
  asset.name = name
  delete (asset as any).lods
  delete (asset as any).cullDistance
  delete (asset as any).lodSource
  return asset
}

/** `base`, or `base 2`, `base 3`… — the first name no model in `taken` has. */
export function uniqueModelName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken)
  if (!names.has(base)) return base
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`
}

