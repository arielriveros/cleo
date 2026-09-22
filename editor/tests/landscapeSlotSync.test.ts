import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { withSyncedSlotMaterial } from '../src/utils/terrainMaterials'
import type { TerrainMaterialAsset } from '../src/utils/terrainMaterials'

// A landscape material's SLOTS embed a copy of an ordinary Material asset, linked by `surfaceMaterialId`.
// Nothing about a copy updates on its own, and neither material-instance sync (scene nodes) nor foliage
// rule sync (models) can reach one — so saving "Rock" left every landscape using it drawing the old rock.

const asset = (slots: any[]): TerrainMaterialAsset => ({
  id: 'tm1', name: 'Cliffside', thumbnail: '', textures: [],
  material: { type: 'pbr', tiling: 20, slots },
} as any)

const rock = { type: 'pbr', properties: { baseColor: [0.4, 0.4, 0.45] } }

describe('slot material propagation', () => {
  it('replaces the embedded copy in every slot that links the saved material', () => {
    const before = asset([
      { id: 's1', surfaceMaterialId: 'rock', material: { type: 'pbr', properties: { baseColor: [1, 0, 0] } } },
      { id: 's2', surfaceMaterialId: 'snow', material: { type: 'pbr', properties: { baseColor: [1, 1, 1] } } },
      { id: 's3', surfaceMaterialId: 'rock', material: { type: 'pbr', properties: { baseColor: [1, 0, 0] } } },
    ])
    const after = withSyncedSlotMaterial(before, 'rock', rock)!
    expect(after).not.toBeNull()
    expect(after.material.slots[0].material.properties.baseColor).toEqual([0.4, 0.4, 0.45])
    expect(after.material.slots[2].material.properties.baseColor).toEqual([0.4, 0.4, 0.45])
    // Untouched, and not shared with the one that was replaced.
    expect(after.material.slots[1].material.properties.baseColor).toEqual([1, 1, 1])
    expect(after.material.slots[0].material).not.toBe(after.material.slots[2].material)
  })

  it('leaves the stored asset alone — the library is React state, so a mutation would not re-render', () => {
    const before = asset([{ id: 's1', surfaceMaterialId: 'rock', material: { type: 'pbr' } }])
    const after = withSyncedSlotMaterial(before, 'rock', rock)!
    expect(after).not.toBe(before)
    expect(before.material.slots[0].material).toEqual({ type: 'pbr' })
  })

  it('returns null when nothing links the material, so no asset is rewritten for nothing', () => {
    expect(withSyncedSlotMaterial(asset([{ id: 's1', surfaceMaterialId: 'snow', material: {} }]), 'rock', rock)).toBeNull()
    expect(withSyncedSlotMaterial(asset([]), 'rock', rock)).toBeNull()
    expect(withSyncedSlotMaterial({ id: 'x', name: 'x', material: {} } as any, 'rock', rock)).toBeNull()
  })

  it('runs on every material save, alongside the node and foliage syncs', () => {
    const ctx = readFileSync(join(__dirname, '..', 'src', 'features', 'EngineContext.tsx'), 'utf8')
    expect(ctx).toMatch(/syncFoliageRulesForMaterial\(tab\.materialId!, tab\.id\);[\s\S]{0,200}syncTerrainMaterialSlots\(tab\.materialId!, asset, tab\.id\)/)
    // Inside withoutDirty with the others: propagation must not mark other tabs unsaved.
    expect(ctx).toMatch(/withoutDirty\(\(\) => \{[\s\S]{0,700}syncTerrainMaterialSlots\(/)
  })
})
