import type { Node, Scene } from 'cleo'
import { nodePath, userChildren, walkUserNodes } from './nodeRefs'

// Turning live engine objects into text an agent can read cheaply, and agent input back into assignments.
// Pure (no editor state) so it is unit-tested against real nodes.

/** Numbers as an agent wants to read them: no 0.30000000000000004. */
export function round(v: number, places = 4): number {
  const f = 10 ** places
  const r = Math.round(v * f) / f
  return Object.is(r, -0) ? 0 : r
}

const isNumericArray = (v: unknown): v is ArrayLike<number> =>
  (ArrayBuffer.isView(v) && !(v instanceof DataView)) || (Array.isArray(v) && v.every(x => typeof x === 'number'))

/** A value small and plain enough to show and to set: a primitive, or a short numeric vector. */
export function simpleValue(v: unknown): unknown {
  if (v === null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? round(v) : undefined
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.length <= 300 ? v : undefined
  if (isNumericArray(v) && v.length > 0 && v.length <= 16) return Array.from(v as ArrayLike<number>, x => round(x))
  return undefined
}

// Not offered as `props`: transform and identity have their own fields, the rest is structure or engine
// plumbing whose setters are not meant to be poked from outside.
const SKIP_PROPS = new Set([
  'constructor', 'parent', 'children', 'name', 'id', 'nodeType', 'position', 'rotation', 'scale', 'visible',
  'quaternion', 'worldPosition', 'worldRotation', 'worldScale', 'worldTransform', 'localTransform', 'matrix',
  'scene', 'body', 'trigger', 'velocity', 'onUpdate', 'onStart', 'script',
  // Editor bookkeeping and per-frame runtime readouts: never something to author.
  'editorOnly', 'editorOwned', 'isTerrainChunk', 'cameraVisible', 'cameraDistance', 'angularVelocity', 'movementDirection',
])
// Objects reached through a getter whose own settable fields are worth listing as "key.field".
const NESTED_LIMIT = 24

function settableOwn(target: object, prefix: string, out: Record<string, unknown>, limit: number, nested: boolean) {
  const seen = new Set<string>()
  const add = (key: string, value: unknown) => {
    if (Object.keys(out).length >= limit) return
    const s = simpleValue(value)
    if (s !== undefined) out[prefix + key] = s
  }
  // Accessors with a setter, from the most derived class up.
  for (let proto = Object.getPrototypeOf(target); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (seen.has(key) || key.startsWith('_') || SKIP_PROPS.has(key)) continue
      seen.add(key)
      if (!d.get) continue
      let value: unknown
      try { value = (target as any)[key] } catch { continue }
      if (d.set) { add(key, value); continue }
      // A getter-only object (LightNode.light, CameraNode.camera): list ITS settable fields one level down.
      if (nested && value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Array.isArray(value)
        && !(value instanceof Map) && !(value instanceof Set) && !('children' in (value as object))) {
        settableOwn(value as object, `${prefix}${key}.`, out, Math.min(limit, Object.keys(out).length + NESTED_LIMIT), false)
      }
    }
  }
  // Plain public fields (and a class script's native fields).
  for (const key of Object.keys(target)) {
    if (seen.has(key) || key.startsWith('_') || SKIP_PROPS.has(key)) continue
    const value = (target as any)[key]
    if (typeof value === 'function') continue
    add(key, value)
  }
}

/** The node's settable properties and their current values: what scene_edit `props` accepts. */
export function settableProps(node: Node, limit = 120): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  settableOwn(node, '', out, limit, true)
  return out
}

function hasSetter(target: object, key: string): boolean {
  for (let p = Object.getPrototypeOf(target); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, key)
    if (d) return !!d.set
  }
  return false
}

/**
 * Assign `value` at a dotted property path on `node`, checking it exists and keeps its kind (a number stays
 * a number, a vector stays a vector of the same length). Throws a message naming what is wrong. With
 * `dryRun` it only checks, so a batch can be validated before any of it is applied.
 */
export function applyProp(node: Node, path: string, value: unknown, dryRun = false): void {
  const parts = path.split('.')
  let target: any = node
  for (const part of parts.slice(0, -1)) {
    const next = target?.[part]
    if (next === null || typeof next !== 'object') throw new Error(`"${path}": "${part}" is not an object on ${node.nodeType} "${node.name}".`)
    target = next
  }
  const key = parts[parts.length - 1]
  if (key.startsWith('_')) throw new Error(`"${path}" is internal.`)
  if (!(key in target)) throw new Error(`"${path}" is not a property of ${node.nodeType} "${node.name}". node_get lists its props.`)
  const current = target[key]
  if (typeof current === 'function') throw new Error(`"${path}" is a method, not a property.`)
  if (typeof current === 'number' && typeof value !== 'number') throw new Error(`"${path}" is a number; got ${JSON.stringify(value)}.`)
  if (typeof current === 'boolean' && typeof value !== 'boolean') throw new Error(`"${path}" is a boolean; got ${JSON.stringify(value)}.`)
  if (isNumericArray(current)) {
    if (!isNumericArray(value) || value.length !== current.length)
      throw new Error(`"${path}" is a vector of ${current.length} numbers; got ${JSON.stringify(value)}.`)
    // A typed-array FIELD is written in place (other code holds the same array); a setter gets the value.
    if (dryRun) return
    if (ArrayBuffer.isView(current) && !hasSetter(target, key)) { (current as any).set(value); return }
  }
  if (dryRun) return
  target[key] = value
}

/**
 * A serialized node made readable: vertex buffers, images and long strings replaced by short markers, so
 * one model does not cost the agent a million tokens.
 */
export function elide(v: unknown, depth = 0): unknown {
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const a = v as unknown as ArrayLike<number>
    return a.length <= 16 ? Array.from(a, x => round(x)) : `<${v.constructor.name} x${a.length}>`
  }
  if (Array.isArray(v)) {
    if (v.length > 32 && v.every(x => typeof x === 'number')) return `<number[] x${v.length}>`
    const head = v.slice(0, 100).map(x => elide(x, depth + 1))
    return v.length > 100 ? [...head, `<… ${v.length - 100} more>`] : head
  }
  if (typeof v === 'string') {
    if (v.startsWith('data:')) return `<data URL, ${Math.round(v.length / 1024)} KB>`
    return v.length > 1500 ? `${v.slice(0, 1500)}… <${v.length} chars>` : v
  }
  if (typeof v === 'number') return Number.isFinite(v) ? round(v) : v
  if (v && typeof v === 'object') {
    if (depth > 10) return '<…>'
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = elide(x, depth + 1)
    return out
  }
  return v
}

export interface OutlineOptions {
  root: Node
  depth: number
  limit: number
  type?: string
  name?: string
  /** Extra tags for a node: script=..., body, trigger... */
  flags?: (node: Node) => string[]
}

/**
 * The scene as indented lines, `Name [type] flags`. With a `type`/`name` filter it is a flat search
 * result of full paths instead. Sibling names that collide carry their id, since a path cannot tell
 * them apart.
 */
export function outline(scene: Scene, opts: OutlineOptions): { text: string; shown: number; total: number } {
  const lines: string[] = []
  const flags = opts.flags ?? (() => [])
  const tag = (n: Node) => {
    const f = flags(n)
    return `[${n.nodeType}]${f.length ? ' ' + f.join(' ') : ''}`
  }
  let total = 0
  let shown = 0

  if (opts.type || opts.name) {
    const needle = opts.name?.toLowerCase()
    walkUserNodes(opts.root, n => {
      if (opts.type && n.nodeType !== opts.type) return
      if (needle && !n.name.toLowerCase().includes(needle)) return
      total++
      if (shown >= opts.limit) return
      shown++
      lines.push(`${nodePath(n, scene.root)} ${tag(n)} #${n.id}`)
    })
    const head = `${total} match${total === 1 ? '' : 'es'}${shown < total ? ` (showing ${shown})` : ''}:`
    return { text: [head, ...lines].join('\n'), shown, total }
  }

  const visit = (node: Node, level: number) => {
    const kids = userChildren(node)
    const counts = new Map<string, number>()
    for (const k of kids) counts.set(k.name, (counts.get(k.name) ?? 0) + 1)
    for (const child of kids) {
      total++
      if (shown >= opts.limit) continue
      shown++
      const dup = (counts.get(child.name) ?? 0) > 1 ? ` #${child.id}` : ''
      const grand = userChildren(child).length
      const more = level + 1 >= opts.depth && grand ? ` (+${countAll(child)} below)` : ''
      lines.push(`${'  '.repeat(level)}${child.name} ${tag(child)}${dup}${more}`)
      if (level + 1 < opts.depth) visit(child, level + 1)
    }
  }
  visit(opts.root, 0)
  const rootPath = nodePath(opts.root, scene.root)
  const head = `${rootPath}${opts.root === scene.root ? ' (scene root)' : ` [${opts.root.nodeType}]`}`
  const tail = shown < total ? [`… cut at ${opts.limit} lines; zoom in with root/depth or search with type/name.`] : []
  return { text: [head, ...lines, ...tail].join('\n'), shown, total }
}

function countAll(node: Node): number {
  let n = 0
  walkUserNodes(node, () => { n++ })
  return n
}
