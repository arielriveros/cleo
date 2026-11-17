// Generate the Creator's Island preset headless and write a preview PNG (heights shaded, water blue) to argv[2].
import fs from 'fs'
import { encodePngRgba8 } from '../../applications/creator/src/core/png'
import { island } from '../../applications/creator/src/world/presets'
import { generateWorld } from '../../applications/creator/src/world/generateWorld'
import { buildFields } from '../../applications/creator/src/world/pipeline'
import { SILENT_CONTEXT } from '../../applications/creator/src/core/generator'

const doc = island()
const t0 = Date.now()
const out = await generateWorld(doc, SILENT_CONTEXT, { resolution: 513 })
const fields = buildFields(out, doc)
const R = out.frame.resolution, k = doc.settings.heightScale
console.log('generated', R, 'in', Date.now() - t0, 'ms; lakes', fields.water.lakes.map((l: any) => [l.level?.toFixed?.(1), l.area]))
let min = Infinity, max = -Infinity
for (const h of out.heights) { min = Math.min(min, h * k); max = Math.max(max, h * k) }
console.log('heights m', min.toFixed(1), max.toFixed(1), 'sea', doc.settings.seaLevel * k)
const rgba = new Uint8Array(R * R * 4)
for (let i = 0; i < R * R; i++) {
  const h = out.heights[i] * k, wet = fields.water.kind[i] !== 0
  const v = Math.max(0, Math.min(1, (h - min) / (max - min)))
  const c = wet ? [30, 80, 160] : [80 + v * 150, 120 + v * 110, 60 + v * 150]
  rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = 255
}
fs.writeFileSync(process.argv[2], await encodePngRgba8(R, R, rgba))
const row = Math.round(0.45 * (R - 1))
console.log('profile z=0.45:', Array.from({ length: 21 }, (_, i) => (out.heights[row * R + Math.round(i / 20 * (R - 1))] * k).toFixed(0)).join(' '))
const at = (u: number, v: number) => (out.heights[Math.round(v * (R - 1)) * R + Math.round(u * (R - 1))] * k).toFixed(0)
console.log('crater centre', at(0.6, 0.58), 'rim', at(0.675, 0.58), at(0.6, 0.655), 'outflow start', at(0.675, 0.64), 'mid', at(0.75, 0.76), 'end', at(0.84, 0.9))
