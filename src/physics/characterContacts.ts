import type { BodyHandle } from './pal/types';
import type { PhysicsWorld } from './pal/world';

// A character is not pushed about by things lighter than it.
//
// A character is an ordinary dynamic body (its Collider's), and every backend splits a contact's impulse by the
// two masses correctly. The trouble is what a light body is backed by. A crate tipping about its bottom edge is a
// lever pinned to the ground, and the ground's mass is infinite: its rising corner carries a 75 kg character up
// as if it weighed as much as the floor, and the solver's penetration recovery (Jolt's position iterations,
// Rapier's stabilization, cannon's SPOOK bias) shares the overlap between the two. In the air nothing takes that
// lift back out, so a character that jumps onto an 8 kg box and tips it is thrown up by the box's corner.
//
// So after every substep, along each contact with a dynamic body lighter than the character, the character keeps
// only the share of what that contact gave it that the masses allow: k = m_other / m_character.
//   - Velocity: the separating speed the step ADDED along the contact normal (never more than the speed the
//     character now leaves at) is cut to k of itself.
//   - Position: the distance the character was moved out along the normal, past what its own velocity would have
//     carried it, is cut to k of itself.
//   - Lift: unless something solid holds the character up too, the upward speed the step gave it past what it
//     had (past zero, when it was falling) and the height it rose past its own speed are cut to the heaviest
//     light body's share. This is the half that matters most: pushing into a light body's edge ALSO lifts, since
//     the ground under that body will not let it give way downward, so the contact deflects the character up as
//     a wall's edge would, even while it still moves into the body (no separating speed to cut).
// What it leaves alone:
//   - holding the character up: a body resting on a crate is not separating (its speed along the normal is 0),
//     so the crate still stops a fall and carries the character's weight;
//   - a jump off a crate: that speed was there before the step, not added by the contact;
//   - pushing crates: the crate still gets the solver's whole impulse;
//   - heavier bodies, the ground, walls, kinematic platforms: anything at least as heavy, or not dynamic, is
//     solid, and a normal a solid contact also pushes along is left to the solver (the floor under a character
//     that a crate's edge also touches from below).
// Known limit: a light body that is itself carried up by something heavier (a crate on a lift) does not lift a
// character standing on it either.
//
// Run around every `world.step(h)`, on the main thread (InlineExecutor) and in the physics worker (WorkerCore),
// through the same accessors on the same world: the worker's copy steps bit for bit like the inline one.

/** What the rule reads of a dynamic body. Not dynamic (static, kinematic): undefined, which counts as solid. */
export interface ContactBodyInfo {
    readonly mass: number;
    readonly isTrigger: boolean;
    readonly collisionResponse: boolean;
}

/** Normals of one contact pair that agree this well are on the same side (a solid contact shadowing a light one). */
const SAME_SIDE = 0.7;
/** A solid contact whose normal is at least this far up holds the character up (about 72 degrees from level). */
const HOLDS_UP = 0.3;

/** One character's state across a substep. */
interface Watched {
    handle: BodyHandle;
    mass: number;
    /** Before the substep: linear velocity, then node-origin position. */
    readonly pre: Float64Array;
    /** Was it asleep before the substep (then the step did not move it). */
    asleep: boolean;
    /** The light bodies touched this substep: other handle -> index into `light` (normal sum x, y, z, k). */
    readonly lightOf: Map<BodyHandle, number>;
    readonly light: number[];
    /** The solid contacts' normals this substep, pointing into the character (x, y, z). */
    readonly solid: number[];
}

export class CharacterContactRule {
    private _watched: Watched[] = [];
    private readonly _byHandle = new Map<BodyHandle, Watched>();
    private readonly _v = new Float64Array(6);
    private readonly _x = new Float64Array(7);
    private readonly _pos = new Float64Array(3);

    /**
     * The characters to watch over the coming substeps: dynamic bodies, each with its mass. Call before a frame's
     * substeps (cheap when unchanged: the same handles keep their state objects).
     */
    public watch(characters: readonly { handle: BodyHandle; mass: number }[]): void {
        const next: Watched[] = [];
        for (const { handle, mass } of characters) {
            let w = this._byHandle.get(handle);
            if (!w) w = { handle, mass, pre: new Float64Array(6), asleep: false, lightOf: new Map(), light: [], solid: [] };
            w.mass = mass;
            next.push(w);
        }
        this._byHandle.clear();
        for (const w of next) this._byHandle.set(w.handle, w);
        this._watched = next;
    }

    /** Whether any character is watched (nothing to do otherwise). */
    public get active(): boolean { return this._watched.length > 0; }

    /** Before one substep: where each character is and how fast it goes. */
    public before(world: PhysicsWorld): void {
        for (const w of this._watched) {
            if (!world.hasBody(w.handle)) { w.asleep = true; continue; }
            w.asleep = world.isSleeping(w.handle);
            if (w.asleep) continue;
            world.getVelocity(w.handle, this._v);
            world.getTransform(w.handle, this._x);
            const pre = w.pre;
            pre[0] = this._v[0]; pre[1] = this._v[1]; pre[2] = this._v[2];
            pre[3] = this._x[0]; pre[4] = this._x[1]; pre[5] = this._x[2];
        }
    }

    /**
     * After one substep of `h` seconds: take back what lighter bodies gave each character beyond their share.
     * `info` describes a body the character touched (undefined: not dynamic, so solid).
     */
    public after(world: PhysicsWorld, h: number, info: (body: BodyHandle) => ContactBodyInfo | undefined): void {
        if (!(h > 0)) return;
        let g: readonly number[] | null = null;
        for (const w of this._watched) {
            if (w.asleep || !world.hasBody(w.handle)) continue;
            w.lightOf.clear(); w.light.length = 0; w.solid.length = 0;
            world.forEachContactOf(w.handle, (other, nx, ny, nz) => {
                const o = info(other);
                if (o && (o.isTrigger || !o.collisionResponse)) return;
                // The normal points out of the character toward the other body: into the character is its negative.
                if (!o || !(o.mass < w.mass)) { w.solid.push(-nx, -ny, -nz); return; }
                // A pair can touch at several points: one normal per body, their sum (normalised below).
                const at = w.lightOf.get(other);
                if (at === undefined) { w.lightOf.set(other, w.light.length); w.light.push(-nx, -ny, -nz, o.mass / w.mass); }
                else { w.light[at] -= nx; w.light[at + 1] -= ny; w.light[at + 2] -= nz; }
            });
            if (w.light.length === 0) continue;
            g ??= world.gravity;
            this._limit(world, w, h, g);
        }
    }

    private _limit(world: PhysicsWorld, w: Watched, h: number, g: readonly number[]): void {
        world.getVelocity(w.handle, this._v);
        world.getTransform(w.handle, this._x);
        const v = this._v, pre = w.pre, pos = this._pos;
        pos[0] = this._x[0]; pos[1] = this._x[1]; pos[2] = this._x[2];
        let changedV = false, changedX = false;
        const light = w.light, solid = w.solid;
        // The largest share any light body here may give (the heaviest of them).
        let keepMost = 0;
        for (let i = 0; i < light.length; i += 4) {
            const len = Math.hypot(light[i], light[i + 1], light[i + 2]);
            if (!(len > 0)) continue;
            const nx = light[i] / len, ny = light[i + 1] / len, nz = light[i + 2] / len, keep = light[i + 3];
            keepMost = Math.max(keepMost, keep);
            // A solid contact pushing the same way: that push is not the light body's to take back.
            if (this._solidAlong(solid, nx, ny, nz, SAME_SIDE)) continue;
            const cut = 1 - keep;
            // Velocity: what the step added along n (gravity aside), at most the speed it now leaves at.
            const leaving = v[0] * nx + v[1] * ny + v[2] * nz;
            if (leaving > 0) {
                const added = (v[0] - pre[0] - g[0] * h) * nx + (v[1] - pre[1] - g[1] * h) * ny + (v[2] - pre[2] - g[2] * h) * nz;
                const gain = Math.min(leaving, added);
                if (gain > 0) {
                    v[0] -= cut * gain * nx; v[1] -= cut * gain * ny; v[2] -= cut * gain * nz;
                    changedV = true;
                }
            }
            // Position: how far it was moved out along n past where its own speed would have taken it.
            const own = Math.max(0, pre[0] * nx + pre[1] * ny + pre[2] * nz) * h;
            const pushed = (pos[0] - pre[3]) * nx + (pos[1] - pre[4]) * ny + (pos[2] - pre[5]) * nz - own;
            if (pushed > 0) {
                pos[0] -= cut * pushed * nx; pos[1] -= cut * pushed * ny; pos[2] -= cut * pushed * nz;
                changedX = true;
            }
        }

        // Lift. A light body backed by the ground turns the character's own motion upward: an edge it runs into
        // deflects it up as a wall's would (the light body cannot give way downward), and a box tipping under it
        // raises it on its corner. Unless something solid holds the character up as well, the light bodies may
        // stop its fall but raise it only by their share: the upward speed the step gave it past what it had (or
        // past zero, when it was falling) is cut to that share, and so is how far it rose past its own speed.
        const gl = Math.hypot(g[0], g[1], g[2]);
        if (gl > 0 && keepMost < 1) {
            const ux = -g[0] / gl, uy = -g[1] / gl, uz = -g[2] / gl;
            if (!this._solidAlong(solid, ux, uy, uz, HOLDS_UP)) {
                const cut = 1 - keepMost;
                const free = (pre[0] + g[0] * h) * ux + (pre[1] + g[1] * h) * uy + (pre[2] + g[2] * h) * uz;
                const up = v[0] * ux + v[1] * uy + v[2] * uz, base = Math.max(free, 0);
                if (up > base) {
                    const gain = cut * (up - base);
                    v[0] -= gain * ux; v[1] -= gain * uy; v[2] -= gain * uz;
                    changedV = true;
                }
                const own = Math.max(0, pre[0] * ux + pre[1] * uy + pre[2] * uz) * h;
                const rose = (pos[0] - pre[3]) * ux + (pos[1] - pre[4]) * uy + (pos[2] - pre[5]) * uz - own;
                if (rose > 0) {
                    pos[0] -= cut * rose * ux; pos[1] -= cut * rose * uy; pos[2] -= cut * rose * uz;
                    changedX = true;
                }
            }
        }
        if (changedV) world.setLinearVelocity(w.handle, v[0], v[1], v[2]);
        if (changedX) world.setTransform(w.handle, pos, null);
    }

    /** Whether a solid contact (normals into the character, unnormalised) pushes along `n` at least `cos`. */
    private _solidAlong(solid: readonly number[], nx: number, ny: number, nz: number, cos: number): boolean {
        for (let j = 0; j < solid.length; j += 3) {
            const sl = Math.hypot(solid[j], solid[j + 1], solid[j + 2]);
            if (sl > 0 && (solid[j] * nx + solid[j + 1] * ny + solid[j + 2] * nz) / sl > cos) return true;
        }
        return false;
    }
}
