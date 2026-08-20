// Operations on SERIALIZED node subtrees — the `{ id, name, type, children, ... }` shape Node.serialize
// produces and Node.parse consumes. Pure JSON in, pure JSON out (parseNodeJson excepted), no GL and no
// live scene, so the editor's asset tooling and the engine's runtime instantiation share one implementation
// rather than each carrying its own copy that can drift.

// The type dispatch that materializes a subtree lives in node.ts (`parseNodeJson`), where every node class
// is already in scope — importing them here would close a cycle, since node.ts uses these helpers.

import { v4 as uuidv4 } from 'uuid';

/**
 * Deep-copy a serialized subtree, preserving typed arrays.
 *
 * `JSON.parse(JSON.stringify(x))` cannot be used: a published build's geometry arrives as Float32Array/
 * Uint16Array views over game.bin, and JSON turns those into `{"0":1,"1":2,…}` objects — a mesh that
 * silently comes back empty. `structuredClone` is no good either, since cloning a view copies the ENTIRE
 * backing buffer (the whole game.bin) per instance.
 *
 * Typed arrays are `slice()`d rather than shared, which is required and not merely tidy: `Geometry.scale`
 * writes into its positions IN PLACE, so two instances over one buffer would deform each other.
 */
export function cloneNodeJson<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value)) return (value as any).slice();
    if (Array.isArray(value)) return value.map(cloneNodeJson) as any;
    const out: any = {};
    for (const key of Object.keys(value as any)) out[key] = cloneNodeJson((value as any)[key]);
    return out;
}

/** Collect every node id present in a serialized subtree. */
export function collectNodeIds(json: any, out: string[] = []): string[] {
    if (json?.id) out.push(json.id);
    if (Array.isArray(json?.children)) json.children.forEach((c: any) => collectNodeIds(c, out));
    return out;
}

/** Fields that store ANOTHER node's id and so must be rewritten alongside it. */
const NODE_REF_KEYS = ['followId', 'lookAtId', 'cameraNodeId', 'uiTargetId'];

/**
 * Rewrite node-reference fields (CameraRigNode's follow/lookAt/camera pins) through an id map.
 *
 * References to nodes OUTSIDE the copied subtree are deliberately left alone: those mean "follow the player
 * that already exists in the scene", which is exactly what should survive an instantiation.
 */
export function remapNodeRefs(json: any, map: Map<string, string>): void {
    for (const key of NODE_REF_KEYS) {
        const value = json?.[key];
        if (typeof value === 'string' && map.has(value)) json[key] = map.get(value);
    }
    if (Array.isArray(json?.collisionIgnoreIds))
        json.collisionIgnoreIds = json.collisionIgnoreIds.map((id: any) =>
            typeof id === 'string' && map.has(id) ? map.get(id) : id);
    if (Array.isArray(json?.children)) json.children.forEach((c: any) => remapNodeRefs(c, map));
}

function assignIds(json: any, map: Map<string, string>, newId: () => string): void {
    if (json?.id) {
        const id = newId();
        map.set(json.id, id);
        // The id this node was COPIED from. Anything keyed by the original id can still find its way home
        // after renumbering — which is how a published game attaches the right precompiled script to an
        // instantiated node (see setScriptProvider / Node._commonParse).
        json.__sourceId = json.__sourceId ?? json.id;
        json.id = id;
    }
    if (Array.isArray(json?.children)) json.children.forEach((c: any) => assignIds(c, map, newId));
}

/**
 * Recursively assign fresh ids to a serialized subtree, filling `map` with oldId -> newId.
 *
 * Two passes, and the second is not optional: a node may reference a sibling that has not been renumbered
 * yet, so the references can only be fixed once the whole map exists. Doing the remap in here rather than
 * leaving it to callers means a copied subtree can never silently keep pointing at the original — a template
 * holding a camera rig and its follow target would otherwise have every instance follow the FIRST
 * instance's target.
 *
 * @param newId Id factory, so a caller with its own id scheme (the editor's `cryptoRandomId`) stays
 *              consistent with the ids it generates everywhere else.
 */
export function regenerateNodeIds(json: any, map: Map<string, string>, newId: () => string = uuidv4): void {
    assignIds(json, map, newId);
    remapNodeRefs(json, map);
}
