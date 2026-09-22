import type { Terrain, TerrainLayerStack, TerrainMaterial } from 'cleo'

// The layer-stack members of `Terrain`, reached through one module, so the editor's panels have a
// single place that knows how a terrain's layers are reached — and one place to change if that moves.

/** The terrain's layer stack, or null when there is no terrain. */
export function layerStackOf(terrain: Terrain | null | undefined): TerrainLayerStack | null {
  return terrain?.layerStack ?? null
}

/** Replace the whole height field (terrain-local metres, row-major, resolution²). */
export function setTerrainHeights(terrain: Terrain, heights: Float32Array): boolean {
  terrain.setHeights(heights)
  return true
}

/**
 * Tell the terrain its layers changed in a way it cannot see — a landscape material edited in place, a
 * base assigned — so it re-flattens its surfaces.
 */
export function layersChanged(terrain: Terrain): void {
  terrain.refreshLayers()
}

/** Every landscape material a terrain's stack holds, with the stack slot it sits in. */
export function stackMaterials(terrain: Terrain): { target: 'base' | string; material: TerrainMaterial; materialId: string | null }[] {
  const stack = terrain.layerStack
  const out: { target: 'base' | string; material: TerrainMaterial; materialId: string | null }[] = []
  if (stack.base.material) out.push({ target: 'base', material: stack.base.material, materialId: stack.base.materialId })
  for (const L of stack.paintLayers) if (L.material) out.push({ target: L.id, material: L.material, materialId: L.materialId })
  return out
}
