// Render the World Creator's terrain presets headless: a sheet with each preset from above and from a low
// oblique view at true proportions (tools/world/sheet.ts), and a table of the measures in
// applications/creator/src/world/terrainStats.ts. What the presets are tuned by.
//
//   npx vite-node --config applications/creator/vitest.config.ts tools/world/renderPresets.ts <out.png> [resolution] [preset ids...]
//
// Tiles run left to right, top to bottom, in the order printed.

import { SILENT_CONTEXT } from '../../applications/creator/src/core/generator'
import { generateWorld } from '../../applications/creator/src/world/generateWorld'
import { buildFields } from '../../applications/creator/src/world/pipeline'
import { WORLD_PRESETS } from '../../applications/creator/src/world/presets'
import { terrainStats } from '../../applications/creator/src/world/terrainStats'
import { normaliseWorld, type WorldDoc } from '../../applications/creator/src/world/worldDoc'
import { Sheet } from './sheet'

const [outPath, resArg, ...ids] = process.argv.slice(2)
if (!outPath) throw new Error('usage: renderPresets.ts <out.png> [resolution] [preset ids...]')
const RES = Number(resArg ?? 513)
const presets = WORLD_PRESETS.filter(p => !ids.length || ids.includes(p.id))
const sheet = new Sheet(presets.length)

console.log(`resolution ${RES}`)
console.log('preset            size    relief   land  slope mean/P50/P90/P99 (deg)  hollows  lakes  concavity  ms')
let k = 0
for (const p of presets) {
  const doc: WorldDoc = normaliseWorld(p.params())
  const t0 = Date.now()
  const out = await generateWorld(doc, SILENT_CONTEXT, { resolution: RES })
  const ms = Date.now() - t0
  const fields = buildFields(out, doc)
  const R = out.frame.resolution, kh = doc.settings.heightScale, size = doc.settings.size
  const hm = new Float32Array(R * R)
  for (let i = 0; i < hm.length; i++) hm[i] = out.heights[i] * kh
  const sea = doc.settings.seaLevel * kh
  const s = terrainStats(hm, R, size / (R - 1), sea)
  console.log(`${p.id.padEnd(16)} ${String(size).padStart(5)} m ${(s.max - s.min).toFixed(0).padStart(6)} m  ${s.land.toFixed(2)}  `
    + `${s.slopeMean.toFixed(1)}/${s.slopeP50.toFixed(1)}/${s.slopeP90.toFixed(1)}/${s.slopeP99.toFixed(1)}`.padEnd(28)
    + ` ${(s.hollows * 100).toFixed(1).padStart(5)}%  ${String(fields.water.lakes.length).padStart(5)}  ${Number.isFinite(s.concavity) ? s.concavity.toFixed(2) : '  -  '}      ${ms}`)
  sheet.tile(k++, hm, R, size, sea, fields.water)
}
await sheet.save(outPath)
console.log('wrote', outPath, `${sheet.width}x${sheet.height}`)
