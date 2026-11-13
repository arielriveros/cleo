// Fixes to the shipped Valley that are not part of its cinematic, applied by applyCinematic.ts before it (and by
// split.ts, which drops the same nodes on a re-split). Each is idempotent: a second run finds nothing to do.

import { VALLEY_SCENE, log, checkNodeRefs, prune } from './bundleOps'

/**
 * Remove the 30 puddle decals (the `Puddles` group) from the Valley, and with them the Water Puddle Decal
 * material and its textures, which nothing else uses. They predate the weather system, whose volume fills the
 * ground's own low, flat spots with standing water as it rains (WeatherNode `puddles`).
 */
export function removePuddles(bundle: any): number {
  const root = bundle.scenes[VALLEY_SCENE]?.scene
  if (!root) throw new Error('no Valley scene')
  const groups = (root.children ?? []).filter((c: any) => c.name === 'Puddles')
  if (groups.length === 0) return 0
  root.children = root.children.filter((c: any) => !groups.includes(c))
  checkNodeRefs(root, groups, 'valley: puddles')
  const { removed } = prune(bundle)
  const count = groups.reduce((n: number, g: any) => n + (g.children?.length ?? 0), 0)
  log(`valley: ${count} puddle decals removed; pruned ${Object.entries(removed).map(([k, v]) => `${(v as string[]).length} ${k}`).join(', ') || 'nothing'}`)
  return count
}
