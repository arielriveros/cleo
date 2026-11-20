// Animation over the network (docs/design/netsync.md §6.7): peers run their own Animators; the host sends what
// DRIVES them, never the pose.
//
//   params   pulse lane, every tick: the parameters of each followed character's animators that changed by more
//            than a hair since last sent (all of them every `refreshTicks`, to cover loss), stamped with the tick.
//            A peer pins them on its copy (`setParamOverride`, which wins over the parameter's own link), so its
//            state machine walks the same states the host's does — the locomotion blend reads the host's speed,
//            and feet do not slide.
//   events   control lane: a trigger set (`setTrigger`), an action played (`playAction`), and the base layer's
//            state when it changes, stamped with the tick. A peer applies each when it DRAWS that tick (the
//            character is drawn `delayTicks` in the past), so a shot's recoil lines up with where the shooter
//            stood; an action that arrives late starts part-way in. A state that drifts from the host's for more
//            than `driftTicks` is forced (`Animator.forceState`).
//
// Animators are addressed by their character's NetId and their order among the animated models under it (the
// same template on both sides, so the same order). A peer's own character is left alone: it animates from its
// own predicted motion.

import { ByteReader, ByteWriter } from '../bytes';
import { FIRST_APP_TYPE } from '../session/messages';
import type { Animator } from '../../animation/animator';
import type { Node } from '../../core/scene/nodes/node';
import type { HostPeer, HostSession } from '../session/hostSession';
import type { PeerSession } from '../session/peerSession';
import type { SyncHost } from './syncHost';
import type { SyncPeer } from './syncPeer';

/** Pulse lane. */
export const ANIM_PARAMS = FIRST_APP_TYPE + 5;
/** Control lane. */
export const ANIM_EVENT = FIRST_APP_TYPE + 15;

const EVENT_TRIGGER = 1;
const EVENT_ACTION = 2;
const EVENT_STATE = 3;

/** Every animated model under `character`, depth first: how both sides number its animators. */
export function animatorsOf(character: Node): Animator[] {
    const out: Animator[] = [];
    const walk = (n: Node) => {
        const a = (n as any).animator as Animator | null | undefined;
        if (a && a.getStateMachine()) out.push(a);
        for (const c of n.children) walk(c);
    };
    walk(character);
    return out;
}

// ----- host -----------------------------------------------------------------------------------------------------

export interface AnimHostOptions {
    /** A full set of every animator's parameters this often, ticks (covers lost pulses). Default 30. */
    refreshTicks?: number;
    /** Smallest change of a number parameter worth sending. Default 0.01. */
    epsilon?: number;
}

interface Tracked {
    character: Node;
    index: number;
    animator: Animator;
    sent: Map<string, number | boolean>;
    state: string | null;
    events: { kind: number; name: string; extra: string }[];
    unhook: () => void;
}

export interface AnimHostStats { paramBytes: number; events: number; }

export class AnimHost {
    public readonly stats: AnimHostStats = { paramBytes: 0, events: 0 };
    private readonly _tracked = new Map<Animator, Tracked>();
    private readonly _refresh: number;
    private readonly _epsilon: number;

    constructor(private readonly _session: HostSession, private readonly _sync: SyncHost, options: AnimHostOptions = {}) {
        this._refresh = options.refreshTicks ?? 30;
        this._epsilon = options.epsilon ?? 0.01;
    }

    /** After every tick (after SyncHost.tick, so new characters have their NetId on the peers). */
    public tick(tick: number): void {
        this._discover();
        const full = tick % this._refresh === 0;
        const w = new ByteWriter(256).u8(ANIM_PARAMS).u32(tick);
        const countAt = w.length;
        w.u16(0);
        let animators = 0;
        const events: Uint8Array[] = [];
        for (const t of this._tracked.values()) {
            const netId = this._sync.netIdOf(t.character);
            if (netId === undefined || !t.character.scene) continue;
            // Triggers and actions first, then the state the tick ended in.
            for (const e of t.events) events.push(this._event(netId, t.index, tick, e.kind, e.name, e.extra));
            t.events.length = 0;
            const state = t.animator.currentStateName;
            if (state !== t.state) {
                t.state = state;
                if (state) events.push(this._event(netId, t.index, tick, EVENT_STATE, state, ''));
            }
            const params = t.animator.getStateMachine()?.parameters ?? [];
            const changed: [number, number | boolean][] = [];
            params.forEach((p, i) => {
                if (p.type === 'trigger') return;
                const v = t.animator.getParam(p.name);
                if (v === undefined) return;
                const was = t.sent.get(p.name);
                const differs = typeof v === 'number' ? typeof was !== 'number' || Math.abs(v - was) > this._epsilon : v !== was;
                if (full || differs) { changed.push([i, v]); t.sent.set(p.name, v); }
            });
            if (!changed.length) continue;
            animators++;
            w.varUint(netId).u8(t.index).u8(changed.length);
            for (const [i, v] of changed) {
                if (typeof v === 'boolean') w.u8(i).u8(v ? 2 : 1);
                else w.u8(i).u8(0).raw(new Uint8Array(new Float32Array([v]).buffer));
            }
        }
        const peers = [...this._session.peers.values()].filter((p) => p.connected);
        for (const m of events) for (const p of peers) p.sendControl(m);
        this.stats.events += events.length;
        if (!animators) return;
        const bytes = w.finish();
        new DataView(bytes.buffer).setUint16(countAt, animators);
        this.stats.paramBytes += bytes.length;
        // Over a datagram's room it goes on the control lane instead (rare: dozens of characters changing at once).
        for (const p of peers) if (bytes.length > (p.link?.pulseBudget ?? 1000) || !p.sendPulse(bytes)) p.sendControl(bytes);
    }

    public dispose(): void {
        for (const t of this._tracked.values()) t.unhook();
        this._tracked.clear();
    }

    private _event(netId: number, index: number, tick: number, kind: number, name: string, extra: string): Uint8Array {
        return new ByteWriter(48).u8(ANIM_EVENT).varUint(netId).u8(index).u32(tick).u8(kind).string(name).string(extra).finish();
    }

    /** Start tracking the animators of synced characters that appeared; forget those that went. */
    private _discover(): void {
        const live = new Set<Animator>();
        for (const node of this._sync.synced.values()) {
            if (node.nodeType !== 'character') continue;
            animatorsOf(node).forEach((animator, index) => {
                live.add(animator);
                if (!this._tracked.has(animator)) this._tracked.set(animator, this._track(node, index, animator));
            });
        }
        for (const [a, t] of this._tracked) if (!live.has(a)) { t.unhook(); this._tracked.delete(a); }
    }

    /** Watch an animator's triggers and actions (wrapped on this instance only). */
    private _track(character: Node, index: number, animator: Animator): Tracked {
        const t: Tracked = { character, index, animator, sent: new Map(), state: null, events: [], unhook: () => {} };
        const setTrigger = animator.setTrigger;
        const playAction = animator.playAction;
        (animator as any).setTrigger = function (name: string) {
            t.events.push({ kind: EVENT_TRIGGER, name, extra: '' });
            return setTrigger.call(this, name as any);
        };
        (animator as any).playAction = function (clip: string, options: any = {}) {
            t.events.push({ kind: EVENT_ACTION, name: clip, extra: JSON.stringify(options ?? {}) });
            return playAction.call(this, clip, options);
        };
        t.unhook = () => { delete (animator as any).setTrigger; delete (animator as any).playAction; };
        return t;
    }
}

// ----- peer -----------------------------------------------------------------------------------------------------

export interface AnimPeerOptions {
    /** Ticks a followed animator's state may differ from the host's before it is forced. Default 15. */
    driftTicks?: number;
}

interface Followed {
    params: { tick: number; values: [number, number | boolean][] }[];
    /** Every parameter's value as of `currentTick` (the newest sample applied). */
    current: Map<number, number | boolean>;
    currentTick: number;
    events: { tick: number; kind: number; name: string; extra: string }[];
    hostState: string | null;
    drift: number;
}

export interface AnimPeerStats { forced: number; actions: number; triggers: number; }

export class AnimPeer {
    public readonly stats: AnimPeerStats = { forced: 0, actions: 0, triggers: 0 };
    private readonly _followed = new Map<string, Followed>();
    private readonly _drift: number;

    constructor(private readonly _session: PeerSession, private readonly _sync: SyncPeer, options: AnimPeerOptions = {}) {
        this._drift = options.driftTicks ?? 15;
        _session.route('pulse', ANIM_PARAMS, (m) => this._onParams(m));
        _session.route('control', [ANIM_EVENT, ANIM_PARAMS], (m) => (m[0] === ANIM_EVENT ? this._onEvent(m) : this._onParams(m)));
    }

    /**
     * Each frame, before the scene updates its animators: pin the parameters the host had at the tick being drawn,
     * and fire the triggers and actions due by then.
     */
    public apply(): void {
        const at = this._sync.renderTick();
        for (const [key, f] of this._followed) {
            const animator = this._animator(key);
            if (!animator) continue;
            // Every sample up to the tick being drawn, in order: the parameters as of then.
            let i = -1;
            for (let k = 0; k < f.params.length && f.params[k].tick <= at; k++) i = k;
            for (let k = 0; k <= i; k++) {
                for (const [index, value] of f.params[k].values) f.current.set(index, value);
                f.currentTick = f.params[k].tick;
            }
            if (i >= 0) f.params.splice(0, i + 1);
            // Between two samples, numbers are interpolated — as positions are, so the animation's speed matches the
            // motion drawn — and booleans hold until the next sample.
            // Samples are sparse — only changes are sent — so a gap means "unchanged": the next sample's change
            // happened during the tick before it, and is blended over that tick only.
            const next = f.params[0];
            const t = next ? Math.max(0, Math.min(1, at - (next.tick - 1))) : 0;
            const names = animator.getStateMachine()?.parameters ?? [];
            for (const [index, value] of f.current) {
                const p = names[index];
                if (!p) continue;
                let v = value;
                if (typeof value === 'number' && next && t > 0) {
                    const ahead = next.values.find(([n]) => n === index)?.[1];
                    if (typeof ahead === 'number') v = value + (ahead - value) * t;
                }
                animator.setParamOverride(p.name, v);
            }
            while (f.events.length && f.events[0].tick <= at) {
                const e = f.events.shift()!;
                if (e.kind === EVENT_TRIGGER) { animator.setTrigger(e.name as any); this.stats.triggers++; }
                else if (e.kind === EVENT_ACTION) {
                    let options: any = {};
                    try { options = JSON.parse(e.extra || '{}'); } catch { /* defaults */ }
                    const handle = animator.playAction(e.name, options);
                    // Late (the event came after its tick was drawn): start it as far in as the host is.
                    const late = (at - e.tick) / this._session.tickRate;
                    if (late > 0.05) handle.seek(late);
                    this.stats.actions++;
                } else if (e.kind === EVENT_STATE) {
                    f.hostState = e.name;
                }
            }
            if (f.hostState && animator.currentStateName !== f.hostState) {
                if (++f.drift > this._drift) { animator.forceState(f.hostState); f.drift = 0; this.stats.forced++; }
            } else f.drift = 0;
        }
    }

    public dispose(): void {
        this._session.route('pulse', ANIM_PARAMS, null);
        this._session.route('control', [ANIM_EVENT, ANIM_PARAMS], null);
    }

    private _key(netId: number, index: number): string { return `${netId}:${index}`; }

    private _animator(key: string): Animator | null {
        const [netId, index] = key.split(':').map(Number);
        const character = this._sync.nodeOf(netId);
        if (!character || this._sync.owns(character.id) || this._ownsCharacter(character)) return null;
        return animatorsOf(character)[index] ?? null;
    }

    /** A peer's own character is the one whose Collider (its parent) it predicts. */
    private _ownsCharacter(character: Node): boolean {
        return !!character.parent && this._sync.owns(character.parent.id);
    }

    private _get(key: string): Followed {
        let f = this._followed.get(key);
        if (!f) { f = { params: [], current: new Map(), currentTick: -1, events: [], hostState: null, drift: 0 }; this._followed.set(key, f); }
        return f;
    }

    private _onParams(m: Uint8Array): void {
        const r = new ByteReader(m, 1);
        try {
            const tick = r.u32();
            for (let n = r.u16(); n > 0; n--) {
                const netId = r.varUint(), index = r.u8();
                const values: [number, number | boolean][] = [];
                for (let c = r.u8(); c > 0; c--) {
                    const i = r.u8(), kind = r.u8();
                    if (kind === 0) values.push([i, new Float32Array(r.raw(4).slice().buffer)[0]]);
                    else values.push([i, kind === 2]);
                }
                const f = this._get(this._key(netId, index));
                // Kept in tick order; a late duplicate of an older tick is merged where it belongs.
                let at = f.params.length;
                while (at > 0 && f.params[at - 1].tick > tick) at--;
                f.params.splice(at, 0, { tick, values });
                if (f.params.length > 64) f.params.shift();
            }
        } catch { /* a truncated datagram: keep what was read */ }
    }

    private _onEvent(m: Uint8Array): void {
        const r = new ByteReader(m, 1);
        const netId = r.varUint(), index = r.u8(), tick = r.u32(), kind = r.u8(), name = r.string(), extra = r.string();
        const f = this._get(this._key(netId, index));
        f.events.push({ tick, kind, name, extra });
    }
}
