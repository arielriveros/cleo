import { Node, ModelNode, LightNode, SkyboxNode, CameraNode, SpriteNode, AnimatedSpriteNode, TextureManager } from 'cleo'
import { cryptoRandomId } from './UIModel'

// Base Node.parse always creates a plain Node; dispatch by type so a template rooted at any
// node subclass (model/light/sprite/...) is reconstructed correctly (mirrors Node._commonParse).
function parseByType(parent: Node, json: any): void {
  switch (json.type) {
    case 'model': (ModelNode as any).parse(parent, json); break
    case 'light': (LightNode as any).parse(parent, json); break
    case 'skybox': (SkyboxNode as any).parse(parent, json); break
    case 'camera': (CameraNode as any).parse(parent, json); break
    case 'sprite': (SpriteNode as any).parse(parent, json); break
    case 'animatedSprite': (AnimatedSpriteNode as any).parse(parent, json); break
    default: (Node as any).parse(parent, json)
  }
}

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

// Remove editor/debug helper children so templates only contain user content.
function stripDebug(nodeJson: any): void {
  if (Array.isArray(nodeJson.children)) {
    nodeJson.children = nodeJson.children.filter((c: any) =>
      !(String(c.name).includes('__debug__') || String(c.name).includes('__editor__')))
    nodeJson.children.forEach(stripDebug)
  }
}

function collectIds(nodeJson: any, out: string[] = []): string[] {
  if (nodeJson?.id) out.push(nodeJson.id)
  if (Array.isArray(nodeJson?.children)) nodeJson.children.forEach((c: any) => collectIds(c, out))
  return out
}

// Collect every texture id referenced anywhere in the subtree (material.textures maps).
function collectTextureIds(obj: any, set: Set<string>): void {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) { obj.forEach(o => collectTextureIds(o, set)); return }
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (key === 'textures' && val && typeof val === 'object' && !Array.isArray(val)) {
      for (const t of Object.values(val)) if (typeof t === 'string' && t) set.add(t)
    } else {
      collectTextureIds(val, set)
    }
  }
}

// Recursively assign fresh ids, returning the oldId -> newId map.
function regenerateIds(nodeJson: any, map: Map<string, string>): void {
  if (nodeJson?.id) {
    const nid = cryptoRandomId()
    map.set(nodeJson.id, nid)
    nodeJson.id = nid
  }
  if (Array.isArray(nodeJson?.children)) nodeJson.children.forEach((c: any) => regenerateIds(c, map))
}

/** Build a Template capturing a node's subtree + its assets and out-of-band script/body/trigger data. */
export async function buildTemplateFromNode(node: Node, maps: EngineMaps): Promise<Template> {
  const nodeJson = await node.serialize()
  stripDebug(nodeJson)

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
