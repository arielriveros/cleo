import { Node, ModelNode, LightNode, SkyboxNode, CameraNode, SpriteNode, AnimatedSpriteNode } from 'cleo'
import { cryptoRandomId } from './UIModel'

// Shared helpers for serialized node subtrees, used by both the Template and Mesh asset systems.
// Kept here (rather than duplicated) so template instances and imported meshes reconstruct identically.

/**
 * Base Node.parse always creates a plain Node; dispatch by type so a subtree rooted at any node
 * subclass (model/light/sprite/...) is reconstructed correctly (mirrors Node._commonParse).
 * ModelNode.parse itself detects animated vs static models, so animated meshes round-trip here.
 */
export function parseByType(parent: Node, json: any): void {
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

/** Remove editor/debug helper children so an asset only contains user content. */
export function stripDebug(nodeJson: any): void {
  if (Array.isArray(nodeJson.children)) {
    nodeJson.children = nodeJson.children.filter((c: any) =>
      !(String(c.name).includes('__debug__') || String(c.name).includes('__editor__')))
    nodeJson.children.forEach(stripDebug)
  }
}

/** Collect every node id present in a serialized subtree. */
export function collectIds(nodeJson: any, out: string[] = []): string[] {
  if (nodeJson?.id) out.push(nodeJson.id)
  if (Array.isArray(nodeJson?.children)) nodeJson.children.forEach((c: any) => collectIds(c, out))
  return out
}

/** Collect every texture id referenced anywhere in the subtree (material.textures maps). */
export function collectTextureIds(obj: any, set: Set<string>): void {
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

/** Recursively assign fresh ids to a serialized subtree, returning the oldId -> newId map. */
export function regenerateIds(nodeJson: any, map: Map<string, string>): void {
  if (nodeJson?.id) {
    const nid = cryptoRandomId()
    map.set(nodeJson.id, nid)
    nodeJson.id = nid
  }
  if (Array.isArray(nodeJson?.children)) nodeJson.children.forEach((c: any) => regenerateIds(c, map))
}
