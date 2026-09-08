import { isDerivedTextureId, isInlineTilesetId } from 'cleo'
import type { AssetRef } from 'cleo'
import { isBinaryPayload } from './binaryPayload'
import type { AssetKind } from './vfs'
import type { SceneRefs } from './sceneStorage'

// The editor half of the asset reference graph: what each asset kind REFERENCES, with attribution.
//
// The engine's `AssetGraph` is kind-agnostic by design; this is the module that knows a material reads
// textures and a model lists materials. One exhaustive `switch (kind)` arm per kind, in the same shape as
// assetKinds.ts's findAsset/renameAsset/deleteAsset — so a new kind is a compile error here too.
//
// THE CANONICAL EDGE TABLE IS `bundleMerge.ts`'s `remapDeep`/`remapVariables`. Every key it rewrites when
// merging a bundle is, by definition, a cross-asset reference, and `walkRefs` below mirrors it branch for
// branch. `assetEdgeCoverage.test.ts` asserts the two never drift apart: a reference field added there and
// missed here would make the graph silently under-report, which is worse than not having it.
//
// Engine-light on purpose: the only `cleo` values imported are two pure string predicates, so this module
// unit-tests with no GL context (as animationAssets.ts does).

/** One outgoing reference: the asset pointed at, and the field the pointer sits in. */
export type EdgeSpec = { to: AssetRef; field: string }

const ref = (kind: AssetKind, id: string): AssetRef => ({ kind, id })

/**
 * Push an edge, skipping ids that name no library asset.
 *
 * The two exclusions are load-bearing, not tidiness. `__packed__` ids are channel packs the engine derives
 * on demand and are backed by no stored bytes; an inline tileset id belongs to a tileset embedded in a
 * sprite with no library asset behind it. `references.ts:47-49` documents why counting either as a
 * reference breaks publish — here it would additionally report a permanent dangling edge for something
 * that is working exactly as intended.
 */
function push(out: EdgeSpec[], kind: AssetKind, id: any, field: string): void {
  if (typeof id !== 'string' || !id) return
  if (kind === 'texture' && isDerivedTextureId(id)) return
  if (kind === 'tileset' && isInlineTilesetId(id)) return
  out.push({ to: ref(kind, id), field })
}

/**
 * Fields that LOOK like references and are not. `lodSource` records which model and level a generated LOD
 * was decimated FROM — provenance, so the model editor can offer to regenerate it (`models.ts:204` says so
 * outright). Treating it as a reference would make every generated LOD a dependent of its source and
 * cascade a rebuild across assets that merely share an ancestry.
 */
const PROVENANCE_KEYS = new Set(['lodSource'])

/**
 * The generic deep walk, mirroring `remapDeep`.
 *
 * Used for every structure that carries references at unknown depth: a model's or template's `nodeJson`, a
 * serialized material, a terrain material's foliage rules. The per-kind arms below add only the fields
 * that live on the asset RECORD, which this walk has no way to type-check.
 */
export function walkRefs(obj: any, out: EdgeSpec[]): void {
  if (!obj || typeof obj !== 'object') return
  // A vertex buffer holds no ids, and descending into one is millions of wasted calls — or, for a typed
  // array, millions of materialised string keys. Same guard, same reason, as remapDeep and collectTextureIds.
  if (isBinaryPayload(obj)) return
  if (Array.isArray(obj)) { obj.forEach(o => walkRefs(o, out)); return }

  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (isBinaryPayload(val) || PROVENANCE_KEYS.has(key)) continue

    // A material's slot -> texture-id map. The SLOT is kept in the field name: it is the difference
    // between "this material uses rock.png" and "this material uses rock.png as its normal map".
    if (key === 'textures' && val && typeof val === 'object' && !Array.isArray(val)) {
      for (const slot of Object.keys(val)) push(out, 'texture', val[slot], `textures.${slot}`)
      continue
    }
    if (key === 'textureId' || key === 'displacementMap') { push(out, 'texture', val, key); continue }
    // A terrain paint layer's `materialId` names a TERRAIN material, not a material. The two libraries are
    // separate and the ids are not interchangeable.
    if (key === 'materialId') { push(out, 'terrainMaterial', val, key); continue }
    if (key === 'materialIds' && Array.isArray(val)) {
      val.forEach((x, i) => push(out, 'material', x, `materialIds[${i}]`))
      continue
    }
    // 'meshId' is the pre-rename spelling of 'modelId'; both point at a model asset.
    if (key === 'modelId' || key === 'meshId') { push(out, 'model', val, key); continue }
    // An animation state's link to its blend space. Its EMBEDDED copy of the field beside it is inline
    // data, not a reference.
    if (key === 'fieldId') { push(out, 'animationField', val, key); continue }
    // A controller's link to the brain asset it copied. Only the link: the machine/goals/fuzzy beside it
    // are the embedded copy.
    if (key === 'brainId') { push(out, 'aiBrain', val, key); continue }
    if (key === 'tilesetId') { push(out, 'tileset', val, key); continue }
    if (key === 'sampleId') { push(out, 'soundSample', val, key); continue }
    if (key === 'audioId') { push(out, 'audioSource', val, key); continue }
    if (key === 'tilesets' && Array.isArray(val)) {
      for (const ts of val) {
        if (ts && typeof ts === 'object') { push(out, 'tileset', ts.id, 'tilesets[].id'); walkRefs(ts, out) }
      }
      continue
    }
    // A sprite embeds ONE tileset under the singular key, which the array branch above never matches.
    if (key === 'tileset' && val && typeof val === 'object') {
      push(out, 'tileset', (val as any).id, 'tileset.id')
      walkRefs(val, out)
      continue
    }
    if (key === 'variables' && val && typeof val === 'object') { walkVariables(val, out); continue }

    walkRefs(val, out)
  }
}

/**
 * The asset-link node variables in a serialized `variables` map.
 *
 * `__materialIds` and `__screenMaterialIds` are JSON STRINGS, not arrays — the node variable system has no
 * array type. That is the trap `bundleMerge.ts:169-176` calls out: an `Array.isArray` guard silently skips
 * them, and a merged multi-material model loses every submesh link but the first.
 */
function walkVariables(vars: any, out: EdgeSpec[]): void {
  const one = (name: string, kind: AssetKind) => {
    const value = vars[name]?.value
    push(out, kind, value, name)
  }
  one('__materialId', 'material')
  one('__modelId', 'model')
  one('__meshId', 'model') // pre-rename spelling, still present in unmigrated projects
  one('__templateId', 'template')
  one('__scriptId', 'script')
  list('__materialIds')
  list('__screenMaterialIds')

  function list(name: string): void {
    const raw = vars[name]?.value
    // A string today; an older project may hold a real array. Read either.
    const ids = Array.isArray(raw) ? raw : parseIdList(raw)
    ids.forEach((id, i) => push(out, 'material', id, `${name}[${i}]`))
  }
}

function parseIdList(raw: any): any[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return [] // a corrupt link references nothing, rather than something invented
  }
}

/**
 * Every asset `asset` references. Exhaustive over {@link AssetKind}.
 *
 * Takes the STORED record rather than a live engine object, so a closed scene and an unopened material are
 * as visible to the graph as the ones currently on screen — which is the whole point of building it from
 * the libraries.
 */
export function edgesOfAsset(kind: AssetKind, asset: any): EdgeSpec[] {
  const out: EdgeSpec[] = []
  if (!asset) return out

  switch (kind) {
    // --- leaves --------------------------------------------------------------------------------------
    // Raw bytes. Nothing below them.
    case 'image':
    case 'audioSource':
      break
    // Clips in source-rig space plus the skeleton they were authored against. `sourceSkin` is embedded
    // data, and `sourceFile` is a filename, not an asset.
    case 'animation':
      break
    // A brain is a machine or a goal graph over its own fuzzy model. A controller EMBEDS a copy and
    // records `brainId` as the back-link, so the reference runs the other way.
    case 'aiBrain':
      break

    // --- the two byte splits -------------------------------------------------------------------------
    // Handled explicitly rather than through walkRefs, because both records carry MIRROR arrays
    // (`textureIds`/`imageIds`, `soundIds`/`audioIds`) whose first entry is the asset's own id — a
    // generic walk would read those as the asset referencing itself.
    case 'texture': {
      const source = asset.source
      if (source?.kind === 'image') push(out, 'image', source.imageId, 'source.imageId')
      if (source?.kind === 'pack') {
        // A baked pack keeps the flattened image it produced, plus the textures each channel was read from.
        push(out, 'image', source.bakedImageId, 'source.bakedImageId')
        for (const channel of ['r', 'g', 'b', 'a']) {
          const slot = source.spec?.[channel]
          push(out, 'texture', slot?.textureId, `source.spec.${channel}.textureId`)
        }
      }
      break
    }
    case 'soundSample':
      if (asset.source?.kind === 'audio') push(out, 'audioSource', asset.source.audioId, 'source.audioId')
      break

    // --- surfaces ------------------------------------------------------------------------------------
    case 'material':
      walkRefs(asset.material, out)
      // Legacy assets embedded their textures as base64 rather than referencing the store. Still read.
      for (const t of asset.textures ?? []) push(out, 'texture', t?.id, 'textures[].id')
      break
    // Its serialized material carries the base surface's `textures`, the terrain-only `displacementMap`,
    // and the foliage include list — whose rules each name a source model plus billboard/impostor
    // textures. walkRefs reaches all of it.
    case 'terrainMaterial':
      walkRefs(asset.material, out)
      for (const t of asset.textures ?? []) push(out, 'texture', t?.id, 'textures[].id')
      break

    // --- composites ----------------------------------------------------------------------------------
    case 'model':
      // The subtree carries the real links: embedded materials with `__materialId`, texture slot maps,
      // and each LOD level's `modelId`.
      walkRefs(asset, out)
      // Not in remapDeep's table, so walkRefs cannot see it: the shared clips a model plays.
      for (const [i, id] of (asset.animationIds ?? []).entries())
        push(out, 'animation', id, `animationIds[${i}]`)
      break
    case 'template':
      // A captured subtree: node variables (`__materialId`, `__modelId`, `__scriptId`, `__templateId`),
      // embedded material texture maps, sound `sampleId`s and tilemap/sprite tilesets.
      walkRefs(asset, out)
      break
    case 'tileset':
      // Deliberately `textureId` alone. `textureIds` is a mirror of it, kept because `referencedTextureIds`
      // scans that field (tilesets.ts:33) — counting both would double every atlas edge.
      push(out, 'texture', asset.textureId, 'textureId')
      break
    case 'animationField':
      push(out, 'model', asset.modelId, 'modelId')
      break
    case 'script':
      // A class-based script's fields are typed values, not asset links. A node's `__scriptId` points AT
      // a script; nothing points out of one.
      break

    // --- scenes --------------------------------------------------------------------------------------
    // Read from the save-time `refs` snapshot, never by walking the stored blob — see edgesOfScene.
    case 'scene':
      return edgesOfScene(asset.refs)
  }

  return out
}

/**
 * A scene's references, from the `SceneRefs` snapshot captured at save time.
 *
 * THIS IS WHY SCENES ARE AFFORDABLE IN THE GRAPH. A scene blob embeds full vertex data, so walking every
 * stored scene on every library change would be seconds of work per keystroke. `SceneRefs` already existed
 * as exactly this cache — written on save so delete warnings could see closed scenes — and reading it here
 * costs a few array iterations per scene.
 *
 * A scene saved before a given field existed simply omits it. That reads as "no references of that kind",
 * which is why `sceneRefsComplete` exists: the viewer says "partial" rather than quietly implying a scene
 * uses no scripts.
 */
export function edgesOfScene(refs: SceneRefs | null | undefined): EdgeSpec[] {
  const out: EdgeSpec[] = []
  if (!refs) return out

  const each = (ids: string[] | undefined, kind: AssetKind, field: string) => {
    for (const id of ids ?? []) push(out, kind, id, field)
  }

  each(refs.materialIds, 'material', 'refs.materialIds')
  each(refs.modelIds, 'model', 'refs.modelIds')
  // The pre-rename spelling, present in metas written before the mesh->model rename.
  each(refs.meshIds, 'model', 'refs.meshIds')
  each(refs.templateIds, 'template', 'refs.templateIds')
  each(refs.terrainMaterialIds, 'terrainMaterial', 'refs.terrainMaterialIds')
  each(refs.tilesetIds, 'tileset', 'refs.tilesetIds')
  each(refs.aiBrainIds, 'aiBrain', 'refs.aiBrainIds')
  each(refs.textureIds, 'texture', 'refs.textureIds')
  each(refs.scriptIds, 'script', 'refs.scriptIds')
  each(refs.animationFieldIds, 'animationField', 'refs.animationFieldIds')
  each(refs.animationIds, 'animation', 'refs.animationIds')
  each(refs.soundSampleIds, 'soundSample', 'refs.soundSampleIds')
  each(refs.audioSourceIds, 'audioSource', 'refs.audioSourceIds')

  return out
}

/**
 * Whether a scene's `refs` were written by a build that records every reference kind.
 *
 * The five fields below were added with the reference graph. Their absence is indistinguishable from
 * "this scene genuinely uses none", so the viewer reports the scene as partial instead of asserting a
 * completeness it cannot know. One save fixes it.
 */
export function sceneRefsComplete(refs: SceneRefs | null | undefined): boolean {
  if (!refs) return false
  return !!refs.scriptIds && !!refs.animationFieldIds && !!refs.animationIds
    && !!refs.soundSampleIds && !!refs.audioSourceIds
}
