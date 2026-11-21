// Fold the 3D examples' static scenery Colliders into one `Static Collision` Collider per scene (one per way of
// colliding), its meshes under it (see mergeColliders.ts).
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/exampleKit/mergeStaticColliders.ts [name ...] [--dry]
//
// Re-runnable: a second run finds nothing left to merge, and a `Static Collision` already there is left alone.

import fs from 'fs'
import path from 'path'
import { EXAMPLES, log, read, write } from '../valley/bundleOps'
import { stableId } from './bundle.mjs'
import { mergeStaticColliders, sameHit, staticRayHits, stringLiterals } from './mergeColliders'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const only = args.filter(a => !a.startsWith('--'))
const THREE_D = ['dungeon', 'valley', 'firing-line']

for (const name of THREE_D) {
  const dir = path.join(EXAMPLES, name)
  if (!fs.existsSync(path.join(dir, 'project.cleo')) || (only.length && !only.includes(name))) continue
  const bundle: any = await read(dir)
  const scriptStrings = stringLiterals((bundle.libraries.scripts ?? []).map((s: any) => s.source))
  // A sequence keys its tracks to nodes by id.
  const externalRefs = new Set<string>()
  const scan = (v: any) => { if (typeof v === 'string') externalRefs.add(v); else if (v && typeof v === 'object') Object.values(v).forEach(scan) }
  for (const s of bundle.libraries.sequences ?? []) scan(s)

  let merged = 0
  for (const [sceneId, data] of Object.entries<any>(bundle.scenes)) {
    const before = await staticRayHits(data.scene)
    const r = mergeStaticColliders(data.scene, { scriptStrings, externalRefs, idFor: key => stableId(`merge:${name}:${sceneId}:${key}`) })
    for (const c of r.colliders) log(`${name}: ${c.name}: ${c.shapes} shapes, ${c.meshes} nodes under it`)
    for (const k of r.kept) log(`${name}: kept ${k}`)
    log(`${name}: ${r.merged} colliders merged`)
    // The merged world must stop every ray where the old one did.
    const after = await staticRayHits(data.scene, before.bounds)
    const differ = before.hits.filter((h, i) => !sameHit(h, after.hits[i])).length
    const hits = before.hits.filter(Boolean).length
    for (let i = 0; i < before.hits.length; i++) if (!sameHit(before.hits[i], after.hits[i])) log(`  ray ${i}: ${JSON.stringify(before.hits[i])} -> ${JSON.stringify(after.hits[i])}`)
    if (differ) throw new Error(`${name}: ${differ} of ${before.hits.length} rays hit differently after the merge`)
    log(`${name}: ${before.hits.length} rays (${hits} hits) land where they did (within 2 mm)`)
    merged += r.merged
  }
  if (!merged) { log(`${name}: nothing to merge`); continue }
  await write(dir, bundle, name, DRY)
}
