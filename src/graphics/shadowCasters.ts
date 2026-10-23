import { vec3 } from 'gl-matrix';
import { MAX_CASTER_REACH, type CascadeSphere } from './shadowMath';

// Which casters a shadow layer needs, and whether a layer would come out the same as last time. Pure
// functions over numbers, like shadowMath.ts; the renderer owns the caster list and the layers.
//
// A caster only matters to a cascade if its shadow can land on a pixel that cascade shades. Two tests
// decide that, both on the caster's SHADOW VOLUME rather than on the caster: the sphere swept along the
// light until it falls below the lowest receiver, a capsule (see `shadowReach`).
//
//  - The capsule must touch the cascade's sphere. The light-space box alone keeps everything up-sun of
//    the footprint out to the 20 km caster reach — on a heightfield that is a strip of terrain chunks
//    the full length of the map, most of them far too low to shadow anything the cascade covers.
//  - Its farthest point from the camera must reach the cascade's RECEIVER SHELL. Pixels closer than the
//    previous split are shaded by a finer cascade (`cleoCascadeCovering` in chunks/shadows.wgsl), so a
//    caster whose whole shadow lies inside that radius — the player, standing beside the camera — draws
//    into cascade 0 and nowhere else.

/** Margin of a camera-centred staggered cascade: it only has to outlast the camera's TRAVEL, not a turn. */
export const EYE_FIT_MARGIN = 0.05;

/**
 * Bounding sphere of the camera sub-frustum [0, far], centred on the eye. Unlike
 * `cascadeSphereFromPerspective` it does not move when the camera turns, so a staggered cascade fit this
 * way stays valid through any amount of mouse-look and only re-renders off its turn once the camera has
 * TRAVELLED its margin. The price is resolution: the radius is the distance to the slice's far corner,
 * `far * sqrt(1 + t^2 (1 + aspect^2))`, about 1.2x the forward-biased fit of the same slice.
 */
export function cascadeSphereAroundEye(far: number, fovYRadians: number, aspect: number,
                                       camPos: ArrayLike<number>, out: CascadeSphere): CascadeSphere {
    const t = Math.tan(fovYRadians * 0.5);
    out.center[0] = camPos[0]; out.center[1] = camPos[1]; out.center[2] = camPos[2];
    out.radius = far * Math.sqrt(1 + t * t * (1 + aspect * aspect));
    return out;
}

/** How much farther than its far split a slice's farthest pixel can be from the eye (its corner). */
export function sliceCornerFactor(fovYRadians: number, aspect: number): number {
    const t = Math.tan(fovYRadians * 0.5);
    return Math.sqrt(1 + t * t * (1 + aspect * aspect));
}

/**
 * Is staggered cascade `cascade` due on `frame`? Cascade i >= 1 renders every 2^i frames, and the phases
 * are OFFSET (frame % 2^i == 2^(i-1)) so no frame renders two of them: 1 on odd frames, 2 on frames 2
 * and 6 of every 8, 3 on frame 4. With the phases aligned, every 8th frame rendered all of them at once.
 * Cascade 0 is always due.
 */
export function staggeredCascadeDue(cascade: number, frame: number): boolean {
    if (cascade <= 0) return true;
    const period = 2 ** cascade;
    const phase = ((frame % period) + period) % period;
    return phase === period / 2;
}

/**
 * The frames no staggered cascade takes (frame % 2^(count-1) == 0), where the far layer refreshes when
 * it only needs to, so its cost never stacks on top of another cascade's.
 */
export function isFreeShadowSlot(frame: number, cascadeCount: number): boolean {
    const period = 2 ** Math.max(0, cascadeCount - 1);
    return ((frame % period) + period) % period === 0;
}

/**
 * How far along the light a caster's shadow can travel before it falls below every receiver: from the
 * top of its sphere down to `receiverFloorY`, the lowest point anything visible can be shaded at. A sun at
 * or below the horizon has no floor, so the reach is the caster cap. `lightDirY` is the y of the unit
 * direction the light TRAVELS.
 */
export function shadowReach(centerY: number, radius: number, receiverFloorY: number, lightDirY: number): number {
    if (!(lightDirY < -1e-3)) return MAX_CASTER_REACH;
    return Math.min(MAX_CASTER_REACH, Math.max(0, (centerY + radius - receiverFloorY) / -lightDirY));
}

/**
 * The lowest ground under a shadow's path, from a landscape's chunk height ranges. A shadow cast over a
 * heightfield ends where it meets the ground, and the ground under a caster is usually far above the lowest
 * point anything in the scene is shaded at — a pond, a cellar, the valley's far end — which is what the
 * reach would otherwise have to run down to. Receivers BELOW the terrain need not count: the terrain over
 * them casts too.
 */
export class TerrainFloorGrid {
    private _minX = 0;
    private _minZ = 0;
    private _cell = 1;
    private _cols = 0;
    private _rows = 0;
    private _minY: Float32Array = new Float32Array(0);
    /** The lowest ground anywhere on the grid. */
    public lowest = Infinity;

    /**
     * Describe the grid: `cols` x `rows` cells of `cell` world units from (`minX`, `minZ`), the lowest
     * ground in cell (c, r) at `minY[r * cols + c]` in world units.
     */
    public set(minX: number, minZ: number, cell: number, cols: number, rows: number, minY: ArrayLike<number>): void {
        this._minX = minX; this._minZ = minZ; this._cell = Math.max(1e-6, cell);
        this._cols = cols; this._rows = rows;
        if (this._minY.length !== cols * rows) this._minY = new Float32Array(cols * rows);
        let lowest = Infinity;
        for (let i = 0; i < cols * rows; i++) { this._minY[i] = minY[i]; if (minY[i] < lowest) lowest = minY[i]; }
        this.lowest = lowest;
    }

    /**
     * The lowest ground under the XZ box around the segment (ax, az)-(bx, bz) grown by `pad`, or NaN when
     * part of that box lies off the grid (nothing is known there, so the caller falls back to the scene's
     * lowest receiver).
     */
    public floorAlong(ax: number, az: number, bx: number, bz: number, pad: number): number {
        const x0 = Math.min(ax, bx) - pad, x1 = Math.max(ax, bx) + pad;
        const z0 = Math.min(az, bz) - pad, z1 = Math.max(az, bz) + pad;
        const c0 = Math.floor((x0 - this._minX) / this._cell), c1 = Math.floor((x1 - this._minX) / this._cell);
        const r0 = Math.floor((z0 - this._minZ) / this._cell), r1 = Math.floor((z1 - this._minZ) / this._cell);
        if (c0 < 0 || r0 < 0 || c1 >= this._cols || r1 >= this._rows) return NaN;
        let floor = Infinity;
        for (let r = r0; r <= r1; r++)
            for (let c = c0; c <= c1; c++) {
                const y = this._minY[r * this._cols + c];
                if (y < floor) floor = y;
            }
        return floor;
    }
}

/** Squared distance from `q` to the segment from `a` along the unit direction `d` for `length`. */
function segmentDistanceSq(ax: number, ay: number, az: number, dx: number, dy: number, dz: number,
                           length: number, qx: number, qy: number, qz: number): number {
    const px = qx - ax, py = qy - ay, pz = qz - az;
    let t = px * dx + py * dy + pz * dz;
    if (t < 0) t = 0; else if (t > length) t = length;
    const ex = px - dx * t, ey = py - dy * t, ez = pz - dz * t;
    return ex * ex + ey * ey + ez * ez;
}

/**
 * Does the shadow volume of a caster (sphere `c`, `r`, swept `reach` along the unit light direction `d`)
 * touch `sphere`?
 */
export function shadowTouchesSphere(cx: number, cy: number, cz: number, r: number, d: ArrayLike<number>,
                                    reach: number, sphere: CascadeSphere): boolean {
    const s = sphere.center, R = r + sphere.radius;
    return segmentDistanceSq(cx, cy, cz, d[0], d[1], d[2], reach, s[0], s[1], s[2]) <= R * R;
}

/**
 * The farthest any point of a caster's shadow volume lies from `eye`. Distance is convex, so it is an
 * end of the swept segment, plus the radius.
 */
export function shadowFarthestFrom(cx: number, cy: number, cz: number, r: number, d: ArrayLike<number>,
                                   reach: number, eye: ArrayLike<number>): number {
    const ax = cx - eye[0], ay = cy - eye[1], az = cz - eye[2];
    const bx = ax + d[0] * reach, by = ay + d[1] * reach, bz = az + d[2] * reach;
    return Math.sqrt(Math.max(ax * ax + ay * ay + az * az, bx * bx + by * by + bz * bz)) + r;
}

/**
 * The receiver shell's inner radius for cascade `cascade`: no pixel this cascade shades is nearer the
 * eye than this. Pixels are picked by view depth, which never exceeds distance, so the bound is the
 * previous split less the blend band reaching back into it (`directionalShadow` cross-fades the last
 * `blend` of each cascade's own range into the next) and less `travel`, how far the camera may move
 * while the layer is reused. Cascade 0 has no inner radius.
 */
export function receiverInnerRadius(splits: ArrayLike<number>, cascade: number, blend: number, travel: number): number {
    if (cascade <= 0) return 0;
    const prev = splits[cascade - 1];
    const prevNear = cascade >= 2 ? splits[cascade - 2] : 0;
    return Math.max(0, prev - Math.max(0, blend) * (prev - prevNear) - Math.max(0, travel));
}

/**
 * Remembers the content signature each shadow layer was last rasterized with, so a layer that would
 * come out identical — same matrix, same casters in the same places, same foliage — is left as it is.
 * The point-light cache's idea (`PointShadowCache` in shadowMath.ts), generalised to the cascades.
 */
export class ShadowLayerCache {
    private readonly _hash: Uint32Array;
    private readonly _valid: Uint8Array;

    constructor(layers: number) {
        this._hash = new Uint32Array(Math.max(0, layers));
        this._valid = new Uint8Array(Math.max(0, layers));
    }

    public get layers(): number { return this._hash.length; }

    /** Must layer `layer` be drawn for `hash`? Records it when so: call once per layer per frame. */
    public changed(layer: number, hash: number): boolean {
        if (layer < 0 || layer >= this._hash.length) return true;
        const h = hash >>> 0;
        if (this._valid[layer] && this._hash[layer] === h) return false;
        this._valid[layer] = 1;
        this._hash[layer] = h;
        return true;
    }

    /** Forget one layer — it was skipped by the stagger with a new matrix, or its storage was lost. */
    public invalidate(layer: number): void {
        if (layer >= 0 && layer < this._valid.length) this._valid[layer] = 0;
    }

    /** Forget every layer. Required after a reallocation: fresh depth storage is undefined. */
    public invalidateAll(): void { this._valid.fill(0); }
}

/** Unit vector, for callers holding a light direction that may not be normalised. */
export function unitDirection(d: ArrayLike<number>, out: vec3): vec3 {
    vec3.set(out, d[0], d[1], d[2]);
    return vec3.normalize(out, out);
}
