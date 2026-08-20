import { parseNodeJson, collectNodeIds, regenerateNodeIds, remapNodeRefs as engineRemapNodeRefs } from 'cleo'
import { cryptoRandomId } from './ids'

// Shared helpers for serialized node subtrees, used by both the Template and Mesh asset systems.
// Kept here (rather than duplicated) so template instances and imported meshes reconstruct identically.
//
// The type dispatch and the id-renumbering now live in the ENGINE (core/scene/nodeJson.ts + node.ts), because
// the runtime needs exactly the same operations for scene.instantiate — and the copy that used to live here
// was missing the landscape / lightProbe / volumetricClouds / skyAtmosphere cases. These are thin
// re-exports so every existing call site keeps working.

/** @see parseNodeJson — reconstructs a serialized subtree under `parent`, dispatching on its `type`. */
export const parseByType = parseNodeJson

/** @see remapNodeRefs — rewrites node-reference fields (camera rig pins) through an id map. */
export const remapNodeRefs = engineRemapNodeRefs

/** Remove editor/debug helper children so an asset only contains user content. */
export function stripDebug(nodeJson: any): void {
  if (Array.isArray(nodeJson.children)) {
    nodeJson.children = nodeJson.children.filter((c: any) =>
      !(String(c.name).includes('__debug__') || String(c.name).includes('__editor__')))
    nodeJson.children.forEach(stripDebug)
  }
}

/** @see collectNodeIds — every node id present in a serialized subtree. */
export const collectIds = collectNodeIds

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

/**
 * Recursively assign fresh ids to a serialized subtree, filling `map` with oldId -> newId.
 *
 * Passes the editor's own id factory so copied nodes keep the same id shape as every other node the editor
 * creates; the two-pass reference remap (and why it must be a second pass) lives in the engine helper.
 */
export function regenerateIds(nodeJson: any, map: Map<string, string>): void {
  regenerateNodeIds(nodeJson, map, cryptoRandomId)
}
