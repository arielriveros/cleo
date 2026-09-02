import { describe, expect, it } from 'vitest';
import {
    INDICES_PER_TEXEL,
    LIGHT_DATA_WIDTH,
    LIGHT_DATA_WIDTH_SHIFT,
    LIGHT_RECORD_TEXELS,
    NO_SHADOW_SLOT,
    POINT_CONE_OFFSET,
    POINT_CONE_SCALE,
    lightDataFloats,
    lightDataLayout,
    packClusterBuild,
    packLightRecord,
    readLightRecord,
} from '../src/graphics/lightData';
import { DEFAULT_CLUSTER_GRID, buildClusters, type ClusterLight } from '../src/graphics/clusters';
import { mat4 } from 'gl-matrix';

/**
 * The light data texture has the failure mode every packed buffer has: a field written at the wrong
 * offset is not a crash, it is a light with somebody else's intensity. Nothing downstream validates
 * it and no picture identifies which field slipped — so the layout is pinned here instead.
 */

describe('lightDataLayout', () => {
    it('packs the three regions end to end with no reservation', () => {
        const layout = lightDataLayout(3456, 10, 40);
        expect(layout.clusterTableTexel).toBe(0);
        expect(layout.lightRecordTexel).toBe(3456);
        expect(layout.lightIndexTexel).toBe(3456 + 10 * LIGHT_RECORD_TEXELS);
        expect(layout.texelCount).toBe(3456 + 40 + 40 / INDICES_PER_TEXEL);
    });

    it('rounds the index region up to a whole texel', () => {
        // One index still occupies a texel; three quarters of it go unread.
        const layout = lightDataLayout(4, 1, 1);
        expect(layout.texelCount).toBe(4 + LIGHT_RECORD_TEXELS + 1);
    });

    it('rounds the upload up to whole rows, and never to zero', () => {
        expect(lightDataLayout(0, 0, 0).rows).toBe(1);
        expect(lightDataLayout(LIGHT_DATA_WIDTH, 0, 0).rows).toBe(1);
        expect(lightDataLayout(LIGHT_DATA_WIDTH + 1, 0, 0).rows).toBe(2);
        expect(lightDataLayout(3456, 256, 20000).rows)
            .toBe(Math.ceil((3456 + 1024 + 5000) / LIGHT_DATA_WIDTH));
    });

    it('sizes a staging buffer at four floats a texel', () => {
        expect(lightDataFloats(3)).toBe(3 * LIGHT_DATA_WIDTH * 4);
    });

    it('keeps the row width a power of two, so the shader masks and shifts', () => {
        expect(1 << LIGHT_DATA_WIDTH_SHIFT).toBe(LIGHT_DATA_WIDTH);
    });
});

describe('packLightRecord', () => {
    it('round-trips a point light', () => {
        const data = new Float32Array(64);
        packLightRecord(data, 4, [1, 2, 3], 0.25, [0.5, 0.25, 0.125], 7.5,
                        [0, 0, -1], 0.05, POINT_CONE_SCALE, POINT_CONE_OFFSET, NO_SHADOW_SLOT, 3);
        const record = readLightRecord(data, 4);

        expect(record.position).toEqual([1, 2, 3]);
        expect(record.invRangeSquared).toBe(0.25);
        expect(record.color).toEqual([0.5, 0.25, 0.125]);
        expect(record.intensity).toBe(7.5);
        expect(record.sourceRadius).toBeCloseTo(0.05, 6);
        expect(record.spotShadowLayer).toBe(NO_SHADOW_SLOT);
        expect(record.pointShadowSlot).toBe(3);
    });

    it('round-trips a spot light, cone and shadow layer included', () => {
        const data = new Float32Array(64);
        packLightRecord(data, 0, [4, 5, 6], 0.01, [1, 1, 1], 2, [0, -1, 0], 0.1, 12.5, -11.5,
                        2, NO_SHADOW_SLOT);
        const record = readLightRecord(data, 0);

        expect(record.direction).toEqual([0, -1, 0]);
        expect(record.coneScale).toBe(12.5);
        expect(record.coneOffset).toBe(-11.5);
        expect(record.spotShadowLayer).toBe(2);
        expect(record.pointShadowSlot).toBe(NO_SHADOW_SLOT);
    });

    it('gives a point light a cone that is exactly transparent', () => {
        // The whole reason the record has no light-type field: `spotAttenuation(cos, 0, 1)` is
        // `saturate(cos * 0 + 1)^2`, which is exactly 1.0 for every input — so `evaluateSpotLight`
        // computes what `evaluatePointLight` computes, bit for bit, and one loop shades both types.
        for (const cosAngle of [-1, -0.5, 0, 0.5, 1]) {
            const a = Math.min(1, Math.max(0, cosAngle * POINT_CONE_SCALE + POINT_CONE_OFFSET));
            expect(a * a).toBe(1);
        }
    });

    it('writes exactly its own four texels and touches no neighbour', () => {
        const data = new Float32Array(LIGHT_RECORD_TEXELS * 3 * 4).fill(-1);
        packLightRecord(data, LIGHT_RECORD_TEXELS, [1, 1, 1], 1, [1, 1, 1], 1, [1, 1, 1], 1, 1, 1, 1, 1);

        for (let i = 0; i < LIGHT_RECORD_TEXELS * 4; i++) expect(data[i]).toBe(-1);
        for (let i = LIGHT_RECORD_TEXELS * 8; i < data.length; i++) expect(data[i]).toBe(-1);
        expect(data[LIGHT_RECORD_TEXELS * 4]).toBe(1);
    });

    it('lands consecutive lights four texels apart', () => {
        const data = new Float32Array(3 * LIGHT_RECORD_TEXELS * 4);
        for (let i = 0; i < 3; i++)
            packLightRecord(data, i * LIGHT_RECORD_TEXELS, [i, 0, 0], 0, [0, 0, 0], 0,
                            [0, 0, 0], 0, 0, 0, NO_SHADOW_SLOT, NO_SHADOW_SLOT);
        for (let i = 0; i < 3; i++)
            expect(readLightRecord(data, i * LIGHT_RECORD_TEXELS).position[0]).toBe(i);
    });
});

describe('packClusterBuild', () => {
    it('places the table and the index list at the layout offsets', () => {
        const view = mat4.create();
        mat4.lookAt(view, [0, 0, 0], [0, 0, -1], [0, 1, 0]);
        const lights: ClusterLight[] = [
            { position: [0, 0, -5], radius: 2 },
            { position: [2, 1, -8], radius: 3 },
        ];
        const grid = DEFAULT_CLUSTER_GRID;
        const clusters = grid.x * grid.y * grid.z;
        const build = buildClusters(lights, { view, near: 0.1, far: 100, fovY: Math.PI / 4, aspect: 16 / 9 });

        const layout = lightDataLayout(clusters, lights.length, build.used);
        const staged = new Float32Array(lightDataFloats(layout.rows));
        packClusterBuild(staged, layout, build, clusters);

        // Every cluster's (offset, count) survives the copy.
        for (let c = 0; c < clusters; c++) {
            expect(staged[c * 4]).toBe(build.table[c * 4]);
            expect(staged[c * 4 + 1]).toBe(build.table[c * 4 + 1]);
        }
        // And every index is reachable at four to a texel, exactly where the shader will look.
        for (let k = 0; k < build.used; k++) {
            const texel = layout.lightIndexTexel + (k >> 2);
            expect(staged[texel * 4 + (k & 3)]).toBe(build.indices[k]);
        }
    });

    it('leaves the light record region untouched for the packer to fill', () => {
        const view = mat4.create();
        const grid = { x: 2, y: 2, z: 2 };
        const clusters = 8;
        const build = buildClusters([{ position: [0, 0, -5], radius: 2 }],
                                    { view, near: 0.1, far: 100, fovY: Math.PI / 4, aspect: 1 }, grid);

        const layout = lightDataLayout(clusters, 1, build.used);
        const staged = new Float32Array(lightDataFloats(layout.rows)).fill(-1);
        packClusterBuild(staged, layout, build, clusters);

        for (let i = 0; i < LIGHT_RECORD_TEXELS * 4; i++)
            expect(staged[layout.lightRecordTexel * 4 + i]).toBe(-1);
    });
});
