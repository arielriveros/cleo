// Drop the authoring a scene's dimension makes dead weight before a build ships: a scene keeps both a
// landscape and a tilemap while it is authored, but a published game needs only the one it uses.
// Runs BEFORE the terrain compression and the referenced-only texture filter, so a discarded landscape's
// layer textures are never deflated and never shipped. See buildMultiSceneGameData for that ordering.

/** Which node type a dimension has no use for. */
function deadType(dimension: '2D' | '3D'): 'landscape' | 'tilemap' {
  return dimension === '2D' ? 'landscape' : 'tilemap'
}

/**
 * Remove every dead subtree from a serialized scene tree, in place. Returns how many were removed.
 * The whole subtree goes, not just the node: a landscape's children are positioned relative to terrain
 * that is about to stop existing.
 */
export function stripDimensionData(sceneJson: any, dimension: '2D' | '3D'): number {
  const dead = deadType(dimension)
  let removed = 0

  const walk = (node: any): void => {
    if (!node || !Array.isArray(node.children)) return
    const kept: any[] = []
    for (const child of node.children) {
      if (child?.type === dead) { removed++; continue }
      walk(child)
      kept.push(child)
    }
    if (kept.length !== node.children.length) node.children = kept
  }

  // The root itself is never one of these (it is always a plain node), so walking from it is enough.
  walk(sceneJson)
  return removed
}

/**
 * Stamp a serialized scene root with its dimension, which is where the player's engine reads it
 * (`Scene.dimension` picks the flat 2D frame): '2D' recorded, '3D' removed (absent reads as 3D). A scene
 * saved before the engine knew its dimension does not carry it itself, so the build writes it from the
 * project's record.
 */
export function stampSceneDimension(sceneJson: any, dimension: '2D' | '3D'): void {
  if (!sceneJson || typeof sceneJson !== 'object') return
  if (dimension === '2D') sceneJson.dimension = '2D'
  else delete sceneJson.dimension
}
