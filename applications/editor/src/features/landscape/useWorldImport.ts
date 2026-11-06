import { useCallback } from 'react'
import { Logger, Material, MAX_PAINT_LAYERS, heightsFromImage } from 'cleo'
import type { LandscapeNode, TerrainMaterial, WorldManifestLayer } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useHistory } from '../HistoryContext'
import { MAX_SLOTS } from '../terrainMaterials/TerrainSlots'
import { rebuildTerrain } from './rebuildTerrain'
import { recordStackEdit } from './stackHistory'
import { useStackEdit } from './useStackEdit'
import { applyHeightsTo } from './heightmapImport'
import { setTerrainHeights } from '../../utils/terrainAccess'
import { buildTerrainMaterialAsset, parseTerrainMaterialAsset, syncLandscapeMaterialLayers, type TerrainMaterialAsset } from '../../utils/terrainMaterials'
import { defaultLandscapeMaterial, newLandscapeSlot, slotDisplayName } from '../../utils/landscapeSlots'
import {
  CREATOR_WORLD_VAR, kindAllowsFoliage, neutralRule, planWorldImport, resolveTarget, ruleDeviations,
  serializeCreatorWorldLink, type ImportSlot, type WorldMapping, type WorldOrientation,
} from './worldImport'
import type { LoadedWorld } from './worldSources'

// Committing an Import world, shared by the dialog and the inspector's one-click Re-apply. The order is
// load-bearing:
//   1. "Match world size" rebuilds the terrain. Not undoable, as Rebuild never is -- and it must come
//      first: mask patches recorded at the old size would be restored out of bounds.
//   2. Add missing slots / Reset rules edit the landscape material in the LIBRARY, outside history (as a
//      landscape-material tab's Save is), and re-apply it to every landscape linking it.
//   3. ONE undo step for the rest: the heights before and after, and every mapped slot's mask.

/** A mapping value in the dialog: make a new paint-only slot for this layer (step 2 creates it). */
export const NEW_SLOT = '__new'

export interface WorldImportRequest {
  world: LoadedWorld
  /** Heights of a 0 and a 1 heightmap sample, terrain-local metres. */
  range: { min: number; max: number }
  orientation: WorldOrientation
  matchSize: boolean
  /** Layer id -> slot id, GROUND, NEW_SLOT, or null (ignored: its weight goes to the Ground). */
  mapping: Record<string, string | null>
  /** Switch off whatever reshapes a mapped slot's mask (neutralRule) in the landscape material. */
  resetRules: boolean
}

/** A landscape material's slots as the planner reads them, named as the editor shows them. */
export function importSlotsOf(tm: TerrainMaterial | null | undefined, materials: readonly { id: string; name: string }[]): ImportSlot[] {
  return (tm?.slots ?? []).map(s => ({ id: s.id, name: slotDisplayName(s, materials), manual: s.manual, rule: s.rule }))
}

/** A new slot's placeholder surface: the world's colour hint, so the import reads before materials are chosen. */
function hintSurface(color: WorldManifestLayer['color']): Material {
  return Material.PBR({ baseColor: color ? [...color] : [1, 1, 1], roughness: 0.9, metallic: 0 })
}

export function useWorldImport(node: LandscapeNode) {
  const { eventEmitter, editorScene, withoutDirty, materials, terrainMaterials, updateTerrainMaterial, addTerrainMaterial, tabs } = useCleoEngine()
  const { push } = useHistory()
  // The import notifies on its own; the two library-material steps it borrows need no extra refresh.
  const noRefresh = useCallback(() => {}, [])
  const { assignBase, saveBaseToLibrary } = useStackEdit(node, noRefresh)

  /**
   * The landscape-material tab editing this landscape's material, if one is open. A library edit made
   * while it is open would be undone by the tab's next Save -- which would drop the new slots and clear
   * the masks they were given -- so Add missing slots and Reset rules wait until it is closed.
   */
  const materialTab = () => {
    const id = node.terrain?.layerStack.base.materialId
    return id ? tabs.find(t => t.kind === 'terrainMaterial' && t.terrainMaterialId === id) : undefined
  }

  /** Paint-only slots that may still be added to this landscape's material: slot room and free mask channels. */
  const slotRoom = () => {
    const stack = node.terrain.layerStack
    return Math.max(0, Math.min(MAX_SLOTS - (stack.base.material?.slots.length ?? 0), MAX_PAINT_LAYERS - stack.usedChannels().length))
  }

  const notify = () => {
    eventEmitter.emit('TEXTURES_CHANGED')
    eventEmitter.emit('SCENE_CHANGED')
    eventEmitter.emit('TERRAIN_EDITED', node.id)
  }

  /**
   * Step 2: append paint-only slots for `adding` and neutralise the rules of `resetIds`, in the library
   * copy of the landscape's material. Returns layer id -> new slot id.
   *
   * A landscape with an EMBEDDED material is saved to the library first (slots are only ever authored on
   * a library material); one with no material at all gets a new one, built with the slots and assigned.
   */
  const editLibraryMaterial = (worldName: string, adding: WorldManifestLayer[], resetIds: ReadonlySet<string>): Map<string, string> => {
    const stack = node.terrain.layerStack
    const base = stack.base
    let asset: TerrainMaterialAsset | null = base.materialId ? terrainMaterials.find(m => m.id === base.materialId) ?? null : null
    if (!asset && base.material) asset = saveBaseToLibrary(`${node.name} material`)
    const tm = asset ? parseTerrainMaterialAsset(asset) : defaultLandscapeMaterial()

    const created = new Map<string, string>()
    const room = Math.max(0, Math.min(MAX_SLOTS - tm.slots.length, MAX_PAINT_LAYERS - stack.usedChannels().length))
    for (const layer of adding.slice(0, room)) {
      const slot = newLandscapeSlot({ name: layer.name, material: hintSurface(layer.color), tiling: tm.tiling, manual: true })
      // newLandscapeSlot starts paint-only slots without foliage (they are usually roads); grass is not.
      slot.allowFoliage = kindAllowsFoliage(layer.kind)
      tm.slots.push(slot)
      created.set(layer.id, slot.id)
    }
    for (const s of tm.slots) if (resetIds.has(s.id)) s.rule = neutralRule(s.rule)

    if (!asset) {
      const next = buildTerrainMaterialAsset(tm, `${worldName} landscape`, '')
      addTerrainMaterial(next)
      assignBase(next)
    } else {
      const next = buildTerrainMaterialAsset(tm, asset.name, asset.thumbnail, asset.id)
      updateTerrainMaterial(asset.id, next)
      // Every landscape painted with it, this one included: the new slots get their channels here. The
      // others' history baselines are refreshed now (this one's is, by the import's own step).
      for (const ln of editorScene.landscapes)
        if (syncLandscapeMaterialLayers(ln.terrain, next) && ln.id !== node.id) eventEmitter.emit('TERRAIN_EDITED', ln.id)
    }
    return created
  }

  /** Run an import. Returns an error to show, or null when it was applied. */
  const commit = (req: WorldImportRequest): string | null => {
    const { world } = req
    const layers = world.weights ? world.manifest.layers : []
    const adding = layers.filter(l => req.mapping[l.id] === NEW_SLOT)
    const stackNow = node.terrain.layerStack
    const slotsNow = importSlotsOf(stackNow.base.material, materials)
    const resetIds = new Set(req.resetRules
      ? slotsNow.filter(s => layers.some(l => resolveTarget(req.mapping[l.id], slotsNow) === s.id) && ruleDeviations(s.rule).length).map(s => s.id)
      : [])
    const tab = materialTab()
    if ((adding.length || resetIds.size) && tab)
      return `“${tab.title}” is open in a tab. Close it first: saving it afterwards would remove the slots this import adds.`

    try {
      // 1. The world's size. Resolution and paint resolution stay the landscape's own.
      const cfg = node.terrain.config
      if (req.matchSize && Math.abs(cfg.size - world.manifest.size) > 1e-3) {
        withoutDirty(() => rebuildTerrain(node, { ...cfg, size: world.manifest.size }))
        eventEmitter.emit('SCENE_CHANGED')
        eventEmitter.emit('TERRAIN_EDITED', node.id)
      }

      // 2. The landscape material.
      const created = adding.length || resetIds.size ? editLibraryMaterial(world.name, adding, resetIds) : new Map<string, string>()
      const mapping: WorldMapping = {}
      for (const l of layers) {
        const v = req.mapping[l.id]
        mapping[l.id] = v === NEW_SLOT ? created.get(l.id) ?? null : v ?? null
      }

      // 3. One undo step. Everything is read off the node again: step 1 replaced its terrain.
      const terrain = node.terrain
      const stack = terrain.layerStack
      const heights = heightsFromImage(world.height, terrain.resolution, { ...req.range, ...req.orientation })
      const plan = world.weights ? planWorldImport({
        layers, planes: world.weights.planes, size: world.weights.size,
        slots: importSlotsOf(stack.base.material, materials), mapping,
        orientation: req.orientation, maskResolution: stack.maskResolution,
      }) : null
      const channels = (plan?.channels ?? []).map(c => stack.channelOf(c.slotId)).filter((c): c is number => c !== undefined)
      const unpainted: string[] = []
      recordStackEdit({
        scene: editorScene, nodeId: node.id, label: `Import world: ${world.name}`, push, notify, channels,
        heights: (t, h) => { applyHeightsTo({ terrain: t }, h, setTerrainHeights) },
      }, (s, t) => {
        applyHeightsTo({ terrain: t }, heights, setTerrainHeights)
        for (const c of plan?.channels ?? []) if (!s.writeChannel(c.slotId, c.alpha, plan!.resolution)) unpainted.push(c.slotId)
        return true
      })
      if (unpainted.length)
        Logger.warn(`Import world: ${unpainted.length} slot(s) have no paint channel (all ${MAX_PAINT_LAYERS} are in use) and were not painted.`, 'Editor')

      // What a later change to the world re-applies with. Outside history, as the heightmap import's is.
      if (world.creator) {
        node.setVariable(CREATOR_WORLD_VAR, serializeCreatorWorldLink({
          id: world.creator.id, revision: world.creator.revision, exportHash: world.creator.exportHash,
          mapping, orientation: req.orientation, matchSize: req.matchSize,
        }), 'string')
      }
      return null
    } catch (err) {
      return `Could not import the world: ${err instanceof Error ? err.message : err}`
    }
  }

  return { commit, materialTab, slotRoom }
}
