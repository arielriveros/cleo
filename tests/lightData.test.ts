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

describe('area lights in the light data', () => {
    it('puts the LTC tables first only in a frame with an area light, and the extensions after the records', async () => {
        const { AREA_EXT_TEXELS, LTC_ROWS, LTC_TEXELS } = await import('../src/graphics/lightData');
        const plain = lightDataLayout(3456, 10, 40, 0);
        expect(plain.clusterTableTexel).toBe(0);
        expect(plain.ltc).toBe(false);
        expect(plain.areaExtTexel).toBe(plain.lightIndexTexel);
        const area = lightDataLayout(3456, 10, 40, 2);
        expect(area.ltc).toBe(true);
        expect(area.clusterTableTexel).toBe(LTC_TEXELS);
        expect(LTC_TEXELS % LIGHT_DATA_WIDTH).toBe(0);
        expect(LTC_ROWS).toBe(32);
        expect(area.lightRecordTexel).toBe(LTC_TEXELS + 3456);
        expect(area.areaExtTexel).toBe(area.lightRecordTexel + 10 * LIGHT_RECORD_TEXELS);
        expect(area.lightIndexTexel).toBe(area.areaExtTexel + 2 * AREA_EXT_TEXELS);
    });

    it('marks an area light in the shadow field its kind leaves free, which an old path reads as no map', async () => {
        const { areaMarker, areaExtensionOf } = await import('../src/graphics/lightData');
        expect(areaMarker(0)).toBe(-2);
        expect(areaExtensionOf(areaMarker(11728), 0)).toBe(11728);      // two-sided: the cube slot stays real
        expect(areaExtensionOf(3, areaMarker(9000))).toBe(9000);        // one-sided: the spot layer stays real
        expect(areaExtensionOf(NO_SHADOW_SLOT, areaMarker(5))).toBe(5);
        // Points and spots, shadowed or not, are never read as area lights.
        expect(areaExtensionOf(NO_SHADOW_SLOT, NO_SHADOW_SLOT)).toBe(-1);
        expect(areaExtensionOf(2, NO_SHADOW_SLOT)).toBe(-1);
        expect(areaExtensionOf(NO_SHADOW_SLOT, 1)).toBe(-1);
        // A marker survives the f32 the texture holds, for any texel the texture can have.
        expect(Math.fround(areaMarker(256 * 4096))).toBe(areaMarker(256 * 4096));
    });

    it('packs an area light as the spot or point an old path shades, plus its extension', async () => {
        const { LightGrid } = await import('../src/graphics/lightGrid');
        const { AREA_SHAPE_DISK, areaExtensionOf, ltcTableTexels } = await import('../src/graphics/lightData');
        const grid = new LightGrid();
        grid.buildSingle(3, 2);
        grid.packAreaRecord(1, 0, [1, 2, 3], 0.01, [1, 0.9, 0.8], 5, [0, -1, 0], 0.4, false, 2,
                            [1, 0, 0], 0.5, 0.25, 4, 0);
        grid.packAreaRecord(2, 1, [4, 5, 6], 0.02, [1, 1, 1], 7, [0, 0, 1], 0.3, true, 1,
                            [0, 1, 0], 0.2, 0.2, 8, AREA_SHAPE_DISK);
        const staging = (grid as any)._staging as Float32Array;
        const L = grid.layout;
        const one = readLightRecord(staging, L.lightRecordTexel + LIGHT_RECORD_TEXELS);
        expect(one.coneScale).toBe(1);
        expect(one.coneOffset).toBe(0);
        expect(one.spotShadowLayer).toBe(2);
        expect(one.direction).toEqual([0, -1, 0]);
        expect(one.sourceRadius).toBeCloseTo(0.4);
        const ext1 = areaExtensionOf(one.spotShadowLayer, one.pointShadowSlot);
        expect(ext1).toBe(L.areaExtTexel);
        expect(Array.from(staging.subarray(ext1 * 4, ext1 * 4 + 8))).toEqual([1, 0, 0, 0.5, 4, 0.25, 0, 0]);
        const two = readLightRecord(staging, L.lightRecordTexel + 2 * LIGHT_RECORD_TEXELS);
        expect([two.coneScale, two.coneOffset]).toEqual([POINT_CONE_SCALE, POINT_CONE_OFFSET]);
        expect(two.pointShadowSlot).toBe(1);
        const ext2 = areaExtensionOf(two.spotShadowLayer, two.pointShadowSlot);
        expect(ext2).toBe(L.areaExtTexel + 2);
        expect(Array.from(staging.subarray(ext2 * 4, ext2 * 4 + 8)).map(x => +x.toFixed(5))).toEqual([0, 1, 0, 0.2, 8, 0.2, AREA_SHAPE_DISK, 1]);
        // The tables are in the staging buffer's first rows, as the shader reads them.
        expect(Array.from(staging.subarray(0, 64))).toEqual(Array.from(ltcTableTexels().subarray(0, 64)));
        // A slot past the frame's area count writes nothing.
        grid.packAreaRecord(0, 2, [9, 9, 9], 1, [1, 1, 1], 1, [0, 1, 0], 1, false, -1, [1, 0, 0], 1, 1, 1, 0);
        expect(readLightRecord(staging, L.lightRecordTexel).position).not.toEqual([9, 9, 9]);
    });

    it('builds an area light tangent perpendicular to its normal from the node frame', async () => {
        const { areaTangent } = await import('../src/graphics/lightData');
        const t = areaTangent([2, 0, 0.5, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [0, 0, 1], [0, 0, 0]);
        expect(t[0]).toBeCloseTo(1);
        expect(t[2]).toBeCloseTo(0);
        const d = areaTangent([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [0, 1, 0], [0, 0, 0]);
        expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1);
        expect(Math.abs(d[1])).toBeLessThan(1e-9);
    });
});
