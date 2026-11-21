// What the editor writes back the first time it opens a project, done to an example before its folder is written,
// so opening examples/<slug>/ in Cleo writes nothing and a checkout stays clean. Each step is the editor's own rule,
// run through its own code where it has one:
//
//   settings     every field of ProjectSettings/settings.json, defaults filled in (features/options/projectSettings.ts
//                parseProjectSettings, which the editor reads the file through and saves back)
//   models       a holder node with one ModelNode collapses into it (utils/modelClips.ts flattenModelAsset, run on
//                the model library as it loads)
//   thumbnails   the explorer renders a thumbnail for every material, terrain material, model and particle system
//                and stores it on the record (assets/assetKinds.ts); the folder keeps that key, blank (folder/codec.ts)
//   scripts      each script's fields re-reflected under the current reflection rules, and stamped with their
//                version (syncScripts.mjs; the editor re-derives a script whose `reflect` is older)
//
// A rule the editor gains for what it rewrites on open belongs here too: `npm run test:example-folders`
// (applications/app-kit/desktop/tools/exampleFolderE2E.mjs: each example opened in the real app, nothing written) is
// what finds one.

import { editorModule, editorSrcModule } from './editorModules.mjs'
import { syncScripts } from './syncScripts.mjs'

/** The libraries whose records the explorer gives a rendered thumbnail. */
const THUMBNAILED = ['materials', 'terrainMaterials', 'models', 'particleSystems']

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Bring `bundle` (in place) to what the editor would save after opening it. Returns what changed, by step. */
export function normalizeForEditor(bundle) {
  const lib = bundle.libraries ??= {}
  const changed = []

  if (lib.projectSettings) {
    const { parseProjectSettings } = editorSrcModule('features/options/projectSettings.ts')
    const settings = parseProjectSettings(lib.projectSettings)
    if (!same(settings, lib.projectSettings)) { lib.projectSettings = settings; changed.push('settings') }
  }

  if (lib.models?.length) {
    const { flattenModelAsset } = editorModule('modelClips.ts')
    const flat = lib.models.map(m => flattenModelAsset(m))
    const n = flat.filter((m, i) => m !== lib.models[i]).length
    if (n) { lib.models = flat; changed.push(`${n} model(s) flattened`) }
  }

  let blank = 0
  for (const key of THUMBNAILED) {
    for (const record of lib[key] ?? []) {
      // Appended, as `{ ...asset, thumbnail }` appends a key the record did not have.
      if (record && typeof record.thumbnail !== 'string') { record.thumbnail = ''; blank++ }
    }
  }
  if (blank) changed.push(`${blank} thumbnail key(s)`)

  const scripts = syncScripts(bundle)
  if (scripts.length) changed.push(`${scripts.length} script(s) re-reflected`)
  return changed
}
