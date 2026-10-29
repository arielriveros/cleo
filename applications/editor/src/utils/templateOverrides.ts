import { Node } from 'cleo'
import { deepClone } from '@cleo/app-kit/utils/deepClone'
import { TEMPLATE_ID_VAR, templateInstanceRootOf } from './templates'

// Per-instance OVERRIDES of a placed template: what a placement changed on top of its template, so a
// rebuild from the template (an edit to it, a resync on open, a publish) reproduces the placement
// instead of resetting it.
//
// Stored as JSON in one variable on the instance root, keyed by each node's NAME PATH below that root
// ('' is the root itself). Name paths survive a rebuild, ids do not: every rebuild regenerates them.
//
// What can be overridden:
//   - the ROOT's name. Children keep their template names, which is what keeps their paths stable and
//     what scripts look them up by;
//   - class-script field values, on the root or any descendant (`node[field]`, the native property the
//     inspector edits and buildGameData writes out as `scriptVars`).
// Structure (children, scripts, components) stays the template's.
//
// At play and publish time the record is inert: the instance's inline subtree already holds the values.

export const OVERRIDES_VAR = '__overrides'

export interface NodeOverride {
  name?: string
  fields?: Record<string, unknown>
}
export type TemplateOverrides = Record<string, NodeOverride>

/** The overrides recorded on an instance root. Empty for a node without any, or with unreadable JSON. */
export function readOverrides(root: Node): TemplateOverrides {
  const raw = root.getVariable(OVERRIDES_VAR)
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Replace the record. An empty one removes the variable, so an untouched instance carries nothing. */
export function writeOverrides(root: Node, overrides: TemplateOverrides): void {
  const clean: TemplateOverrides = {}
  for (const [path, o] of Object.entries(overrides)) {
    const entry: NodeOverride = {}
    if (path === '' && typeof o.name === 'string') entry.name = o.name
    if (o.fields && Object.keys(o.fields).length) entry.fields = o.fields
    if (entry.name !== undefined || entry.fields) clean[path] = entry
  }
  if (Object.keys(clean).length === 0) { root.removeVariable(OVERRIDES_VAR); return }
  root.setVariable(OVERRIDES_VAR, JSON.stringify(clean), 'string', 'private')
}

// A path segment is the child's name, with `#k` for the k-th (k >= 1) later sibling sharing it, so two
// children both called "Light" stay distinguishable.
function segmentOf(child: Node): string {
  const parent = child.parent
  if (!parent) return child.name
  let k = 0
  for (const sibling of parent.children) {
    if (sibling === child) break
    if (sibling.name === child.name) k++
  }
  return k === 0 ? child.name : `${child.name}#${k}`
}

/** `node`'s name path below `root` ('' for the root), or null when it is not inside it. */
export function pathOf(root: Node, node: Node): string | null {
  const parts: string[] = []
  let n: Node | null = node
  while (n && n !== root) {
    parts.unshift(segmentOf(n))
    n = n.parent
  }
  return n === root ? parts.join('/') : null
}

/** The node at `path` below `root`, or null when the template no longer has it. */
export function nodeAtPath(root: Node, path: string): Node | null {
  if (path === '') return root
  let n: Node | null = root
  for (const part of path.split('/')) {
    if (!n) return null
    const hash = part.lastIndexOf('#')
    const index = hash > 0 && /^\d+$/.test(part.slice(hash + 1)) ? Number(part.slice(hash + 1)) : 0
    const name = index > 0 ? part.slice(0, hash) : part
    let k = 0
    let found: Node | null = null
    for (const child of n.children as Node[]) {
      if (child.name !== name) continue
      if (k === index) { found = child; break }
      k++
    }
    n = found
  }
  return n
}

/** The instance root `node` belongs to, and its path there — or null outside any instance. */
export function overrideTarget(node: Node): { root: Node; path: string } | null {
  const root = templateInstanceRootOf(node)
  if (!root) return null
  const path = pathOf(root, node)
  return path === null ? null : { root, path }
}

/** Record that `node`'s script field `field` is overridden with `value`. No-op outside an instance. */
export function setFieldOverride(node: Node, field: string, value: unknown): void {
  const target = overrideTarget(node)
  if (!target) return
  const overrides = readOverrides(target.root)
  const entry = overrides[target.path] ?? {}
  entry.fields = { ...(entry.fields ?? {}), [field]: deepClone(value) }
  overrides[target.path] = entry
  writeOverrides(target.root, overrides)
}

/** Record the instance root's own name. Only the root's name can be overridden. */
export function setNameOverride(root: Node, name: string): void {
  if (!root.getVariable(TEMPLATE_ID_VAR)) return
  const overrides = readOverrides(root)
  overrides[''] = { ...(overrides[''] ?? {}), name }
  writeOverrides(root, overrides)
}

/** Forget one field override of `node`, its name override (`field` = 'name' on the root), or all of its. */
export function clearOverride(node: Node, field?: string): void {
  const target = overrideTarget(node)
  if (!target) return
  const overrides = readOverrides(target.root)
  const entry = overrides[target.path]
  if (!entry) return
  if (field === undefined) delete overrides[target.path]
  else if (field === 'name' && target.path === '') delete entry.name
  else if (entry.fields) delete entry.fields[field]
  writeOverrides(target.root, overrides)
}

/** Whether `node`'s `field` (or its name, for 'name' on the root) is overridden. */
export function isOverridden(node: Node, field: string): boolean {
  const target = overrideTarget(node)
  if (!target) return false
  const entry = readOverrides(target.root)[target.path]
  if (!entry) return false
  if (field === 'name' && target.path === '') return entry.name !== undefined
  return !!entry.fields && field in entry.fields
}

/** Every override recorded on `root`, counted (name and each field). */
export function overrideCount(root: Node): number {
  let n = 0
  for (const entry of Object.values(readOverrides(root))) {
    if (entry.name !== undefined) n++
    n += Object.keys(entry.fields ?? {}).length
  }
  return n
}

/**
 * Put the recorded overrides back onto a (freshly rebuilt) instance. Returns the paths that no longer
 * exist in the template: those are KEPT in the record, so a template edit that drops a child and a later
 * one that restores it does not lose the placement's values in between.
 */
export function applyOverrides(root: Node): string[] {
  const stale: string[] = []
  for (const [path, entry] of Object.entries(readOverrides(root))) {
    const node = nodeAtPath(root, path)
    if (!node) { stale.push(path); continue }
    if (path === '' && typeof entry.name === 'string' && entry.name) node.name = entry.name
    for (const [field, value] of Object.entries(entry.fields ?? {})) (node as any)[field] = deepClone(value)
  }
  return stale
}
