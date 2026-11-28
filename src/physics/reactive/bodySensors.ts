import { vec3 } from 'gl-matrix';
import type { PhysicsBody } from '../physicsBody';
import type { Ragdoll } from '../ragdoll';
import type { BodyHandle } from '../pal/types';
import { capturePoint, convexHull2D, convexPolygonDistance2D } from '../../core/math';

// What a reacting body knows of itself, measured once a step from its simulated parts: where its weight is
// and where it is going, how upright it is, what it touches, where it will land and on what. The reaction
// controller's states and every behaviour read these; the bench's overlays draw them.

/** The ground a falling body is heading over. */
export type TerrainKind = 'flat' | 'slope' | 'stairs' | 'ledge';

/** Where a falling body will land, as far as its predicted path says. */
export interface PredictedImpact {
    /** Seconds until it does. */
    time: number;
    point: [number, number, number];
    normal: [number, number, number];
    /** Speed it lands at (m/s). */
    speed: number;
    /** The head lands before the hips do. */
    headFirst: boolean;
}

/** A source of the last step's contacts, by body handle (the physics step's ContactSource). */
export interface ContactList {
    readonly contactCount: number;
    forEachContact(visit: (a: BodyHandle, b: BodyHandle, nx: number, ny: number, nz: number) => void): void;
}

/**
 * Which of the senses' rays to cast this step (all of them by default): `sweep`, where a fall lands (up to 20 rays);
 * `terrain`, the ground ahead (4); `under`, the ground under the centre (1). What is not cast keeps its last value
 * (the sweep and the terrain read as nothing ahead and flat).
 */
export interface SensorDetail { sweep: boolean; terrain: boolean; under: boolean }
const ALL_DETAIL: SensorDetail = { sweep: true, terrain: true, under: true };

/**
 * How a body lies, from how far the front of its hips and chest faces up (BodySensors.bellyUp): 1 on its back, −1 on
 * its front, 0 on its side. Past ±0.35 from nothing known; once it is one, it stays that until it is well into the
 * next (±0.25 to leave a side, ±0.45 to reach one), so a body rocking on the line does not flicker between them.
 */
export function classifyLying(bellyUp: number, previous: -1 | 0 | 1 | null): -1 | 0 | 1 {
    const s = bellyUp;
    if (previous === 1) return s > 0.25 ? 1 : s < -0.45 ? -1 : 0;
    if (previous === -1) return s < -0.25 ? -1 : s > 0.45 ? 1 : 0;
    if (previous === 0) return s > 0.45 ? 1 : s < -0.45 ? -1 : 0;
    return s > 0.35 ? 1 : s < -0.35 ? -1 : 0;
}

/** How far ahead the fall is predicted, and in how many straight pieces. */
const SWEEP_SECONDS = 1.2;
const SWEEP_PIECES = 10;

export class BodySensors {
    /** Mass-weighted centre and its velocity. */
    public readonly com: [number, number, number] = [0, 0, 0];
    public readonly velocity: [number, number, number] = [0, 0, 0];
    public mass = 0;
    public speed = 0;
    /** 1 standing up, 0 lying, −1 upside down: the hips-to-head direction against up. */
    public uprightness = 1;
    /** Lying on its back (chest facing up) rather than its front. */
    public faceUp = true;
    /**
     * How far the front of the hips and the chest faces up, averaged: 1 flat on its back, −1 flat on its front, near 0
     * on its side (what classifyLying reads).
     */
    public bellyUp = 1;
    /** The trunk's turning speed (rad/s): tumbling, rolling. */
    public trunkSpin = 0;
    /** Parts touching something that is not themselves this step. */
    public readonly touching = new Set<number>();
    /** Parts that started touching this step, and the hardest of those touches (m/s along the normal). */
    public readonly touchedNow = new Set<number>();
    public impactSpeed = 0;
    /** Any part on the ground. */
    public grounded = false;
    public airTime = 0;
    public groundedTime = 0;
    /** Highest the centre has been since it last touched the ground, and the drop from there. */
    public peakHeight = 0;
    public fallHeight = 0;
    /** The ground under the centre (NaN when none within reach) and the body's height over it. */
    public groundY = NaN;
    public height = 0;
    public readonly groundNormal: [number, number, number] = [0, 1, 0];
    /** What the ground ahead looks like, and its slope (rad). */
    public terrain: TerrainKind = 'flat';
    public slope = 0;
    /** Where it will land (null: nothing within the sweep). */
    public impact: PredictedImpact | null = null;
    /** The feet on the ground, as a convex polygon on the ground plane [x, z], and how many feet that is. */
    public support: [number, number][] = [];
    public feetDown = 0;
    /** Where it must step to stop [x, z], and how far outside its feet that is (negative inside). */
    public capture: [number, number] = [0, 0];
    public captureMargin = 0;
    /** Seconds it has been almost still. */
    public stillFor = 0;
    /** Its character's forward on the ground (from the pelvis), and its left. */
    public readonly forward: [number, number, number] = [0, 0, 1];
    public readonly left: [number, number, number] = [1, 0, 0];

    private _handles = new Map<BodyHandle, number>();
    private _wasTouching = new Set<number>();
    private _bodies: PhysicsBody[] = [];

    /** Measure the body after a step of `dt` seconds. */
    public update(ragdoll: Ragdoll, dt: number, contacts: ContactList | null, settleSpeed: number, raycast: Raycaster, detail: SensorDetail = ALL_DETAIL): void {
        const parts = ragdoll.parts;
        if (parts.length === 0) return;
        if (this._bodies.length !== parts.length || this._bodies.some((b, i) => b !== parts[i].body)) {
            this._bodies = parts.map(p => p.body);
            this._handles.clear();
        }
        for (const p of parts) if (typeof p.body.handle === 'number') this._handles.set(p.body.handle, p.index);

        // Weight, momentum.
        let m = 0, cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0, spin = 0, spinMass = 0, still = 0;
        for (const p of parts) {
            const b = p.body, w = p.mass || 1;
            m += w; cx += b.position.x * w; cy += b.position.y * w; cz += b.position.z * w;
            vx += b.velocity.x * w; vy += b.velocity.y * w; vz += b.velocity.z * w;
            still += w * (b.velocity.x ** 2 + b.velocity.y ** 2 + b.velocity.z ** 2);
            if (p.region === 'pelvis' || p.region === 'spine') { spin += w * b.angularVelocity.length(); spinMass += w; }
        }
        m = m || 1;
        this.mass = m;
        this.com[0] = cx / m; this.com[1] = cy / m; this.com[2] = cz / m;
        this.velocity[0] = vx / m; this.velocity[1] = vy / m; this.velocity[2] = vz / m;
        this.speed = Math.hypot(this.velocity[0], this.velocity[1], this.velocity[2]);
        this.trunkSpin = spinMass > 0 ? spin / spinMass : 0;
        const rms = Math.sqrt(still / m);
        this.stillFor = rms < settleSpeed ? this.stillFor + dt : 0;

        // Upright: hips to head.
        const pelvis = parts.find(p => p.region === 'pelvis') ?? parts[0];
        const head = parts.find(p => p.role === 'neck' || p.role === 'head') ?? parts.find(p => p.region === 'neck');
        const chest = parts.find(p => p.role === 'chest') ?? parts.find(p => p.region === 'spine') ?? pelvis;
        if (head) {
            const d = vec3.normalize(vec3.create(), [head.body.position.x - pelvis.body.position.x, head.body.position.y - pelvis.body.position.y, head.body.position.z - pelvis.body.position.z]);
            this.uprightness = d[1];
        }
        // Body frames: X left, Y along the segment, Z forward (ragdollProfile's layout).
        const q = chest.body.quaternion, cq = [q.x, q.y, q.z, q.w];
        const fwd = vec3.transformQuat(vec3.create(), [0, 0, 1], cq as unknown as [number, number, number, number]);
        this.faceUp = fwd[1] > 0;
        const pq = pelvis.body.quaternion;
        const pf = vec3.transformQuat(vec3.create(), [0, 0, 1], [pq.x, pq.y, pq.z, pq.w]);
        this.bellyUp = chest === pelvis ? pf[1] : (pf[1] + fwd[1]) / 2;
        const py = vec3.transformQuat(vec3.create(), [0, 1, 0], [pq.x, pq.y, pq.z, pq.w]);
        // Lying, the pelvis's forward points up or down: its heading is along the body then.
        const flat = Math.hypot(pf[0], pf[2]) > 0.3 ? pf : [py[0], 0, py[2]];
        const fl = Math.hypot(flat[0], flat[2]) || 1;
        this.forward[0] = flat[0] / fl; this.forward[1] = 0; this.forward[2] = flat[2] / fl;
        this.left[0] = this.forward[2]; this.left[1] = 0; this.left[2] = -this.forward[0];

        // Contacts.
        this.touchedNow.clear();
        this.touching.clear();
        this.impactSpeed = 0;
        if (contacts && contacts.contactCount > 0) {
            contacts.forEachContact((a, b, nx, ny, nz) => {
                const pa = this._handles.get(a), pb = this._handles.get(b);
                if (pa !== undefined && pb === undefined) this._touch(parts[pa].body, pa, -nx, -ny, -nz);
                else if (pb !== undefined && pa === undefined) this._touch(parts[pb].body, pb, nx, ny, nz);
            });
        }
        const was = this._wasTouching;
        for (const i of this.touching) if (!was.has(i)) this.touchedNow.add(i);
        const was2 = this._wasTouching;
        was2.clear();
        for (const i of this.touching) was2.add(i);
        this.grounded = this.touching.size > 0;
        if (this.grounded) { this.airTime = 0; this.groundedTime += dt; this.peakHeight = this.com[1]; }
        else { this.airTime += dt; this.groundedTime = 0; this.peakHeight = Math.max(this.peakHeight, this.com[1]); }
        this.fallHeight = Math.max(0, this.peakHeight - this.com[1]);

        // The ground under it and ahead.
        const ignore = this._bodies;
        if (detail.under) {
            const under = raycast([this.com[0], this.com[1] + 0.5, this.com[2]], [this.com[0], this.com[1] - 30, this.com[2]], ignore);
            if (under) {
                this.groundY = under.point[1];
                this.groundNormal[0] = under.normal[0]; this.groundNormal[1] = under.normal[1]; this.groundNormal[2] = under.normal[2];
            } else { this.groundY = NaN; this.groundNormal[0] = 0; this.groundNormal[1] = 1; this.groundNormal[2] = 0; }
        }
        this.height = Number.isFinite(this.groundY) ? this.com[1] - this.groundY : Infinity;
        if (detail.terrain) this._terrain(raycast, ignore);
        else { this.terrain = 'flat'; this.slope = Math.acos(Math.max(-1, Math.min(1, this.groundNormal[1]))); }

        // Where it will land.
        this.impact = detail.sweep ? this._sweep(raycast, ignore, head ?? pelvis, pelvis) : null;

        // Balance: the feet on the ground, the capture point against them.
        const support: [number, number][] = [];
        // A foot on the ground: touching it, or a hair above it (a contact can blink out for a step).
        const onGround = (p: { index: number; body: PhysicsBody; radius: number }) =>
            this.touching.has(p.index) || (Number.isFinite(this.groundY) && p.body.position.y - p.radius - this.groundY < 0.04);
        for (const p of parts) {
            if (p.region !== 'feet' || !onGround(p)) continue;
            const b = p.body, bq = b.quaternion;
            const y = vec3.transformQuat(vec3.create(), [0, 1, 0], [bq.x, bq.y, bq.z, bq.w]);
            const h = Math.max(0, p.halfLength - p.radius * 0.5);
            support.push([b.position.x + y[0] * h, b.position.z + y[2] * h], [b.position.x - y[0] * h, b.position.z - y[2] * h]);
        }
        this.support = convexHull2D(support);
        this.feetDown = support.length / 2;
        const g = 9.81;
        this.capture = capturePoint(this.com, this.velocity, Number.isFinite(this.height) ? Math.max(0.3, this.height) : 1, g);
        this.captureMargin = convexPolygonDistance2D(this.support, this.capture[0], this.capture[1]);
    }

    /** Forget the path so far (a new reaction). */
    public reset(): void {
        this.airTime = 0; this.groundedTime = 0; this.stillFor = 0; this.peakHeight = this.com[1]; this.fallHeight = 0;
        this._wasTouching.clear();
    }

    private _touch(body: PhysicsBody, part: number, nx: number, ny: number, nz: number): void {
        this.touching.add(part);
        if (this._wasTouching.has(part)) return;
        // How hard it came in: its velocity into the surface.
        const into = -(body.velocity.x * nx + body.velocity.y * ny + body.velocity.z * nz);
        if (into > this.impactSpeed) this.impactSpeed = into;
    }

    private _terrain(raycast: Raycaster, ignore: readonly PhysicsBody[]): void {
        const v = this.velocity, flat = Math.hypot(v[0], v[2]);
        const dir = flat > 0.2 ? [v[0] / flat, 0, v[2] / flat] : this.forward;
        const heights: number[] = [];
        for (let i = 0; i < 4; i++) {
            const x = this.com[0] + dir[0] * 0.35 * i, z = this.com[2] + dir[2] * 0.35 * i;
            const hit = raycast([x, this.com[1] + 0.5, z], [x, this.com[1] - 4, z], ignore);
            heights.push(hit ? hit.point[1] : NaN);
        }
        this.slope = Math.acos(Math.max(-1, Math.min(1, this.groundNormal[1])));
        if (!Number.isFinite(heights[0])) { this.terrain = 'ledge'; return; }
        let steps = 0, drop = 0;
        for (let i = 1; i < 4; i++) {
            if (!Number.isFinite(heights[i])) { this.terrain = 'ledge'; return; }
            const d = heights[i - 1] - heights[i];
            drop += d;
            if (Math.abs(d) > 0.08 && Math.abs(d) < 0.45) steps++;
            if (d > 0.9) { this.terrain = 'ledge'; return; }
        }
        this.terrain = steps >= 2 ? 'stairs' : this.slope > 0.2 || Math.abs(drop) > 0.35 ? 'slope' : 'flat';
    }

    /** The ballistic path of the hips (and of the head, the same way) against the world. */
    private _sweep(raycast: Raycaster, ignore: readonly PhysicsBody[], head: { body: PhysicsBody }, pelvis: { body: PhysicsBody }): PredictedImpact | null {
        const g = -9.81, v = this.velocity;
        const at = (p: { x: number; y: number; z: number }, t: number): [number, number, number] =>
            [p.x + v[0] * t, p.y + v[1] * t + 0.5 * g * t * t, p.z + v[2] * t];
        const hit = (p: { x: number; y: number; z: number }): { t: number; point: [number, number, number]; normal: [number, number, number] } | null => {
            let prev = at(p, 0);
            for (let i = 1; i <= SWEEP_PIECES; i++) {
                const t = SWEEP_SECONDS * i / SWEEP_PIECES, next = at(p, t);
                const h = raycast(prev, next, ignore);
                if (h) {
                    const seg = Math.hypot(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]) || 1;
                    return { t: t - SWEEP_SECONDS / SWEEP_PIECES * (1 - h.distance / seg), point: h.point, normal: h.normal };
                }
                prev = next;
            }
            return null;
        };
        const hips = hit(pelvis.body.position), top = hit(head.body.position);
        const first = hips && top ? (top.t < hips.t ? top : hips) : hips ?? top;
        if (!first) return null;
        const vy = v[1] + g * first.t;
        return { time: Math.max(0, first.t), point: first.point, normal: first.normal, speed: Math.hypot(v[0], vy, v[2]), headFirst: !!top && (!hips || top.t + 0.04 < hips.t) };
    }
}

/** A ray against the world that skips `ignore`: point, normal and distance, or null. */
export type Raycaster = (from: ArrayLike<number>, to: ArrayLike<number>, ignore: readonly PhysicsBody[]) =>
    { point: [number, number, number]; normal: [number, number, number]; distance: number } | null;
