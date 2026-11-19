// Camera rigs pick collision layers, in the shipped examples (player contract 45).
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/exampleKit/convertCameraLayers.ts [name ...]
//
// The examples were generated when the camera had channels of its own: a Collider's `cameraCollision`, a node's
// or a foliage rule's `cameraDither` (see-through), and a rig's `collisionMode`. The engine reads those as it
// loads (src/core/scene/nodes/cameraLayersLegacy.ts); this tool does the same to the SHIPPED data, so the examples
// are stored the way the editor now saves them (the Valley's and the Dungeon's generators cannot be rerun: their
// source art is gone):
//
//   - every Collider lands on the layer that does what its flags did: See Through for one that (or a mesh in
//     which) was see-through, No Camera for one the camera passed; every rig on the Blocked by / See through
//     masks of its old mode; every foliage rule or layer with collision that was see-through on See Through;
//   - the Dungeon's pillars, whose meshes were see-through on their own while their walls were a separate
//     Collider, go INTO that Collider: a rig now sees through what a Collider on a See through layer holds, and
//     a mesh outside any Collider is never seen through.
//
// Re-runnable: a converted project has nothing left to convert.

import fs from 'fs'
import path from 'path'
import { EXAMPLES, log, nodes, read, write } from '../valley/bundleOps'
import { migrateCameraLayersTree, legacyFoliageCollisionLayer, type CameraLayersMigration } from '../../src/core/scene/nodes/cameraLayersLegacy'
import { LAYER } from '../../src/physics/collisionLayers'

const DRY = !!process.env.CONVERT_DRY
const only = process.argv.slice(2)

/** Foliage rules and saved foliage layers anywhere in `v` (a terrain material, a terrain node): `cameraDither` read into their collision layer. */
function migrateFoliage(v: any): number {
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v)) return 0
  let n = 0
  if (Array.isArray(v)) { for (const x of v) n += migrateFoliage(x); return n }
  if ('cameraDither' in v && !('children' in v)) {
    const layer = legacyFoliageCollisionLayer(v)
    if (layer !== undefined && v.collision && typeof v.collision === 'object') v.collision = { ...v.collision, layer }
    delete v.cameraDither
    n++
  }
  for (const x of Object.values(v)) n += migrateFoliage(x)
  return n
}

const IDENTITY = (n: any) => !n.quaternion
  && (!n.position || n.position.every((x: number) => x === 0))
  && (!n.rotation || n.rotation.every((x: number) => x === 0))
  && (!n.scale || n.scale.every((x: number) => x === 1))

/**
 * The Dungeon's pillar meshes into the Collider of the pillars' walls (merged, at the origin, now on See Through).
 * Returns whether it moved them.
 */
function pillarsIntoTheirCollider(sceneRoot: any): boolean {
  // Level > Dungeon Structure > Pillars, the path the generator lays it on.
  const chain: any[] = []
  const find = (n: any, names: string[]): boolean => {
    if (!names.length) return true
    const next = n.children?.find((c: any) => c.name === names[0])
    if (!next) return false
    chain.push(next)
    return find(next, names.slice(1))
  }
  const found = find(sceneRoot, ['Level', 'Dungeon Structure', 'Pillars'])
  const pillars = found ? chain[2] : undefined
  const structure = chain[1]
  const collider = sceneRoot.children?.find((c: any) => c.type === 'collider' && /^Static Collision \(blocksSwings, see-through\)$|^Static Collision \(blocksSwings, See Through\)$/.test(c.name))
  if (!collider) throw new Error('dungeon: no pillars collider at the scene root')
  if (collider.collider?.layer !== LAYER.SEE_THROUGH) throw new Error(`dungeon: the pillars collider is on layer ${collider.collider?.layer}, not See Through`)
  collider.name = 'Static Collision (blocksSwings, See Through)'
  if (!pillars) return false   // moved already
  // The meshes keep their world transforms: everything between them and the scene root, and the collider, is
  // the identity (checked, not assumed).
  if (!chain.every(IDENTITY) || !IDENTITY(collider))
    throw new Error('dungeon: the pillars or their collider are not at the identity; move them by hand')
  structure.children = structure.children.filter((c: any) => c !== pillars)
  collider.children = [...(collider.children ?? []), pillars]
  return true
}

for (const name of fs.readdirSync(EXAMPLES)) {
  const dir = path.join(EXAMPLES, name)
  if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, 'manifest.json'))) continue
  if (only.length && !only.includes(name)) continue
  const bundle: any = await read(dir)
  const lib = bundle.libraries
  const counts: CameraLayersMigration = { colliders: 0, rigs: 0, loose: 0 }
  let changed = false
  const migrate = (root: any) => {
    const before = JSON.stringify(root)
    const out = migrateCameraLayersTree(root, counts)
    const foliage = migrateFoliage(out)
    if (foliage || JSON.stringify(out) !== before) changed = true
    return out
  }

  // The Dungeon's pillar meshes asked for the hole on their own, outside any Collider: they move into theirs
  // first, so the tree conversion below sees them inside it (and counts none loose).
  let moved = false
  for (const data of Object.values(bundle.scenes) as any[]) {
    if (name !== 'dungeon') continue
    const looseBefore = [...nodes(data.scene)].filter(n => n.cameraDither === true && n.type !== 'collider').length
    const root = migrateCameraLayersTree(data.scene, counts)
    if (pillarsIntoTheirCollider(root)) { moved = true; changed = true }
    data.scene = root
    log(`dungeon: ${looseBefore} see-through meshes, pillars ${moved ? 'moved into their collider' : 'already in it'}`)
  }
  for (const data of Object.values(bundle.scenes) as any[]) data.scene = migrate(data.scene)
  for (const t of lib.templates ?? []) if (t.nodeJson) t.nodeJson = migrate(t.nodeJson)
  for (const m of lib.terrainMaterials ?? []) if (migrateFoliage(m)) changed = true

  if (!changed) { log(`${name}: nothing to convert`); continue }
  log(`${name}: ${counts.colliders} collider(s) onto a camera layer, ${counts.rigs} rig(s) onto layers, ${counts.loose} loose see-through mesh(es) dropped`)
  await write(dir, bundle, name, DRY)
}
