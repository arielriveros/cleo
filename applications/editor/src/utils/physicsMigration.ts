import { hasLegacyPhysics, migrateLegacyPhysicsTree } from 'cleo'
import { TEMPLATE_ID_VAR, type Template } from './templates'
import { OVERRIDES_VAR, type TemplateOverrides } from './templateOverrides'
import { cloneJson, diffTemplate, jsonPathMap, materializeVariant } from './templateVariants'

// The editor's half of loading physics saved before colliders and triggers were nodes (player contract
// 37). The engine converts a node's JSON as it parses it (physicsLegacy.ts): a node with a `body` is
// wrapped in a Collider, one with a `trigger` gets a Trigger child. That is all a scene needs, except
// for two things only the editor knows about:
//
//  - TEMPLATES kept their bodies and triggers beside the tree, in id-keyed `bodies` / `triggers` maps,
//    and a variant's diff had sections for them. They are folded into the tree and converted, and a
//    variant's diff is taken again against its converted base.
//  - A placed template INSTANCE is marked on its root (`__templateId`, with its overrides keyed by name
//    path below it). When the conversion wraps that root in a Collider, the Collider is the instance
//    now: the mark moves up to it, and the overrides follow their nodes to their new paths.

/** Whether a serialized subtree still carries physics in the old form anywhere. */
export function subtreeHasLegacyPhysics(json: any): boolean {
  if (!json || typeof json !== 'object') return false
  if (hasLegacyPhysics(json)) return true
  return Array.isArray(json.children) && json.children.some(subtreeHasLegacyPhysics)
}

/** The name of the node a converted template's Collider root wraps: an instance's root node, under it. */
function wrappedRootName(template: Template | undefined): string | undefined {
  const root = template?.nodeJson
  if (root?.type !== 'collider' || !Array.isArray(root.children) || !root.children.length) return undefined
  return typeof root.children[0]?.name === 'string' ? root.children[0].name : undefined
}

/**
 * A placed template instance's subtree converted. `before` is the instance as saved, `after` the
 * engine's conversion of it. When the root was wrapped, the instance mark and its overrides move up to
 * the Collider; overrides recorded for a node that now sits deeper follow it there.
 */
function adoptInstance(before: any, after: any, innerName: string | undefined): any {
  const wrapped = after.type === 'collider' && before.type !== 'collider'
  const inner = wrapped ? after.children[0] : after
  const vars = inner.variables ?? {}
  const overridesVar = vars[OVERRIDES_VAR]

  // Where each node of the instance is now, as a path below the instance root. A wrapped root's own node
  // is under the Collider, under the name the template gives it (the instance's own may be overridden).
  const newPathById = new Map<string, string>()
  if (wrapped) {
    const prefix = innerName ?? String(inner.name ?? '')
    for (const [p, e] of jsonPathMap(inner)) if (e.node?.id) newPathById.set(e.node.id, p === '' ? prefix : `${prefix}/${p}`)
  } else {
    for (const [p, e] of jsonPathMap(after)) if (e.node?.id) newPathById.set(e.node.id, p)
  }

  let remapped: string | undefined
  if (overridesVar && typeof overridesVar.value === 'string') {
    try {
      const old = JSON.parse(overridesVar.value) as TemplateOverrides
      const oldIdAt = new Map([...jsonPathMap(before)].map(([p, e]) => [p, e.node?.id as string | undefined]))
      const next: TemplateOverrides = {}
      for (const [path, o] of Object.entries(old ?? {})) {
        // The root's name is the instance's name: the instance is the Collider now, and keeps it.
        if (path === '' && typeof o.name === 'string') next[''] = { ...next[''], name: o.name }
        if (!o.fields) continue
        const id = oldIdAt.get(path)
        const to = (id && newPathById.get(id)) ?? path
        next[to] = { ...next[to], fields: o.fields }
      }
      remapped = JSON.stringify(next)
    } catch { /* an unreadable record stays as it was */ }
  }

  if (!wrapped) {
    if (remapped !== undefined) inner.variables = { ...vars, [OVERRIDES_VAR]: { ...overridesVar, value: remapped } }
    return after
  }
  const { [TEMPLATE_ID_VAR]: mark, [OVERRIDES_VAR]: _overrides, ...rest } = vars
  inner.variables = rest
  after.variables = {
    ...(after.variables ?? {}),
    ...(mark ? { [TEMPLATE_ID_VAR]: mark } : {}),
    ...(overridesVar ? { [OVERRIDES_VAR]: remapped !== undefined ? { ...overridesVar, value: remapped } : overridesVar } : {}),
  }
  return after
}

/**
 * A serialized scene tree with its physics in the node form. `templates` names what each placed instance
 * was made from, so an instance's overrides land on the paths the converted template gives its nodes.
 * Returns `json` itself when there was nothing to convert.
 */
export function migrateScenePhysics(json: any, templates: readonly Template[] = []): any {
  if (!subtreeHasLegacyPhysics(json)) return json
  const byId = new Map(templates.map(t => [t.id, t]))
  const visit = (node: any): any => {
    if (!node || typeof node !== 'object' || !subtreeHasLegacyPhysics(node)) return node
    const templateId = node.variables?.[TEMPLATE_ID_VAR]?.value
    if (typeof templateId === 'string' && templateId) {
      const before = cloneJson(node)
      return adoptInstance(before, migrateLegacyPhysicsTree(node), wrappedRootName(byId.get(templateId)))
    }
    // This node first (it may be wrapped or given a Trigger child), then what is under it, which now
    // includes the node itself when it was wrapped: its conversion is a no-op the second time.
    const out = migrateLegacyPhysicsTree({ ...node, children: [] })
    const kids: any[] = Array.isArray(node.children) ? node.children.map(visit) : []
    if (out.type === 'collider' && node.type !== 'collider') {
      const inner = out.children[0]
      // The Trigger child the conversion may have given the node goes after its own children.
      out.children = [{ ...inner, children: [...kids, ...(inner.children ?? [])] }, ...out.children.slice(1)]
    } else {
      out.children = [...kids, ...(out.children ?? [])]
    }
    return out
  }
  return visit(json)
}

/** Whether a template (or its diff, for a variant) still has physics in the old form. */
function templateHasLegacyPhysics(t: Template): boolean {
  if (Object.keys(t.bodies ?? {}).length || Object.keys(t.triggers ?? {}).length) return true
  const diff = t.variant?.diff
  if (diff && (Object.keys(diff.bodies ?? {}).length || Object.keys(diff.triggers ?? {}).length)) return true
  return subtreeHasLegacyPhysics(t.nodeJson)
}

/** A template's tree with its legacy body/trigger maps put back on their nodes, then converted. */
function convertedTree(t: Template): any {
  const json = cloneJson(t.nodeJson)
  const bodies = t.bodies ?? {}, triggers = t.triggers ?? {}
  const put = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.id === 'string') {
      if (bodies[node.id]) node.body = cloneJson(bodies[node.id])
      if (triggers[node.id]) node.trigger = cloneJson(triggers[node.id])
    }
    for (const c of node.children ?? []) put(c)
  }
  put(json)
  return migrateLegacyPhysicsTree(json)
}

/**
 * The template library with every template's physics in the node form, or null when none needed it.
 * A variant is re-based on its converted base: its diff is taken again between the two converted trees,
 * so its body and trigger changes become changes to the Collider and Trigger nodes they now are.
 */
export function migrateTemplatePhysics(templates: readonly Template[]): Template[] | null {
  const byId = new Map(templates.map(t => [t.id, t]))
  // A variant must be re-diffed when anything it inherits from was converted: its paths moved.
  const needs = new Map<string, boolean>()
  const needsOf = (t: Template, seen = new Set<string>()): boolean => {
    if (needs.has(t.id)) return needs.get(t.id)!
    let out = templateHasLegacyPhysics(t)
    const base = t.variant ? byId.get(t.variant.baseTemplateId) : undefined
    if (!out && base && !seen.has(t.id)) { seen.add(t.id); out = needsOf(base, seen) }
    needs.set(t.id, out)
    return out
  }
  if (!templates.some(t => needsOf(t))) return null

  const done = new Map<string, Template>()
  const convert = (t: Template, stack = new Set<string>()): Template => {
    const hit = done.get(t.id)
    if (hit) return hit
    let out: Template
    if (!needsOf(t)) out = t
    else {
      const { bodies: _b, triggers: _t, ...rest } = t
      const tree = convertedTree(t)
      const baseSrc = t.variant ? byId.get(t.variant.baseTemplateId) : undefined
      if (!t.variant || !baseSrc || stack.has(baseSrc.id)) {
        // A plain template, or a variant whose base is gone: its content is all there is.
        const plain: Template = { ...rest, nodeJson: tree }
        if (plain.variant) {
          const { bodies: _db, triggers: _dt, ...diff } = plain.variant.diff
          plain.variant = { ...plain.variant, diff: { ...diff, version: 2 } }
        }
        out = plain
      } else {
        stack.add(t.id)
        const base = convert(baseSrc, stack)
        stack.delete(t.id)
        // Both roots wrapped: the node under the Collider keeps the base's name, so it (and everything
        // under it) stays inherited rather than reading as removed and added. The variant's own name is
        // the Collider's.
        const baseInner = wrappedRootName(base)
        if (baseInner !== undefined && tree.type === 'collider' && t.nodeJson?.type !== 'collider' && tree.children?.[0])
          tree.children[0].name = baseInner
        const diff = diffTemplate(base, { ...rest, nodeJson: tree })
        out = { ...rest, ...materializeVariant(base, t.id, diff), variant: { baseTemplateId: base.id, diff } }
      }
    }
    done.set(t.id, out)
    return out
  }
  return templates.map(t => convert(t))
}
