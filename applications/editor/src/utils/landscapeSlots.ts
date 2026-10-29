import {
  LandscapeNode, Terrain, TerrainMaterial, Material, newTerrainSlotId, defaultBlendRule,
  type TerrainMaterialSlot,
} from 'cleo'

// A landscape as the editor authors it: painted with ONE landscape material (the stack's base). Slot 0 is
// the ground, the material's own surface, covering everything; slots 1..n blend over it by rule, or —
// paint only — just where they are brushed, through a mask channel the stack gives each such slot.

/** The ground a new landscape starts with: the flat green it drew before it had any material. */
export const GROUND_COLOR: [number, number, number] = [0.38, 0.5, 0.28]

/** A fresh landscape material: one PBR ground surface, no slots. */
export function defaultLandscapeMaterial(): TerrainMaterial {
  return TerrainMaterial.Create('pbr', { baseColor: [...GROUND_COLOR], roughness: 0.9, metallic: 0 })
}

/**
 * A new landscape, with no material yet: it draws flat green until one is chosen in the Layers panel,
 * which offers the library and "New landscape material". What the Add menu and the Layers panel create.
 */
export function createLandscapeNode(name = 'landscape'): LandscapeNode {
  return new LandscapeNode(name, new Terrain({ size: 200, resolution: 129, chunkQuads: 32 }))
}

/**
 * What a slot is called on screen. A slot linked to a Material asset is named by it — renaming the
 * material renames the slot everywhere, with nothing to propagate — and falls back to its own stored
 * name when unlinked or when the material is missing from the library.
 */
export function slotDisplayName(slot: { name: string; surfaceMaterialId: string | null },
                                materials: readonly { id: string; name: string }[]): string {
  const linked = slot.surfaceMaterialId ? materials.find(m => m.id === slot.surfaceMaterialId) : undefined
  return linked?.name ?? slot.name
}

/**
 * A plain surface for a slot that has not been given a library material yet. WHITE, because the base
 * colour multiplies whatever texture is given to it next: the 0.6 grey this used to start at capped a
 * snow texture at 60% and read as "the whites are never white".
 */
export function blankSlotSurface(): Material {
  return Material.PBR({ baseColor: [1, 1, 1], roughness: 0.9, metallic: 0 })
}

/**
 * A new slot. Covers everywhere until it is given a rule (inheriting another's would hide it) — or, when
 * `manual`, nowhere until it is painted. Paint-only slots are roads and paths, so foliage is off for them.
 */
export function newLandscapeSlot(opts: {
  name: string; material?: Material; surfaceMaterialId?: string | null; tiling: number; manual?: boolean
}): TerrainMaterialSlot {
  return {
    id: newTerrainSlotId(),
    name: opts.name,
    material: opts.material ?? blankSlotSurface(),
    surfaceMaterialId: opts.surfaceMaterialId ?? null,
    tiling: opts.tiling,
    rule: defaultBlendRule(),
    allowFoliage: false,
    manual: !!opts.manual,
  }
}
