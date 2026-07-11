import { Node, TextureManager } from 'cleo'
import { cryptoRandomId } from './UIModel'
import { parseByType, stripDebug, collectIds, collectTextureIds, regenerateIds } from './nodeSubtree'

// A reusable node template: a serialized node subtree plus every asset/script it depends on.
export type Template = {
  id: string
  name: string
  nodeJson: any                       // serialized node subtree (children + model/material/variables)
  textures: any[]                     // [{ id, data, config }] snapshots from TextureManager
  scripts: Record<string, string>     // originalNodeId -> script source
  bodies: Record<string, any>         // originalNodeId -> BodyDescription
  triggers: Record<string, any>       // originalNodeId -> { shapes }
}

type EngineMaps = {
  scripts: Map<string, string>
  bodies: Map<string, any>
  triggers: Map<string, any>
}

// Node variable name used to link a placed instance back to its source template.
export const TEMPLATE_ID_VAR = '__templateId'

/** True if `node` or any ancestor is a placed template instance (carries the __templateId marker). */
export function isWithinTemplateInstance(node: Node | null | undefined): boolean {
  let n: Node | null | undefined = node
  while (n) {
    if (n.getVariable(TEMPLATE_ID_VAR)) return true
    n = n.parent
  }
  return false
}

/** Build a Template capturing a node's subtree + its assets and out-of-band script/body/trigger data. */
export async function buildTemplateFromNode(node: Node, maps: EngineMaps): Promise<Template> {
  const nodeJson = await node.serialize()
  stripDebug(nodeJson)
  // A template definition must never carry an instance back-link (the editing scene instantiates the
  // template, which stamps __templateId onto the root); strip it so it isn't baked into the definition.
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

  const texIds = new Set<string>()
  collectTextureIds(nodeJson, texIds)
  const allTextures: any[] = (TextureManager.Instance as any).serializeTextureData?.() ?? []
  const textures = allTextures.filter((t: any) => texIds.has(t.id))

  return { id: cryptoRandomId(), name: node.name, nodeJson, textures, scripts, bodies, triggers }
}

/** Instantiate a template under `parent`, regenerating ids and restoring assets/scripts. Returns the new root id. */
export function instantiateTemplate(template: Template, parent: Node, maps: EngineMaps): string {
  const clone = JSON.parse(JSON.stringify(template.nodeJson))
  const idMap = new Map<string, string>()
  regenerateIds(clone, idMap)

  // Tag the instance root so it can be recognized as a template instance (read-only in Scene mode)
  // and re-synced when the template is edited. Persists via the node's serialized `variables`.
  clone.variables = { ...(clone.variables || {}), [TEMPLATE_ID_VAR]: { type: 'string', value: template.id } }

  // Restore any textures not already present.
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

  parseByType(parent, clone)
  return clone.id
}
