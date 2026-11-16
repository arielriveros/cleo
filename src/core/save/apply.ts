// Restore: putting a SceneMemory back into a scene as it is built. Two halves, because of when things exist.
//
//   patchSceneJson  BEFORE parse — the serialized tree is edited: removed nodes pruned, transforms, dormancy,
//                   variables and `@save` fields written in. Bodies are built from the transform finishParse
//                   applies (node.ts), so this is the only way a body starts where it was saved: moving a node
//                   after parse does not carry a descendant's body along, and setQuaternion never touches one.
//   applyLive       AFTER parse, before start — what needs the live tree: Saved copies instantiated again,
//                   node references resolved, velocities, and the onRestore queue Scene.start drains.

import type { Node } from '../scene/nodes/node';
import type { Scene } from '../scene/scene';
import { Logger } from '../logger';
import { getTemplate } from '../scene/templates';
import type { SavedNodeState, SavedSpawn, SceneMemory } from './doc';
import { decodeSaveValue, holdsNodeRef } from './values';
import { indexNodeJson, liveNodeAtPath, type SceneJsonIndex } from './nodePaths';

/** What applyLive still has to do for one restored node. */
interface LiveWork {
    state: SavedNodeState;
    /** `@save` fields holding node references, which resolve only once the tree is built. */
    deferred: Record<string, unknown> | null;
}

/** The second half of a restore, prepared by {@link patchSceneJson}. */
export interface RestorePlan {
    /** Authored nodes restored, by their id in THIS build. */
    nodes: Map<string, LiveWork>;
    /** Saved copies to make again, with their parent's id in this build (null: the scene root). */
    spawns: { spawn: SavedSpawn; parentId: string | null }[];
}

/** Write a node's saved state into its JSON. Returns the fields that must wait for the live tree. */
function patchNodeJson(json: any, state: SavedNodeState): Record<string, unknown> | null {
    if (Array.isArray(state.p) && state.p.length === 3) json.position = [...state.p];
    if (Array.isArray(state.q) && state.q.length === 4) json.quaternion = [...state.q];
    if (Array.isArray(state.s) && state.s.length === 3) json.scale = [...state.s];
    if (state.sleep === true) json.spawnOnStart = false;
    else if (state.sleep === false) json.spawnOnStart = true;
    if (state.vars && typeof state.vars === 'object') {
        const vars = { ...(json.variables && typeof json.variables === 'object' ? json.variables : {}) };
        for (const [name, entry] of Object.entries(state.vars)) {
            if (!entry || typeof entry !== 'object') continue;
            const e = entry as any;
            vars[name] = { type: e.type, value: decodeSaveValue(e.value), access: e.access ?? 'public' };
        }
        json.variables = vars;
    }
    let deferred: Record<string, unknown> | null = null;
    if (state.fields && typeof state.fields === 'object') {
        // As `scriptVars`: restored onto the node before its script binds, exactly like an authored value, so
        // every handler (onConstruct included) already sees them and field defaults never overwrite them.
        const vars = { ...(json.scriptVars && typeof json.scriptVars === 'object' ? json.scriptVars : {}) };
        for (const [field, value] of Object.entries(state.fields)) {
            if (holdsNodeRef(value)) (deferred ??= {})[field] = value;
            else vars[field] = decodeSaveValue(value);
        }
        json.scriptVars = vars;
    }
    return deferred;
}

/** The JSON node a saved reference names: by id, else by its authored path. */
function resolveJson(index: SceneJsonIndex, id: string, path: string | null | undefined): any {
    return index.byId.get(id) ?? (typeof path === 'string' ? index.byPath.get(path) : undefined);
}

/**
 * Edit a scene's serialized root (`json.scene`) to carry `mem`, before it is parsed. `index` must have been
 * built from that same JSON, untouched: every lookup is resolved first, against the authored tree, and only
 * then is anything pruned (a removed namesake shifts the `#k` of the siblings after it).
 */
export function patchSceneJson(mem: SceneMemory, index: SceneJsonIndex): RestorePlan {
    const plan: RestorePlan = { nodes: new Map(), spawns: [] };

    const targets: { json: any; state: SavedNodeState }[] = [];
    for (const [id, state] of Object.entries(mem.nodes)) {
        const json = resolveJson(index, id, state?.path);
        if (json && state && typeof state === 'object') targets.push({ json, state });
    }
    const pruned = mem.removed.map(r => resolveJson(index, r.id, r.path)).filter(Boolean);
    for (const spawn of mem.spawned) {
        // A parent the authored tree has resolves to its id here; one it has not is an earlier copy (made with
        // its saved id) or gone, which applyLive finds out.
        const parentJson = spawn.parent ? resolveJson(index, spawn.parent.id, spawn.parent.path) : null;
        plan.spawns.push({ spawn, parentId: spawn.parent ? (parentJson?.id ?? spawn.parent.id) : null });
    }

    for (const { json, state } of targets) {
        plan.nodes.set(json.id, { state, deferred: patchNodeJson(json, state) });
    }
    for (const json of pruned) {
        const parent = index.parentOf.get(json);
        if (!parent || !Array.isArray(parent.children)) continue;   // the root itself is never pruned
        const at = parent.children.indexOf(json);
        if (at >= 0) parent.children.splice(at, 1);
    }
    return plan;
}

/** How applyLive finds the node a saved reference names, in the scene as it now stands. */
function nodeFinder(scene: Scene, index: SceneJsonIndex | null) {
    return (id: string, path: string | null): Node | null => {
        const byId = scene.getNodeById(id);
        if (byId) return byId;
        if (path === null || !scene.root) return null;
        // The authored path names a node of the authored tree; its id in this build finds it.
        const json = index?.byPath.get(path);
        if (json?.id) return scene.getNodeById(json.id) ?? null;
        return liveNodeAtPath(scene.root, path);
    };
}

/** Mark one live node restored and give it what only the live tree can take. */
function restoreLive(scene: Scene, node: Node, work: LiveWork, find: ReturnType<typeof nodeFinder>, later: (() => void)[]): void {
    node._saveInfo().restored = true;
    const { state, deferred } = work;
    // Velocities need the body. A Collider parsed as part of a whole scene builds it at the first physics step;
    // building it now is what that step would do, at the same (restored) pose.
    if (state.v || state.w) {
        if (!node.ownBody && node.wantsPhysicsBuild && scene.spawnRulesEnabled !== false) node.buildPhysics();
        const body = node.ownBody;
        if (body && Array.isArray(state.v)) body.velocity.set(state.v[0], state.v[1], state.v[2]);
        if (body && Array.isArray(state.w)) body.angularVelocity.set(state.w[0], state.w[1], state.w[2]);
    }
    // Node references and onSave data wait until every copy is back: they may point at one.
    later.push(() => {
        if (deferred) for (const [field, value] of Object.entries(deferred)) (node as any)[field] = decodeSaveValue(value, find);
        scene.saveState.pendingRestore.set(node, state.custom === undefined ? undefined : decodeSaveValue(state.custom, find));
    });
}

/** Make one Saved copy again, carrying its saved state and its inner participants'. */
function respawn(scene: Scene, entry: RestorePlan['spawns'][number], find: ReturnType<typeof nodeFinder>, later: (() => void)[]): void {
    const { spawn, parentId } = entry;
    let parent: Node | undefined;
    if (parentId !== null) {
        parent = scene.getNodeById(parentId) ?? find(parentId, spawn.parent?.path ?? null) ?? undefined;
        if (!parent) {
            Logger.warn(`Save: '${spawn.name}' was attached to a node that is gone; it is not made again.`, 'Save');
            return;
        }
    }
    const template = getTemplate(spawn.template) ? spawn.template
        : spawn.templateName && getTemplate(spawn.templateName) ? spawn.templateName : null;
    if (!template) {
        Logger.warn(`Save: no template '${spawn.templateName || spawn.template}' to make '${spawn.name}' from.`, 'Save');
        return;
    }
    const inner = new Map<string, LiveWork>();
    const made = scene.instantiate(template, { parent, name: spawn.name, id: spawn.id }, json => {
        // A copy is recorded only when Saved; one a script flagged after making it must stay Saved too.
        json.saved = true;
        const rootDeferred = patchNodeJson(json, spawn.state);
        inner.set('', { state: spawn.state, deferred: rootDeferred });
        if (spawn.sub) {
            const index = indexNodeJson(json);
            for (const [rel, state] of Object.entries(spawn.sub)) {
                const target = rel === '' ? null : index.byPath.get(rel);
                if (target && state) inner.set(rel, { state, deferred: patchNodeJson(target, state) });
            }
        }
    });
    if (!made) return;
    for (const [rel, work] of inner) {
        const node = rel === '' ? made : liveNodeAtPath(made, rel);
        if (node) restoreLive(scene, node, work, find, later);
    }
}

/**
 * The live half of a restore, on a parsed scene that has not started. `index` is the one the plan was made
 * against (the authored tree), for references by path.
 */
export function applyLive(scene: Scene, plan: RestorePlan, index: SceneJsonIndex | null): void {
    const find = nodeFinder(scene, index);
    const later: (() => void)[] = [];
    for (const entry of plan.spawns) respawn(scene, entry, find, later);
    for (const [id, work] of plan.nodes) {
        const node = scene.getNodeById(id);
        // Gone from this build, or inside something removed: nothing to restore it into.
        if (node) restoreLive(scene, node, work, find, later);
    }
    for (const run of later) run();
}
