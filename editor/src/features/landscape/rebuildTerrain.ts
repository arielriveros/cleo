import { Terrain, LandscapeNode } from 'cleo'
import type { TerrainConfig } from 'cleo'

// Re-create a landscape's terrain at a different size / resolution / chunk size, carrying everything the
// author made across onto it. The order of the carry-over steps is load-bearing.

/**
 * Swap `node`'s terrain for one built to `cfg`, resampling the sculpted shape, the painted splat, the
 * layer materials and the scattered foliage onto it. The node keeps its identity and transform.
 */
export function rebuildTerrain(node: LandscapeNode, cfg: Required<TerrainConfig>): void {
  const old = node.terrain
  const next = new Terrain(cfg)

  // Origin FIRST: foliage instances are stored in world space, so the replacement must know where it is
  // before any of them are re-placed. setTerrain would set it one step too late.
  next.setOrigin(node.worldPosition)

  next.resampleHeightsFrom(old)
  next.resampleSplatFrom(old)
  for (let i = 0; i < old.layers.length && i < 4; i++) {
    const layer = old.layers[i]
    if (!layer.material) continue
    next.setLayer(i, layer.material, {
      tiling: layer.tiling, auto: layer.auto, hRange: layer.hRange, sRange: layer.sRange,
      materialId: layer.materialId ?? null,
    })
  }
  next.foliageColliders = { ...old.foliageColliders }
  next.resampleFoliageFrom(old)

  node.setTerrain(next)
}
