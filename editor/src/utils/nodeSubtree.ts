import { Node, ModelNode, LightNode, SkyboxNode, CameraNode, CameraRigNode, SpriteNode, AnimatedSpriteNode, LodGroupNode } from 'cleo'
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
    case 'lodGroup': (LodGroupNode as any).parse(parent, json); break
    case 'cameraRig': (CameraRigNode as any).parse(parent, json); break
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

/** Node-reference fields that store another node's id and so must be rewritten alongside it. */
const NODE_REF_KEYS = ['followId', 'lookAtId', 'cameraNodeId']

function assignIds(nodeJson: any, map: Map<string, string>): void {
  if (nodeJson?.id) {
    const nid = cryptoRandomId()
    map.set(nodeJson.id, nid)
    nodeJson.id = nid
  }
  if (Array.isArray(nodeJson?.children)) nodeJson.children.forEach((c: any) => assignIds(c, map))
}

/**
 * Rewrite node-reference fields (CameraRigNode's follow/lookAt/camera pins) through an id map.
 *
 * References to nodes OUTSIDE the copied subtree are deliberately left alone: those mean "follow the
 * player that already exists in the scene", which is exactly what should survive an instantiation.
 */
export function remapNodeRefs(nodeJson: any, map: Map<string, string>): void {
  for (const key of NODE_REF_KEYS) {
    const value = nodeJson?.[key]
    if (typeof value === 'string' && map.has(value)) nodeJson[key] = map.get(value)
  }
  if (Array.isArray(nodeJson?.collisionIgnoreIds))
    nodeJson.collisionIgnoreIds = nodeJson.collisionIgnoreIds.map((id: any) =>
      typeof id === 'string' && map.has(id) ? map.get(id) : id)
  if (Array.isArray(nodeJson?.children)) nodeJson.children.forEach((c: any) => remapNodeRefs(c, map))
}

/**
 * Recursively assign fresh ids to a serialized subtree, filling `map` with oldId -> newId.
 *
 * Two passes, and the second is not optional: a node may reference a sibling that has not been
 * renumbered yet, so the references can only be fixed once the whole map exists. Doing the remap in
 * here rather than leaving it to callers means a copied subtree can never silently keep pointing at
 * the original — a template holding a camera rig and its follow target would otherwise have every
 * instance follow the FIRST instance's target.
 */
export function regenerateIds(nodeJson: any, map: Map<string, string>): void {
  assignIds(nodeJson, map)
  remapNodeRefs(nodeJson, map)
}
