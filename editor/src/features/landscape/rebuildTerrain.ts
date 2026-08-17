import { Terrain, LandscapeNode } from 'cleo'
import type { TerrainConfig } from 'cleo'

// Re-create a landscape's terrain at a different size / resolution / chunk size, carrying everything the
// author made across onto it.
//
// The ORDER here is load-bearing and is the whole reason this lives in one place rather than inline in a
// panel. Rebuilding used to keep only the heights, which silently reset every paint layer to layer 0 and
// then regenerated foliage against that blank splat.

/**
 * Swap `node`'s terrain for one built to `cfg`, resampling the sculpted shape, the painted splat, the
 * layer materials and the scattered foliage onto it. The node keeps its identity and transform, so a
 * rebuild never disturbs the selection or anything parented to it.
 */
export function rebuildTerrain(node: LandscapeNode, cfg: Required<TerrainConfig>): void {
  const old = node.terrain
  const next = new Terrain(cfg)

  // Origin FIRST. Foliage instances are stored in world space, so the replacement needs to know where it
  // is before any of them are re-placed onto it — setTerrain would set it one step too late.
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
  // Carry the author's placement across rather than re-rolling it — a resize is not a request to
  // redistribute every tree.
  next.resampleFoliageFrom(old)

  node.setTerrain(next)
}
