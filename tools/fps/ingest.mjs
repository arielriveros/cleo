// Firing Line: refresh the example from a project exported out of the editor.
//
//   node --max-old-space-size=12288 tools/fps/ingest.mjs [path/to/Firing-Line.cleoproj.zip]
//
// The example is no longer generated: the project (build/Firing-Line.cleoproj.zip, edited and exported from the
// editor) is the source of truth for the scene, templates, materials, models, animations, sounds and baked GI.
// What this repository still owns is the SCRIPTS (examples/scripts/Fps*.ts), so this tool takes the zip and
//
//   1. keeps one scene (the zip's main scene, renamed "Firing Line"), dropping the others;
//   2. writes the current examples/scripts sources and reflected fields into the script library and into every
//      node and template that embeds a copy, and carries the manager's old `mode` over to `gameType`;
//   3. repacks the bundle (editor reader + writer, assets split in parts under GitHub's file limit) into
//      applications/editor/public/examples/firing-line/, leaving example.json alone.
//
// After a script-only edit, run it on the example folder itself: `node tools/fps/ingest.mjs --scripts-only`.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { loadScriptReflector, stableId as nsId } from '../exampleKit/bundle.mjs'
import { packFormat2, readGiBakes } from '../exampleKit/packFormat2.mjs'
import { applyEventActions } from './eventActions.mjs'
import { applyWarehouse } from './warehouse.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SCRIPTS = path.join(ROOT, 'examples', 'scripts')
const EXAMPLE = path.join(ROOT, 'applications', 'editor', 'public', 'examples', 'firing-line')
const require = createRequire(path.join(ROOT, 'applications', 'editor', 'package.json'))
const JSZip = require('jszip')

const scriptsOnly = process.argv.includes('--scripts-only')
const zipPath = path.resolve(process.argv.slice(2).find(a => !a.startsWith('--')) ?? path.join(ROOT, 'build', 'Firing-Line.cleoproj.zip'))
const SCENE_NAME = 'Firing Line'

// ----- the script assets ----------------------------------------------------------------------------------

/** [asset name, file, base node type]. A script asset is named after its file; ids are the ones the project holds. */
const SCRIPT_FILES = [
  ['FpsShared', 'node'], ['FpsCombatant', 'character'], ['FpsGameManager', 'node'], ['FpsPlayer', 'character'],
  ['FpsBot', 'character'], ['FpsHud', 'uiRoot'], ['FpsFx', 'node'], ['FpsDecal', 'node'], ['FpsTracer', 'node'], ['FpsMarker', 'node'],
]
const reflect = loadScriptReflector(ROOT)
const readScript = (file) => fs.readFileSync(path.join(SCRIPTS, `${file}.ts`), 'utf8')

/** A class script's fields including the ones it inherits from base-class scripts, base first. */
function resolveVariables(file, seen = new Set()) {
  const source = readScript(file)
  const own = reflect(source)
  const ext = /export\s+default\s+class\s+\w+\s+extends\s+(\w+)/.exec(source)
  const imp = ext && new RegExp(`import\\s+${ext[1]}\\s+from\\s+['"](?:\\./|@/(?:[^'"]*/)?)(\\w+)['"]`).exec(source)
  if (!imp || seen.has(imp[1])) return own
  seen.add(file)
  const merged = new Map()
  for (const v of [...resolveVariables(imp[1], seen), ...own]) merged.set(v.name, v)
  return [...merged.values()]
}

const sources = new Map()
for (const [file] of SCRIPT_FILES) {
  const source = readScript(file)
  const kind = /^\s*export\s+default\s+class\b/m.test(source) ? 'class' : 'module'
  sources.set(file, { id: nsId('fps:script:' + file), source, kind, variables: kind === 'module' ? [] : resolveVariables(file) })
}
const byId = new Map([...sources.values()].map(s => [s.id, s]))

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v))

/** Every node (and template node) that links a script gets the current source; the library gets source + fields. */
function refreshScripts(dir) {
  const lib = path.join(dir, 'libraries', 'scripts.json')
  const assets = readJson(lib)
  for (const a of assets) {
    const s = sources.get(a.name)
    if (!s) continue
    if (s.id !== a.id) throw new Error(`script ${a.name} has id ${a.id} in the project, ${s.id} here`)
    Object.assign(a, { source: s.source, kind: s.kind, variables: s.variables })
  }
  writeJson(lib, assets)

  const fix = (n) => {
    const link = n.variables?.__scriptId?.value
    const s = link && byId.get(link)
    if (s) {
      n.script = s.source
      // The manager's old `mode` field is the new `gameType`.
      if (n.scriptVars && 'mode' in n.scriptVars && s === sources.get('FpsGameManager')) {
        n.scriptVars = { ...n.scriptVars, gameType: n.scriptVars.mode }
        delete n.scriptVars.mode
      }
    }
    for (const c of n.children ?? []) fix(c)
  }
  const files = [path.join(dir, 'libraries', 'templates.json'), ...fs.readdirSync(path.join(dir, 'scenes')).map(f => path.join(dir, 'scenes', f))]
  for (const f of files) {
    const data = readJson(f)
    if (Array.isArray(data)) for (const t of data) fix(t.nodeJson ?? t)
    else fix(data.scene)
    writeJson(f, data)
  }
}

// ----- GI bakes -------------------------------------------------------------------------------------------

/**
 * Every GI Volume names a bake by a stable id (derived from its node id), so a bake made by
 * `node tools/valley/bakeGI.cjs --example firing-line --scenes "Firing Line"` is found again after the next ingest.
 * A volume the project holds without one is given its id here; its bake is then captured by that tool.
 */
function ensureBakeIds(dir) {
  for (const name of fs.readdirSync(path.join(dir, 'scenes'))) {
    const file = path.join(dir, 'scenes', name)
    const scene = readJson(file)
    const walk = (n) => {
      if (n.type === 'giVolume' && n.giVolume && !n.giVolume.bakeId) n.giVolume.bakeId = nsId('fps:gi:' + n.id)
      for (const c of n.children ?? []) walk(c)
    }
    walk(scene.scene)
    writeJson(file, scene)
  }
}

/** The bakes the example already carries, for the volumes the freshly ingested scene still names. */
function carriedBakes(dir) {
  const named = new Set()
  const walk = (n) => { if (n.type === 'giVolume' && n.giVolume?.bakeId) named.add(n.giVolume.bakeId); for (const c of n.children ?? []) walk(c) }
  for (const name of fs.readdirSync(path.join(dir, 'scenes'))) walk(readJson(path.join(dir, 'scenes', name)).scene)
  return readGiBakes(EXAMPLE).filter(b => named.has(b.id))
}

// ----- the project ------------------------------------------------------------------------------------------

async function unzip(zip, dir) {
  const z = await JSZip.loadAsync(fs.readFileSync(zip))
  for (const [name, entry] of Object.entries(z.files)) {
    const out = path.join(dir, ...name.split('/'))
    if (entry.dir) { fs.mkdirSync(out, { recursive: true }); continue }
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, await entry.async('nodebuffer'))
  }
}

function singleScene(dir) {
  const mp = path.join(dir, 'manifest.json')
  const manifest = readJson(mp)
  const keep = manifest.mainSceneId
  for (const m of manifest.sceneMetas) if (m.id !== keep) fs.rmSync(path.join(dir, 'scenes', `${m.id}.json`), { force: true })
  manifest.sceneMetas = manifest.sceneMetas.filter(m => m.id === keep).map(m => ({ ...m, name: SCENE_NAME }))
  manifest.openSceneId = keep
  writeJson(mp, manifest)
}

function install(from, to) {
  const OWNED = /^(manifest\.json|vfs\.json|assets\.json|assets(\.\d+)?\.bin)$/
  for (const name of fs.readdirSync(to)) {
    if (OWNED.test(name) || ['libraries', 'scenes', 'textures'].includes(name)) fs.rmSync(path.join(to, name), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
  for (const name of fs.readdirSync(from)) fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true })
}

/** What every pack applies to the inflated bundle (each idempotent): the clip event actions, then the warehouse annex. */
async function applyPasses(bundle) {
  applyEventActions(bundle)
  await applyWarehouse(bundle)
}

if (scriptsOnly) {
  // The example folder itself: unpack format 2, refresh the scripts, pack it again.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-scripts-'))
  fs.cpSync(EXAMPLE, work, { recursive: true })
  refreshScripts(work)
  await packFormat2(work, { mutate: applyPasses })
  install(work, EXAMPLE)
  fs.rmSync(work, { recursive: true, force: true })
  console.log('scripts refreshed in', EXAMPLE)
} else {
  if (!fs.existsSync(zipPath)) { console.error(`no project at ${zipPath}`); process.exit(1) }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-ingest-'))
  console.log('unpacking', zipPath)
  await unzip(zipPath, work)
  singleScene(work)
  refreshScripts(work)
  ensureBakeIds(work)
  const giBakes = carriedBakes(work)
  console.log(`repacking (${giBakes.length} GI bakes carried over)`)
  const largest = await packFormat2(work, { giBakes, mutate: applyPasses })
  install(work, EXAMPLE)
  fs.rmSync(work, { recursive: true, force: true })
  console.log(`${EXAMPLE} written - largest file ${(largest / 1048576).toFixed(1)} MB`)
}
