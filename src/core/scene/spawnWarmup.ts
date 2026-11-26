// Drawing what a scene can SPAWN while its shaders are prepared (Renderer.prepareShaders).
//
// A shader sweep draws the scene's own nodes, so a template only a script instantiates (a muzzle flash, an impact, a
// bullet hole) met its pipelines on the frame it first appeared: a GPU particle system compiles its simulation and
// draw programs on the spot, a decal its surface pass, and the driver's compile can hold the whole window for
// seconds. Here a copy of each such template is drawn with the sweep instead, made inert first: no scripts, no
// physics, no camera, sound or scene singleton of its own, nothing saved, nothing marked unsaved.

import { vec3 } from 'gl-matrix';
import { Logger } from '../logger';
import { Node } from './nodes/node';
import { parseNodeJson } from './nodes/parseNodeJson';
import { isUINodeType } from './nodes/nodeType';
import { markEditorOwned, SPAWN_WARMUP_HOLDER } from './editorNodes';
import { disposeModelSubtree } from './nodes/modelNode';
import { cloneNodeJson, regenerateNodeIds } from './nodeJson';
import { compileScript } from '../scripting/scriptRuntime';
import type { Scene } from './scene';

// The holder's name (editorNodes.ts): `__editor__` makes it, and all under it, editor-owned.
export { SPAWN_WARMUP_HOLDER };

/** How far in front of the camera the copies are put: on screen, close enough for a decal's box to be in view. */
const AHEAD = 4;

/**
 * The node types a copy keeps: what draws. Every other type becomes a plain node (its transform and children kept),
 * so a copy cannot take the camera, change the sky, play a sound, run physics or a sequence.
 */
const DRAWN_TYPES = new Set([
    'node', 'model', 'lodGroup', 'light', 'decal', 'particleSystem', 'sprite', 'animatedSprite', 'cloth',
    'volumetricFog', 'fluidVolume', 'tilemap', 'parallaxLayer',
]);

/** What a node carries that would run or persist: scripts and their fields, save data, legacy physics. */
const INERT_STRIPPED = ['script', 'scriptPath', 'scriptVars', 'saved', 'saveFields', '__sourceId', 'body', 'trigger', 'area2D'];

/**
 * An inert copy of a serialized subtree, for drawing only: fresh ids, no scripts (nothing for the parse to attach,
 * from source or from a published game's provider), no physics, UI dropped, every type that does more than draw
 * turned into a plain node. The root sits at the origin of whatever it is put under.
 */
export function warmCopyJson(json: any): any | null {
    if (!json || typeof json !== 'object' || isUINodeType(json.type)) return null;
    const copy = cloneNodeJson(json);
    regenerateNodeIds(copy, new Map());
    const inert = (n: any): any | null => {
        if (!n || typeof n !== 'object' || isUINodeType(n.type)) return null;
        for (const key of INERT_STRIPPED) delete n[key];
        // A dormant node (spawnOnStart false) is still a node something wakes: it is drawn as if woken.
        n.spawnOnStart = true;
        const children = Array.isArray(n.children) ? n.children.map(inert).filter((c: any) => c) : [];
        if (!DRAWN_TYPES.has(n.type ?? 'node')) {
            return { id: n.id, name: n.name, type: 'node', position: n.position, rotation: n.rotation, scale: n.scale,
                     spawnOnStart: true, children };
        }
        n.children = children;
        return n;
    };
    const root = inert(copy);
    if (root) root.position = [0, 0, 0];
    return root;
}

/** The node types `warmCopyJson` keeps as they are (for tests and tooling). */
export function isDrawnWarmType(type: string): boolean { return DRAWN_TYPES.has(type); }

/** A mounted warm-up: stepped before each sweep frame, removed when the sweep is done. */
export interface SpawnWarmup {
    /** Copies mounted (subtrees that parsed). */
    readonly count: number;
    /** Run the copies' particle systems one step, so their simulation and draw programs are asked for. */
    beforeFrame(dt: number): void;
    /** Take the copies out of the scene and free their meshes. Safe to call twice. */
    dispose(): void;
}

/** A particle system as the warm-up drives it (ParticleSystemNode, a feature's class: not imported here). */
interface WarmStepper { warmStep(dt: number): void }
const isStepper = (n: Node): n is Node & WarmStepper => typeof (n as any).warmStep === 'function';

/**
 * Mount an inert copy of each subtree in `scene`, in front of its camera, under one editor-owned holder: never an
 * unsaved change, an undo step or part of a save, and hidden from the scene tree. The copies are built while the
 * holder is detached, so nothing in them starts on the way in; one that fails to parse is logged and left out.
 */
export function mountSpawnWarmup(scene: Scene, subtrees: readonly unknown[]): SpawnWarmup {
    const holder = markEditorOwned(new Node(SPAWN_WARMUP_HOLDER));
    let count = 0;
    for (const json of subtrees) {
        const copy = warmCopyJson(json);
        if (!copy) continue;
        try {
            parseNodeJson(holder, copy);
            count++;
        } catch (e) {
            Logger.warn(`[shaders] could not prepare '${(json as any)?.name ?? '?'}' with the scene: ${(e as Error)?.message ?? e}`, 'Renderer');
        }
    }
    if (count === 0) return { count: 0, beforeFrame() {}, dispose() {} };

    // Camera.position is where it stands (its `eye` is the point it looks at); the view matrix's third row is its back.
    const camera = scene.activeCamera?.camera;
    if (camera) {
        const v = camera.viewMatrix, at = camera.position;
        holder.setPosition(vec3.fromValues(at[0] - v[2] * AHEAD, at[1] - v[6] * AHEAD, at[2] - v[10] * AHEAD));
    }
    const steppers: (Node & WarmStepper)[] = [];
    const collect = (n: Node) => { if (isStepper(n)) steppers.push(n); for (const c of n.children) collect(c); };
    collect(holder);

    scene.addNode(holder);
    let mounted = true;
    return {
        count,
        beforeFrame(dt: number) {
            if (!mounted) return;
            for (const s of steppers) s.warmStep(dt);
        },
        dispose() {
            if (!mounted) return;
            mounted = false;
            scene.removeNode(holder);
            disposeModelSubtree(holder);
        },
    };
}

/**
 * Copies of the scene's own particle systems that are not running (a one-shot a script plays, say), without their
 * children: a sweep draws only what emits, so these would otherwise meet their programs on their first play.
 * `idleOnly` false copies every one: a scene not started yet has none running.
 */
export async function particleCopiesOf(scene: Scene, idleOnly: boolean): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const node of scene.particleSystems) {
        if (node.isEditorOwned) continue;
        if (idleOnly && node.isAlive) continue;
        try {
            const json = await node.serialize();
            if (json) out.push({ ...json, children: [] });
        } catch { /* a system that cannot serialize is simply not prepared */ }
    }
    return out;
}

/**
 * Compile the scripts a set of template subtrees carries as source (the editor's Play, Play in window), so the first
 * spawn finds them compiled. Only compiles: no script runs. A published game carries no sources, so this does
 * nothing there. Returns how many compiled.
 */
export function precompileTemplateScripts(subtrees: readonly unknown[]): number {
    let n = 0;
    const walk = (json: any) => {
        if (!json || typeof json !== 'object') return;
        if (typeof json.script === 'string' && json.script.trim()) {
            try { compileScript(json.script, { path: typeof json.scriptPath === 'string' ? json.scriptPath : undefined }); n++; }
            catch { /* its error is reported when it is attached, as it always was */ }
        }
        for (const c of json.children ?? []) walk(c);
    };
    for (const s of subtrees) walk(s);
    return n;
}
