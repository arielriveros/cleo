import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import {
    MAX_CASCADES,
    buildCascadeMatrix,
    cascadeDepthScale,
    cascadeSphereFromCorners,
    cascadeSphereFromPerspective,
    computeCascadeSplits,
    quantizeRadius,
    snapToTexelGrid,
    spotShadowFar,
    SpotShadowSlots,
} from '../src/graphics/shadowMath';

/**
 * The cascade fit is where shadow mapping fails silently: a sign error makes everything black, and a
 * fit that is not rotation-invariant makes shadow edges crawl as the camera turns. Neither shows up
 * in a code review and both need a running GL context to see — so the math lives in shadowMath.ts,
 * free of any GL call, and gets tested here instead.
 */

describe('computeCascadeSplits', () => {
    it('is monotonically increasing and reaches exactly `far`', () => {
        const splits = computeCascadeSplits(0.1, 500, 4, 0.5);
        expect(splits).toHaveLength(4);
        for (let i = 1; i < splits.length; i++) expect(splits[i]).toBeGreaterThan(splits[i - 1]);
        // Exact, not approximate: a last split a hair short of `far` drops a shell of the world out
        // of every cascade, which reads as a ring of unshadowed geometry at the shadow distance.
        expect(splits[3]).toBe(500);
    });

    it('lambda 0 is exactly uniform', () => {
        const splits = computeCascadeSplits(10, 110, 4, 0);
        expect(splits[0]).toBeCloseTo(35, 6);
        expect(splits[1]).toBeCloseTo(60, 6);
        expect(splits[2]).toBeCloseTo(85, 6);
        expect(splits[3]).toBe(110);
    });

    it('lambda 1 is exactly logarithmic', () => {
        const near = 1, far = 256;
        const splits = computeCascadeSplits(near, far, 4, 1);
        for (let i = 1; i <= 4; i++)
            expect(splits[i - 1]).toBeCloseTo(near * Math.pow(far / near, i / 4), 5);
    });

    it('a single cascade is just [far]', () => {
        expect(computeCascadeSplits(0.1, 80, 1, 0.5)).toEqual([80]);
    });

    it('reuses the output array without leaving stale trailing entries', () => {
        const scratch = new Array(MAX_CASCADES).fill(999);
        const splits = computeCascadeSplits(0.1, 50, 2, 0.5, scratch);
        expect(splits).toBe(scratch);
        expect(splits).toHaveLength(2);
    });
});

describe('cascadeSphereFromPerspective', () => {
    /** World-space corners of a camera sub-frustum, the way the renderer used to compute the fit. */
    function frustumCorners(view: mat4, proj: mat4): vec3[] {
        const invVP = mat4.create();
        mat4.multiply(invVP, proj, view);
        mat4.invert(invVP, invVP);
        const out: vec3[] = [];
        for (let x = 0; x < 2; x++)
            for (let y = 0; y < 2; y++)
                for (let z = 0; z < 2; z++)
                    out.push(vec3.transformMat4(vec3.create(), vec3.fromValues(2 * x - 1, 2 * y - 1, 2 * z - 1), invVP));
        return out;
    }

    const FOV = 60 * Math.PI / 180;
    const ASPECT = 16 / 9;
    const NEAR = 5, FAR = 50;
    const EYE = vec3.fromValues(120, 8, -47);

    function forwardForYaw(yaw: number): vec3 {
        return vec3.fromValues(Math.sin(yaw), 0, -Math.cos(yaw));
    }

    it('the radius does not change when the camera rotates', () => {
        // This is the entire point of the sphere fit. The old light-space AABB grew and shrank as the
        // camera turned (its axes were the LIGHT's, which do not follow the camera), so the texel grid
        // it defined changed size every frame and the snap could not hold shadow edges still.
        const a = cascadeSphereFromPerspective(NEAR, FAR, FOV, ASPECT, EYE, forwardForYaw(0));
        for (const yaw of [0.3, 1.1, Math.PI / 2, 2.7, 5.9]) {
            const b = cascadeSphereFromPerspective(NEAR, FAR, FOV, ASPECT, EYE, forwardForYaw(yaw));
            expect(b.radius).toBeCloseTo(a.radius, 10);
            // The centre moves with the camera, but always by the same distance along the view axis.
            // gl-matrix vec3 is Float32Array, so 4 decimals is the honest precision here.
            expect(vec3.distance(b.center, EYE)).toBeCloseTo(vec3.distance(a.center, EYE), 4);
        }
    });

    it('encloses every corner of the sub-frustum', () => {
        const view = mat4.create();
        mat4.lookAt(view, EYE, vec3.add(vec3.create(), EYE, forwardForYaw(0.8)), [0, 1, 0]);
        const proj = mat4.create();
        mat4.perspective(proj, FOV, ASPECT, NEAR, FAR);

        const sphere = cascadeSphereFromPerspective(NEAR, FAR, FOV, ASPECT, EYE, forwardForYaw(0.8));
        for (const c of frustumCorners(view, proj))
            expect(vec3.distance(c, sphere.center)).toBeLessThanOrEqual(sphere.radius + 1e-4);
    });

    it('falls back to the far cap for a short, wide slice', () => {
        // When the slice is shallow relative to its width the optimal sphere is centred ON the far
        // plane; the general formula would place it beyond and give a needlessly larger radius.
        const sphere = cascadeSphereFromPerspective(48, 50, FOV, ASPECT, [0, 0, 0], [0, 0, -1]);
        expect(sphere.center[2]).toBeCloseTo(-50, 6);
    });
});

describe('cascadeSphereFromCorners', () => {
    it('centres on the box and reaches its corner', () => {
        const corners: number[][] = [];
        for (const x of [-2, 2]) for (const y of [-3, 3]) for (const z of [-6, 6]) corners.push([x, y, z]);
        const s = cascadeSphereFromCorners(corners);
        expect(Array.from(s.center)).toEqual([0, 0, 0]);
        expect(s.radius).toBeCloseTo(Math.sqrt(4 + 9 + 36), 10);
    });
});

describe('texel snapping', () => {
    it('is idempotent', () => {
        const once = snapToTexelGrid(13.37, 0.25);
        expect(snapToTexelGrid(once, 0.25)).toBe(once);
    });

    it('does not move for a sub-texel camera translation', () => {
        // The whole reason the snap exists: a camera creeping forward must not shift the shadow map's
        // sampling grid, or every shadow edge crawls along with it.
        const texel = 0.5;
        const base = snapToTexelGrid(100.0, texel);
        for (const drift of [0.01, 0.1, 0.3, 0.49])
            expect(snapToTexelGrid(100.0 + drift, texel)).toBe(base);
        expect(snapToTexelGrid(100.0 + 0.6, texel)).not.toBe(base);
    });

    it('passes the value through for a degenerate texel size', () => {
        expect(snapToTexelGrid(7.25, 0)).toBe(7.25);
    });

    it('quantizeRadius rounds up onto a fixed ladder', () => {
        expect(quantizeRadius(10.001, 16)).toBeCloseTo(10.0625, 10);
        expect(quantizeRadius(10.0625, 16)).toBeCloseTo(10.0625, 10);
        expect(quantizeRadius(0)).toBe(0);
    });
});

describe('buildCascadeMatrix', () => {
    const scratch = () => ({ view: mat4.create(), proj: mat4.create(), up: vec3.create(), center: vec3.create() });
    const SUN = vec3.normalize(vec3.create(), vec3.fromValues(0.4, -1, 0.3));

    function project(m: mat4, p: vec3): vec3 {
        const v = [p[0], p[1], p[2], 1];
        const out = vec3.create();
        const w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15];
        out[0] = (m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12]) / w;
        out[1] = (m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13]) / w;
        out[2] = (m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]) / w;
        return out;
    }

    it('maps the whole sphere inside the clip cube', () => {
        const sphere = { center: vec3.fromValues(30, 4, -12), radius: 20 };
        const out = mat4.create();
        const fit = buildCascadeMatrix(sphere, SUN, 2048, 50, out, scratch());

        expect(Number.isFinite(out[0])).toBe(true);
        expect(fit.depthRange).toBeGreaterThan(0);
        // Six extreme points of the sphere, which is what the ortho box has to contain.
        for (const axis of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const p = vec3.scaleAndAdd(vec3.create(), sphere.center, axis as vec3, sphere.radius);
            const ndc = project(out, p);
            expect(Math.abs(ndc[0])).toBeLessThanOrEqual(1 + 1e-5);
            expect(Math.abs(ndc[1])).toBeLessThanOrEqual(1 + 1e-5);
            expect(Math.abs(ndc[2])).toBeLessThanOrEqual(1 + 1e-5);
        }
    });

    it('leaves an occluder behind the slice inside the depth range (casterPad)', () => {
        // A wall between the light and the cascade's slice must still rasterize into the map, or it
        // casts nothing at all. That headroom is exactly what casterPad buys.
        const sphere = { center: vec3.fromValues(0, 0, 0), radius: 10 };
        const out = mat4.create();
        buildCascadeMatrix(sphere, SUN, 1024, 40, out, scratch());
        const behind = vec3.scaleAndAdd(vec3.create(), sphere.center, SUN, -35); // 35 units toward the light
        expect(project(out, behind)[2]).toBeGreaterThanOrEqual(-1);
    });

    it('does not go NaN for a light pointing straight down', () => {
        // lookAt with a view direction parallel to the up vector is degenerate; the fit has to pick a
        // different up rather than propagate a zero-length cross product through the whole matrix.
        const out = mat4.create();
        buildCascadeMatrix({ center: vec3.fromValues(3, 9, 2), radius: 12 }, [0, -1, 0], 1024, 20, out, scratch());
        for (let i = 0; i < 16; i++) expect(Number.isFinite(out[i])).toBe(true);
    });

    const R = 16, RES = 1024;
    const TEXEL = (2 * R) / RES;
    /** Footprint origin (the x/y translation of the ortho) for a centre nudged `k` texels along +X. */
    function footprintFor(k: number, snap: boolean): [number, number] {
        const out = mat4.create();
        // Start mid-cell: a centre sitting exactly ON a texel boundary would flip cells on the
        // smallest drift in either direction, which says nothing about whether snapping works.
        const center = vec3.fromValues(TEXEL * (0.5 + k), 0, 0);
        buildCascadeMatrix({ center, radius: R }, SUN, RES, 30, out, scratch(), snap);
        return [out[12], out[13]];
    }

    it('holds the footprint still while the camera creeps by less than a texel', () => {
        const base = footprintFor(0, true);
        for (const drift of [0.1, 0.2, 0.3]) {
            const [x, y] = footprintFor(drift, true);
            expect(x).toBeCloseTo(base[0], 10);
            expect(y).toBeCloseTo(base[1], 10);
        }
    });

    it('snap: false lets the footprint follow the camera continuously', () => {
        // The contrast that proves the snap is doing the work: the same sub-texel drift moves the
        // unsnapped footprint, which is the shadow edges crawling.
        const base = footprintFor(0, false);
        const [x] = footprintFor(0.3, false);
        expect(x).not.toBeCloseTo(base[0], 10);
    });
});

describe('cascadeDepthScale', () => {
    it('makes one world-unit bias mean the same offset in cascades of different depth', () => {
        // Cascade 0 might span 30 world units of depth and cascade 3 six hundred. Without the scale a
        // single bias slider is correct in exactly one of them.
        const worldBias = 0.05;
        for (const range of [30, 120, 600]) {
            const depthUnits = worldBias * cascadeDepthScale(range);
            expect(depthUnits * range).toBeCloseTo(worldBias, 10);
        }
    });

    it('is zero for a degenerate range rather than Infinity', () => {
        expect(cascadeDepthScale(0)).toBe(0);
    });
});

describe('spotShadowFar', () => {
    it('solves the quadratic attenuation for a positive distance', () => {
        const c = 1, l = 0.09, q = 0.032;
        const d = spotShadowFar(c, l, q, 1000);
        expect(d).toBeGreaterThan(0);
        // At that distance the attenuation is the requested 1/256 of full brightness.
        expect(1 / (c + l * d + q * d * d)).toBeCloseTo(1 / 256, 6);
    });

    it('handles pure linear falloff', () => {
        const d = spotShadowFar(1, 0.5, 0, 1000);
        expect(d).toBeCloseTo((256 - 1) / 0.5, 6);
    });

    it('clamps to the global cap when the light never falls off', () => {
        expect(spotShadowFar(1, 0, 0, 250)).toBe(250);
    });

    it('never returns a degenerate far plane', () => {
        expect(spotShadowFar(1e9, 0.09, 0.032, 500)).toBeGreaterThanOrEqual(1);
    });
});

describe('SpotShadowSlots', () => {
    it('keeps a light on its layer when unrelated lights come and go', () => {
        // The trap this class exists for: LightNode.index is a dense compaction over traversal order,
        // so spawning ANY node renumbers the spotlights after it. Keying the atlas by index would hand
        // light B the depth map rendered for light A, one frame after an unrelated node appeared.
        const slots = new SpotShadowSlots(4);
        slots.update(['a', 'b', 'c']);
        const before = { a: slots.layerOf('a'), b: slots.layerOf('b'), c: slots.layerOf('c') };

        slots.update(['z', 'c', 'a', 'b']); // reordered, plus a newcomer
        expect(slots.layerOf('a')).toBe(before.a);
        expect(slots.layerOf('b')).toBe(before.b);
        expect(slots.layerOf('c')).toBe(before.c);
        expect(slots.layerOf('z')).toBe(3);
    });

    it('reuses a freed layer without moving anyone else', () => {
        const slots = new SpotShadowSlots(4);
        slots.update(['a', 'b', 'c', 'd']);
        const kept = { a: slots.layerOf('a'), c: slots.layerOf('c'), d: slots.layerOf('d') };
        const freed = slots.layerOf('b');

        slots.update(['a', 'c', 'd', 'e']);
        expect(slots.layerOf('b')).toBe(-1);
        expect(slots.layerOf('e')).toBe(freed);
        expect(slots.layerOf('a')).toBe(kept.a);
        expect(slots.layerOf('c')).toBe(kept.c);
        expect(slots.layerOf('d')).toBe(kept.d);
    });

    it('gives casters past capacity no layer instead of overwriting one', () => {
        const slots = new SpotShadowSlots(2);
        slots.update(['a', 'b', 'c']);
        expect(slots.layerOf('a')).toBe(0);
        expect(slots.layerOf('b')).toBe(1);
        expect(slots.layerOf('c')).toBe(-1);
    });

    it('drops out-of-range assignments when the capacity shrinks', () => {
        const slots = new SpotShadowSlots(4);
        slots.update(['a', 'b', 'c', 'd']);
        slots.capacity = 2;
        expect(slots.layerOf('c')).toBe(-1);
        expect(slots.layerOf('d')).toBe(-1);
        expect(slots.layerOf('a')).toBe(0);
    });
});
