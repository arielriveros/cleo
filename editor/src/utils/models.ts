import { Node, ModelNode, AnimatedModel, Logger, TextureManager, mergeBlocker, mergeModels } from 'cleo'
import { cryptoRandomId } from './ids'
import { parseByType, stripDebug, collectTextureIds, regenerateIds } from './nodeSubtree'
import { resolveMaterialRefs, applyMaterialAsset, applyMaterialAssets, serializedVar, getMaterialIdsOf, MATERIAL_ID_VAR, MaterialAsset } from './materials'
import { skinnedModelJsonOf as skinnedJson, flattenModelAsset, nodeJsonTrs, modelTransformDelta } from './modelClips'
import type { AnimationAsset } from './animationAssets'
import { applyModelAnimations } from './animationResolve'
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
 * The first skinned ModelNode AT or BENEATH `node` (depth-first, self first), or null.
 * Matches what the animation UI needs: an AnimatedModel with a skin AND a live animator. First match on
 * purpose for a multi-part model, as skinnedModelJsonOf also does.
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
 * The first ModelNode AT or BENEATH `node` (depth-first, self first), or null.
 * The unskinned sibling of skinnedModelNodeOf.
 */
export function modelNodeOf(node: Node | null | undefined): ModelNode | null {
  if (!node) return null
  if (node instanceof ModelNode) return node
  for (const child of node.children) {
    const found = modelNodeOf(child)
    if (found) return found
  }
  return null
}

/**
 * One extra LOD level of a model asset: a **reference** to another model asset, plus the camera distance
 * at which it takes over.
 */
export type ModelLodDef = {
  distance: number
  /** The model asset rendered at this level. */
  modelId?: string
  /** Legacy: an embedded copy of the level's subtree. Still read; never written. */
  nodeJson?: any
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
  for (const lod of asset.lods ?? []) {
    const nodeJson = lodLevelJson(lod, models)
    if (nodeJson) out.push({ nodeJson, distance: lod.distance })
  }
  return out
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
   * Present only on a GENERATED LOD level: which model it was decimated from, and which level it is.
   *
   * Provenance, not a reference — `lods` on the source is what actually wires the levels together. This
   * exists so regenerating a model's LODs can UPDATE the assets it minted last time instead of adding a
   * second set on every press, which would fill the library with orphans.
   */
  lodSource?: { modelId: string; level: number }
}

/**
 * Snapshot a live node subtree into a saveable model asset.
 * Records only the texture IDS the subtree uses; the payloads live once in the texture store.
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
 * A save must refuse an empty subtree: it renders as nothing and destroys the asset's previous content.
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

// Skeleton + animation clips belong to the MODEL ASSET; the engine-free serialized half lives in
// modelClips.ts and is re-exported here so call sites have one import.
export {
  skinnedModelJsonOf, assetWithClipAdded, assetWithClipRenamed, assetWithClipRemoved,
  assetWithClipRootMotion, assetWithBoneNames, assetClipNames, assetWithIkRig, assetIkRig,
  flattenModelJson, flattenModelAsset, assetWithoutEmbeddedClips,
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
 * Collapse an imported model's sub-meshes into ONE ModelNode carrying one submesh per material.
 * Returns the merged children (a single node), or null with the reason logged when the parts are not
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
  // Vertices are concatenated verbatim, so a part sitting at its own transform would land in the wrong place.
  const moved = children.filter(c => !isIdentityTransform(c))
  if (moved.length) {
    Logger.warn(`Kept "${root.name}" split across ${children.length} parts: a part has its own transform`, 'Import')
    return null
  }

  const merged = mergeModels(models)
  if (!merged) return null

  // One asset per SUBMESH, taken from the child that submesh came from — never de-duplicated by material:
  // `mergeModels` collapses only CONSECUTIVE parts, so a repeated material legitimately gets two submeshes
  // and a de-duplicated list would misalign every link after the first repeat.
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
 * own transform — still becomes ONE asset, just with its parts as separate nodes; the reason is logged
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

    // Merge BEFORE re-centring: mergeSubModels requires its children at identity, and re-centring is
    // exactly what breaks that. On a blocker it returns null and the group keeps its parts as nodes.
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
  if (animations?.length && asset.animationIds?.length) {
    const placed = parent.children.find(c => c.id === clone.id)
    if (placed) applyModelAnimations(placed, asset, animations)
  }
  return clone.id
}
