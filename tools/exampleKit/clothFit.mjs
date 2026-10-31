// Cloth parts of a skinned character (AnimatedModel.skinnedCloth), worked out from its mesh: which
// pieces of a cloth material hang free, how free each vertex is, and capsules fitted to the armour or
// body under them for the cloth to collide with. Pure: plain arrays in, plain JSON out.
//
// The rules, from what the knight showed:
//   - A piece of cloth lying ON the armour (sandwiched between plates) must not move at all: simulated,
//     it sags straight through the metal. Such a piece is mostly within ANCHOR of another material.
//   - A piece hangs from where it is ATTACHED, not from its top: a strap sewn to a belt at one end swings
//     from that end. Its weight grows with the distance from the nearest attached vertex.
//   - Ragdoll capsules are a body's limbs, thinner than its armour: the cloth collides with capsules
//     fitted to the character's own other materials instead, one per bone.

import { vec3 } from 'gl-matrix'

/** Metres: a cloth vertex this close to another material is sewn to it. */
export const ANCHOR = 0.008
/** A piece this much attached is lying on the armour: not simulated. */
const ON_ARMOUR = 0.8
/** With no contact at all, the top of the piece (its waistband) is what it hangs from. */
const TOP_BAND = 0.12
/**
 * Metres: a piece this small across (a tie, a tassel, a loop on a bracer) dangles from whatever it is
 * nearest — wherever it is on the body. Modelled hanging in the bind pose, it sticks out sideways the
 * moment the arm it is on drops; simulated, it falls.
 */
export const DANGLE_SIZE = 0.12
/** A dangling piece with no contact is held by its vertices within this of its nearest approach. */
const NEAREST_BAND = 0.006
/** A hanging piece's contacts count as attachments only in its top share this big (see pieceWeights). */
const HANG_CONTACT = 0.35
/** More of a hanging piece than this held, and only its top band holds it. */
const HANG_MAX_HELD = 0.3
/** Fitted capsules: the radius is this percentile of the radial spread, less SHRINK metres. */
const RADIUS_PERCENTILE = 0.85
const SHRINK = 0.003
/** Metres a fitted capsule stays inside the cloth's rest shape; a capsule thinner than MIN_COLLIDER is dropped. */
const CLEARANCE = 0.01
const MIN_COLLIDER = 0.03

/** Pieces of the triangles `[start, start + count)`: vertex sets, welded by position (a UV seam must not split one). */
export function pieces(positions, indices, start, count, weld = 1e-4) {
  const key = (v) => `${Math.round(positions[v * 3] / weld)},${Math.round(positions[v * 3 + 1] / weld)},${Math.round(positions[v * 3 + 2] / weld)}`
  const parent = new Map()
  const canon = new Map()
  const at = (v) => { const k = key(v); if (!canon.has(k)) canon.set(k, v); return canon.get(k) }
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
  for (let t = start; t < start + count; t++) { const v = at(indices[t]); if (!parent.has(v)) parent.set(v, v) }
  for (let t = start; t + 2 < start + count; t += 3) {
    const a = find(at(indices[t])), b = find(at(indices[t + 1])), c = find(at(indices[t + 2]))
    parent.set(b, a); parent.set(find(c), a)
  }
  const out = new Map()
  for (let t = start; t < start + count; t++) {
    const v = indices[t], root = find(at(v))
    if (!out.has(root)) out.set(root, new Set())
    out.get(root).add(v)
  }
  return [...out.values()].map(s => [...s])
}

/** A point set's nearest-distance query on a hash grid of `cell` metres. */
export function pointIndex(points, cell = 0.02) {
  const grid = new Map()
  const k = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
  for (let i = 0; i < points.length; i += 3) {
    const key = k(points[i], points[i + 1], points[i + 2])
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key).push(points[i], points[i + 1], points[i + 2])
  }
  /** Distance to the nearest point, or Infinity beyond `reach` (one ring of cells). */
  return (x, y, z) => {
    let best = Infinity
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`)
      if (list) for (let i = 0; i < list.length; i += 3) best = Math.min(best, Math.hypot(list[i] - x, list[i + 1] - y, list[i + 2] - z))
    }
    return best
  }
}

/**
 * How free each vertex of a piece is, 0..1: 0 where it is attached, rising to 1 at the point farthest
 * from any attachment. `anchored(v)` says which vertices are attached; `fallback`, the anchors to use when
 * none are (a dangling piece's nearest approach). Null when the piece is mostly
 * attached (it lies on the armour) — leave it skinned.
 */
export function pieceWeights(positions, verts, anchored, fallback = null, { hangs = false } = {}) {
  let anchors = verts.filter(anchored)
  // Only a small piece can be "lying on the armour" (a patch, a stitch). A hanging one — a skirt, the loops
  // round a belt — hangs from its top however closely it was modelled over the plates; the backstop keeps
  // it from sinking into them.
  if (!hangs && anchors.length >= verts.length * ON_ARMOUR) return null
  let top = -Infinity, bottom = Infinity
  for (const v of verts) { top = Math.max(top, positions[v * 3 + 1]); bottom = Math.min(bottom, positions[v * 3 + 1]) }
  const band = top - (top - bottom) * TOP_BAND
  if (hangs) {
    // A skirt hangs from its waist: it is sewn along its top band, and where it touches something in its
    // upper part. Contact lower down (a hem brushing a thigh plate) holds nothing — the backstop keeps it
    // off the plate — or the skirt would hang from its sides and swing like a hinged hoop.
    const upper = top - (top - bottom) * HANG_CONTACT
    anchors = verts.filter(v => positions[v * 3 + 1] >= band || (positions[v * 3 + 1] >= upper && anchored(v)))
    // A piece in contact almost everywhere (loops wrapped over the belt plates) is held by its top band
    // alone, or it would be held everywhere and never fall.
    if (anchors.length > verts.length * HANG_MAX_HELD) anchors = verts.filter(v => positions[v * 3 + 1] >= band)
  }
  if (anchors.length === 0 && fallback?.length) anchors = fallback
  if (anchors.length === 0) anchors = verts.filter(v => positions[v * 3 + 1] >= band)
  const anchorPoints = []
  for (const v of anchors) anchorPoints.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2])
  // Brute force: pieces are hundreds of vertices, anchors a fraction of them.
  const dist = verts.map(v => {
    let best = Infinity
    for (let i = 0; i < anchorPoints.length; i += 3)
      best = Math.min(best, Math.hypot(positions[v * 3] - anchorPoints[i], positions[v * 3 + 1] - anchorPoints[i + 1], positions[v * 3 + 2] - anchorPoints[i + 2]))
    return best
  })
  const far = Math.max(...dist)
  if (!(far > 1e-6)) return null
  return dist.map(d => {
    const t = Math.min(1, d / far)
    return Math.round(t * t * (3 - 2 * t) * 1000) / 1000
  })
}

/** The principal axis of a point cloud (power iteration on its covariance), and its centroid. */
export function principalAxis(points) {
  const n = points.length / 3
  const c = [0, 0, 0]
  for (let i = 0; i < points.length; i += 3) { c[0] += points[i]; c[1] += points[i + 1]; c[2] += points[i + 2] }
  c[0] /= n; c[1] /= n; c[2] /= n
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < points.length; i += 3) {
    const d = [points[i] - c[0], points[i + 1] - c[1], points[i + 2] - c[2]]
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) m[r * 3 + k] += d[r] * d[k]
  }
  let v = [0.3, 1, 0.2]
  for (let it = 0; it < 64; it++) {
    const w = [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
    const l = Math.hypot(w[0], w[1], w[2]) || 1
    v = [w[0] / l, w[1] / l, w[2] / l]
  }
  return { center: c, axis: v }
}

/**
 * A capsule around `points` (flat xyz), along their principal axis: the segment trimmed to where the points
 * project, the radius their RADIUS_PERCENTILE radial distance from it less SHRINK. Null with too few.
 */
export function fitCapsule(points) {
  const n = points.length / 3
  if (n < 8) return null
  const { center: a, axis } = principalAxis(points)
  const ax = vec3.fromValues(axis[0], axis[1], axis[2])
  let t0 = Infinity, t1 = -Infinity
  const radial = []
  for (let i = 0; i < points.length; i += 3) {
    const dx = points[i] - a[0], dy = points[i + 1] - a[1], dz = points[i + 2] - a[2]
    const t = dx * ax[0] + dy * ax[1] + dz * ax[2]
    t0 = Math.min(t0, t); t1 = Math.max(t1, t)
    const rx = dx - ax[0] * t, ry = dy - ax[1] * t, rz = dz - ax[2] * t
    radial.push(Math.hypot(rx, ry, rz))
  }
  radial.sort((x, y) => x - y)
  const radius = Math.max(0.005, radial[Math.min(radial.length - 1, Math.floor(radial.length * RADIUS_PERCENTILE))] - SHRINK)
  // The caps add the radius at each end: pull the segment in by it, but never past its middle.
  const mid = (t0 + t1) / 2
  const s0 = Math.min(mid, t0 + radius), s1 = Math.max(mid, t1 - radius)
  const round = (v) => Math.round(v * 1e4) / 1e4
  return {
    a: [round(a[0] + ax[0] * s0), round(a[1] + ax[1] * s0), round(a[2] + ax[2] * s0)],
    b: [round(a[0] + ax[0] * s1), round(a[1] + ax[1] * s1), round(a[2] + ax[2] * s1)],
    radius: round(radius),
  }
}

/** The dominant joint of vertex `v`. */
export function dominantJoint(jointIndices, jointWeights, v) {
  let best = 0
  for (let k = 1; k < 4; k++) if (jointWeights[v * 4 + k] > jointWeights[v * 4 + best]) best = k
  return jointIndices[v * 4 + best]
}

/**
 * The cloth parts of a merged skinned mesh (buildCharacter's `clothOf` arguments).
 *
 * @param clothSubmesh  the cloth material's submesh index
 * @param hangsFrom     RegExp on a bone name: pieces mostly carried by these bones may simulate
 * @param colliderBones RegExp on a bone name: one fitted capsule each, from the OTHER materials
 * @param settings      merged into the result (maxDistance, stiffness, ...)
 * @returns `{ data, report }`; data null when nothing simulates
 */
export function clothParts({ positions, indices, submeshes, jointIndices, jointWeights, skin }, { clothSubmesh, hangsFrom, colliderBones, settings }) {
  const names = new Map(skin.nodeNames)
  const boneName = (j) => names.get(skin.joints[j].nodeIndex) ?? ''
  const sub = submeshes[clothSubmesh]

  // Every vertex of the other materials: what the cloth is sewn to, and what it collides with.
  const otherSet = new Set()
  submeshes.forEach((s, m) => { if (m !== clothSubmesh) for (let t = s.start; t < s.start + s.count; t++) otherSet.add(indices[t]) })
  const other = [...otherSet]
  const otherPoints = []
  for (const v of other) otherPoints.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2])
  const nearOther = pointIndex(otherPoints, ANCHOR * 2)
  // The cloth's own pieces, each vertex tagged with its piece: a tie is sewn to the sleeve beside it, and
  // that is cloth too.
  const all = pieces(positions, indices, sub.start, sub.count)
  const pieceOf = new Map()
  all.forEach((verts, k) => { for (const v of verts) pieceOf.set(v, k) })
  const cg = ANCHOR * 2
  const clothGrid = new Map()
  for (const v of pieceOf.keys()) {
    const key = `${Math.floor(positions[v * 3] / cg)},${Math.floor(positions[v * 3 + 1] / cg)},${Math.floor(positions[v * 3 + 2] / cg)}`
    if (!clothGrid.has(key)) clothGrid.set(key, [])
    clothGrid.get(key).push(v)
  }
  /** Distance from `v` to the nearest cloth vertex of ANOTHER piece (Infinity beyond a cell or so). */
  const nearOtherCloth = (v) => {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2], own = pieceOf.get(v)
    const cx = Math.floor(x / cg), cy = Math.floor(y / cg), cz = Math.floor(z / cg)
    let best = Infinity
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      for (const u of clothGrid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? [])
        if (pieceOf.get(u) !== own) best = Math.min(best, Math.hypot(positions[u * 3] - x, positions[u * 3 + 1] - y, positions[u * 3 + 2] - z))
    return best
  }
  /** How close `v` comes to anything else: another material, or another piece of cloth. */
  const contact = (v) => Math.min(nearOther(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]), nearOtherCloth(v))
  const extent = (verts) => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
    for (const v of verts) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], positions[v * 3 + a]); mx[a] = Math.max(mx[a], positions[v * 3 + a]) }
    return Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2])
  }

  const vertices = [], weights = []
  let kept = 0, onArmour = 0, fitted = 0, dangling = 0
  for (const verts of all) {
    // Big pieces simulate only where they hang from the hips and legs (a sleeve stays on its arm); small
    // ones dangle wherever they are.
    const small = extent(verts) <= DANGLE_SIZE
    const carried = verts.filter(v => hangsFrom.test(boneName(dominantJoint(jointIndices, jointWeights, v)))).length
    if (!small && carried < verts.length * 0.6) { fitted++; continue }
    const near = new Map(verts.map(v => [v, contact(v)]))
    // A dangling piece touching nothing hangs from its nearest approach to the body.
    let fallback = null
    if (small) {
      const closest = Math.min(...near.values())
      if (Number.isFinite(closest)) fallback = verts.filter(v => near.get(v) <= closest + NEAREST_BAND)
    }
    const w = pieceWeights(positions, verts, v => near.get(v) <= ANCHOR, fallback, { hangs: !small })
    if (!w) { onArmour++; continue }
    if (small && carried < verts.length * 0.6) dangling++
    // No per-vertex backstops: neighbours with different ones pulled the cloth into spikes. One uniform
    // backstop (the settings') holds it off the armour.
    verts.forEach((v, i) => { vertices.push(v); weights.push(w[i]) })
    kept++
  }

  // One capsule per collider bone, around that bone's share of the other materials.
  const colliders = []
  skin.joints.forEach((_, j) => {
    if (!colliderBones.test(boneName(j))) return
    const pts = []
    for (const v of other) if (dominantJoint(jointIndices, jointWeights, v) === j) pts.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2])
    const c = fitCapsule(pts)
    if (!c) return
    // Never past the cloth's own rest shape: a capsule that swallows the skirt at rest would shove it out
    // every frame. One axis per bone fits a limb's plates well and a pelvis's flared fauld badly — there
    // the backstop does the work, and the capsule is cut down to what lies inside the cloth.
    const ax = c.b[0] - c.a[0], ay = c.b[1] - c.a[1], az = c.b[2] - c.a[2]
    const len2 = ax * ax + ay * ay + az * az
    let inner = Infinity
    for (const v of vertices) {
      const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2]
      const t = Math.min(1, Math.max(0, len2 > 1e-12 ? ((x - c.a[0]) * ax + (y - c.a[1]) * ay + (z - c.a[2]) * az) / len2 : 0))
      inner = Math.min(inner, Math.hypot(x - c.a[0] - ax * t, y - c.a[1] - ay * t, z - c.a[2] - az * t))
    }
    const radius = Math.round(Math.min(c.radius, inner - CLEARANCE) * 1e4) / 1e4
    if (radius >= MIN_COLLIDER) colliders.push({ joint: j, ...c, radius })
  })

  // How much of the simulated cloth RESTS inside a capsule: what the solver would push out every frame.
  let inside = 0
  for (const v of vertices) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2]
    for (const c of colliders) {
      const ax = c.b[0] - c.a[0], ay = c.b[1] - c.a[1], az = c.b[2] - c.a[2]
      const len2 = ax * ax + ay * ay + az * az
      const t = Math.min(1, Math.max(0, len2 > 1e-12 ? ((x - c.a[0]) * ax + (y - c.a[1]) * ay + (z - c.a[2]) * az) / len2 : 0))
      if (Math.hypot(x - c.a[0] - ax * t, y - c.a[1] - ay * t, z - c.a[2] - az * t) < c.radius) { inside++; break }
    }
  }
  const report = `cloth: ${kept} pieces simulated (${dangling} of them small dangling ties; ${vertices.length} vertices, ${inside} resting inside a capsule), `
    + `${onArmour} lying on armour and ${fitted} fitted to a limb left skinned, ${colliders.length} armour capsules`
  if (!vertices.length) return { data: null, report }
  return { data: { vertices, weights, ...settings, colliders }, report }
}
