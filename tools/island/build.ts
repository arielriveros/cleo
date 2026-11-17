// Build the Island example (applications/editor/public/examples/island): the Creator's Island world (its
// preset, generated headless) as the landscape, dressed with the Valley's own assets - its landscape
// material and plants, its hamlet (houses, windmill, well, poles, furniture, torches) stamped onto the
// island with the ground it stands on - and water: an Ocean node round the island, a Lake node per lake,
// and River nodes from the peak into the big lake and out of it to the sea, their channels cut into the
// ground and the whole system flow-baked as one. The Valley's sky,
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
import { priorityFlood, WATER_LAKE, WATER_SEA } from '../../applications/creator/src/world/lakes'
import { WaterMaterial } from '../../src/graphics/material'
import { WATER_LOOK_PRESETS } from '../../src/water/waterLook'
import { Scene } from '../../src/core/scene/scene'
import { WaterVolumeNode } from '../../src/core/scene/nodes/waterVolumeNode'
import { bakeWater } from '../../src/water/bake/shallowWater'
import { prepareGroupBake, waterBakeGroup, waterGroupReach } from '../../src/water/bake/bakeNode'
import { carveWater } from '../../src/water/carve'
import { normaliseWaterBody, resolveWaterBody } from '../../src/water/waterShapes'
import { pointInPolygonXZ } from '../../src/physics/water/waterColumn'
import { heightsRegionKey } from '../../src/water/ground'
import { Node } from '../../src/core/scene/nodes/node'
import { parseNodeJson } from '../../src/core/scene/nodes/parseNodeJson'
import { mat4, quat, vec3 } from 'gl-matrix'
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

// ----- the rivers' channels -------------------------------------------------------------------------------

// The flow bake runs the water over the GROUND, not along the line a river was drawn on, so each river is
// drawn here for the ground to hold it: from the head of the preset's river node down the world's own
// drainage; its surface under the lowest ground across its channel, out to the top of its banks, so both
// banks stand over it; always falling; never under the water it runs into. Its bed is then dug into the
// heights, before they are written.
const lakes = fields.water.lakes as { id: number; level: number; floor: number; area: number; bounds: [number, number, number, number] }[]
const lakeIds = fields.water.lakeId as Int32Array
const lakeIdAt = (x: number, z: number, reach = 0) => {
  for (let d = 0; d <= reach; d += CELL) for (let a = 0; a < (d === 0 ? 1 : 8); a++) {
    const c = Math.round((x + Math.cos(a * Math.PI / 4) * d + SIZE / 2) / CELL), r = Math.round((z + Math.sin(a * Math.PI / 4) * d + SIZE / 2) / CELL)
    if (c >= 0 && r >= 0 && c < RES && r < RES && lakeIds[r * RES + c] >= 0) return lakeIds[r * RES + c]
  }
  return -1
}
const levelOf = (lake: number) => lakes.find(l => l.id === lake)!.level
/** Metres between a river's points at most; how far under its lowest bank its surface is drawn; its banks' width; the least it falls; how far its bed is dug under its drawn depth. */
const STEP = 14, FREEBOARD = 0.8, BANK = 4, MIN_SLOPE = 0.012, DIG = 0.5
/** Metres a straight run between two points may ride over the surface the ground allows, and the closest two points stand. */
const RIDE = 0.1, CLOSEST = 4
/** Metres the straight run between two points may pass beside the line the water takes. */
const ASIDE = 0.75
/** Metres of a river's start that are the sill of the lake it drains, and how deep it is drawn there. */
const SILL = 12, SILL_DEPTH = 0.3
/** Mountain streams: a few cubic metres a second. */
const STREAM = [{ depth: 0.7, flowSpeed: 1.4 }, { depth: 0.8, flowSpeed: 1.5 }]
type RiverPoint = { pos: [number, number, number]; width: number; depth: number; flowSpeed: number }
// Where the ground sends the water from each river's head: the drainage of the ground as it stands (each
// sample's downstream neighbour on the filled surface, lakes.ts), which runs down the trench the world cut
// for the river wherever it cut one.
const flood = priorityFlood(H, RES)
const drainsTo = flood.parent
const traced = (doc.graph.nodes as any[]).filter(n => n.type === 'river').map(n => {
  const head: [number, number] = [toWorld(n.params.points[0][0]), toWorld(n.params.points[0][1])]
  const cells: number[] = []
  for (let c = Math.round((head[1] + SIZE / 2) / CELL) * RES + Math.round((head[0] + SIZE / 2) / CELL); c >= 0 && cells.length < RES * 8; c = drainsTo[c]) {
    cells.push(c)
    // Down to the sea, and no further.
    if (kind[c] === WATER_SEA && cells.length > 4 && kind[cells[cells.length - 4]] === WATER_SEA) break
  }
  return { head, from: lakeIdAt(head[0], head[1], 10), cells }
})
// A hollow on a river's way that the world did not make a lake of would hold the stream back as a deep pool
// wider than its course, and one beside it would take the stream off its course: every hollow the course
// touches is levelled up to where it spills, the whole of it, so the stream runs on across or past it. A
// lake's own basin is left as it is.
{
  const lakeSpills = new Set<number>()
  for (let c = 0; c < lakeIds.length; c++) if (lakeIds[c] >= 0) lakeSpills.add(Math.round(flood.spill[c] * 1000))
  const hollow = (c: number) => kind[c] === 0 && lakeIds[c] < 0 && flood.spill[c] - H[c] >= 0.02 && !lakeSpills.has(Math.round(flood.spill[c] * 1000))
  const TOUCH = Math.round(12 / CELL)
  const queue: number[] = []
  const taken = new Uint8Array(RES * RES)
  for (const river of traced) for (const c of river.cells) {
    const cc = c % RES, cr = Math.floor(c / RES)
    for (let r = Math.max(0, cr - TOUCH); r <= Math.min(RES - 1, cr + TOUCH); r++) for (let q = Math.max(0, cc - TOUCH); q <= Math.min(RES - 1, cc + TOUCH); q++) {
      const i = r * RES + q
      if (!taken[i] && hollow(i)) { taken[i] = 1; queue.push(i) }
    }
  }
  const levelled = new Map<number, { samples: number; deepest: number }>()
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]
    const spill = flood.spill[c]
    const entry = levelled.get(spill) ?? levelled.set(spill, { samples: 0, deepest: 0 }).get(spill)!
    entry.samples++; entry.deepest = Math.max(entry.deepest, spill - H[c])
    H[c] = spill
    const cc = c % RES
    for (const j of [c - 1, c + 1, c - RES, c + RES]) {
      if (j < 0 || j >= taken.length || taken[j] || Math.abs((j % RES) - cc) > 1 || flood.spill[j] !== spill || !hollow(j)) continue
      taken[j] = 1; queue.push(j)
    }
  }
  let samples = 0, deepest = 0
  for (const e of levelled.values()) { samples += e.samples; deepest = Math.max(deepest, e.deepest) }
  log(`hollows on the rivers' way levelled: ${levelled.size}, ${samples} samples in all, the deepest ${deepest.toFixed(1)} m`)
}
const riverPlans = (doc.graph.nodes as any[]).filter(n => n.type === 'river').map((n, k) => {
  const width = r3((n.params.width ?? 0.004) * SIZE), half = width / 2
  const { head, from, cells } = traced[k]
  // It starts where it leaves the lake it drains, and ends where it first reaches another lake, or the sea.
  let start = 0, stop = cells.length - 1, into: number | 'sea' | null = null
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]
    if (from >= 0 && lakeIds[c] === from) { start = i; continue }
    if (lakeIds[c] >= 0) { stop = i; into = lakeIds[c]; break }
    if (kind[c] === WATER_SEA || H[c] < SEA) { stop = i; into = 'sea'; break }
  }
  // A few metres on into the water it reaches, so its mouth lies in it.
  stop = Math.min(cells.length - 1, stop + Math.round(6 / CELL))
  // And a few metres back in the lake it drains, so it starts in its water.
  start = Math.max(0, start - Math.round(6 / CELL))
  const raw = cells.slice(start, stop + 1).map(c => [-SIZE / 2 + (c % RES) * CELL, -SIZE / 2 + Math.floor(c / RES) * CELL] as [number, number])
  if (from >= 0 && lakeIds[cells[start]] !== from) {
    // Its head stands on the lake's rim: it starts at the lake's nearest water.
    let best = Infinity, at: [number, number] | null = null
    for (let dz = -12; dz <= 12; dz += CELL) for (let dx = -12; dx <= 12; dx += CELL) {
      const c = Math.round((head[1] + dz + SIZE / 2) / CELL) * RES + Math.round((head[0] + dx + SIZE / 2) / CELL)
      if (lakeIds[c] === from && dx * dx + dz * dz < best) { best = dx * dx + dz * dz; at = [head[0] + dx, head[1] + dz] }
    }
    if (at) raw.unshift(at)
  }
  // The samples step from one to its neighbour: smoothed into a line (its ends held), then a point every STEP metres.
  const REACH = Math.round(8 / CELL)
  const smooth = raw.map((q, i) => {
    const w = Math.min(REACH, i, raw.length - 1 - i)
    let x = 0, z = 0
    for (let k = i - w; k <= i + w; k++) { x += raw[k][0]; z += raw[k][1] }
    return [x / (2 * w + 1), z / (2 * w + 1)] as [number, number]
  })
  // Its surface along that line, sample by sample: under the lowest ground across its channel, out to the top
  // of its banks, so both banks stand over it; always falling; never under the water it runs into.
  const endLevel = into === 'sea' ? SEA : into !== null ? levelOf(into) : -Infinity
  const fromLevel = from >= 0 ? levelOf(from) : Infinity
  const last = smooth.length - 1
  const along = new Float64Array(smooth.length), ideal = new Float64Array(smooth.length)
  let deepest = 0
  for (let i = 0; i <= last; i++) {
    const [x, z] = smooth[i]
    const [px, pz] = smooth[Math.max(0, i - 2)], [qx, qz] = smooth[Math.min(last, i + 2)]
    const len = Math.hypot(qx - px, qz - pz) || 1, ox = -(qz - pz) / len, oz = (qx - px) / len
    let low = heightAt(x, z)
    for (const o of [half + BANK / 2, half + BANK]) for (const side of [-1, 1]) {
      // Dry banks only: the bed of the lake it drains, or of the sea, is no bank of its.
      const bx = x + ox * o * side, bz = z + oz * o * side
      if (waterKindAt(bx, bz) === 0) low = Math.min(low, heightAt(bx, bz))
    }
    const ds = i ? Math.hypot(x - smooth[i - 1][0], z - smooth[i - 1][1]) : 0
    along[i] = i ? along[i - 1] + ds : 0
    if (i === last && Number.isFinite(endLevel)) ideal[i] = endLevel
    // Across the rim of the lake it drains it holds the lake's level: the cut there is the lake's sill, and a
    // deep one would drain the lake down to it.
    else if (from >= 0 && along[i] <= SILL) ideal[i] = fromLevel - MIN_SLOPE * along[i]
    else ideal[i] = Math.max(endLevel, Math.min((i ? ideal[i - 1] : Infinity) - MIN_SLOPE * ds, low - FREEBOARD))
    deepest = Math.max(deepest, heightAt(x, z) - ideal[i])
  }
  // Its points: as few as draw that surface along that line. A point at most every STEP metres, and sooner
  // wherever the straight run to the next would ride over ground that falls away faster (a step down in a
  // steep bed: the water would stand over its banks) or cut a bend (the channel would be dug beside the line
  // the ground sends the water down).
  const picked = [0]
  for (let i = 0; i < last;) {
    let j = i + 1
    while (j < last && along[j + 1] - along[i] <= STEP) {
      let fits = true
      const [ax, az] = smooth[i], [cx, cz] = smooth[j + 1]
      const span = Math.hypot(cx - ax, cz - az) || 1
      for (let k = i + 1; k <= j && fits; k++) {
        const chord = ideal[i] + (ideal[j + 1] - ideal[i]) * (along[k] - along[i]) / (along[j + 1] - along[i])
        // Nor may it cut a bend: the channel is dug along the line through the points.
        const aside = Math.abs((smooth[k][0] - ax) * (cz - az) - (smooth[k][1] - az) * (cx - ax)) / span
        fits = (chord <= ideal[k] + RIDE && aside <= ASIDE) || along[j + 1] - along[i] <= CLOSEST
      }
      if (!fits) break
      j++
    }
    picked.push(j)
    i = j
  }
  const points: RiverPoint[] = picked.map(i => ({
    pos: [r3(smooth[i][0]), r3(ideal[i]), r3(smooth[i][1])], width,
    // The sill is shallow, so the lake stands near the level the world flooded it to.
    depth: from >= 0 && along[i] <= SILL ? SILL_DEPTH : STREAM[k % 2].depth, flowSpeed: STREAM[k % 2].flowSpeed,
  }))
  return { name: n.name as string, points, from, into, deepest }
})
const RIVER_CARVE = { enabled: true, bankWidth: BANK, extraDepth: DIG }
// Metres from each sample to the nearest river's water (negative in its bed), and that river's surface there.
const riverEdge = new Float32Array(RES * RES).fill(Infinity), riverTop = new Float32Array(RES * RES)
const riverEnds = new Float32Array(RES * RES)
for (const plan of riverPlans) {
  const body = normaliseWaterBody({ type: 'river', points: plan.points, carve: RIVER_CARVE })
  const shape = resolveWaterBody(body, { position: [0, 0, 0], scale: [1, 1, 1] } as any, plan.name)!
  const region = carveWater({ heights: H, resolution: RES, size: SIZE, origin: [0, 0, 0] }, body, shape)
  log(`${plan.name}: ${plan.points.length} points from ${plan.from >= 0 ? 'lake ' + plan.from : 'a spring'} into ${plan.into === 'sea' ? 'the sea' : plan.into !== null ? 'lake ' + plan.into : 'nothing'}, `
    + `${plan.points[0].pos[1].toFixed(1)} m down to ${plan.points[plan.points.length - 1].pos[1].toFixed(1)} m, its surface at most ${plan.deepest.toFixed(1)} m under the ground; `
    + `carved ${region ? `${region.c1 - region.c0 + 1} x ${region.r1 - region.r0 + 1} samples` : 'nothing'}`)
  const endLevel = plan.into === 'sea' ? SEA : plan.into !== null ? levelOf(plan.into) : -Infinity
  for (const q of (shape as any).samples as { x: number; z: number; y: number; width: number }[]) {
    const half = q.width / 2, reach = half + BANK + 10
    const c0 = Math.max(0, Math.floor((q.x - reach + SIZE / 2) / CELL)), c1 = Math.min(RES - 1, Math.ceil((q.x + reach + SIZE / 2) / CELL))
    const r0 = Math.max(0, Math.floor((q.z - reach + SIZE / 2) / CELL)), r1 = Math.min(RES - 1, Math.ceil((q.z + reach + SIZE / 2) / CELL))
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const d = Math.hypot(-SIZE / 2 + c * CELL - q.x, -SIZE / 2 + r * CELL - q.z) - half
      const i = r * RES + c
      if (d < riverEdge[i]) { riverEdge[i] = d; riverTop[i] = q.y; riverEnds[i] = endLevel }
    }
  }
}
// The banks the carve leaves are the ground's own, and the ground beside a channel may lie under its water
// where a sample of it was not looked at: a dip, the trench the world cut forking off. There, within the
// banks' width, the ground is raised into a bank that stands FREEBOARD over the river's surface, so the water
// has one channel to run in. Not where the river has come down to the water it runs into: that is its mouth.
{
  let raised = 0, most = 0
  for (let i = 0; i < riverEdge.length; i++) {
    const d = riverEdge[i]
    if (!(d > 0 && d <= BANK + 1.5) || kind[i] !== 0 || riverTop[i] <= riverEnds[i] + 0.3) continue
    const t = Math.min(1, d / (BANK * 0.75))
    const need = riverTop[i] - 0.2 + (FREEBOARD + 0.2) * t * t * (3 - 2 * t)
    const lift = need - H[i]
    if (lift <= 0 || lift > 2.5) continue
    H[i] = need
    raised++; most = Math.max(most, lift)
  }
  log(`river banks raised where the ground lay under the water: ${raised} samples, by ${most.toFixed(2)} m at most`)
}
const riverEdgeAt = (x: number, z: number) => {
  const c = Math.round((x + SIZE / 2) / CELL), r = Math.round((z + SIZE / 2) / CELL)
  return c < 0 || r < 0 || c >= RES || r >= RES ? Infinity : riverEdge[r * RES + c]
}

// ----- the landscape: heights, masks, material ------------------------------------------------------------

let hMin = Infinity, hMax = -Infinity
for (const h of H) { hMin = Math.min(hMin, h); hMax = Math.max(hMax, h) }
const u16 = new Uint16Array(H.length)
for (let i = 0; i < H.length; i++) u16[i] = Math.round((H[i] - hMin) / (hMax - hMin) * 65535)
t.size = SIZE; t.resolution = RES; t.heightMin = hMin; t.heightMax = hMax
t.heights = Buffer.from(u16.buffer).toString('base64')
// From here on the ground is the ground as saved, to the last bit: the water is baked over what the editor loads.
for (let i = 0; i < H.length; i++) H[i] = hMin + u16[i] / 65535 * (hMax - hMin)

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
const sh = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)
for (let r = 0; r < MR; r++) for (let c = 0; c < MR; c++) {
  const x = -SIZE / 2 + (c + 0.5) * texel, z = -SIZE / 2 + (r + 0.5) * texel
  const h = heightAt(x, z), slope = slopeAt(x, z), wk = waterKindAt(x, z)
  const foot = inFoot(x, z)
  // Under water: the clay bed. On the shore: sand. In the forests: forest floor. By the rivers: dirt.
  const bank = riverEdgeAt(x, z)
  const clay = wk !== 0 || h < SEA - 0.5 || bank < 0.5 ? 1 : 0
  // A river's cut banks are bare earth, and the forest floor stops short of them.
  const dirt = bank >= 0.5 && bank < BANK + 1 ? 1 - Math.max(0, bank - BANK * 0.5) / (BANK * 0.5 + 1) : 0
  const wooded = Math.min(1, Math.max(0, (bank - BANK * 0.5) / BANK))
  const sand = Math.max(0, 1 - Math.max(0, h - SEA) / (4 + noise(x, z, 30) * 4)) * (slope < 22 ? 1 : 0)
  let lakeShore = 0
  if (wk === 0) for (const lake of lakes) {
    const above = h - lake.level
    if (above >= 0 && above < 1.6) {
      const near = [[3, 0], [-3, 0], [0, 3], [0, -3]].some(([ox, oz]) => waterKindAt(x + ox, z + oz) === WATER_LAKE)
      if (near) lakeShore = Math.max(lakeShore, 1 - above / 1.6)
    }
  }
  const values = [0, forestAt(x, z, h, slope) * wooded, 0, 0, clay, Math.max(sand * (wk === 0 ? 1 : 0), lakeShore) * (bank < 0.5 ? 0 : 1), dirt]
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
    // Nothing in a river's bed; trees and bushes stand back from its banks.
    if (riverEdgeAt(px, pz) < (TREES.has(layer.name) ? BANK + 3 : 0.5)) continue
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
  // Bounds in cells: [c0, r0, c1, r1].
  const b = lake.bounds
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
/**
 * The outline of a lake's flooded samples and `grow` samples round them: its boundary walked once round
 * (Moore's neighbour tracing) and thinned to the points that shape it (Douglas-Peucker, `tolerance` metres).
 * A lake with bays and arms keeps them, which rays from its middle would cut off.
 */
const lakeOutline = (lake: { id: number; bounds: [number, number, number, number] }, grow: number, tolerance: number): [number, number][] => {
  const pad = grow + 2
  const c0 = lake.bounds[0] - pad, r0 = lake.bounds[1] - pad
  const w = lake.bounds[2] - lake.bounds[0] + 1 + 2 * pad, h = lake.bounds[3] - lake.bounds[1] + 1 + 2 * pad
  const mask = new Uint8Array(w * h)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const gc = c + c0, gr = r + r0
    if (gc < 0 || gr < 0 || gc >= RES || gr >= RES || lakeIds[gr * RES + gc] !== lake.id) continue
    for (let dr = -grow; dr <= grow; dr++) for (let dc = -grow; dc <= grow; dc++) {
      if (dc * dc + dr * dr <= grow * grow + 1) mask[(r + dr) * w + c + dc] = 1
    }
  }
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < w && r < h && mask[r * w + c] === 1
  const first = mask.indexOf(1)
  if (first < 0) return []
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
  const ring: [number, number][] = []
  let c = first % w, r = Math.floor(first / w), back = 4
  const sc = c, sr = r
  do {
    ring.push([c, r])
    let moved = false
    for (let k = 1; k <= 8 && !moved; k++) {
      const d = (back + k) % 8
      const nc = c + dirs[d][0], nr = r + dirs[d][1]
      if (!inside(nc, nr)) continue
      // The neighbour looked at just before this one was outside: the next walk starts from it.
      const pd = (d + 7) % 8
      const bc = c + dirs[pd][0] - nc, br = r + dirs[pd][1] - nr
      back = dirs.findIndex(([x, z]) => x === bc && z === br)
      c = nc; r = nr; moved = true
    }
    if (!moved) break
  } while ((c !== sc || r !== sr) && ring.length < w * h)
  const world = ring.map(([cc, rr]) => [-SIZE / 2 + (cc + c0) * CELL, -SIZE / 2 + (rr + r0) * CELL] as [number, number])
  // Thinned between the two points farthest apart, each half on its own.
  let far = 0
  for (let i = 1; i < world.length; i++) if (Math.hypot(world[i][0] - world[0][0], world[i][1] - world[0][1]) > Math.hypot(world[far][0] - world[0][0], world[far][1] - world[0][1])) far = i
  const thin = (pts: [number, number][]): [number, number][] => {
    if (pts.length < 3) return pts.slice(0, -1)
    const [ax, az] = pts[0], [bx, bz] = pts[pts.length - 1]
    const len = Math.hypot(bx - ax, bz - az) || 1
    let worst = 0, at = -1
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((pts[i][0] - ax) * (bz - az) - (pts[i][1] - az) * (bx - ax)) / len
      if (d > worst) { worst = d; at = i }
    }
    if (worst <= tolerance) return [pts[0]]
    return [...thin(pts.slice(0, at + 1)), ...thin(pts.slice(at))]
  }
  return [...thin(world.slice(0, far + 1)), ...thin([...world.slice(far), world[0]])]
}
// Each lake a Lake node at its level, inside the outline of its flooded samples and 4 m round them (the
// lake's own spline rounds the corners): the water stays in its basin, where a box over its bounds would
// also flood the downhill ground beyond its rim.
const lakeNodeOf = new Map<number, WaterVolumeNode>()
const lakeNodes = biggest.map((lake, i) => {
  const box = lakeBox(lake)
  const cx = box.center[0], cz = box.center[2]
  const outline = lakeOutline(lake, Math.round(4 / CELL), 2.5)
  const pts = outline.map(([x, z]) => ({ pos: [r3(x - cx), 0, r3(z - cz)] as [number, number, number], width: 1, depth: 1, flowSpeed: 0 }))
  const node = place(new WaterVolumeNode(i === 0 ? 'Lake' : `Tarn ${i}`, { waterType: 'lake', depth: r3(box.size[1]), points: pts }, id(`lake${i}`)), [cx, r3(lake.level), cz])
  lakeNodeOf.set(lake.id, node)
  const shape: any = node.resolved()
  let inside = 0, all = 0
  for (let c = 0; c < lakeIds.length; c++) {
    if (lakeIds[c] !== lake.id) continue
    all++
    if (pointInPolygonXZ(-SIZE / 2 + (c % RES) * CELL, -SIZE / 2 + Math.floor(c / RES) * CELL, shape.outline)) inside++
  }
  log(`${node.name}: level ${lake.level.toFixed(2)} m, ${pts.length} outline points round ${(inside / all * 100).toFixed(1)}% of its ${all} flooded samples`)
  if (inside < all * 0.995) throw new Error(`${node.name}'s outline leaves ${(100 - inside / all * 100).toFixed(1)}% of its water outside it`)
  return node
})
// The rivers as planned above, each joined to the lake it drains and the water it runs into.
const SEA_ID = id('ocean')
const riverNodes = riverPlans.map((plan, i) => {
  const connect = {
    start: plan.from >= 0 ? lakeNodeOf.get(plan.from)!.id : null,
    end: plan.into === 'sea' ? SEA_ID : plan.into !== null ? lakeNodeOf.get(plan.into)!.id : null,
  }
  // A bouldery mountain bed.
  return place(new WaterVolumeNode(plan.name, { waterType: 'river', points: plan.points, connect, carve: RIVER_CARVE, bedRoughness: 0.05 }, id(`river${i}`)), [0, 0, 0])
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
// A mountain stream: clear, a little green with what it carries, white where it tumbles.
const RIVER_MAT = addWaterMaterial('rivers', 'Island Rivers', look('alpineRiver', { turbidity: 0.25, clarity: 4, shoreFoam: 0.2 }))
const oceanMatAsset = materials.find(m => m.id === OCEAN_MAT), lakeMatAsset = materials.find(m => m.id === LAKE_MAT), riverMatAsset = materials.find(m => m.id === RIVER_MAT)
const ocean = place(new WaterVolumeNode('Ocean', { waterType: 'ocean', depth: 200 }, SEA_ID), [0, SEA, 0])

// Flow-bake every system of joined water as the editor's Bake flow button does: one simulation over the
// island's ground and round the static colliders the scene has, from the spring through the lake to the sea.
// The editor checks each bake against the scene it opens, so the scratch scene gets the same colliders, and
// each bake is signed with the key of the saved landscape heights under its system (water/ground.ts
// heightsRegionKey), read here off what is written.
const colliderJson = (function* walk(n: any, parent: mat4): Generator<{ json: any; parent: mat4 }> {
  const q = Array.isArray(n.quaternion) ? n.quaternion as quat : quat.fromEuler(quat.create(), n.rotation?.[0] ?? 0, n.rotation?.[1] ?? 0, n.rotation?.[2] ?? 0)
  const local = mat4.fromRotationTranslationScale(mat4.create(), q, (n.position ?? [0, 0, 0]) as vec3, (n.scale ?? [1, 1, 1]) as vec3)
  const world = mat4.multiply(mat4.create(), parent, local)
  if (n.type === 'collider') yield { json: n, parent }
  for (const c of n.children ?? []) yield* walk(c, world)
})(root, mat4.create())
for (const { json, parent } of colliderJson) {
  // A holder carrying the collider's parent transform, so the collider lands where the editor will put it.
  const holder = new Node('holder')
  holder.setPosition([...mat4.getTranslation(vec3.create(), parent)] as [number, number, number])
  holder.setQuaternion([...mat4.getRotation(quat.create(), parent)] as any)
  holder.setScale([...mat4.getScaling(vec3.create(), parent)] as [number, number, number])
  parseNodeJson(holder, JSON.parse(JSON.stringify({ ...json, children: [] })))
  waterScene.addNode(holder)
  holder.updateTransforms()
}
const landPos: number[] = landscape.position ?? [0, 0, 0]
const groundKeyOf = (group: WaterVolumeNode[]) => {
  const reach = waterGroupReach(group)
  const key = reach ? heightsRegionKey(u16, hMin, hMax, RES, SIZE, landPos[0], landPos[2], reach) : ''
  return key ? `${landPos[1]}:${key}` : ''
}
const BAKE_RES = Number(process.env.ISLAND_BAKE_RES ?? 1024)
const bakes: Record<string, string> = {}
const grouped = new Set<WaterVolumeNode>()
for (const river of riverNodes) {
  if (grouped.has(river)) continue
  const group = waterBakeGroup(river)
  for (const n of group) grouped.add(n)
  // The scratch scene has no landscape node: the island's own ground is the bake's ground.
  // A lake between two rivers stands where its outlet lets it, not where the world flooded it to: a coarse
  // bake finds that level, the lake is drawn there, and the fine bake starts from it.
  for (let pass = 0; pass < 2; pass++) {
    const coarse = bakeWater(prepareGroupBake(river, { maxRes: 256, ground: heightAt }).setup)
    let moved = false
    for (const l of coarse.report.levels) {
      const node = group.find(n => n.id === l.id)
      if (!node || Math.abs(l.level - l.drawn) < 0.05) continue
      const at = node.worldPosition
      node.setPosition([at[0], r3(l.level), at[2]])
      node.updateTransforms()
      log(`${node.name} stands at ${l.level.toFixed(2)} m (the world flooded it to ${l.drawn.toFixed(2)} m)`)
      moved = true
    }
    if (!moved) break
  }
  const started = Date.now()
  const { setup } = prepareGroupBake(river, { maxRes: BAKE_RES, ground: heightAt })
  const output = bakeWater(setup)
  const report = output.report
  log(`${group.map(n => n.name).join(', ')} baked as one: ${setup.nx} x ${setup.nz} cells of ${setup.cell.toFixed(2)} m in ${((Date.now() - started) / 1000).toFixed(0)} s; `
    + `${report.settled ? 'settled' : 'NOT settled'} after ${report.seconds.toFixed(0)} s of flow, ${report.inflow.toFixed(2)} m3/s in, ${report.outflow.toFixed(2)} out, ${report.lost.toFixed(2)} lost`)
  if (!report.settled || report.lost > 0.02 * report.inflow || Math.abs(report.outflow - report.inflow) > 0.05 * report.inflow) {
    throw new Error(`the water did not settle in its channels: ${JSON.stringify(report)}`)
  }
  const signature = river.bakeSignature(groundKeyOf(group))
  for (const m of output.members) {
    const n = group.find(g => g.id === m.id)!
    const bakeId = id(`water-bake:${n.id}`)
    m.info.source = bakeId
    bundle.giBakes = [...(bundle.giBakes ?? []).filter((g: any) => g.id !== bakeId), { id: bakeId, bytes: encodeWaterBake(m.info, signature).buffer }]
    bakes[n.id] = bakeId
    // How it runs: the share of its cells that are wet, and how fast.
    let wet = 0, sum = 0, top = 0
    for (let c = 0; c < m.info.nx * m.info.nz; c++) {
      if (m.info.info1[c * 4 + 3] <= 0.5) continue
      const v = Math.hypot(m.info.info0[c * 4 + 1], m.info.info0[c * 4 + 2])
      wet++; sum += v; top = Math.max(top, v)
    }
    log(`  ${n.name}: ${m.info.nx} x ${m.info.nz} cells, ${wet} wet, ${(sum / Math.max(1, wet)).toFixed(2)} m/s on average, ${top.toFixed(2)} at its fastest`)
  }
}

const LIQUID = {
  density: 1000, linearDrag: 2.5, angularDrag: 0.5, waveAmplitude: 0, waveFrequency: 0.6, affectCharacters: false,
  splashTemplate: 'Water Splash', wadeSplashTemplate: 'Water Step', enabled: true, currents: true,
}
const LAKE_WATER = { windSpeed: 2.5, waveDirection: 25, choppiness: 0.3, shoreFade: 4, followWind: true, waterMaterialId: LAKE_MAT, waterMaterial: lakeMatAsset.material }
// A river's waves are its current's, whatever the wind; its banks calm them.
const RIVER_WATER = { windSpeed: 0, shoreFade: 1.5, followWind: false, waterMaterialId: RIVER_MAT, waterMaterial: riverMatAsset.material }
const waterJson = async (n: WaterVolumeNode, over: any) => {
  const json: any = await n.serialize()
  json.waterVolume = { ...json.waterVolume, ...LIQUID, ...over, waterType: n.waterType }
  json.children = []
  return json
}
const waterGroup = {
  id: id('water'), name: 'Water', type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], spawnOnStart: true,
  children: [
    // A fresh breeze over the strait: 12 m/s across 10 km of open water raises a young sea of short, steep,
    // choppy waves. Offshore the wind blows stronger than the Wind node's breeze over the land, so the
    // sea keeps its own rather than following it.
    await waterJson(ocean, {
      density: 1025, windSpeed: 12, fetch: 10000, waveDirection: 25, choppiness: 0.8, shoreFade: 10, followWind: false,
      waterMaterialId: OCEAN_MAT, waterMaterial: oceanMatAsset.material,
    }),
    ...await Promise.all(lakeNodes.map(n => waterJson(n, { ...LAKE_WATER, ...(bakes[n.id] ? { bakeId: bakes[n.id] } : {}) }))),
    ...await Promise.all(riverNodes.map(n => waterJson(n, { ...RIVER_WATER, ...(bakes[n.id] ? { bakeId: bakes[n.id] } : {}) }))),
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
