// The Valley's two torch models and its bonfire's campfire, as parts: geometry only. Materials,
// templates and placement are build.mjs's.
//
//   Standing Torch  build/props/medieval_torch.glb -- a hand torch modelled leaning; stood upright about
//                   its own long axis, scaled to a road torch, its foot on the origin.
//   Wall Torch      build/props/wall_torch_model/torch.fbx -- a sconce whose plate is its -Z face. The
//                   origin goes on the plate (the wall), so a placement is a point on a wall and a yaw.
//   Campfire        build/props/campfire_fire_with_stones.glb -- stones round a log pile, in no unit at
//                   all (about 6000 across); scaled to a stated width.
//
// Each returns its parts plus `flame`: where the fire sits on it, [x, y, z] in its own frame.

import path from 'path'
import { mat4, quat, vec3 } from 'gl-matrix'
import { loadAssimp, toGltf } from '../exampleKit/fbxImport.mjs'
import { boundsOf, decimate, mergeByMaterial, normalizeParts, partsOf, readGltf } from './meshes.mjs'

/** Transform every part's positions and normals in place by `m` (rotation + uniform scale only). */
function transformParts(parts, m) {
  const r = mat4.getRotation(quat.create(), m)
  const v = vec3.create()
  for (const p of parts) for (let k = 0; k < p.positions.length; k += 3) {
    vec3.transformMat4(v, [p.positions[k], p.positions[k + 1], p.positions[k + 2]], m)
    p.positions.set(v, k)
    vec3.transformQuat(v, [p.normals[k], p.normals[k + 1], p.normals[k + 2]], r)
    vec3.normalize(v, v)
    p.normals.set(v, k)
  }
}

function points(parts) {
  const out = []
  for (const p of parts) for (let k = 0; k < p.positions.length; k += 3) out.push([p.positions[k], p.positions[k + 1], p.positions[k + 2]])
  return out
}

/** The principal axis of a point cloud (power iteration on its covariance). */
function principalAxis(pts) {
  const c = [0, 1, 2].map(a => pts.reduce((s, p) => s + p[a], 0) / pts.length)
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const p of pts) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += (p[i] - c[i]) * (p[j] - c[j])
  let v = [0, 1, 0]
  for (let it = 0; it < 64; it++) {
    const n = [0, 1, 2].map(i => cov[i][0] * v[0] + cov[i][1] * v[1] + cov[i][2] * v[2])
    const l = Math.hypot(...n)
    v = n.map(x => x / l)
  }
  return { centre: c, axis: v }
}

/** Centre (x, z) and top of the points in the top `share` of the height: where a flame stands. */
function headOf(parts, share) {
  const b = boundsOf(parts)
  const cut = b.max[1] - b.size[1] * share
  const head = points(parts).filter(p => p[1] >= cut)
  const x = head.reduce((s, p) => s + p[0], 0) / head.length
  const z = head.reduce((s, p) => s + p[2], 0) / head.length
  return [x, b.max[1], z]
}

export function buildStandingTorch(propsDir, { height = 1.7 } = {}) {
  const parts = mergeByMaterial(partsOf(readGltf(path.join(propsDir, 'medieval_torch.glb'))))
  // Upright: the long axis onto +Y, the head (the wider end) up.
  const pts = points(parts)
  const { centre, axis } = principalAxis(pts)
  const along = (p) => (p[0] - centre[0]) * axis[0] + (p[1] - centre[1]) * axis[1] + (p[2] - centre[2]) * axis[2]
  const spread = (sign) => {
    const end = pts.filter(p => along(p) * sign > 0.6 * Math.max(...pts.map(q => along(q) * sign)))
    return Math.max(...end.map(p => {
      const t = along(p)
      return Math.hypot(p[0] - centre[0] - axis[0] * t, p[1] - centre[1] - axis[1] * t, p[2] - centre[2] - axis[2] * t)
    }))
  }
  const up = spread(1) >= spread(-1) ? axis : axis.map(v => -v)
  const m = mat4.fromQuat(mat4.create(), quat.rotationTo(quat.create(), up, [0, 1, 0]))
  transformParts(parts, m)
  normalizeParts(parts, { scale: height / boundsOf(parts).size[1] })
  return { parts, flame: headOf(parts, 0.12), size: boundsOf(parts).size }
}

export async function buildWallTorch(root, propsDir, { height = 0.7, ratio = 0.4 } = {}) {
  const ajs = await loadAssimp(root)
  // 4 k triangles at the source; the dungeon hangs fifty of them, none ever bigger than a hand on screen.
  const parts = mergeByMaterial(partsOf(await toGltf(ajs, path.join(propsDir, 'wall_torch_model', 'torch.fbx'))))
    .map(p => ({ ...decimate(root, p, ratio), name: p.name, material: p.material }))
  const s = height / boundsOf(parts).size[1]
  for (const p of parts) for (let k = 0; k < p.positions.length; k++) p.positions[k] *= s
  // Origin on the wall plate: x centred, y at the bottom, z at the back.
  const b = boundsOf(parts)
  const off = [(b.min[0] + b.max[0]) / 2, b.min[1], b.min[2]]
  for (const p of parts) for (let k = 0; k < p.positions.length; k += 3) {
    p.positions[k] -= off[0]; p.positions[k + 1] -= off[1]; p.positions[k + 2] -= off[2]
  }
  return { parts, flame: headOf(parts, 0.15), size: boundsOf(parts).size }
}

export function buildCampfire(propsDir, { width = 1.6 } = {}) {
  const parts = mergeByMaterial(partsOf(readGltf(path.join(propsDir, 'campfire_fire_with_stones.glb'))))
  const b = boundsOf(parts)
  normalizeParts(parts, { scale: width / Math.max(b.size[0], b.size[2]) })
  return { parts, size: boundsOf(parts).size }
}

/**
 * Where a horizontal ray from `from` toward `to` first meets `parts` (Möller–Trumbore), as
 * `{ point, normal }` with the normal facing back along the ray, or null.
 */
export function rayHit(parts, from, to) {
  const dir = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), to, from))
  let best = null
  const e1 = vec3.create(), e2 = vec3.create(), pv = vec3.create(), tv = vec3.create(), qv = vec3.create()
  for (const p of parts) {
    const P = p.positions, I = p.indices
    for (let k = 0; k < I.length; k += 3) {
      const a = [P[I[k] * 3], P[I[k] * 3 + 1], P[I[k] * 3 + 2]]
      const b = [P[I[k + 1] * 3], P[I[k + 1] * 3 + 1], P[I[k + 1] * 3 + 2]]
      const c = [P[I[k + 2] * 3], P[I[k + 2] * 3 + 1], P[I[k + 2] * 3 + 2]]
      vec3.sub(e1, b, a); vec3.sub(e2, c, a)
      vec3.cross(pv, dir, e2)
      const det = vec3.dot(e1, pv)
      if (Math.abs(det) < 1e-9) continue
      vec3.sub(tv, from, a)
      const u = vec3.dot(tv, pv) / det
      if (u < 0 || u > 1) continue
      vec3.cross(qv, tv, e1)
      const v = vec3.dot(dir, qv) / det
      if (v < 0 || u + v > 1) continue
      const t = vec3.dot(e2, qv) / det
      if (t > 0 && (!best || t < best.t)) {
        const n = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), e1, e2))
        if (vec3.dot(n, dir) > 0) vec3.negate(n, n)
        best = { t, point: [from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t], normal: [...n] }
      }
    }
  }
  return best
}
