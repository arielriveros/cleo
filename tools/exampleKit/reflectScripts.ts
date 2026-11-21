// Re-derive every example's script fields (`variables`) from its own .ts files, under the editor's current
// reflection rules, inherited fields included (syncScripts.mjs), and point the node fields of each scene at their
// nodes (nodeFields.mjs). Run after the rules change (what makes a field an inspector attribute, what a decorator
// means), or after editing scripts outside Cleo (`npm run examples:sync` does the first half alone).
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/exampleKit/reflectScripts.ts [name ...]
//
// Writing the folder also puts every template's and variant's copy of a source back to the script's own.

import { log, read, write } from '../valley/bundleOps'
import { applyNodeFields } from './nodeFields.mjs'
import { listExamples } from './folder.mjs'
import { syncScripts } from './syncScripts.mjs'

const only = process.argv.slice(2)

for (const { slug: name, dir } of listExamples()) {
  if (only.length && !only.includes(name)) continue
  const bundle: any = await read(dir)
  let changed = syncScripts(bundle).length
  // The node fields (`sun: LightNode`), pointed at the node each used to look up by name (nodeFields.mjs).
  for (const scene of Object.values(bundle.scenes ?? {}) as any[])
    changed += applyNodeFields(scene.scene ?? scene, bundle.libraries.scripts, (m: string) => log(`${name}:${m}`))
  if (!changed) { log(`${name}: fields up to date`); continue }
  log(`${name}: ${changed} change(s)`)
  await write(dir, bundle, name)
}
