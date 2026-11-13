/**
 * The 2D half of AI control, as pure functions over a ray and a ground query: what a side-view agent
 * needs that the 3D steering does not answer -- which way its eyes point, the angle to a target in the
 * picture plane, and whether a wall or a drop is just ahead.
 *
 * A LEAF (gl-matrix only): the queries are passed in as functions, so a test hands it a lambda over a
 * grid and the controller hands it the scene's 2D world (World2D.raycast / groundBelow).
 *
 * Conventions: a 2D scene's picture plane is XY, +x right, +y up. A 2D body FACES +1 (right) or -1
 * (left) -- it flips its sprite rather than rotating -- so its "forward" is (facing, 0).
 */

import { vec3 } from "gl-matrix";
import type { ProbeHit } from "./steering";

/** Up for a walker's steering: flattening along +Y leaves motion along X. */
export const AXIS_Y: Readonly<vec3> = vec3.fromValues(0, 1, 0);
/** Up for a flier's steering and for distances in the picture plane: flattening along +Z leaves XY. */
export const AXIS_Z: Readonly<vec3> = vec3.fromValues(0, 0, 1);

/** A ray against the 2D world: the first solid hit within `max`, its distance and face normal, or null. */
export type Ray2DFn = (x: number, y: number, dx: number, dy: number, max: number)
    => { distance: number, normal: readonly [number, number] } | null;
/** The top of the ground under a box `halfWidth` either side of x, from `fromY` down `depth`, or -Infinity. */
export type Ground2DFn = (x: number, halfWidth: number, fromY: number, depth: number) => number;

/**
 * The yaw a vision cone needs to look the way a 2D body faces, in the perception's XZ frame (the picture
 * plane laid flat, its y as z): +90 looks along +x, -90 along -x.
 */
export function facingYaw2D(facing: number): number {
    return facing < 0 ? -90 : 90;
}

/**
 * The angle to a target in the picture plane, degrees, from the way the body faces: 0 dead ahead, +90
 * straight up, -90 straight down, ±180 behind. Mirrored with the facing, so "ahead and above" is positive
 * whichever way the body looks.
 */
export function angleToTarget2D(dx: number, dy: number, facing: number): number {
    if (dx === 0 && dy === 0) return 0;
    return Math.atan2(dy, dx * (facing < 0 ? -1 : 1)) * 180 / Math.PI;
}

/**
 * Whether a wall stands within `reach` ahead of a body (feet at x, y; `height` tall) moving `dir` (±1):
 * a solid hit at knee height whose face is a wall (|normal x| over 0.7), not a slope to walk up.
 */
export function probeWall2D(ray: Ray2DFn, x: number, y: number, dir: number, halfWidth: number,
                            height: number, reach: number): boolean {
    const d = dir < 0 ? -1 : 1;
    const knee = y + Math.min(0.6, height * 0.35);
    const hit = ray(x + d * (halfWidth - 0.02), knee, d, 0, reach);
    return !!hit && Math.abs(hit.normal[0]) > 0.7;
}

/**
 * How tall the wall ahead is above the feet, up to `limit`: the lowest height a level ray at it clears,
 * or Infinity if none up to `limit` does. A walker can jump a wall lower than its jump height.
 */
export function wallHeight2D(ray: Ray2DFn, x: number, y: number, dir: number, halfWidth: number,
                             reach: number, limit: number, step: number = 0.25): number {
    const d = dir < 0 ? -1 : 1;
    for (let h = step; h <= limit + 1e-6; h += step) {
        const hit = ray(x + d * (halfWidth - 0.02), y + h, d, 0, reach);
        if (!hit) return h;
    }
    return Infinity;
}

/**
 * Whether the ground ends just ahead of a body moving `dir`: no floor (one-way platforms count) within
 * `drop` below its feet at `ahead` past its leading edge. A walker turns, or stops, at one.
 */
export function probeLedge2D(ground: Ground2DFn, x: number, y: number, dir: number, halfWidth: number,
                             ahead: number, drop: number): boolean {
    const d = dir < 0 ? -1 : 1;
    const probeX = x + d * (halfWidth + ahead);
    const top = ground(probeX, 0.05, y + 0.05, drop + 0.05);
    return !(top > -Infinity);
}

/** The way a pacing walker goes next: turned back at a wall or a ledge, otherwise on. */
export function paceDirection(current: number, wallAhead: boolean, ledgeAhead: boolean): number {
    const d = current < 0 ? -1 : 1;
    return wallAhead || ledgeAhead ? -d : d;
}

/**
 * A fan of `count` rays from (x, y) about the heading (hx, hy), `spread` degrees across, each `reach`
 * long, written as steering probe hits (in the XY plane, z 0) for `avoidObstacles` with up +Z: a flier's
 * whiskers. Returns how many hit.
 */
export function fanProbes2D(ray: Ray2DFn, x: number, y: number, hx: number, hy: number, count: number,
                            spread: number, reach: number, out: ProbeHit[]): number {
    out.length = 0;
    const len = Math.hypot(hx, hy);
    if (!(len > 1e-9) || !(reach > 0)) return 0;
    const heading = Math.atan2(hy, hx);
    const n = Math.max(1, Math.min(9, Math.round(count)));
    for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
        const a = heading + (t * spread * 0.5) * Math.PI / 180;
        const dx = Math.cos(a), dy = Math.sin(a);
        const hit = ray(x, y, dx, dy, reach);
        if (!hit) continue;
        out.push({ direction: [dx, dy, 0], distance: hit.distance, normal: [hit.normal[0], hit.normal[1], 0] });
    }
    return out.length;
}
