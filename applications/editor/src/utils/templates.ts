import { Node, TextureManager } from 'cleo'
import { cryptoRandomId } from './ids'
import { parseByType, stripDebug, collectIds, collectTextureIds, regenerateIds } from './nodeSubtree'
import { resolveMaterialRefs, MaterialAsset } from './materials'
import { deepClone } from '@cleo/app-kit/utils/deepClone'
import { getScriptIdOf, collectScriptVars, scriptKindOfAsset, type ScriptAsset } from './scripts'
import type { TemplateDiff } from './templateVariants'

// A reusable node template: a serialized node subtree plus every asset/script it depends on.
export type Template = {
  id: string
  name: string
  nodeJson: any                       // serialized node subtree (children + model/material/variables)
  /** TextureManager ids this subtree references. The payloads live in the texture store (textureStore.ts). */
  textureIds?: string[]
  /** Legacy: textures embedded as base64 ([{ id, data, config }]). Still read; never written. */
  textures?: any[]
  scripts: Record<string, string>     // originalNodeId -> script source
  bodies: Record<string, any>         // originalNodeId -> BodyDescription
  triggers: Record<string, any>       // originalNodeId -> { shapes }
  /**
   * Present on a VARIANT: the template it is based on and what it changes (templateVariants.ts). The
   * fields above stay the MATERIALIZED result, so nothing that instantiates or publishes reads this.
   */
  variant?: { baseTemplateId: string; diff: TemplateDiff }
}

type EngineMaps = {
  scripts: Map<string, string>
  bodies: Map<string, any>
  triggers: Map<string, any>
}

// Node variable name used to link a placed instance back to its source template.
export const TEMPLATE_ID_VAR = '__templateId'

/** Walk up to the placed-instance root (nearest ancestor, or self, carrying __templateId), or null. */
export function templateInstanceRootOf(node: Node | null | undefined): Node | null {
  let n: Node | null | undefined = node
  while (n) {
    if (n.getVariable(TEMPLATE_ID_VAR)) return n
    n = n.parent
  }
  return null
}

/** True if `node` or any ancestor is a placed template instance (carries the __templateId marker). */
export function isWithinTemplateInstance(node: Node | null | undefined): boolean {
  return !!templateInstanceRootOf(node)
}

/**
 * Build a Template capturing a node's subtree + its assets and out-of-band script/body/trigger data.
 *
 * `scriptAssets` lets it capture class-script FIELD VALUES too. They live as native properties on the
 * nodes and `serialize()` does not see them, so without the library a template saved from the editor
 * reverted every field to its class default — undoing whatever the template was configured with.
 */
export async function buildTemplateFromNode(node: Node, maps: EngineMaps, scriptAssets?: ScriptAsset[]): Promise<Template> {
  const nodeJson = await node.serialize()
  stripDebug(nodeJson)
  if (scriptAssets) attachScriptVars(node, nodeJson, new Map(scriptAssets.map(a => [a.id, a])))
  // A template definition must never carry an instance back-link; strip the __templateId the editing
  // scene stamped onto the root.
  if (nodeJson.variables) delete nodeJson.variables[TEMPLATE_ID_VAR]

  const ids = collectIds(nodeJson)
  const scripts: Record<string, string> = {}
  const bodies: Record<string, any> = {}
  const triggers: Record<string, any> = {}
  for (const id of ids) {
    const s = maps.scripts.get(id); if (s) scripts[id] = s
    const b = maps.bodies.get(id); if (b) bodies[id] = b
    const t = maps.triggers.get(id); if (t) triggers[id] = t
  }

  // Only the texture IDS; the payloads live once in the texture store (textureStore.ts).
  const texIds = new Set<string>()
  collectTextureIds(nodeJson, texIds)

  return { id: cryptoRandomId(), name: node.name, nodeJson, textureIds: [...texIds], scripts, bodies, triggers }
}

// Walk the live subtree and its serialized twin together (serialize keeps child order), writing each
// scripted node's field values as the `scriptVars` the engine restores on parse.
function attachScriptVars(live: Node, json: any, assets: Map<string, ScriptAsset>): void {
  const sid = getScriptIdOf(live)
  const asset = sid ? assets.get(sid) : undefined
  if (asset && scriptKindOfAsset(asset) !== 'module') {
    const vars = collectScriptVars(live, asset)
    if (Object.keys(vars).length) json.scriptVars = deepClone(vars)
  }
  const kids = (json.children ?? []) as any[]
  for (const child of live.children as Node[]) {
    const twin = kids.find(k => k.id === child.id)
    if (twin) attachScriptVars(child, twin, assets)
  }
}

/**
 * Instantiate a template under `parent`, regenerating ids and restoring assets/scripts.
 * Returns the new root id.
 * `materials` re-resolves the subtree's __materialId links against the library, so the instance gets the
 * current material rather than the copy frozen into the template. Omit it to keep the embedded copies.
 */
export function instantiateTemplate(template: Template, parent: Node, maps: EngineMaps, materials?: MaterialAsset[]): string {
  const clone = deepClone(template.nodeJson)
  if (materials) resolveMaterialRefs(clone, materials)
  const idMap = new Map<string, string>()
  regenerateIds(clone, idMap)

  // Tag the instance root: read-only in Scene mode, and re-synced when the template is edited.
  // Persists via the node's serialized `variables`.
  clone.variables = { ...(clone.variables || {}), [TEMPLATE_ID_VAR]: { type: 'string', value: template.id } }

  // Only legacy templates carry embedded base64; current ones take their textures from the store.
  for (const t of template.textures || []) {
    if (!TextureManager.Instance.getTexture(t.id))
      TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id)
  }

  // Re-key out-of-band data onto the new ids.
  for (const [oldId, newId] of idMap) {
    if (template.scripts[oldId]) maps.scripts.set(newId, template.scripts[oldId])
    if (template.bodies[oldId]) maps.bodies.set(newId, template.bodies[oldId])
    if (template.triggers[oldId]) maps.triggers.set(newId, template.triggers[oldId])
  }
  // A source carried INLINE on a node (a bundle authored by a generator does this) goes to the map too,
  // exactly as a scene's does on load (extractNodeState). Left on the node, the parse would compile it
  // with no script path, and any relative import in it (`./SoulsMath`) would fail in the editor.
  const lift = (n: any) => {
    if (typeof n?.script === 'string') {
      if (n.script.trim() && !maps.scripts.has(n.id)) maps.scripts.set(n.id, n.script)
      delete n.script
    }
    for (const c of n?.children ?? []) lift(c)
  }
  lift(clone)

  parseByType(parent, clone)
  return clone.id
}
