import {
  Camera2DNode, Node, declarationOf, declarationsOf, isAssetRef, isNodePathRef, propertyTypeLabel, readProperty,
  resolveProperty, shownProperties, storedValueFits, writeProperty,
  type PropertyDeclaration, type PropertyType, type Scene,
} from 'cleo'
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
  'wantsPhysicsBuild', 'grounded', 'isJumping', 'velocity2D',
  // A second name for detectTriggers.
  'detectAreas',
])
/**
 * Getter-only objects NOT to list one level down: a Character Body 2D's `intent` and `tuning` mirror its own
 * fields and are rebuilt each frame, a sequence node's `bindings` must go through bind() (it keeps a slot
 * cache), and a sprite's `sprite` repeats the node's own accessors. Writing any of them does nothing lasting.
 */
const SKIP_NESTED = new Set(['intent', 'tuning', 'bindings', 'sprite'])

/** A nested object of `target` that settableProps leaves out (see SKIP_NESTED). */
function skipNested(target: object, key: string): boolean {
  if (SKIP_NESTED.has(key)) return true
  // A Camera 2D sizes its projection from pixelsPerUnit and zoom every frame: its camera's extents are output.
  return key === 'camera' && target instanceof Camera2DNode
}
// Objects reached through a getter whose own settable fields are worth listing as "key.field".
const NESTED_LIMIT = 24

function settableOwn(target: object, prefix: string, out: Record<string, unknown>, limit: number, nested: boolean) {
  const seen = new Set<string>()
  const add = (key: string, value: unknown) => {
    if (Object.keys(out).length >= limit || prefix + key in out) return
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
        && !(value instanceof Map) && !(value instanceof Set) && !('children' in (value as object)) && !skipNested(target, key)) {
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

// ----- Declared rows (src/properties): what the node's inspector shows, with its labels and types --------------

/** A declared row's value as an agent reads it: plain, or the stored `{ $asset, id }` / `{ $nodePath }` of a link. */
function rowValue(v: unknown): unknown {
  const s = simpleValue(v)
  if (s !== undefined) return s
  if (isAssetRef(v) || isNodePathRef(v)) return v
  if (Array.isArray(v)) return v.map(x => simpleValue(x) ?? (isAssetRef(x) || isNodePathRef(x) ? x : null))
  return undefined
}

/** The declared rows of the node's own cards: every node's Transform has op fields of its own. */
function ownRows(node: Node) {
  const transform = declarationOf(null, Node)
  return shownProperties(node).filter(r => r.decl !== transform)
}

/** One row of a node's inspector: what it is called there, its type, its value. */
export interface InspectorRow { label: string; type: string; value: unknown; readonly?: true }

/**
 * The rows the node's inspector shows now, by the key scene_edit `props` takes: each with its label there (`Light ›
 * Emission › Color`), its type (Color, Vec3, Material, a node class, ...) and its value.
 */
export function inspectorRows(node: Node): Record<string, InspectorRow> {
  const out: Record<string, InspectorRow> = {}
  for (const { decl, section, prop } of ownRows(node)) {
    if (prop.key in out) continue
    const p = resolveProperty(prop, node)
    const value = rowValue(readProperty(node, prop))
    if (value === undefined) continue
    out[prop.key] = {
      label: [decl.title, section.title, p.label].filter(Boolean).join(' › '), type: propertyTypeLabel(p.type), value,
      ...(p.readonly ? { readonly: true as const } : {}),
    }
  }
  return out
}

/** The declared row of `node` at `key` (shown or not), with its type, or null. */
export function declaredRow(node: Node, key: string): { prop: PropertyDeclaration; type: PropertyType } | null {
  const transform = declarationOf(null, Node)
  for (const decl of declarationsOf(node)) {
    if (decl === transform) continue
    for (const s of decl.sections) for (const prop of s.props)
      if (prop.key === key) return { prop, type: resolveProperty(prop, node).type }
  }
  return null
}

/** The node's settable properties and their current values: what scene_edit `props` accepts. Its inspector's rows first. */
export function settableProps(node: Node, limit = 120): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { prop } of ownRows(node)) {
    if (Object.keys(out).length >= limit || prop.readonly || prop.key in out) continue
    const value = rowValue(readProperty(node, prop))
    if (value !== undefined) out[prop.key] = value
  }
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

/** Edit distance between two strings (insert, delete, substitute), case-insensitive. */
export function editDistance(a: string, b: string): number {
  a = a.toLowerCase(); b = b.toLowerCase()
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

/** The candidates nearest `name`: those containing it (or its last segment), then those a few edits away. */
export function nearestNames(name: string, candidates: Iterable<string>, max = 5): string[] {
  const lower = name.toLowerCase()
  const scored: { c: string; d: number }[] = []
  for (const c of candidates) {
    const tail = c.slice(c.lastIndexOf('.') + 1)
    const contains = c.toLowerCase().includes(lower) || (tail.length > 2 && lower.includes(tail.toLowerCase()))
    const d = contains ? 0 : Math.min(editDistance(name, c), editDistance(name, tail))
    if (d <= Math.max(2, Math.floor(name.length / 3))) scored.push({ c, d })
  }
  return scored.sort((x, y) => x.d - y.d || x.c.length - y.c.length).slice(0, max).map(x => x.c)
}

/** Why a property cannot be set through `props`, with what to use instead: an asset link has its own field. */
const LINK_HINTS: Record<string, string> = {
  tileset: 'link a tileset with the op field assets: {"tileset": "<name>"}',
  animationSet: "an animated sprite's clips come with its tileset: assets: {\"tileset\": \"<name>\"}",
  sequence: 'link a sequence with assets: {"sequence": "<name>"}',
  material: 'set it with the op field material',
  socketAttachment: 'attach to a socket from a script (engine_api {"query":"socket attach"})',
  controller: 'a Controller node above or beside it drives it',
}

/**
 * Assign `value` at a dotted property path on `node`, checking it exists and keeps its kind: a number stays
 * a number, a boolean a boolean, a string a string, a vector a vector of the same length. An object or an
 * empty (null) slot is never replaced from here: those are links and structures with their own fields and
 * setters, and a string written over one breaks the node. Throws a message naming what is wrong, with the
 * nearest property names for a miss. With `dryRun` it only checks, so a batch can be validated before any
 * of it is applied.
 */
export function applyProp(node: Node, path: string, value: unknown, dryRun = false): void {
  // A row of its inspector is written as the inspector writes it: through the row's setter, which keeps the
  // node's invariants (a clamp, a cone wider than another, a vehicle rebuilt).
  const row = declaredRow(node, path)
  if (row) {
    const { prop, type } = row
    const what = `"${path}" on ${node.nodeType} "${node.name}"`
    if (prop.readonly) throw new Error(`${what} is read-only.`)
    const fits = storedValueFits(type, value)
      && (type.kind !== 'number' || Number.isFinite(value as number))
      && (type.kind !== 'choice' || type.values.includes(value as string))
    // A choice's type lists its values: 'rect' | 'disk'.
    if (!fits) throw new Error(`${what} is ${type.kind === 'choice' ? 'one of' : 'a'} ${propertyTypeLabel(type)}; got ${JSON.stringify(value)}.`)
    if (!dryRun) writeProperty(node, prop, value)
    return
  }
  const parts = path.split('.')
  let target: any = node
  for (const part of parts.slice(0, -1)) {
    const next = target?.[part]
    if (next === null || typeof next !== 'object') throw new Error(`"${path}": "${part}" is not an object on ${node.nodeType} "${node.name}".`)
    target = next
  }
  const key = parts[parts.length - 1]
  if (key.startsWith('_')) throw new Error(`"${path}" is internal.`)
  if (!(key in target)) {
    const near = nearestNames(path, Object.keys(settableProps(node, 400)))
    throw new Error(`"${path}" is not a property of ${node.nodeType} "${node.name}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} node_get lists its props.`)
  }
  const current = target[key]
  const what = `"${path}" on ${node.nodeType} "${node.name}"`
  if (typeof current === 'function') throw new Error(`"${path}" is a method, not a property.`)
  if (typeof current === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`"${path}" is a number; got ${JSON.stringify(value)}.`)
  if (typeof current === 'boolean' && typeof value !== 'boolean') throw new Error(`"${path}" is a boolean; got ${JSON.stringify(value)}.`)
  if (typeof current === 'string' && typeof value !== 'string') throw new Error(`"${path}" is a string; got ${JSON.stringify(value)}.`)
  // An empty slot takes a plain value (an id, a name), but never one of the known object links: a string
  // written over a sprite's empty tileset is a broken sprite.
  if (current === null && LINK_HINTS[key])
    throw new Error(`${what} is empty (null): it holds an object, not a value props can set. Instead, ${LINK_HINTS[key]}.`)
  if ((current === null || current === undefined) && value !== null && typeof value === 'object' && !isNumericArray(value))
    throw new Error(`${what} is unset; props sets numbers, booleans, strings and number vectors, not objects.`)
  if (isNumericArray(current)) {
    // A short or typed vector keeps its length (a position, a colour); a longer plain list (frames) may change.
    const fixed = ArrayBuffer.isView(current) || (current as ArrayLike<number>).length <= 4
    if (!isNumericArray(value) || (fixed && value.length !== current.length))
      throw new Error(`"${path}" is a vector of ${current.length} numbers; got ${JSON.stringify(value)}.`)
    // A typed-array FIELD is written in place (other code holds the same array); a setter gets the value.
    if (dryRun) return
    if (ArrayBuffer.isView(current) && !hasSetter(target, key)) { (current as any).set(value); return }
  } else if (Array.isArray(current)) {
    // A list of strings (names, tags) takes another list of strings; a list of objects is structure.
    const strings = current.every(x => typeof x === 'string')
    if (!strings || !Array.isArray(value) || !value.every(x => typeof x === 'string'))
      throw new Error(`${what} is a list${strings ? ' of strings' : ' of objects, which props cannot set'}; got ${JSON.stringify(value)}.`)
  } else if (current && typeof current === 'object') {
    const hint = LINK_HINTS[key]
    const fields = Object.keys(settableProps(node, 400)).filter(k => k.startsWith(`${path}.`)).slice(0, 8)
    throw new Error(`${what} is an object; ${hint ?? (fields.length ? `set its fields by dotted path: ${fields.join(', ')}` : 'props cannot replace it')}.`)
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
  /** Every line carries its node's id, not only lines whose name a sibling shares. */
  ids?: boolean
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
      const dup = opts.ids || (counts.get(child.name) ?? 0) > 1 ? ` #${child.id}` : ''
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
