// Make templates of the shipped examples' repeated subtrees (see templatize.ts): every group the scene places
// more than once becomes a template, its copies instances, its near-copies variants.
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/exampleKit/templatizeExamples.ts [name ...] [--dry]
//
// For the bundles whose generators can no longer run (Dungeon, Valley, Firing Line); Duskwell's generator
// (tools/duskwell/build.ts) runs the same pass itself. Re-runnable: a copy already an instance is left alone.

import fs from 'fs'
import path from 'path'
import { EXAMPLES, log, read, write } from '../valley/bundleOps'
import { stableId } from './bundle.mjs'
import { folderFor, templatizeScene } from './templatize'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const only = args.filter(a => !a.startsWith('--'))
const SKIP = new Set(['duskwell'])   // its generator templatizes

for (const name of fs.readdirSync(EXAMPLES)) {
  const dir = path.join(EXAMPLES, name)
  if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, 'project.cleo'))) continue
  if (SKIP.has(name) || (only.length && !only.includes(name))) continue
  const bundle: any = await read(dir)
  const lib = (bundle.libraries.templates ??= [])
  const takenNames = new Set<string>(lib.map((t: any) => t.name))
  const folderOfAsset = new Map<string, string>()
  for (const e of bundle.vfs?.entries ?? []) if (e.assetId) folderOfAsset.set(e.assetId, path.posix.dirname(e.path))

  let made = 0
  for (const [sceneId, data] of Object.entries<any>(bundle.scenes)) {
    const { templates, log: lines } = templatizeScene(data.scene, {
      takenNames,
      idFor: key => stableId(`tpl:${name}:${sceneId}:${key}`),
    })
    for (const l of lines) log(`${name}: ${l}`)
    for (const m of templates) {
      lib.push(m.template)
      const folder = folderFor(m, folderOfAsset)
      bundle.vfs.entries.push({ path: `${folder}/${m.template.name}.tpl`, kind: 'template', assetId: m.template.id, created: bundle.manifest.createdAt })
      for (let d = folder; d && d !== '/'; d = path.posix.dirname(d))
        if (!bundle.vfs.folders.includes(d)) bundle.vfs.folders.push(d)
      const meta = bundle.manifest.sceneMetas?.find((s: any) => s.id === sceneId)
      if (meta?.refs) meta.refs.templateIds = [...new Set([...(meta.refs.templateIds ?? []), m.template.id])]
    }
    made += templates.length
  }
  bundle.vfs.folders.sort()
  if (!made) { log(`${name}: nothing repeated`); continue }
  log(`${name}: ${made} template(s)`)
  await write(dir, bundle, name, DRY)
}
