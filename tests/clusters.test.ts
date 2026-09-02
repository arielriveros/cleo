import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    DEFAULT_CLUSTER_GRID,
    buildClusters,
    buildSingleCluster,
    clusterDepthScaleBias,
    clusterIndex,
    clusterSliceOf,
    sphereAxisExtent,
    spotBoundingSphere,
    type ClusterBuild,
    type ClusterGrid,
    type ClusterLight,
    type ClusterView,
} from '../src/graphics/clusters';

/**
 * Cluster assignment fails silently in both directions and neither shows up in a picture you can
 * trust. Assign too FEW clusters and a light vanishes from part of the screen — which looks like a
 * falloff bug, or like nothing at all if the light was dim. Assign too MANY and everything is
 * correct but the whole point of the system is gone, with no visual symptom whatsoever. So the math
 * is GL-free and every claim it makes is pinned here.
 */

const GRID: ClusterGrid = { x: 16, y: 9, z: 24 };

/** A camera at the origin looking down -Z, which is what `lookAt` gives for forward = (0,0,-1). */
function cameraAt(eye: vec3, target: vec3, near = 0.1, far = 100): ClusterView {
    const view = mat4.create();
    mat4.lookAt(view, eye, target, [0, 1, 0]);
    return { view, near, far, fovY: Math.PI / 4, aspect: 16 / 9 };
}

/** Every cluster a light index appears in, decoded back out of the packed list. */
function clustersHolding(build: ClusterBuild, light: number, grid: ClusterGrid): Set<number> {
    const found = new Set<number>();
    const total = grid.x * grid.y * grid.z;
    for (let c = 0; c < total; c++) {
        const offset = build.table[c * 4];
        const count = build.table[c * 4 + 1];
        for (let k = 0; k < count; k++)
            if (build.indices[offset + k] === light) found.add(c);
    }
    return found;
}

describe('clusterDepthScaleBias / clusterSliceOf', () => {
    it('puts `near` in slice 0 and `far` in the last slice', () => {
        const [scale, bias] = clusterDepthScaleBias(0.1, 100, 24);
        expect(clusterSliceOf(0.1, scale, bias, 24)).toBe(0);
        // Exactly `far` lands one past the end before the clamp; the clamp is what makes the far
        // plane belong to a slice at all, and without it the last shell of the world reads cluster
        // garbage rather than being merely unlit.
        expect(clusterSliceOf(100, scale, bias, 24)).toBe(23);
        expect(clusterSliceOf(99.999, scale, bias, 24)).toBe(23);
    });

    it('is monotonic across the whole range', () => {
        const [scale, bias] = clusterDepthScaleBias(0.1, 500, 24);
        let previous = -1;
        for (let z = 0.1; z < 500; z *= 1.2) {
            const slice = clusterSliceOf(z, scale, bias, 24);
            expect(slice).toBeGreaterThanOrEqual(previous);
            previous = slice;
        }
    });

    it('is exponential, not uniform: slice 0 is far thinner than the last', () => {
        const [scale, bias] = clusterDepthScaleBias(0.1, 100, 24);
        // The depth at which each slice starts, inverted from the same scale/bias.
        const startOf = (s: number) => Math.exp((s - bias) / scale);
        const first = startOf(1) - startOf(0);
        const last = startOf(24) - startOf(23);
        expect(last).toBeGreaterThan(first * 100);
    });

    it('survives a degenerate near plane instead of returning NaN', () => {
        const [scale, bias] = clusterDepthScaleBias(0, 100, 24);
        expect(Number.isFinite(scale)).toBe(true);
        expect(Number.isFinite(bias)).toBe(true);
        expect(clusterSliceOf(1, scale, bias, 24)).toBeGreaterThanOrEqual(0);
    });
});

describe('sphereAxisExtent', () => {
    const out: [number, number] = [0, 0];

    it('brackets a sphere sitting on the axis', () => {
        // Centred straight ahead at 10 m, radius 1, 45-degree half-fov (tanHalf = 1).
        expect(sphereAxisExtent(0, 10, 1, 1, out)).toBe(true);
        expect(out[0]).toBeLessThan(0);
        expect(out[1]).toBeGreaterThan(0);
        expect(out[0]).toBeCloseTo(-out[1], 6);
        // The silhouette subtends asin(1/10); its tangent through the eye is what bounds it.
        const half = Math.tan(Math.asin(0.1));
        expect(out[1]).toBeCloseTo(half, 4);
    });

    it('reports unbounded when the eye is inside the sphere', () => {
        expect(sphereAxisExtent(0, 1, 5, 1, out)).toBe(false);
    });

    it('reports unbounded when the sphere straddles the eye plane', () => {
        // Centre 1 m ahead, radius 2: the silhouette wraps past the camera and no rectangle holds it.
        expect(sphereAxisExtent(0, 1, 2, 1, out)).toBe(false);
    });

    it('is tighter than the projected bounding box, and never looser', () => {
        // A sphere off to one side is where the two disagree most: the box's near corners project
        // wider than the real silhouette.
        expect(sphereAxisExtent(4, 10, 1, 1, out)).toBe(true);
        const boxMin = (4 - 1) / (10 + 1);      // nearest the axis, furthest away
        const boxMax = (4 + 1) / (10 - 1);
        expect(out[0]).toBeGreaterThanOrEqual(boxMin - 1e-9);
        expect(out[1]).toBeLessThanOrEqual(boxMax + 1e-9);
        // And it still contains the centre's own projection.
        expect(out[0]).toBeLessThan(0.4);
        expect(out[1]).toBeGreaterThan(0.4);
    });

    it('divides the extent by the half-fov tangent', () => {
        const wide: [number, number] = [0, 0];
        sphereAxisExtent(0, 10, 1, 1, out);
        sphereAxisExtent(0, 10, 1, 2, wide);
        expect(wide[1]).toBeCloseTo(out[1] / 2, 9);
    });
});

describe('spotBoundingSphere', () => {
    const out = { center: new Float32Array(3), radius: 0 };

    it('never has a radius larger than the range', () => {
        // NOT the same as being contained in the range sphere, which it is not past 45 degrees — the
        // sphere is offset along the axis and pokes out the far side. See the note on the function.
        for (const degrees of [1, 15, 30, 45, 60, 80, 89.9]) {
            spotBoundingSphere([0, 0, 0], [0, 0, -1], 10, degrees * Math.PI / 180, out);
            expect(out.radius).toBeLessThanOrEqual(10 + 1e-6);
        }
    });

    it('contains the apex and the far rim at every angle', () => {
        // The only thing a bounding volume owes. Both extremes lie exactly ON the sphere in one
        // branch or the other, so the tolerance is float slack and nothing more.
        for (const degrees of [1, 15, 30, 44.9, 45.1, 60, 80, 89.9]) {
            const half = degrees * Math.PI / 180;
            spotBoundingSphere([0, 0, 0], [0, 0, -1], 10, half, out);
            const c = out.center;
            expect(Math.hypot(c[0], c[1], c[2])).toBeLessThanOrEqual(out.radius + 1e-4);
            // A point on the cap's rim: 10 m along the axis, splayed out by the half angle.
            const rim = [Math.sin(half) * 10, 0, -Math.cos(half) * 10];
            expect(Math.hypot(rim[0] - c[0], rim[1] - c[1], rim[2] - c[2]))
                .toBeLessThanOrEqual(out.radius + 1e-4);
        }
    });

    it('is a hemisphere-sized sphere on the light itself at 90 degrees', () => {
        spotBoundingSphere([0, 0, 0], [0, 0, -1], 10, Math.PI / 2, out);
        expect(out.radius).toBeCloseTo(10, 6);
        expect(Math.hypot(out.center[0], out.center[1], out.center[2])).toBeCloseTo(0, 6);
    });

    it('is much tighter than the range sphere for a narrow cone', () => {
        spotBoundingSphere([0, 0, 0], [0, 0, -1], 10, 10 * Math.PI / 180, out);
        // Half the range, near enough, where the range sphere would be the full 10.
        expect(out.radius).toBeLessThan(5.2);
    });
});

describe('buildClusters', () => {
    it('produces a valid prefix sum whose end is `used`', () => {
        const lights: ClusterLight[] = [
            { position: [0, 0, -5], radius: 2 },
            { position: [3, 1, -12], radius: 4 },
            { position: [-6, 0, -30], radius: 10 },
        ];
        const build = buildClusters(lights, cameraAt([0, 0, 0], [0, 0, -1]), GRID);

        const total = GRID.x * GRID.y * GRID.z;
        let running = 0;
        for (let c = 0; c < total; c++) {
            expect(build.table[c * 4]).toBe(running);
            running += build.table[c * 4 + 1];
        }
        expect(running).toBe(build.used);
        expect(build.used).toBeGreaterThan(0);
    });

    it('writes every index it counted, and never past `used`', () => {
        const lights: ClusterLight[] = [];
        for (let i = 0; i < 40; i++)
            lights.push({ position: [(i % 8) - 4, ((i / 8) | 0) - 2, -4 - i], radius: 3 });
        const build = buildClusters(lights, cameraAt([0, 0, 0], [0, 0, -1]), GRID);

        const total = GRID.x * GRID.y * GRID.z;
        let seen = 0;
        for (let c = 0; c < total; c++) {
            const offset = build.table[c * 4];
            const count = build.table[c * 4 + 1];
            for (let k = 0; k < count; k++) {
                const index = build.indices[offset + k];
                expect(index).toBeGreaterThanOrEqual(0);
                expect(index).toBeLessThan(lights.length);
                expect(Number.isInteger(index)).toBe(true);
                seen++;
            }
        }
        expect(seen).toBe(build.used);
    });

    it('confines a small light to a handful of clusters, not the whole grid', () => {
        const build = buildClusters([{ position: [0, 0, -10], radius: 0.5 }],
                                    cameraAt([0, 0, 0], [0, 0, -1]), GRID);
        const held = clustersHolding(build, 0, GRID);
        expect(held.size).toBeGreaterThan(0);
        expect(held.size).toBeLessThan(20);
    });

    it('puts a light enclosing the camera in every cluster', () => {
        const build = buildClusters([{ position: [0, 0, 0], radius: 500 }],
                                    cameraAt([0, 0, 0], [0, 0, -1], 0.1, 100), GRID);
        expect(build.used).toBe(GRID.x * GRID.y * GRID.z);
    });

    it('drops a light entirely behind the camera', () => {
        const build = buildClusters([{ position: [0, 0, 10], radius: 1 }],
                                    cameraAt([0, 0, 0], [0, 0, -1]), GRID);
        expect(build.used).toBe(0);
    });

    it('drops a light past the clustered far distance', () => {
        const build = buildClusters([{ position: [0, 0, -400], radius: 10 }],
                                    cameraAt([0, 0, 0], [0, 0, -1], 0.1, 100), GRID);
        expect(build.used).toBe(0);
    });

    it('drops a light with no radius', () => {
        const build = buildClusters([{ position: [0, 0, -5], radius: 0 }],
                                    cameraAt([0, 0, 0], [0, 0, -1]), GRID);
        expect(build.used).toBe(0);
    });

    it('widens to the full screen when a light straddles the near plane', () => {
        // Centre 1 m ahead with a 3 m radius: the silhouette wraps around the camera, so no finite
        // rectangle holds it and every tile has to take the light. Getting this wrong is the classic
        // clustered-lighting bug — the light disappears exactly when you walk into it.
        const build = buildClusters([{ position: [0, 0, -1], radius: 3 }],
                                    cameraAt([0, 0, 0], [0, 0, -1], 0.1, 100), GRID);
        const held = clustersHolding(build, 0, GRID);
        const slices = new Set<number>();
        for (const c of held) slices.add(Math.floor(c / (GRID.x * GRID.y)));
        // Every tile of every slice the sphere spans.
        expect(held.size).toBe(slices.size * GRID.x * GRID.y);
    });

    it('separates two lights on opposite sides of the screen', () => {
        const camera = cameraAt([0, 0, 0], [0, 0, -1]);
        const build = buildClusters([
            { position: [-8, 0, -10], radius: 1 },
            { position: [8, 0, -10], radius: 1 },
        ], camera, GRID);

        const left = clustersHolding(build, 0, GRID);
        const right = clustersHolding(build, 1, GRID);
        expect(left.size).toBeGreaterThan(0);
        expect(right.size).toBeGreaterThan(0);
        for (const c of left) expect(right.has(c)).toBe(false);
    });

    it('separates two lights at different depths', () => {
        const camera = cameraAt([0, 0, 0], [0, 0, -1], 0.1, 100);
        const build = buildClusters([
            { position: [0, 0, -3], radius: 0.5 },
            { position: [0, 0, -60], radius: 0.5 },
        ], camera, GRID);

        const near = clustersHolding(build, 0, GRID);
        const far = clustersHolding(build, 1, GRID);
        for (const c of near) expect(far.has(c)).toBe(false);
    });

    it('honours the per-cluster cap and reports the overflow', () => {
        const lights: ClusterLight[] = [];
        for (let i = 0; i < 30; i++) lights.push({ position: [0, 0, 0], radius: 500 });
        const build = buildClusters(lights, cameraAt([0, 0, 0], [0, 0, -1]), GRID, 8);

        const total = GRID.x * GRID.y * GRID.z;
        for (let c = 0; c < total; c++) expect(build.table[c * 4 + 1]).toBeLessThanOrEqual(8);
        expect(build.used).toBe(total * 8);
        expect(build.overflowed).toBe(total * 22);
    });

    it('reuses the arrays it was handed, and grows `indices` when a frame needs more', () => {
        const camera = cameraAt([0, 0, 0], [0, 0, -1]);
        const out = buildClusters([{ position: [0, 0, -10], radius: 1 }], camera, GRID);
        const table = out.table;

        const many: ClusterLight[] = [];
        for (let i = 0; i < 60; i++) many.push({ position: [0, 0, 0], radius: 500 });
        const second = buildClusters(many, camera, GRID, 64, out);

        expect(second).toBe(out);
        expect(second.table).toBe(table);                       // the table never changes size
        expect(second.indices.length).toBeGreaterThanOrEqual(second.used);
    });

    it('leaves no stale counts behind when a rebuild finds fewer lights', () => {
        const camera = cameraAt([0, 0, 0], [0, 0, -1]);
        const out = buildClusters([{ position: [0, 0, 0], radius: 500 }], camera, GRID);
        expect(out.used).toBeGreaterThan(0);

        buildClusters([], camera, GRID, 64, out);
        expect(out.used).toBe(0);
        const total = GRID.x * GRID.y * GRID.z;
        for (let c = 0; c < total; c++) expect(out.table[c * 4 + 1]).toBe(0);
    });

    it('follows the camera rather than the world origin', () => {
        // The same light, seen from two places. Moving the camera past it must move which clusters
        // hold it — the assignment is in VIEW space, and a missing view transform is invisible from
        // a camera that happens to sit at the origin.
        const light: ClusterLight[] = [{ position: [0, 0, -10], radius: 1 }];
        const a = buildClusters(light, cameraAt([0, 0, 0], [0, 0, -1]), GRID);
        const b = buildClusters(light, cameraAt([0, 0, -30], [0, 0, -40]), GRID);
        expect(a.used).toBeGreaterThan(0);
        expect(b.used).toBe(0);                                 // now behind the camera
    });
});

describe('buildSingleCluster', () => {
    it('holds every light in one cluster', () => {
        const build = buildSingleCluster(5);
        expect(build.table[0]).toBe(0);
        expect(build.table[1]).toBe(5);
        expect(build.used).toBe(5);
        expect(Array.from(build.indices.subarray(0, 5))).toEqual([0, 1, 2, 3, 4]);
    });

    it('is empty for a scene with no lights', () => {
        const build = buildSingleCluster(0);
        expect(build.table[1]).toBe(0);
        expect(build.used).toBe(0);
    });
});

describe('clusterIndex', () => {
    it('is slice-major and covers the grid exactly once', () => {
        const grid: ClusterGrid = { x: 4, y: 3, z: 2 };
        const seen = new Set<number>();
        for (let z = 0; z < grid.z; z++)
            for (let y = 0; y < grid.y; y++)
                for (let x = 0; x < grid.x; x++) seen.add(clusterIndex(x, y, z, grid));
        expect(seen.size).toBe(24);
        expect(Math.max(...seen)).toBe(23);
        // One slice's tiles are contiguous, which is what makes a depth-ordered fill cache-friendly.
        expect(clusterIndex(0, 0, 1, grid)).toBe(12);
    });
});

describe('DEFAULT_CLUSTER_GRID', () => {
    it('matches the grid these tests pin', () => {
        expect(DEFAULT_CLUSTER_GRID).toEqual(GRID);
    });
});

describe('the light cap is gone from the shader tree', () => {
    // A source-text sweep, in the style of tests/shaderShadowContract.test.ts, because the thing being
    // asserted is an ABSENCE and nothing else can notice one. `array<PointLight, 16>` was declared in
    // four separate lighting blocks that had to be edited in lockstep with `MAX_POINT_LIGHTS` in
    // graphics/lighting.ts, shaders/constants.glsl and the renderer's name tables; a fifth copy
    // reappearing anywhere is exactly how the cap came to live in eight files the first time.
    const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
    const files = [
        join(WGSL, 'chunks', 'pbrForward.wgsl'),
        join(WGSL, 'chunks', 'blinnPhongForward.wgsl'),
        join(WGSL, 'chunks', 'shadows.wgsl'),
        join(WGSL, 'deferredLighting.wgsl'),
        join(WGSL, 'terrainForward.wgsl'),
    ];

    it('declares no fixed-length light array', () => {
        for (const file of files) {
            const src = readFileSync(file, 'utf-8');
            expect(src, file).not.toMatch(/array<PointLight,/);
            expect(src, file).not.toMatch(/array<SpotLight,/);
        }
    });

    it('declares no light-count constant or uniform', () => {
        for (const file of files) {
            const src = readFileSync(file, 'utf-8');
            for (const name of ['MAX_POINT_LIGHTS', 'MAX_SPOTLIGHTS',
                                'u_numPointLights', 'u_numSpotlights']) {
                // A prose mention of what these WERE is fine; a declaration is not.
                expect(src, `${file}: ${name}`).not.toMatch(
                    new RegExp(`^\s*(const\s+${name}|${name}\s*:)`, 'm'));
            }
        }
    });

    it('has none left in constants.glsl or graphics/lighting.ts either', () => {
        const constants = readFileSync(
            join(__dirname, '..', 'src', 'graphics', 'shaders', 'constants.glsl'), 'utf-8');
        expect(constants).not.toContain('MAX_POINT_LIGHTS');
        expect(constants).not.toContain('MAX_SPOTLIGHTS');

        const lighting = readFileSync(
            join(__dirname, '..', 'src', 'graphics', 'lighting.ts'), 'utf-8');
        expect(lighting).not.toMatch(/export const MAX_POINT_LIGHTS/);
        expect(lighting).not.toMatch(/export const MAX_SPOTLIGHTS/);
        // What replaced them is a memory budget, and it is far larger than the 16 + 8 it retired.
        expect(lighting).toMatch(/export const MAX_LIGHTS = (\d+)/);
        expect(Number(/export const MAX_LIGHTS = (\d+)/.exec(lighting)![1])).toBeGreaterThan(24);
    });
});
