import { describe, expect, it } from 'vitest';
import { FOLIAGE_STARTER, Material, applyWind, foliageSurfaceOf, isFoliageMaterial, setFoliage, windConfigOf } from '../src/graphics/material';
import { foliageProgramFor, physicalFor } from '../src/graphics/programVariants';
import { WeatherNode } from '../src/core/scene/nodes/weatherNode';
import { WEATHER_PRESETS } from '../src/core/scene/nodes/weatherPresets';

// The FOLIAGE material: PBR shading plus wind, interaction, variation, weather and gusts, which only the
// foliage shader variants run. These pin the asset side and which program a foliage layer draws with.

describe('Foliage material', () => {
    it('shades as PBR, serializes as its own type and round-trips', () => {
        const m = Material.Foliage({ roughness: 0.6, translucency: 0.4 }, { side: 'double' }, FOLIAGE_STARTER);
        expect(m.type).toBe('pbr');
        expect(isFoliageMaterial(m)).toBe(true);
        const json = m.serialize();
        expect(json.type).toBe('foliage');
        expect(json.windStrength).toBe(0.2);
        expect(json.rippleSheen).toBe(0.4);
        const back = Material.parse(json);
        expect(isFoliageMaterial(back)).toBe(true);
        expect(back.properties.get('roughness')).toBe(0.6);
        expect(foliageSurfaceOf(back)).toEqual(foliageSurfaceOf(m));
        expect(windConfigOf(back)).toEqual(windConfigOf(m));
    });

    it('writes no foliage surface keys at their defaults, and fills every one on load', () => {
        const json = Material.Foliage({}).serialize();
        expect(json.type).toBe('foliage');
        for (const k of ['variationHue', 'wetResponse', 'snowCover', 'leafFlip', 'dryColor', 'undersideColor']) expect(k in json).toBe(false);
        // Uniforms: a foliage material must carry every value, or it would inherit the previous draw's.
        const back = Material.parse(json);
        for (const k of ['variationHue', 'variationValue', 'variationDry', 'dryColor', 'wetResponse', 'snowCover',
                         'weightDroop', 'rippleSheen', 'leafFlip', 'undersideColor'])
            expect(back.properties.has(k), k).toBe(true);
    });

    it('clamps its values', () => {
        const m = Material.Foliage({}, undefined, { variationHue: 3, leafFlip: -1, dryColor: [2, 0.5, -1] });
        const f = foliageSurfaceOf(m);
        expect(f.variationHue).toBe(0.5);
        expect(f.leafFlip).toBe(0);
        expect(f.dryColor).toEqual([1, 0.5, 0]);
    });

    it('leaves an old PBR material with wind as PBR, keeping the values for a switch to Foliage', () => {
        const old = Material.PBR({});
        applyWind(old, { windStrength: 0.3 });
        const back = Material.parse(old.serialize());
        expect(back.serialize().type).toBe('pbr');
        expect(isFoliageMaterial(back)).toBe(false);
        expect(windConfigOf(back).windStrength).toBe(0.3);
        setFoliage(back, true);
        expect(isFoliageMaterial(back)).toBe(true);
        expect(back.serialize().windStrength).toBe(0.3);
        setFoliage(back, false);
        expect(back.serialize().type).toBe('pbr');
    });

    it('never makes a non-PBR material foliage', () => {
        const blinn = Material.Default({});
        setFoliage(blinn, true);
        expect(isFoliageMaterial(blinn)).toBe(false);
    });
});

describe('foliageProgramFor', () => {
    const base = { billboard: false, sway: false, foliage: false, parallax: false, afterPrepass: false, lean: true, pbr: true };
    it('sends only foliage materials through the foliage variants', () => {
        expect(foliageProgramFor({ ...base, foliage: true })).toBe('pbrGeometryInstancedLeanFoliage');
        expect(foliageProgramFor(base)).toBe('pbrGeometryInstancedLean');
        expect(foliageProgramFor({ ...base, lean: false, foliage: true })).toBe('pbrGeometryInstancedFoliage');
        expect(foliageProgramFor({ ...base, afterPrepass: true, foliage: true })).toBe('pbrGeometryInstancedLeanOpaqueFoliage');
        // Blinn-Phong never sways now; a marching prop stays plain.
        expect(foliageProgramFor({ ...base, pbr: false, foliage: true })).toBe('blinn_phongGeometryInstanced');
        expect(foliageProgramFor({ ...base, parallax: true, foliage: true })).toBe('pbrGeometryInstancedPom');
        expect(foliageProgramFor({ ...base, billboard: true, sway: true })).toBe('foliageBillboardInstancedWind');
    });

    it('resolves every foliage name to its variant', () => {
        for (const [name, tag] of [['pbrGeometryInstancedFoliage', 'foliage'], ['pbrGeometryInstancedLeanFoliage', 'leanFoliage'],
                                   ['pbrGeometryInstancedPrepassFoliage', 'prepassFoliage'], ['pbrGeometryInstancedLeanOpaqueFoliage', 'leanOpaqueFoliage'],
                                   ['shadowMapInstancedFoliage', 'foliage'], ['shadowMapInstancedCutoutFoliage', 'foliage']])
            expect(physicalFor(name, 0), name).toMatch(new RegExp(`~${tag}$`));
    });
});

describe('WeatherNode', () => {
    it('clamps, round-trips and applies presets', () => {
        const w = new WeatherNode('Weather', { wetness: 3, snow: -1 });
        expect([w.wetness, w.snow]).toEqual([1, 0]);
        expect(w.applyPreset('snowedIn')).toBe(true);
        expect([w.wetness, w.snow]).toEqual([0, 1]);
        // The weather, then the box (unbounded: a scene-wide node, as every scene saved before boxes has).
        expect((w as any)._serializePayload().weather).toMatchObject({ wetness: 0, snow: 1, puddles: 0, size: [0, 0, 0] });
        expect(WEATHER_PRESETS.map(p => p.id)).toEqual(['dry', 'drizzle', 'rain', 'storm', 'lightSnow', 'snowedIn', 'blizzard']);
    });
});
