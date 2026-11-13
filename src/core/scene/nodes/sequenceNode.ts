import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { Logger } from "../../logger";
import { authoring } from "../../eventBus";
import { unwrapScriptNode } from "./nodeScripting";
import { parseSequence, emptySequence } from "../../../sequencer/parse";
import { SequencePlayer, type SequenceEventListener } from "../../../sequencer/sequencePlayer";
import type { SequenceData, SequenceSlot } from "../../../sequencer/types";

/** Why a playback ended: it ran to the end, or something stopped it. */
export type SequenceEndReason = 'finished' | 'stopped';

export interface SequencePlayOptions {
    /** Sequence seconds to start from. Default 0. */
    from?: number;
    /** Nodes for slots, by slot id or slot name, overriding the authored bindings for this playback. */
    bindings?: Record<string, Node>;
    /** Playback rate multiplier. Default 1. */
    rate?: number;
}

/**
 * Plays a sequence (sequencer/types.ts): the scene object that owns a cinematic.
 *
 * It holds its own copy of the sequence data and the map from the sequence's SLOTS to nodes in this scene.
 * A director script attached to this node receives the sequence's event keys as method calls:
 *
 *   export default class IntroDirector extends Node {
 *     openGate() { this.findNode('Gate')?.play?.('Open') }
 *   }
 *
 * Playback runs in the scene's sequence pass, after the control pass and before the node loop, so a camera
 * the sequence moves renders the same frame and every `onUpdate` reads the values it wrote.
 *
 *   const intro = this.findNode('Intro') as SequenceNode
 *   await intro.play().finished
 *
 * Script sections call a method of the director (or of a bound node) with a context as they are entered, every
 * frame inside, and as they are left; a `hold` section stops the playback at its end until the method calls
 * `ctx.resume()` (or something calls this node's `resume()`):
 *
 *   waitForGate(ctx: SequenceScriptContext) {
 *     if ((this.findNode('Gate') as any)?.isOpen) ctx.resume()   // called every frame, holding included
 *   }
 */
export class SequenceNode extends Node {
    private _data: SequenceData;
    private _bindings: Record<string, string>;
    private _sequenceId: string | null;
    /** Start playing the first frame the game runs (never while editing). */
    public autoplay: boolean;
    /**
     * Runtime, never saved: whether the camera cut takes the scene's camera. The editor turns it off while it
     * previews, so its viewport keeps the editor camera; the shot camera is then only reported in
     * {@link shotCamera}.
     */
    public previewCuts: boolean = true;

    private _player: SequencePlayer | null = null;
    private _time = 0;
    private _playing = false;
    private _paused = false;
    private _rate = 1;
    private _autoplayed = false;
    /** The hold section playback waits at, and the holds already let go this playback. */
    private _holding: string | null = null;
    private readonly _released = new Set<string>();
    /** Sequence seconds per real second over the last advance (audio tracks play at it). */
    private _speed = 1;
    private readonly _overrides = new Map<string, Node>();
    private readonly _slotCache = new Map<string, Node>();
    private readonly _endListeners = new Set<(reason: SequenceEndReason) => void>();
    private _finished: Promise<SequenceEndReason> = Promise.resolve('finished');
    private _resolveFinished: ((reason: SequenceEndReason) => void) | null = null;

    constructor(name: string, options: {
        sequence?: SequenceData; bindings?: Record<string, string>; autoplay?: boolean; sequenceId?: string | null;
    } = {}, id: string = uuidv4()) {
        super(name, 'sequence', id);
        this._data = options.sequence ?? emptySequence(name);
        this._bindings = { ...(options.bindings ?? {}) };
        this.autoplay = options.autoplay === true;
        this._sequenceId = options.sequenceId ?? null;
    }

    // ---- data ----------------------------------------------------------------------------------------

    /** The sequence this node plays (its own copy). Assigning one replaces it; a playback in progress continues. */
    public get sequence(): SequenceData { return this._data; }
    public set sequence(data: SequenceData) {
        this._data = parseSequence(data);
        this._player?.setSequence(this._data);
        this._slotCache.clear();
    }

    /**
     * The library `.sequence` asset this node's copy mirrors, or null. The copy above is what plays (a
     * published game needs no library); the editor refreshes it from the asset when the asset is saved and
     * when a scene is opened or published. Like a particle system's `particleSystemId`.
     */
    public get sequenceId(): string | null { return this._sequenceId; }
    public set sequenceId(value: string | null) {
        if (value === this._sequenceId) return;
        const prev = this._sequenceId;
        this._sequenceId = value;
        this._notifyChange('component', 'sequenceId', prev, value);
    }

    /** Slot id → node id. */
    public get bindings(): Readonly<Record<string, string>> { return this._bindings; }

    /** Bind `slot` (an id or a name) to a node, or unbind it with null. */
    public bind(slot: string, node: Node | string | null): void {
        const id = this._slotOf(slot)?.id ?? slot;
        if (node === null) delete this._bindings[id];
        else this._bindings[id] = typeof node === 'string' ? node : unwrapScriptNode(node).id;
        this._slotCache.delete(id);
    }

    public get duration(): number { return this._data.duration; }
    /** Sequence seconds. */
    public get time(): number { return this._time; }
    public get isPlaying(): boolean { return this._playing; }
    public get isPaused(): boolean { return this._paused; }
    /** Waiting at the end of a `hold` script section for a `resume()`. */
    public get isHolding(): boolean { return this._holding !== null; }
    /** The camera the camera cut has on screen at the current time (reported even when `previewCuts` is off). */
    public get shotCamera(): Node | null { return this._player?.shotCamera ?? null; }

    /** Resolves when the current (or last) playback ends, with why. */
    public get finished(): Promise<SequenceEndReason> { return this._finished; }

    // ---- playback ------------------------------------------------------------------------------------

    /** Start (or restart) playback. Returns this node, whose `finished` resolves when it ends. */
    public play(options: SequencePlayOptions = {}): this {
        if (this._playing) this._end('stopped', false);
        this._overrides.clear();
        this._slotCache.clear();
        for (const [slot, node] of Object.entries(options.bindings ?? {})) {
            const id = this._slotOf(slot)?.id ?? slot;
            if (node) this._overrides.set(id, unwrapScriptNode(node));
        }
        this._rate = typeof options.rate === 'number' && options.rate > 0 ? options.rate : 1;
        this._holding = null;
        this._released.clear();
        const from = Math.min(this._data.duration, Math.max(0, options.from ?? 0));
        this._finished = new Promise(resolve => { this._resolveFinished = resolve; });
        this._playing = true;
        this._paused = false;
        this._time = from;
        // Evaluate now, firing keys AT the start time, so the first frame already shows the first shot
        // (rather than one frame of whatever camera was live before).
        this._apply(this._player_().evaluate(from, from - 1e-6));
        return this;
    }

    public pause(): void { if (this._playing) this._paused = true; }

    /** Carry on after `pause()`, and past a `hold` section the playback is waiting at. */
    public resume(): void {
        if (!this._playing) return;
        this._paused = false;
        this._releaseHold(this._holding);
    }

    /** Let hold `sectionId` go: now if playback waits at it, else when it gets there. */
    private _releaseHold(sectionId: string | null): void {
        if (!sectionId) return;
        this._released.add(sectionId);
        if (this._holding === sectionId) this._holding = null;
    }

    /**
     * Stop and put back everything the sequence changed. After a playback that ran to its end (and kept its
     * final state), this only restores: the playback already ended, so no end listener fires again.
     */
    public stop(): void {
        if (this._playing) { this._end('stopped', true); return; }
        if (this._player?.hasCapturedState) this._apply(this._player.restoreAll());
    }

    /** Jump to `time` without firing events (a scrub). Works while stopped too, for previews. */
    public seek(time: number): void {
        this._time = Math.min(this._data.duration, Math.max(0, time));
        // A jump away from a hold leaves it behind (one jumped back to is held at again).
        this._holding = null;
        this._apply(this._player_().evaluate(this._time));
    }

    /** Jump to the end and finish, without firing the events in between. */
    public skip(): void {
        if (!this._playing) return;
        this.seek(this._data.duration);
        this._end('finished', false);
    }

    /** Call `listener(reason)` whenever a playback ends. Returns the remover. */
    public onFinished(listener: (reason: SequenceEndReason) => void): () => void {
        this._endListeners.add(listener);
        return () => { this._endListeners.delete(listener); };
    }

    /** Call `listener(name, key)` for every event key the playback passes. Returns the remover. */
    public onEvent(listener: SequenceEventListener): () => void {
        return this._player_().onEvent(listener);
    }

    /**
     * @internal The scene's sequence pass. `running` is "the scene is started and not paused"; `authoring`
     * means the editor is editing, where autoplay never fires.
     */
    public advanceSequence(delta: number, unscaledDelta: number, running: boolean, authoring: boolean): void {
        // Autoplay is a runtime rule, like spawnOnStart: never in a scene that has them off (an editor's), even in
        // the frames before the editor's authoring flag is up (a scene still loading) — a sequence played there
        // would write its first frame into the scene being authored.
        if (this.autoplay && !this._autoplayed && running && !authoring && this.scene?.spawnRulesEnabled !== false) {
            this._autoplayed = true;
            this.play();
            return;
        }
        if (!this._playing || this._paused || !running) return;
        const player = this._player_();
        // Waiting at a hold: the frame stays, and the section's method is still called every frame, so it can
        // watch for what it waits on and resume.
        if (this._holding) { this._apply(player.evaluate(this._time, this._time)); return; }
        const dt = (this._data.clock === 'real' ? unscaledDelta : delta) * this._rate;
        if (!(dt > 0)) return;
        if (unscaledDelta > 0) this._speed = dt / unscaledDelta;
        const duration = this._data.duration;
        const prev = this._time;
        let next = prev + dt;
        // A hold section ahead: land on its end and wait there.
        const hold = player.holdBetween(prev, Math.min(next, duration), this._released);
        if (hold) {
            this._time = hold.end;
            this._apply(player.evaluate(hold.end, prev));
            // Its method may have let it go already, while it was being left.
            if (!this._released.has(hold.id)) this._holding = hold.id;
            return;
        }
        if (next < duration) {
            this._time = next;
            this._apply(player.evaluate(next, prev));
            return;
        }
        // The end: land exactly on it, firing the keys up to it.
        this._apply(player.evaluate(duration, prev));
        if (this._data.loop && duration > 0) {
            next %= duration;
            this._time = next;
            // The wrap fires keys at 0 too: (-epsilon, next].
            this._apply(player.evaluate(next, -1e-6));
            return;
        }
        this._time = duration;
        this._end('finished', false);
    }

    private _end(reason: SequenceEndReason, restore: boolean): void {
        this._playing = false;
        this._paused = false;
        this._holding = null;
        // Step just past the end, so sections that run to it settle as they ask: the last shot of a cut track
        // hands the camera back (its default), a path or property holds its final value.
        if (reason === 'finished' && this._player) {
            const end = this._data.duration;
            this._apply(this._player.evaluate(end + 1e-6, end));
        }
        if (restore && this._player) this._apply(this._player.restoreAll());
        const resolve = this._resolveFinished;
        this._resolveFinished = null;
        resolve?.(reason);
        for (const listener of Array.from(this._endListeners)) {
            try { listener(reason); }
            catch (e) { Logger.error(`Sequence '${this.name}': a finished listener threw: ${e}`, 'Script'); }
        }
    }

    // ---- slots ---------------------------------------------------------------------------------------

    private _slotOf(idOrName: string): SequenceSlot | undefined {
        return this._data.slots.find(s => s.id === idOrName) ?? this._data.slots.find(s => s.name === idOrName);
    }

    /**
     * The node bound to a slot: a playback override, this node's binding, the node the sequence was authored
     * against (`slot.nodeId`), or the slot's fallback path.
     */
    public resolveSlot(slotId: string): Node | null {
        const override = this._overrides.get(slotId);
        if (override) return override.scene ? override : null;
        const cached = this._slotCache.get(slotId);
        if (cached && cached.scene === this.scene && !cached.markForRemoval) return cached;
        const scene = this.scene;
        if (!scene) return null;
        let node: Node | null = null;
        const id = this._bindings[slotId];
        if (id) node = scene.getNodeById(id) ?? null;
        if (!node) {
            const slot = this._data.slots.find(s => s.id === slotId);
            if (slot?.nodeId) node = scene.getNodeById(slot.nodeId) ?? null;
            if (!node && slot?.path) node = resolveNodePath(scene.root, slot.path);
        }
        if (node) this._slotCache.set(slotId, node); else this._slotCache.delete(slotId);
        return node;
    }

    private _player_(): SequencePlayer {
        if (!this._player) {
            const self = this;
            this._player = new SequencePlayer(this._data, {
                resolveSlot: (slot: string) => self.resolveSlot(slot),
                get director() { return self; },
                get scene() { return self.scene; },
                get renderer() { return sequenceGlobals.renderer?.() ?? null; },
                get game() { return sequenceGlobals.game?.() ?? null; },
                get applyCuts() { return self.previewCuts; },
                // Editing: the scene is the one being authored, not a game's.
                get authoring() { return authoring.enabled; },
                get playbackRate() { return self._speed; },
                setSlotOverride: (slot: string, node: any | null) => {
                    if (node) self._overrides.set(slot, node); else self._overrides.delete(slot);
                },
                releaseHold: (sectionId: string) => self._releaseHold(sectionId),
            });
        }
        return this._player;
    }

    /** Refresh the world matrices of the nodes a pass wrote, so everything after reads this frame's pose. */
    private _apply(touched: Set<any>): void {
        for (const node of touched) {
            let ancestor = node.parent, covered = false;
            while (ancestor) { if (touched.has(ancestor)) { covered = true; break; } ancestor = ancestor.parent; }
            if (!covered) node.updateTransforms(node.parent?.worldTransform ?? null);
        }
    }

    // ---- node plumbing -------------------------------------------------------------------------------

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        return { min: vec3.fromValues(p[0] - 0.5, p[1] - 0.5, p[2] - 0.5), max: vec3.fromValues(p[0] + 0.5, p[1] + 0.5, p[2] + 0.5) };
    }

    protected _serializePayload(): any {
        return {
            // A copy: a serialized snapshot (an undo baseline) must not alias the live sequence.
            sequence: structuredClone(this._data),
            bindings: { ...this._bindings },
            ...(this.autoplay ? { autoplay: true } : {}),
            ...(this._sequenceId ? { sequenceId: this._sequenceId } : {}),
        };
    }

    public static parse(parent: Node, json: any) {
        const bindings: Record<string, string> = {};
        if (json.bindings && typeof json.bindings === 'object')
            for (const [slot, id] of Object.entries(json.bindings)) if (typeof id === 'string') bindings[slot] = id;
        const node = new SequenceNode(json.name, {
            sequence: parseSequence(json.sequence), bindings, autoplay: json.autoplay === true,
            sequenceId: typeof json.sequenceId === 'string' && json.sequenceId ? json.sequenceId : null,
        }, json.id);
        Node.finishParse(node, parent, json);
    }
}

/**
 * Where property tracks with a `target` find their roots. Installed by the engine (the renderer, the Game
 * facade), not imported here, because this module sits below both in the import graph.
 */
export const sequenceGlobals: { renderer?: () => unknown; game?: () => unknown } = {};

/** A node by NAME path from `root` ("Buildings/Long House"); a single name matches anywhere, breadth-first. */
export function resolveNodePath(root: Node, path: string): Node | null {
    const parts = path.split('/').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
        const queue: Node[] = [...root.children];
        while (queue.length > 0) {
            const n = queue.shift()!;
            if (n.name === parts[0]) return n;
            queue.push(...n.children);
        }
        return null;
    }
    let node: Node | undefined = root;
    for (const part of parts) {
        node = node?.children.find(c => c.name === part);
        if (!node) return null;
    }
    return node ?? null;
}

