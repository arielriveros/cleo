// The dungeon's props, as parts: the scanned models in build/props and a few simple joinery pieces built
// from boxes. Geometry only -- materials, colliders and placement are the generator's.
//
// Every prop shares one frame: origin at the middle of its footprint on the floor, +Y up, its FRONT toward
// +Z. A prop that stands against a wall therefore has its back on local z = -depth/2, and is placed with a
// yaw that turns +Z away from the wall, the same way a wall torch is.

import path from 'path'
import { mat4 } from 'gl-matrix'
import { boundsOf, mergeByMaterial, mergeParts, normalizeParts, partsOf, readGltf } from '../meshes.mjs'

/** Transform parts in place by `m` (rotation, uniform scale and translation). */
function transform(parts, m) {
  const n = mat4.invert(mat4.create(), m)
  mat4.transpose(n, n)
  for (const p of parts) for (let k = 0; k < p.positions.length; k += 3) {
    const [x, y, z] = [p.positions[k], p.positions[k + 1], p.positions[k + 2]]
    p.positions[k] = m[0] * x + m[4] * y + m[8] * z + m[12]
    p.positions[k + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
    p.positions[k + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
    const [a, b, c] = [p.normals[k], p.normals[k + 1], p.normals[k + 2]]
    const nx = n[0] * a + n[4] * b + n[8] * c, ny = n[1] * a + n[5] * b + n[9] * c, nz = n[2] * a + n[6] * b + n[10] * c
    const l = Math.hypot(nx, ny, nz) || 1
    p.normals[k] = nx / l; p.normals[k + 1] = ny / l; p.normals[k + 2] = nz / l
  }
  return parts
}

/** The bookcase, its open front turned to +Z (the file's is +X), `height` tall. */
export function buildBookcase(propsDir, { height = 2.6 } = {}) {
  const parts = mergeByMaterial(partsOf(readGltf(path.join(propsDir, 'bookcase.glb'))))
  transform(parts, mat4.fromYRotation(mat4.create(), -Math.PI / 2))
  normalizeParts(parts, { scale: height / boundsOf(parts).size[1] })
  return { parts, size: boundsOf(parts).size }
}

/** The dungeon cage, `height` tall: a prisoner's cage standing, or a lantern-sized one hung up. */
export function buildCage(propsDir, { height = 2.4 } = {}) {
  const parts = mergeByMaterial(partsOf(readGltf(path.join(propsDir, 'dungeon_cage.glb'))))
  normalizeParts(parts, { scale: height / boundsOf(parts).size[1] })
  return { parts, size: boundsOf(parts).size }
}

/** One of the polyhaven weapons, as it comes: upright, metres, its grip near the origin. */
export function buildWeapon(file) {
  const parts = mergeByMaterial(partsOf(readGltf(file)))
  const b = boundsOf(parts)
  return { parts, size: b.size, min: b.min, max: b.max }
}

/** The second barrel of wooden_barrels_01 (the first is the breakable one), base on the origin. */
export function buildStaticBarrel(file) {
  const doc = readGltf(file)
  const part = mergeParts(partsOf(doc, { filter: n => n.name === 'wooden_barrels_01_barrel02', transform: () => mat4.create() }), 'Barrel', 0)
  normalizeParts([part])
  return { parts: [part], size: boundsOf([part]).size }
}

// ---------------------------------------------------------------------------------------------------
// Joinery: boxes with uvs in metres (scaled by `uvScale`), so the plank texture keeps its size on every
// board, however long.
// ---------------------------------------------------------------------------------------------------

/** An axis-aligned box `size` big, centred on `at`, as part arrays. */
function box(size, at, uvScale = 1 / 1.5) {
  const [hx, hy, hz] = size.map(v => v / 2)
  const faces = [
    // normal, u axis, v axis (each as [axis, sign])
    [[1, 0, 0], [2, -1], [1, 1]], [[-1, 0, 0], [2, 1], [1, 1]],
    [[0, 1, 0], [0, 1], [2, -1]], [[0, -1, 0], [0, 1], [2, 1]],
    [[0, 0, 1], [0, 1], [1, 1]], [[0, 0, -1], [0, -1], [1, 1]],
  ]
  const positions = [], normals = [], uvs = [], indices = []
  const half = [hx, hy, hz]
  for (const [n, [ua, us], [va, vs]] of faces) {
    const base = positions.length / 3
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 0, 0]
      const na = n.findIndex(v => v !== 0)
      p[na] = n[na] * half[na]
      p[ua] = su * us * half[ua]
      p[va] = sv * vs * half[va]
      positions.push(p[0] + at[0], p[1] + at[1], p[2] + at[2])
      normals.push(...n)
      uvs.push((p[ua] + at[ua]) * us * uvScale, (p[va] + at[va]) * vs * uvScale)
    }
    // Wound so the face's front is its normal side.
    const tri = [0, 1, 2, 0, 2, 3].map(i => base + i)
    if (cross(positions, tri, n)) indices.push(...tri)
    else indices.push(tri[0], tri[2], tri[1], tri[3], tri[5], tri[4])
  }
  return { positions, normals, uvs, indices }
}

/** Whether triangle `tri[0..2]` winds counter-clockwise seen from its normal side. */
function cross(positions, tri, n) {
  const p = (i) => [positions[tri[i] * 3], positions[tri[i] * 3 + 1], positions[tri[i] * 3 + 2]]
  const a = p(0), b = p(1), c = p(2)
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const x = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  return x[0] * n[0] + x[1] * n[1] + x[2] * n[2] > 0
}

/** Boxes ([size, centre] pairs) as one part. */
function boxes(name, list) {
  const out = { positions: [], normals: [], uvs: [], indices: [] }
  for (const [size, at] of list) {
    const b = box(size, at)
    const base = out.positions.length / 3
    out.positions.push(...b.positions); out.normals.push(...b.normals); out.uvs.push(...b.uvs)
    out.indices.push(...b.indices.map(i => i + base))
  }
  return {
    name, material: 0, positions: Float32Array.from(out.positions), normals: Float32Array.from(out.normals),
    uvs: Float32Array.from(out.uvs), indices: Uint32Array.from(out.indices),
  }
}

/** A plank crate, `s` a side, battens round its faces. */
export function buildCrate(s = 0.7) {
  const t = 0.04, h = s / 2
  const list = [[[s - 0.02, s - 0.02, s - 0.02], [0, h, 0]]]
  for (const y of [0.06, s - 0.06]) {
    list.push([[s + t, 0.08, t], [0, y, h]], [[s + t, 0.08, t], [0, y, -h]], [[t, 0.08, s + t], [h, y, 0]], [[t, 0.08, s + t], [-h, y, 0]])
  }
  for (const [x, z] of [[h, h], [-h, h], [h, -h], [-h, -h]]) list.push([[0.08, s, 0.08], [x * 0.98, h, z * 0.98]])
  return { parts: [boxes('Crate', list)], size: [s + t, s, s + t] }
}

/** A trestle table, `length` along X. */
export function buildTable(length = 2.4, width = 0.9, height = 0.82) {
  const top = 0.07, leg = 0.09
  const list = [[[length, top, width], [0, height - top / 2, 0]]]
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    list.push([[leg, height - top, leg], [sx * (length / 2 - 0.18), (height - top) / 2, sz * (width / 2 - 0.12)]])
  list.push([[length - 0.4, 0.06, 0.06], [0, 0.22, 0]])
  return { parts: [boxes('Table', list)], size: [length, height, width] }
}

/** A bench, `length` along X. */
export function buildBench(length = 2.2, height = 0.45) {
  const seat = 0.06
  const list = [[[length, seat, 0.32], [0, height - seat / 2, 0]]]
  for (const sx of [-1, 1]) list.push([[0.06, height - seat, 0.26], [sx * (length / 2 - 0.2), (height - seat) / 2, 0]])
  return { parts: [boxes('Bench', list)], size: [length, height, 0.32] }
}

/** A ladder against a wall (its back at z = 0, rising along +Y), `height` tall. */
export function buildLadder(height = 4.2, width = 0.55) {
  const rail = 0.07
  const list = [[[rail, height, rail], [-width / 2, height / 2, rail / 2 + 0.06]], [[rail, height, rail], [width / 2, height / 2, rail / 2 + 0.06]]]
  for (let y = 0.3; y < height - 0.1; y += 0.32) list.push([[width, 0.045, 0.045], [0, y, rail / 2 + 0.06]])
  return { parts: [boxes('Ladder', list)], size: [width + rail, height, rail + 0.06] }
}

/** A board on a wall to hang weapons from (back at z = 0), `length` along X. */
export function buildRack(length = 1.8) {
  const list = [[[length, 0.4, 0.05], [0, 0, 0.025]], [[length, 0.06, 0.16], [0, -0.17, 0.08]]]
  return { parts: [boxes('Rack', list)], size: [length, 0.4, 0.16] }
}

/** A length of chain (a square iron bar, 1 m along +Y from the origin): scaled along Y to the length wanted. */
export function buildChain(thickness = 0.035) {
  return { parts: [boxes('Chain', [[[thickness, 1, thickness], [0, 0.5, 0]]])], size: [thickness, 1, thickness] }
}

/** A church candle on a little iron dish: `height` of wax. The flame goes at `height + 0.02`. */
export function buildCandle(height = 0.22) {
  const segments = 10, r = 0.035
  const positions = [], normals = [], uvs = [], indices = []
  for (let i = 0; i <= segments; i++) {
    const a = i / segments * Math.PI * 2, c = Math.cos(a), s = Math.sin(a)
    positions.push(c * r, 0, s * r, c * r, height, s * r)
    normals.push(c, 0, s, c, 0, s)
    uvs.push(i / segments, 0, i / segments, height * 4)
    if (i < segments) { const b = i * 2; indices.push(b, b + 1, b + 2, b + 2, b + 1, b + 3) }
  }
  const top = positions.length / 3
  positions.push(0, height, 0); normals.push(0, 1, 0); uvs.push(0.5, 0.5)
  for (let i = 0; i < segments; i++) indices.push(top, i * 2 + 3, i * 2 + 1)
  // Sides (bottom, top, next bottom) and cap (centre, next, this) are both counter-clockwise from outside.
  const wax = { name: 'Wax', material: 0, positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) }
  const dish = boxes('Dish', [[[0.14, 0.02, 0.14], [0, 0.01, 0]]])
  for (let k = 1; k < wax.positions.length; k += 3) wax.positions[k] += 0.02
  return { parts: [wax, dish], size: [0.14, height + 0.02, 0.14], flame: height + 0.04 }
}
