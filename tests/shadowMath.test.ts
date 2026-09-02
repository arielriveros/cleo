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
    MAX_POINT_SHADOWS,
    POINT_SHADOW_FACES,
    PointShadowCache,
    cubeFaceIndex,
    pointShadowFov,
    HASH_SEED,
    mixNumber,
    mixString,
    mixTransform,
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
    // The 1/256 quadratic solve this used to do moved to `graphics/lighting.ts` as `legacyRange`,
    // where the migration needs it; a light carries a real range now. The two must agree, which
    // `tests/lightMigration.test.ts` asserts — otherwise a migrated spot's shadow frustum ends
    // somewhere other than its light.
    it('is the light range, capped by the renderer distance', () => {
        expect(spotShadowFar(40, 1000)).toBe(40);
        expect(spotShadowFar(400, 250)).toBe(250);
    });

    it('never returns a degenerate far plane', () => {
        expect(spotShadowFar(0.2, 500)).toBe(1);
        expect(spotShadowFar(0, 500)).toBe(500);
        expect(spotShadowFar(NaN, 500)).toBe(500);
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

// ---------------------------------------------------------------------------------------------
// Point-light (cube) shadow maps.
// ---------------------------------------------------------------------------------------------

/** The six face view-projections exactly as `Renderer._renderPointShadows` builds them. */
function buildFaceMatrices(lightPos: vec3, near: number, far: number, fov: number): mat4[] {
    return POINT_SHADOW_FACES.map(face => {
        const view = mat4.create();
        const proj = mat4.create();
        const target = vec3.add(vec3.create(), lightPos, face.dir);
        mat4.lookAt(view, lightPos, target, face.up);
        mat4.perspective(proj, fov, 1, near, far);
        return mat4.multiply(mat4.create(), proj, view);
    });
}

describe('cubeFaceIndex', () => {
    it('picks the face each axis points at', () => {
        expect(cubeFaceIndex( 1,  0,  0)).toBe(0);
        expect(cubeFaceIndex(-1,  0,  0)).toBe(1);
        expect(cubeFaceIndex( 0,  1,  0)).toBe(2);
        expect(cubeFaceIndex( 0, -1,  0)).toBe(3);
        expect(cubeFaceIndex( 0,  0,  1)).toBe(4);
        expect(cubeFaceIndex( 0,  0, -1)).toBe(5);
    });

    it('agrees with the direction POINT_SHADOW_FACES rasterizes at that index', () => {
        // The contract the whole atlas rests on: the CPU rasterizes face i looking down
        // POINT_SHADOW_FACES[i].dir, and the shader picks index i for that direction. Disagree and
        // a fragment samples the neighbouring face, which looks like a torn shadow, not an index bug.
        POINT_SHADOW_FACES.forEach((face, i) => {
            expect(cubeFaceIndex(face.dir[0], face.dir[1], face.dir[2])).toBe(i);
        });
    });

    it('resolves ties toward the earlier axis, matching cleoCubeFace', () => {
        // A direction exactly on a cube edge or corner has no single major axis. Any choice works so
        // long as BOTH sides make it — these pin down which one, so the WGSL cannot drift.
        expect(cubeFaceIndex(1, 1, 0)).toBe(0);   // X ties Y -> X
        expect(cubeFaceIndex(0, 1, 1)).toBe(2);   // Y ties Z -> Y
        expect(cubeFaceIndex(1, 1, 1)).toBe(0);   // corner -> X
        expect(cubeFaceIndex(-1, -1, -1)).toBe(1);
    });

    it('treats an exact zero direction as a negative face rather than returning garbage', () => {
        // A fragment exactly at the light. `> 0.0` is false, so it lands on -X; what matters is that
        // it is a VALID layer index, because it will be used to index the atlas either way.
        const face = cubeFaceIndex(0, 0, 0);
        expect(face).toBeGreaterThanOrEqual(0);
        expect(face).toBeLessThan(6);
    });
});

describe('POINT_SHADOW_FACES', () => {
    it('has six orthonormal frames', () => {
        expect(POINT_SHADOW_FACES).toHaveLength(6);
        for (const face of POINT_SHADOW_FACES) {
            expect(vec3.length(face.dir)).toBeCloseTo(1, 12);
            expect(vec3.length(face.up)).toBeCloseTo(1, 12);
            // Parallel up and dir is what makes lookAt produce NaN.
            expect(Math.abs(vec3.dot(face.dir, face.up))).toBeLessThan(1e-12);
        }
    });

    it('covers all six axes exactly once', () => {
        const seen = new Set(POINT_SHADOW_FACES.map(f => `${f.dir[0]},${f.dir[1]},${f.dir[2]}`));
        expect(seen.size).toBe(6);
    });

    it('produces PROPER rotations, so front-face culling keeps its meaning', () => {
        // The reason this table is not Renderer._CUBE_FACES. That one is the OpenGL cubemap
        // convention, whose left-handed basis gives lookAt a determinant of -1 — a mirrored view,
        // which swaps which triangles rasterize as front-facing. The shadow pass culls FRONT faces
        // to push acne out of sight, so a mirrored frame would cull the visible half of every caster
        // and the shadows would come out inside-out. det = +1 is that bug's tripwire.
        for (const face of POINT_SHADOW_FACES) {
            const view = mat4.lookAt(mat4.create(), [0, 0, 0], face.dir, face.up);
            const det = view[0] * (view[5] * view[10] - view[6] * view[9])
                      - view[1] * (view[4] * view[10] - view[6] * view[8])
                      + view[2] * (view[4] * view[9] - view[5] * view[8]);
            expect(det).toBeCloseTo(1, 12);
        }
    });
});

describe('pointShadowFov', () => {
    it('is exactly 90 degrees with no border', () => {
        // Six 90-degree faces tile the cube exactly; the widening is purely the filter's margin.
        expect(pointShadowFov(512, 0)).toBeCloseTo(Math.PI / 2, 12);
    });

    it('widens with the border and narrows with resolution', () => {
        expect(pointShadowFov(512, 2)).toBeGreaterThan(Math.PI / 2);
        // More texels to spare means less angle spent on the same border.
        expect(pointShadowFov(1024, 2)).toBeLessThan(pointShadowFov(512, 2));
        expect(pointShadowFov(512, 4)).toBeGreaterThan(pointShadowFov(512, 2));
    });

    it('stays a sane angle for a degenerate map', () => {
        const fov = pointShadowFov(1, 10000);
        expect(fov).toBeLessThan(Math.PI);
        expect(Number.isFinite(fov)).toBe(true);
    });
});

describe('cube face coverage', () => {
    it('projects every direction inside the face cubeFaceIndex selects', () => {
        // The end-to-end statement the atlas depends on, checked without a GL context: rasterize
        // with POINT_SHADOW_FACES[i], select with cubeFaceIndex, and the sample lands on the map.
        const lightPos = vec3.fromValues(3, -2, 7);
        const faces = buildFaceMatrices(lightPos, 0.05, 40, pointShadowFov(512, 2));

        // A deterministic spiral over the sphere — no RNG, so a failure is reproducible.
        const N = 2000;
        for (let k = 0; k < N; k++) {
            const y = 1 - (2 * k + 1) / N;
            const r = Math.sqrt(Math.max(0, 1 - y * y));
            const theta = k * Math.PI * (3 - Math.sqrt(5));
            const dir = vec3.fromValues(Math.cos(theta) * r, y, Math.sin(theta) * r);

            const world = vec3.scaleAndAdd(vec3.create(), lightPos, dir, 10);
            const face = cubeFaceIndex(dir[0], dir[1], dir[2]);
            const clip = vec3.create();
            const p = [world[0], world[1], world[2], 1] as [number, number, number, number];
            const m = faces[face];
            const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
            clip[0] = (m[0] * p[0] + m[4] * p[1] + m[8]  * p[2] + m[12]) / cw;
            clip[1] = (m[1] * p[0] + m[5] * p[1] + m[9]  * p[2] + m[13]) / cw;

            // In front of the light, and inside the face.
            expect(cw).toBeGreaterThan(0);
            expect(Math.abs(clip[0])).toBeLessThanOrEqual(1);
            expect(Math.abs(clip[1])).toBeLessThanOrEqual(1);
        }
    });

    it('leaves a real border for the PCF kernel at every face edge', () => {
        // The seam fix, stated as a measurement. A direction exactly on a cube edge must land
        // strictly INSIDE its face by at least the border the kernel will reach for.
        const res = 512, border = 2;
        const faces = buildFaceMatrices(vec3.create(), 0.05, 40, pointShadowFov(res, border));
        const edge = vec3.normalize(vec3.create(), vec3.fromValues(1, 1, 0));
        const world = vec3.scale(vec3.create(), edge, 10);
        const m = faces[cubeFaceIndex(edge[0], edge[1], edge[2])];
        const cw = m[3] * world[0] + m[7] * world[1] + m[11] * world[2] + m[15];
        const ndcY = (m[1] * world[0] + m[5] * world[1] + m[9] * world[2] + m[13]) / cw;
        // Convert the shortfall from the edge into texels; it must cover the kernel's reach.
        const texelsInside = (1 - Math.abs(ndcY)) * 0.5 * res;
        expect(texelsInside).toBeGreaterThanOrEqual(border);
    });
});

describe('PointShadowCache', () => {
    const pos = vec3.fromValues(1, 2, 3);

    it('reports the first look at a slot as stale, then clean', () => {
        const cache = new PointShadowCache(MAX_POINT_SHADOWS);
        expect(cache.needsUpdate(0, pos, 20, 1234)).toBe(true);
        expect(cache.needsUpdate(0, pos, 20, 1234)).toBe(false);
    });

    it('notices a moved light, a changed range, and a moved caster', () => {
        const cache = new PointShadowCache(MAX_POINT_SHADOWS);
        cache.needsUpdate(0, pos, 20, 1234);
        expect(cache.needsUpdate(0, vec3.fromValues(1, 2, 3.5), 20, 1234)).toBe(true);
        expect(cache.needsUpdate(0, vec3.fromValues(1, 2, 3.5), 25, 1234)).toBe(true);
        expect(cache.needsUpdate(0, vec3.fromValues(1, 2, 3.5), 25, 9999)).toBe(true);
        expect(cache.needsUpdate(0, vec3.fromValues(1, 2, 3.5), 25, 9999)).toBe(false);
    });

    it('keeps slots independent', () => {
        const cache = new PointShadowCache(MAX_POINT_SHADOWS);
        cache.needsUpdate(0, pos, 20, 1);
        expect(cache.needsUpdate(1, pos, 20, 1)).toBe(true);
        expect(cache.needsUpdate(0, pos, 20, 1)).toBe(false);
    });

    it('re-renders after release and after invalidateAll', () => {
        const cache = new PointShadowCache(MAX_POINT_SHADOWS);
        cache.needsUpdate(2, pos, 20, 1);
        cache.release(2);
        expect(cache.needsUpdate(2, pos, 20, 1)).toBe(true);

        cache.needsUpdate(0, pos, 20, 1);
        cache.invalidateAll();
        // A reallocation leaves undefined depth in the new storage; every slot must redraw.
        expect(cache.needsUpdate(0, pos, 20, 1)).toBe(true);
        expect(cache.needsUpdate(2, pos, 20, 1)).toBe(true);
    });

    it('answers "stale" for a slot it does not hold', () => {
        const cache = new PointShadowCache(MAX_POINT_SHADOWS);
        expect(cache.needsUpdate(-1, pos, 20, 1)).toBe(true);
        expect(cache.needsUpdate(MAX_POINT_SHADOWS, pos, 20, 1)).toBe(true);
    });
});

describe('caster hashing', () => {
    it('separates transforms that differ below any sensible epsilon', () => {
        // The reason the mix goes over the f32 BIT PATTERN rather than the value: a caster nudged by
        // a thousandth still moves its shadow edge across a 512-texel face.
        const a = mat4.create();
        const b = mat4.fromTranslation(mat4.create(), [0.001, 0, 0]);
        expect(mixTransform(HASH_SEED, a)).not.toBe(mixTransform(HASH_SEED, b));
    });

    it('is stable for an unchanged transform', () => {
        const m = mat4.fromTranslation(mat4.create(), [4, 5, 6]);
        expect(mixTransform(HASH_SEED, m)).toBe(mixTransform(HASH_SEED, m));
    });

    it('depends on which ids are in the set, and on their order', () => {
        // Order sensitivity is fine — scene traversal order is stable — but a DIFFERENT set must
        // hash differently, or a swapped pair of casters would not trigger a redraw.
        expect(mixString(HASH_SEED, 'a')).not.toBe(mixString(HASH_SEED, 'b'));
        expect(mixString(mixString(HASH_SEED, 'a'), 'b'))
            .not.toBe(mixString(mixString(HASH_SEED, 'b'), 'a'));
    });

    it('stays an unsigned 32-bit integer', () => {
        let h = HASH_SEED;
        for (let i = 0; i < 100; i++) h = mixNumber(h, i * 1.37);
        expect(Number.isInteger(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(0xffffffff);
    });
});
