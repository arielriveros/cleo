// Turn a scene's repeated subtrees into templates, in serialized scene JSON.
//
// A subtree with at least one child that the scene holds more than once becomes a template, and each copy an
// instance of it. Copies that are the same apart from what an instance may hold of its own (its root's
// transform, name, spawn and save flags, and any node's script values) are instances of one template.
// Near-copies (the same nodes, the same assets, but some other value differs: a bigger gem, a tint) become
// VARIANTS of the most common form, each with its own instances.
//
// The copies keep their node ids, so nothing elsewhere in the scene that points at one of their nodes needs
// rewriting, and a save that recorded them still finds them. Each copy is stamped `__templateId`, and what it
// holds of its own is recorded in `__overrides`, the record the editor replays when it rebuilds an instance
// from its template. Pure JSON in and out: used by the example tools (templatizeExamples.ts) and generators.

import { derivedNodeId, diffTemplate, jsonPathMap, materializeVariant, cloneJson, type VariantSource } from '../../applications/editor/src/utils/templateVariants'

const TEMPLATE_ID_VAR = '__templateId'
const OVERRIDES_VAR = '__overrides'
/** What a copy may hold of its own on its root, beyond what the comparison already ignores everywhere. */
const ROOT_OWN = new Set(['position', 'rotation', 'scale', 'name', 'spawnOnStart', 'saved'])
/** Never compared: identity, and what an instance carries per node (script values; inline source follows the script asset). */
const NODE_OWN = new Set(['id', '__sourceId', 'children', 'scriptVars', 'script'])

export interface TemplatizeOptions {
  /** Names already taken by the library's templates. New ones are kept unique against these. */
  takenNames: Set<string>
  /** A stable id for the template of `key` (a description of the family and class). */
  idFor: (key: string) => string
}

export interface MadeTemplate {
  template: VariantSource & { textureIds: string[] }
  /** How many copies became its instances. */
  instances: number
  /** One copy, for the caller to place the template in a folder by what it uses. */
  sample: any
}

export interface TemplatizeResult {
  templates: MadeTemplate[]
  /** One line per family, for review. */
  log: string[]
}

// ----- comparison -----------------------------------------------------------------------------------------

/**
 * One node's content, minus what a copy may hold of its own. A reference to a node of the same subtree (a
 * controller's possessed body, a camera's follow target) reads as that node's path: the ids differ per copy.
 */
function comparable(n: any, isRoot: boolean, idToPath: Map<string, string>): string {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(n).sort()) {
    if (NODE_OWN.has(k)) continue
    if (isRoot && ROOT_OWN.has(k)) continue
    out[k] = n[k]
  }
  // An instance root's own marks: which template it is, and what it overrides.
  if (isRoot && out.variables) {
    const { [TEMPLATE_ID_VAR]: _t, [OVERRIDES_VAR]: _o, ...rest } = out.variables as Record<string, unknown>
    out.variables = rest
  }
  // No variables and an empty set of them are the same thing.
  if (out.variables && !Object.keys(out.variables as object).length) delete out.variables
  return JSON.stringify(out,(_k, v) => typeof v === 'string' && idToPath.has(v) ? '@path:' + idToPath.get(v) : v)
}

/** Every node id of a subtree, to its name path. */
function idPaths(root: any): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of jsonPathMap(root).values()) if (e.node?.id) out.set(e.node.id, e.path)
  return out
}

/** The whole subtree's content, minus what each copy may hold of its own. */
function exactKey(n: any, isRoot = true, idToPath = idPaths(n)): string {
  return comparable(n, isRoot, idToPath) + '[' + (n.children ?? []).map((c: any) => exactKey(c, false, idToPath)).join(',') + ']'
}

/** Asset ids a node names: its `__xxxId` links and its geometry. */
function assetsOf(n: any): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries<any>(n.variables ?? {}))
    if (/^__\w+Id$/.test(k) && k !== TEMPLATE_ID_VAR && typeof v?.value === 'string') out.push(`${k}=${v.value}`)
  if (n.model?.geometry) out.push('geo=' + JSON.stringify(n.model.geometry))
  if (n.sprite?.tilesetId) out.push('tileset=' + n.sprite.tilesetId)
  return out.sort()
}

/** Which nodes, of which types, using which assets: copies that match here are the same thing, maybe tuned differently. */
function familyKey(n: any, isRoot = true): string {
  return `${n.type}|${isRoot ? '' : n.name}|${assetsOf(n).join(',')}[` + (n.children ?? []).map((c: any) => familyKey(c, false)).join(',') + ']'
}

// ----- helpers --------------------------------------------------------------------------------------------

function* walk(n: any): Generator<any> {
  yield n
  for (const c of n.children ?? []) yield* walk(c)
}

const isInstance = (n: any) => !!n?.variables?.[TEMPLATE_ID_VAR]

function collectTextureIds(obj: any, set: Set<string>): void {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) { obj.forEach(o => collectTextureIds(o, set)); return }
  if ('$geo' in obj || '$bin' in obj) return
  for (const [key, val] of Object.entries<any>(obj)) {
    if (key === 'textures' && val && typeof val === 'object' && !Array.isArray(val)) {
      for (const t of Object.values(val)) if (typeof t === 'string' && t) set.add(t)
    } else collectTextureIds(val, set)
  }
}

/**
 * A copy as template content: the root at the origin and named `name`, every node on an id derived from the
 * template and its path, and references between its own nodes moved to those ids.
 */
function asTemplateJson(copy: any, templateId: string, name: string): any {
  const json = cloneJson(copy)
  const ids = new Map<string, string>()
  for (const e of jsonPathMap(json).values()) if (e.node.id) ids.set(e.node.id, derivedNodeId(templateId, e.path))
  const remap = (v: any): any => {
    if (typeof v === 'string') return ids.get(v) ?? v
    if (Array.isArray(v)) return v.map(remap)
    if (v && typeof v === 'object' && !('$geo' in v) && !('$bin' in v)) {
      for (const k of Object.keys(v)) if (k !== 'children') v[k] = remap(v[k])
      return v
    }
    return v
  }
  for (const n of walk(json)) {
    for (const k of Object.keys(n)) if (k !== 'id' && k !== 'children') n[k] = remap(n[k])
    n.id = ids.get(n.id) ?? n.id
  }
  json.name = name
  json.position = [0, 0, 0]
  json.rotation = [0, 0, 0]
  json.scale = [1, 1, 1]
  if (json.variables) { delete json.variables[TEMPLATE_ID_VAR]; delete json.variables[OVERRIDES_VAR] }
  delete json.saved
  return json
}

/** A template's name: what its copies are called, without numbering or the Collider wrapper's suffix. */
function baseName(copies: any[]): string {
  const names = copies.map(c => String(c.name ?? 'Template'))
  const strip = (s: string) => s.replace(/ Collider$/, '')
  if (names.every(n => n === names[0])) return strip(names[0])
  return strip(names[0]).replace(/[\s_-]*\(?\d+\)?$/, '').trim() || strip(names[0])
}

function unique(name: string, taken: Set<string>): string {
  let out = name
  for (let k = 2; taken.has(out); k++) out = `${name} ${k}`
  taken.add(out)
  return out
}

/**
 * Stamp `copy` as an instance of `template`: check it holds exactly the template's content, then record its
 * root name and its script values where they differ, as the editor's overrides.
 */
function linkInstance(template: VariantSource, copy: any): void {
  const want = jsonPathMap(template.nodeJson)
  const got = jsonPathMap(copy)
  const wantIds = idPaths(template.nodeJson), gotIds = idPaths(copy)
  const overrides: Record<string, { name?: string; fields?: Record<string, unknown> }> = {}
  for (const [p, e] of got) {
    const t = want.get(p)?.node
    if (!t) throw new Error(`${copy.name}: "${p}" is not in template "${template.name}"`)
    if (comparable(e.node, p === '', gotIds) !== comparable(t, p === '', wantIds))
      throw new Error(`${copy.name}: "${p || '(root)'}" differs from template "${template.name}" in more than an instance may`)
    const entry: { name?: string; fields?: Record<string, unknown> } = {}
    if (p === '' && e.node.name !== t.name) entry.name = e.node.name
    for (const [field, value] of Object.entries(e.node.scriptVars ?? {}))
      if (JSON.stringify(value) !== JSON.stringify(t.scriptVars?.[field])) (entry.fields ??= {})[field] = value
    if (entry.name !== undefined || entry.fields) overrides[p] = entry
  }
  for (const p of want.keys()) if (!got.has(p)) throw new Error(`${copy.name}: template "${template.name}" has "${p}", the copy does not`)
  copy.variables = { ...(copy.variables ?? {}), [TEMPLATE_ID_VAR]: { type: 'string', value: template.id, access: 'public' } }
  if (Object.keys(overrides).length)
    copy.variables[OVERRIDES_VAR] = { type: 'string', value: JSON.stringify(overrides), access: 'private' }
}

/**
 * Make ONE subtree a template and stamp it, in place, as that template's instance: a character placed once, say,
 * that should still be a template so more can be placed and each can set its own public attributes. `node` keeps
 * its ids and transform; the template gets the content at the origin on ids derived from `id`.
 */
export function templatizeSubtree(node: any, id: string, name: string): MadeTemplate['template'] {
  const template: MadeTemplate['template'] = { id, name, nodeJson: asTemplateJson(node, id, name), scripts: {}, textureIds: [] }
  const tex = new Set<string>()
  collectTextureIds(template.nodeJson, tex)
  template.textureIds = [...tex]
  linkInstance(template, node)
  return template
}

// ----- the pass -------------------------------------------------------------------------------------------

/**
 * Make templates of `sceneRoot`'s repeated subtrees, and stamp their copies as instances, in place. The
 * scene root itself, nodes inside an existing instance, editor-owned nodes (`__…`) and subtrees holding an
 * instance are left alone. Outer copies are taken first: a copy inside another template's copy is part of it.
 */
export function templatizeScene(sceneRoot: any, opts: TemplatizeOptions): TemplatizeResult {
  const depth = new Map<any, number>()
  const parentOf = new Map<any, any>()
  const candidates: any[] = []
  const visit = (n: any, d: number, inInstance: boolean) => {
    depth.set(n, d)
    const inst = inInstance || isInstance(n)
    if (d > 0 && !inst && (n.children ?? []).length && !String(n.name ?? '').startsWith('__')
        && ![...walk(n)].some(x => x !== n && isInstance(x)))
      candidates.push(n)
    for (const c of n.children ?? []) { parentOf.set(c, n); visit(c, d + 1, inst) }
  }
  visit(sceneRoot, 0, false)

  const families = new Map<string, any[]>()
  for (const n of candidates) {
    const key = familyKey(n)
    const list = families.get(key) ?? []
    list.push(n)
    families.set(key, list)
  }

  const taken = new Set<any>()            // nodes inside a copy already made an instance
  const isTaken = (n: any) => { for (let p = n; p; p = parentOf.get(p)) if (taken.has(p)) return true; return false }
  const ordered = [...families.entries()]
    .filter(([, list]) => list.length > 1)
    .sort((a, b) => Math.min(...a[1].map(n => depth.get(n)!)) - Math.min(...b[1].map(n => depth.get(n)!)))

  const result: TemplatizeResult = { templates: [], log: [] }
  for (const [familyId, all] of ordered) {
    const members = all.filter(n => !isTaken(n))
    if (members.length < 2) continue

    // Exact classes, most common first: the first is the base, the rest its variants.
    const classes = new Map<string, any[]>()
    for (const m of members) {
      const k = exactKey(m)
      const list = classes.get(k) ?? []
      list.push(m)
      classes.set(k, list)
    }
    const sorted = [...classes.values()].sort((a, b) => b.length - a.length)

    const baseCopies = sorted[0]
    const baseName_ = unique(baseName(baseCopies), opts.takenNames)
    const baseId = opts.idFor(`${familyId}::base`)
    const base: MadeTemplate['template'] = { id: baseId, name: baseName_, nodeJson: asTemplateJson(baseCopies[0], baseId, baseName_), scripts: {}, textureIds: [] }
    const tex = new Set<string>()
    collectTextureIds(base.nodeJson, tex)
    base.textureIds = [...tex]
    for (const c of baseCopies) linkInstance(base, c)
    result.templates.push({ template: base, instances: baseCopies.length, sample: baseCopies[0] })
    const line = [`${baseName_} ×${baseCopies.length}`]

    for (const copies of sorted.slice(1)) {
      let name = baseName(copies)
      if (name === baseName_ || name === baseName(baseCopies)) name = `${baseName_} ${String.fromCharCode(65 + sorted.indexOf(copies))}`
      name = unique(name, opts.takenNames)
      const id = opts.idFor(`${familyId}::${exactKey(copies[0])}`)
      const candidate: VariantSource = { id, name, nodeJson: asTemplateJson(copies[0], id, name), scripts: {} }
      const diff = diffTemplate(base, candidate)
      const m = materializeVariant(base, id, diff)
      const variant: MadeTemplate['template'] = {
        id, name, nodeJson: m.nodeJson, scripts: m.scripts ?? {}, textureIds: m.textureIds ?? [],
        variant: { baseTemplateId: base.id, diff },
      }
      for (const c of copies) linkInstance(variant, c)
      result.templates.push({ template: variant, instances: copies.length, sample: copies[0] })
      line.push(`variant ${name} ×${copies.length}`)
    }
    for (const m of members) taken.add(m)
    result.log.push(line.join(', '))
  }
  return result
}

// ----- where a template goes in the Assets panel ----------------------------------------------------------

/** Folders that hold one kind of a thing's assets: a template sits beside them, in the thing's own folder. */
const KIND_FOLDER = /\/(Scripts|Materials|Models|Textures|Source|Meshes|Animations|AI)$/

/** The folder for a template: the folder of the first asset its copy uses, else /Templates. */
export function folderFor(made: MadeTemplate, folderOfAsset: Map<string, string>): string {
  const ids: string[] = []
  const visit = (n: any) => {
    if (n.sprite?.tilesetId) ids.push(n.sprite.tilesetId)
    for (const [k, v] of Object.entries<any>(n.variables ?? {}))
      if (/^__\w+Id$/.test(k) && k !== '__scriptId' && k !== '__templateId' && typeof v?.value === 'string') ids.push(v.value)
    for (const c of n.children ?? []) visit(c)
  }
  visit(made.sample)
  const script = made.sample.variables?.__scriptId?.value
  if (script) ids.push(script)
  for (const id of ids) {
    const dir = folderOfAsset.get(id)
    if (dir) return dir.replace(KIND_FOLDER, '') || '/Templates'
  }
  return '/Templates'
}

// ----- checks ---------------------------------------------------------------------------------------------

/**
 * How a placed instance strays from its template, beyond what an instance may hold of its own: one line per
 * node that differs, is missing or is extra. Empty when the editor would rebuild it to exactly what it is.
 */
export function instanceProblems(template: { name: string; nodeJson: any }, copy: any): string[] {
  const want = jsonPathMap(template.nodeJson)
  const got = jsonPathMap(copy)
  const wantIds = idPaths(template.nodeJson), gotIds = idPaths(copy)
  const out: string[] = []
  for (const [p, e] of got) {
    const t = want.get(p)?.node
    if (!t) out.push(`"${p}" is not in template "${template.name}"`)
    else if (comparable(e.node, p === '', gotIds) !== comparable(t, p === '', wantIds)) out.push(`"${p || '(root)'}" differs from template "${template.name}"`)
  }
  for (const p of want.keys()) if (!got.has(p)) out.push(`template "${template.name}" has "${p}", the copy does not`)
  return out
}
