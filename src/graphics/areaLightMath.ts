import { LTC_TABLE_SIZE } from './ltcTables';
import { ltcTableTexels } from './lightData';
import { add3, cross3, dot3, normalize3, scale3, sub3 } from '../core/math';
export { cross3 as cross, dot3 as dot, normalize3 as normalize } from '../core/math';

// -----------------------------------------------------------------------------------------------
// The CPU twin of chunks/areaLights.wgsl: the same polygon, the same edge integral, the same LTC lookup,
// in double precision. Tests hold it against brute-force integration (tests/areaLightMath.test.ts), and
// through it hold the shader to the paper; change one, change both.
// -----------------------------------------------------------------------------------------------

export type V3 = [number, number, number];

/** sqrt(pi / (2 sqrt 2)): the circumradius of the octagon of a unit disk's area. */
export const DISK_OCTAGON_SCALE = 1.0539;
export const DISK_SIDES = 8;

export interface AreaEmitter {
    center: V3;
    /** The emitting side's unit normal. */
    normal: V3;
    /** Unit width axis, perpendicular to the normal. */
    tangent: V3;
    halfWidth: number;
    halfHeight: number;
    shape: 'rect' | 'disk';
    twoSided: boolean;
}

/** The emitter's polygon, counter-clockwise seen from its front (4 corners, or the disk's octagon). */
export function areaPolygon(e: AreaEmitter): V3[] {
    const b = cross3(e.normal, e.tangent);
    if (e.shape === 'disk') {
        const r = e.halfWidth * DISK_OCTAGON_SCALE;
        return Array.from({ length: DISK_SIDES }, (_, i) => {
            const a = (i * 2 * Math.PI) / DISK_SIDES;
            return add3(e.center, add3(scale3(e.tangent, Math.cos(a) * r), scale3(b, Math.sin(a) * r)));
        });
    }
    const corner = (sx: number, sy: number) => add3(e.center, add3(scale3(e.tangent, sx * e.halfWidth), scale3(b, sy * e.halfHeight)));
    return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

/** `cross(v1, v2) * theta / sin(theta) / 2pi` by the shader's rational fit. */
export function ltcEdge(v1: V3, v2: V3): V3 {
    const x = dot3(v1, v2);
    const y = Math.abs(x);
    const a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
    const b = 3.4175940 + (4.1616724 + y) * y;
    const v = a / b;
    const thetaSinTheta = x > 0 ? v : 0.5 / Math.sqrt(Math.max(1 - x * x, 1e-7)) - v;
    return scale3(cross3(v1, v2), thetaSinTheta);
}

/** Row-major 3x3 as nine numbers. */
export type M3 = number[];
const mulMV = (m: M3, v: V3): V3 => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
export const IDENTITY3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** The shader's frame round N: T1 in the plane of N and V. */
export function ltcFrame(N: V3, V: V3): [V3, V3, V3] {
    let t1 = sub3(V, scale3(N, dot3(V, N)));
    if (dot3(t1, t1) < 1e-8) {
        t1 = Math.abs(N[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
        t1 = sub3(t1, scale3(N, dot3(t1, N)));
    }
    t1 = normalize3(t1);
    return [t1, scale3(cross3(N, t1), -1), N];
}

/**
 * The emitter integrated against the cosine lobe `minv` (row-major, in the frame) maps it into: the shader's
 * `cleoLtcIntegrate`. 1 for a polygon filling the hemisphere. The polygon is clipped to the lobe's horizon
 * (z > 0) exactly, then Lambert's edge sum's z is the integral.
 */
export function ltcIntegrate(e: AreaEmitter, P: V3, frame: [V3, V3, V3], minv: M3 = IDENTITY3): number {
    const behind = dot3(e.normal, sub3(P, e.center)) < 0;
    if (behind && !e.twoSided) return 0;
    let poly = areaPolygon(e).map(v => {
        const d = sub3(v, P);
        return mulMV(minv, [dot3(frame[0], d), dot3(frame[1], d), dot3(frame[2], d)]);
    });
    // Seen from behind, a two-sided panel winds the other way.
    if (behind) poly = poly.reverse();
    const clipped = clipToHorizon(poly).map(normalize3);
    if (clipped.length < 3) return 0;
    let fz = 0;
    for (let i = 0; i < clipped.length; i++) fz += ltcEdge(clipped[i], clipped[(i + 1) % clipped.length])[2];
    return Math.max(fz, 0);
}

/** Sutherland-Hodgman against z = 0, keeping z >= 0: a convex polygon gains at most one vertex. */
export function clipToHorizon(poly: V3[]): V3[] {
    const out: V3[] = [];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const ina = a[2] >= 0, inb = b[2] >= 0;
        if (ina) out.push(a);
        if (ina !== inb) {
            const t = a[2] / (a[2] - b[2]);
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0]);
        }
    }
    return out;
}

/** The LTC tables' bilinear lookup at (perceptual roughness, NoV): table 0 or 1, as the shader reads it. */
export function ltcLookup(table: 0 | 1, perceptual: number, NoV: number): [number, number, number, number] {
    const t = ltcTableTexels();
    const n = LTC_TABLE_SIZE;
    const u = Math.min(1, Math.max(0, perceptual)) * (n - 1);
    const v = Math.sqrt(Math.min(1, Math.max(0, 1 - NoV))) * (n - 1);
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
    const at = (x: number, y: number, c: number) => {
        const cx = Math.min(n - 1, Math.max(0, x)), cy = Math.min(n - 1, Math.max(0, y));
        return t[(table * n * n + cy * n + cx) * 4 + c];
    };
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
        const a = at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx;
        const b = at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx;
        out[c] = a * (1 - fy) + b * fy;
    }
    return out;
}

/** The inverse transform from a table-1 texel, row-major: `[[a, 0, b], [0, 1, 0], [c, 0, d]]` as the shader builds it. */
export function ltcMinv(t1: [number, number, number, number]): M3 {
    // The shader's mat3x3(vec3(a, 0, b), vec3(0, 1, 0), vec3(c, 0, d)) takes COLUMNS: row-major it is this.
    return [t1[0], 0, t1[2], 0, 1, 0, t1[1], 0, t1[3]];
}

/**
 * The specular the shader computes for a white light of radiance 1 on a surface of specular colour `f0`,
 * before the multi-scatter term: `(f0 x t2.x + (1 - f0) x t2.y) x FF(Minv)`.
 */
export function ltcSpecular(e: AreaEmitter, P: V3, N: V3, V: V3, perceptual: number, f0: number): number {
    const NoV = Math.min(1, Math.max(1e-4, dot3(N, V)));
    const frame = ltcFrame(N, V);
    const t1 = ltcLookup(0, perceptual, NoV);
    const t2 = ltcLookup(1, perceptual, NoV);
    return (f0 * t2[0] + (1 - f0) * t2[1]) * ltcIntegrate(e, P, frame, ltcMinv(t1));
}
