import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
    EYE_FIT_MARGIN,
    ShadowLayerCache,
    TerrainFloorGrid,
    cascadeSphereAroundEye,
    isFreeShadowSlot,
    receiverInnerRadius,
    shadowFarthestFrom,
    shadowReach,
    shadowTouchesSphere,
    sliceCornerFactor,
    staggeredCascadeDue,
} from '../src/graphics/shadowCasters';
import { MAX_CASTER_REACH, cascadeSphereFromPerspective, staleCascadeCovers } from '../src/graphics/shadowMath';

const FOV = 73 * Math.PI / 180;
const ASPECT = 16 / 9;
/** The Valley sun: the direction the light travels. */
const SUN = vec3.normalize(vec3.create(), vec3.fromValues(0.32, -0.62, -0.72));

/** World-space corners of the camera slice [near, far] for a camera at `eye` looking along `fwd`. */
function sliceCorners(eye: vec3, fwd: vec3, near: number, far: number): vec3[] {
    const up0 = Math.abs(fwd[1]) > 0.99 ? vec3.fromValues(0, 0, 1) : vec3.fromValues(0, 1, 0);
    const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), fwd, up0));
    const up = vec3.cross(vec3.create(), right, fwd);
    const t = Math.tan(FOV / 2);
    const out: vec3[] = [];
    for (const d of [near, far])
        for (const sx of [-1, 1])
            for (const sy of [-1, 1]) {
                const p = vec3.scaleAndAdd(vec3.create(), eye, fwd, d);
                vec3.scaleAndAdd(p, p, right, sx * d * t * ASPECT);
                vec3.scaleAndAdd(p, p, up, sy * d * t);
                out.push(p);
            }
    return out;
}

function randomUnit(rand: () => number): vec3 {
    for (;;) {
        const v = vec3.fromValues(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
        const l = vec3.length(v);
        if (l > 0.1 && l <= 1) return vec3.scale(v, v, 1 / l);
    }
}

function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = Math.imul(s, 1664525) + 1013904223 >>> 0) / 4294967296);
}

describe('cascadeSphereAroundEye', () => {
    it('contains the whole slice [0, far] for any view direction', () => {
        const rand = lcg(7);
        const eye = vec3.fromValues(12, 40, -7);
        const s = cascadeSphereAroundEye(68.3, FOV, ASPECT, eye, { center: vec3.create(), radius: 0 });
        for (let i = 0; i < 50; i++) {
            const fwd = randomUnit(rand);
            for (const c of sliceCorners(eye, fwd, 0.1, 68.3))
                // vec3 is Float32Array: allow its rounding, nothing more.
                expect(vec3.distance(c, s.center)).toBeLessThanOrEqual(s.radius * (1 + 1e-5));
        }
    });

    it('does not move or grow when the camera turns', () => {
        const eye = vec3.fromValues(1, 2, 3);
        const a = cascadeSphereAroundEye(39.5, FOV, ASPECT, eye, { center: vec3.create(), radius: 0 });
        const b = cascadeSphereAroundEye(39.5, FOV, ASPECT, eye, { center: vec3.create(), radius: 0 });
        expect(Array.from(a.center)).toEqual(Array.from(b.center));
        expect(a.radius).toBe(b.radius);
        // A stale fit (with its margin) still covers itself after any turn, which the forward-biased fit
        // of the same slice does not survive past a few degrees.
        const old = { center: vec3.clone(a.center), radius: a.radius * (1 + EYE_FIT_MARGIN) };
        expect(staleCascadeCovers(old, a)).toBe(true);
    });

    it('costs about a fifth more radius than the forward-biased fit of the same slice', () => {
        const f = cascadeSphereFromPerspective(19.1, 39.5, FOV, ASPECT, [0, 0, 0], [0, 0, -1]);
        const e = cascadeSphereAroundEye(39.5, FOV, ASPECT, [0, 0, 0], { center: vec3.create(), radius: 0 });
        expect(e.radius / f.radius).toBeGreaterThan(1.1);
        expect(e.radius / f.radius).toBeLessThan(1.3);
        expect(e.radius).toBeCloseTo(39.5 * sliceCornerFactor(FOV, ASPECT), 9);
    });
});

describe('staggeredCascadeDue', () => {
    it('renders cascade i every 2^i frames and never two staggered cascades on one frame', () => {
        const counts = [0, 0, 0, 0];
        for (let f = 0; f < 64; f++) {
            let staggered = 0;
            for (let i = 0; i < 4; i++) if (staggeredCascadeDue(i, f)) { counts[i]++; if (i > 0) staggered++; }
            expect(staggered).toBeLessThanOrEqual(1);
            // The free slot is exactly the frames no staggered cascade takes.
            expect(isFreeShadowSlot(f, 4)).toBe(staggered === 0);
        }
        expect(counts).toEqual([64, 32, 16, 8]);
    });

    it('keeps the period for fewer cascades, and handles negative frames', () => {
        for (let f = 0; f < 16; f++) {
            const any = staggeredCascadeDue(1, f) || staggeredCascadeDue(2, f);
            expect(isFreeShadowSlot(f, 3)).toBe(!any);
        }
        expect(isFreeShadowSlot(5, 1)).toBe(true);
        expect(staggeredCascadeDue(1, -1)).toBe(true);
    });
});

describe('shadowReach', () => {
    it('runs from the top of the sphere to the receiver floor along the light', () => {
        const L = shadowReach(10, 2, 0, SUN[1]);
        expect(L).toBeCloseTo(12 / -SUN[1], 9);
    });

    it('is the caster cap for a sun at or below the horizon', () => {
        expect(shadowReach(10, 2, 0, 0)).toBe(MAX_CASTER_REACH);
        expect(shadowReach(10, 2, 0, 0.3)).toBe(MAX_CASTER_REACH);
    });

    it('is zero for a caster wholly below the floor', () => {
        expect(shadowReach(-10, 2, 0, SUN[1])).toBe(0);
    });
});

describe('shadow volume tests', () => {
    it('keeps a floating cube whose shadow lands on a non-casting ground plane', () => {
        // Cube at 10 m over a plane at y = 0 that casts nothing: the floor must come from the plane
        // (every visible model), not from the casters alone, or the cube's shadow would be cut short.
        const cube = { c: vec3.fromValues(0, 10, 0), r: 0.9 };
        const reach = shadowReach(cube.c[1], cube.r, 0, SUN[1]);
        const landing = vec3.scaleAndAdd(vec3.create(), cube.c, SUN, (cube.c[1]) / -SUN[1]);
        // A cascade sphere around where the shadow lands, but nowhere near the cube itself.
        const cascade = { center: landing, radius: 2 };
        expect(vec3.distance(cube.c, landing)).toBeGreaterThan(cube.r + cascade.radius);
        expect(shadowTouchesSphere(cube.c[0], cube.c[1], cube.c[2], cube.r, SUN, reach, cascade)).toBe(true);
        // With the floor wrongly taken as the cube's own bottom, the volume stops short of the ground.
        const short = shadowReach(cube.c[1], cube.r, cube.c[1] - cube.r, SUN[1]);
        expect(shadowTouchesSphere(cube.c[0], cube.c[1], cube.c[2], cube.r, SUN, short, cascade)).toBe(false);
    });

    it('drops a low caster far up-sun whose shadow cannot reach the cascade', () => {
        // A 20 m-high chunk 1500 m up-sun: its shadow lands ~40 m downstream, far short of the cascade.
        const up = vec3.scale(vec3.create(), SUN, -1);
        const horiz = vec3.normalize(vec3.create(), vec3.fromValues(up[0], 0, up[2]));
        const c = vec3.scale(vec3.create(), horiz, 1500);
        c[1] = 10;
        const reach = shadowReach(c[1], 10, 0, SUN[1]);
        const cascade = { center: vec3.fromValues(0, 0, 0), radius: 250 };
        expect(shadowTouchesSphere(c[0], c[1], c[2], 10, SUN, reach, cascade)).toBe(false);
        // A 430 m peak at the same spot does reach it.
        const peak = shadowReach(400, 40, 0, SUN[1]);
        const pc = vec3.scale(vec3.create(), horiz, 600);
        pc[1] = 400;
        expect(shadowTouchesSphere(pc[0], pc[1], pc[2], 40, SUN, peak, cascade)).toBe(true);
    });

    it('measures the far end of the volume from the eye', () => {
        const eye = vec3.fromValues(0, 1.7, 0);
        const reach = 10;
        const far = shadowFarthestFrom(0, 1, -3, 0.5, SUN, reach, eye);
        const end = vec3.scaleAndAdd(vec3.create(), vec3.fromValues(0, 1, -3), SUN, reach);
        expect(far).toBeCloseTo(Math.max(vec3.distance(end, eye), vec3.distance([0, 1, -3], eye)) + 0.5, 5);
    });
});

describe('receiverInnerRadius', () => {
    const splits = [19.1, 39.5, 68.3, 150];

    it('is zero for cascade 0', () => {
        expect(receiverInnerRadius(splits, 0, 0.1, 5)).toBe(0);
    });

    it('is the previous split less the blend band reaching back into it and the travel margin', () => {
        expect(receiverInnerRadius(splits, 1, 0.1, 0)).toBeCloseTo(19.1 - 0.1 * 19.1, 9);
        expect(receiverInnerRadius(splits, 3, 0.1, 2)).toBeCloseTo(68.3 - 0.1 * (68.3 - 39.5) - 2, 9);
        expect(receiverInnerRadius(splits, 2, 0, 100)).toBe(0);
    });

    it('drops the player beside the camera from the outer cascades only', () => {
        const eye = vec3.fromValues(0, 3, 4);
        const player = { c: vec3.fromValues(0, 0.9, 0), r: 1.1 };
        const reach = shadowReach(player.c[1], player.r, 0, SUN[1]);
        const far = shadowFarthestFrom(player.c[0], player.c[1], player.c[2], player.r, SUN, reach, eye);
        expect(far).toBeGreaterThanOrEqual(receiverInnerRadius(splits, 0, 0.1, 0));
        for (let i = 1; i < 4; i++) expect(far).toBeLessThan(receiverInnerRadius(splits, i, 0.1, 2));
    });
});

describe('ShadowLayerCache', () => {
    it('says changed the first time, unchanged for the same hash, changed for a new one', () => {
        const cache = new ShadowLayerCache(5);
        expect(cache.changed(2, 123)).toBe(true);
        expect(cache.changed(2, 123)).toBe(false);
        expect(cache.changed(2, 124)).toBe(true);
        expect(cache.changed(2, 124)).toBe(false);
        // Layers are independent.
        expect(cache.changed(3, 124)).toBe(true);
    });

    it('forgets layers when invalidated, and treats out-of-range layers as always changed', () => {
        const cache = new ShadowLayerCache(2);
        cache.changed(0, 1); cache.changed(1, 1);
        cache.invalidate(0);
        expect(cache.changed(0, 1)).toBe(true);
        expect(cache.changed(1, 1)).toBe(false);
        cache.invalidateAll();
        expect(cache.changed(1, 1)).toBe(true);
        expect(cache.changed(7, 1)).toBe(true);
        expect(cache.changed(7, 1)).toBe(true);
    });

    it('compares hashes as unsigned', () => {
        const cache = new ShadowLayerCache(1);
        cache.changed(0, -1);
        expect(cache.changed(0, 0xffffffff)).toBe(false);
    });
});

describe('TerrainFloorGrid', () => {
    // 4 x 3 cells of 10 m from (-20, -15): a valley floor at 0, one deep cell at -30, high ground at 50.
    const grid = new TerrainFloorGrid();
    const minY = [50, 50, 50, 50,
                  50, 0, 0, 50,
                  50, -30, 50, 50];
    grid.set(-20, -15, 10, 4, 3, minY);

    it('knows its lowest ground', () => {
        expect(grid.lowest).toBe(-30);
    });

    it('takes the lowest ground under the box around the path, grown by the pad', () => {
        // A path inside the middle row: the valley floor.
        expect(grid.floorAlong(-5, 0, 5, 0, 0.5)).toBe(0);
        // Grown into the deep cell below it.
        expect(grid.floorAlong(-5, 0, 5, 0, 6)).toBe(-30);
        // Wholly over high ground.
        expect(grid.floorAlong(-18, -12, -12, -12, 1)).toBe(50);
    });

    it('answers NaN when the path leaves the grid, so the caller falls back to the scene floor', () => {
        expect(grid.floorAlong(0, 0, 100, 0, 1)).toBeNaN();
        expect(grid.floorAlong(-25, 0, -5, 0, 0)).toBeNaN();
    });

    it('ends a shadow on the valley floor under it, not at the deepest point anywhere', () => {
        // 200 m of valley floor at 0, with one deep cell in a far corner setting the scene's lowest point.
        const valley = new TerrainFloorGrid();
        const cells = new Array(400).fill(0);
        cells[0] = -30;
        valley.set(-100, -100, 10, 20, 20, cells);
        expect(valley.lowest).toBe(-30);
        // A short caster in the middle: even run down to -30, its path stays over the floor.
        const longest = shadowReach(1.5, 0.5, valley.lowest, SUN[1]);
        const ground = valley.floorAlong(0, 0, SUN[0] * longest, SUN[2] * longest, 0.5);
        expect(ground).toBe(0);
        expect(shadowReach(1.5, 0.5, ground, SUN[1])).toBeLessThan(longest / 10);
    });
});
