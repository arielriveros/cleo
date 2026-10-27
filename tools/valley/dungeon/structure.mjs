// The dungeon's architecture: build/props/medieval_dungeon_structure (1).glb, as parts, render chunks and
// the artist's own light rig. Geometry only -- materials, colliders and placement are the generator's.
//
// The file is one level, about 58 x 15 x 65 m, in 20 named meshes (Walls, Floors, Pillars, Stairs, Arena,
// Throne ...) over 17 materials, and ~1.4 M triangles. It is shipped at full detail. What makes that
// affordable is CHUNKING: a mesh like "Pillars" spans the whole dungeon, so as one model node its bounding
// sphere is always on screen and it is never culled. Cut into ~10 m cells, the renderer's frustum culling
// and GPU occlusion queries can drop every room the camera cannot see.
//
// It also carries 91 KHR_lights_punctual lights, which are the best map of WHERE things go: 55 torch-height
// points a hand's width off the walls (the sconces), braziers round the arena, candles at the crypt, the
// fireplace, window shafts and a moon shaft through the oculus. They are returned as anchors.

import { mat4, quat, vec3 } from 'gl-matrix'
import { localMatrix } from '../../exampleKit/fbxImport.mjs'
import { boundsOf, partsOf, readGltf } from '../meshes.mjs'

/** The structure: parts (each tagged with its glTF material's name), the punctual lights, and the bounds. */
export function loadStructure(file) {
  const doc = readGltf(file)
  const { gltf } = doc
  const materialNames = (gltf.materials ?? []).map((m, i) => m.name ?? `material${i}`)
  const parts = partsOf(doc).map(p => ({ ...p, materialName: materialNames[p.material] }))
  return { parts, lights: punctualLights(gltf), bounds: boundsOf(parts), materialNames }
}

/**
 * Every KHR_lights_punctual light placed in the scene, in world space: `{ index, name, type, color,
 * intensity, range, position, direction, innerCone, outerCone }`. Spots and directionals shine down their
 * node's -Z. The lights are root nodes in this file, but parents are honoured anyway.
 */
export function punctualLights(gltf) {
  const defs = gltf.extensions?.KHR_lights_punctual?.lights ?? []
  const out = []
  const visit = (i, parent) => {
    const n = gltf.nodes[i]
    const m = mat4.multiply(mat4.create(), parent, localMatrix(n))
    const ref = n.extensions?.KHR_lights_punctual?.light
    if (ref !== undefined) {
      const def = defs[ref]
      const position = [m[12], m[13], m[14]]
      const r = mat4.getRotation(quat.create(), m)
      const direction = [...vec3.normalize(vec3.create(), vec3.transformQuat(vec3.create(), [0, 0, -1], r))]
      out.push({
        index: ref, name: n.name ?? `Light_${ref}`, type: def.type, color: def.color ?? [1, 1, 1],
        intensity: def.intensity ?? 1, range: def.range ?? 0, position, direction,
        innerCone: def.spot?.innerConeAngle ?? 0, outerCone: def.spot?.outerConeAngle ?? Math.PI / 4,
      })
    }
    for (const c of n.children ?? []) visit(c, m)
  }
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes
    ?? gltf.nodes.map((_, i) => i).filter(i => !gltf.nodes.some(n => n.children?.includes(i)))
  for (const r of roots) visit(r, mat4.create())
  return out.sort((a, b) => a.index - b.index)
}

/**
 * Cut parts into an XZ grid of `cell`-metre squares by triangle centroid, one chunk per (part, cell).
 * Vertices are re-indexed per chunk, so each chunk carries only what it draws. Chunks under
 * `minTriangles` are folded into their part's nearest larger chunk, so a few stray triangles do not cost
 * a draw call (and a node) of their own.
 */
export function chunkParts(parts, { cell = 10, minTriangles = 64 } = {}) {
  const chunks = []
  for (const part of parts) {
    const P = part.positions, I = part.indices
    const buckets = new Map()
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3
      const cx = Math.floor((P[a] + P[b] + P[c]) / 3 / cell)
      const cz = Math.floor((P[a + 2] + P[b + 2] + P[c + 2]) / 3 / cell)
      const key = `${cx},${cz}`
      if (!buckets.has(key)) buckets.set(key, { cx, cz, tris: [] })
      buckets.get(key).tris.push(k)
    }
    const list = [...buckets.values()]
    const big = list.filter(b => b.tris.length >= minTriangles)
    const keep = big.length ? big : list
    for (const small of list) {
      if (keep.includes(small)) continue
      let best = keep[0]
      for (const b of keep) if (Math.hypot(b.cx - small.cx, b.cz - small.cz) < Math.hypot(best.cx - small.cx, best.cz - small.cz)) best = b
      best.tris.push(...small.tris)
    }
    for (const b of keep) chunks.push({ ...subPart(part, b.tris), name: `${part.name} ${b.cx},${b.cz}`, partName: part.name, cell: [b.cx, b.cz] })
  }
  return chunks
}

/** The triangles starting at `starts` (indices into `part.indices`) as a part of their own. */
function subPart(part, starts) {
  const remap = new Map()
  const positions = [], normals = [], uvs = [], indices = []
  for (const k of starts) for (let j = 0; j < 3; j++) {
    const v = part.indices[k + j]
    let n = remap.get(v)
    if (n === undefined) {
      n = remap.size
      remap.set(v, n)
      positions.push(part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2])
      normals.push(part.normals[v * 3], part.normals[v * 3 + 1], part.normals[v * 3 + 2])
      uvs.push(part.uvs[v * 2], part.uvs[v * 2 + 1])
    }
    indices.push(n)
  }
  return {
    name: part.name, material: part.material, materialName: part.materialName,
    positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices),
  }
}

// ---------------------------------------------------------------------------------------------------
// Doorways
// ---------------------------------------------------------------------------------------------------
//
// The file frames some doorways in a wall it never cut: the arch is there, the wall runs on behind it.
// `openDoorways` finds every door frame (a connected piece of the "Frames" mesh, standing on a floor, a
// metre or more across), measures its opening, and cuts that opening out of the walls behind it: an arch
// polygon swept through the frame's depth, subtracted from every wall triangle it touches. The frame
// covers the cut's edges, so the hole needs no reveal faces.

/** Connected pieces of a part (vertices welded at 5 mm), each as `{ min, max, triangles }`. */
function pieces(part) {
  const P = part.positions, I = part.indices
  const nv = P.length / 3
  const parent = new Int32Array(nv).map((_, i) => i)
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b }
  const byPos = new Map()
  for (let v = 0; v < nv; v++) {
    const k = `${Math.round(P[v * 3] * 200)},${Math.round(P[v * 3 + 1] * 200)},${Math.round(P[v * 3 + 2] * 200)}`
    if (byPos.has(k)) unite(v, byPos.get(k)); else byPos.set(k, v)
  }
  for (let k = 0; k < I.length; k += 3) { unite(I[k], I[k + 1]); unite(I[k], I[k + 2]) }
  const out = new Map()
  for (let k = 0; k < I.length; k += 3) {
    const r = find(I[k])
    if (!out.has(r)) out.set(r, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], triangles: [] })
    const c = out.get(r)
    c.triangles.push(k)
    for (let j = 0; j < 3; j++) for (let a = 0; a < 3; a++) {
      const v = P[I[k + j] * 3 + a]
      if (v < c.min[a]) c.min[a] = v
      if (v > c.max[a]) c.max[a] = v
    }
  }
  return [...out.values()]
}

/** Pieces closer than `gap` on every axis merged, repeatedly: the bits of one frame become one frame. */
function cluster(list, gap = 0.3) {
  const out = list.map(p => ({ ...p, triangles: [...p.triangles] }))
  for (let merged = true; merged;) {
    merged = false
    for (let i = 0; i < out.length && !merged; i++) for (let j = i + 1; j < out.length && !merged; j++) {
      const a = out[i], b = out[j]
      if ([0, 1, 2].some(k => Math.max(a.min[k], b.min[k]) - Math.min(a.max[k], b.max[k]) >= gap)) continue
      a.min = a.min.map((v, k) => Math.min(v, b.min[k]))
      a.max = a.max.map((v, k) => Math.max(v, b.max[k]))
      a.triangles.push(...b.triangles)
      out.splice(j, 1)
      merged = true
    }
  }
  return out
}

/**
 * Every door frame's opening, as `{ axis, depth: [lo, hi], polygon: [[u, y], …], centre, floor }`: `axis`
 * the wall's normal (0 = X, 2 = Z), `u` the other horizontal axis, the polygon convex (an arch: posts, then
 * an elliptical head through the apex), counter-clockwise in (u, y).
 */
export function doorFrames(parts) {
  const out = []
  for (const part of parts.filter(p => p.name === 'Frames')) {
    const P = part.positions, I = part.indices
    for (const f of cluster(pieces(part).filter(p => p.triangles.length > 8))) {
      const size = f.max.map((v, k) => v - f.min[k])
      const axis = size[0] < size[2] ? 0 : 2
      const ua = axis === 0 ? 2 : 0
      if (size[ua] < 1 || size[1] < 1.5) continue
      const floor = f.min[1]
      const mid = (f.min[ua] + f.max[ua]) / 2
      // Where the frame's triangle edges cross a plane: at chest height they give the posts, over a u the head.
      const crossings = (fixedAxis, value) => {
        const hits = []
        for (const k of f.triangles) {
          const v = [0, 1, 2].map(j => [P[I[k + j] * 3], P[I[k + j] * 3 + 1], P[I[k + j] * 3 + 2]])
          for (let j = 0; j < 3; j++) {
            const a = v[j], b = v[(j + 1) % 3]
            if ((a[fixedAxis] - value) * (b[fixedAxis] - value) > 0 || a[fixedAxis] === b[fixedAxis]) continue
            const t = (value - a[fixedAxis]) / (b[fixedAxis] - a[fixedAxis])
            hits.push(a.map((x, i) => x + (b[i] - x) * t))
          }
        }
        return hits
      }
      const atChest = crossings(1, floor + 1)
      const left = atChest.filter(p => p[ua] < mid).map(p => p[ua])
      const right = atChest.filter(p => p[ua] > mid).map(p => p[ua])
      if (!left.length || !right.length) continue
      const L = Math.max(...left), R = Math.min(...right)
      if (R - L < 0.6) continue
      const lowestAbove = (u, from) => {
        const ys = crossings(ua, u).map(p => p[1]).filter(y => y > from)
        return ys.length ? Math.min(...ys) : null
      }
      const apex = lowestAbove(mid, floor + 1.5)
      if (apex === null) continue
      const spring = Math.min(lowestAbove(L + 0.08, floor + 1) ?? apex, lowestAbove(R - 0.08, floor + 1) ?? apex)
      const polygon = [[L, floor - 0.2], [R, floor - 0.2], [R, spring]]
      const rise = Math.max(0, apex - spring), half = (R - L) / 2
      for (let s = 1; s < 8; s++) {
        const a = s / 8 * Math.PI
        polygon.push([mid + Math.cos(a) * half, spring + Math.sin(a) * rise])
      }
      polygon.push([L, spring])
      out.push({ axis, depth: [f.min[axis] - 0.25, f.max[axis] + 0.25], polygon, centre: f.min.map((v, k) => (v + f.max[k]) / 2), floor })
    }
  }
  return out
}

/** Cut every frame's opening out of the wall parts, in place. Returns how many wall triangles were cut. */
export function openDoorways(parts, frames, wallNames = ['Walls', 'Ossuary', 'Catacombs']) {
  let cut = 0
  for (const part of parts) if (wallNames.includes(part.name)) cut += subtractPrisms(part, frames)
  return cut
}

/** Remove the connected pieces of `partName` lying wholly inside `box` ([[min], [max]]), in place. */
export function removePieces(parts, partName, box) {
  let removed = 0
  for (const part of parts) {
    if (part.name !== partName) continue
    const drop = new Set()
    for (const p of pieces(part))
      if (p.min.every((v, k) => v >= box[0][k]) && p.max.every((v, k) => v <= box[1][k])) for (const k of p.triangles) drop.add(k)
    if (!drop.size) continue
    const keep = []
    for (let k = 0; k < part.indices.length; k += 3) if (!drop.has(k)) keep.push(part.indices[k], part.indices[k + 1], part.indices[k + 2])
    part.indices = Uint32Array.from(keep)
    removed += drop.size
  }
  return removed
}

/** A frame's opening as half-spaces (inside = in the opening): the polygon's edges, then the depth slab. */
function prismPlanes({ axis, depth, polygon }) {
  const ua = axis === 0 ? 2 : 0
  const planes = []
  for (let i = 0; i < polygon.length; i++) {
    const [u0, y0] = polygon[i], [u1, y1] = polygon[(i + 1) % polygon.length]
    // The inward normal of a counter-clockwise edge in (u, y) is (-dy, du).
    const n = [0, 0, 0]
    n[ua] = -(y1 - y0); n[1] = u1 - u0
    planes.push({ n, d: n[ua] * u0 + n[1] * y0 })
  }
  const lo = [0, 0, 0], hi = [0, 0, 0]
  lo[axis] = 1; hi[axis] = -1
  planes.push({ n: lo, d: depth[0] }, { n: hi, d: -depth[1] })
  return planes
}

/** Sutherland–Hodgman: the part of a convex polygon on the side `n·p >= d`, attributes interpolated. */
function clipPoly(poly, n, d) {
  const out = []
  const side = (v) => n[0] * v.p[0] + n[1] * v.p[1] + n[2] * v.p[2] - d
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const sa = side(a), sb = side(b)
    if (sa >= 0) out.push(a)
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb)
      const lerp = (x, y) => x.map((v, k) => v + (y[k] - v) * t)
      out.push({ p: lerp(a.p, b.p), n: lerp(a.n, b.n), uv: lerp(a.uv, b.uv) })
    }
  }
  return out
}

/**
 * Subtract every frame's prism from a part's triangles, in place. A triangle that reaches into a prism is
 * replaced by the pieces of it outside: clipped against each face of the prism in turn, keeping what lies
 * beyond that face, and continuing with what lies within. Returns how many triangles were cut.
 */
function subtractPrisms(part, frames) {
  const P = part.positions, N = part.normals, U = part.uvs, I = part.indices
  const prisms = frames.map(f => {
    const ua = f.axis === 0 ? 2 : 0
    const min = [0, 0, 0], max = [0, 0, 0]
    min[f.axis] = f.depth[0]; max[f.axis] = f.depth[1]
    min[ua] = Math.min(...f.polygon.map(p => p[0])); max[ua] = Math.max(...f.polygon.map(p => p[0]))
    min[1] = Math.min(...f.polygon.map(p => p[1])); max[1] = Math.max(...f.polygon.map(p => p[1]))
    return { planes: prismPlanes(f), min, max }
  })
  const vert = (v) => ({ p: [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], n: [N[v * 3], N[v * 3 + 1], N[v * 3 + 2]], uv: [U[v * 2], U[v * 2 + 1]] })
  const outP = Array.from(P), outN = Array.from(N), outU = Array.from(U), outI = []
  let cut = 0
  for (let k = 0; k < I.length; k += 3) {
    let polys = [[vert(I[k]), vert(I[k + 1]), vert(I[k + 2])]]
    let touched = false
    for (const prism of prisms) {
      const next = []
      for (const poly of polys) {
        const overlaps = [0, 1, 2].every(a => Math.min(...poly.map(v => v.p[a])) <= prism.max[a] && Math.max(...poly.map(v => v.p[a])) >= prism.min[a])
        if (!overlaps) { next.push(poly); continue }
        let rem = poly
        const outside = []
        for (const { n, d } of prism.planes) {
          const o = clipPoly(rem, n.map(v => -v), -d)
          if (o.length >= 3) outside.push(o)
          rem = clipPoly(rem, n, d)
          if (rem.length < 3) break
        }
        if (rem.length < 3) { next.push(poly); continue }   // never inside the opening
        touched = true
        next.push(...outside)
      }
      polys = next
    }
    if (!touched) { outI.push(I[k], I[k + 1], I[k + 2]); continue }
    cut++
    for (const poly of polys) {
      const base = outP.length / 3
      for (const v of poly) { outP.push(...v.p); outN.push(...v.n); outU.push(...v.uv) }
      for (let j = 1; j < poly.length - 1; j++) outI.push(base, base + j, base + j + 1)
    }
  }
  part.positions = Float32Array.from(outP)
  part.normals = Float32Array.from(outN)
  part.uvs = Float32Array.from(outU)
  part.indices = Uint32Array.from(outI)
  return cut
}
