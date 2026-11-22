// WHERE FLOWING WATER THROWS SPRAY, and how hard: points on a Water node's drawn grid (its bake, or the grid its
// shape draws), the obstacles standing in it and the bodies its current hits. What the spray rig
// (waterSprayRig.ts) turns into droplets, mist and foam. Pure: grids and numbers in, points out, unit tested.
//
//  - RAPIDS: where the water loses its energy (water/bake/foam.ts foamEmission: the head it loses a second,
//    squared), clustered into a point every few metres. A gentle river loses a centimetre a second and throws
//    nothing; a torrent's chutes and the foot of a weir throw spray in proportion.
//  - FALLS: a LIP where the surface starts to drop steeply along the flow (and the flow is quick), followed down
//    the flow to its PLUNGE, where the drop flattens out (or the water runs into the water below): a fall only if
//    it does within SPRAY_FALL_REACH, and drops at least SPRAY_FALL_STEEP of its run (a long steep chute is a
//    rapid all the way down, not a fall with a foot halfway): the fall's height H, the water going over it (q), and
//    the speed it lands at, sqrt(u^2 + 2 g H) (the bake holds a torrent's own speed down by its roughness: the
//    fall's height says how hard it lands). Its power is rho g q H. A fall close to sheer (H at least twice
//    its run) is a CURTAIN too: spray all the way down its face.
//  - FACES: a static collider standing in water faster than SPRAY_FACE_SPEED: the face the current meets, as
//    wide as the collider across the flow, where the water piles U^2 / 2g up its front and bursts.
//  - BODIES: anything crossing the surface faster than SPRAY_BODY_SPEED against the water (a boat's bow, a crate
//    held in a rapid, a swimmer): spray off the face the water meets; a hard entry from above, a splash.

import { foamEmission } from '../bake/foam';
import type { WaterInfo } from '../waterInfo';
import type { WaterObstacleFootprint } from '../bake/obstacles';
import { roundedRectSupport } from '../../core/math';

const G = 9.81;

/** Foam made a second (foamEmission) below which a cell is no rapid. */
export const SPRAY_RAPID_MIN = 0.02;
/** Metres a rapid's cells are gathered over into one point, at least (and two cells). */
export const SPRAY_RAPID_BUCKET = 4;
/** The surface's fall along the flow (rise over run) a lip starts at. */
export const SPRAY_LIP_SLOPE = 0.4;
/** The current a lip runs at, at least (m/s): a still pool's edge is no fall. */
export const SPRAY_LIP_SPEED = 0.3;
/** Metres a fall drops at least to be one (a step in a rapid is one, small). */
export const SPRAY_FALL_MIN = 0.3;
/** Metres a fall is followed down at most. */
export const SPRAY_FALL_REACH = 40;
/** Rise over run a fall drops at least, lip to plunge. */
export const SPRAY_FALL_STEEP = 0.8;
/** The current (m/s) past which water bursts on what stands in it. */
export const SPRAY_FACE_SPEED = 1;
/** The speed (m/s) against the water past which a body throws spray. */
export const SPRAY_BODY_SPEED = 1.5;
/** The downward speed (m/s) past which a body entering the water splashes. */
export const SPRAY_ENTRY_SPEED = 2;

export type SprayKind = 'rapid' | 'lip' | 'curtain' | 'plunge' | 'face' | 'body' | 'entry';

/** One place spray rises from. World space; its ellipse lies on the ground plane. */
export interface SprayPoint {
    /** Stable from one build to the next while the water stays as it is (its rate is accumulated by it). */
    id: number;
    kind: SprayKind;
    x: number; y: number; z: number;
    /** Its ellipse: along the flow (unit), half its length along it and half its width across. */
    ax: number; az: number;
    along: number; across: number;
    /** Metres above `y` it rises through (a curtain's face). */
    rise: number;
    /** The current there (m/s). */
    ux: number; uz: number;
    /** The speed that drives it: the current (rapid, lip, face), the landing speed (curtain, plunge), the body's against the water. */
    speed: number;
    /** What its rates scale with: foam made x area (rapid), rho g q H (plunge), w U^3 (face), share r (|v| - 1.5)^3 (body). */
    power: number;
    /** Metres: a fall's height (lip, curtain, plunge), the pile up a face. */
    height: number;
    /** m3/s going over a fall (lip, curtain, plunge). */
    q: number;
}

/** The water at a point of a grid (only its own water counts): surface, current, depth, and whether there is any. */
export interface FlowSample { surface: number; u: number; v: number; depth: number; wet: boolean; }

/**
 * The water of `info`'s own cells at world (x, z): bilinear over the four cells round it, among those that are
 * the water's (a dry cell's carried surface is no water). `wet` when at least half the weight is water.
 */
export function sampleFlow(info: WaterInfo, x: number, z: number, out: FlowSample = { surface: 0, u: 0, v: 0, depth: 0, wet: false }): FlowSample {
    const { nx, nz, cell, info0, info1 } = info;
    const fx = (x - info.originX) / cell, fz = (z - info.originZ) / cell;
    out.wet = false; out.surface = 0; out.u = 0; out.v = 0; out.depth = 0;
    if (!(fx >= 0 && fz >= 0 && fx <= nx - 1 && fz <= nz - 1)) return out;
    const x0 = Math.min(nx - 2, Math.floor(fx)), z0 = Math.min(nz - 2, Math.floor(fz));
    const tx = fx - x0, tz = fz - z0;
    let w = 0, s = 0, u = 0, v = 0, d = 0;
    for (let k = 0; k < 4; k++) {
        const ix = x0 + (k & 1), iz = z0 + (k >> 1);
        const i = iz * nx + ix;
        if (!(info1[i * 4 + 3] > 0.5)) continue;
        const wk = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? tz : 1 - tz);
        s += info0[i * 4] * wk; u += info0[i * 4 + 1] * wk; v += info0[i * 4 + 2] * wk;
        d += Math.max(0, info0[i * 4] - info1[i * 4 + 2]) * wk;
        w += wk;
    }
    if (w < 0.5) return out;
    out.surface = s / w; out.u = u / w; out.v = v / w; out.depth = d / w; out.wet = true;
    return out;
}

const KIND_CODE: Record<SprayKind, number> = { rapid: 1, lip: 2, curtain: 3, plunge: 4, face: 5, body: 6, entry: 7 };
const idOf = (kind: SprayKind, n: number) => (KIND_CODE[kind] * 0x1000000 + (n & 0xffffff)) >>> 0;

/**
 * The spray points of a water's drawn grid `info`: its falls (lip, curtain, plunge) and its rapids. Stable ids:
 * the same grid gives the same points.
 */
export function flowSprayField(info: WaterInfo): SprayPoint[] {
    const { nx, nz, cell, info0, info1 } = info;
    const n = nx * nz;
    const own = new Uint8Array(n);
    const surface = new Float32Array(n), depth = new Float32Array(n), u = new Float32Array(n), v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        own[i] = info1[i * 4 + 3] > 0.5 ? 1 : 0;
        surface[i] = info0[i * 4]; u[i] = info0[i * 4 + 1]; v[i] = info0[i * 4 + 2];
        depth[i] = own[i] ? Math.max(0, info0[i * 4] - info1[i * 4 + 2]) : 0;
    }
    const points: SprayPoint[] = [];
    const quiet = new Uint8Array(n);
    findFalls(info, own, surface, depth, u, v, points, quiet);

    // Rapids: where the water loses its energy, gathered into a point every bucket.
    const made = foamEmission({ nx, nz, cell, water: own, surface, depth, u, v });
    const bucket = Math.max(SPRAY_RAPID_BUCKET, 2 * cell);
    const per = Math.max(1, Math.round(bucket / cell));
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
        if (!own[i] || quiet[i] || !(made[i] > SPRAY_RAPID_MIN)) continue;
        const x = i % nx, z = (i - x) / nx;
        const k = Math.floor(z / per) * 65536 + Math.floor(x / per);
        const list = groups.get(k);
        if (list) list.push(i); else groups.set(k, [i]);
    }
    const area = cell * cell;
    for (const [key, list] of groups) {
        let w = 0, sx = 0, sz = 0, sy = 0, su = 0, sv = 0;
        for (const i of list) {
            const x = i % nx, z = (i - x) / nx, e = made[i] * area;
            w += e; sx += x * e; sz += z * e; sy += surface[i] * e; su += u[i] * e; sv += v[i] * e;
        }
        if (!(w > 0)) continue;
        const cx = sx / w, cz = sz / w, mu = su / w, mv = sv / w;
        const speed = Math.hypot(mu, mv);
        const ax = speed > 1e-3 ? mu / speed : 1, az = speed > 1e-3 ? mv / speed : 0;
        // Its spread along the flow and across it: two standard deviations, and half a cell.
        let along = 0, across = 0;
        for (const i of list) {
            const x = i % nx, z = (i - x) / nx, e = made[i] * area;
            const dx = x - cx, dz = z - cz;
            along += e * (dx * ax + dz * az) ** 2;
            across += e * (-dx * az + dz * ax) ** 2;
        }
        points.push({
            id: idOf('rapid', key), kind: 'rapid',
            x: info.originX + cx * cell, y: sy / w, z: info.originZ + cz * cell,
            ax, az, along: (2 * Math.sqrt(along / w) + 0.5) * cell, across: (2 * Math.sqrt(across / w) + 0.5) * cell, rise: 0,
            ux: mu, uz: mv, speed, power: w, height: 0, q: 0,
        });
    }
    return points;
}

/** The falls of a grid: lips, their curtains and plunges, into `points`; marks the cells about them `quiet` (no rapid there too). */
function findFalls(info: WaterInfo, own: Uint8Array, surface: Float32Array, depth: Float32Array, u: Float32Array, v: Float32Array,
                   points: SprayPoint[], quiet: Uint8Array): void {
    const { nx, nz, cell } = info;
    const n = nx * nz;
    const s0: FlowSample = { surface: 0, u: 0, v: 0, depth: 0, wet: false };
    const s1: FlowSample = { surface: 0, u: 0, v: 0, depth: 0, wet: false };
    // Each cell: the surface's fall over the next cell down the flow, and over the one above it.
    const lip = new Uint8Array(n);
    const slope = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        if (!own[i] || depth[i] < 0.02) continue;
        const speed = Math.hypot(u[i], v[i]);
        if (speed < SPRAY_LIP_SPEED) continue;
        const ux = u[i] / speed, uz = v[i] / speed;
        const x = i % nx, z = (i - x) / nx;
        const wx = info.originX + x * cell, wz = info.originZ + z * cell;
        sampleFlow(info, wx + ux * cell, wz + uz * cell, s0);
        if (!s0.wet) continue;
        const down = (surface[i] - s0.surface) / cell;
        slope[i] = down;
        if (down < SPRAY_LIP_SLOPE) continue;
        sampleFlow(info, wx - ux * cell, wz - uz * cell, s1);
        const up = s1.wet ? (s1.surface - surface[i]) / cell : 0;
        if (up < down / 2) lip[i] = 1;
    }
    // Lips side by side, running the same way, are one.
    const seen = new Uint8Array(n);
    const groups: number[][] = [];
    for (let s = 0; s < n; s++) {
        if (!lip[s] || seen[s]) continue;
        const group: number[] = [];
        const stack = [s];
        seen[s] = 1;
        const sp = Math.hypot(u[s], v[s]), ux0 = u[s] / sp, uz0 = v[s] / sp;
        while (stack.length) {
            const i = stack.pop()!;
            group.push(i);
            const x = i % nx, z = (i - x) / nx;
            for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
                const xx = x + a, zz = z + b;
                if (xx < 0 || zz < 0 || xx >= nx || zz >= nz) continue;
                const j = zz * nx + xx;
                if (!lip[j] || seen[j]) continue;
                const sj = Math.hypot(u[j], v[j]);
                if ((u[j] * ux0 + v[j] * uz0) / sj < 0.7) continue;
                seen[j] = 1;
                stack.push(j);
            }
        }
        groups.push(group);
    }
    // Highest first: a fall followed down marks its way, and the lips on it are part of it.
    const top = (g: number[]) => Math.max(...g.map(i => surface[i]));
    groups.sort((a, b) => top(b) - top(a));
    const used = new Uint8Array(n);
    for (const group of groups) {
        let w = 0, sx = 0, sz = 0, sy = 0, su = 0, sv = 0, q = 0;
        for (const i of group) {
            const x = i % nx, z = (i - x) / nx;
            const flux = Math.hypot(u[i], v[i]) * depth[i] * cell;
            const wk = Math.max(flux, 1e-6);
            w += wk; sx += x * wk; sz += z * wk; sy += surface[i] * wk; su += u[i] * wk; sv += v[i] * wk;
            q += flux;
        }
        const cx = sx / w, cz = sz / w;
        const ci = Math.min(nz - 1, Math.max(0, Math.round(cz))) * nx + Math.min(nx - 1, Math.max(0, Math.round(cx)));
        if (used[ci]) continue;
        const ulx = su / w, ulz = sv / w, uLip = Math.hypot(ulx, ulz);
        if (!(uLip > 1e-3)) continue;
        let dx = ulx / uLip, dz = ulz / uLip;
        const lipSlope = Math.max(...group.map(i => slope[i]));
        const lipY = sy / w;
        // Down the flow from the lip until the drop eases off: the plunge.
        let px = info.originX + cx * cell, pz = info.originZ + cz * cell, py = lipY, run = 0, easy = 0, eased = false;
        const lx = px, lz = pz;
        const step = 0.5 * cell;
        for (let k = 0; run < SPRAY_FALL_REACH && k < 4 * SPRAY_FALL_REACH / cell; k++) {
            const nxp = px + dx * step, nzp = pz + dz * step;
            // Out of this water (into the lake or the river below it): it lands there.
            if (!sampleFlow(info, nxp, nzp, s0).wet) { eased = true; break; }
            const drop = (py - s0.surface) / step;
            px = nxp; pz = nzp; py = s0.surface; run += step;
            const sp = Math.hypot(s0.u, s0.v);
            if (sp > 0.2) { dx = s0.u / sp; dz = s0.v / sp; }
            // Mark the way, a cell either side.
            const gx = Math.round((px - info.originX) / cell), gz = Math.round((pz - info.originZ) / cell);
            for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
                const xx = gx + a, zz = gz + b;
                if (xx >= 0 && zz >= 0 && xx < nx && zz < nz) used[zz * nx + xx] = 1;
            }
            if (drop < lipSlope / 4) { if (++easy >= 2) { eased = true; break; } } else easy = 0;
        }
        const height = lipY - py;
        if (!eased || height < SPRAY_FALL_MIN || height < SPRAY_FALL_STEEP * Math.hypot(px - lx, pz - lz)) continue;
        const width = Math.max(cell, Math.sqrt(group.length) * cell);
        const impact = Math.sqrt(uLip * uLip + 2 * G * height);
        const power = 1000 * G * q * height;
        const lax = ulx / uLip, laz = ulz / uLip;
        const base = { ax: lax, az: laz, ux: ulx, uz: ulz, height, q };
        points.push({ ...base, id: idOf('lip', ci), kind: 'lip', x: lx, y: lipY, z: lz, along: 0.5 * cell, across: width / 2, rise: 0,
                      speed: uLip, power });
        const horizontal = Math.hypot(px - lx, pz - lz);
        if (height >= 2 * Math.max(horizontal, 0.5 * cell))
            points.push({ ...base, id: idOf('curtain', ci), kind: 'curtain', x: lx + lax * 0.5 * cell, y: py, z: lz + laz * 0.5 * cell,
                          along: 0.5 * cell, across: width / 2, rise: height, speed: impact, power });
        points.push({ ...base, id: idOf('plunge', ci), kind: 'plunge', x: px, y: py, z: pz, along: Math.max(1, cell), across: width / 2 + 1,
                      rise: 0, speed: impact, power });
        // No rapid of its own round the lip and the plunge: they are this fall's.
        for (const [qx, qz] of [[lx, lz], [px, pz]]) {
            const gx = Math.round((qx - info.originX) / cell), gz = Math.round((qz - info.originZ) / cell);
            for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
                const xx = gx + a, zz = gz + b;
                if (xx >= 0 && zz >= 0 && xx < nx && zz < nz) quiet[zz * nx + xx] = 1;
            }
        }
    }
}

/**
 * The faces fast water meets on the obstacles standing in it (`footprints`, at the surface): `flow` gives the
 * water round them. One point per obstacle the current runs at faster than SPRAY_FACE_SPEED.
 */
export function obstacleSpray(footprints: readonly WaterObstacleFootprint[], flow: (x: number, z: number, out: FlowSample) => FlowSample,
                              cell: number): SprayPoint[] {
    const out: SprayPoint[] = [];
    const s: FlowSample = { surface: 0, u: 0, v: 0, depth: 0, wet: false };
    for (const f of footprints) {
        if (f.under > 0.2) continue;
        // The current round it, a cell and a half out (its own cells read still: it is a wall to the bake).
        let n = 0, su = 0, sv = 0, sy = 0;
        for (let k = 0; k < 8; k++) {
            const a = k * Math.PI / 4, dx = Math.cos(a), dz = Math.sin(a);
            const reach = roundedRectSupport(f.ax, f.az, f.a, f.b, f.r, dx, dz) + 1.5 * cell;
            if (!flow(f.x + dx * reach, f.z + dz * reach, s).wet) continue;
            n++; su += s.u; sv += s.v; sy += s.surface;
        }
        if (!n) continue;
        const U = Math.hypot(su / n, sv / n);
        if (U <= SPRAY_FACE_SPEED) continue;
        const ux = su / n / U, uz = sv / n / U;
        const front = roundedRectSupport(f.ax, f.az, f.a, f.b, f.r, ux, uz);
        const half = roundedRectSupport(f.ax, f.az, f.a, f.b, f.r, -uz, ux);
        const width = 2 * half;
        const key = (Math.round(f.x * 4) * 73856093) ^ (Math.round(f.z * 4) * 19349663);
        out.push({
            id: idOf('face', key), kind: 'face', x: f.x - ux * front, y: sy / n, z: f.z - uz * front,
            ax: ux, az: uz, along: 0.15, across: half, rise: 0, ux: su / n, uz: sv / n, speed: U,
            power: width * U * U * U, height: U * U / (2 * G), q: 0,
        });
    }
    return out;
}

/** A body crossing the surface (WaterVolumeNode.disturbances): where, how big, how much of it, and its motion against the water. */
export interface SprayBody { x: number; z: number; radius: number; share: number; vx: number; vy: number; vz: number; }

/**
 * The spray bodies crossing the surface throw: off the face the water meets when they move against it faster
 * than SPRAY_BODY_SPEED, and a splash where one comes down into it faster than SPRAY_ENTRY_SPEED. `surface`
 * gives the water's height under each. `salt` keeps two waters' bodies apart.
 */
export function bodySpray(bodies: readonly SprayBody[], surface: (x: number, z: number) => number | null, salt = 0): SprayPoint[] {
    const out: SprayPoint[] = [];
    bodies.forEach((b, k) => {
        const planar = Math.hypot(b.vx, b.vz);
        const y = surface(b.x, b.z);
        if (y === null) return;
        if (planar > SPRAY_BODY_SPEED) {
            const ux = b.vx / planar, uz = b.vz / planar;
            out.push({
                id: idOf('body', salt * 64 + k), kind: 'body', x: b.x + ux * b.radius, y, z: b.z + uz * b.radius,
                ax: ux, az: uz, along: 0.1, across: Math.max(0.05, b.radius * 0.8), rise: 0, ux: -b.vx, uz: -b.vz,
                speed: planar, power: b.share * b.radius * (planar - SPRAY_BODY_SPEED) ** 3, height: 0, q: 0,
            });
        }
        if (b.vy < -SPRAY_ENTRY_SPEED) {
            out.push({
                id: idOf('entry', salt * 64 + k), kind: 'entry', x: b.x, y, z: b.z, ax: 1, az: 0,
                along: Math.max(0.05, b.radius * 0.9), across: Math.max(0.05, b.radius * 0.9), rise: 0, ux: 0, uz: 0,
                speed: -b.vy, power: b.share * b.radius * b.radius * -b.vy, height: 0, q: 0,
            });
        }
    });
    return out;
}
