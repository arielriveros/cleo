import type { BodyHandle } from './pal/types';
import type { PhysicsWorld } from './pal/world';

// A character stands on a slope without sliding down it.
//
// A character is a frictionless dynamic body (it owns its own speed), and every substep the backend integrates the
// world's whole gravity into it. On a slope the solver takes back only the part pushing into the ground, so the
// part ALONG the ground is left over: a standing character creeps downhill (about 0.1 m/s on a 30 degree ramp),
// brakes going down at `a - g sin(slope)` and climbs at `a - g sin(slope)`, which stalls a slow one. Friction cannot
// be the answer: it is the character's own speed it would fight.
//
// So a character that asks to be held (PhysicsSystem.holdOnSlope, every frame it stands on walkable ground) is
// given, for each substep, a force that cancels the share of gravity lying along its ground:
//
//     F = -m (g - (g . n) n)
//
// A force, not a velocity change made before the step: the backend integrates it exactly as it integrates gravity
// (Rapier in internal steps of its own, where a velocity change made up front leaves the body creeping uphill).
// Gravity then only presses it into the ground: standing still it stays put, and it starts, brakes and climbs on
// the slope as it does on the flat. The ground is the most upward of the body's own contacts in the last substep
// that is no steeper than its limit (never the frame's ground stamp, which outlives the contact by a grace window
// and so would hold a character running off a crest). Cannon drops a resting contact for the odd substep, so a
// ground is kept for two substeps without one.
//
// CharacterContactRule reads what a step added past gravity; for a held body it asks `gravityOf` for the gravity
// the step really applied (gravity's push into the ground alone). On the main thread (InlineExecutor) and in the
// physics worker (WorkerCore), through the same world accessors.

/** One held body as the next step should treat it: its handle, its mass and the steepest ground it stands on (cos). */
export interface SlopeHoldRequest {
    handle: BodyHandle;
    mass: number;
    cosLimit: number;
}

interface Held {
    handle: BodyHandle;
    mass: number;
    cosLimit: number;
    /** The ground normal (up out of the ground), when there is one. */
    readonly n: Float64Array;
    has: boolean;
    /** Substeps since a contact last gave a ground. */
    misses: number;
    /** Held this substep: the gravity the step applies to it (gravity's push into the ground alone). */
    applied: boolean;
    readonly gravity: Float64Array;
}

/** Substeps a ground is kept with no contact to renew it. */
const KEEP_SUBSTEPS = 2;

export class SlopeHold {
    private _held: Held[] = [];
    private readonly _byHandle = new Map<BodyHandle, Held>();
    private readonly _force = new Float64Array(3);

    /** The bodies held over the coming substeps (cheap when unchanged: a body keeps its ground across frames). */
    public hold(requests: readonly SlopeHoldRequest[]): void {
        const next: Held[] = [];
        for (const { handle, mass, cosLimit } of requests) {
            let h = this._byHandle.get(handle);
            if (!h) h = { handle, mass, cosLimit, n: new Float64Array(3), has: false, misses: 0, applied: false, gravity: new Float64Array(3) };
            h.mass = mass;
            h.cosLimit = cosLimit;
            h.applied = false;
            next.push(h);
        }
        this._byHandle.clear();
        for (const h of next) this._byHandle.set(h.handle, h);
        this._held = next;
    }

    /** Whether any body is held. */
    public get active(): boolean { return this._held.length > 0; }

    /** Before one substep: a force on each held body against gravity's pull along its ground. */
    public before(world: PhysicsWorld): void {
        if (this._held.length === 0) return;
        const g = world.gravity, f = this._force;
        for (const b of this._held) {
            b.applied = false;
            // A sleeping body is not stepped, and a force would wake it.
            if (!b.has || !(b.mass > 0) || !world.hasBody(b.handle) || world.isSleeping(b.handle)) continue;
            const n = b.n;
            const gn = g[0] * n[0] + g[1] * n[1] + g[2] * n[2];
            const tx = g[0] - gn * n[0], ty = g[1] - gn * n[1], tz = g[2] - gn * n[2];
            if (tx * tx + ty * ty + tz * tz < 1e-12) continue;
            f[0] = -tx * b.mass; f[1] = -ty * b.mass; f[2] = -tz * b.mass;
            world.applyForce(b.handle, f);
            b.applied = true;
            b.gravity[0] = gn * n[0]; b.gravity[1] = gn * n[1]; b.gravity[2] = gn * n[2];
        }
    }

    /**
     * The gravity the last substep applied to `body`, when the hold changed it (gravity's push into its ground
     * alone); undefined for a body it left alone, which felt the world's.
     */
    public gravityOf(body: BodyHandle): ArrayLike<number> | undefined {
        const b = this._byHandle.get(body);
        return b?.applied ? b.gravity : undefined;
    }

    /**
     * After one substep: each held body's ground, from its own contacts. `solid` says whether a body it touches can
     * be stood on (a trigger cannot); without it every contact counts.
     */
    public after(world: PhysicsWorld, solid?: (other: BodyHandle) => boolean): void {
        if (this._held.length === 0) return;
        const g = world.gravity;
        const gl = Math.hypot(g[0], g[1], g[2]);
        if (!(gl > 0)) { for (const b of this._held) b.has = false; return; }
        const ux = -g[0] / gl, uy = -g[1] / gl, uz = -g[2] / gl;
        for (const b of this._held) {
            if (!world.hasBody(b.handle)) { b.has = false; continue; }
            let best = -Infinity, bx = 0, by = 0, bz = 0;
            world.forEachContactOf(b.handle, (other, nx, ny, nz) => {
                if (solid && !solid(other)) return;
                // The normal points out of the body toward the other one: the ground's normal is its negative.
                const len = Math.hypot(nx, ny, nz);
                if (!(len > 0)) return;
                const gx = -nx / len, gy = -ny / len, gz = -nz / len;
                const up = gx * ux + gy * uy + gz * uz;
                if (up >= b.cosLimit && up > best) { best = up; bx = gx; by = gy; bz = gz; }
            });
            if (best > -Infinity) {
                b.n[0] = bx; b.n[1] = by; b.n[2] = bz;
                b.has = true;
                b.misses = 0;
            } else if (b.has && ++b.misses > KEEP_SUBSTEPS) b.has = false;
        }
    }
}
