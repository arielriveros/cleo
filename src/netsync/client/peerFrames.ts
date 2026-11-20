// A predicting peer that runs its simulation frame by frame (docs/design/netsync.md §6.5, phase 9).
//
// The host steps in ticks; a browser draws at whatever rate its display runs. Rather than stepping the peer's
// simulation in host ticks (which would leave its camera, animation and effects moving at 30 Hz on a 144 Hz
// screen), the peer's engine runs its normal frame loop — every frame simulated with that frame's time — and this
// class watches the character's body across frames. Each time the peer's clock passes a whole host tick, the
// character's state AT that tick is taken between the two frames around it, and handed to the predictor with the
// command for that tick. The host replays each command over one tick; the peer spread the same intent over
// whatever frames fell in it — the difference is small, and the predictor corrects what it adds up to.
//
// Per frame, in the engine's order:
//   beforeFrame()      — the host's animation parameters onto followed characters (before they animate)
//   …the engine's frame: input, physics, scripts and controllers, render…
//   afterFrame(dt)     — host ticks crossed: sampled, commanded, compared; then followers placed for the frame

import { vec3 } from 'gl-matrix';
import type { Predictor } from '../sync/predictor';
import type { SyncPeer } from '../sync/syncPeer';
import type { AnimPeer } from '../sync/animSync';
import type { CarryPeer } from '../sync/carry';
import type { WeaponPeer } from '../sync/weapons';

export interface PeerFramesParts {
    predictor: Predictor;
    sync: SyncPeer;
    anim?: AnimPeer | null;
    carry?: CarryPeer | null;
    weapons?: WeaponPeer | null;
    /** Where the carried prop is held this tick, or null (see CarryPeer.update). */
    hold?: (tick: number) => { pos: ArrayLike<number>; rot: ArrayLike<number> } | null;
    /** Most ticks one frame may account for: past it (a stalled tab), the oldest are skipped. Default 8. */
    maxTicksPerFrame?: number;
}

export class PeerFrames {
    /** Ticks handed to the predictor, and ticks skipped after a stall. */
    public ticks = 0;
    public skipped = 0;

    private _lastExact: number | null = null;
    private readonly _p0 = vec3.create();
    private readonly _v0 = vec3.create();
    private readonly _pos = vec3.create();
    private readonly _vel = vec3.create();

    constructor(private readonly _parts: PeerFramesParts) {}

    /** Before the engine's frame. */
    public beforeFrame(): void {
        this._parts.anim?.apply();
    }

    /** After the engine's frame simulated (`dt`: that frame's seconds). */
    public afterFrame(dt: number): void {
        const { predictor, sync } = this._parts;
        const exact = predictor.dueTickExact();
        const body = (predictor.pawn?.parent as any)?.body ?? null;
        if (body && Number.isFinite(exact)) {
            const p1 = body.position.toArray() as number[];
            const v1 = body.velocity.toArray() as number[];
            const last = this._lastExact;
            if (last === null || exact <= last) {
                // The first frame (or the peer's clock stepped back): start from here, nothing to sample yet.
                if (last === null) this._lastExact = exact;
            } else {
                let first = Math.floor(last) + 1;
                const due = Math.floor(exact);
                const most = this._parts.maxTicksPerFrame ?? 8;
                if (due - first + 1 > most) { this.skipped += due - first + 1 - most; first = due - most + 1; }
                for (let t = first; t <= due; t++) {
                    // Where the body was when the clock passed t: between last frame's state and this one's.
                    const f = Math.min(1, Math.max(0, (t - last) / (exact - last)));
                    vec3.lerp(this._pos, this._p0, p1 as unknown as vec3, f);
                    vec3.lerp(this._vel, this._v0, v1 as unknown as vec3, f);
                    predictor.afterTick(t, { pos: this._pos, vel: this._vel });
                    this.ticks++;
                    const c = this._parts.carry;
                    if (c) { const h = this._parts.hold?.(t) ?? null; c.update(t, h?.pos ?? null, h?.rot ?? null, dt); }
                }
                this._lastExact = exact;
            }
            // This frame's state is the next frame's starting point: read again, the predictor may have moved it.
            const now = body.position.toArray() as number[];
            vec3.set(this._p0, now[0], now[1], now[2]);
            vec3.set(this._v0, v1[0], v1[1], v1[2]);
        }
        sync.apply();
        this._parts.weapons?.update();
    }
}
