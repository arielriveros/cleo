import { Sprite, legacySheetTileset, remapLegacyFrame } from "../../../graphics/sprite";
import type { Scene } from "../scene";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { SpriteNode, spritePayload } from "./spriteNode";
import { CharacterBody2DNode } from "./characterBody2DNode";
import { Area2DNode } from "./area2DNode";
import { createConditionContext } from "../../conditions";
import type { ConditionContext } from "../../conditions";
import {
    advanceClip, cloneSpriteAnimationSet, createPlayhead, normalizedTime, parseSpriteAnimationSet, stepSpriteMachine,
} from "../../../animation/spriteAnimation";
import type { SpriteAnimationSet, SpriteClip } from "../../../animation/spriteAnimation";

/**
 * A sprite that plays a frame sequence.
 */

export type SpriteFrameSource = 'node' | 'tile';

export class AnimatedSpriteNode extends SpriteNode {
    private _frames: number[];
    private _frameSource: SpriteFrameSource;
    private _fps: number;
    private _loop: boolean;
    /** The `tile` source's rate: 0 plays at the tile's own fps, above 0 overrides it for this sprite only. */
    private _tileFps: number;
    /**
     * Start somewhere random in `frames` (and part-way into that frame), so copies of one sprite — a row
     * of torches — do not flicker in step.
     */
    private _randomStart: boolean;
    /** Index INTO `_frames`, not a tile index. */
    private _currentFrame: number;
    private _accumulator: number;
    /** Scene time, for the `tile` source — `Tileset.frameOf` is a pure function of it. */
    private _elapsed: number;

    // --- clips (an animation set) -------------------------------------------------------------------
    /** The embedded animation set, or null for the single frame list above. See {@link animationSet}. */
    private _set: SpriteAnimationSet | null = null;
    /** The library asset the set came from, for the editor's link; null when it is the node's own. */
    public animationSetId: string | null = null;
    private _clip: SpriteClip | null = null;
    private readonly _head = createPlayhead();
    private _stateName: string | null = null;
    private _stateSpeed = 1;
    /** False while a `play()` of a clip the machine has no state for holds the machine off. */
    private _machineOn = true;
    private readonly _params: ConditionContext = createConditionContext();
    private readonly _entered: number[] = [];
    /** Every Area2D name a frame of the set switches, for switching the rest off. */
    private _hitboxNames: string[] = [];
    /** The hitboxes still have to be set for the frame on screen (the set was given before the sprite had a parent). */
    private _hitboxesPending = true;
    /** Multiplies every clip's rate: slow motion of one character, a stagger. */
    public speed: number = 1;
    /** Hold on the frame on screen. */
    public paused: boolean = false;

    constructor(
        name: string,
        sprite: Sprite,
        options?: {
            frames?: number[],
            frameSource?: SpriteFrameSource,
            fps?: number,
            loop?: boolean,
            tileFps?: number,
            randomStart?: boolean,
            constraints?: 'free' | 'spherical' | 'cylindrical',
            id?: string
        }
    ) {
        super(name, sprite, options?.constraints || 'spherical', options?.id || uuidv4(), 'animatedSprite');
        this._frames = [...(options?.frames ?? [])];
        this._frameSource = options?.frameSource ?? 'node';
        this._fps = Math.max(0.0001, options?.fps ?? 12);
        this._loop = options?.loop ?? true;
        this._tileFps = Math.max(0, options?.tileFps ?? 0);
        this._randomStart = options?.randomStart === true;
        this._currentFrame = 0;
        this._accumulator = 0;
        this._elapsed = 0;
        if (this._randomStart) this._startRandomly();
    }

    private _startRandomly(): void {
        if (this._frames.length > 0) this._currentFrame = Math.floor(Math.random() * this._frames.length);
        this._accumulator = Math.random() / this._fps;
        // The `tile` source reads elapsed time; an offset into one loop of it does the same job there.
        this._elapsed = Math.random() * Math.max(1, this._frames.length) / this._fps;
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        this._elapsed += delta;
        if (this._set) { this._updateClips(delta); return; }
        // The `tile` source is a pure function of elapsed time (see uvRect) — nothing to step.
        if (this._frameSource === 'tile') return;
        if (this._frames.length === 0) return;

        const frameTime = 1.0 / this._fps;
        this._accumulator += delta;
        while (this._accumulator >= frameTime) {
            this._accumulator -= frameTime;
            if (this._currentFrame < this._frames.length - 1) this._currentFrame++;
            else if (this._loop) this._currentFrame = 0;
            // Non-looping holds on the last frame.
        }
    }

    /** The tile index actually on screen this instant. */
    public get currentTile(): number {
        if (this._clip) {
            const frames = this._clip.frames;
            return frames.length > 0 ? frames[Math.max(0, Math.min(this._head.frame, frames.length - 1))].tile : this.tileIndex;
        }
        if (this._frameSource === 'tile') {
            const tileset = this.sprite.tileset;
            return tileset ? tileset.frameOf(this.tileIndex, this._elapsed, this._tileFps) : this.tileIndex;
        }
        if (this._frames.length === 0) return this.tileIndex;
        const i = Math.max(0, Math.min(this._currentFrame, this._frames.length - 1));
        return this._frames[i];
    }

    public uvRect(): [number, number, number, number] { return this.sprite.uvRectOf(this.currentTile); }

    protected _serializePayload(): any {
        // Must spread the parent's payload rather than replace it, or the sprite's own keys are dropped.
        return {
            ...super._serializePayload(),
            animation: {
                frames: [...this._frames],
                frameSource: this._frameSource,
                fps: this._fps,
                loop: this._loop,
                // Only when set, so a sprite that follows its tile serializes as it always did.
                ...(this._tileFps > 0 ? { tileFps: this._tileFps } : {}),
                ...(this._randomStart ? { randomStart: true } : {}),
            },
            // The clips, embedded like the tileset (and linked by id to the library asset they came from).
            ...(this._set ? { animationSet: cloneSpriteAnimationSet(this._set) } : {}),
            ...(this._set && this.animationSetId ? { animationSetId: this.animationSetId } : {}),
        };
    }

    public static parse(parent: Node, json: any) {
        const sprite = Sprite.parse(spritePayload(json));
        const animation = migrateLegacyAnimation(json, sprite);
        const spriteNode = new AnimatedSpriteNode(json.name, sprite, {
            id: json.id,
            constraints: json.sprite?.constraints,
            frames: animation.frames,
            frameSource: animation.frameSource,
            fps: animation.fps,
            loop: animation.loop,
            tileFps: json?.animation?.tileFps,
            randomStart: json?.animation?.randomStart,
        });
        const set = json?.animationSet ? parseSpriteAnimationSet(json.animationSet) : null;
        if (set) {
            spriteNode.animationSet = set;
            spriteNode.animationSetId = typeof json.animationSetId === 'string' ? json.animationSetId : null;
        }
        Node.finishParse(spriteNode, parent, json);
    }

    // --- clips ----------------------------------------------------------------------------------------

    /**
     * The sprite's animation set: named clips (idle, run, attack...), each frames of the tileset with their own
     * times, events and hitboxes, and an optional state machine that picks the clip from what the character
     * does. While one is set it is what plays; the single `frames` list is the fallback without one.
     * Assigning embeds a copy and starts the set's entry state (or default clip).
     */
    public get animationSet(): SpriteAnimationSet | null { return this._set; }
    public set animationSet(set: SpriteAnimationSet | null) {
        this._set = set ? cloneSpriteAnimationSet(set) : null;
        this._clip = null;
        this._stateName = null;
        this._machineOn = true;
        this._hitboxNames = [];
        if (!this._set) return;
        const names = new Set<string>();
        for (const clip of this._set.clips) for (const f of clip.frames) for (const h of f.hitboxes ?? []) names.add(h.area);
        this._hitboxNames = [...names];
        const machine = this._set.machine;
        if (machine) this._enterState(machine.entry);
        else this._startClip(this._set.defaultClip);
    }

    /** The clip playing, by name, or null. */
    public get clip(): string | null { return this._clip?.name ?? null; }
    /** The machine's state, by name, or null (no machine, or held off by a `play`). */
    public get state(): string | null { return this._machineOn ? this._stateName : null; }
    /** A once-clip that has reached its end. */
    public get isFinished(): boolean { return this._head.finished; }
    /** How far through its clip the sprite is, 0..1. */
    public get normalizedTime(): number { return this._clip ? normalizedTime(this._clip, this._head) : 0; }
    /** The frame of the clip on screen, from 0. */
    public get clipFrame(): number { return this._head.frame; }
    /** Every clip's name, in the set's order. */
    public get clipNames(): string[] { return this._set ? this._set.clips.map(c => c.name) : []; }

    /**
     * Play `name`: a state of the machine (or the state that plays that clip), else that clip on its own with
     * the machine held off until {@link resumeMachine}. The clip already playing carries on unless `restart`.
     */
    public play(name: string, restart: boolean = false): void {
        const set = this._set;
        if (!set) return;
        const machine = set.machine;
        const state = machine?.states.find(s => s.name === name) ?? machine?.states.find(s => s.clip === name);
        if (state) {
            this._machineOn = true;
            if (state.name !== this._stateName || restart) this._enterState(state.name);
            return;
        }
        if (!set.clips.some(c => c.name === name)) return;
        this._machineOn = !machine;
        if (this._clip?.name !== name || restart) this._startClip(name);
    }

    /** Hand the sprite back to its state machine after a `play` of a clip it has no state for. */
    public resumeMachine(): void {
        if (!this._set?.machine || this._machineOn) return;
        this._machineOn = true;
        this._enterState(this._stateName ?? this._set.machine.entry);
    }

    /** Set a machine parameter (a number or a yes/no) a transition reads. */
    public setParam(name: string, value: number | boolean): void { this._params.values.set(name, value); }
    /** Raise a machine trigger: the next transition that reads it fires and lowers it. */
    public fireTrigger(name: string): void { this._params.values.set(name, true); }
    /** A machine parameter's value now. */
    public param(name: string): number | boolean | undefined { return this._params.values.get(name); }

    private _enterState(name: string): void {
        const state = this._set?.machine?.states.find(s => s.name === name);
        if (!state) return;
        this._stateName = state.name;
        this._stateSpeed = state.speed ?? 1;
        this._startClip(state.clip);
    }

    private _startClip(name: string): void {
        const clip = this._set?.clips.find(c => c.name === name) ?? null;
        this._clip = clip;
        const h = this._head;
        h.frame = 0; h.time = 0; h.direction = 1; h.finished = false; h.elapsed = 0;
        if (!this._machineOn || !this._set?.machine) this._stateSpeed = 1;
        if (clip?.pivot) this.sprite.pivot = clip.pivot;
        this._enterFrame(0);
    }

    /** The character body this sprite belongs to: itself or its nearest ancestor. Its state drives the machine. */
    private _ownerBody2D(): CharacterBody2DNode | null {
        for (let n: Node | null = this.parent; n; n = n.parent) if (n instanceof CharacterBody2DNode) return n;
        return null;
    }

    private _updateClips(delta: number): void {
        const body = this._ownerBody2D();
        const v = this._params.values;
        if (body) {
            v.set('grounded', body.isGrounded);
            v.set('velocityX', body.velocity2D[0]);
            v.set('velocityY', body.velocity2D[1]);
            v.set('speedX', Math.abs(body.velocity2D[0]));
            v.set('onWall', body.onWall !== 0);
            v.set('wallSliding', body.isWallSliding);
            v.set('dashing', body.isDashing);
            v.set('facing', body.facing);
            if (body.justJumped) v.set('jumped', true);
            if (body.justLanded) v.set('landed', true);
            if (body.justDashed) v.set('dashed', true);
        }
        const machine = this._set?.machine;
        if (machine && this._machineOn && this._stateName) {
            const next = stepSpriteMachine(machine, this._stateName, this.normalizedTime, this._params);
            if (next) this._enterState(next);
        }
        // This frame's motion events are spent whether or not a transition read them.
        v.set('jumped', false); v.set('landed', false); v.set('dashed', false);

        const clip = this._clip;
        if (clip && this._hitboxesPending) this._applyHitboxes(clip.frames[this._head.frame]);
        if (!clip || this.paused) return;
        const wasFinished = this._head.finished;
        const entered = this._entered;
        entered.length = 0;
        advanceClip(clip, this._head, delta * Math.max(0, this.speed) * (clip.speed ?? 1) * this._stateSpeed, entered);
        for (const frame of entered) this._enterFrame(frame);
        if (this._head.finished && !wasFinished) {
            const name = clip.name;
            this.onAnimationFinished(name);
            if (this.parent) this.parent.onAnimationFinished(name);
            // A once-clip with a follow-on plays it, unless a machine is choosing.
            if (clip.next && this._clip === clip && (!machine || !this._machineOn)) this._startClip(clip.next);
        }
    }

    /** Switch the set's hitboxes to what `frame` lists: on (and resized) for those it names, off for the rest. */
    private _applyHitboxes(frame: SpriteClip['frames'][number] | undefined): void {
        if (this._hitboxNames.length === 0) { this._hitboxesPending = false; return; }
        const owner = this._ownerBody2D() ?? this.parent;
        if (!owner) { this._hitboxesPending = true; return; }
        this._hitboxesPending = false;
        for (const name of this._hitboxNames) {
            const area = owner.getChildByName(name)[0];
            if (!(area instanceof Area2DNode)) continue;
            const live = frame?.hitboxes?.find(h => h.area === name);
            area.enabled = !!live;
            if (live?.rect) { area.offset = [live.rect[0], live.rect[1]]; area.size = [live.rect[2], live.rect[3]]; }
        }
    }

    /** A frame comes on screen: its pivot, its hitboxes, its events. */
    private _enterFrame(index: number): void {
        const clip = this._clip;
        const frame = clip?.frames[index];
        if (!clip || !frame) return;
        if (frame.pivot) this.sprite.pivot = frame.pivot;
        else if (clip.pivot && index > 0 && clip.frames[index - 1]?.pivot) this.sprite.pivot = clip.pivot;
        this._applyHitboxes(frame);
        for (const event of frame.events ?? []) {
            this.onAnimationEvent(event, clip.name);
            if (this.parent) this.parent.onAnimationEvent(event, clip.name);
        }
    }

    /** Ordered tile indices this sprite cycles through. */
    public get frames(): number[] { return this._frames; }
    public set frames(frames: number[]) {
        this._frames = [...(frames ?? [])];
        this._currentFrame = 0;
        this._accumulator = 0;
    }
    public get frameSource(): SpriteFrameSource { return this._frameSource; }
    public set frameSource(source: SpriteFrameSource) { this._frameSource = source; this.reset(); }
    public get fps(): number { return this._fps; }
    public set fps(v: number) { this._fps = Math.max(0.0001, v); }
    /** See `_tileFps`: 0 follows the tile's own rate. */
    public get tileFps(): number { return this._tileFps; }
    public set tileFps(v: number) { this._tileFps = Math.max(0, Number.isFinite(v) ? v : 0); }
    /**
     * The rate this sprite is playing at right now, whichever source it reads: its own `fps`, or for the
     * `tile` source the override or the tile's authored rate (0 when the tile does not animate).
     */
    public get effectiveFps(): number {
        if (this._frameSource === 'node') return this._fps;
        if (this._tileFps > 0) return this._tileFps;
        return this.sprite.tileset?.metaOf(this.tileIndex)?.animation?.fps ?? 0;
    }
    public get loop(): boolean { return this._loop; }
    public set loop(v: boolean) { this._loop = v; }
    /** See `_randomStart`. Takes effect from the next spawn; setting it does not jump the current frame. */
    public get randomStart(): boolean { return this._randomStart; }
    public set randomStart(v: boolean) { this._randomStart = v === true; }
    /** Position within `frames`. Clamped, and resets the sub-frame accumulator. */
    public get currentFrame(): number { return this._currentFrame; }
    public set currentFrame(v: number) {
        const last = Math.max(0, this._frames.length - 1);
        this._currentFrame = Math.max(0, Math.min(Math.floor(v), last));
        this._accumulator = 0;
    }

    /** Restart from the first frame. */
    public reset(): void {
        this._currentFrame = 0;
        this._accumulator = 0;
        this._elapsed = 0;
    }
}

/** Expand a legacy columns x rows sheet animation into an explicit list of tile indices. */
function migrateLegacyAnimation(json: any, sprite: Sprite): {
    frames: number[]; frameSource: SpriteFrameSource; fps: number; loop: boolean;
} {
    const animation = json?.animation ?? {};
    const fps = animation.fps ?? 12;
    const loop = animation.loop ?? true;

    if (Array.isArray(animation.frames)) {
        return { frames: animation.frames, frameSource: animation.frameSource ?? 'node', fps, loop };
    }

    const columns = Math.max(1, animation.columns ?? 1);
    const rows = Math.max(1, animation.rows ?? 1);
    const textureId = sprite.tileset?.textureId;
    if (textureId) sprite.tileset = legacySheetTileset(textureId, columns, rows);

    const legacy: number[] = Array.isArray(animation.sequence) && animation.sequence.length > 0
        ? animation.sequence
        : (() => {
            const start = Math.max(0, animation.startFrame ?? 0);
            const end = Math.min(columns * rows - 1, animation.endFrame ?? (columns * rows - 1));
            const out: number[] = [];
            for (let i = start; i <= end; i++) out.push(i);
            return out;
        })();

    return { frames: legacy.map(i => remapLegacyFrame(i, columns, rows)), frameSource: 'node', fps, loop };
}
