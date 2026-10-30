import type { FoliageCollision } from 'cleo'

// Fitting a foliage prop's collider to its geometry, in PROTOTYPE units (each instance scales it by its
// own random scale). Works on the rule's baked prototype — `TerrainFoliageRule.models`, one
// `Model.serialize()` payload per sub-mesh with its transforms already in the vertices — so the fit is
// measured in exactly the space the collider is authored in. Pure: no GL, testable headless.
//
// The collider is centred on the instance's origin axis (the physics body sits at the instance position,
// lifted only in Y), so every radius here is measured from that axis, not from the mesh's own centre.

type Point = [number, number, number]

/** Every vertex of a list of serialized models. Reads flat typed arrays and the legacy array-of-triples form. */
export function prototypePoints(models: readonly any[] | null | undefined): Point[] {
  const out: Point[] = []
  for (const m of models ?? []) {
    const p = m?.geometry?.positions
    if (!p) continue
    if (typeof p[0] === 'number') for (let i = 0; i + 2 < p.length; i += 3) out.push([p[i], p[i + 1], p[i + 2]])
    else for (const v of p) if (Array.isArray(v)) out.push([v[0], v[1], v[2]])
  }
  return out
}

/** The value at fraction `q` of a sorted copy of `values` (0 = min, 1 = max). */
function quantile(values: number[], q: number): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]
}

const round = (v: number) => Math.round(v * 1000) / 1000

/** A collider of `shape` around ALL of the geometry: radius to its farthest reach from the axis. */
export function fitColliderToBounds(models: readonly any[] | null | undefined,
                                    shape: FoliageCollision['shape']): FoliageCollision | null {
  const pts = prototypePoints(models)
  if (!pts.length) return null
  let minY = Infinity, maxY = -Infinity, rx = 0, rz = 0, r = 0
  for (const [x, y, z] of pts) {
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    rx = Math.max(rx, Math.abs(x)); rz = Math.max(rz, Math.abs(z)); r = Math.max(r, Math.hypot(x, z))
  }
  const height = Math.max(1e-3, maxY - minY)
  if (shape === 'sphere') {
    const radius = round(Math.max(r, height / 2))
    return { shape, radius, offsetY: round((minY + maxY) / 2) }
  }
  if (shape === 'box') return { shape, width: round(rx), depth: round(rz), height: round(height), offsetY: round((minY + maxY) / 2) }
  return { shape: 'cylinder', radius: round(r), height: round(height), offsetY: round((minY + maxY) / 2) }
}

/** Fraction of the height the trunk is measured over (the bottom slice, below the lowest branches). */
export const TRUNK_SLICE = 0.3
/** How tall a fitted trunk collider is, as a fraction of the plant's height. */
export const TRUNK_HEIGHT = 0.6
/** Share of the slice's vertices the trunk radius covers — a stray low twig does not widen it. */
const TRUNK_PERCENTILE = 0.8

/**
 * A collider around the TRUNK: the radius from the bottom slice of the geometry (80th percentile of the
 * distance from the axis, so one low branch does not fatten it), spanning the lower part of the plant.
 * What a character should bump into — not the canopy it walks under.
 */
export function fitColliderToTrunk(models: readonly any[] | null | undefined,
                                   shape: FoliageCollision['shape']): FoliageCollision | null {
  const pts = prototypePoints(models)
  if (!pts.length) return null
  let minY = Infinity, maxY = -Infinity
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]) }
  const total = Math.max(1e-3, maxY - minY)
  const sliceTop = minY + total * TRUNK_SLICE
  const radial = pts.filter(p => p[1] <= sliceTop).map(p => Math.hypot(p[0], p[2]))
  const radius = Math.max(0.01, quantile(radial, TRUNK_PERCENTILE))
  const height = total * TRUNK_HEIGHT
  if (shape === 'sphere') return { shape, radius: round(radius), offsetY: round(minY + radius) }
  if (shape === 'box') return { shape, width: round(radius), depth: round(radius), height: round(height), offsetY: round(minY + height / 2) }
  return { shape: 'cylinder', radius: round(radius), height: round(height), offsetY: round(minY + height / 2) }
}

/** One line describing a collider, for the rule row: "Cylinder · Ø 0.8 · h 6 · centre +3". */
export function describeCollider(c: FoliageCollision): string {
  const n = (v: number) => (Math.round(v * 100) / 100).toString()
  const r = c.radius ?? 0.5, h = c.height ?? 2
  const centre = c.offsetY ?? (c.shape === 'sphere' ? r : h / 2)
  const centreText = `centre ${c.offsetY === undefined ? 'auto ' : ''}${centre >= 0 ? '+' : ''}${n(centre)}`
  if (c.shape === 'sphere') return `Sphere · Ø ${n(r * 2)} · ${centreText}`
  if (c.shape === 'box')
    return `Box · ${n((c.width ?? r) * 2)} × ${n((c.depth ?? r) * 2)} · h ${n(h)} · ${centreText}`
  return `Cylinder · Ø ${n(r * 2)} · h ${n(h)} · ${centreText}`
}
