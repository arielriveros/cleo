// Capture: what a running scene's participants hold right now, as a SceneMemory. Visits only the scene's
// participant index (Node.refreshSaveParticipation), never the whole tree: a big landscape scene has tens
// of thousands of nodes and maybe twenty that save.

import { Node } from '../scene/nodes/node';
import type { Scene } from '../scene/scene';
import { Logger } from '../logger';
import { logScriptError } from '../scripting/scriptErrors';
import { emptySceneMemory, type SavedNodeState, type SavedSpawn, type SceneMemory } from './doc';
import { encodeSaveValue, UNSAVEABLE, type EncodeContext } from './values';
import { livePathOf } from './nodePaths';
import { getTemplate } from '../scene/templates';

/** Problems reported once per session each, so a field saved every scene switch does not flood the log. */
const reported = new Set<string>();

/** Forget which problems were reported (a new play session reports them again). */
export function resetCaptureWarnings(): void {
    reported.clear();
}

function warnOnce(message: string): void {
    if (reported.has(message)) return;
    reported.add(message);
    Logger.warn(message, 'Save');
}

/** The instantiated copy a node belongs to (itself, or its nearest instantiated ancestor), or null. */
function copyRootOf(node: Node): Node | null {
    for (let n: Node | null = node; n; n = n.parent) if (n._cleoSave?.instanceOf) return n;
    return null;
}

function depthOf(node: Node): number {
    let d = 0;
    for (let n = node.parent; n; n = n.parent) d++;
    return d;
}

const nonZero = (v: { x: number; y: number; z: number }) => v.x !== 0 || v.y !== 0 || v.z !== 0;

/** One participant's state. `path` is where it is: its authored path, or its path below its copy's root. */
function stateOf(node: Node, path: string | null, ctx: EncodeContext): SavedNodeState {
    const info = node._cleoSave;
    const state: SavedNodeState = { path };
    const label = `'${node.name}'`;
    if (info?.saved) {
        state.p = Array.from(node.position);
        state.q = Array.from(node.quaternion);
        state.s = Array.from(node.scale);
        // Dormancy at the boundary only: a node asleep because its PARENT is asleep says nothing, or a later
        // parent.spawn() would leave it asleep (spawn respects each descendant's own flag).
        const parentAwake = !node.parent || node.parent.spawned;
        if (!node.spawned && parentAwake) state.sleep = true;
        else if (node.spawned && !node.spawnOnStart) state.sleep = false;
        const body = node.ownBody;
        if (body) {
            if (nonZero(body.velocity)) state.v = [body.velocity.x, body.velocity.y, body.velocity.z];
            if (nonZero(body.angularVelocity)) state.w = [body.angularVelocity.x, body.angularVelocity.y, body.angularVelocity.z];
        }
        // `__`-named variables are the editor's bookkeeping (__scriptId, __templateId, __overrides), which the
        // authored scene already carries.
        const vars: Record<string, unknown> = {};
        for (const [name, v] of node.variables) {
            if (name.startsWith('__')) continue;
            const value = encodeSaveValue(v.value, `${label} variable '${name}'`, ctx);
            if (value !== UNSAVEABLE) vars[name] = { type: v.type, value, access: v.access ?? 'public' };
        }
        if (Object.keys(vars).length) state.vars = vars;
    }
    if (info?.fields.length) {
        const fields: Record<string, unknown> = {};
        for (const field of info.fields) {
            const value = encodeSaveValue((node as any)[field], `${label} field '${field}'`, ctx);
            if (value !== UNSAVEABLE) fields[field] = value;
        }
        if (Object.keys(fields).length) state.fields = fields;
    }
    if (node.onSave !== Node.prototype.onSave) {
        try {
            const result = node.onSave();
            if (result && typeof (result as any).then === 'function')
                warnOnce(`${label}: onSave returned a promise, which is not saved. Return the data itself (onSave cannot be async).`);
            else {
                const value = encodeSaveValue(result, `${label} onSave()`, ctx);
                if (value !== UNSAVEABLE) state.custom = value;
            }
        } catch (e) {
            logScriptError(`Error in onSave for node ${node.name}`, e, 'Script');
        }
    }
    return state;
}

/**
 * The state of `scene`'s participants now. Nodes the memory it was entered with had already removed were never
 * built this visit, so they are carried forward as removed.
 */
export function captureScene(scene: Scene): SceneMemory {
    const st = scene.saveState;
    const root = scene.root;
    const mem = emptySceneMemory();
    const ctx: EncodeContext = {
        warn: (where, why) => warnOnce(`Not saved — ${where}: ${why}.`),
        pathOf: (node) => node._cleoSave?.path ?? (root ? livePathOf(root, node) : null),
    };

    const copies: Node[] = [];
    const inCopies = new Map<Node, Node[]>();
    for (const node of st.participants) {
        if (node.scene !== scene) continue;
        const copy = copyRootOf(node);
        if (copy) {
            // Inside a copy a script made: it comes back only as part of a Saved copy.
            if (copy === node) { if (node.saved) copies.push(node); }
            else {
                const list = inCopies.get(copy);
                if (list) list.push(node); else inCopies.set(copy, [node]);
            }
            continue;
        }
        if (node.isBeingRemoved) continue;   // recorded as removed, below
        mem.nodes[node.id] = stateOf(node, ctx.pathOf(node), ctx);
    }

    // Outer copies first: a copy made inside another (a weapon given to a spawned enemy) is attached to it.
    copies.sort((a, b) => depthOf(a) - depthOf(b));
    for (const copy of copies) {
        // One made inside a copy that will not come back (not Saved, or going away) has nowhere to go.
        const outer = copy.parent ? copyRootOf(copy.parent) : null;
        if (copy.isBeingRemoved || (outer && (!outer.saved || outer.isBeingRemoved))) continue;
        const info = copy._cleoSave!;
        const parent = copy.parent && copy.parent !== root ? copy.parent : null;
        const spawn: SavedSpawn = {
            template: info.instanceOf!,
            templateName: getTemplate(info.instanceOf!)?.name ?? '',
            name: copy.name,
            id: copy.id,
            parent: parent ? { id: parent.id, path: ctx.pathOf(parent) } : null,
            state: stateOf(copy, null, ctx),
        };
        const inner = inCopies.get(copy);
        if (inner) {
            const sub: Record<string, SavedNodeState> = {};
            for (const node of inner) {
                if (node.isBeingRemoved || copyRootOf(node) !== copy) continue;
                const rel = livePathOf(copy, node);
                if (rel !== null) sub[rel] = stateOf(node, rel, ctx);
            }
            if (Object.keys(sub).length) spawn.sub = sub;
        }
        mem.spawned.push(spawn);
    }

    // Authored participants that are gone, and those already gone when the scene was entered.
    const removed = new Set<string>();
    for (const [id, path] of st.authored) {
        const live = scene.getNodeById(id);
        if (live && live.scene === scene && !live.isBeingRemoved) continue;
        removed.add(id);
        mem.removed.push({ id, path });
    }
    const carried = st.memoryIn as SceneMemory | null;
    for (const r of carried?.removed ?? []) {
        if (removed.has(r.id)) continue;
        removed.add(r.id);
        mem.removed.push({ id: r.id, path: r.path ?? null });
    }
    return mem;
}
