// Operations on SERIALIZED node subtrees — the `{ id, name, type, children, ... }` shape Node.serialize
// produces and Node.parse consumes. Pure JSON in, pure JSON out, no GL and no live scene, so the editor's
// asset tooling and the engine's runtime instantiation share one implementation.

import { v4 as uuidv4 } from 'uuid';

/**
 * Deep-copy a serialized subtree, preserving typed arrays.
 *
 * Neither `JSON.parse(JSON.stringify(x))` (turns geometry views into plain objects) nor `structuredClone`
 * (copies each view's entire backing buffer) is usable here. Typed arrays are `slice()`d, never shared:
 * `Geometry.scale` writes its positions IN PLACE, so two instances over one buffer would deform each other.
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

/**
 * Fields that store ANOTHER node's id and so must be rewritten alongside it.
 *
 * `possessedId` is the one whose absence would be hardest to diagnose: every spawned enemy's controller
 * would point at the FIRST enemy, so a crowd of NPCs would move as a single body.
 */
const NODE_REF_KEYS = ['followId', 'lookAtId', 'cameraNodeId', 'uiTargetId', 'focusTargetId',
                       'possessedId', 'aimSourceId'];

/**
 * Rewrite node-reference fields (CameraRigNode's follow/lookAt/camera pins) through an id map.
 * References to nodes OUTSIDE the copied subtree are left alone: those mean "follow the player already
 * in the scene", which must survive an instantiation.
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
        // The id this node was COPIED from, so anything keyed by the original id still resolves after
        // renumbering (a published game attaches precompiled scripts this way).
        json.__sourceId = json.__sourceId ?? json.id;
        json.id = id;
    }
    if (Array.isArray(json?.children)) json.children.forEach((c: any) => assignIds(c, map, newId));
}

/**
 * Recursively assign fresh ids to a serialized subtree, filling `map` with oldId -> newId, then remap
 * node references. The remap must be a second pass: a node may reference a sibling that has not been
 * renumbered yet, so references can only be fixed once the whole map exists.
 *
 * @param newId Id factory, for a caller with its own id scheme (the editor's `cryptoRandomId`).
 */
export function regenerateNodeIds(json: any, map: Map<string, string>, newId: () => string = uuidv4): void {
    assignIds(json, map, newId);
    remapNodeRefs(json, map);
}
