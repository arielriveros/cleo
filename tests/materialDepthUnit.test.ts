import { describe, expect, it } from 'vitest';
import { Geometry } from '../src/core/geometry';
import { Material } from '../src/graphics/material';

/**
 * Relief depth has a UNIT now, and this is what that costs and buys.
 *
 * `dispScale` was a fraction of one texture repeat, and a fraction of a repeat means nothing until you
 * know what a repeat is worth. A tiling material puts one inside a few centimetres, so the 0.05 default
 * is a few millimetres of relief. An atlas-mapped photogrammetry scan puts one repeat around the WHOLE
 * OBJECT: measured on the branch that prompted this, one uv unit was 47.97 world units, so the same
 * default asked for 2.4 units of relief on a branch 12.7 units thick. The march then reached across the
 * atlas for texels belonging to its far side, and the surface swam as the camera moved. Nothing in the
 * shader could have detected the difference — the two cases are identical numbers over different meshes
 * — so the control carries its unit instead.
 *
 * The migration is a FLAG, not arithmetic, and that is forced: converting a stored number needs the
 * chart's world scale, and that belongs to the MESH, not the material. One material can sit on a cube
 * and on a scan, so there is no single number to convert it to.
 */

describe('Geometry.worldPerUv measures what one uv unit is worth', () => {
    /** A quad of `size` world units mapped over `uvSpan` of uv. */
    const quad = (size: number, uvSpan: number) => new Geometry(
        [0, 0, 0, size, 0, 0, size, size, 0, 0, size, 0],
        [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        [0, 0, uvSpan, 0, uvSpan, uvSpan, 0, uvSpan],
        [], [], [0, 1, 2, 0, 2, 3], false);

    it('is 1 when one uv unit is one world unit', () => {
        expect(quad(1, 1).worldPerUv()).toBeCloseTo(1, 9);
    });

    it('is the world size when the whole surface is one 0..1 chart', () => {
        // The scan's case: a 48-unit object atlassed into 0..1 reports 48.
        expect(quad(48, 1).worldPerUv()).toBeCloseTo(48, 6);
        // 4 places, not 6: Geometry stores positions as Float32Array, so 62.4 comes back as
        // 62.400001525878906 before any of this arithmetic runs.
        expect(quad(62.4, 1).worldPerUv()).toBeCloseTo(62.4, 4);
    });

    it('falls as the chart tiles', () => {
        // 8 world units across 8 repeats: one repeat per unit.
        expect(quad(8, 8).worldPerUv()).toBeCloseTo(1, 6);
        expect(quad(1, 10).worldPerUv()).toBeCloseTo(0.1, 6);
    });

    it('a unit cube reports 1, so a world depth and a uv depth agree on it', () => {
        // Which is why every primitive looked correct while the scan did not: on a 0..1-mapped unit
        // face the two units are the same number, and the bug could not express itself.
        expect(Geometry.Cube().worldPerUv()).toBeCloseTo(1, 6);
    });

    it('returns a neutral 1 rather than a NaN for a mesh with no usable chart', () => {
        expect(new Geometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [], [], [], [], [0, 1, 2], false).worldPerUv())
            .toBe(1);
        expect(new Geometry().worldPerUv()).toBe(1);
    });
});

describe('Geometry.meanUvEdge decides what geometry can carry', () => {
    /**
     * A displacement bake band-limits to the mip matching its output vertex spacing, and that spacing is
     * `meanUvEdge / segments` in uv. Getting this from `sqrt(triangleCount)` instead — the first
     * attempt — conflates mesh density with CHART density: an 8-triangle ramp whose faces each carry a
     * 0..1 chart came out as 181 texels per output edge when the truth is 512, so it sampled mip 7.5 of
     * a 4096 map and displaced by a near-constant. "Almost totally flat" was that. The guess only spared
     * dense meshes, where it happened to land near the truth.
     */
    const quad = (size: number, uvSpan: number) => new Geometry(
        [0, 0, 0, size, 0, 0, size, size, 0, 0, size, 0],
        [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        [0, 0, uvSpan, 0, uvSpan, uvSpan, 0, uvSpan],
        [], [], [0, 1, 2, 0, 2, 3], false);

    it('does not depend on the mesh world size, only on the chart', () => {
        // The whole point: two meshes of wildly different size with the same 0..1 chart carry the map
        // equally badly.
        expect(quad(1, 1).meanUvEdge()).toBeCloseTo(quad(100, 1).meanUvEdge(), 6);
    });

    it('falls as the chart tiles, which is what makes detail carryable', () => {
        const one = quad(1, 1).meanUvEdge();
        expect(quad(1, 8).meanUvEdge() / one, '8 repeats: eight times shorter an edge').toBeCloseTo(8, 4);
    });

    it('a 0..1 chart on a cube face is 512 texels per edge at level 3 - correctly flat', () => {
        // Not a bug and not fixable by subdivision: 4096 texels across a face cannot be represented by
        // nine vertices along it. This is the number the editor warns with.
        const edge = Geometry.Cube().meanUvEdge();
        const texelsPerEdge = (edge * 4096) / 8;
        expect(texelsPerEdge).toBeGreaterThan(400);
        // A dense chart is the opposite case, and lands where the scan does.
        const sphere = (Geometry.Sphere().meanUvEdge() * 4096) / 8;
        expect(sphere).toBeLessThan(32);
    });

    it('is 0 for a mesh with no chart, so a caller can tell "cannot band-limit"', () => {
        expect(new Geometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [], [], [], [], [0, 1, 2], false).meanUvEdge())
            .toBe(0);
        expect(new Geometry().meanUvEdge()).toBe(0);
    });
});

describe('the unit survives a save/load round trip, and its ABSENCE means uv', () => {
    const roundTrip = (m: Material) => Material.parse(JSON.parse(JSON.stringify(m.serialize())));

    it('a material created now is in world units', () => {
        expect(Material.PBR({}).properties.get('depthInWorld')).toBe(true);
        expect((Material.PBR({}).serialize() as any).depthSpace).toBe('world');
    });

    it('and stays that way across a round trip', () => {
        const m = Material.PBR({ displacementScale: 0.3 });
        const back = roundTrip(m);
        expect(back.properties.get('depthInWorld')).toBe(true);
        expect(back.properties.get('dispScale')).toBeCloseTo(0.3, 9);
    });

    it('an explicit uv material stays uv', () => {
        const back = roundTrip(Material.PBR({ depthSpace: 'uv', displacementScale: 0.05 }));
        expect(back.properties.get('depthInWorld')).toBe(false);
        expect((back.serialize() as any).depthSpace).toBe('uv');
    });

    it('AN ASSET WITH NO MARKER IS UV — this read must stay forever', () => {
        // Asset JSON is not rewritten until the asset is re-saved, so every project on disk predates
        // the marker. Reading its absence as "world" would silently reinterpret every stored depth by
        // the mesh's chart scale — a factor of 48 on the scan that prompted this.
        const legacy = Material.PBR({ displacementScale: 0.05 }).serialize() as any;
        delete legacy.depthSpace;
        expect(Material.parse(legacy).properties.get('depthInWorld')).toBe(false);
    });

    it('PARALLAX is off everywhere, INCLUDING for an unmarked legacy asset', () => {
        // The one marker in this file that does NOT preserve old behaviour, and deliberately so: the
        // march was withdrawn rather than re-defaulted, and the editor no longer has a control that
        // could switch it back off, so a legacy material that kept marching would be stuck that way.
        expect(Material.PBR({}).properties.get('parallax'), 'created: off').toBe(false);

        const legacy = Material.PBR({ parallax: true }).serialize() as any;
        delete legacy.parallax;
        expect(Material.parse(legacy).properties.get('parallax'), 'no marker: OFF').toBe(false);

        // An asset that explicitly asked for it still gets it — the shader still honours the flag.
        expect(Material.PBR({ parallax: true }).properties.get('parallax')).toBe(true);
        const on = Material.PBR({ parallax: true }).serialize() as any;
        expect(Material.parse(on).properties.get('parallax'), 'explicit true survives').toBe(true);
    });

    it('the subdivision level lives on the MATERIAL and round-trips', () => {
        // Moved off the model: the surface decides how it wants to be represented, so a material
        // carried onto another mesh brings its relief with it.
        expect(Material.PBR({}).properties.get('displaceLevel'), 'off by default').toBe(0);
        const m = Material.PBR({ displaceLevel: 3 });
        expect(m.properties.get('displaceLevel')).toBe(3);
        expect(Material.parse(JSON.parse(JSON.stringify(m.serialize()))).properties.get('displaceLevel'))
            .toBe(3);
    });

    it('the marker is not `depthUnit`, which belongs to terrain', () => {
        // `depthUnit: 'metres'` is terrain's retired migration stamp, and
        // tests/terrainDepthMigration.test.ts asserts nothing writes it any more — a stale one is the
        // double-migration hazard it exists to prevent. Reusing the key would resurrect that.
        expect((Material.PBR({}).serialize() as any).depthUnit).toBeUndefined();
    });
});
