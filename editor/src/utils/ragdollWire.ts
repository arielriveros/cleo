// Wireframes for the rig editor's ragdoll preview: each part's collider, and each joint's limit, as line
// pairs in the owning part's own frame (bind MODEL units). The preview places one node per part with the
// same pose the runtime ragdoll would spawn that part at (`ragdollPartPose`), so what is drawn is what
// will fall.

import { quat, vec3 } from 'gl-matrix'
import type { RagdollLayoutPart } from 'cleo'

export type Lines = { positions: [number, number, number][]; indices: number[] }

const SEGMENTS = 20

function circle(out: Lines, center: vec3, a: vec3, b: vec3, radius: number, from = 0, to = Math.PI * 2, closed = true): void {
  const base = out.positions.length
  const n = closed ? SEGMENTS : Math.max(2, Math.ceil(SEGMENTS * (to - from) / (Math.PI * 2)))
  const count = closed ? n : n + 1
  for (let i = 0; i < count; i++) {
    const t = from + (to - from) * (i / n)
    const c = Math.cos(t) * radius, s = Math.sin(t) * radius
    out.positions.push([center[0] + a[0] * c + b[0] * s, center[1] + a[1] * c + b[1] * s, center[2] + a[2] * c + b[2] * s])
  }
  for (let i = 0; i < n; i++) out.indices.push(base + i, base + (closed ? (i + 1) % n : i + 1))
}

function line(out: Lines, p: vec3 | number[], q: vec3 | number[]): void {
  const base = out.positions.length
  out.positions.push([p[0], p[1], p[2]], [q[0], q[1], q[2]])
  out.indices.push(base, base + 1)
}

const X = vec3.fromValues(1, 0, 0), Y = vec3.fromValues(0, 1, 0), Z = vec3.fromValues(0, 0, 1)

/** A part's collider outline, centred on the part (Y along the segment). */
export function partLines(lp: RagdollLayoutPart): Lines {
  const out: Lines = { positions: [], indices: [] }
  const r = lp.radius
  if (lp.part.shape === 'box') {
    const hx = r, hy = lp.length / 2, hz = lp.depth / 2
    const corners: [number, number, number][] = []
    for (let i = 0; i < 8; i++) corners.push([(i & 1) ? hx : -hx, (i & 2) ? hy : -hy, (i & 4) ? hz : -hz])
    const base = out.positions.length
    out.positions.push(...corners)
    for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) out.indices.push(base + i, base + (i | bit))
    return out
  }
  if (lp.part.shape === 'sphere') {
    const o = vec3.create()
    circle(out, o, X, Y, r); circle(out, o, Y, Z, r); circle(out, o, X, Z, r)
    return out
  }
  // Capsule: two rings, four uprights, and a half circle over each cap in two planes.
  const h = Math.max(0, lp.length / 2 - r)
  const top = vec3.fromValues(0, h, 0), bottom = vec3.fromValues(0, -h, 0)
  circle(out, top, X, Z, r); circle(out, bottom, X, Z, r)
  for (const [x, z] of [[r, 0], [-r, 0], [0, r], [0, -r]]) line(out, [x, h, z], [x, -h, z])
  circle(out, top, X, Y, r, 0, Math.PI, false); circle(out, top, Z, Y, r, 0, Math.PI, false)
  circle(out, bottom, X, Y, r, Math.PI, Math.PI * 2, false); circle(out, bottom, Z, Y, r, Math.PI, Math.PI * 2, false)
  return out
}

/**
 * A joint's limit, drawn in the PARENT part's frame (the limit is fixed to the parent): a cone around the
 * neutral direction for a cone joint, the bend arc for a hinge. `size` is how far out it is drawn.
 */
export function jointLines(child: RagdollLayoutPart, parent: RagdollLayoutPart, size: number): Lines {
  const out: Lines = { positions: [], indices: [] }
  const inv = quat.invert(quat.create(), parent.rotation)
  const toLocal = (v: vec3, point = false) => {
    const o = point ? vec3.sub(vec3.create(), v, parent.center) : vec3.clone(v)
    return vec3.transformQuat(o, o, inv)
  }
  const pivot = toLocal(child.pivot, true)
  const jt = child.part.joint
  if (jt?.type === 'fixed') {
    circle(out, pivot, X, Z, size * 0.15)
    return out
  }
  if (jt?.type === 'hinge' && child.hingeAxis) {
    const axis = toLocal(child.hingeAxis)
    const bindDir = toLocal(child.childAxis)
    const lo = Math.min(jt.hingeMin, jt.hingeMax) * Math.PI / 180, hi = Math.max(jt.hingeMin, jt.hingeMax) * Math.PI / 180
    const at = (t: number) => vec3.scaleAndAdd(vec3.create(), pivot,
      vec3.transformQuat(vec3.create(), bindDir, quat.setAxisAngle(quat.create(), axis, t)), size)
    const steps = 16
    const base = out.positions.length
    for (let i = 0; i <= steps; i++) { const p = at(lo + (hi - lo) * i / steps); out.positions.push([p[0], p[1], p[2]]) }
    for (let i = 0; i < steps; i++) out.indices.push(base + i, base + i + 1)
    line(out, pivot, at(lo)); line(out, pivot, at(hi))
    return out
  }
  // Cone: a ring at `size` along the axis, and four edges.
  const axis = toLocal(child.parentAxis)
  const angle = Math.min(child.coneAngle, Math.PI * 0.49)
  const a = vec3.cross(vec3.create(), axis, Math.abs(axis[1]) < 0.9 ? Y : X)
  vec3.normalize(a, a)
  const b = vec3.cross(vec3.create(), axis, a)
  const ringCenter = vec3.scaleAndAdd(vec3.create(), pivot, axis, size * Math.cos(angle))
  const ringRadius = size * Math.sin(angle)
  circle(out, ringCenter, a, b, ringRadius)
  for (const t of [0, 0.5, 1, 1.5]) {
    const dir = vec3.create()
    vec3.scaleAndAdd(dir, dir, a, Math.cos(t * Math.PI) * ringRadius)
    vec3.scaleAndAdd(dir, dir, b, Math.sin(t * Math.PI) * ringRadius)
    line(out, pivot, vec3.add(dir, dir, ringCenter))
  }
  line(out, pivot, vec3.scaleAndAdd(vec3.create(), pivot, axis, size * 1.1))
  return out
}
