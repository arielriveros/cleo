// Walls and roofs for the hamlet's houses, so the knight can walk in through the doors.
//
// A convex hull over a whole house (what every building used to get) fills it solid. These are BOXES
// instead, from the render mesh rasterised top-down into 0.2 m cells, the way dungeon/collision.mjs builds
// the dungeon's — but a house stands on the terrain, has no floor parts to start the columns from, and is
// small, so it is rebuilt more simply here:
//
//   - a WALL column wherever a steep face crosses the band a body stands in (0.3 m to 1.9 m above the
//     base), from under the ground up into the roof;
//   - a LINTEL over a doorway or window: steep faces only above that band, from the lowest of them up;
//   - the ROOF as one convex hull over everything above the eave (EAVE).
//
// A doorway is simply a gap in the walls, so it stays open; its lintels say how tall it is, which the
// generator logs and checks against the player. Walls are merged the way the dungeon's are: a few dozen
// boxes a house, not hundreds.

import { chainSlivers, compactClumps, cover, fillEnclosed } from './dungeon/collision.mjs'

const RES = 0.2
const Y0 = -1
const BIN = 0.25
const BINS = 64                     // -1 m .. +15 m
const BODY_LOW = 0.5                // over the floor; lower, a face is a step or the floor's own edge
const BODY_HIGH = 1.9
const FLOOR_MIN = 0.15              // an up face this far over the base, up to FLOOR_MAX, is a raised floor
const FLOOR_MAX = 0.6
const WALL_FOOT = -0.3              // walls start under the ground: the base sits at the LOWEST ground
const EAVE = 2.4                    // the roof hull takes everything from here up; boxes below
const EAVE_OVERLAP = 0.3            // walls and lintels reach this far into the hull, so nothing slips between
const LINTEL_STEP = 0.25            // lintels this close in height are one box

const round = (v) => Math.round(v * 1000) / 1000

/**
 * The house grid in the shape `dungeon/collision.mjs#rasterise` returns (so occluders.mjs reads both), plus
 * per cell: `roofLow` (underside of the roof, or Infinity), `topMax` (the highest anything reaches),
 * `steepMax`, and `floorY` (a raised floor: the highest up face FLOOR_MIN .. FLOOR_MAX over the base, or
 * -Infinity where the floor is the ground).
 */
export function rasteriseHouse(parts) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) for (let a = 0; a < 3; a++) {
    min[a] = Math.min(min[a], p.positions[i + a]); max[a] = Math.max(max[a], p.positions[i + a])
  }
  const x0 = Math.floor(min[0]) - 1, z0 = Math.floor(min[2]) - 1
  const W = Math.ceil((max[0] + 1 - x0) / RES), H = Math.ceil((max[2] + 1 - z0) / RES)
  const steep = new Uint8Array(W * H * BINS)
  const roofLow = new Float32Array(W * H).fill(Infinity)
  const topMax = new Float32Array(W * H).fill(-Infinity)
  const steepMax = new Float32Array(W * H).fill(-Infinity)
  const floorY = new Float32Array(W * H).fill(-Infinity)
  const binOf = (y) => Math.max(0, Math.min(BINS - 1, Math.floor((y - Y0) / BIN)))

  for (const p of parts) {
    const P = p.positions, I = p.indices
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2]
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2]
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
      const len = Math.hypot(nx, ny, nz)
      if (len < 1e-12) continue
      const up = ny / len
      const edge = Math.max(Math.hypot(e1x, e1y, e1z), Math.hypot(e2x, e2y, e2z), Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]))
      const n = Math.max(1, Math.ceil(edge / (RES * 0.5)))
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n
        const x = P[a] + e1x * u + e2x * v, y = P[a + 1] + e1y * u + e2y * v, z = P[a + 2] + e1z * u + e2z * v
        const gx = Math.floor((x - x0) / RES), gz = Math.floor((z - z0) / RES)
        if (gx < 0 || gz < 0 || gx >= W || gz >= H) continue
        const cell = gz * W + gx
        if (y > topMax[cell]) topMax[cell] = y
        if (Math.abs(up) <= 0.7) {
          steep[cell * BINS + binOf(y)] = 1
          if (y > steepMax[cell]) steepMax[cell] = y
        } else if (up < -0.3 && y > BODY_HIGH && y < roofLow[cell]) roofLow[cell] = y
        else if (up > 0.7 && y >= FLOOR_MIN && y <= FLOOR_MAX && y > floorY[cell]) floorY[cell] = y
      }
    }
  }
  return { x0, z0, W, H, steep, binOf, res: RES, y0: Y0, bin: BIN, bins: BINS, roofLow, topMax, steepMax, floorY }
}

/**
 * The colliders of one house, in its own (prop) space: `{ boxes: [{ kind, center, size, rotation }],
 * roofPoints, grid, doorLows, floor, interior }`.
 *
 * - `boxes`: walls and lintels, all standing up to EAVE + EAVE_OVERLAP, so every wall is the same height
 *   and merges with its neighbours (dungeon/collision.mjs: pockets filled, clumps one box each, diagonals
 *   one turned box each).
 * - `roofPoints`: every vertex over the roofed floor at or above EAVE, for ONE convex hull over the whole
 *   roof (and the gables and wall tops under it). Nothing walks up there, so a hull filling the attic
 *   keeps the knight and the camera out of the roof in one shape where boxes following it were hundreds.
 * - `doorLows`: the lintel heights, lowest first — how tall the doorways (and the windows' tops) are.
 * - `floor`: the raised floor's height over the base.
 * - `interior`: the box of the roofed, wall-free floor, for an exposure volume.
 */
export function houseColliders(parts) {
  const grid = rasteriseHouse(parts)
  const { x0, z0, W, H, steep, roofLow, floorY } = grid
  const wallAt = new Uint8Array(W * H)
  const lintelLow = new Float32Array(W * H).fill(Infinity)
  for (let cell = 0; cell < W * H; cell++) {
    // The band a body stands in, over the floor it stands on: the planks' own edges under a raised floor
    // are not walls.
    const base = Math.max(0, floorY[cell])
    const binLo = Math.floor((base + BODY_LOW - Y0) / BIN), binHi = Math.floor((base + BODY_HIGH - Y0) / BIN)
    for (let k = binLo; k <= binHi && !wallAt[cell]; k++) if (steep[cell * BINS + k]) wallAt[cell] = 1
    if (wallAt[cell]) continue
    for (let k = binHi + 1; k < BINS; k++) if (steep[cell * BINS + k]) { lintelLow[cell] = Y0 + k * BIN; break }
  }
  const top = EAVE + EAVE_OVERLAP

  const boxes = []
  const rectBox = (r, y0, y1, kind) => boxes.push({
    kind,
    center: [round(x0 + (r.gx + r.w / 2) * RES), round((y0 + y1) / 2), round(z0 + (r.gz + r.h / 2) * RES)],
    size: [round(r.w * RES), round(y1 - y0), round(r.h * RES)],
    rotation: [0, 0, 0],
  })

  // Walls, in the shape dungeon/collision.mjs merges: [base, top, lid, see-through].
  const walls = new Array(W * H)
  for (let cell = 0; cell < W * H; cell++) walls[cell] = wallAt[cell] ? [WALL_FOOT, top, Infinity, 0] : null
  fillEnclosed(grid, walls)
  const clumps = compactClumps(grid, walls)
  const { rects, lines } = chainSlivers(grid, cover(grid, cell => walls[cell], [0, 0, Infinity, 0]))
  for (const r of rects) rectBox(r, WALL_FOOT, top, 'wall')
  for (const c of [...clumps, ...lines]) boxes.push({
    kind: 'wall',
    center: [round(c.center[0]), round((WALL_FOOT + top) / 2), round(c.center[1])],
    size: [round(c.size[0]), round(top - WALL_FOOT), round(c.size[1])],
    rotation: [0, round(c.yaw), 0],
  })

  // Lintels: over a doorway or a window, from the face (to LINTEL_STEP, the highest of those merged, so a
  // doorway is never made lower than it is) up into the roof hull. Only the ones under the eave: higher,
  // the hull has them.
  const doorLows = []
  for (const r of cover(grid, cell => wallAt[cell] || !Number.isFinite(lintelLow[cell]) || lintelLow[cell] >= EAVE ? null : [lintelLow[cell]], [LINTEL_STEP])) {
    const low = r.hi[0]
    rectBox(r, low, top, 'lintel')
    doorLows.push(Math.floor(low * 4) / 4)
  }

  // The floor: both houses stand on a raised one, a third of a metre up. No boxes for it — the generator
  // raises the terrain under the house to it (build.mjs levelHouseFloors), and the terrain sloping up to
  // the doorway stands in for the step a capsule could not climb. `floor` is the height most roofed cells
  // share: a bench or a chest top in the same range is furniture, not a storey.
  const under = []
  for (let cell = 0; cell < W * H; cell++)
    if (!wallAt[cell] && floorY[cell] > -Infinity && Number.isFinite(roofLow[cell])) under.push(floorY[cell])
  under.sort((a, b) => a - b)
  const floor = under.length ? under[Math.floor(under.length / 2)] : 0

  // The roof hull's points: every vertex at or over the eave, inside the roofed floor's bounds (so a tall
  // post out in the yard does not stretch the hull over it).
  let rx0 = Infinity, rz0 = Infinity, rx1 = -Infinity, rz1 = -Infinity
  for (let gz = 0; gz < H; gz++) for (let gx = 0; gx < W; gx++) {
    if (!Number.isFinite(roofLow[gz * W + gx])) continue
    rx0 = Math.min(rx0, x0 + gx * RES); rx1 = Math.max(rx1, x0 + (gx + 1) * RES)
    rz0 = Math.min(rz0, z0 + gz * RES); rz1 = Math.max(rz1, z0 + (gz + 1) * RES)
  }
  const roofPoints = []
  for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) {
    const x = p.positions[i], y = p.positions[i + 1], z = p.positions[i + 2]
    if (y >= EAVE && x >= rx0 - 0.5 && x <= rx1 + 0.5 && z >= rz0 - 0.5 && z <= rz1 + 0.5) roofPoints.push(x, y, z)
  }

  // The interior: roofed cells with no wall, their bounding box pulled in a little; up to the median
  // roof underside over them.
  let min = [Infinity, Infinity], max = [-Infinity, -Infinity]
  const unders = []
  for (let gz = 0; gz < H; gz++) for (let gx = 0; gx < W; gx++) {
    const cell = gz * W + gx
    if (wallAt[cell] || !Number.isFinite(roofLow[cell])) continue
    const x = x0 + (gx + 0.5) * RES, z = z0 + (gz + 0.5) * RES
    min = [Math.min(min[0], x), Math.min(min[1], z)]; max = [Math.max(max[0], x), Math.max(max[1], z)]
    unders.push(roofLow[cell])
  }
  unders.sort((a, b) => a - b)
  const ceiling = unders.length ? unders[Math.floor(unders.length / 2)] : 0
  const interior = unders.length ? {
    center: [round((min[0] + max[0]) / 2), round(ceiling / 2), round((min[1] + max[1]) / 2)],
    size: [round(Math.max(1, max[0] - min[0] - 0.6)), round(Math.max(2, ceiling)), round(Math.max(1, max[1] - min[1] - 0.6))],
  } : null

  doorLows.sort((a, b) => a - b)
  return { boxes, roofPoints: Float32Array.from(roofPoints), grid, doorLows, floor: round(floor), interior }
}
