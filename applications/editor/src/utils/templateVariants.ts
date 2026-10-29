import { isBinaryPayload } from './binaryPayload'

// TEMPLATE VARIANTS: a template based on another template. The variant records only what it changes —
// a structured diff against its base, keyed by node NAME PATH — and inherits everything else, so an edit
// to the base flows into every variant that did not override it.
//
// A variant ALSO stores the materialized result (`nodeJson`, `scripts`, `bodies`, `triggers`, `textureIds`)
// exactly like a plain template. Everything downstream — instantiate, the scene resync, hashing, bake and
// publish — reads only that, so none of it knows variants exist. The diff is consulted only to rebuild
// the materialized copy when the base changes, and to tell inherited values from overridden ones.
//
// Pure JSON in, JSON out, and no imports beyond a sibling with none, so the example generators can load
// this file directly and produce byte-for-byte what the editor would.
//
// Paths: the same scheme as templateOverrides — a child's name, with `#k` for the k-th later sibling of
// the same name; '' is the root. A renamed child therefore reads as removed + added (it stops inheriting).

/** What a variant changes on one inherited node. */
export interface NodePatch {
  /** A deep merge-patch over the base node: plain objects merge key by key, anything else replaces. */
  merge?: Record<string, unknown>
  /** Keys the variant removed, each as a key path into the node (['scriptVars', 'speed']). */
  unset?: string[][]
}

/** A subtree the variant adds. `node` carries no ids; `parent` is a path in the variant. */
export interface AddedSubtree { parent: string; index: number; node: any }

export interface TemplateDiff {
  version: 1
  nodes: Record<string, NodePatch>
  added: AddedSubtree[]
  /** Base paths the variant drops (top-most only: a removed node takes its subtree). */
  removed: string[]
  /** Out-of-band per-node data the variant sets (a value) or drops (null), by path. */
  bodies: Record<string, unknown>
  triggers: Record<string, unknown>
  /** Inline script sources (nodes without a shared script asset), by path. */
  scripts: Record<string, string | null>
}

/** The template fields a variant materializes. Structural, so the editor's `Template` satisfies it. */
export interface VariantSource {
  id: string
  name: string
  nodeJson: any
  textureIds?: string[]
  scripts: Record<string, string>
  bodies: Record<string, any>
  triggers: Record<string, any>
  variant?: { baseTemplateId: string; diff: TemplateDiff }
}

export type Materialized = Pick<VariantSource, 'nodeJson' | 'scripts' | 'bodies' | 'triggers' | 'textureIds'>

// Node-reference keys, as in the engine's nodeJson.ts. A reference to a node INSIDE the template is
// compared and stored as a path, since ids differ between a base and its variant.
const NODE_REF_KEYS = ['followId', 'lookAtId', 'cameraNodeId', 'uiTargetId', 'focusTargetId',
                       'possessedId', 'aimSourceId', 'navMeshId']
const REF_PREFIX = '@path:'
/** Keys that are identity or structure, never diffed. */
const SKIP_KEYS = new Set(['id', '__sourceId', 'children'])
const SCRIPT_ID_VAR = '__scriptId'

export function emptyDiff(): TemplateDiff {
  return { version: 1, nodes: {}, added: [], removed: [], bodies: {}, triggers: {}, scripts: {} }
}

// ── path walking ─────────────────────────────────────────────────────────────────────────────────────

interface Entry { node: any; parent: any | null; path: string }

function segment(siblings: any[], child: any): string {
  let k = 0
  for (const s of siblings) {
    if (s === child) break
    if (s?.name === child?.name) k++
  }
  return k === 0 ? String(child?.name ?? '') : `${child?.name}#${k}`
}

/** Every node of a serialized subtree by name path, in pre-order. */
export function jsonPathMap(root: any): Map<string, Entry> {
  const out = new Map<string, Entry>()
  const walk = (node: any, parent: any | null, path: string) => {
    out.set(path, { node, parent, path })
    const kids: any[] = Array.isArray(node?.children) ? node.children : []
    for (const c of kids) {
      const seg = segment(kids, c)
      walk(c, node, path === '' ? seg : `${path}/${seg}`)
    }
  }
  if (root) walk(root, null, '')
  return out
}

function parentPath(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

// ── value helpers ────────────────────────────────────────────────────────────────────────────────────

function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)
}

/** Deep copy that keeps typed arrays typed (sliced, never shared). */
export function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value)) return (value as any).slice()
  if (Array.isArray(value)) return value.map(cloneJson) as any
  const out: any = {}
  for (const key of Object.keys(value as any)) out[key] = cloneJson((value as any)[key])
  return out
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  const av = ArrayBuffer.isView(a), bv = ArrayBuffer.isView(b)
  if (av || bv) {
    if (!av || !bv || (a as any).constructor !== (b as any).constructor) return false
    const x = a as any, y = b as any
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && !(x[i] !== x[i] && y[i] !== y[i])) return false
    return true
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const y = b as unknown[]
    if (a.length !== y.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], y[i])) return false
    return true
  }
  const ka = Object.keys(a as object), kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!(k in (b as object)) || !deepEqual((a as any)[k], (b as any)[k])) return false
  return true
}

/** A node's diffable view: identity/structure keys dropped, in-template references as path tokens. */
function view(node: any, idToPath: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(node ?? {})) {
    if (SKIP_KEYS.has(key)) continue
    out[key] = refOut(key, node[key], idToPath)
  }
  return out
}

function refOut(key: string, value: unknown, idToPath: Map<string, string>): unknown {
  if (NODE_REF_KEYS.includes(key) && typeof value === 'string' && idToPath.has(value))
    return REF_PREFIX + idToPath.get(value)
  // A UI root keeps its world anchor inside its `ui` payload.
  if (key === 'ui' && isPlain(value) && typeof value.uiTargetId === 'string' && idToPath.has(value.uiTargetId))
    return { ...value, uiTargetId: REF_PREFIX + idToPath.get(value.uiTargetId) }
  if (key === 'collisionIgnoreIds' && Array.isArray(value))
    return value.map(id => typeof id === 'string' && idToPath.has(id) ? REF_PREFIX + idToPath.get(id) : id)
  return value
}

function refIn(json: any, pathToId: Map<string, string>): void {
  const back = (v: unknown) =>
    typeof v === 'string' && v.startsWith(REF_PREFIX) ? (pathToId.get(v.slice(REF_PREFIX.length)) ?? '') : v
  for (const key of NODE_REF_KEYS) if (key in (json ?? {})) json[key] = back(json[key])
  if (Array.isArray(json?.collisionIgnoreIds)) json.collisionIgnoreIds = json.collisionIgnoreIds.map(back)
  if (isPlain(json?.ui) && typeof json.ui.uiTargetId === 'string') json.ui.uiTargetId = back(json.ui.uiTargetId)
}

function setAt(target: Record<string, unknown>, keys: string[], value: unknown): void {
  let t: any = target
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlain(t[keys[i]])) t[keys[i]] = {}
    t = t[keys[i]]
  }
  t[keys[keys.length - 1]] = value
}

function diffInto(a: Record<string, unknown>, b: Record<string, unknown>, prefix: string[], patch: Required<NodePatch>): void {
  for (const key of Object.keys(b)) {
    const keys = [...prefix, key]
    if (!(key in a)) { setAt(patch.merge, keys, cloneJson(b[key])); continue }
    if (isPlain(a[key]) && isPlain(b[key])) { diffInto(a[key] as any, b[key] as any, keys, patch); continue }
    if (!deepEqual(a[key], b[key])) setAt(patch.merge, keys, cloneJson(b[key]))
  }
  for (const key of Object.keys(a)) if (!(key in b)) patch.unset.push([...prefix, key])
}

function applyMerge(target: any, merge: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(merge)) {
    if (isPlain(value) && isPlain(target[key])) applyMerge(target[key], value)
    else target[key] = cloneJson(value)
  }
}

function applyUnset(target: any, keys: string[]): void {
  let t = target
  for (let i = 0; i < keys.length - 1; i++) { t = t?.[keys[i]]; if (!isPlain(t)) return }
  if (isPlain(t)) delete t[keys[keys.length - 1]]
}

function stripIds(json: any): void {
  if (!json || typeof json !== 'object') return
  delete json.id
  delete json.__sourceId
  for (const c of json.children ?? []) stripIds(c)
}

function scriptIdOf(json: any): string | undefined {
  const v = json?.variables?.[SCRIPT_ID_VAR]?.value
  return typeof v === 'string' && v ? v : undefined
}

/** A stable 32-hex id for the node at `path` of variant `variantId` (four seeded FNV-1a passes). */
export function derivedNodeId(variantId: string, path: string): string {
  const key = `${variantId}/${path}`
  let out = ''
  for (let seed = 0; seed < 4; seed++) {
    let h = (0x811c9dc5 ^ (seed * 0x9e3779b1)) >>> 0
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    out += h.toString(16).padStart(8, '0')
  }
  return out
}

function collectTextureIds(obj: any, set: Set<string>): void {
  if (!obj || typeof obj !== 'object' || isBinaryPayload(obj)) return
  if (Array.isArray(obj)) { obj.forEach(o => collectTextureIds(o, set)); return }
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (isBinaryPayload(val)) continue
    if (key === 'textures' && isPlain(val)) {
      for (const t of Object.values(val)) if (typeof t === 'string' && t) set.add(t)
    } else collectTextureIds(val, set)
  }
}

// ── diff ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What `candidate` changes relative to `base`. Inherited nodes (same path, same node type) get a patch;
 * nodes only in the candidate become added subtrees; nodes only in the base are removed.
 */
export function diffTemplate(base: VariantSource, candidate: VariantSource): TemplateDiff {
  const diff = emptyDiff()
  const bMap = jsonPathMap(base.nodeJson)
  const cMap = jsonPathMap(candidate.nodeJson)
  const bIdToPath = new Map([...bMap.values()].filter(e => e.node?.id).map(e => [e.node.id as string, e.path]))
  const cIdToPath = new Map([...cMap.values()].filter(e => e.node?.id).map(e => [e.node.id as string, e.path]))
  const inherited = (path: string) => {
    const b = bMap.get(path), c = cMap.get(path)
    return !!b && !!c && b.node?.type === c.node?.type
  }
  const addedPaths = new Set<string>()

  for (const [path, c] of cMap) {
    if (inherited(path)) {
      const patch: Required<NodePatch> = { merge: {}, unset: [] }
      diffInto(view(bMap.get(path)!.node, bIdToPath), view(c.node, cIdToPath), [], patch)
      const out: NodePatch = {}
      if (Object.keys(patch.merge).length) out.merge = patch.merge
      if (patch.unset.length) out.unset = patch.unset
      if (out.merge || out.unset) diff.nodes[path] = out
      continue
    }
    // A subtree is recorded once, at its top; its descendants travel inside it.
    addedPaths.add(path)
    if (path !== '' && addedPaths.has(parentPath(path))) continue
    const siblings: any[] = c.parent?.children ?? []
    const node = cloneJson(c.node)
    const normalize = (src: any, dst: any) => {
      for (const key of [...NODE_REF_KEYS, 'collisionIgnoreIds', 'ui']) if (key in src) dst[key] = refOut(key, src[key], cIdToPath)
      ;(src.children ?? []).forEach((child: any, i: number) => normalize(child, dst.children[i]))
    }
    normalize(c.node, node)
    stripIds(node)
    diff.added.push({ parent: parentPath(path), index: siblings.indexOf(c.node), node })
  }

  for (const path of bMap.keys()) {
    if (inherited(path)) continue
    if (path !== '' && diff.removed.some(r => path.startsWith(r + '/'))) continue
    diff.removed.push(path)
  }

  // Out-of-band data, by path. Added nodes contribute whatever they carry.
  for (const [path, c] of cMap) {
    const cid = c.node?.id
    const bid = inherited(path) ? bMap.get(path)!.node?.id : undefined
    for (const kind of ['bodies', 'triggers'] as const) {
      const cv = cid ? (candidate[kind] ?? {})[cid] : undefined
      const bv = bid ? (base[kind] ?? {})[bid] : undefined
      if (!deepEqual(cv ?? null, bv ?? null)) diff[kind][path] = cv === undefined ? null : cloneJson(cv)
    }
    // A node on a shared script asset takes its source from the asset; only inline sources diff.
    if (scriptIdOf(c.node)) continue
    const cs = cid ? (candidate.scripts ?? {})[cid] : undefined
    const bs = bid ? (base.scripts ?? {})[bid] : undefined
    if ((cs ?? null) !== (bs ?? null)) diff.scripts[path] = cs ?? null
  }
  return diff
}

// ── materialize ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The variant's full template content: the base with the diff applied, every node on an id derived from
 * the variant and its path (unique across templates, and stable, so an unchanged result hashes the same).
 * Patches and removals whose path the base no longer has are skipped, and stay in the diff.
 */
export function materializeVariant(base: VariantSource, variantId: string, diff: TemplateDiff): Materialized {
  const root = cloneJson(base.nodeJson)
  const bMap = jsonPathMap(root)
  const baseIdToPath = new Map([...bMap.values()].filter(e => e.node?.id).map(e => [e.node.id as string, e.path]))
  const baseScriptId = new Map([...bMap.values()].filter(e => e.node?.id).map(e => [e.node.id as string, scriptIdOf(e.node)]))

  // Normalize in-template references to paths before anything moves.
  for (const e of bMap.values()) {
    for (const key of [...NODE_REF_KEYS, 'collisionIgnoreIds', 'ui']) if (key in e.node) e.node[key] = refOut(key, e.node[key], baseIdToPath)
  }

  // Resolve every target against the UNTOUCHED base first: removing one `Light` renumbers its `#k` siblings.
  const removals = diff.removed.map(p => bMap.get(p)).filter((e): e is Entry => !!e && e.path !== '')
  const patches = Object.entries(diff.nodes).map(([p, patch]) => [bMap.get(p), patch] as const)
  for (const e of removals) {
    const kids: any[] = e.parent?.children ?? []
    const i = kids.indexOf(e.node)
    if (i >= 0) kids.splice(i, 1)
  }
  const removedSet = new Set(removals.map(e => e.node))
  for (const [e, patch] of patches) {
    if (!e || removedSet.has(e.node)) continue
    if (patch.merge) applyMerge(e.node, patch.merge)
    for (const keys of patch.unset ?? []) applyUnset(e.node, keys)
  }
  // Added subtrees in variant pre-order, each parent resolved against the tree as it now stands.
  for (const a of diff.added) {
    const parent = jsonPathMap(root).get(a.parent)?.node
    if (!parent) continue
    if (!Array.isArray(parent.children)) parent.children = []
    parent.children.splice(Math.min(Math.max(0, a.index), parent.children.length), 0, cloneJson(a.node))
  }

  // Ids: derived per path. Remember each inherited node's BASE id to re-key its out-of-band data.
  const finalMap = jsonPathMap(root)
  const pathToId = new Map<string, string>()
  const baseIdAt = new Map<string, string | undefined>()
  for (const [path, e] of finalMap) {
    baseIdAt.set(path, e.node.id)
    const id = derivedNodeId(variantId, path)
    pathToId.set(path, id)
    e.node.id = id
    delete e.node.__sourceId
  }
  for (const e of finalMap.values()) refIn(e.node, pathToId)

  const scripts: Record<string, string> = {}
  const bodies: Record<string, any> = {}
  const triggers: Record<string, any> = {}
  for (const [path, e] of finalMap) {
    const id = pathToId.get(path)!
    const bid = baseIdAt.get(path)
    for (const [kind, out] of [['bodies', bodies], ['triggers', triggers]] as const) {
      const value = path in diff[kind] ? diff[kind][path] : (bid ? (base[kind] ?? {})[bid] : undefined)
      if (value !== undefined && value !== null) out[id] = cloneJson(value)
    }
    let source = path in diff.scripts ? diff.scripts[path] : (bid ? (base.scripts ?? {})[bid] : undefined)
    // A cached source belongs to the base's script asset; a variant that swapped the asset must not keep it.
    if (!(path in diff.scripts) && bid && scriptIdOf(e.node) !== baseScriptId.get(bid))
      source = undefined
    if (typeof source === 'string') scripts[id] = source
  }

  const textures = new Set<string>()
  collectTextureIds(root, textures)
  return { nodeJson: root, scripts, bodies, triggers, textureIds: [...textures] }
}

// ── library operations ───────────────────────────────────────────────────────────────────────────────

/** A new variant of `base`: no changes but its name. */
export function createVariant<T extends VariantSource>(base: T, name: string, id: string): T {
  const diff = emptyDiff()
  diff.nodes[''] = { merge: { name } }
  return { ...base, id, name, ...materializeVariant(base, id, diff), variant: { baseTemplateId: base.id, diff } }
}

/** The variants based directly on `id`. */
export function variantsOf<T extends VariantSource>(templates: T[], id: string): T[] {
  return templates.filter(t => t.variant?.baseTemplateId === id)
}

/**
 * Re-materialize every variant descending from `changedId`, base before variant, from the library as
 * given (which must already hold the changed template). Returns only the records that were rebuilt.
 * A cycle — impossible through the UI, possible in a hand-edited bundle — is cut and reported.
 */
export function cascadeFrom<T extends VariantSource>(templates: T[], changedId: string, warn: (msg: string) => void = () => {}): T[] {
  const latest = new Map(templates.map(t => [t.id, t]))
  const visited = new Set<string>([changedId])
  const queue = [changedId]
  const out: T[] = []
  while (queue.length) {
    const baseId = queue.shift()!
    const base = latest.get(baseId)
    if (!base) continue
    for (const v of variantsOf([...latest.values()], baseId)) {
      if (visited.has(v.id)) { warn(`Template variant cycle through "${v.name}" — not re-materialized`); continue }
      visited.add(v.id)
      const next = { ...v, ...materializeVariant(base, v.id, v.variant!.diff) }
      latest.set(v.id, next)
      out.push(next)
      queue.push(v.id)
    }
  }
  return out
}

/**
 * Save an edited variant: diff the edited tree against the base AS IT WAS WHEN THE TAB OPENED, then lay
 * that diff over the base as it is now — so a base edit made meanwhile is not frozen into overrides.
 */
export function saveVariant<T extends VariantSource>(variant: T, edited: VariantSource, baseAtOpen: VariantSource, currentBase: VariantSource): T {
  const diff = diffTemplate(baseAtOpen, edited)
  return {
    ...variant,
    name: edited.name,
    ...materializeVariant(currentBase, variant.id, diff),
    variant: { baseTemplateId: currentBase.id, diff },
  }
}

/** A variant cut loose from its base: it keeps its materialized content as a plain template. */
export function flattenVariant<T extends VariantSource>(variant: T): T {
  const { variant: _drop, ...rest } = variant
  return rest as T
}

/** The base node a variant node inherits from, 'added' for one the variant introduced, or null. */
export function baseNodeAt(base: VariantSource, diff: TemplateDiff, path: string): any | 'added' | null {
  if (diff.removed.some(r => path === r || path.startsWith(r + '/'))) return 'added'
  const hit = jsonPathMap(base.nodeJson).get(path)
  return hit ? hit.node : 'added'
}

/**
 * The diff with `path`'s own changes dropped — its patch and its out-of-band data (body, trigger, inline
 * script) — so that node goes back to inheriting everything from the base. Added and removed nodes are
 * structure, not values, and stay. With no `path`, every node's changes go. The root's NAME always stays.
 */
export function revertInDiff(diff: TemplateDiff, path?: string): TemplateDiff {
  const out: TemplateDiff = cloneJson(diff)
  const drop = (p: string) => {
    delete out.nodes[p]
    delete out.bodies[p]
    delete out.triggers[p]
    delete out.scripts[p]
  }
  // The variant keeps being called what it is called, whatever is reverted.
  const name = (diff.nodes['']?.merge as any)?.name
  if (path !== undefined) drop(path)
  else for (const p of new Set([...Object.keys(out.nodes), ...Object.keys(out.bodies), ...Object.keys(out.triggers), ...Object.keys(out.scripts)])) drop(p)
  if (typeof name === 'string' && (path === undefined || path === '')) out.nodes[''] = { merge: { name } }
  return out
}

/** Whether the variant changes any value on the node at `path` (not counting the root's name). */
export function hasOwnChanges(diff: TemplateDiff, path: string): boolean {
  const patch = diff.nodes[path]
  const merge = { ...(patch?.merge ?? {}) }
  if (path === '') delete (merge as any).name
  return Object.keys(merge).length > 0 || !!patch?.unset?.length
    || path in diff.bodies || path in diff.triggers || path in diff.scripts
}

/**
 * A new variant of `base` whose content is `instance` — a placed copy, with whatever it changed on top of
 * the template (its overrides) becoming the variant's own changes.
 */
export function variantFromContent<T extends VariantSource>(base: T, content: VariantSource, id: string, name: string): T {
  const diff = diffTemplate(base, { ...content, nodeJson: { ...content.nodeJson, name } })
  return { ...base, id, name, ...materializeVariant(base, id, diff), variant: { baseTemplateId: base.id, diff } }
}
/** `id` and every template that descends from it through variants — what a variant must not be rebased onto. */
export function lineageOf<T extends VariantSource>(templates: T[], id: string): Set<string> {
  const out = new Set<string>([id])
  const queue = [id]
  while (queue.length) for (const v of variantsOf(templates, queue.shift()!)) if (!out.has(v.id)) { out.add(v.id); queue.push(v.id) }
  return out
}

/**
 * The same variant, based on `newBase` instead: its CONTENT stays exactly what it is now, and its diff is
 * recomputed against the new base — so from here on it follows that one. Refuses (returns null) a base
 * that is the variant itself or descends from it, which would make a cycle.
 */
export function rebaseVariant<T extends VariantSource>(templates: T[], variant: T, newBase: T): T | null {
  if (lineageOf(templates, variant.id).has(newBase.id)) return null
  return variantFromContent(newBase, variant, variant.id, variant.name)
}
