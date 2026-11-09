import { mat4, quat, vec3 } from 'gl-matrix';
import { eulerFromQuatDeg } from '../core/math';
import { Logger } from '../core/logger';
import type { Node } from '../core/scene/nodes/node';
import type { Scene } from '../core/scene/scene';

/**
 * Event Actions: what an animation event DOES, as data on the animated character's state machine instead of
 * code in a script.
 *
 * A clip says WHEN (a named marker at a time, `StoredClip.events`) and the machine says WHAT: a list of bindings,
 * event name to actions. A `shot` marker on a weapon's Fire clip plays the weapon's sound, bursts its muzzle
 * particles, flashes its light and spawns a template; the same marker on another weapon's controller does something
 * else. A script can fire the same named event for something with no clip (`animator.fireEvent('shot')`).
 *
 * Targets are named by PATH (`Sounds/Shot`, `Muzzle/Flash`) and found from the animated node down, then from each
 * ancestor up, the nearest match winning — a weapon's own sounds before its owner's.
 */

export type EventAction =
    | { kind: 'sound'; target: string; /** Overlap an earlier shot of the same sound (default) instead of restarting it. */ overlap?: boolean }
    | { kind: 'particles'; target: string; mode: 'play' | 'burst' | 'stop'; count?: number; emitter?: string }
    | { kind: 'light'; target: string; /** Peak lumens. */ intensity: number; /** Seconds to fade to nothing. */ seconds: number; /** Fade curve exponent (2 = quick falloff). */ falloff?: number }
    | {
        kind: 'spawn'; template: string; /** Where: a node path, found like any target. Empty: the animated node. */ at?: string;
        /** Metres, in the target's frame. */ offset?: [number, number, number];
        /** Orientation: the target's (default), the active camera's, or Euler degrees. */ rotation?: 'target' | 'camera' | [number, number, number];
        /** Keep the spawned node on the target (where the target is DRAWN, so a viewmodel's muzzle carries it) for as long as it lives. */ follow?: boolean;
    };

export interface EventActionBinding {
    /** The event name a clip marker (or `fireEvent`) carries. */
    event: string;
    /** Only this clip's markers (absent: any clip). */
    clip?: string;
    actions: EventAction[];
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const vec = (v: unknown): [number, number, number] | undefined =>
    Array.isArray(v) && v.length >= 3 && v.every(x => typeof x === 'number') ? [v[0], v[1], v[2]] : undefined;

/** One action read tolerantly; null when it is not one the engine knows. */
export function parseEventAction(raw: unknown): EventAction | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    switch (o.kind) {
        case 'sound': return str(o.target) ? { kind: 'sound', target: str(o.target), ...(o.overlap === false ? { overlap: false } : {}) } : null;
        case 'particles': {
            if (!str(o.target)) return null;
            const mode = o.mode === 'play' || o.mode === 'stop' ? o.mode : 'burst';
            return { kind: 'particles', target: str(o.target), mode, ...(o.count !== undefined ? { count: Math.max(0, Math.floor(num(o.count, 0))) } : {}),
                ...(str(o.emitter) ? { emitter: str(o.emitter) } : {}) };
        }
        case 'light': return str(o.target)
            ? { kind: 'light', target: str(o.target), intensity: Math.max(0, num(o.intensity, 5000)), seconds: Math.max(0.01, num(o.seconds, 0.08)),
                ...(o.falloff !== undefined ? { falloff: Math.max(0.1, num(o.falloff, 2)) } : {}) } : null;
        case 'spawn': {
            if (!str(o.template)) return null;
            const rotation = o.rotation === 'camera' ? 'camera' : vec(o.rotation);
            return { kind: 'spawn', template: str(o.template), ...(str(o.at) ? { at: str(o.at) } : {}), ...(vec(o.offset) ? { offset: vec(o.offset) } : {}),
                ...(rotation ? { rotation } : {}), ...(o.follow === true ? { follow: true } : {}) };
        }
        default: return null;
    }
}

/** Bindings read tolerantly from a machine's JSON: whatever parses, with unknown actions dropped. */
export function parseEventActions(raw: unknown): EventActionBinding[] {
    if (!Array.isArray(raw)) return [];
    const out: EventActionBinding[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        if (!str(o.event)) continue;
        const actions = (Array.isArray(o.actions) ? o.actions : []).map(parseEventAction).filter((a): a is EventAction => a !== null);
        out.push({ event: str(o.event), ...(str(o.clip) ? { clip: str(o.clip) } : {}), actions });
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------------

const isHelper = (name: string) => name.startsWith('__debug__') || name.startsWith('__editor__');

/** `path` ('A/B/C') below `from`: the first segment anywhere under it, the rest by direct children. */
function findBelow(from: Node, segments: string[]): Node | null {
    const queue: Node[] = [from];
    for (let head = 0; head < queue.length; head++) {
        for (const child of queue[head].children) {
            if (isHelper(child.name)) continue;
            if (child.name === segments[0]) {
                let at: Node | null = child;
                for (let i = 1; i < segments.length && at; i++) at = at.children.find(c => c.name === segments[i]) ?? null;
                if (at) return at;
            }
            queue.push(child);
        }
    }
    return null;
}

const warned = new WeakMap<Node, Set<string>>();

/** The node a target path names, searched from `owner` down, then from each ancestor; null (warned once) when none. */
export function resolveTarget(owner: Node, path: string): Node | null {
    const segments = path.split('/').map(s => s.trim()).filter(Boolean);
    if (!segments.length) return owner;
    for (let at: Node | null = owner; at; at = at.parent) {
        if (at.name === segments[0] && segments.length === 1) return at;
        const found = findBelow(at, segments);
        if (found) return found;
    }
    let seen = warned.get(owner);
    if (!seen) { seen = new Set(); warned.set(owner, seen); }
    if (!seen.has(path)) {
        seen.add(path);
        Logger.warn(`Event action: no node "${path}" at or above "${owner.name}"`, 'Animation');
    }
    return null;
}

// ---------------------------------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------------------------------

/** Spare emitters per sound, so a new shot rings over the tail of the last one instead of cutting it off. */
const MAX_OVERLAP = 6;
const overlaps = new WeakMap<object, any[]>();

function playSound(cue: any, overlap: boolean): void {
    if (typeof cue.play !== 'function') return;
    if (!overlap || !cue.isPlaying) { cue.play(); return; }
    let pool = overlaps.get(cue);
    if (!pool) { pool = []; overlaps.set(cue, pool); }
    let spare = pool.find(s => !s.isPlaying);
    if (!spare && pool.length < MAX_OVERLAP && cue.parent) {
        spare = new (cue.constructor as any)(cue.name + ' (overlap)', {
            mode: cue.mode, sampleId: cue.sampleId ?? undefined, volume: cue.volume, loopMode: cue.loopMode, playOnStart: false,
            distanceModel: cue.distanceModel, refDistance: cue.refDistance, maxDistance: cue.maxDistance, rolloffFactor: cue.rolloffFactor,
        });
        cue.parent.addChild(spare);
        pool.push(spare);
    }
    (spare ?? cue).play();
}

/**
 * The light flashes in flight in one scene, advanced by a single late update.
 *
 * A light is not hidden between flashes: the renderer does not gate lights on `visible`, and removing one from the scene
 * rebuilds the node lists. What does free its cluster slot is a range of nothing, so between flashes the light sits at
 * intensity 0 and the smallest range, and the authored range is put back for the flash.
 */
class LightFlasher {
    private readonly _flashes = new Map<any, { peak: number; seconds: number; falloff: number; age: number }>();
    private readonly _authoredRange = new Map<any, number>();
    private _remove: (() => void) | null = null;

    constructor(private readonly _scene: Scene) {}

    public flash(light: any, peak: number, seconds: number, falloff: number): void {
        const l = light.light;
        if (!l) return;
        if (!this._authoredRange.has(light)) this._authoredRange.set(light, l.range);
        l.range = this._authoredRange.get(light);
        l.intensity = peak;
        this._flashes.set(light, { peak, seconds, falloff, age: 0 });
        this._remove ??= this._scene.addLateUpdate(delta => this._tick(delta));
    }

    private _tick(delta: number): void {
        for (const [light, f] of this._flashes) {
            f.age += delta;
            if (f.age >= f.seconds || !light.scene) {
                light.light.intensity = 0;
                light.light.range = 0.01;
                this._flashes.delete(light);
                continue;
            }
            light.light.intensity = f.peak * Math.pow(1 - f.age / f.seconds, f.falloff);
        }
        if (this._flashes.size === 0 && this._remove) { this._remove(); this._remove = null; }
    }
}

const flashers = new WeakMap<Scene, LightFlasher>();

const _q = quat.create();
const _p = vec3.create();
const _view = mat4.create();
const _inv = mat4.create();

/**
 * Where a node is DRAWN, in world space. A viewmodel (`Node.viewmodel`) is drawn through the camera's viewmodel lens
 * and at a share of its true distance, so its muzzle is not where its node is: the same point squeezed the way the
 * renderer squeezes it, about the camera and in its frame. Anything that is not a viewmodel is where it is.
 */
export function drawnWorldPosition(node: Node, out: vec3 = vec3.create()): vec3 {
    vec3.copy(out, node.worldPosition);
    let viewmodel = false;
    for (let n: Node | null = node; n; n = n.parent) if (n.viewmodel) { viewmodel = true; break; }
    if (!viewmodel) return out;
    const camera = node.scene?.activeCamera?.camera;
    const squeeze = camera?.viewmodelMatrix;
    if (!camera || !squeeze) return out;
    mat4.copy(_view, camera.viewMatrix);
    vec3.transformMat4(_p, out, _view);
    vec3.transformMat4(_p, _p, squeeze);
    mat4.invert(_inv, _view);
    return vec3.transformMat4(out, _p, _inv);
}

/** Spawned nodes that follow a target, moved by one late update per scene (after the animation has posed it). */
class Followers {
    private readonly _list: { node: Node; at: Node; offset?: [number, number, number]; rotation?: EventActionRotation }[] = [];
    private _remove: (() => void) | null = null;

    constructor(private readonly _scene: Scene) {}

    public add(node: Node, at: Node, offset: [number, number, number] | undefined, rotation: EventActionRotation | undefined): void {
        this._list.push({ node, at, offset, rotation });
        this._remove ??= this._scene.addLateUpdate(() => this._tick());
    }

    private _tick(): void {
        for (let i = this._list.length - 1; i >= 0; i--) {
            const f = this._list[i];
            if (!f.node.scene || !f.at.scene) { this._list.splice(i, 1); continue; }
            place(f.node, f.at, f.offset, f.rotation);
        }
        if (this._list.length === 0 && this._remove) { this._remove(); this._remove = null; }
    }
}

type EventActionRotation = 'target' | 'camera' | [number, number, number];

const followers = new WeakMap<Scene, Followers>();

/** Put `node` at `at`'s drawn position (plus `offset` in its frame) and turn it as `rotation` says. */
function place(node: Node, at: Node, offset: [number, number, number] | undefined, rotation: EventActionRotation | undefined): void {
    const position = drawnWorldPosition(at);
    if (offset) {
        quat.copy(_q, at.worldQuaternion);
        vec3.add(position, position, vec3.transformQuat(vec3.create(), offset, _q));
    }
    node.setPosition([position[0], position[1], position[2]]);
    const euler = turnTo(at, rotation);
    if (euler) node.setRotation(euler);
}

function turnTo(at: Node, rotation: EventActionRotation | undefined): number[] | undefined {
    if (rotation === 'camera') {
        const camera = at.scene?.activeCamera;
        return camera ? Array.from(eulerFromQuatDeg(vec3.create(), camera.worldQuaternion)) : undefined;
    }
    if (Array.isArray(rotation)) return [...rotation];
    return Array.from(eulerFromQuatDeg(vec3.create(), at.worldQuaternion));
}

function spawn(owner: Node, action: Extract<EventAction, { kind: 'spawn' }>): void {
    const scene = owner.scene;
    if (!scene) return;
    const at = action.at ? resolveTarget(owner, action.at) : owner;
    if (!at) return;
    const position = drawnWorldPosition(at);
    if (action.offset) {
        quat.copy(_q, at.worldQuaternion);
        vec3.add(position, position, vec3.transformQuat(vec3.create(), action.offset, _q));
    }
    const rotation = turnTo(at, action.rotation);
    const node = scene.instantiate(action.template, {
        position: [position[0], position[1], position[2]],
        ...(rotation ? { rotation } : {}),
    });
    if (node && action.follow) {
        let list = followers.get(scene);
        if (!list) { list = new Followers(scene); followers.set(scene, list); }
        list.add(node, at, action.offset, action.rotation);
    }
}

/** Run `actions` for `owner` (the animated node). One bad target never stops the rest. */
export function runEventActions(owner: Node, actions: readonly EventAction[]): void {
    for (const action of actions) {
        try {
            if (action.kind === 'spawn') { spawn(owner, action); continue; }
            const target: any = resolveTarget(owner, action.target);
            if (!target) continue;
            if (action.kind === 'sound') playSound(target, action.overlap !== false);
            else if (action.kind === 'particles') {
                if (action.mode === 'play') target.play?.();
                else if (action.mode === 'stop') target.stop?.();
                else target.burst?.(action.count ?? 0, action.emitter);
            } else if (action.kind === 'light') {
                const scene = target.scene as Scene | null;
                if (!scene) continue;
                let flasher = flashers.get(scene);
                if (!flasher) { flasher = new LightFlasher(scene); flashers.set(scene, flasher); }
                flasher.flash(target, action.intensity, action.seconds, action.falloff ?? 2);
            }
        } catch (e) {
            Logger.error(`Event action "${action.kind}" on ${owner.name}: ${e}`, 'Animation');
        }
    }
}

/** The actions bound to `event` (for `clip`, when a binding names one). */
export function actionsFor(bindings: readonly EventActionBinding[] | undefined, event: string, clip: string): EventAction[] {
    if (!bindings || bindings.length === 0) return [];
    const out: EventAction[] = [];
    for (const b of bindings) if (b.event === event && (!b.clip || b.clip === clip)) out.push(...b.actions);
    return out;
}
