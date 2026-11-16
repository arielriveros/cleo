// Fold a scene's static scenery Colliders into one Collider per kind of collision, in serialized scene JSON.
//
// A 3D example used to wrap every static mesh in its own Collider ("Barrel Collider > Barrel", "Walls 2,-5"),
// which fills the scene tree with wrappers. This pass moves every such collider's shapes onto one Collider at the
// scene root, `Static Collision`, and its meshes under it, in groups that mirror where they were. The world they
// build is the same: each shape is baked to exactly what the old collider handed the physics backend
// (Node.attachShapes: dimensions and offset by the collider's world scale, placed by its world pose).
//
// Left as they are: template instances (placing one keeps its collision), anything scripted, anything holding a
// Trigger, a saved node or a dormant one, and any collider another node or a script names. Colliders that differ
// in how they collide (the `collider` block bar its shapes, gameplay variables such as `blocksSwings`, see-through
// dither) get a merged Collider each.

import { mat4, quat, vec3 } from 'gl-matrix'
import { Node } from '../../src/core/scene/nodes/node'
import { parseNodeJson } from '../../src/core/scene/nodes/parseNodeJson'
import { ColliderNode } from '../../src/core/scene/nodes/colliderNode'

export interface MergeOptions {
  /** A stable id for a node this pass creates. */
  idFor: (key: string) => string
  /** Every string literal of the project's scripts: a collider whose name is among them is looked up, and stays. */
  scriptStrings: Set<string>
  /** Ids referenced from outside the scene (sequences): a collider among them stays. */
  externalRefs?: Set<string>
}

export interface MergeResult {
  merged: number
  colliders: { name: string; shapes: number; meshes: number }[]
  kept: string[]
}

// ----- the world transforms, as the engine computes them --------------------------------------------------

/** The scene's transform skeleton as engine nodes, by id: what world pose and scale every node has. */
function worldNodes(sceneRoot: any): Map<string, Node> {
  const skeleton = (n: any): any => ({
    type: 'node', id: n.id, name: n.name,
    position: n.position ?? [0, 0, 0], rotation: n.rotation ?? [0, 0, 0], scale: n.scale ?? [1, 1, 1],
    ...(Array.isArray(n.quaternion) ? { quaternion: n.quaternion } : {}),
    children: (n.children ?? []).map(skeleton),
  })
  const root = new Node('root')
  for (const c of sceneRoot.children ?? []) parseNodeJson(root, skeleton(c))
  root.updateTransforms(null)
  const out = new Map<string, Node>()
  const walk = (n: Node) => { out.set(n.id, n); n.children.forEach(walk) }
  walk(root)
  return out
}

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps: number) => {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > eps * Math.max(1, Math.abs(b[i]))) return false
  return true
}

/** Euler degrees that quat.fromEuler turns back into `q` (checked: a mismatch throws). */
function eulerOf(q: quat): number[] {
  // The engine's eulerFromQuatDeg convention (src/core/math.ts), in doubles and with the pitch from atan2: its float asin loses ~0.015°
  // right at a quarter turn, which is exactly where authored props sit.
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]]
  const r00 = 1 - 2 * (y * y + z * z), r10 = 2 * (x * y + w * z), r20 = 2 * (x * z - w * y)
  const r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y), r12 = 2 * (y * z - w * x), r11 = 1 - 2 * (x * x + z * z)
  const cy = Math.hypot(r00, r10)
  const D = 180 / Math.PI
  const e = cy > 1e-7
    ? [Math.atan2(r21, r22) * D, Math.atan2(-r20, cy) * D, Math.atan2(r10, r00) * D]
    : [Math.atan2(-r12, r11) * D, Math.atan2(-r20, cy) * D, 0]
  // The same rotation also reads as (x + 180, 180 - y, z + 180): keep whichever tilts least about x and z, which
  // is how it was authored (a ramp turned round is [-30, 180, 0], not [150, 0, 180]).
  const wrap = (v: number) => { let w = ((v + 180) % 360 + 360) % 360 - 180; if (w === -180) w = 180; return w }
  const alt = [wrap(e[0] + 180), wrap(180 - e[1]), wrap(e[2] + 180)]
  const pick = Math.abs(alt[0]) + Math.abs(alt[2]) < Math.abs(e[0]) + Math.abs(e[2]) - 1e-9 ? alt : e
  const back = quat.fromEuler(quat.create(), pick[0], pick[1], pick[2])
  if (!near(back, q, 1e-5) && !near(back, quat.scale(quat.create(), q, -1), 1e-5))
    throw new Error(`rotation does not round-trip through Euler degrees: ${[...q].join(', ')}`)
  return [pick[0], pick[1], pick[2]].map(v => Math.abs(v) < 1e-9 ? 0 : v)
}

/** Euler degrees for `rotation`'s quaternion in the form eulerOf prefers (for data written before it preferred one). */
export function canonicalEuler(rotation: number[]): number[] {
  return eulerOf(quat.fromEuler(quat.create(), rotation[0], rotation[1], rotation[2]))
}

/** A transform as position, Euler rotation and scale, or null when it has shear (no TRS can express it). */
function trsOf(m: mat4): { position: number[]; rotation: number[]; scale: number[] } | null {
  const t = mat4.getTranslation(vec3.create(), m)
  const s = mat4.getScaling(vec3.create(), m)
  const unscaled = mat4.fromValues(
    m[0] / (s[0] || 1), m[1] / (s[0] || 1), m[2] / (s[0] || 1), 0,
    m[4] / (s[1] || 1), m[5] / (s[1] || 1), m[6] / (s[1] || 1), 0,
    m[8] / (s[2] || 1), m[9] / (s[2] || 1), m[10] / (s[2] || 1), 0, 0, 0, 0, 1)
  const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), unscaled))
  // A mirrored transform: put the flip in one scale axis.
  if (mat4.determinant(m) < 0) s[0] = -s[0]
  const rotation = eulerOf(q)
  const back = mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), rotation[0], rotation[1], rotation[2]), t, s)
  if (!near(back, m, 1e-5)) return null
  return { position: [...t], rotation, scale: [...s] }
}

// ----- shapes ---------------------------------------------------------------------------------------------

/**
 * A collider's shape as it ends up in the world, as a shape of a Collider at the identity transform. Mirrors
 * Node.attachShapes and the Shape factories: dimensions scale by the collider's (absolute) world scale in the
 * shape's own axes, the offset by it too, then the collider's world pose places both.
 */
function bakeShape(shape: any, at: Node): any {
  const s = at.worldScale
  const [sx, sy, sz] = [Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2])]
  const off = shape.offset ?? [0, 0, 0]
  const local = vec3.fromValues(off[0] * s[0], off[1] * s[1], off[2] * s[2])
  const offset = vec3.add(vec3.create(), at.worldPosition, vec3.transformQuat(vec3.create(), local, at.worldQuaternion))
  const r = shape.rotation ?? [0, 0, 0]
  const q = quat.multiply(quat.create(), at.worldQuaternion, quat.fromEuler(quat.create(), r[0], r[1], r[2]))
  const out: any = { ...shape, offset: [...offset], rotation: eulerOf(q) }
  switch (shape.type) {
    case 'box': out.width = shape.width * sx; out.height = shape.height * sy; out.depth = shape.depth * sz; break
    case 'sphere': out.radius = shape.radius * Math.max(sx, sy, sz); break
    case 'cylinder': out.radius = shape.radius * Math.max(sx, sz); out.height = shape.height * sy; break
    case 'capsule': out.radius = shape.radius * Math.max(sx, sz); out.height = shape.height * sy; break
    case 'convex': out.vertices = (shape.vertices as number[][]).map(v => [v[0] * sx, v[1] * sy, v[2] * sz]); break
    case 'plane': break
    default: throw new Error(`shape type ${shape.type} cannot be merged`)
  }
  return out
}

// ----- choosing -------------------------------------------------------------------------------------------

function* walk(n: any): Generator<any> {
  yield n
  for (const c of n.children ?? []) yield* walk(c)
}

const isInstance = (n: any) => !!n?.variables?.__templateId
const scripted = (n: any) => !!n?.variables?.__scriptId || typeof n?.script === 'string'

/** What makes two colliders collide differently: they merge only when this is equal. */
/** A collider block as the engine reads it: every setting present, defaults filled in, shapes left out. */
function settings(block: any): Record<string, unknown> {
  const c = new ColliderNode('settings')
  ColliderNode.readSettings(c, { ...block, shapes: [] })
  const { shapes: _s, mass: _m, ...out } = (c as any)._serializePayload().collider
  return out
}

function behaviour(n: any): string {
  const block = settings(n.collider ?? {})
  const vars = Object.fromEntries(Object.entries(n.variables ?? {}).filter(([k]) => !k.startsWith('__')))
  return JSON.stringify({ block, vars, cameraDither: n.cameraDither ?? null })
}

/** A short label for what sets a group apart, for its name ("blocksSwings"). */
function label(n: any): string {
  const vars = Object.entries<any>(n.variables ?? {}).filter(([k]) => !k.startsWith('__')).map(([k, v]) => v?.value === true ? k : `${k} ${v?.value}`)
  if (n.cameraDither) vars.push('see-through')
  return vars.join(', ')
}

/** Ids any node names in a field other than its own id: a collider among them is referenced, and stays. */
function referencedIds(sceneRoot: any): Set<string> {
  const out = new Set<string>()
  const scan = (v: any) => {
    if (typeof v === 'string') out.add(v)
    else if (Array.isArray(v)) v.forEach(scan)
    else if (v && typeof v === 'object' && !('$geo' in v) && !('$bin' in v)) for (const [k, x] of Object.entries(v)) if (k !== 'children') scan(x)
  }
  for (const n of walk(sceneRoot)) for (const [k, v] of Object.entries(n)) if (k !== 'id' && k !== 'children' && k !== 'name' && k !== 'type') scan(v)
  return out
}

/** Why a collider must stay its own, or null when it is scenery to merge. */
function keepReason(n: any, inInstance: boolean, refs: Set<string>, opts: MergeOptions): string | null {
  if (n.type !== 'collider') return 'not a collider'
  if ((n.collider?.mass ?? 0) > 0) return 'dynamic'
  // One this pass made, on an earlier run.
  if (/^Static Collision/.test(String(n.name))) return 'already merged'
  if (inInstance || isInstance(n)) return 'template instance'
  if (n.spawnOnStart === false) return 'dormant'
  for (const d of walk(n)) {
    // A script BELOW it (a flickering lamp, turning sails) moves with its mesh; only the collider's own matters.
    if (d === n && scripted(d)) return 'scripted'
    if (d.type === 'trigger') return 'holds a Trigger'
    if (d !== n && d.type === 'collider') return 'holds a Collider'
    if (d.saved) return 'holds a saved node'
    if (d !== n && isInstance(d) && d.type === 'collider') return 'holds an instance collider'
  }
  if (refs.has(n.id) || opts.externalRefs?.has(n.id)) return 'referenced by id'
  if (opts.scriptStrings.has(n.name)) return 'named by a script'
  return null
}

// ----- the pass -------------------------------------------------------------------------------------------

/** Fold `sceneRoot`'s static scenery Colliders into `Static Collision` Colliders, in place. */
export function mergeStaticColliders(sceneRoot: any, opts: MergeOptions): MergeResult {
  const refs = referencedIds(sceneRoot)
  const world = worldNodes(sceneRoot)
  const parentOf = new Map<any, any>()
  const pathOf = new Map<any, string[]>()
  const chosen: any[] = []
  const kept: string[] = []

  const visit = (n: any, path: string[], inInstance: boolean) => {
    pathOf.set(n, path)
    if (n !== sceneRoot && n.type === 'collider') {
      let why = keepReason(n, inInstance, refs, opts)
      // A child whose world transform has shear cannot sit, unparented, under a Collider at the identity.
      if (!why) {
        const kids = n.children ?? []
        const placedId = kids.length === 1 && n.name === `${kids[0].name} Collider` ? kids[0].id : n.id
        if (kids.length && !trsOf(world.get(placedId)!.worldTransform)) why = 'its world transform has shear'
      }
      if (why) {
        if (why !== 'not a collider' && why !== 'dynamic' && why !== 'template instance' && why !== 'already merged') kept.push(`${n.name}: ${why}`)
      } else {
        chosen.push(n)
        return   // its subtree moves as it is
      }
    }
    const inst = inInstance || isInstance(n)
    for (const c of n.children ?? []) { parentOf.set(c, n); visit(c, n === sceneRoot ? [] : [...path, n.name], inst) }
  }
  visit(sceneRoot, [], false)

  // One merged Collider per way of colliding, in the order the scene first uses each.
  const groups = new Map<string, any[]>()
  for (const c of chosen) {
    const k = behaviour(c)
    groups.set(k, [...(groups.get(k) ?? []), c])
  }

  // The plain group first, then the tagged ones in scene order.
  const ordered = [...groups].sort((a, b) => Number(!!label(a[1][0])) - Number(!!label(b[1][0])))
  groups.clear()
  for (const [k, v] of ordered) groups.set(k, v)

  const result: MergeResult = { merged: chosen.length, colliders: [], kept }
  let index = 0
  for (const [key, members] of groups) {
    const first = members[0]
    // Named by what sets it apart; the plain one (no gameplay tags) is just "Static Collision".
    const tag = groups.size > 1 ? label(first) : ''
    let name = tag ? `Static Collision (${tag})` : 'Static Collision'
    for (let k = 2; result.colliders.some(c => c.name === name); k++) name = `${tag ? `Static Collision (${tag})` : 'Static Collision'} ${k}`
    const block = settings(first.collider)
    const merged: any = {
      id: opts.idFor(`collider:${key}`), name, type: 'collider',
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      variables: Object.fromEntries(Object.entries(first.variables ?? {}).filter(([k]) => !k.startsWith('__'))),
      spawnOnStart: true,
      ...(first.cameraDither ? { cameraDither: first.cameraDither } : {}),
      collider: { ...block, mass: 0, shapes: [] as any[] },
      children: [] as any[],
    }
    // Groups inside it that mirror where each collider sat ("Props", "Level/Props").
    const groupAt = new Map<string, any>([['', merged]])
    const group = (path: string[]): any => {
      const key = path.join('/')
      const hit = groupAt.get(key)
      if (hit) return hit
      const parent = group(path.slice(0, -1))
      const g = { id: opts.idFor(`group:${merged.id}:${key}`), name: path[path.length - 1], type: 'node',
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], variables: {}, spawnOnStart: true, children: [] as any[] }
      parent.children.push(g)
      groupAt.set(key, g)
      return g
    }
    let meshes = 0
    for (const c of members) {
      const at = world.get(c.id)!
      for (const shape of c.collider.shapes ?? []) merged.collider.shapes.push(bakeShape(shape, at))
      // A wall that is shapes alone adds shapes only. A wrapper ("Barrel Collider" holding "Barrel") gives way to
      // what it wraps, at its world transform. A collider that WAS the thing ("Campfire", holding its model and
      // its fire) becomes a plain node of the same name and id, so the thing keeps its name and its parts.
      const kids = c.children ?? []
      if (kids.length) {
        const into = group(pathOf.get(c)!)
        const wrapper = kids.length === 1 && c.name === `${kids[0].name} Collider`
        const placed = wrapper ? kids[0] : {
          id: c.id, name: c.name, type: 'node', variables: {}, spawnOnStart: c.spawnOnStart ?? true, children: kids,
        }
        // Where nothing above the collider moves it and the wrapped node sits unmoved in it (the usual case:
        // a placed copy), the collider's own numbers ARE its world transform: keep them verbatim, as authored.
        const identity = (n: any) => !n.quaternion && [n.position, n.rotation].every((v: any) => !v || v.every((x: number) => x === 0))
          && (!n.scale || n.scale.every((x: number) => x === 1))
        const chainIsIdentity = (() => { for (let p = parentOf.get(c); p && p !== sceneRoot; p = parentOf.get(p)) if (!identity(p)) return false; return true })()
        if (chainIsIdentity && (!wrapper || identity(kids[0]))) {
          placed.position = [...(c.position ?? [0, 0, 0])]
          placed.rotation = [...(c.rotation ?? [0, 0, 0])]
          placed.scale = [...(c.scale ?? [1, 1, 1])]
          if (c.quaternion) placed.quaternion = [...c.quaternion]
          else delete placed.quaternion
        } else {
          const trs = trsOf(world.get(placed.id)!.worldTransform)!
          placed.position = trs.position
          placed.rotation = trs.rotation
          placed.scale = trs.scale
          delete placed.quaternion
        }
        into.children.push(placed)
        meshes += wrapper ? 1 : kids.length
      }
      // Out of its old place.
      const parent = parentOf.get(c)
      parent.children = parent.children.filter((x: any) => x !== c)
    }
    sceneRoot.children.push(merged)
    result.colliders.push({ name, shapes: merged.collider.shapes.length, meshes })
    index++
  }

  // Groups left empty by the move (a "Collision" folder of walls) go too; a group that was empty already stays.
  const emptied = new Set<any>()
  for (const c of chosen) for (let p = parentOf.get(c); p && p !== sceneRoot; p = parentOf.get(p)) emptied.add(p)
  const prune = (n: any): boolean => {
    n.children = (n.children ?? []).filter((c: any) => !prune(c))
    const plain = n.type === 'node' && !scripted(n) && !isInstance(n) && !Object.keys(n.variables ?? {}).length
    return emptied.has(n) && plain && n.children.length === 0 && !refs.has(n.id) && !opts.scriptStrings.has(n.name)
  }
  prune(sceneRoot)
  return result
}

/** Every string literal in these script sources (single, double or backtick quoted, no interpolation). */
export function stringLiterals(sources: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const src of sources)
    for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) if (!m[2].includes('${')) out.add(m[2])
  return out
}

// ----- checking ---------------------------------------------------------------------------------------------

/**
 * Where a grid of rays hits the static colliders of a scene: downward rays over its extent and horizontal rays
 * across it at a few heights. Before and after a merge the lists must match: that is the proof the merged
 * shapes are the old ones.
 */
export type Bounds = { min: number[]; max: number[]; targets: number[][] }

export async function staticRayHits(sceneRoot: any, bounds?: Bounds, backend = 'cannon', rays = 24): Promise<{ hits: (number[] | null)[]; bounds: Bounds }> {
  const { PhysicsSystem } = await import('../../src/physics/physicsSystem')
  // Only the static colliders, as bodies; everything else a bare transform.
  const strip = (n: any): any => {
    const isStatic = n.type === 'collider' && !((n.collider?.mass ?? 0) > 0)
    return {
      type: isStatic ? 'collider' : 'node', id: n.id, name: n.name,
      position: n.position ?? [0, 0, 0], rotation: n.rotation ?? [0, 0, 0], scale: n.scale ?? [1, 1, 1],
      ...(Array.isArray(n.quaternion) ? { quaternion: n.quaternion } : {}),
      ...(isStatic ? { collider: { ...settings(n.collider), mass: 0, shapes: n.collider.shapes ?? [] } } : {}),
      children: (n.children ?? []).map(strip),
    }
  }
  const root = new Node('root')
  const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend } as any)
  p.initialize()
  const nodes: Node[] = []
  const scene: any = { nodes, landscapes: [], tilemaps: [], activeCamera: null, physics: p, spawnRulesEnabled: true }
  ;(p as any)._scene = scene
  for (const c of sceneRoot.children ?? []) parseNodeJson(root, strip(c))
  root.updateTransforms(null)
  const walkNodes = (n: Node) => { nodes.push(n); n.children.forEach(walkNodes) }
  root.children.forEach(walkNodes)
  for (const n of nodes) { (n as any)._hasStarted = true; (n as any)._scene = scene }
  // The first step builds the bodies (after stepping), the second puts them in the broadphase.
  p.update(1 / 60)
  p.update(1 / 60)
  // The extent: every node's world position (pass the first call's to the second, so both cast the same rays).
  const min = bounds ? bounds.min : [Infinity, Infinity, Infinity], max = bounds ? bounds.max : [-Infinity, -Infinity, -Infinity]
  if (!bounds) for (const n of nodes) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], n.worldPosition[i]); max[i] = Math.max(max[i], n.worldPosition[i]) }
  const out: (number[] | null)[] = []
  const hit = (from: number[], to: number[]) => {
    const h: any = p.raycast(from as any, to as any)
    out.push(h ? [h.point[0], h.point[1], h.point[2]].map(v => Math.round(v * 1000) / 1000) : null)
  }
  for (let i = 0; i <= rays; i++) for (let j = 0; j <= rays; j++) {
    // Off the round numbers authored geometry sits on: a ray grazing a shape's exact edge hits or misses by rounding.
    const x = min[0] + (max[0] - min[0]) * (i + 0.137) / (rays + 1), z = min[2] + (max[2] - min[2]) * (j + 0.291) / (rays + 1)
    hit([x, max[1] + 5, z], [x, min[1] - 5, z])
  }
  for (const y of [0.513, 1.527, 3.041]) for (let i = 0; i <= rays; i++) {
    const z = min[2] + (max[2] - min[2]) * (i + 0.291) / (rays + 1)
    hit([min[0] - 5, min[1] + y, z], [max[0] + 5, min[1] + y, z])
  }
  // And through every static collider, so a sparse scene (a valley of scattered props) is covered too: down
  // through it, and across it along both axes. Its world position, nudged off the authored round numbers.
  const targets = bounds ? bounds.targets : nodes.filter(n => n.nodeType === 'collider').map(n => [...n.worldPosition].map((v, i) => v + [0.0137, 0.211, 0.0291][i]))
  for (const t of targets) {
    hit([t[0], max[1] + 5, t[2]], [t[0], min[1] - 5, t[2]])
    hit([t[0] - 30, t[1], t[2]], [t[0] + 30, t[1], t[2]])
    hit([t[0], t[1], t[2] - 30], [t[0], t[1], t[2] + 30])
  }
  return { hits: out, bounds: { min, max, targets } }
}

/** Whether two ray results agree: both missed, or both hit within `tolerance` metres (float noise between bodies). */
export function sameHit(a: number[] | null, b: number[] | null, tolerance = 0.002): boolean {
  if (!a || !b) return a === b
  return a.every((v, i) => Math.abs(v - b[i]) <= tolerance)
}
