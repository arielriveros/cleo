// Build the Island example (applications/editor/public/examples/island): the Creator's Island world (its
// preset, generated headless) as the landscape, dressed with the Valley's own assets - its landscape
// material and plants, its hamlet (houses, windmill, well, poles, furniture, torches) stamped onto the
// island with the ground it stands on - and water: an Ocean node round the island, a Lake node per lake,
// and River nodes from the peak into the big lake and out of it to the sea, each flow-baked. The Valley's sky,
// sun, clouds, wind, weather and day cycle come along as they are.
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config applications/creator/vitest.config.ts tools/island/build.ts [--dry]
//
// Then `npm --prefix applications/editor run examples:list` to refresh the gallery index.

import fs from 'fs'
import path from 'path'
import { EXAMPLES, VALLEY_DIR, log, nodes, prune, read, write } from '../valley/bundleOps'
import { stableId } from '../exampleKit/bundle.mjs'
import { island } from '../../applications/creator/src/world/presets'
import { generateWorld } from '../../applications/creator/src/world/generateWorld'
import { buildFields } from '../../applications/creator/src/world/pipeline'
import { SILENT_CONTEXT } from '../../applications/creator/src/core/generator'
import { WATER_LAKE, WATER_SEA } from '../../applications/creator/src/world/lakes'
import { WaterMaterial } from '../../src/graphics/material'
import { WATER_LOOK_PRESETS } from '../../src/water/waterLook'
import { Scene } from '../../src/core/scene/scene'
import { WaterVolumeNode } from '../../src/core/scene/nodes/waterVolumeNode'
import { bakeShallowWater } from '../../src/water/bake/shallowWater'
import { encodeWaterBake } from '../../src/water/bake/waterBakeFormat'
import { seededRandom } from '../../src/core/math'

const args = new Set(process.argv.slice(2))
const ISLAND_DIR = path.join(EXAMPLES, 'island')
const id = (key: string) => stableId('island:' + key)
const r3 = (v: number) => Math.round(v * 1000) / 1000

// ----- the world ------------------------------------------------------------------------------------------

const doc = island()
const RES = 1025
const out = await generateWorld(doc, SILENT_CONTEXT, { resolution: RES })
const fields = buildFields(out, doc)
const SIZE = doc.settings.size, K = doc.settings.heightScale, SEA = doc.settings.seaLevel * K
const CELL = SIZE / (RES - 1)
const H = new Float32Array(RES * RES)
for (let i = 0; i < H.length; i++) H[i] = out.heights[i] * K
log(`world ${RES}² over ${SIZE} m, ${Math.min(...H.subarray(0, 4)).toFixed(0)}..; sea ${SEA} m, lakes ${fields.water.lakes.length}`)

const toWorld = (u: number) => (u - 0.5) * SIZE
const heightAt = (x: number, z: number) => {
  const fx = Math.min(RES - 1.001, Math.max(0, (x + SIZE / 2) / CELL)), fz = Math.min(RES - 1.001, Math.max(0, (z + SIZE / 2) / CELL))
  const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r
  const a = H[r * RES + c] + (H[r * RES + c + 1] - H[r * RES + c]) * tx
  const b = H[(r + 1) * RES + c] + (H[(r + 1) * RES + c + 1] - H[(r + 1) * RES + c]) * tx
  return a + (b - a) * tz
}
const slopeAt = (x: number, z: number) => {
  const d = 2
  const gx = (heightAt(x + d, z) - heightAt(x - d, z)) / (2 * d), gz = (heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d)
  return Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI
}
const kind = fields.water.kind as Uint8Array
const waterKindAt = (x: number, z: number) => {
  const c = Math.round((x + SIZE / 2) / CELL), r = Math.round((z + SIZE / 2) / CELL)
  if (c < 0 || r < 0 || c >= RES || r >= RES) return WATER_SEA
  return kind[r * RES + c]
}

// ----- the Valley ---------------------------------------------------------------------------------------

const bundle = await read(VALLEY_DIR)
const [valleySceneId] = Object.keys(bundle.scenes)
const sceneEntry = bundle.scenes[valleySceneId]
const root = sceneEntry.scene
const byName = (name: string, under: any = root) => [...nodes(under)].find((n: any) => n.name === name)
const removeChild = (parent: any, name: string) => {
  const i = (parent.children ?? []).findIndex((c: any) => c.name === name)
  if (i >= 0) parent.children.splice(i, 1)
}
const landscape = byName('Landscape')
const t = landscape.terrain

// The Valley's ground, to stamp under its hamlet.
const vR: number = t.resolution, vSize: number = t.size
const vBytes = new Uint8Array(Buffer.from(t.heights, 'base64'))
const vU16 = new Uint16Array(vBytes.buffer, vBytes.byteOffset, vBytes.byteLength / 2)
const vE = vSize / (vR - 1)
const valleyHeight = (x: number, z: number) => {
  const fx = Math.min(vR - 1.001, Math.max(0, (x + vSize / 2) / vE)), fz = Math.min(vR - 1.001, Math.max(0, (z + vSize / 2) / vE))
  const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r
  const at = (cc: number, rr: number) => t.heightMin + vU16[rr * vR + cc] / 65535 * (t.heightMax - t.heightMin)
  const a = at(c, r) + (at(c + 1, r) - at(c, r)) * tx, b = at(c, r + 1) + (at(c + 1, r + 1) - at(c, r + 1)) * tx
  // The Valley pond is not coming: its basin is filled level with its banks.
  const h = a + (b - a) * tz
  const dp = Math.hypot(x - 44, z - 22)
  return dp < 18 ? Math.max(h, 1.0 + (h - 1.0) * Math.max(0, (dp - 13) / 5)) : h
}

// ----- where the hamlet goes ------------------------------------------------------------------------------

// The hamlet's footprint in the Valley (houses, poles, well, campfire, windmill) and the margin it blends over.
const FOOT = { x0: -100, x1: 75, z0: -60, z1: 95 }
const FEATHER = 30
let site = { dx: 0, dz: 0, dy: 0, score: Infinity }
const rand = seededRandom(11)
for (let k = 0; k < 4000; k++) {
  const dx = Math.round((rand() - 0.5) * 1100 / 2) * 2, dz = Math.round((rand() - 0.5) * 1100 / 2) * 2
  let sum = 0, sq = 0, n = 0, bad = false
  for (let x = FOOT.x0; x <= FOOT.x1 && !bad; x += 12) for (let z = FOOT.z0; z <= FOOT.z1; z += 12) {
    const wx = x + dx, wz = z + dz
    if (waterKindAt(wx, wz) !== 0) { bad = true; break }
    const h = heightAt(wx, wz) - valleyHeight(x, z)
    sum += h; sq += h * h; n++
  }
  if (bad) continue
  // Clear of every lake by the footprint and its feather, so the hamlet is never sunk under one.
  const cx = dx + (FOOT.x0 + FOOT.x1) / 2, cz = dz + (FOOT.z0 + FOOT.z1) / 2
  const clear = (fields.water.lakes as any[]).every(l => {
    const lx = -SIZE / 2 + (l.bounds[0] + l.bounds[2]) / 2 * CELL, lz = -SIZE / 2 + (l.bounds[1] + l.bounds[3]) / 2 * CELL
    const lr = Math.max(l.bounds[2] - l.bounds[0], l.bounds[3] - l.bounds[1]) / 2 * CELL
    return Math.hypot(cx - lx, cz - lz) > lr + 130 + FEATHER
  })
  if (!clear) continue
  const mean = sum / n, varc = sq / n - mean * mean
  // Raised to meet the island along its border (the median offset there), so it sits in the slope rather
  // than in a pit or on a plinth.
  const ring: number[] = []
  for (let x = FOOT.x0; x <= FOOT.x1; x += 8) for (const z of [FOOT.z0, FOOT.z1]) ring.push(heightAt(x + dx, z + dz) - valleyHeight(x, z))
  for (let z = FOOT.z0; z <= FOOT.z1; z += 8) for (const x of [FOOT.x0, FOOT.x1]) ring.push(heightAt(x + dx, z + dz) - valleyHeight(x, z))
  ring.sort((a, b) => a - b)
  const base = ring[ring.length >> 1]
  // Well above the sea and the lake, and the flattest fit of the Valley's ground.
  if (base < SEA + 14 || base > 130) continue
  const score = varc + Math.abs(base - (SEA + 30)) * 2
  if (score < site.score) site = { dx, dz, dy: Math.round(base * 10) / 10, score }
}
if (!Number.isFinite(site.score)) throw new Error('no site for the hamlet on the island')
log(`hamlet at (${site.dx}, ${site.dz}), raised ${site.dy} m`)
const inFoot = (x: number, z: number) => {
  const lx = x - site.dx, lz = z - site.dz
  const ex = Math.max(FOOT.x0 - lx, 0, lx - FOOT.x1), ez = Math.max(FOOT.z0 - lz, 0, lz - FOOT.z1)
  const d = Math.hypot(ex, ez)
  return d >= FEATHER ? 0 : 1 - d / FEATHER
}
// Stamp the Valley's ground under the hamlet, eased into the island's over the feather.
for (let r = 0; r < RES; r++) for (let c = 0; c < RES; c++) {
  const x = -SIZE / 2 + c * CELL, z = -SIZE / 2 + r * CELL
  const w = inFoot(x, z)
  if (w <= 0) continue
  const s = w * w * (3 - 2 * w)
  const i = r * RES + c
  H[i] = H[i] + (valleyHeight(x - site.dx, z - site.dz) + site.dy - H[i]) * s
}

// ----- the landscape: heights, masks, material ------------------------------------------------------------

let hMin = Infinity, hMax = -Infinity
for (const h of H) { hMin = Math.min(hMin, h); hMax = Math.max(hMax, h) }
const u16 = new Uint16Array(H.length)
for (let i = 0; i < H.length; i++) u16[i] = Math.round((H[i] - hMin) / (hMax - hMin) * 65535)
t.size = SIZE; t.resolution = RES; t.heightMin = hMin; t.heightMax = hMax
t.heights = Buffer.from(u16.buffer).toString('base64')

// Masks: the Valley's paint channels (trail 0, forest 1, dirt road 2, path 3, clay 4, sand 5, dirt 6).
const ls = t.layerStack
const MR: number = ls.maskRes, SL: number = ls.maskSlices
const vMasks = new Uint8Array(Buffer.from(ls.masks, 'base64'))
const masks = new Uint8Array(SL * MR * MR * 4)
const mIndex = (ch: number, c: number, r: number) => ((Math.floor(ch / 4) * MR + r) * MR + c) * 4 + (ch % 4)
const texel = SIZE / MR
const noise = (x: number, z: number, s: number) => {
  // Cheap value noise for patch edges.
  const fx = x / s, fz = z / s, ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz
  const hash = (a: number, b: number) => { const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return h - Math.floor(h) }
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz)
  const a = hash(ix, iz) + (hash(ix + 1, iz) - hash(ix, iz)) * sx, b = hash(ix, iz + 1) + (hash(ix + 1, iz + 1) - hash(ix, iz + 1)) * sx
  return a + (b - a) * sz
}
const forestAt = (x: number, z: number, h: number, slope: number) => {
  if (h < SEA + 10 || h > 230 || slope > 30) return 0
  const n = noise(x, z, 90) * 0.7 + noise(x, z, 23) * 0.3
  return Math.min(1, Math.max(0, (n - 0.34) * 5))
}
const lakes = fields.water.lakes as { level: number; area: number; bounds: [number, number, number, number] | any }[]
const sh = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)
for (let r = 0; r < MR; r++) for (let c = 0; c < MR; c++) {
  const x = -SIZE / 2 + (c + 0.5) * texel, z = -SIZE / 2 + (r + 0.5) * texel
  const h = heightAt(x, z), slope = slopeAt(x, z), wk = waterKindAt(x, z)
  const foot = inFoot(x, z)
  // Under water: the clay bed. On the shore: sand. In the forests: forest floor. By the rivers: dirt.
  const clay = wk !== 0 || h < SEA - 0.5 ? 1 : 0
  const sand = Math.max(0, 1 - Math.max(0, h - SEA) / (4 + noise(x, z, 30) * 4)) * (slope < 22 ? 1 : 0)
  let lakeShore = 0
  if (wk === 0) for (const lake of lakes) {
    const above = h - lake.level
    if (above >= 0 && above < 1.6) {
      const near = [[3, 0], [-3, 0], [0, 3], [0, -3]].some(([ox, oz]) => waterKindAt(x + ox, z + oz) === WATER_LAKE)
      if (near) lakeShore = Math.max(lakeShore, 1 - above / 1.6)
    }
  }
  const values = [0, forestAt(x, z, h, slope), 0, 0, clay, Math.max(sand * (wk === 0 ? 1 : 0), lakeShore), 0]
  for (let ch = 0; ch < 7; ch++) {
    let v = values[ch] * (1 - foot)
    if (foot > 0) {
      // The hamlet keeps the Valley's own paint (its roads, paths, dirt), shifted with it.
      const vc = c - site.dx / texel, vr = r - site.dz / texel
      if (vc >= 0 && vr >= 0 && vc < MR && vr < MR) v += vMasks[mIndex(ch, vc, vr)] / 255 * foot
    }
    masks[mIndex(ch, c, r)] = sh(v)
  }
}
ls.masks = Buffer.from(masks).toString('base64')
// No snow on a 300 m island; rock and rocky dirt keep their slope rules, rocky dirt only above the beaches.
const tuneSlots = (material: any) => {
  for (const slot of material?.slots ?? []) {
    if (slot.id === 'slot_snow' && slot.rule?.elevation) slot.rule.elevation.min = 5000
    if (slot.id === 'slot_rockydirt' && slot.rule?.elevation) { slot.rule.elevation.min = SEA + 6; slot.rule.elevation.max = 400 }
    // The island's flanks are steeper than the valley floor: rocky dirt and rock start on steeper ground.
    if (slot.id === 'slot_rockydirt' && slot.rule?.slope) slot.rule.slope.min = 31
    if (slot.id === 'slot_rock' && slot.rule?.slope) slot.rule.slope.min = 40
  }
}
tuneSlots(ls.base.material)
const tmLib = bundle.libraries.terrainMaterials.find((m: any) => m.id === ls.base.materialId)
if (tmLib) { tmLib.name = 'Island Landscape'; tuneSlots(tmLib.material) }

// ----- foliage: the Valley's plants, scattered again over the island --------------------------------------

const forestMaskAt = (x: number, z: number) => forestAt(x, z, heightAt(x, z), slopeAt(x, z))
const plantRules: Record<string, (x: number, z: number, h: number, s: number, f: number) => boolean> = {
  'Spruce A': (x, z, h, s, f) => h > SEA + 25 && h < 230 && s < 32 && f > 0.5,
  'Spruce B': (x, z, h, s, f) => h > SEA + 25 && h < 230 && s < 32 && f > 0.4,
  'Highland Spruce': (x, z, h, s) => h > 140 && s < 36,
  'Oak': (x, z, h, s, f) => h > SEA + 6 && h < 120 && s < 20 && f < 0.3,
  'Meadow Grass A': (x, z, h, s) => h > SEA + 3 && s < 30,
  'Meadow Grass B': (x, z, h, s) => h > SEA + 3 && s < 30,
  'Tall Grass': (x, z, h, s, f) => h > SEA + 4 && s < 26 && f < 0.5,
  'Forest Undergrowth A': (x, z, h, s, f) => f > 0.5 && s < 32,
  'Forest Undergrowth B': (x, z, h, s, f) => f > 0.5 && s < 32,
  'Boxwood': (x, z, h, s, f) => f > 0.3 && s < 28,
  'Shrub A': (x, z, h, s) => h > SEA + 4 && s < 34,
  'Shrub B': (x, z, h, s) => h > SEA + 4 && s < 34,
  'Juniper': (x, z, h, s) => h > SEA + 20 && s < 38,
}
// The hamlet keeps its clearings: no trees or bushes over its houses, poles and paths.
const TREES = new Set(['Spruce A', 'Spruce B', 'Highland Spruce', 'Oak', 'Boxwood', 'Shrub A', 'Shrub B', 'Juniper', 'Forest Undergrowth A', 'Forest Undergrowth B'])
const ISLAND_R = SIZE * 0.36
for (const layer of t.foliage) {
  const rule = plantRules[layer.name]
  if (!rule) { layer.instances = Buffer.from(new Float32Array(0).buffer).toString('base64'); continue }
  const valleyCount = Buffer.from(layer.instances, 'base64').byteLength / 20
  const density: number = layer.params?.density ?? 0.001
  const prand = seededRandom(id(layer.name).split('').reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7))
  // Jittered candidates over the island's disc at the layer's density, kept by its rule, then capped.
  // Trees stand closer than in the Valley's open meadows: the island's forests are woods, not groves.
  const step = 1 / Math.sqrt(Math.max(density * (layer.name.includes('Spruce') || layer.name === 'Oak' ? 3 : 1), 1e-6))
  const pts: number[] = []
  for (let z = -ISLAND_R; z < ISLAND_R; z += step) for (let x = -ISLAND_R; x < ISLAND_R; x += step) {
    const px = x + (prand() - 0.5) * step, pz = z + (prand() - 0.5) * step
    if (waterKindAt(px, pz) !== 0) continue
    const h = heightAt(px, pz), s = slopeAt(px, pz)
    if (!rule(px, pz, h, s, forestMaskAt(px, pz))) continue
    const foot = inFoot(px, pz)
    if (TREES.has(layer.name) && foot > 0.05) continue
    pts.push(px, pz)
  }
  // Thin evenly to the cap: the Valley's own count for the grasses (its budget), a forest's worth of trees.
  const cap = TREES.has(layer.name) ? (layer.name.startsWith('Forest') || layer.name === 'Boxwood' ? 6000 : 3000) : Math.max(valleyCount, 60000)
  const n = pts.length / 2, keep = Math.min(n, Math.max(1, cap))
  const f = new Float32Array(keep * 5)
  const minS = layer.params?.minScale ?? 0.8, maxS = layer.params?.maxScale ?? 1.2
  for (let k = 0; k < keep; k++) {
    const j = Math.floor(k * n / keep)
    const x = pts[j * 2], z = pts[j * 2 + 1]
    f.set([x, heightAt(x, z) - 0.05, z, prand() * Math.PI * 2, minS + prand() * (maxS - minS)], k * 5)
  }
  layer.instances = Buffer.from(f.buffer).toString('base64')
  log(`  ${layer.name}: ${keep} (of ${n} candidates; the Valley had ${valleyCount})`)
}

// ----- the hamlet and the scene's other nodes -------------------------------------------------------------

const shift = (n: any) => { n.position = [r3(n.position[0] + site.dx), r3(n.position[1] + site.dy), r3(n.position[2] + site.dz)] }
for (const name of ['Static Collision', 'Furniture', 'Candles', 'Torches', 'Exposure Volumes']) {
  const n = byName(name)
  if (n) shift(n)
}
// Probes: the hamlet's move with it; the Valley-wide one goes over the island's middle; the pond's over the lake.
const probes = byName('Light Probes')
for (const p of probes?.children ?? []) {
  if (p.name === 'Valley Probe') { p.name = 'Island Probe'; p.position = [0, r3(heightAt(0, 0) + 40), 0] }
  else if (p.name !== 'Pond Probe') shift(p)
}
// The Valley's tour, GI bakes and pond go: they were laid out for the Valley.
removeChild(root, 'Cinematic')
removeChild(root, 'GI Volumes')
removeChild(root, 'Water')

// ----- water ----------------------------------------------------------------------------------------------

const biggest = [...lakes].sort((a, b) => b.area - a.area)
const lakeBox = (lake: any) => {
  // Bounds in cells: [c0, r0, c1, r1] or {c0, r0, c1, r1}.
  const b = Array.isArray(lake.bounds) ? lake.bounds : [lake.bounds.c0 ?? lake.bounds.minX, lake.bounds.r0 ?? lake.bounds.minZ, lake.bounds.c1 ?? lake.bounds.maxX, lake.bounds.r1 ?? lake.bounds.maxZ]
  const x0 = -SIZE / 2 + b[0] * CELL - 6, x1 = -SIZE / 2 + b[2] * CELL + 6
  const z0 = -SIZE / 2 + b[1] * CELL - 6, z1 = -SIZE / 2 + b[3] * CELL + 6
  let floor = lake.level
  for (let x = x0; x <= x1; x += 4) for (let z = z0; z <= z1; z += 4) floor = Math.min(floor, heightAt(x, z))
  const depth = Math.max(1, lake.level - floor + 1)
  return { center: [r3((x0 + x1) / 2), r3(lake.level - depth / 2), r3((z0 + z1) / 2)] as [number, number, number],
           size: [r3(x1 - x0), r3(depth), r3(z1 - z0)] as [number, number, number] }
}
// The water is built as real Water nodes in a scratch scene, so the rivers resolve against the lakes they
// flow into exactly as the editor will, and each bake's signature is the node's own.
const waterScene = new Scene()
const place = (n: WaterVolumeNode, position: [number, number, number]) => {
  n.setPosition(position)
  waterScene.addNode(n)
  n.updateTransforms()
  return n
}
// Each lake a Lake node at its level: its outline traced from the flooded cells (rays from the centre out to
// the last lake cell, a few metres past it, smoothed by the lake's own spline), so the water stays in the
// basin; a box over its bounds would also flood the downhill ground beyond its rim.
const lakeNodes = biggest.map((lake, i) => {
  const box = lakeBox(lake)
  const cx = box.center[0], cz = box.center[2]
  const pts: { pos: [number, number, number]; width: number; depth: number; flowSpeed: number }[] = []
  const RAYS = 28
  for (let k = 0; k < RAYS; k++) {
    const a = k / RAYS * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a)
    let last = 2
    for (let d = 2; d < 400; d += 2) {
      if (waterKindAt(cx + dx * d, cz + dz * d) === WATER_LAKE) last = d
      else if (d - last > 12) break
    }
    pts.push({ pos: [r3(dx * (last + 4)), 0, r3(dz * (last + 4))], width: 1, depth: 1, flowSpeed: 0 })
  }
  const node = new WaterVolumeNode(i === 0 ? 'Lake' : `Tarn ${i}`, { waterType: 'lake', depth: r3(box.size[1]), points: pts }, id(`lake${i}`))
  return place(node, [cx, r3(lake.level), cz])
})
const lakeAt = (x: number, z: number) => lakeNodes.find(n => {
  const r = n.resolved()
  return !!r && x >= r.min[0] && x <= r.max[0] && z >= r.min[2] && z <= r.max[2]
})
// The rivers the world carved, along the same control points; the surface a metre over the carved bed, never
// climbing downstream, ending in the lake or the sea.
const SEA_ID = id('ocean')
const rivers = (doc.graph.nodes as any[]).filter(n => n.type === 'river')
const riverNodes = rivers.map((n, i) => {
  const pts: { pos: [number, number, number]; width: number; depth: number; flowSpeed: number }[] = []
  let last = Infinity
  const ctrl: [number, number][] = n.params.points
  for (let k = 0; k < ctrl.length; k++) {
    const x = toWorld(ctrl[k][0]), z = toWorld(ctrl[k][1])
    let y = Math.min(last, Math.max(heightAt(x, z) + 1.0, SEA))
    last = y
    const width = (n.params.width ?? 0.006) * SIZE + 4
    pts.push({ pos: [r3(x), r3(y), r3(z)], width: r3(width), depth: 1.2, flowSpeed: k === 0 ? 1.6 : 1.2 })
  }
  const first = pts[0].pos, end = pts[pts.length - 1].pos
  const into = lakeAt(end[0], end[2]), from = lakeAt(first[0], first[2])
  // A river that reaches no lake runs out to sea.
  const connect = { start: from?.id ?? null, end: into?.id ?? (end[1] <= SEA + 1.5 ? SEA_ID : null) }
  return place(new WaterVolumeNode(n.name, { waterType: 'river', points: pts, connect }, id(`river${i}`)), [0, 0, 0])
})

const look = (pid: string, over: any = {}) => new WaterMaterial({ ...WATER_LOOK_PRESETS.find(p => p.id === pid)!.options, ...over }).serialize()
const materials: any[] = bundle.libraries.materials
const addWaterMaterial = (key: string, name: string, material: any) => {
  const mid = id('material:' + key)
  if (!materials.some(m => m.id === mid)) materials.push({ id: mid, name, material, textureIds: [], thumbnail: '' })
  return mid
}
const OCEAN_MAT = addWaterMaterial('ocean', 'Island Ocean', look('openOcean', { subsurface: 1.4 }))
const LAKE_MAT = addWaterMaterial('lakes', 'Island Lakes', look('clearLake', { turbidity: 0.2, clarity: 6, detailStrength: 0.45, subsurface: 0.7 }))
const oceanMatAsset = materials.find(m => m.id === OCEAN_MAT), lakeMatAsset = materials.find(m => m.id === LAKE_MAT)
const ocean = place(new WaterVolumeNode('Ocean', { waterType: 'ocean', depth: 200 }, SEA_ID), [0, SEA, 0])

// Flow-bake every river over the island's ground, as the editor's Bake flow button does: into the water it
// joins, which keeps its level and takes what the river brings.
const bakes: Record<string, string> = {}
for (const river of riverNodes) {
  const r = river.resolved()
  if (!r) continue
  const info = bakeShallowWater([r], heightAt, { maxRes: 256, duration: 40, handOver: river.handOver() })
  const bakeId = id(`water-bake:${river.id}`)
  bundle.giBakes = [...(bundle.giBakes ?? []).filter((g: any) => g.id !== bakeId), { id: bakeId, bytes: encodeWaterBake(info, river.bakeSignature()).buffer }]
  bakes[river.id] = bakeId
  log(`${river.name} baked: ${info.nx} x ${info.nz} cells`)
}

const LIQUID = {
  density: 1000, linearDrag: 2.5, angularDrag: 0.5, waveAmplitude: 0, waveFrequency: 0.6, affectCharacters: false,
  splashTemplate: 'Water Splash', wadeSplashTemplate: 'Water Step', enabled: true, currents: true,
}
const LAKE_WATER = { windSpeed: 2.5, waveDirection: 25, choppiness: 0.3, shoreFade: 4, followWind: true, waterMaterialId: LAKE_MAT, waterMaterial: lakeMatAsset.material }
const waterJson = async (n: WaterVolumeNode, over: any) => {
  const json: any = await n.serialize()
  json.waterVolume = { ...json.waterVolume, ...LIQUID, ...over, waterType: n.waterType }
  json.children = []
  return json
}
const waterGroup = {
  id: id('water'), name: 'Water', type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], spawnOnStart: true,
  children: [
    await waterJson(ocean, {
      density: 1025, windSpeed: 7, waveDirection: 25, choppiness: 0.55, shoreFade: 10, followWind: true,
      waterMaterialId: OCEAN_MAT, waterMaterial: oceanMatAsset.material,
    }),
    ...await Promise.all(lakeNodes.map(n => waterJson(n, LAKE_WATER))),
    ...await Promise.all(riverNodes.map(n => waterJson(n, { ...LAKE_WATER, ...(bakes[n.id] ? { bakeId: bakes[n.id] } : {}) }))),
  ],
}
root.children.splice(root.children.findIndex((c: any) => c.name === 'Landscape') + 1, 0, waterGroup)
// The pond's mist and probe go over the big lake.
const lake0 = lakeNodes[0].worldPosition
const lake0Box = lakeBox(biggest[0])
const mist = byName('Pond Mist')
if (mist) { mist.name = 'Lake Mist'; mist.position = [r3(lake0[0]), r3(lake0[1] + 2.5), r3(lake0[2])]; mist.volumetricFog.size = [r3(lake0Box.size[0]), 5.5, r3(lake0Box.size[2])] }
const pondProbe = byName('Pond Probe')
if (pondProbe) { pondProbe.name = 'Lake Probe'; pondProbe.position = [r3(lake0[0]), r3(lake0[1] + 2), r3(lake0[2])] }

// Weather: a drizzle over everything, so the water rings and the ground darkens; the day cycle and wind stay.
const weather = byName('Weather')
if (weather?.weather) Object.assign(weather.weather, { wetness: 0.35, precipitation: 'rain', precipitationRate: 0.2 })

// The camera: on the hamlet's lake side, looking over the lake to the peak and the sea.
const cam = byName('Fly Camera')
if (cam) {
  const cx = (site.dx + lake0[0]) / 2, cz = (site.dz + lake0[2]) / 2
  cam.position = [r3(cx), r3(heightAt(cx, cz) + 14), r3(cz)]
}

// ----- the project ----------------------------------------------------------------------------------------

const SCENE_ID = id('scene')
// The scene root keeps its name: the scene parser finds the root as `root`.
delete bundle.scenes[valleySceneId]
bundle.scenes[SCENE_ID] = sceneEntry
const meta = bundle.manifest.sceneMetas.find((m: any) => m.id === valleySceneId)
bundle.manifest = {
  ...bundle.manifest, projectName: 'Island', mainSceneId: SCENE_ID, openSceneId: SCENE_ID,
  sceneMetas: [{ ...meta, id: SCENE_ID, name: 'Island', thumbnail: undefined }],
}
// The Valley's own sequences that animated what is gone (the tour) are pruned with everything else unreached.
const removed = prune(bundle)
log('pruned', JSON.stringify(removed.removed))
if (!args.has('--dry')) fs.mkdirSync(ISLAND_DIR, { recursive: true })
await write(ISLAND_DIR, bundle, 'Island', args.has('--dry'))
if (!args.has('--dry')) fs.writeFileSync(path.join(ISLAND_DIR, 'example.json'), JSON.stringify({
  name: 'Island',
  description: 'A water demo: an island from the World Creator in open sea, with lakes and rivers that run from the peak into the lake and on to the sea, the Valley\'s forests, meadows and hamlet, drizzle, wind and a day cycle.',
  order: 4,
}, null, 2) + '\n')
log('now run: npm --prefix applications/editor run examples:list')
