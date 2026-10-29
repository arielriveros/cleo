import { Terrain, LandscapeNode } from 'cleo'
import type { TerrainConfig } from 'cleo'

// Re-create a landscape's terrain at a different size / resolution / chunk size / mask resolution,
// carrying everything the author made across onto it. The order of the carry-over steps is load-bearing.

/**
 * Swap `node`'s terrain for one built to `cfg`, resampling the sculpted shape, the layer stack (base,
 * paint layers and their masks) and the scattered foliage onto it. The node keeps its identity and
 * transform.
 */
export function rebuildTerrain(node: LandscapeNode, cfg: Required<TerrainConfig>): void {
  const old = node.terrain
  const next = new Terrain(cfg)

  // Origin FIRST: foliage instances are stored in world space, so the replacement must know where it is
  // before any of them are re-placed. setTerrain would set it one step too late.
  next.setOrigin(node.worldPosition)

  next.resampleHeightsFrom(old)
  // The whole stack, masks resampled by position. It used to be the four splat channels plus a per-slot
  // material copy loop, which dropped a legacy plain-albedo layer until it was special-cased.
  next.resampleLayersFrom(old)
  next.foliageColliders = { ...old.foliageColliders }
  next.resampleFoliageFrom(old)

  node.setTerrain(next)
}
