import { finiteOr } from '../core/math';
import {
    conditionNodeMet, consumeTriggers, forEachCondition, parseConditionNode, updateLatch,
} from '../core/conditions';
import type { ConditionContext, ConditionNode } from '../core/conditions';

// Sprite animation for 2D characters: named CLIPS (idle, run, jump, attack...) made of frames that each
// show one tile of the sprite's tileset, for their own time, and can fire events and switch hitboxes on;
// and an optional STATE MACHINE that picks the clip from what the character is doing (grounded, falling,
// running) and from triggers a script raises (attack, hurt). Pure data and pure steps: the node that plays
// them is AnimatedSpriteNode.

/** A hitbox a frame switches on: an Area2D near the sprite, by name, optionally resized for the frame. */
export interface SpriteFrameHitbox {
    /** The Area2DNode's name, in the character the sprite belongs to. */
    area: string;
    /** Offset and size for this frame, world units, from the character's position (mirrored when it faces left). */
    rect?: [number, number, number, number];
}

export interface SpriteFrame {
    /** The tile it shows. */
    tile: number;
    /** Seconds on screen; absent: one frame of the clip's fps. */
    duration?: number;
    /** Events fired as the frame comes on screen: `onAnimationEvent(name, clip)` on the sprite and its parent. */
    events?: string[];
    /** The hitboxes live on this frame; every hitbox the set names is off on the frames that do not. */
    hitboxes?: SpriteFrameHitbox[];
    /** This frame's pivot, overriding the clip's (a lunge that moves the body off its feet). */
    pivot?: [number, number];
}

/** How a clip ends: loop round, stop on its last frame, or play back and forth. */
export type SpriteClipLoop = 'loop' | 'once' | 'pingpong';

export interface SpriteClip {
    name: string;
    frames: SpriteFrame[];
    fps: number;
    loop: SpriteClipLoop;
    /** Multiplies the clip's rate. */
    speed?: number;
    /** The sprite's pivot while this clip plays (Sprite.pivot), when the clip's frames stand differently. */
    pivot?: [number, number];
    /** A once-clip that ends plays this one next (attack recovery into idle), unless the machine picks. */
    next?: string;
}

/** A state of the sprite machine: a clip to play while in it. */
export interface SpriteMachineState {
    name: string;
    clip: string;
    /** Multiplies the clip's rate in this state. */
    speed?: number;
}

/** A way from one state to another, taken the first frame it holds. */
export interface SpriteMachineTransition {
    /** The state it leaves, or '*' for any state (but never into the state already playing). */
    from: string;
    to: string;
    /** When to take it: an AND/OR tree over the parameters (core/conditions.ts). Absent: always. */
    condition?: ConditionNode;
    /** Only once the clip has played this share of itself (0..1); a once-clip that finished counts as 1. */
    exitTime?: number;
}

export interface SpriteStateMachine {
    entry: string;
    states: SpriteMachineState[];
    transitions: SpriteMachineTransition[];
}

/** A character's sprite animations: its clips, the clip it starts on, and an optional machine to drive them. */
export interface SpriteAnimationSet {
    id: string;
    name: string;
    clips: SpriteClip[];
    defaultClip: string;
    machine?: SpriteStateMachine;
}

/** Where a clip is: frame, time into it, direction (ping-pong), and whether a once-clip has ended. */
export interface ClipPlayhead {
    frame: number;
    /** Seconds into the current frame. */
    time: number;
    direction: 1 | -1;
    finished: boolean;
    /** Seconds since the clip started, for normalized time. */
    elapsed: number;
}

export function createPlayhead(): ClipPlayhead {
    return { frame: 0, time: 0, direction: 1, finished: false, elapsed: 0 };
}

/** One frame's time on screen at the clip's rate. */
export function frameDuration(clip: SpriteClip, frame: number): number {
    const f = clip.frames[frame];
    const own = f?.duration;
    return typeof own === 'number' && own > 0 ? own : 1 / Math.max(0.0001, clip.fps);
}

/** The clip's whole length, seconds, at speed 1 (one pass, ping-pong there and not back). */
export function clipLength(clip: SpriteClip): number {
    let t = 0;
    for (let i = 0; i < clip.frames.length; i++) t += frameDuration(clip, i);
    return t;
}

/**
 * Advance `head` through `clip` by `dt` seconds (already scaled by any speed), pushing into `entered` the
 * index of every frame that comes on screen -- each crossed frame exactly once, however large `dt`. A
 * looping clip wraps; a ping-pong one turns at either end; a once-clip holds its last frame and is
 * `finished`.
 */
export function advanceClip(clip: SpriteClip, head: ClipPlayhead, dt: number, entered: number[]): void {
    const n = clip.frames.length;
    if (n === 0 || !(dt > 0)) return;
    head.elapsed += dt;
    if (head.finished) return;
    head.time += dt;
    // Bounded: a pathological dt (a resumed tab) plays at most a few passes' worth of frame changes.
    for (let guard = 0; guard < n * 4 + 8; guard++) {
        const d = frameDuration(clip, head.frame);
        if (head.time < d) return;
        head.time -= d;
        let next = head.frame + head.direction;
        if (next >= n || next < 0) {
            if (clip.loop === 'loop') next = next >= n ? 0 : n - 1;
            else if (clip.loop === 'pingpong' && n > 1) {
                head.direction = head.direction === 1 ? -1 : 1;
                next = head.frame + head.direction;
            } else {
                head.finished = true;
                head.time = 0;
                return;
            }
        }
        head.frame = next;
        entered.push(next);
    }
    head.time = 0;
}

/** How far through the clip the playhead is, 0..1 (a finished once-clip is 1). */
export function normalizedTime(clip: SpriteClip, head: ClipPlayhead): number {
    if (head.finished) return 1;
    const len = clipLength(clip);
    if (!(len > 0)) return 1;
    if (clip.loop === 'loop') return (head.elapsed % len) / len;
    return Math.min(1, head.elapsed / len);
}

/**
 * The state the machine moves to from `current` this frame, or null to stay: the first transition out of
 * `current`, then the first from any state, whose exit time has passed and whose condition holds. Triggers
 * the taken transition reads are lowered. Every condition's latch advances first (core/conditions.ts).
 */
export function stepSpriteMachine(machine: SpriteStateMachine, current: string, progress: number,
                                  ctx: ConditionContext): string | null {
    for (const t of machine.transitions) forEachCondition(t.condition, undefined, c => updateLatch(ctx, c));
    const pick = (t: SpriteMachineTransition): boolean => {
        if (t.to === current) return false;
        if (typeof t.exitTime === 'number' && progress < t.exitTime) return false;
        return !t.condition || conditionNodeMet(ctx, t.condition);
    };
    for (const pass of [0, 1]) {
        for (const t of machine.transitions) {
            if (pass === 0 ? t.from !== current : t.from !== '*') continue;
            if (!pick(t)) continue;
            if (t.condition) consumeTriggers(ctx, t.condition, undefined);
            return t.to;
        }
    }
    return null;
}

// --- reading --------------------------------------------------------------------------------------------

const pairOr = (v: unknown, fallback: [number, number] | undefined): [number, number] | undefined =>
    Array.isArray(v) && v.length >= 2 ? [finiteOr(v[0], 0.5), finiteOr(v[1], 0.5)] : fallback;

/** A clip out of untrusted JSON, or null without a name. */
export function parseSpriteClip(raw: any): SpriteClip | null {
    const name = typeof raw?.name === 'string' ? raw.name : '';
    if (!name) return null;
    const frames: SpriteFrame[] = [];
    for (const f of Array.isArray(raw.frames) ? raw.frames : []) {
        const tile = typeof f === 'number' ? f : f?.tile;
        if (typeof tile !== 'number' || !Number.isFinite(tile)) continue;
        const frame: SpriteFrame = { tile: Math.max(0, Math.floor(tile)) };
        if (typeof f === 'object') {
            if (typeof f.duration === 'number' && f.duration > 0) frame.duration = f.duration;
            if (Array.isArray(f.events)) frame.events = f.events.filter((e: unknown) => typeof e === 'string' && e);
            if (Array.isArray(f.hitboxes)) frame.hitboxes = f.hitboxes
                .filter((h: any) => typeof h?.area === 'string' && h.area)
                .map((h: any) => ({ area: h.area, ...(Array.isArray(h.rect) && h.rect.length >= 4 ? { rect: [+h.rect[0] || 0, +h.rect[1] || 0, +h.rect[2] || 0, +h.rect[3] || 0] as [number, number, number, number] } : {}) }));
            const pivot = pairOr(f.pivot, undefined);
            if (pivot) frame.pivot = pivot;
        }
        frames.push(frame);
    }
    const loop: SpriteClipLoop = raw.loop === 'once' || raw.loop === 'pingpong' ? raw.loop : raw.loop === false ? 'once' : 'loop';
    const clip: SpriteClip = { name, frames, fps: Math.max(0.0001, finiteOr(raw.fps, 12)), loop };
    if (typeof raw.speed === 'number' && raw.speed > 0 && raw.speed !== 1) clip.speed = raw.speed;
    const pivot = pairOr(raw.pivot, undefined);
    if (pivot) clip.pivot = pivot;
    if (typeof raw.next === 'string' && raw.next) clip.next = raw.next;
    return clip;
}

/** A machine out of untrusted JSON, or undefined without states. */
export function parseSpriteMachine(raw: any): SpriteStateMachine | undefined {
    if (!raw || !Array.isArray(raw.states)) return undefined;
    const states: SpriteMachineState[] = raw.states
        .filter((s: any) => typeof s?.name === 'string' && s.name && typeof s.clip === 'string')
        .map((s: any) => ({ name: s.name, clip: s.clip, ...(typeof s.speed === 'number' && s.speed > 0 && s.speed !== 1 ? { speed: s.speed } : {}) }));
    if (states.length === 0) return undefined;
    const transitions: SpriteMachineTransition[] = [];
    for (const t of Array.isArray(raw.transitions) ? raw.transitions : []) {
        if (typeof t?.from !== 'string' || typeof t?.to !== 'string') continue;
        const out: SpriteMachineTransition = { from: t.from, to: t.to };
        const condition = t.condition ? parseConditionNode(t.condition) : null;
        if (condition) out.condition = condition;
        if (typeof t.exitTime === 'number' && Number.isFinite(t.exitTime)) out.exitTime = Math.min(1, Math.max(0, t.exitTime));
        transitions.push(out);
    }
    const entry = typeof raw.entry === 'string' && states.some(s => s.name === raw.entry) ? raw.entry : states[0].name;
    return { entry, states, transitions };
}

/** A whole set out of untrusted JSON, or null with no clips. */
export function parseSpriteAnimationSet(raw: any): SpriteAnimationSet | null {
    if (!raw || !Array.isArray(raw.clips)) return null;
    const clips = raw.clips.map(parseSpriteClip).filter((c: SpriteClip | null): c is SpriteClip => !!c);
    if (clips.length === 0) return null;
    const defaultClip = typeof raw.defaultClip === 'string' && clips.some((c: SpriteClip) => c.name === raw.defaultClip)
        ? raw.defaultClip : clips[0].name;
    const set: SpriteAnimationSet = {
        id: typeof raw.id === 'string' ? raw.id : '', name: typeof raw.name === 'string' ? raw.name : '', clips, defaultClip,
    };
    const machine = parseSpriteMachine(raw.machine);
    if (machine) set.machine = machine;
    return set;
}

/** A detached copy of a set, for embedding. */
export function cloneSpriteAnimationSet(set: SpriteAnimationSet): SpriteAnimationSet {
    return JSON.parse(JSON.stringify(set));
}
