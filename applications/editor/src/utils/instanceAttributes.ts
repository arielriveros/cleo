import type { Node } from 'cleo'
import { TEMPLATE_ID_VAR } from './templates'
import { pathOf, setFieldOverride } from './templateOverrides'
import type { ScriptAsset, ScriptVarSchema } from './scripts'

// Which script attributes a placed template instance may set, and where they show.
//
// The script decides, by each field's own accessor: a `public` attribute (or one with no modifier) is the
// CHARACTER's, so every placement of the template sets its own (a Player's walk speed scale, its camera's
// arm length); a `private` or `protected` one is the BEHAVIOR's, set once in the template for every placement
// (how the stick feels, how long a camera switch takes).
//
// The instance root's Behaviors panel lists, after the root's own behavior, the public attributes of every
// behavior INSIDE it, so a character's whole per-placement set is edited in one place without selecting
// (or even seeing) the nodes that carry it. Each value is recorded as an override at that node's name path
// (templateOverrides.ts), so it survives every rebuild from the template.

/** The tooltip on an attribute a placement cannot set. */
export const INSTANCE_LOCKED_TIP = 'Set in the template: this attribute belongs to the behavior, not the character'

/** Whether a placed instance may set `v`: a shown attribute the script declares public. */
export function settableOnInstance(v: ScriptVarSchema): boolean {
  return !v.hidden && !v.ref && v.access === 'public'
}

/**
 * Set `v` on `node` (inside an instance) as that placement's override. Refuses, changing nothing, an
 * attribute the placement may not set. Returns whether it was set.
 */
export function setInstanceAttribute(node: Node, v: ScriptVarSchema, value: unknown): boolean {
  if (!settableOnInstance(v)) return false
  ;(node as unknown as Record<string, unknown>)[v.name] = value
  setFieldOverride(node, v.name, value)
  return true
}

/** A node inside an instance whose behavior has attributes the placement may set. */
export interface InnerAttributeSection {
  node: Node
  /** Its name path below the instance root: where its overrides are recorded, and its section's heading. */
  path: string
  asset: ScriptAsset
  /** The attributes the placement may set, in declaration order. */
  fields: ScriptVarSchema[]
}

/**
 * Every node below the instance `root` (not the root itself) whose behavior has public attributes, in tree
 * order. A template instance nested inside it is skipped, whole: its attributes are its own placement's, set
 * by selecting it.
 */
export function innerAttributeSections(root: Node, assetOf: (node: Node) => ScriptAsset | undefined): InnerAttributeSection[] {
  const out: InnerAttributeSection[] = []
  const visit = (node: Node) => {
    for (const child of node.children as Node[]) {
      if (child.getVariable(TEMPLATE_ID_VAR)) continue
      const asset = assetOf(child)
      const fields = asset ? asset.variables.filter(settableOnInstance) : []
      const path = pathOf(root, child)
      if (asset && fields.length && path !== null) out.push({ node: child, path, asset, fields })
      visit(child)
    }
  }
  visit(root)
  return out
}
