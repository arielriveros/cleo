#!/usr/bin/env node
// The Mixamo "Pro Rifle Pack" clips (build/fps_prepared/pack/*.fbx, unzipped from build/Pro Rifle Pack.zip),
// retargeted onto Ch05 (the zip's own character, so the rig the clips are authored on) and written to the
// committed `fpsClips.json`:
//
//     node --max-old-space-size=8192 tools/fps/prepareCharacters.mjs ch05
//     node tools/fps/importClips.mjs
//
// Every clip is held in place (a blend field cannot carry root motion, see fbxImport.holdInPlace) except the
// deaths, which keep their fall: they play as the base layer's Dead state. Names are `Fps_<PascalCase file>`.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { editorModules, engineModules, importClipFile, loadAssimp, retargetTargetOf } from '../exampleKit/fbxImport.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const DIR = path.join(ROOT, 'build', 'fps_prepared', 'pack')
const OUT = path.join(HERE, 'fpsClips.json')

const pascal = (s) => s.replace(/\.fbx$/i, '').split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1)).join('')

async function main() {
  const ajs = await loadAssimp(ROOT)
  const ctx = { ajs, ...engineModules(ROOT) }
  const { loadSkin } = editorModules(ROOT)
  const { skin } = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'fps_prepared', 'ch05', 'ch05.json'), 'utf8'))
  const target = retargetTargetOf(loadSkin, skin)
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.fbx') && !/^Ch\d+/i.test(f)).sort()
  console.log(`fps: ${files.length} clips onto ${target.joints.length} joints`)
  const out = []
  for (const file of files) {
    const name = `Fps_${pascal(file)}`
    const death = /^death/i.test(file)
    const res = await importClipFile(ctx, path.join(DIR, file), name, target, { rootMotion: death, ratioRange: [0.5, 2] })
    out.push(res.clip)
    console.log(`  ${name.padEnd(36)} ${res.seconds.toFixed(2).padStart(5)}s ratio ${res.ratio.toFixed(3)}${death ? ' rootMotion' : ''}${res.held > 0.5 ? ` held ${(res.held / 100).toFixed(2)}m` : ''}`)
  }
  fs.writeFileSync(OUT, JSON.stringify(out, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e5) / 1e5 : v)))
  console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB)`)
}

await main()
