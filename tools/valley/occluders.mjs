// Occluder volumes fitted INSIDE walls, for the renderer's CPU occlusion culling.
//
// An occluder is only safe inside solid geometry: one that pokes out past a wall's end or top hides
// things you can see round it (src/core/scene/nodes/occluderNode.ts). The wall COLLIDER boxes are the
// wrong answer as they stand — they are rasterised onto a grid, so they cover every cell a face touches
// and stand up to a cell proud of the real surface. So each occluder is a thin slab down the middle of
// its wall box, pulled in from the ends and the top, and only as tall as the wall is unbroken: a window
// or a doorway above the base ends it there.
//
// Works on any grid in the shape `dungeon/collision.mjs#rasterise` returns (per-cell steep-face height
// bins), which is also what houses.mjs builds for the hamlet's buildings.

/** Shorter or lower than this and an occluder hides too little to be worth rasterising every frame. */
const MIN_LONG = 2
const MIN_HEIGHT = 2
/** Pulled in from each end and from the top, against the grid's coarseness. */
const END_INSET = 0.2
const TOP_INSET = 0.2
/** Slab thickness. Thin on purpose: down the middle of a wall it is inside it whatever the wall's own. */
const THICKNESS = 0.02
/** The wall's foot is often where the floor meets it; start the unbroken run this far up. */
const FOOT = 0.3

const round = (v) => Math.round(v * 1000) / 1000

/**
 * Fit occluders to `walls` (`[{ center, size }]`, axis-aligned, in the grid's frame). Returns
 * `[{ center, size }]` in the same frame, one per wall that qualifies.
 */
export function fitOccluders(grid, walls) {
  const { x0, z0, W, H, steep, res, y0, bin, bins } = grid
  const out = []
  for (const b of walls) {
    // A turned wall (a diagonal) has no grid-aligned run of cells to measure: none.
    if (b.rotation?.some(v => v)) continue
    const alongX = b.size[0] >= b.size[2]
    const long = alongX ? b.size[0] : b.size[2]
    if (long < MIN_LONG || b.size[1] < MIN_HEIGHT) continue

    // The wall box's cells.
    const gx0 = Math.max(0, Math.round((b.center[0] - b.size[0] / 2 - x0) / res))
    const gx1 = Math.min(W, Math.round((b.center[0] + b.size[0] / 2 - x0) / res))
    const gz0 = Math.max(0, Math.round((b.center[2] - b.size[2] / 2 - z0) / res))
    const gz1 = Math.min(H, Math.round((b.center[2] + b.size[2] / 2 - z0) / res))
    if (gx1 <= gx0 || gz1 <= gz0) continue

    // Up from the foot, bin by bin, while every slice along the wall has a face at that height somewhere
    // across its thickness. The first slice without one is a window, a doorway or the wall's top.
    const base = b.center[1] - b.size[1] / 2
    const top = b.center[1] + b.size[1] / 2
    const first = Math.max(0, Math.ceil((base + FOOT - y0) / bin))
    const last = Math.min(bins - 1, Math.floor((top - y0) / bin) - 1)
    let solidTo = first - 1
    for (let k = first; k <= last; k++) {
      let every = true
      if (alongX) {
        for (let gx = gx0; gx < gx1 && every; gx++) {
          let any = false
          for (let gz = gz0; gz < gz1 && !any; gz++) any = steep[(gz * W + gx) * bins + k] === 1
          every = any
        }
      } else {
        for (let gz = gz0; gz < gz1 && every; gz++) {
          let any = false
          for (let gx = gx0; gx < gx1 && !any; gx++) any = steep[(gz * W + gx) * bins + k] === 1
          every = any
        }
      }
      if (!every) break
      solidTo = k
    }
    const bottom = y0 + first * bin
    const height = y0 + (solidTo + 1) * bin - TOP_INSET - bottom
    if (height < MIN_HEIGHT) continue

    const length = long - 2 * END_INSET
    out.push({
      center: [round(b.center[0]), round(bottom + height / 2), round(b.center[2])],
      size: alongX ? [round(length), round(height), THICKNESS] : [THICKNESS, round(height), round(length)],
    })
  }
  return out
}
