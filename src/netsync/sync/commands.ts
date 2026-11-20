// Remote control (docs/design/netsync.md §6.5): a peer's player drives its own character on the host.
//
// The peer sends a COMMAND per host tick — its controller's intent (move, aim, sprint, crouch, the requests it
// raised: jump, interact, primary, secondary), stamped with the host tick it is meant for. Each datagram carries
// the newest command and the three before it, so a lost datagram loses nothing. The host keeps a small queue per
// peer and, before each tick, hands the controller that peer possesses (`controlSource: 'remote'`) the command
// for that tick. A request is applied once, whenever its command arrives; a tick with no command repeats the last
// one's movement for a moment (`holdTicks`), then the character stops.
//
// Possession is the game's decision: the host asks `possess(peer)` for a controller when a peer joins (spawn a
// player template, or take a seat in the scene) and tells the peer which character is theirs.

import { ByteReader, ByteWriter } from '../bytes';
import { FIRST_APP_TYPE } from '../session/messages';
import { INTENT_REQUESTS, clearIntent, createIntent, type ControlIntent } from '../../core/control/intent';
import type { ControllerNode } from '../../core/scene/nodes/controllerNode';
import type { Node } from '../../core/scene/nodes/node';
import type { HostPeer, HostSession } from '../session/hostSession';
import type { PeerSession } from '../session/peerSession';

/** Pulse lane, peer → host. */
export const COMMAND_TYPE = FIRST_APP_TYPE + 2;
/** Control lane, host → peer: which controller and character are this peer's. */
export const POSSESS_TYPE = FIRST_APP_TYPE + 3;
/** Commands per datagram: the newest and the three before it. */
export const COMMANDS_PER_DATAGRAM = 4;

export interface Command {
    /** The host tick this command is for. */
    tick: number;
    intent: ControlIntent;
}

// ----- wire format ----------------------------------------------------------------------------------------------

const MOVE_SCALE = 32767;
const ANGLE_SCALE = 100; // 1/100 degree
const wrapDegrees = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const i16 = (v: number) => (v << 16) >> 16;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function writeCommand(w: ByteWriter, c: Command): void {
    const it = c.intent;
    w.u32(c.tick);
    w.u16(Math.round(clamp(it.move[0], -1, 1) * MOVE_SCALE) & 0xffff).u16(Math.round(clamp(it.move[1], -1, 1) * MOVE_SCALE) & 0xffff);
    w.u16(Math.round(wrapDegrees(it.basisYaw) * ANGLE_SCALE) & 0xffff);
    w.u16(Math.round(wrapDegrees(it.aimYaw) * ANGLE_SCALE) & 0xffff);
    w.u16(Math.round(clamp(it.aimPitch, -90, 90) * ANGLE_SCALE) & 0xffff);
    w.u8((it.sprint ? 1 : 0) | (it.crouch ? 2 : 0));
    w.u8(Math.round(clamp(it.speedScale, 0, 1) * 255));
    // Each request's remaining buffer, in 1/100 s (0 = not raised).
    for (const kind of INTENT_REQUESTS) w.u8(Math.round(clamp(it.requests[kind], 0, 2.55) * 100));
}

function readCommand(r: ByteReader): Command {
    const intent = createIntent();
    const tick = r.u32();
    intent.move[0] = i16(r.u16()) / MOVE_SCALE;
    intent.move[1] = i16(r.u16()) / MOVE_SCALE;
    intent.basisYaw = i16(r.u16()) / ANGLE_SCALE;
    intent.aimYaw = i16(r.u16()) / ANGLE_SCALE;
    intent.aimPitch = i16(r.u16()) / ANGLE_SCALE;
    const flags = r.u8();
    intent.sprint = (flags & 1) !== 0;
    intent.crouch = (flags & 2) !== 0;
    intent.speedScale = r.u8() / 255;
    for (const kind of INTENT_REQUESTS) intent.requests[kind] = r.u8() / 100;
    return { tick, intent };
}

export function encodeCommands(commands: readonly Command[]): Uint8Array {
    const w = new ByteWriter(2 + commands.length * 21).u8(COMMAND_TYPE).u8(commands.length);
    for (const c of commands) writeCommand(w, c);
    return w.finish();
}

export function decodeCommands(m: Uint8Array): Command[] {
    const r = new ByteReader(m, 1);
    const out: Command[] = [];
    for (let n = r.u8(); n > 0; n--) out.push(readCommand(r));
    return out;
}

function encodePossess(controllerId: string, pawnId: string): Uint8Array {
    return new ByteWriter(80).u8(POSSESS_TYPE).string(controllerId).string(pawnId).finish();
}

// ----- host --------------------------------------------------------------------------------------------------------

/** One peer's commands, waiting for their tick. */
export class CommandQueue {
    private readonly _pending = new Map<number, ControlIntent>();
    private _last: Command | null = null;
    private _consumedUpTo = -1;
    /** Ticks whose command has arrived (recent ones), so a redundant copy is not applied twice. */
    private readonly _seen = new Set<number>();
    /** Requests from commands that arrived after their tick was already played: applied on the next tick. */
    private readonly _late = createIntent().requests;
    private readonly _out = createIntent();

    constructor(public readonly holdTicks: number = 6) {}

    /** Commands waiting for a later tick (the peer is ahead, as it should be by about half a round trip). */
    public get pending(): number { return this._pending.size; }

    public add(c: Command): void {
        if (this._seen.has(c.tick) || c.tick < this._consumedUpTo - 64) return; // a copy, or too old to matter
        this._seen.add(c.tick);
        if (this._seen.size > 256) for (const t of this._seen) if (t < this._consumedUpTo - 64) this._seen.delete(t);
        if (c.tick <= this._consumedUpTo) {
            // Its tick has been played without it (its datagram was lost; a later one carried it): the movement
            // is history, but a jump it asked for still happens.
            for (const kind of INTENT_REQUESTS) this._late[kind] = Math.max(this._late[kind], c.intent.requests[kind]);
            return;
        }
        this._pending.set(c.tick, c.intent);
        if (this._pending.size > 128) this._pending.delete(Math.min(...this._pending.keys()));
    }

    /**
     * The intent for host tick `tick`, or null for an idle pawn. Every command up to this tick not applied yet is
     * consumed now: the newest gives movement and aim; each one's requests are raised (a jump is never dropped
     * because its command came late).
     */
    public take(tick: number): ControlIntent | null {
        const due = [...this._pending.keys()].filter((t) => t <= tick).sort((a, b) => a - b);
        const late = INTENT_REQUESTS.some((kind) => this._late[kind] > 0);
        let out: ControlIntent;
        if (!due.length) {
            if ((!this._last || tick - this._last.tick > this.holdTicks) && !late) return null;
            // Nothing new: keep moving as last asked, for a moment (requests were applied when they came).
            out = this._last && tick - this._last.tick <= this.holdTicks ? this._copyContinuous(this._last.intent) : this._copyContinuous(createIntent());
            this._takeLate(out);
            return out;
        }
        const newest = this._pending.get(due[due.length - 1])!;
        out = this._copyContinuous(newest);
        this._takeLate(out);
        for (const t of due) {
            const c = this._pending.get(t)!;
            for (const kind of INTENT_REQUESTS) out.requests[kind] = Math.max(out.requests[kind], c.requests[kind]);
            this._pending.delete(t);
        }
        this._consumedUpTo = due[due.length - 1];
        if (!this._last || this._consumedUpTo > this._last.tick) this._last = { tick: this._consumedUpTo, intent: newest };
        return out;
    }

    private _takeLate(out: ControlIntent): void {
        for (const kind of INTENT_REQUESTS) {
            out.requests[kind] = Math.max(out.requests[kind], this._late[kind]);
            this._late[kind] = 0;
        }
    }

    private _copyContinuous(from: ControlIntent): ControlIntent {
        const out = clearIntent(this._out);
        // clearIntent keeps pending requests (on a pawn, a buffered jump must survive); here each tick's
        // requests are exactly what its commands raised.
        for (const kind of INTENT_REQUESTS) out.requests[kind] = 0;
        out.move[0] = from.move[0];
        out.move[1] = from.move[1];
        out.basisYaw = from.basisYaw;
        out.aimYaw = from.aimYaw;
        out.aimPitch = from.aimPitch;
        out.sprint = from.sprint;
        out.crouch = from.crouch;
        out.speedScale = from.speedScale;
        return out;
    }
}

export interface RemoteControlOptions {
    /**
     * The controller a newly joined peer drives, or null for none (a spectator). Usually: instantiate the player
     * template and return the Controller in it. Its `controlSource` is set to 'remote'.
     */
    possess: (peer: HostPeer) => ControllerNode | null;
    /** A peer left for good: let its character go. Default: the controller stops driving (`controlSource: 'none'`). */
    release?: (peer: HostPeer, controller: ControllerNode) => void;
    /** Ticks the last command keeps a character moving when the next is late. Default 6 (200 ms at 30 Hz). */
    holdTicks?: number;
}

/** The host's side: possession, command queues, and each tick's intents. */
export class RemoteControl {
    private readonly _seats = new Map<number, { controller: ControllerNode; queue: CommandQueue }>();

    constructor(private readonly _session: HostSession, private readonly _options: RemoteControlOptions) {
        _session.route('pulse', COMMAND_TYPE, this._onCommand);
        _session.on('join', this._onJoin);
        _session.on('resume', this._onResume);
        _session.on('drop', this._onDrop);
        _session.on('leave', this._onLeave);
    }

    /**
     * The peer that owns `node`: the one whose controller sits in the same top-level tree (a spawned player
     * template: its Collider, Character, Controller, camera and weapons), or 0 for the host. For `this.net.owner`.
     */
    public ownerOf(node: Node): number {
        // The ancestor directly under the scene's root (the scene's root itself sits under nothing).
        const top = (n: Node): Node => { const root = n.scene?.root; while (n.parent && n.parent !== root) n = n.parent; return n; };
        const mine = top(node);
        for (const [peerId, seat] of this._seats) if (seat.controller.scene && top(seat.controller) === mine) return peerId;
        return 0;
    }

    /** The controller peer `peerId` drives, if any. */
    public controllerOf(peerId: number): ControllerNode | null { return this._seats.get(peerId)?.controller ?? null; }
    public queueOf(peerId: number): CommandQueue | null { return this._seats.get(peerId)?.queue ?? null; }

    /** Hand every possessed controller its intent for `tick`. Call before the host steps that tick. */
    public beforeTick(tick: number): void {
        for (const [peerId, seat] of this._seats) {
            const peer = this._session.peers.get(peerId);
            seat.controller.remoteIntent = peer?.connected ? seat.queue.take(tick) : null;
        }
    }

    public dispose(): void {
        this._session.route('pulse', COMMAND_TYPE, null);
        this._session.off('join', this._onJoin);
        this._session.off('resume', this._onResume);
        this._session.off('drop', this._onDrop);
        this._session.off('leave', this._onLeave);
    }

    private readonly _onCommand = (peer: HostPeer, m: Uint8Array): void => {
        const seat = this._seats.get(peer.id);
        if (!seat) return;
        try { for (const c of decodeCommands(m)) seat.queue.add(c); } catch { /* a malformed datagram is dropped */ }
    };

    private readonly _onJoin = (peer: HostPeer): void => {
        const controller = this._options.possess(peer);
        if (!controller) return;
        controller.controlSource = 'remote';
        controller.remoteIntent = null;
        this._seats.set(peer.id, { controller, queue: new CommandQueue(this._options.holdTicks) });
        this._tellPeer(peer, controller);
    };

    private readonly _onResume = (peer: HostPeer): void => {
        const seat = this._seats.get(peer.id);
        if (!seat) return;
        // Its commands start over from its new link's clock.
        seat.queue = new CommandQueue(this._options.holdTicks);
        this._tellPeer(peer, seat.controller);
    };

    private readonly _onDrop = (e: { peer: HostPeer }): void => {
        const seat = this._seats.get(e.peer.id);
        if (seat) seat.controller.remoteIntent = null;
    };

    private readonly _onLeave = (e: { peer: HostPeer }): void => {
        const seat = this._seats.get(e.peer.id);
        if (!seat) return;
        this._seats.delete(e.peer.id);
        seat.controller.remoteIntent = null;
        if (this._options.release) this._options.release(e.peer, seat.controller);
        else seat.controller.controlSource = 'none';
    };

    private _tellPeer(peer: HostPeer, controller: ControllerNode): void {
        peer.sendControl(encodePossess(controller.id, controller.possessedId ?? ''));
    }
}

// ----- peer --------------------------------------------------------------------------------------------------------

/** The peer's side: which character is its own, and the commands that drive it. */
export class PeerCommands {
    /** The host's id for the controller this peer drives, and for its character — '' until the host says. */
    public controllerId = '';
    public pawnId = '';
    /** Called when the host assigns (or re-assigns, after a resume) this peer's character. */
    public onPossess: ((controllerId: string, pawnId: string) => void) | null = null;
    public sent = 0;

    private readonly _history: Command[] = [];
    private _lastTick = -1;
    /** Requests raised since the last command went out, so a press between two sends is not lost. */
    private readonly _requests = createIntent().requests;

    constructor(private readonly _session: PeerSession, private readonly _leadTicks: number = 1) {
        _session.route('control', POSSESS_TYPE, (m) => {
            const r = new ByteReader(m, 1);
            this.controllerId = r.string();
            this.pawnId = r.string();
            this.onPossess?.(this.controllerId, this.pawnId);
        });
    }

    /**
     * The host tick a command sent now should be for: the tick that will be due on the host when it arrives (half
     * a round trip from now), plus `leadTicks` of margin for jitter.
     */
    public targetTick(): number {
        const tickMs = 1000 / this._session.tickRate;
        return Math.floor((this._session.hostTimeNow() + this._session.clock.rttMs / 2) / tickMs) + this._leadTicks;
    }

    /**
     * Give this frame's intent (a local controller's `publishedIntent`). Call every frame; a command goes out once
     * per host tick, with the newest intent and every request raised since the last one.
     */
    public update(intent: Readonly<ControlIntent>): void {
        for (const kind of INTENT_REQUESTS) this._requests[kind] = Math.max(this._requests[kind], intent.requests[kind]);
        const tick = this.targetTick();
        if (tick <= this._lastTick) return;
        this.send(tick, intent);
    }

    /**
     * Send the command for host tick `tick` (a predicting peer, which steps its own ticks, says which). Ticks
     * must increase; requests raised through {@link update} since the last send ride along.
     */
    public send(tick: number, intent: Readonly<ControlIntent>): void {
        if (tick <= this._lastTick) return;
        for (const kind of INTENT_REQUESTS) this._requests[kind] = Math.max(this._requests[kind], intent.requests[kind]);
        this._lastTick = tick;
        const copy = createIntent();
        copy.move[0] = intent.move[0];
        copy.move[1] = intent.move[1];
        copy.basisYaw = intent.basisYaw;
        copy.aimYaw = intent.aimYaw;
        copy.aimPitch = intent.aimPitch;
        copy.sprint = intent.sprint;
        copy.crouch = intent.crouch;
        copy.speedScale = intent.speedScale;
        for (const kind of INTENT_REQUESTS) { copy.requests[kind] = this._requests[kind]; this._requests[kind] = 0; }
        this._history.push({ tick, intent: copy });
        if (this._history.length > COMMANDS_PER_DATAGRAM) this._history.shift();
        if (this._session.sendPulse(encodeCommands([...this._history].reverse()))) this.sent++;
    }

    public dispose(): void { this._session.route('control', POSSESS_TYPE, null); }
}
