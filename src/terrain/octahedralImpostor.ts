/**
 * Octahedral impostors: a model captured from a hemisphere of directions into one atlas, so a distant
 * instance can be drawn as a single camera-facing quad that still shows the right side of the model.
 *
 * ## Why, over the cross-quad card
 *
 * The card is one front elevation on two crossed quads. It reads as the model only from roughly level
 * and only far away: from above it collapses to two lines, and near enough to see parallax it reads as
 * what it is. That is what pushes a card's takeover out to ~8x the model's height. An octahedral impostor
 * stores N x N views over the upper hemisphere (hemi-octahedral mapping) and blends the three nearest to
 * the actual view direction, which holds up much closer — so the expensive mesh levels can hand over
 * earlier. It is the technique Fortnite's and Horizon's foliage use (Ryan Brucks' ImposterBaker).
 *
 * ## The conventions, which the baker and chunks/octahedralImpostor.wgsl must share exactly
 *
 * - Frames sit on an N x N grid of hemi-octahedral coordinates `(i, j) / (N - 1)`, frame (i, j) at tile
 *   column i, row j of the atlas (row 0 at the TOP of the image, as the baker writes it).
 * - A frame's direction D points FROM the model's centre TOWARD the camera that captured it.
 * - Each frame is an orthographic capture of the sphere of `radius` around `center`, looking along -D,
 *   with image right = T and image up = B from {@link frameBasis}.
 *
 * Pure and dependency-free so the conventions are unit-testable without a GPU.
 */

export type V3 = [number, number, number];

/** Views per side by default: 8 x 8 = 64 frames. */
export const OCTA_DEFAULT_FRAMES = 8;

/** Unit direction (y >= 0) -> hemi-octahedral uv in [0, 1]². Directions below the horizon fold up. */
export function hemiOctEncode(d: V3): [number, number] {
    const x = d[0], z = d[2], y = Math.abs(d[1]);
    const s = Math.abs(x) + y + Math.abs(z) || 1;
    const px = x / s, pz = z / s;
    return [(px + pz) * 0.5 + 0.5, (px - pz) * 0.5 + 0.5];
}

/** Hemi-octahedral uv in [0, 1]² -> unit direction with y >= 0. The inverse of {@link hemiOctEncode}. */
export function hemiOctDecode(u: number, v: number): V3 {
    const a = u * 2 - 1, b = v * 2 - 1;
    const x = (a + b) * 0.5, z = (a - b) * 0.5;
    const y = Math.max(0, 1 - Math.abs(x) - Math.abs(z));
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
}

/** The direction of frame (i, j) on an N x N grid. */
export function frameDirection(i: number, j: number, frames: number): V3 {
    const n = Math.max(2, frames) - 1;
    return hemiOctDecode(i / n, j / n);
}

/**
 * The capture basis for a view along -`d`: image right `t` and image up `b`, with `t`, `b`, `d`
 * right-handed. Near the zenith world-up is parallel to `d`, so +Z stands in for it there.
 */
export function frameBasis(d: V3): { t: V3; b: V3 } {
    const up: V3 = Math.abs(d[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
    // t = normalize(up x d)
    let tx = up[1] * d[2] - up[2] * d[1], ty = up[2] * d[0] - up[0] * d[2], tz = up[0] * d[1] - up[1] * d[0];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // b = d x t
    const bx = d[1] * tz - d[2] * ty, by = d[2] * tx - d[0] * tz, bz = d[0] * ty - d[1] * tx;
    return { t: [tx, ty, tz], b: [bx, by, bz] };
}

/**
 * Where world point `p` lands in frame `d`'s image, as uv in [0, 1]² (v = 0 at the BOTTOM of the frame),
 * for an impostor of `radius` around `center`.
 */
export function frameUv(p: V3, center: V3, radius: number, d: V3): [number, number] {
    const { t, b } = frameBasis(d);
    const lx = p[0] - center[0], ly = p[1] - center[1], lz = p[2] - center[2];
    const r2 = 2 * Math.max(radius, 1e-6);
    return [(lx * t[0] + ly * t[1] + lz * t[2]) / r2 + 0.5, (lx * b[0] + ly * b[1] + lz * b[2]) / r2 + 0.5];
}

/**
 * The three frames to blend for a view direction (model space, pointing from the centre to the eye), and
 * their weights: the corners of the grid triangle the direction falls in, barycentric. Sums to 1.
 */
export function frameBlend(view: V3, frames: number): { cells: [number, number][]; weights: [number, number, number] } {
    const n = Math.max(2, frames) - 1;
    const [u, v] = hemiOctEncode(view);
    const gx = Math.min(n - 1e-6, Math.max(0, u * n)), gy = Math.min(n - 1e-6, Math.max(0, v * n));
    const cx = Math.floor(gx), cy = Math.floor(gy);
    const fx = gx - cx, fy = gy - cy;
    if (fx + fy < 1) return { cells: [[cx, cy], [cx + 1, cy], [cx, cy + 1]], weights: [1 - fx - fy, fx, fy] };
    return { cells: [[cx + 1, cy + 1], [cx, cy + 1], [cx + 1, cy]], weights: [fx + fy - 1, 1 - fx, 1 - fy] };
}

/** An octahedral impostor's description, as a foliage rule and layer carry it. */
export interface OctahedralImpostorInfo {
    /** Frames per side of the atlas. */
    frames: number;
    /** Radius of the captured sphere, model units. */
    radius: number;
    /** Centre of the captured sphere, model space. */
    center: V3;
}

/** Read one tolerantly, or null. */
export function parseOctahedralInfo(raw: unknown): OctahedralImpostorInfo | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const frames = Math.round(Number(o.frames));
    const radius = Number(o.radius);
    const c = Array.isArray(o.center) ? o.center.map(Number) : null;
    if (!(frames >= 2 && frames <= 32) || !(radius > 0) || !c || c.length < 3 || c.some(v => !Number.isFinite(v))) return null;
    return { frames, radius, center: [c[0], c[1], c[2]] };
}
