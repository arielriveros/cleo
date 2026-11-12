import { mat4, quat, vec3 } from 'gl-matrix';
import { Logger } from '../core/logger';
import {
    aimFromDirection, clamp01, evaluateKeyedNumber, evaluateKeyedStep, evaluateKeyedVector, rampWeight, smoothstep,
    Spline3, type Vec3Tuple,
} from '../core/math';
import { compilePropertyPath, snapshotValue, type PropertyAccessor } from './propertyPath';
import { blendPresetValue, presetFields, sequencePresetsFor } from './presetRegistry';
import type {
    CameraCutTrack, EventKey, EventTrack, FoliageTrack, PathSection, PathTrack, PresetSection, PresetTrack,
    PropertyTrack, SectionBase, SequenceData, SequenceTrack,
} from './types';

/**
 * Evaluates a {@link SequenceData} against live objects.
 *
 * Continuous tracks (paths, properties, the camera cut) are a function of the time they are evaluated at:
 * seeking anywhere gives the same picture as playing there. Event keys fire only during PLAYBACK, in the
 * half-open window `(previous, current]`, never on a seek — the rule clip events follow, "a scrub is not
 * playback".
 *
 * Every target's value is captured the first time a track writes it, so {@link restoreAll} puts the scene
 * back exactly as it was, and a section marked `whenFinished: 'restore'` can do the same when it ends.
 * Blends (a section easing in) start from that captured value, never from last frame's output, so the
 * result does not depend on the frame rate or on where playback came from.
 *
 * Engine-agnostic by design: the host resolves slots to nodes and supplies the scene, so the player is
 * unit-testable against plain objects.
 */

/** What a sequence player needs from wherever it is playing. */
export interface SequencePlayerHost {
    /** The node bound to `slotId`, or null when unbound or gone. */
    resolveSlot(slotId: string): any | null;
    /** Receives event keys that name no slot (the SequenceNode, carrying its director script). */
    readonly director: any | null;
    /** The scene, for the camera cut (`setActiveCamera` / `pinnedCamera`). */
    readonly scene: any | null;
    /** Roots for property tracks with a `target`. */
    readonly renderer?: any | null;
    readonly game?: any | null;
    /**
     * Whether the camera cut takes the scene's camera (pins it and switches it on). False while the editor
     * previews: the viewport keeps the editor's camera, and the shot is only reported in `shotCamera`.
     */
    readonly applyCuts?: boolean;
}

export type SequenceEventListener = (name: string, key: EventKey) => void;

interface TrackState {
    /** Whether the track wrote anything on the last evaluation. */
    influencing: boolean;
    accessor?: PropertyAccessor;
    accessorRoot?: unknown;
    warned?: boolean;
    /** The camera the cut track last pinned, and every camera it switched on with its authored flag. */
    cutCamera?: any | null;
    cutTouched?: Map<any, boolean>;
}

/** A world-space pose. */
export interface SequencePose { pos: vec3; rot: quat; fov: number | undefined; }

const _m = mat4.create();
const _q = quat.create();
const _qRoll = quat.create();
const _v = vec3.create();
const _up = vec3.create();
const WORLD_UP = vec3.fromValues(0, 1, 0);
const VIEW_AXIS = vec3.fromValues(0, 0, 1);

export class SequencePlayer {
    private _seq: SequenceData;
    private readonly _host: SequencePlayerHost;
    private readonly _states = new Map<string, TrackState>();
    /** Restore closures in capture order, keyed by target, so each target is captured once. */
    private readonly _restores = new Map<string, () => void>();
    /** Values as captured, for blends to start from. */
    private readonly _originals = new Map<string, unknown>();
    private readonly _splines = new WeakMap<object, Spline3>();
    private readonly _touched = new Set<any>();
    private readonly _listeners = new Set<SequenceEventListener>();
    private _shotCamera: any | null = null;

    constructor(sequence: SequenceData, host: SequencePlayerHost) {
        this._seq = sequence;
        this._host = host;
    }

    public get sequence(): SequenceData { return this._seq; }

    /** Swap the data (an edit). Captured state is kept, so a later restore still returns the original values. */
    public setSequence(sequence: SequenceData): void {
        this._seq = sequence;
        for (const s of this._states.values()) { s.accessor = undefined; s.accessorRoot = undefined; }
    }

    public onEvent(listener: SequenceEventListener): () => void {
        this._listeners.add(listener);
        return () => { this._listeners.delete(listener); };
    }

    /** The camera the camera cut has on screen now (or would, while cuts are only reported), else null. */
    public get shotCamera(): any | null { return this._shotCamera; }

    /** Whether anything is captured, i.e. whether the scene currently differs from how the sequence found it. */
    public get hasCapturedState(): boolean { return this._restores.size > 0; }

    /**
     * Apply the sequence at `time`. With `fireFrom` set, event keys in `(fireFrom, time]` fire (playback);
     * without it nothing fires (a seek). Returns the nodes whose transforms were written, so the caller can
     * refresh their world matrices before anything reads them this frame.
     */
    public evaluate(time: number, fireFrom?: number): Set<any> {
        this._touched.clear();
        for (const track of this._seq.tracks) {
            if (track.muted) continue;
            try {
                switch (track.type) {
                    case 'path': this._evalPath(track, time, fireFrom); break;
                    case 'property': this._evalProperty(track, time, fireFrom); break;
                    case 'cameraCut': this._evalCut(track, time, fireFrom); break;
                    case 'event': if (fireFrom !== undefined) this._fireEvents(track, fireFrom, time); break;
                    case 'preset': this._evalPreset(track, time, fireFrom); break;
                    case 'foliage': this._evalFoliage(track, time, fireFrom); break;
                }
            } catch (e) {
                Logger.error(`Sequence '${this._seq.name}': track ${track.name ?? track.id} failed: ${e}`, 'Script');
            }
        }
        return this._touched;
    }

    /**
     * Put every captured target back as it was before the sequence first touched it, newest first. Returns the
     * nodes whose transforms were restored.
     */
    public restoreAll(): Set<any> {
        this._touched.clear();
        const restores = Array.from(this._restores.values()).reverse();
        this._restores.clear();
        this._originals.clear();
        for (const restore of restores) {
            try { restore(); } catch (e) { Logger.error(`Sequence '${this._seq.name}': restore failed: ${e}`, 'Script'); }
        }
        for (const s of this._states.values()) { s.influencing = false; s.cutCamera = null; s.cutTouched = undefined; }
        this._shotCamera = null;
        return this._touched;
    }

    // ---- sections ------------------------------------------------------------------------------------

    private _state(track: SequenceTrack): TrackState {
        let s = this._states.get(track.id);
        if (!s) { s = { influencing: false }; this._states.set(track.id, s); }
        return s;
    }

    /**
     * The sections a track is influenced by at `time`, or — once the timeline has left all of them — what
     * the track should do about it: hold the end of the last one it passed, or restore. Null: nothing to do
     * (the track is idle and stays idle, so it leaves its target alone for gameplay to change).
     */
    private _resolveSections<S extends SectionBase>(track: { sections: S[] }, state: TrackState, time: number,
                                                    fireFrom: number | undefined, defaultFinish: 'keep' | 'restore'):
        { active: S[] } | { hold: S } | { restore: true } | null {
        const active: S[] = [];
        let ended: S | null = null;
        for (const s of track.sections) {
            if (s.end <= s.start) continue;
            if (time >= s.start && time <= s.end) active.push(s);
            else if (s.end < time && (!ended || s.end >= ended.end)) ended = s;
        }
        if (active.length > 0) { state.influencing = true; return { active }; }
        // A section passed inside a single frame (a short one, or a long frame) still lands its end value.
        // So does a SEEK past one: what holds after a section is part of the picture at that time, so a
        // seek into the gap between two sections shows the first one's end, as playing there would have.
        const crossed = ended !== null && (fireFrom === undefined || ended.end > fireFrom);
        if (!state.influencing && !crossed) return null;
        state.influencing = false;
        if (ended && (ended.whenFinished ?? defaultFinish) === 'keep') return { hold: ended };
        return { restore: true };
    }

    private _restore(key: string): void {
        const restore = this._restores.get(key);
        if (!restore) return;
        this._restores.delete(key);
        this._originals.delete(key);
        restore();
    }

    // ---- path ----------------------------------------------------------------------------------------

    private _spline(owner: object, points: readonly (readonly number[])[]): Spline3 {
        let s = this._splines.get(owner);
        if (!s) { s = new Spline3(points); this._splines.set(owner, s); }
        return s;
    }

    /** Where a path section puts its subject at sequence `time`, in WORLD space. */
    public pathPose(section: PathSection, time: number,
                    out: SequencePose = { pos: vec3.create(), rot: quat.create(), fov: undefined }): SequencePose {
        const local = Math.min(section.end, Math.max(section.start, time)) - section.start;
        const span = Math.max(1e-6, section.end - section.start);
        const spline = this._spline(section, section.points);
        let u = section.progress ? evaluateKeyedNumber(section.progress, local) : local / span;
        u = Math.min(1, Math.max(0, u));
        const p = spline.pointAt(u, [0, 0, 0]);
        vec3.set(out.pos, p[0], p[1], p[2]);

        const target: Vec3Tuple = [p[0], p[1], p[2]];
        const look = section.look ?? { mode: 'ahead' as const };
        let aimed = false;
        if (look.mode === 'point') {
            target[0] = look.point[0]; target[1] = look.point[1]; target[2] = look.point[2];
            aimed = true;
        } else if (look.mode === 'slot') {
            const wp = this._host.resolveSlot(look.slot)?.worldPosition;
            if (wp) {
                const off = look.offset ?? [0, 0, 0];
                target[0] = wp[0] + off[0]; target[1] = wp[1] + off[1]; target[2] = wp[2] + off[2];
                aimed = true;
            }
        } else if (look.mode === 'path') {
            const lookSpline = this._spline(look, look.points);
            const lu = Math.min(1, Math.max(0, look.progress ? evaluateKeyedNumber(look.progress, local) : u));
            lookSpline.pointAt(lu, target);
            aimed = true;
        } else {
            const ahead = Math.max(0.1, look.distance ?? 6);
            const along = u * spline.length + ahead;
            if (along <= spline.length) {
                spline.pointAtDistance(along, target);
            } else {
                // Past the end: keep looking the way the path was heading.
                const dir = spline.tangentAt(1, [0, 0, 0]);
                const end = spline.pointAt(1, [0, 0, 0]);
                const over = along - spline.length;
                target[0] = end[0] + dir[0] * over; target[1] = end[1] + dir[1] * over; target[2] = end[2] + dir[2] * over;
            }
            aimed = true;
        }
        vec3.set(_v, target[0] - p[0], target[1] - p[1], target[2] - p[2]);
        if (!aimed || vec3.length(_v) < 1e-4) {
            const t = spline.tangentAt(u, [0, 0, 0]);
            vec3.set(_v, t[0], t[1], t[2]);
        }
        const { yaw, pitch } = aimFromDirection(_v);
        // The rig's convention (CameraRigNode): rotation = fromEuler(pitch, yaw, 0); +Z is the view axis.
        quat.fromEuler(out.rot, pitch, yaw, 0);
        const roll = section.roll ? evaluateKeyedNumber(section.roll, local) : 0;
        if (roll !== 0) quat.multiply(out.rot, out.rot, quat.setAxisAngle(_qRoll, VIEW_AXIS, roll * Math.PI / 180));
        out.fov = section.fov ? evaluateKeyedNumber(section.fov, local) : undefined;
        return out;
    }

    private _evalPath(track: PathTrack, time: number, fireFrom: number | undefined): void {
        const state = this._state(track);
        const res = this._resolveSections(track, state, time, fireFrom, 'keep');
        if (!res) return;
        const node = this._host.resolveSlot(track.slot);
        if (!node) return;
        const key = `path:${track.id}`;
        if ('restore' in res) { this._restore(key); return; }

        if (!this._restores.has(key)) {
            const pos = vec3.clone(node.position), rot = quat.clone(node.quaternion);
            const cam = node.camera;
            const up = cam?.up ? vec3.clone(cam.up) : null;
            const fov: number | undefined = cam ? cam.fov : undefined;
            const world: SequencePose = { pos: vec3.clone(node.worldPosition), rot: quat.clone(node.worldQuaternion), fov };
            this._originals.set(key, world);
            this._restores.set(key, () => {
                node.setPosition(pos);
                node.setQuaternion(rot);
                if (cam && up) cam.up = up;
                if (cam && fov !== undefined) cam.fov = fov;
                this._touched.add(node);
            });
        }

        const sections = 'hold' in res ? [res.hold] : res.active;
        const at = 'hold' in res ? res.hold.end : time;
        // An easing-in first section fades from the pose the subject had before the sequence took it.
        const original = this._originals.get(key) as SequencePose;
        const pose: SequencePose = { pos: vec3.clone(original.pos), rot: quat.clone(original.rot), fov: original.fov };
        const next: SequencePose = { pos: vec3.create(), rot: quat.create(), fov: undefined };
        for (const s of sections) {
            const w = 'hold' in res ? 1 : rampWeight(s.start, s.end, s.easeIn, s.easeOut, at);
            if (w <= 0) continue;
            this.pathPose(s, at, next);
            if (w >= 1) {
                vec3.copy(pose.pos, next.pos); quat.copy(pose.rot, next.rot);
                if (next.fov !== undefined) pose.fov = next.fov;
            } else {
                vec3.lerp(pose.pos, pose.pos, next.pos, w);
                quat.slerp(pose.rot, pose.rot, next.rot, w);
                if (next.fov !== undefined) pose.fov = pose.fov === undefined ? next.fov : pose.fov + (next.fov - pose.fov) * w;
            }
        }
        this._applyWorldPose(node, pose);
    }

    private _applyWorldPose(node: any, pose: SequencePose): void {
        const parent = node.parent;
        if (parent && parent.parent) {
            // World -> parent space. A child of the scene root skips both inversions.
            if (mat4.invert(_m, parent.worldTransform)) node.setPosition(vec3.transformMat4(_v, pose.pos, _m));
            node.setQuaternion(quat.multiply(_q, quat.invert(_q, parent.worldQuaternion), pose.rot));
        } else {
            node.setPosition(vec3.copy(_v, pose.pos));
            node.setQuaternion(quat.copy(_q, pose.rot));
        }
        const cam = node.camera;
        if (cam) {
            // CameraNode never derives `up` from its node, so a roll only shows if it is written here.
            cam.up = vec3.transformQuat(_up, WORLD_UP, pose.rot);
            if (pose.fov !== undefined && Number.isFinite(pose.fov)) cam.fov = Math.min(170, Math.max(1, pose.fov));
        }
        this._touched.add(node);
    }

    // ---- property ------------------------------------------------------------------------------------

    private _propertyRoot(track: PropertyTrack): unknown {
        if (track.target === 'renderer') return this._host.renderer ?? null;
        if (track.target === 'game') return this._host.game ?? null;
        return this._host.resolveSlot(track.slot!);
    }

    private _evalProperty(track: PropertyTrack, time: number, fireFrom: number | undefined): void {
        const state = this._state(track);
        const res = this._resolveSections(track, state, time, fireFrom, 'keep');
        if (!res) return;
        const key = `prop:${track.id}`;
        if ('restore' in res) { this._restore(key); return; }
        const root = this._propertyRoot(track);
        if (!root) return;
        if (state.accessorRoot !== root || !state.accessor) {
            state.accessor = compilePropertyPath(root as object, track.path);
            state.accessorRoot = root;
        }
        const accessor = state.accessor;

        if (!this._restores.has(key)) {
            const original = snapshotValue(accessor.get());
            if (original === undefined) {
                if (!state.warned) {
                    Logger.warn(`Sequence '${this._seq.name}': '${track.path}' does not resolve on ${track.slot ?? track.target}.`, 'Script');
                    state.warned = true;
                }
                return;
            }
            this._originals.set(key, original);
            this._restores.set(key, () => { accessor.set(snapshotValue(original)); });
        }

        const sections = 'hold' in res ? [res.hold] : res.active;
        const at = 'hold' in res ? res.hold.end : time;
        let value: unknown = snapshotValue(this._originals.get(key));
        for (const s of sections) {
            const w = 'hold' in res ? 1 : rampWeight(s.start, s.end, s.easeIn, s.easeOut, at);
            if (w <= 0) continue;
            const local = Math.min(at, s.end) - s.start;
            if (track.valueType === 'number') {
                const v = evaluateKeyedNumber(s.curve, local, typeof value === 'number' ? value : 0);
                value = typeof value === 'number' && w < 1 ? value + (v - value) * w : v;
            } else if (track.valueType === 'vector') {
                const first = s.curve.keys[0]?.v;
                const width = Array.isArray(value) ? value.length : Array.isArray(first) ? first.length : 3;
                const v = evaluateKeyedVector(s.curve, local, new Array(width).fill(0));
                value = Array.isArray(value) && w < 1 ? (value as number[]).map((x, i) => x + (v[i] - x) * w) : v;
            } else if (w >= 0.5) {
                // Steps cannot blend: the section in charge decides once it is at least half in.
                value = evaluateKeyedStep(s.curve as any, local, value);
            }
        }
        accessor.set(value);
    }

    // ---- presets -------------------------------------------------------------------------------------

    /** Warn once per track. */
    private _warnOnce(track: SequenceTrack, state: TrackState, message: string): void {
        if (state.warned) return;
        state.warned = true;
        Logger.warn(`Sequence '${this._seq.name}': ${track.name ?? track.id}: ${message}`, 'Script');
    }

    /** The preset of the last section on `track` that starts before `section`: where a chain's next blend starts. */
    private static _previousPreset(track: PresetTrack, section: PresetSection): string | undefined {
        let best: PresetSection | undefined;
        for (const s of track.sections)
            if (s !== section && s.start < section.start && (!best || s.start >= best.start)) best = s;
        return best?.preset;
    }

    private _evalPreset(track: PresetTrack, time: number, fireFrom: number | undefined): void {
        const state = this._state(track);
        const res = this._resolveSections(track, state, time, fireFrom, 'keep');
        if (!res) return;
        const key = `preset:${track.id}`;
        if ('restore' in res) { this._restore(key); return; }
        const node = this._host.resolveSlot(track.slot);
        if (!node) return;
        const list = sequencePresetsFor(node);
        if (!list) { this._warnOnce(track, state, `a ${node.nodeType ?? 'node'} has no presets to blend.`); return; }

        // Every field the list sets, captured once: a stop puts the node back exactly as it was.
        if (!this._restores.has(key)) {
            const original: Record<string, unknown> = {};
            for (const f of presetFields(list)) {
                const v = snapshotValue(node[f]);
                if (v !== undefined) original[f] = v;
            }
            this._originals.set(key, original);
            this._restores.set(key, () => {
                for (const [f, v] of Object.entries(original)) node[f] = assignable(snapshotValue(v), node[f]);
            });
        }
        const original = this._originals.get(key) as Record<string, unknown>;

        // The section that started last is in charge; it blends from its base to its preset, eased.
        const sections = 'hold' in res ? [res.hold] : res.active;
        const section = sections.reduce((a, b) => (b.start >= a.start ? b : a));
        const find = (id: string | undefined) => (id ? list.find(p => p.id === id) : undefined);
        const target = find(section.preset);
        if (!target) { this._warnOnce(track, state, `no preset '${section.preset}' for a ${node.nodeType}.`); return; }
        const base = find(section.from) ?? find(SequencePlayer._previousPreset(track, section));
        const baseOptions = base?.options as Record<string, unknown> | undefined;
        const at = 'hold' in res ? section.end : time;
        const t = section.end > section.start ? smoothstep(section.start, section.end, at) : 1;
        for (const [f, b] of Object.entries(target.options as Record<string, unknown>)) {
            if (!(f in original) || b === undefined) continue;
            const a = baseOptions && baseOptions[f] !== undefined ? baseOptions[f] : original[f];
            node[f] = assignable(blendPresetValue(a, b, t), node[f]);
        }
    }

    // ---- foliage -------------------------------------------------------------------------------------

    private _evalFoliage(track: FoliageTrack, time: number, fireFrom: number | undefined): void {
        const state = this._state(track);
        const res = this._resolveSections(track, state, time, fireFrom, 'keep');
        if (!res) return;
        const key = `foliage:${track.id}`;
        if ('restore' in res) { this._restore(key); return; }

        if (!this._restores.has(key)) {
            const landscape = this._host.resolveSlot(track.slot);
            const all: any[] = landscape?.terrain?.foliage ?? [];
            const names = track.layers;
            const layers = names === 'all' ? all : all.filter(l => names.includes(l.name));
            if (layers.length === 0) {
                if (landscape) this._warnOnce(track, state, 'no foliage layer matches.');
                return;
            }
            // Each layer's own values: the channels are multipliers on them, and a stop puts them back.
            const saved: FoliageSaved[] = layers.map(layer => ({
                layer, densityScale: layer.densityScale ?? 1, cullDistance: layer.cullDistance,
                billboardDistance: layer.billboardDistance, castShadows: layer.castShadows,
            }));
            this._originals.set(key, saved);
            this._restores.set(key, () => {
                for (const o of saved) {
                    o.layer.densityScale = o.densityScale; o.layer.cullDistance = o.cullDistance;
                    o.layer.billboardDistance = o.billboardDistance; o.layer.castShadows = o.castShadows;
                }
            });
        }
        const saved = this._originals.get(key) as FoliageSaved[];

        const sections = 'hold' in res ? [res.hold] : res.active;
        const at = 'hold' in res ? res.hold.end : time;
        let density = 1, cull = 1, billboard = 1;
        let shadows: boolean | undefined;
        for (const s of sections) {
            const w = 'hold' in res ? 1 : rampWeight(s.start, s.end, s.easeIn, s.easeOut, at);
            if (w <= 0) continue;
            const local = Math.min(at, s.end) - s.start;
            if (s.density) density += (evaluateKeyedNumber(s.density, local, 1) - density) * w;
            if (s.cull) cull += (evaluateKeyedNumber(s.cull, local, 1) - cull) * w;
            if (s.billboard) billboard += (evaluateKeyedNumber(s.billboard, local, 1) - billboard) * w;
            if (s.shadows && w >= 0.5) shadows = evaluateKeyedStep(s.shadows, local, shadows ?? true);
        }
        // A layer drawing out to the renderer's distance (its own 0) is brought in from that one.
        const sceneCull = Number(this._host.renderer?.foliageCullDistance) || 0;
        for (const o of saved) {
            o.layer.densityScale = o.densityScale * clamp01(density);
            const from = o.cullDistance > 0 ? o.cullDistance : sceneCull;
            o.layer.cullDistance = cull === 1 || !(from > 0) ? o.cullDistance : Math.max(0.01, from * Math.max(0, cull));
            if (Number.isFinite(o.billboardDistance)) o.layer.billboardDistance = o.billboardDistance * Math.max(0, billboard);
            o.layer.castShadows = shadows ?? o.castShadows;
        }
    }

    // ---- camera cut ----------------------------------------------------------------------------------

    private _evalCut(track: CameraCutTrack, time: number, fireFrom: number | undefined): void {
        const state = this._state(track);
        const res = this._resolveSections(track, state, time, fireFrom, 'restore');
        if (!res) return;
        const key = `cut:${track.id}`;
        if ('restore' in res) { this._restore(key); this._shotCamera = null; return; }
        // The section that started last is the shot on screen.
        const sections = 'hold' in res ? [res.hold] : res.active;
        const shot = sections.reduce((a, b) => (b.start >= a.start ? b : a));
        const camera = this._host.resolveSlot(shot.slot);
        this._shotCamera = camera ?? null;
        // Reporting only (an editor preview): the scene's camera, its pin and every `active` flag stay as they are.
        if (this._host.applyCuts === false) return;
        if (!camera || state.cutCamera === camera) return;

        const scene = this._host.scene;
        if (!this._restores.has(key)) {
            const pinned = scene?.pinnedCamera ?? null;
            const touched = new Map<any, boolean>();
            state.cutTouched = touched;
            this._restores.set(key, () => {
                for (const [cam, wasActive] of touched) cam.active = wasActive;
                scene?.setActiveCamera?.(pinned);
                state.cutCamera = null;
                state.cutTouched = undefined;
            });
        }
        const touched = state.cutTouched!;
        // The previous shot's camera goes back to how it was authored: an inactive cinematic camera
        // must not win the scene's first-active scan once the sequence lets go.
        const previous = state.cutCamera;
        if (previous && touched.has(previous)) previous.active = touched.get(previous);
        if (!touched.has(camera)) touched.set(camera, camera.active);
        camera.active = true;
        scene?.setActiveCamera?.(camera);
        state.cutCamera = camera;
    }

    // ---- events --------------------------------------------------------------------------------------

    private _fireEvents(track: EventTrack, from: number, to: number): void {
        for (const key of track.keys) {
            if (key.t <= from || key.t > to) continue;
            this._fire(key);
        }
    }

    private _fire(key: EventKey): void {
        const name = key.name ?? key.method ?? '';
        if (key.method) {
            const target = key.slot ? this._host.resolveSlot(key.slot) : this._host.director;
            const fn = target?.[key.method];
            if (typeof fn === 'function') {
                try { fn.apply(target, key.args ?? []); }
                catch (e) { Logger.error(`Sequence '${this._seq.name}': ${key.method}() at ${key.t}s threw: ${e}`, 'Script'); }
            } else {
                Logger.warn(`Sequence '${this._seq.name}': no method '${key.method}' on ${key.slot ?? 'the director'} (event at ${key.t}s).`, 'Script');
            }
        }
        for (const listener of this._listeners) {
            try { listener(name, key); } catch (e) { Logger.error(`Sequence '${this._seq.name}': an event listener threw: ${e}`, 'Script'); }
        }
    }
}

/** A foliage layer's values as a Foliage track found them. */
interface FoliageSaved {
    layer: any;
    densityScale: number;
    cullDistance: number;
    billboardDistance: number;
    castShadows: boolean;
}

/** `v` in the shape the target holds: a typed array stays one (a gl-matrix vec3 field), else as is. */
function assignable(v: unknown, current: unknown): unknown {
    if (Array.isArray(v) && ArrayBuffer.isView(current) && !(current instanceof DataView))
        return new (current.constructor as new (a: number[]) => unknown)(v);
    return v;
}
