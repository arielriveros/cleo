import { Node, Scene, parseNodeJson, disposeModelSubtree } from 'cleo'
import type { NodeType } from 'cleo'
import { stripDebug } from './nodeSubtree'

// Changing a node's type in place.
//
// The engine has no setter for it: `_nodeType` is readonly and assigned once in the Node constructor, so
// a type change is necessarily serialize -> rebase -> destroy -> parse. The node's ID is preserved
// throughout, which is what makes the operation cheap: the editor keys `scripts`, `bodies` and `triggers`
// by node id (EngineContext.engineMaps), and none of the three is part of serialize() output, so all of
// them survive a conversion without being touched.
//
// Kept free of React and of the icon catalog so the editor's node-environment test suite can import it.

/**
 * The keys `Node.serialize()` writes for EVERY node whatever its class (see node.ts). Everything else in a
 * serialized node came from its `_serializePayload()` — the type-specific half, and the half a conversion
 * replaces. `type` is deliberately absent: it is the thing being changed.
 *
 * Subtractive rather than enumerating each subclass's payload keys: this list is short, fixed and pinned by
 * tests/nodeParse.test.ts, while the payload keys are owned by twenty `_serializePayload` overrides that
 * would never be updated in step with this file.
 */
const BASE_KEYS: readonly string[] = [
  'id', 'name', 'position', 'rotation', 'scale', 'children', 'variables', 'spawnOnStart', 'motionBlur',
]

/**
 * Node variables that link a node to an ASSET its new type cannot be an instance of, dropped on every
 * conversion. Left behind, `__modelId` makes syncModelInstances still match the node, and the next save of
 * that model asset rebuilds it back into the model — silently undoing the type change.
 *
 * `__templateId` and `__scriptId` are deliberately NOT here: the template being edited and the script
 * attached to this id are both still exactly what they were. (A script whose baseType no longer matches is
 * a separate concern — see baseTypeMatchesNode at the call site.)
 */
const ASSET_LINK_VARS: readonly string[] = [
  '__modelId', '__meshId', '__modelBaseTRS', '__materialId', '__materialIds', '__screenMaterialIds',
]

/** The type-specific half of a serialized node: everything `_serializePayload` contributed. */
export function payloadOf(json: any): any {
  const out: any = {}
  if (!json) return out
  for (const key of Object.keys(json))
    if (key !== 'type' && !BASE_KEYS.includes(key)) out[key] = json[key]
  return out
}

/**
 * The same node under a different type: its common block verbatim, its old payload dropped whole, and
 * `payload` — a fresh node of the target type's payload, from {@link payloadOf} — put in its place.
 *
 * `children` is copied by reference, so a before/after pair shares every vertex buffer in the subtree
 * rather than duplicating it. That matters: these two blobs are what the undo entry holds onto.
 */
export function rebaseNodeJson(json: any, nodeType: NodeType, payload: any = {}): any {
  const out: any = { type: nodeType }
  for (const key of BASE_KEYS) if (key in json) out[key] = json[key]
  if (out.variables) {
    out.variables = { ...out.variables }
    for (const name of ASSET_LINK_VARS) delete out.variables[name]
  }
  // `payload` holds no BASE_KEYS by construction, so it cannot clobber the block above.
  return { ...out, ...payload }
}

/**
 * Destroy the node carrying `json.id` and reconstruct it from `json`, keeping its parent and its slot among
 * its siblings. Synchronous on purpose: the caller brackets exactly this in `history.silently`, which only
 * suspends recording for the duration of a synchronous call.
 *
 * Follows HistoryContext.restore, with two deliberate differences:
 *   - `removeChild(existing)` with reparent FALSE, so `onDespawn` fires and pending timers are cancelled.
 *     A SoundNode converted away otherwise keeps playing forever — stop() is what onDespawn calls.
 *   - the old subtree's GPU buffers are released. `json` holds its own copy of every vertex buffer, so an
 *     undo can still rebuild it.
 *
 * Emits no event: the caller owns that, and owns suppressing the structural events removeChild/addChild
 * emit on their own.
 */
export function rebuildNodeInPlace(scene: Scene, json: any): Node | null {
  const existing = scene.getNodeById(json.id)
  const parent = existing?.parent ?? scene.root
  const index = existing ? parent.children.indexOf(existing) : -1
  if (existing) {
    parent.removeChild(existing)
    disposeModelSubtree(existing)
  }
  // parseNodeJson, never Node.parse: the latter keeps a foreign `type` string on a plain Node, producing a
  // node that claims to be a Controller with none of the behaviour.
  parseNodeJson(parent, json)
  // parseNodeJson always appends, so put it back where it was — a conversion that also reshuffles the
  // scene tree reads as corruption.
  const rebuilt = scene.getNodeById(json.id)
  if (rebuilt && index >= 0) parent.moveChildTo(rebuilt, index)
  return rebuilt ?? null
}

/**
 * Build the before/after subtree JSON for a type change, without mutating anything.
 *
 * Split from {@link rebuildNodeInPlace} because this half is async — both `serialize()` and an add-catalog
 * `create()` return promises — and the mutation half must run inside a synchronous history suspension.
 *
 * @param makeDefault Builds a throwaway node of the target type whose payload seeds the new node. Required
 *                    for model / light / camera, whose `parse` throws on a missing payload; null for the
 *                    types that tolerate a bare blob.
 * @returns null when the node is already the target type.
 */
export async function prepareNodeTypeChange(
  node: Node, target: NodeType, makeDefault: (() => Promise<Node>) | null,
): Promise<{ before: any; after: any } | null> {
  if (node.nodeType === target) return null
  const before = await node.serialize()
  // The __editor__ light sprite / __debug__ camera gizmo the helper reconciler splices in are real children
  // and would be re-parsed as ordinary content — and then never removed again, because every prune branch
  // in reconcileEditorHelpers is guarded by `instanceof <the owning class>`, which no longer holds.
  stripDebug(before)
  const payload = makeDefault ? payloadOf(await (await makeDefault()).serialize()) : {}
  return { before, after: rebaseNodeJson(before, target, payload) }
}
