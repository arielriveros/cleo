/**
 * Foliage interaction: grass and bushes bending aside for what moves through them -- characters, moving
 * physics bodies, radial force fields (an explosion) and anything a script or tool registers -- and
 * springing back after it has passed.
 *
 * What the GPU gets is a short list of STAMPS (at most {@link MAX_INTERACT_STAMPS}): a sphere in world
 * space, the direction it was travelling, a strength and the time it was made. Every source writes a live
 * stamp each frame, and drops a TRAIL stamp every so often as it moves, so the grass it walked through
 * stays parted behind it. The vertex stage (chunks/foliageWind.wgsl `interactLean`) bends each plant away
 * from the stamps around it and lets the bend die out as `exp(-age / recovery)`, where `recovery` is the
 * MATERIAL's (Material `interactRecovery`) -- so a stiff bush springs back sooner than long grass, from
 * the same stamps. No per-plant state is kept anywhere: a stamp's age is the whole memory.
 *
 * Pure: the renderer gathers the sources (`gatherFoliageInteractors`) and uploads the packed result.
 */

import type { Scene } from '../core/scene/scene';

/** Stamps the shader reads. Each is two vec4s in `u_interactStamps`. */
export const MAX_INTERACT_STAMPS = 16;
/** Sources farther than this from the camera make no stamps: past it the plants are not swaying anyway. */
export const INTERACT_RANGE = 40;
/** A trail stamp older than this is dropped; at the longest recovery it has faded to almost nothing. */
export const INTERACT_MAX_AGE = 6;

/** Something that pushes foliage aside. */
export interface FoliageInteractor {
    position: ArrayLike<number>;
    /** World radius of what pushes (a character's capsule, a body's bounds, a blast). */
    radius: number;
    /** 0..1 and up: how hard. 1 is a person walking through. */
    strength?: number;
    /** Its velocity, for the trail and for folding the grass along the motion. */
    velocity?: ArrayLike<number>;
}

interface Stamp { x: number; y: number; z: number; r: number; dx: number; dz: number; s: number; birth: number }

/** Speed below which a source counts as standing still: it presses the grass but leaves no trail. */
const MOVING = 0.2;

export class FoliageInteraction {
    /** The packed stamps: per stamp [x, y, z, radius] then [dirX, dirZ, strength, birthTime]. */
    public readonly stamps = new Float32Array(MAX_INTERACT_STAMPS * 8);
    /** How many of `stamps` are in use. */
    public count = 0;

    private _trail: Stamp[] = [];
    /** Where each source last dropped a trail stamp. Keyed by the source object, so a vanished one is GC'd. */
    private _lastDrop = new WeakMap<object, [number, number]>();

    /**
     * Rebuild the stamps for this frame. `sources` are this frame's live interactors, each keyed by an
     * object that stays the same while it lives (the node, the body); `time` is the clock the shader
     * measures ages with (the renderer's wind time).
     */
    update(sources: readonly { key: object; interactor: FoliageInteractor }[], time: number, camera: ArrayLike<number>): void {
        const live: Stamp[] = [];
        for (const { key, interactor } of sources) {
            const p = interactor.position;
            if (Math.hypot(p[0] - camera[0], p[1] - camera[1], p[2] - camera[2]) > INTERACT_RANGE) continue;
            const v = interactor.velocity;
            const vx = v ? v[0] : 0, vz = v ? v[2] : 0;
            const speed = Math.hypot(vx, vz);
            const dx = speed > 1e-4 ? vx / speed : 0, dz = speed > 1e-4 ? vz / speed : 0;
            const s = Math.max(0, interactor.strength ?? 1);
            const r = Math.max(0.05, interactor.radius);
            if (!(s > 0)) continue;
            live.push({ x: p[0], y: p[1], z: p[2], r, dx, dz, s, birth: time });
            // Moving: leave a stamp behind every ~0.8 radii, so the parted grass lingers along the path.
            if (speed > MOVING) {
                const last = this._lastDrop.get(key);
                if (!last || Math.hypot(p[0] - last[0], p[2] - last[1]) >= r * 0.8) {
                    this._trail.push({ x: p[0], y: p[1], z: p[2], r, dx, dz, s, birth: time });
                    this._lastDrop.set(key, [p[0], p[2]]);
                }
            }
        }
        this._trail = this._trail.filter(t => time - t.birth <= INTERACT_MAX_AGE && t.birth <= time);

        // Live stamps first; then the trail, nearest the camera and freshest first, into what is left.
        const dist = (t: Stamp) => Math.hypot(t.x - camera[0], t.y - camera[1], t.z - camera[2]);
        live.sort((a, b) => dist(a) - dist(b));
        const trail = [...this._trail].sort((a, b) => (dist(a) + (time - a.birth) * 4) - (dist(b) + (time - b.birth) * 4));
        const chosen = [...live, ...trail].slice(0, MAX_INTERACT_STAMPS);
        // Never let the trail grow without bound when there are far more than fit.
        if (this._trail.length > MAX_INTERACT_STAMPS * 8) this._trail = trail.slice(0, MAX_INTERACT_STAMPS * 4);

        this.stamps.fill(0);
        chosen.forEach((t, i) => {
            const o = i * 8;
            this.stamps[o] = t.x; this.stamps[o + 1] = t.y; this.stamps[o + 2] = t.z; this.stamps[o + 3] = t.r;
            this.stamps[o + 4] = t.dx; this.stamps[o + 5] = t.dz; this.stamps[o + 6] = t.s; this.stamps[o + 7] = t.birth;
        });
        this.count = chosen.length;
    }

    /** Forget every stamp (a scene change). */
    clear(): void {
        this._trail = [];
        this._lastDrop = new WeakMap();
        this.stamps.fill(0);
        this.count = 0;
    }
}

/** A character's push radius when it says nothing better: about a person's shoulders. */
const CHARACTER_RADIUS = 0.45;

/**
 * This frame's interactors in `scene`: its characters, its dynamic physics bodies that are moving, its
 * enabled radial force fields (a blast pushes everything outward over its radius), and whatever was
 * registered with `scene.addFoliageInteractor`.
 */
export function gatherFoliageInteractors(scene: Scene): { key: object; interactor: FoliageInteractor }[] {
    const out: { key: object; interactor: FoliageInteractor }[] = [];
    for (const c of scene.characters) {
        if (!c.visible) continue;
        out.push({ key: c, interactor: { position: c.worldPosition, radius: CHARACTER_RADIUS, strength: 1, velocity: c.currentVelocity } });
    }
    const bodies = (scene as any).physics?.bodies as readonly any[] | undefined;
    if (bodies) {
        for (const b of bodies) {
            if (!(b.mass > 0) || !b.velocity || !b.position) continue;
            const speed = Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z);
            if (speed < 0.5) continue;
            const radius = Number(b.boundingRadius) > 0 ? Math.min(3, b.boundingRadius) : 0.5;
            out.push({ key: b, interactor: {
                position: [b.position.x, b.position.y, b.position.z], radius,
                strength: Math.min(1.5, speed / 4), velocity: [b.velocity.x, b.velocity.y, b.velocity.z],
            } });
        }
    }
    for (const f of scene.forceFields) {
        if (!f.enabled || !f.visible || f.kind !== 'radial' || !(Math.abs(f.strength) > 0)) continue;
        out.push({ key: f, interactor: { position: f.worldPosition, radius: f.radius, strength: Math.min(2, Math.abs(f.strength) / 10) } });
    }
    for (const [key, interactor] of scene.foliageInteractors) out.push({ key, interactor });
    return out;
}
