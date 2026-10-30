// Colliders for the dungeon, generated from its render mesh.
//
// The scene format has no triangle-mesh collider, and cannon could not use one anyway: it collides only
// spheres and planes with a trimesh, so the player's capsule (a cylinder between two spheres) would walk
// through every wall. So the architecture is rebuilt as BOXES, the shape everything collides with best.
//
// The mesh is rasterised top-down into 0.2 m cells. Per cell it records the heights of the walkable
// surfaces (the up faces of the floor-like parts) and, in 0.25 m height bins, where steep faces are. Then,
// for every floor of every cell:
//
//   - a FLOOR box under it, 0.3 m thick;
//   - a WALL column if a steep face crosses the band a body stands in ([h + 0.4, h + 1.6]), from the floor
//     up through the steep faces above it (to the ceiling for a wall, to its top for a sarcophagus);
//   - a CEILING slab under the lowest down face over it, for the camera boom.
//
// Cells that agree to within a tolerance are merged into rectangles, one box each (`cover`); a pillar or
// another small solid clump of wall is one box (`compactClumps`), and a diagonal wall one turned box
// (`chainSlivers`) rather than a staircase of slivers. Below 0.4 m a steep face is a STEP, not
// a wall, and the engine has no step-up: every step between floors is given a WEDGE, a 30° box over its
// edge, and every staircase a RAMP, a single tilted box whose top touches each nosing. Boxes are grouped
// into one static body per 10 m chunk, because the broadphase pairs bodies, not shapes.
//
// `checkRoute` walks a polyline over the result the way a capsule would, and is what the generator asserts
// with: floor under every step of the route, nothing solid in the column above it.

export const RES = 0.2
const BIN = 0.25
const Y0 = -8
const BINS = 80                    // -8 m .. +12 m
const WALL_LOW = 0.4               // a steep face below this is a step
const WALL_HIGH = 1.6
const FLOOR_THICK = 0.3
// How far the cells merged into one box may disagree (see `cover`). The fewer boxes, the cheaper every
// broadphase pair and every camera ray; a few centimetres of floor or a little more wall changes nothing.
const FLOOR_TOL = 0.06
const WALL_BASE_TOL = 0.3
const WALL_TOP_TOL = 0.75
const CEILING_TOL = 1.0
const CEILING_HEADROOM = 1.9
/** Square metres: an enclosed pocket up to this size is filled solid (see `fillEnclosed`). */
const MAX_POCKET = 2.5
/** A wall clump this small (square metres of bounding box) and this full is one box (`compactClumps`). */
const CLUMP_AREA = 4
const CLUMP_FILL = 0.6
/** A clump of any size this full of wall is its bounding box. */
const SOLID_FILL = 0.85
/**
 * Diagonal walls (`chainSlivers`): a sliver is at most SLIVER cells across, a chain joins slivers up to
 * CHAIN_GAP cells apart, and its turned box is at most CHAIN_WIDTH metres across.
 */
const SLIVER = 2
const CHAIN_GAP = 2
const CHAIN_WIDTH = 1.0
const MAX_WEDGE_STEP = 0.36        // taller than this, an edge is a ledge (or a wall), not a step
// Lower than this, the capsule's round foot rides up an edge on its own: no wedge (the floor tolerance
// already merges most of these, and every one was a box).
const MIN_WEDGE_STEP = 0.08
const WEDGE_SLOPE = Math.tan(30 * Math.PI / 180)

/** The parts whose up faces are walked on. Everything else only ever blocks. */
export const FLOOR_PARTS = new Set(['Floors', 'Stairs', 'Gallery', 'Arena', 'Throne', 'Grate'])
/** Parts that are not solid at all (bars you see through but the generator would wall in are kept). */
const IGNORED_PARTS = new Set(['Windows', 'Oculus', 'Beams', 'Portcullis'])
/**
 * Parts the player camera sees through (the scene gives their nodes `cameraDither`): their walls are kept
 * apart and flagged `seeThrough`, so they can go on bodies of their own that the camera rig ignores.
 */
export const SEE_THROUGH_PARTS = new Set(['Pillars'])

/** Rasterise the structure. Returns the grid: per-cell floors, steep and down-face bins. */
export function rasterise(parts, bounds) {
  const x0 = Math.floor(bounds.min[0]) - 1, z0 = Math.floor(bounds.min[2]) - 1
  const W = Math.ceil((bounds.max[0] + 1 - x0) / RES), H = Math.ceil((bounds.max[2] + 1 - z0) / RES)
  const floors = Array.from({ length: W * H }, () => [])   // [{ y, stairs }]
  const steep = new Uint8Array(W * H * BINS)
  // Cells only a see-through part (SEE_THROUGH_PARTS) stands in (=== 1): their walls are boxes of their own.
  const seeThrough = new Uint8Array(W * H)
  const down = new Uint8Array(W * H * BINS)
  const binOf = (y) => Math.max(0, Math.min(BINS - 1, Math.floor((y - Y0) / BIN)))
  const cellOf = (x, z) => {
    const gx = Math.floor((x - x0) / RES), gz = Math.floor((z - z0) / RES)
    return gx < 0 || gz < 0 || gx >= W || gz >= H ? -1 : gz * W + gx
  }

  for (const part of parts) {
    if (IGNORED_PARTS.has(part.name)) continue
    const isFloor = FLOOR_PARTS.has(part.name)
    const isStairs = part.name === 'Stairs'
    const isSeeThrough = SEE_THROUGH_PARTS.has(part.name)
    const P = part.positions, I = part.indices
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3
      const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2]
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
      const len = Math.hypot(nx, ny, nz)
      if (len < 1e-12) continue
      const up = ny / len
      if (up > 0.7) {
        if (!isFloor) continue
        // Cell centres inside the triangle's XZ projection, height interpolated.
        const minx = Math.floor((Math.min(ax, bx, cx) - x0) / RES), maxx = Math.floor((Math.max(ax, bx, cx) - x0) / RES)
        const minz = Math.floor((Math.min(az, bz, cz) - z0) / RES), maxz = Math.floor((Math.max(az, bz, cz) - z0) / RES)
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
        if (Math.abs(d) < 1e-12) continue
        for (let gz = Math.max(0, minz); gz <= Math.min(H - 1, maxz); gz++) for (let gx = Math.max(0, minx); gx <= Math.min(W - 1, maxx); gx++) {
          const px = x0 + (gx + 0.5) * RES, pz = z0 + (gz + 0.5) * RES
          const u = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / d
          const v = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / d
          if (u < -1e-3 || v < -1e-3 || u + v > 1 + 1e-3) continue
          const y = u * ay + v * by + (1 - u - v) * cy
          const list = floors[gz * W + gx]
          const near = list.find(f => Math.abs(f.y - y) < 0.12)
          if (!near) list.push({ y, stairs: isStairs })
          else if (y > near.y) { near.y = y; near.stairs ||= isStairs }
        }
      } else {
        // Steep and down faces: sample the triangle every ~RES/2 and mark the cells and height bins.
        const target = up < -0.7 ? down : Math.abs(up) <= 0.7 ? steep : null
        if (!target) continue
        const edge = Math.max(Math.hypot(e1x, e1y, e1z), Math.hypot(e2x, e2y, e2z), Math.hypot(cx - bx, cy - by, cz - bz))
        const n = Math.max(1, Math.ceil(edge / (RES * 0.5)))
        for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
          const u = i / n, v = j / n
          const x = ax + e1x * u + e2x * v, y = ay + e1y * u + e2y * v, z = az + e1z * u + e2z * v
          const cell = cellOf(x, z)
          if (cell < 0) continue
          target[cell * BINS + binOf(y)] = 1
          // Bit 1: a see-through part has a face here; bit 2: something solid does too (it wins).
          if (target === steep) seeThrough[cell] |= isSeeThrough ? 1 : 2
        }
      }
    }
  }
  fillSlits(floors, W, H)
  for (let i = 0; i < floors.length; i++) {
    // A floor with another less than a body's height over it is buried (the hall floor under the arena's
    // dais, the floor under a stair's bottom treads): nothing stands there, and it must not read as a step.
    const list = floors[i].sort((p, q) => p.y - q.y)
    floors[i] = list.filter((f, k) => k === list.length - 1 || list[k + 1].y - f.y >= 1.0)
  }
  // `res`/`y0`/`bin`/`bins` describe the steep-face bins for readers outside this module (occluders.mjs).
  return { x0, z0, W, H, floors, steep, down, seeThrough, binOf, res: RES, y0: Y0, bin: BIN, bins: BINS }
}

/**
 * Close slits a cell or two wide in a floor (plank gaps on the gallery, a gutter in the entry hall): a
 * cell with floor at the same height on both sides, along X or along Z, gets that floor. Two passes.
 */
function fillSlits(floors, W, H) {
  for (let pass = 0; pass < 2; pass++) {
    const add = []
    for (let gz = 0; gz < H; gz++) for (let gx = 0; gx < W; gx++) {
      const i = gz * W + gx
      for (const [ox, oz] of [[1, 0], [0, 1]]) for (const reach of [1, 2]) {
        const ax = gx - ox, az = gz - oz, bx = gx + ox * reach, bz = gz + oz * reach
        if (ax < 0 || az < 0 || bx >= W || bz >= H) continue
        for (const f of floors[az * W + ax]) {
          if (floors[i].some(e => Math.abs(e.y - f.y) < 0.12)) continue
          const g = floors[bz * W + bx].find(e => Math.abs(e.y - f.y) < 0.03)
          if (g) add.push([i, { y: Math.max(f.y, g.y), stairs: f.stairs && g.stairs }])
        }
      }
    }
    for (const [i, f] of add) if (!floors[i].some(e => Math.abs(e.y - f.y) < 0.12)) floors[i].push(f)
  }
}

/**
 * The columns over one floor of one cell: wall top (or null), ceiling (or null). `rampOver` is the top of a
 * ramp over this cell, if any: nothing under a ramp may reach up through it.
 */
function columnOver(grid, cell, floorIndex, rampOver = null) {
  const list = grid.floors[cell]
  const h = list[floorIndex].y
  let next = floorIndex + 1 < list.length ? list[floorIndex + 1].y : Infinity
  if (rampOver !== null) {
    // The ramp's own treads (and the bevel rows between them) are not walls: under it, only what stands
    // clear below it counts.
    if (rampOver - h < 1.0) return { h, wall: null, ceiling: null, underRamp: true }
    next = Math.min(next, rampOver - FLOOR_THICK - 0.05)
  }
  const { steep, down, binOf } = grid
  const base = cell * BINS
  // The ceiling: the lowest down face at least 1.9 m above the floor and below the next floor.
  let ceiling = null
  for (let b = binOf(h + 1.9); b < BINS; b++) {
    const y = Y0 + b * BIN
    if (y >= next) break
    if (down[base + b]) { ceiling = y; break }
  }
  const lid = Math.min(next - 0.05, ceiling ?? Infinity, h + 6)
  // A wall: a steep face in the band a standing body occupies, then up through contiguous steep bins.
  let wall = null
  for (let b = binOf(h + WALL_LOW); b <= binOf(Math.min(h + WALL_HIGH, lid)); b++) {
    if (!steep[base + b]) continue
    let top = b, gap = 0
    for (let t = b + 1; t < BINS && Y0 + t * BIN < lid; t++) {
      if (steep[base + t]) { top = t; gap = 0 } else if (++gap > 2) break
    }
    wall = Math.min(lid, Y0 + (top + 1) * BIN)
    break
  }
  return { h, wall, ceiling, lid }
}

/**
 * Greedy rectangles over the grid, each grown along X then Z. Cells join one when their VALUES agree to
 * within `tol`, and a rectangle may grow over cells an earlier one already covers (only its seed must be
 * new). `valuesOf(cell)` is a number array (null = none), `tol` one tolerance per component. Each rectangle
 * `{ gx, gz, w, h, lo, hi }` carries the `lo` and `hi` of every component over its cells.
 *
 * Far fewer boxes than exact keys: a floor whose tiles wander by a centimetre or two, or a wall whose top
 * steps with the masonry, is one box rather than a strip per value; and overlapping lets an L or a T be two
 * boxes instead of a staircase of slivers.
 */
export function cover(grid, valuesOf, tol) {
  const { W, H } = grid
  const vals = new Array(W * H)
  for (let i = 0; i < W * H; i++) vals[i] = valuesOf(i)
  const covered = new Uint8Array(W * H)
  const rects = []
  const fits = (j, lo, hi) => {
    const v = vals[j]
    if (!v) return false
    for (let c = 0; c < v.length; c++) if (Math.max(hi[c], v[c]) - Math.min(lo[c], v[c]) > tol[c]) return false
    return true
  }
  const take = (j, lo, hi) => {
    const v = vals[j]
    for (let c = 0; c < v.length; c++) { lo[c] = Math.min(lo[c], v[c]); hi[c] = Math.max(hi[c], v[c]) }
  }
  for (let gz = 0; gz < H; gz++) for (let gx = 0; gx < W; gx++) {
    const i = gz * W + gx
    if (!vals[i] || covered[i]) continue
    const lo = vals[i].slice(), hi = vals[i].slice()
    // Back along X first (over covered cells only: they are what an overlap can reuse), then forward.
    let x0 = gx
    while (x0 > 0 && covered[i - (gx - x0) - 1] && fits(i - (gx - x0) - 1, lo, hi)) { x0--; take(gz * W + x0, lo, hi) }
    let x1 = gx + 1
    while (x1 < W && fits(gz * W + x1, lo, hi)) { take(gz * W + x1, lo, hi); x1++ }
    let z1 = gz + 1
    grow: while (z1 < H) {
      const l = lo.slice(), h = hi.slice()
      for (let x = x0; x < x1; x++) {
        const j = z1 * W + x
        if (!fits(j, l, h)) break grow
        take(j, l, h)
      }
      for (let c = 0; c < lo.length; c++) { lo[c] = l[c]; hi[c] = h[c] }
      z1++
    }
    for (let z = gz; z < z1; z++) for (let x = x0; x < x1; x++) covered[z * W + x] = 1
    rects.push({ gx: x0, gz, w: x1 - x0, h: z1 - gz, lo, hi })
  }
  return rects
}

/**
 * Fill the small pockets a ring of walls closes off (the hollow inside a pillar, the gap inside a double
 * wall): nothing can stand there, and a solid one is a box where its ring was a dozen. A pocket is a
 * 4-connected run of empty cells, no larger than MAX_POCKET, that never reaches the grid's edge; it takes
 * the values of the wall beside it. `walls` is modified in place.
 */
export function fillEnclosed(grid, walls) {
  const { W, H } = grid
  const seen = new Uint8Array(W * H)
  const stack = []
  for (let start = 0; start < W * H; start++) {
    if (walls[start] || seen[start]) continue
    const pocket = []
    let open = false, ring = null
    stack.push(start); seen[start] = 1
    while (stack.length) {
      const i = stack.pop()
      pocket.push(i)
      const gx = i % W, gz = (i - gx) / W
      if (gx === 0 || gz === 0 || gx === W - 1 || gz === H - 1) open = true
      for (const j of [gx > 0 ? i - 1 : -1, gx < W - 1 ? i + 1 : -1, gz > 0 ? i - W : -1, gz < H - 1 ? i + W : -1]) {
        if (j < 0) continue
        if (walls[j]) { ring ??= walls[j]; continue }
        if (!seen[j]) { seen[j] = 1; stack.push(j) }
      }
    }
    if (open || !ring || pocket.length * RES * RES > MAX_POCKET) continue
    for (const i of pocket) walls[i] = ring.slice()
  }
}

/**
 * Small or solid clumps of wall as ONE box each: their bounding box, from the lowest base to the highest
 * top. A clump is an 8-connected run of wall cells of one see-through kind (the last value); it qualifies
 * when its bounding box is at most CLUMP_AREA and at least CLUMP_FILL full (a pillar, a column), or of any
 * size and at least SOLID_FILL full (a row of sarcophagi). Their cells are cleared from `walls`. Returns
 * `{ lo, hi, center: [x, z], size: [x, z], yaw: 0 }`.
 */
export function compactClumps(grid, walls) {
  const { W, H, x0, z0 } = grid
  const seen = new Uint8Array(W * H)
  const out = []
  const stack = []
  for (let start = 0; start < W * H; start++) {
    if (!walls[start] || seen[start]) continue
    const kind = walls[start][walls[start].length - 1]
    const cells = []
    let gx0 = Infinity, gz0 = Infinity, gx1 = -Infinity, gz1 = -Infinity
    stack.push(start); seen[start] = 1
    while (stack.length) {
      const i = stack.pop()
      cells.push(i)
      const gx = i % W, gz = (i - gx) / W
      gx0 = Math.min(gx0, gx); gx1 = Math.max(gx1, gx); gz0 = Math.min(gz0, gz); gz1 = Math.max(gz1, gz)
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const x = gx + dx, z = gz + dz
        if (x < 0 || z < 0 || x >= W || z >= H) continue
        const j = z * W + x
        if (!walls[j] || seen[j] || walls[j][walls[j].length - 1] !== kind) continue
        seen[j] = 1; stack.push(j)
      }
    }
    const w = gx1 - gx0 + 1, h = gz1 - gz0 + 1
    const fill = cells.length / (w * h)
    if (!((w * h * RES * RES <= CLUMP_AREA && fill >= CLUMP_FILL) || fill >= SOLID_FILL)) continue
    const lo = walls[cells[0]].slice(), hi = walls[cells[0]].slice()
    for (const i of cells) {
      const v = walls[i]
      for (let c = 0; c < v.length; c++) { lo[c] = Math.min(lo[c], v[c]); hi[c] = Math.max(hi[c], v[c]) }
      walls[i] = null
    }
    out.push({ lo, hi, center: [x0 + (gx0 + w / 2) * RES, z0 + (gz0 + h / 2) * RES], size: [w * RES, h * RES], yaw: 0 })
  }
  return out
}

/**
 * Diagonal walls as ONE turned box each. Axis-aligned rectangles can only follow a diagonal as a staircase
 * of slivers, one or two per cell row, and a rasterised diagonal often does not even touch from row to row.
 * So `cover`'s small rectangles (at most SLIVER cells across) are chained: from each, the slivers within
 * CHAIN_GAP cells join while every cell of the chain stays inside a box at most CHAIN_WIDTH across, with
 * values within the wall tolerances. A chain of three or more that ends at least three times as long as it
 * is across is one box (`lineOf`). Returns `{ rects, lines }`: the rectangles left as they were, and the
 * lines in the shape `compactClumps` returns.
 */
export function chainSlivers(grid, rects) {
  const { W } = grid
  const isSliver = r => Math.min(r.w, r.h) <= SLIVER && Math.max(r.w, r.h) <= 3 * SLIVER
  const slivers = rects.filter(isSliver)
  const gapOf = (a, b) => Math.max(
    Math.max(a.gx, b.gx) - Math.min(a.gx + a.w, b.gx + b.w),
    Math.max(a.gz, b.gz) - Math.min(a.gz + a.h, b.gz + b.h))
  // Neighbours through a coarse bucket grid: slivers are small, so a bucket and its ring hold every candidate.
  const B = 8
  const buckets = new Map()
  const keyOf = (bx, bz) => bx * 100003 + bz
  for (const r of slivers) {
    const k = keyOf(Math.floor(r.gx / B), Math.floor(r.gz / B))
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(r)
  }
  const near = (r) => {
    const out = []
    const bx = Math.floor(r.gx / B), bz = Math.floor(r.gz / B)
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++)
      for (const s of buckets.get(keyOf(bx + dx, bz + dz)) ?? []) if (s !== r && gapOf(r, s) <= CHAIN_GAP) out.push(s)
    return out
  }
  const cellsOf = (r) => {
    const out = []
    for (let z = r.gz; z < r.gz + r.h; z++) for (let x = r.gx; x < r.gx + r.w; x++) out.push(z * W + x)
    return out
  }
  const fits = (lo, hi, r) => r.lo[3] === lo[3]
    && Math.max(hi[0], r.hi[0]) - Math.min(lo[0], r.lo[0]) <= WALL_BASE_TOL
    && Math.max(hi[1], r.hi[1]) - Math.min(lo[1], r.lo[1]) <= WALL_TOP_TOL

  const used = new Set()
  const lines = []
  for (const seed of slivers) {
    if (used.has(seed)) continue
    const chain = [seed]
    const inChain = new Set(chain)
    let cells = cellsOf(seed)
    const lo = seed.lo.slice(), hi = seed.hi.slice()
    let shape = null
    for (let grown = true; grown;) {
      grown = false
      const candidates = new Set()
      for (const r of chain) for (const s of near(r)) if (!used.has(s) && !inChain.has(s)) candidates.add(s)
      for (const s of candidates) {
        if (!fits(lo, hi, s)) continue
        const next = cells.concat(cellsOf(s))
        const line = lineOf(grid, next)
        if (line.size[0] > CHAIN_WIDTH) continue
        chain.push(s); inChain.add(s); cells = next; shape = line; grown = true
        for (let c = 0; c < lo.length; c++) { lo[c] = Math.min(lo[c], s.lo[c]); hi[c] = Math.max(hi[c], s.hi[c]) }
      }
    }
    // A line only once it is one: three slivers or more, three times as long as it is across.
    if (chain.length < 3 || !shape || shape.size[1] < 3 * shape.size[0]) continue
    for (const r of chain) used.add(r)
    lines.push({ lo, hi, ...shape })
  }
  return { rects: rects.filter(r => !used.has(r)), lines }
}

/**
 * The box along a set of cells: the principal axis of the cell centres, the box spanning them along it
 * and across it (plus the cells' own reach). `size` is [across, along]; `yaw` turns local +Z onto the axis.
 */
function lineOf(grid, cells) {
  const { W, x0, z0 } = grid
  const pts = cells.map(i => { const gx = i % W, gz = (i - gx) / W; return [x0 + (gx + 0.5) * RES, z0 + (gz + 0.5) * RES] })
  let mx = 0, mz = 0
  for (const [x, z] of pts) { mx += x; mz += z }
  mx /= pts.length; mz /= pts.length
  let sxx = 0, szz = 0, sxz = 0
  for (const [x, z] of pts) { const dx = x - mx, dz = z - mz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  const ax = Math.cos(theta), az = Math.sin(theta)        // along
  let t0 = Infinity, t1 = -Infinity, p0 = Infinity, p1 = -Infinity
  for (const [x, z] of pts) {
    const dx = x - mx, dz = z - mz
    const t = dx * ax + dz * az, p = -dx * az + dz * ax
    t0 = Math.min(t0, t); t1 = Math.max(t1, t); p0 = Math.min(p0, p); p1 = Math.max(p1, p)
  }
  // A cell reaches half its diagonal past its centre along a 45° axis, half a side along X or Z.
  const reach = RES * (0.5 + Math.abs(2 * ax * az) * (Math.SQRT1_2 - 0.5))
  const across = p1 - p0 + 2 * reach, along = t1 - t0 + 2 * reach
  const tc = (t0 + t1) / 2, pc = (p0 + p1) / 2
  return {
    center: [mx + ax * tc - az * pc, mz + az * tc + ax * pc],
    size: [across, along],
    yaw: Math.atan2(ax, az) * 180 / Math.PI,
  }
}

const q = (v, step) => Math.round(v / step) * step
const round = (v) => Math.round(v * 1000) / 1000

/**
 * The colliders: `{ boxes: [{ kind, center, size, rotation }], grid }`. Rotation is Euler degrees, used
 * by ramps and wedges only.
 */
export function buildColliders(parts, bounds, { ramps: extraRamps = [] } = {}) {
  const grid = rasterise(parts, bounds)
  const { x0, z0, W, H, floors } = grid
  const boxes = []
  const rectBox = (r, y0, y1, kind) => boxes.push({
    kind,
    center: [round(x0 + (r.gx + r.w / 2) * RES), round((y0 + y1) / 2), round(z0 + (r.gz + r.h / 2) * RES)],
    size: [round(r.w * RES), round(y1 - y0), round(r.h * RES)],
    rotation: [0, 0, 0],
  })

  // Ramps first: what lies under them is cut to fit.
  const ramps = stairRamps(grid)
  // Over any part of the cell, and down to a little below the floor: at the foot of a flight the ramp runs
  // out level with the floor, and the first riser there must not stand as a wall across it.
  const rampTop = (cell, y) => {
    const gx = cell % W, gz = (cell - gx) / W
    let best = null
    for (const [fx, fz] of [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]]) {
      const x = x0 + (gx + fx) * RES, z = z0 + (gz + fz) * RES
      for (const r of ramps) {
        const t = topAt(r, x, z)
        if (t !== null && t >= y - 0.3 && (best === null || t < best)) best = t
      }
    }
    return best
  }

  // Every floor layer a cell can have; most have one, under the gallery two, under a stair three.
  const maxLayers = Math.max(...floors.map(f => f.length))
  const columns = floors.map((list, cell) => list.map((f, i) => columnOver(grid, cell, i, rampTop(cell, f.y))))
  for (let layer = 0; layer < maxLayers; layer++) {
    // Floors: tiles within FLOOR_TOL of each other are one box, its top at the highest of them.
    for (const r of cover(grid, cell => {
      const f = floors[cell][layer]
      return f ? [f.y] : null
    }, [FLOOR_TOL])) {
      rectBox(r, r.hi[0] - FLOOR_THICK, r.hi[0], 'floor')
    }
    // Walls: bases within WALL_BASE_TOL, tops within WALL_TOP_TOL; from the lowest base to the highest top,
    // but never above the lowest lid (the floor or ceiling over a column) — a wall standing up through the
    // gallery over it would block its walkway. The last value keeps see-through walls (pillars) and solid
    // ones apart. Pockets filled, pillars and solid clumps as one box each, diagonals as one turned box
    // each, and the rest rectangles.
    const walls = new Array(W * H)
    for (let cell = 0; cell < W * H; cell++) {
      const c = columns[cell][layer]
      walls[cell] = c && c.wall !== null ? [c.h, c.wall, c.lid, grid.seeThrough[cell] === 1 ? 1 : 0] : null
    }
    fillEnclosed(grid, walls)
    const clumps = compactClumps(grid, walls)
    const { rects, lines } = chainSlivers(grid, cover(grid, cell => walls[cell], [WALL_BASE_TOL, WALL_TOP_TOL, Infinity, 0]))
    for (const r of rects) {
      rectBox(r, r.lo[0], Math.min(r.hi[1], r.lo[2]), 'wall')
      if (r.lo[3] === 1) boxes[boxes.length - 1].seeThrough = true
    }
    for (const c of [...clumps, ...lines]) {
      const y0 = c.lo[0], y1 = Math.min(c.hi[1], c.lo[2])
      boxes.push({
        kind: 'wall',
        center: [round(c.center[0]), round((y0 + y1) / 2), round(c.center[1])],
        size: [round(c.size[0]), round(y1 - y0), round(c.size[1])],
        rotation: [0, round(c.yaw), 0],
        ...(c.lo[3] === 1 ? { seeThrough: true } : {}),
      })
    }
    // Ceilings, for the camera boom: only the low ones it could reach (under 5 m). The slab's underside is
    // the lowest ceiling over it, but never closer than CEILING_HEADROOM over the highest floor under it.
    for (const r of cover(grid, cell => {
      const c = columns[cell][layer]
      return c && c.ceiling !== null && c.wall === null && c.ceiling - c.h < 5 ? [c.ceiling, c.h] : null
    }, [CEILING_TOL, WALL_BASE_TOL])) {
      const y = Math.min(r.hi[0], Math.max(r.lo[0], r.hi[1] + CEILING_HEADROOM))
      rectBox(r, y, r.hi[0] + FLOOR_THICK, 'ceiling')
    }
  }

  boxes.push(...ramps)
  boxes.push(...stepWedges(grid))
  for (const r of extraRamps) boxes.push(rampBox(r.from, r.to, r.width, 'ramp'))
  return { boxes, grid }
}

// ---------------------------------------------------------------------------------------------------
// Ramps and wedges
// ---------------------------------------------------------------------------------------------------

/**
 * A box whose top face runs from `from` to `to` (both [x, y, z] on its centre line), `width` across,
 * FLOOR_THICK deep. Pitch tilts it about its own X, yaw turns it toward the run.
 */
export function rampBox(from, to, width, kind = 'ramp') {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]
  const run = Math.hypot(dx, dz)
  const length = Math.hypot(run, dy)
  const yaw = Math.atan2(dx, dz) * 180 / Math.PI
  const pitch = -Math.atan2(dy, run) * 180 / Math.PI
  // The top face's centre is the midpoint; the box's centre is half a thickness under it, along its normal
  // (local +Y after Ry(yaw)·Rx(pitch): [sin(pitch)·x̂, cos(pitch), sin(pitch)·ẑ] of the run's direction).
  const sp = Math.sin(pitch * Math.PI / 180), cp = Math.cos(pitch * Math.PI / 180)
  const normal = [sp * dx / (run || 1), cp, sp * dz / (run || 1)]
  const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2]
  return {
    kind,
    center: mid.map((v, a) => round(v - normal[a] * FLOOR_THICK / 2)),
    size: [round(width), FLOOR_THICK, round(length)],
    rotation: [round(pitch), round(yaw), 0],
  }
}

/**
 * One ramp per straight flight of the Stairs part. Each stair cell is classed by which way its treads climb
 * (+X, -X, +Z, -Z, or flat for a landing), measured over ±0.8 m so a single riser does not decide it; the
 * connected cells of one class are a flight. The flight's ramp is raised to the UPPER envelope of its
 * treads, so it rests on the nosings and no tread pokes through it, and runs a little past each end.
 */
function stairRamps(grid) {
  const { x0, z0, W, H, floors } = grid
  const stairY = (gx, gz) => {
    if (gx < 0 || gz < 0 || gx >= W || gz >= H) return null
    const f = floors[gz * W + gx].findLast(e => e.stairs)
    return f ? f.y : null
  }
  const cls = new Int8Array(W * H).fill(-1)   // -1 none, 0 flat, 1 +x, 2 -x, 3 +z, 4 -z
  // Over ±0.8 m: wider than a tread, so the window always straddles a riser.
  const nearest = (gx, gz, y, ox, oz) => {
    for (let d = 4; d >= 1; d--) {
      const v = stairY(gx + ox * d, gz + oz * d)
      if (v !== null && Math.abs(v - y) < 1.2) return { v, d }
    }
    return null
  }
  for (let gz = 0; gz < H; gz++) for (let gx = 0; gx < W; gx++) {
    const y = stairY(gx, gz)
    if (y === null) continue
    const slope = (ox, oz) => {
      const p = nearest(gx, gz, y, ox, oz), m = nearest(gx, gz, y, -ox, -oz)
      if (!p || !m) return 0
      return (p.v - m.v) / ((p.d + m.d) * RES)
    }
    const sx = slope(1, 0), sz = slope(0, 1)
    if (Math.max(Math.abs(sx), Math.abs(sz)) < 0.2) cls[gz * W + gx] = 0
    else if (Math.abs(sx) >= Math.abs(sz)) cls[gz * W + gx] = sx > 0 ? 1 : 2
    else cls[gz * W + gx] = sz > 0 ? 3 : 4
  }
  const out = []
  const seen = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) {
    if (cls[i] <= 0 || seen[i]) continue
    const c = cls[i]
    const cells = []
    const stack = [i]
    seen[i] = 1
    while (stack.length) {
      const k = stack.pop()
      cells.push(k)
      const gx = k % W, gz = (k - gx) / W
      // Two cells as well as one: a tread's bevelled nosing leaves a row with no up face between treads.
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
        const nx = gx + ox, nz = gz + oz
        if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue
        const j = nz * W + nx
        if (seen[j] || cls[j] !== c) continue
        // This dungeon's risers are 0.5 m (0.6 m treads, a 40° flight).
        if (Math.abs(stairY(nx, nz) - stairY(gx, gz)) > 0.6) continue
        seen[j] = 1
        stack.push(j)
      }
    }
    if (cells.length < 12) continue
    const alongX = c <= 2
    const pts = cells.map(k => {
      const gx = k % W, gz = (k - gx) / W
      return { s: alongX ? x0 + (gx + 0.5) * RES : z0 + (gz + 0.5) * RES, t: alongX ? z0 + (gz + 0.5) * RES : x0 + (gx + 0.5) * RES, y: stairY(gx, gz) }
    })
    // Slope by least squares along the run, then the offset of the upper envelope.
    const n = pts.length
    const ms = pts.reduce((a, p) => a + p.s, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n
    let num = 0, den = 0
    for (const p of pts) { num += (p.s - ms) * (p.y - my); den += (p.s - ms) ** 2 }
    if (den < 1e-9) continue
    const slope = num / den
    let off = -Infinity
    for (const p of pts) off = Math.max(off, p.y - slope * p.s)
    const smin = Math.min(...pts.map(p => p.s)) - RES / 2, smax = Math.max(...pts.map(p => p.s)) + RES / 2
    const tmin = Math.min(...pts.map(p => p.t)) - RES / 2, tmax = Math.max(...pts.map(p => p.t)) + RES / 2
    const tm = (tmin + tmax) / 2
    const at = (sv) => alongX ? [sv, slope * sv + off, tm] : [tm, slope * sv + off, sv]
    // A line on the nosings meets the first tread at its riser's TOP, a riser above the landing it rises
    // from, and the last at the landing it climbs to. So the ramp runs from where the line comes down to
    // the landing below to where it reaches the landing above (each found just past that end of the flight,
    // within a riser or two), and a little on under the lower landing so its edge is buried.
    const ys = pts.map(p => p.y)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const landing = (from, dir, accept) => {
      for (let d = 0.1; d <= 1.0; d += RES / 2) {
        const sv = from + dir * d
        const [x, z] = alongX ? [sv, tm] : [tm, sv]
        const gx = Math.floor((x - x0) / RES), gz = Math.floor((z - z0) / RES)
        if (gx < 0 || gz < 0 || gx >= W || gz >= H) continue
        const f = floors[gz * W + gx].filter(e => !e.stairs && accept(e.y)).map(e => e.y)
        if (f.length) return f
      }
      return null
    }
    const lowEnd = slope > 0 ? smin : smax, highEnd = slope > 0 ? smax : smin
    const down = Math.sign(lowEnd - highEnd)
    const below = landing(lowEnd, down, y => y < minY - 0.02 && y > minY - 0.9)
    const above = landing(highEnd, -down, y => y > maxY - 0.02 && y < maxY + 0.9)
    const lowY = below ? Math.max(...below) : minY
    const highY = above ? Math.min(...above) : maxY
    const sOf = (y) => (y - off) / slope
    const box = rampBox(at(sOf(lowY) + down * 0.15), at(sOf(highY)), tmax - tmin, 'ramp')
    box.flight = { cells: n, slopeDeg: round(Math.atan(Math.abs(slope)) * 180 / Math.PI) }
    out.push(box)
  }
  return out
}

/**
 * A 30° wedge over every step edge between two floor cells that differ by MIN_WEDGE_STEP .. `maxStep`, on
 * the lower side, top flush with the upper floor at the edge. Edges along one row are merged first. Stairs
 * are skipped: their ramp already covers them.
 */
export function stepWedges(grid, { maxStep = MAX_WEDGE_STEP } = {}) {
  const { x0, z0, W, H, floors } = grid
  const out = []
  // dir: 0 = +X neighbour, 1 = +Z neighbour.
  for (const dir of [0, 1]) {
    const runs = new Map()   // key -> list of [along, lowY, highY, lowerIsNeighbour, line]
    for (let gz = 0; gz < H - (dir ? 1 : 0); gz++) for (let gx = 0; gx < W - (dir ? 0 : 1); gx++) {
      const i = gz * W + gx, j = dir ? i + W : i + 1
      for (const f of floors[i]) {
        if (f.stairs) continue
        const g = floors[j].find(e => !e.stairs && Math.abs(e.y - f.y) > MIN_WEDGE_STEP && Math.abs(e.y - f.y) <= maxStep)
        if (!g) continue
        // Skip it if the neighbour also has a floor at f's height: that edge is the boundary of a lip, not a step.
        if (floors[j].some(e => Math.abs(e.y - f.y) <= 0.03) || floors[i].some(e => Math.abs(e.y - g.y) <= 0.03)) continue
        const low = Math.min(f.y, g.y), high = Math.max(f.y, g.y)
        const lowerIsNeighbour = g.y < f.y
        const line = dir ? gz : gx
        const along = dir ? gx : gz
        const key = `${line}|${q(low, 0.05).toFixed(2)}|${q(high, 0.05).toFixed(2)}|${lowerIsNeighbour}`
        if (!runs.has(key)) runs.set(key, [])
        runs.get(key).push(along)
      }
    }
    for (const [key, list] of runs) {
      const [lineS, lowS, highS, lowerS] = key.split('|')
      const line = parseInt(lineS), low = parseFloat(lowS), high = parseFloat(highS), lowerIsNeighbour = lowerS === 'true'
      list.sort((a, b) => a - b)
      let start = list[0], prev = list[0]
      const flush = (a0, a1) => {
        // The edge between cell `line` and `line + 1` along the step direction.
        const edge = (dir ? z0 : x0) + (line + 1) * RES
        const length = (high - low) / WEDGE_SLOPE
        const sign = lowerIsNeighbour ? 1 : -1                 // which way "down the wedge" points
        const across0 = (dir ? x0 : z0) + a0 * RES, across1 = (dir ? x0 : z0) + (a1 + 1) * RES
        const mid = (across0 + across1) / 2
        const top = dir ? [mid, high, edge] : [edge, high, mid]
        const foot = dir ? [mid, low, edge + sign * length] : [edge + sign * length, low, mid]
        out.push(rampBox(foot, top, across1 - across0, 'wedge'))
      }
      for (let k = 1; k < list.length; k++) {
        if (list[k] === prev + 1) { prev = list[k]; continue }
        flush(start, prev)
        start = prev = list[k]
      }
      flush(start, prev)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------

/** World matrix (rotation part) of a box's Euler degrees, as the engine applies them (Rz·Ry·Rx). */
function rotationOf(deg) {
  const [px, py, pz] = deg.map(d => d * Math.PI / 180)
  const cx = Math.cos(px), sx = Math.sin(px), cy = Math.cos(py), sy = Math.sin(py), cz = Math.cos(pz), sz = Math.sin(pz)
  // R = Rz * Ry * Rx, column vectors.
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ]
}

/** `p` in a box's own frame. */
function toLocal(box, p) {
  const R = box._r ??= rotationOf(box.rotation)
  const d = [p[0] - box.center[0], p[1] - box.center[1], p[2] - box.center[2]]
  // Rᵀ d
  return [R[0][0] * d[0] + R[1][0] * d[1] + R[2][0] * d[2], R[0][1] * d[0] + R[1][1] * d[1] + R[2][1] * d[2], R[0][2] * d[0] + R[1][2] * d[1] + R[2][2] * d[2]]
}

/** The top of the walkable box under (x, z) nearest to `y` (within +0.6 / -1.2 m), or null. */
export function groundAt(boxes, x, y, z) {
  let best = null
  for (const box of boxes) {
    if (box.kind === 'wall' || box.kind === 'ceiling') continue
    const reach = Math.max(box.size[0], box.size[2], box.size[1]) / 2 + 0.5
    if (Math.abs(box.center[0] - x) > reach || Math.abs(box.center[2] - z) > reach) continue
    // Cast down through the box: the top face is local y = +size/2. Solve in the box frame.
    const top = topAt(box, x, z)
    if (top === null) continue
    if (top > y + 0.6 || top < y - 1.2) continue
    if (best === null || Math.abs(top - y) < Math.abs(best - y)) best = top
  }
  return best
}

/** Height of a box's top face over (x, z), or null when (x, z) is outside it. */
export function topAt(box, x, z) {
  // The top face's plane through local (0, hy, 0) with local up as normal, intersected with a vertical line.
  const R = box._r ??= rotationOf(box.rotation)
  const up = [R[0][1], R[1][1], R[2][1]]
  if (up[1] < 0.3) return null
  const hy = box.size[1] / 2
  const c = [box.center[0] + up[0] * hy, box.center[1] + up[1] * hy, box.center[2] + up[2] * hy]
  const y = c[1] - (up[0] * (x - c[0]) + up[2] * (z - c[2])) / up[1]
  const l = toLocal(box, [x, y, z])
  if (Math.abs(l[0]) > box.size[0] / 2 + 1e-3 || Math.abs(l[2]) > box.size[2] / 2 + 1e-3) return null
  return y
}

/** Whether a vertical capsule of `radius` standing at (x, y, z) overlaps any wall box between `from` and `to` above y. */
export function blockedAt(boxes, x, y, z, { radius = 0.3, from = 0.45, to = 1.6 } = {}) {
  for (const box of boxes) {
    if (box.kind !== 'wall') continue
    const hx = box.size[0] / 2 + radius, hz = box.size[2] / 2 + radius
    // Walls turn about Y only (compactClumps): test in the box's own frame, Ry(-yaw).
    let lx = x - box.center[0], lz = z - box.center[2]
    if (box.rotation[1]) {
      const a = box.rotation[1] * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
      ;[lx, lz] = [c * lx - s * lz, s * lx + c * lz]
    }
    if (Math.abs(lx) > hx || Math.abs(lz) > hz) continue
    const bottom = box.center[1] - box.size[1] / 2, top = box.center[1] + box.size[1] / 2
    if (top <= y + from || bottom >= y + to) continue
    return box
  }
  return null
}

/**
 * Walk `route` (a list of [x, z] or [x, z, y] points; y when a level must be named) in 0.25 m steps,
 * following the ground. Returns the problems found, as `{ at, why }`; empty means walkable.
 */
export function checkRoute(boxes, route, { start }) {
  const problems = []
  let y = start
  for (let i = 0; i < route.length - 1; i++) {
    const [ax, az] = route[i], [bx, bz] = route[i + 1]
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.25))
    for (let k = 0; k <= n; k++) {
      const x = ax + (bx - ax) * k / n, z = az + (bz - az) * k / n
      const g = groundAt(boxes, x, y, z)
      if (g === null) { problems.push({ at: [round(x), round(y), round(z)], why: 'no ground' }); continue }
      if (g > y + 0.37) problems.push({ at: [round(x), round(g), round(z)], why: `climb ${round(g - y)} m` })
      y = g
      const wall = blockedAt(boxes, x, y, z)
      if (wall) problems.push({ at: [round(x), round(y), round(z)], why: `wall at ${wall.center.join(',')}` })
    }
  }
  return problems
}

/** Boxes bucketed by `size`-metre XZ cells over their (rotation-safe) footprint, for local queries. */
export function boxIndex(boxes, size = 2) {
  const map = new Map()
  for (const box of boxes) {
    const r = Math.hypot(box.size[0], box.size[1], box.size[2]) / 2
    const reachX = box.rotation.some(v => v) ? r : box.size[0] / 2, reachZ = box.rotation.some(v => v) ? r : box.size[2] / 2
    for (let cz = Math.floor((box.center[2] - reachZ) / size); cz <= Math.floor((box.center[2] + reachZ) / size); cz++)
      for (let cx = Math.floor((box.center[0] - reachX) / size); cx <= Math.floor((box.center[0] + reachX) / size); cx++) {
        const key = cx * 100003 + cz
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(box)
      }
  }
  return { near: (x, z) => map.get(Math.floor(x / size) * 100003 + Math.floor(z / size)) ?? [] }
}

/**
 * Everywhere a capsule (radius 0.3) can walk to from `from` = [x, y, z], over a `res` grid: the walkable
 * surfaces are box tops, a step between neighbours is at most `climb`, and a cell is open when nothing
 * solid stands in the capsule's column over it. Returns `{ reaches([x, y, z]) -> boolean, cells }`.
 * Drops are not followed (they are one-way), so what it reaches is reachable AND returnable.
 */
export function reachability(boxes, from, { res = 0.25, climb = 0.37, radius = 0.3 } = {}) {
  const index = boxIndex(boxes)
  const heightsAt = (x, z) => {
    const out = []
    for (const box of index.near(x, z)) {
      if (box.kind === 'wall' || box.kind === 'ceiling') continue
      const t = topAt(box, x, z)
      if (t !== null && !out.some(y => Math.abs(y - t) < 0.06)) out.push(t)
    }
    return out
  }
  const open = (x, y, z) => !blockedAt(index.near(x, z), x, y, z, { radius })
  const key = (gx, gz, y) => `${gx},${gz},${Math.round(y * 10)}`
  const seen = new Map()
  const start = [Math.round(from[0] / res), Math.round(from[2] / res)]
  const y0 = heightsAt(start[0] * res, start[1] * res).sort((a, b) => Math.abs(a - from[1]) - Math.abs(b - from[1]))[0]
  if (y0 === undefined) return { reaches: () => false, cells: seen }
  const queue = [[start[0], start[1], y0]]
  seen.set(key(start[0], start[1], y0), y0)
  while (queue.length) {
    const [gx, gz, y] = queue.pop()
    for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
      if (!ox && !oz) continue
      const nx = gx + ox, nz = gz + oz
      for (const ny of heightsAt(nx * res, nz * res)) {
        if (Math.abs(ny - y) > climb) continue
        const k = key(nx, nz, ny)
        if (seen.has(k)) continue
        if (!open(nx * res, ny, nz * res)) continue
        seen.set(k, ny)
        queue.push([nx, nz, ny])
      }
    }
  }
  const reaches = ([x, y, z]) => {
    const gx = Math.round(x / res), gz = Math.round(z / res)
    for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++)
      for (const h of heightsAt((gx + ox) * res, (gz + oz) * res))
        if (Math.abs(h - y) < 0.6 && seen.has(key(gx + ox, gz + oz, h))) return true
    return false
  }
  return { reaches, cells: seen, res }
}

/**
 * The walkable surface `reachability` found, as a triangle soup for the navmesh baker: one quad per cell,
 * its corners at the average height of the cells round them that a capsule steps between, so neighbours
 * share vertices (the baker welds them) and ramps and steps come out as one continuous sheet per level.
 *
 * Baking from the colliders instead carves every wall box, pillar and prop out of every floor box, which
 * here shatters the floor into a third of a million slivers. This is the same walkable area, already clear
 * of everything solid by a capsule's radius, at a fixed resolution: no carving left to do.
 */
export function walkableSoup(reach, { climb = 0.37 } = {}) {
  const { cells, res } = reach
  const byCell = new Map()
  for (const [key, y] of cells) {
    const xz = key.slice(0, key.lastIndexOf(','))
    if (!byCell.has(xz)) byCell.set(xz, [])
    byCell.get(xz).push(y)
  }
  const positions = [], indices = []
  const vertices = new Map()
  // A corner in doubled cell units (odd numbers), so the four cells round it are at (c ± 1) / 2.
  const corner = (cx, cz, y) => {
    let sum = 0, n = 0
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
      for (const h of byCell.get(`${(cx + ox) / 2},${(cz + oz) / 2}`) ?? []) if (Math.abs(h - y) <= climb) { sum += h; n++ }
    const cy = n ? sum / n : y
    const key = `${cx},${cz},${Math.round(cy * 100)}`
    let i = vertices.get(key)
    if (i === undefined) {
      i = positions.length / 3
      positions.push(cx * res / 2, cy, cz * res / 2)
      vertices.set(key, i)
    }
    return i
  }
  for (const [key, y] of cells) {
    const [gx, gz] = key.split(',').map(Number)
    const a = corner(2 * gx - 1, 2 * gz - 1, y), b = corner(2 * gx + 1, 2 * gz - 1, y)
    const c = corner(2 * gx + 1, 2 * gz + 1, y), d = corner(2 * gx - 1, 2 * gz + 1, y)
    // Counter-clockwise seen from above: the normal is +Y.
    indices.push(a, d, c, a, c, b)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

/** Boxes grouped into `cell`-metre XZ chunks by centre: [{ key, boxes }]. */
export function chunkBoxes(boxes, cell = 10) {
  const map = new Map()
  for (const b of boxes) {
    const key = `${Math.floor(b.center[0] / cell)},${Math.floor(b.center[2] / cell)}`
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(b)
  }
  return [...map.entries()].map(([key, list]) => ({ key, boxes: list }))
}
