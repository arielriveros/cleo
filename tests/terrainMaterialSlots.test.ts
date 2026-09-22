import { describe, it, expect } from 'vitest';
import { Material, TerrainMaterial, legacyHeightBlendToRule } from '../src/graphics/material';
import { defaultBlendRule, rangeCoverage, smoothstep } from '../src/terrain/terrainLayers';

// A landscape material is an ordered list of slots now: its own surface (slot 0) plus any number of
// further surfaces, each with its own blend rule. These pin the JSON shape and the migration of every
// material saved before rules existed.

describe('landscape material slots', () => {
    it('round-trips slots, rules and the foliage flag', () => {
        const tm = TerrainMaterial.Create('pbr', { baseColor: [0.3, 0.5, 0.2] });
        tm.rule.opacity = 0.75;
        tm.allowFoliage = true;
        const rock = Material.PBR({ baseColor: [0.5, 0.5, 0.5], roughness: 0.9 });
        const rule = defaultBlendRule();
        rule.slope = { enabled: true, min: 35, max: 90, falloff: 6 };
        rule.noise = { amount: 0.5, scale: 12, seed: 3 };
        tm.slots.push({
            id: 'slot_rock', name: 'Rock', material: rock, surfaceMaterialId: 'mat-rock',
            tiling: 35, rule, allowFoliage: false,
        });

        const back = TerrainMaterial.parse(JSON.parse(JSON.stringify(tm.serialize())));
        expect(back.rule.opacity).toBe(0.75);
        expect(back.slots.length).toBe(1);
        const s = back.slots[0];
        expect(s.id).toBe('slot_rock');
        expect(s.name).toBe('Rock');
        expect(s.surfaceMaterialId).toBe('mat-rock');
        expect(s.tiling).toBe(35);
        expect(s.allowFoliage).toBe(false);
        expect(s.rule).toEqual(rule);
        // The slot's surface is a PLAIN material of its own base type, never a terrain one.
        expect(s.material).not.toBeInstanceOf(TerrainMaterial);
        expect(s.material.type).toBe(rock.type);
        expect(s.material.properties.get('roughness')).toBe(0.9);
    });

    it('a slot whose surface was saved as a terrain material still parses as a plain one', () => {
        const nested = TerrainMaterial.Create('basic', { color: [1, 0, 0] }).serialize();
        const slot = TerrainMaterial.parseSlot({ id: 'x', material: nested });
        expect(slot.material).not.toBeInstanceOf(TerrainMaterial);
    });

    it('a slot with nothing but a surface fills in sane defaults', () => {
        const slot = TerrainMaterial.parseSlot({ material: Material.Basic({}).serialize() });
        expect(slot.id).toMatch(/^slot_/);
        expect(slot.tiling).toBe(20);
        expect(slot.allowFoliage).toBe(true);
        expect(slot.rule).toEqual(defaultBlendRule());
        expect(slot.surfaceMaterialId).toBeNull();
    });
});

describe('migration of materials saved before rules existed', () => {
    it('a material with auto off gets an open rule', () => {
        const old = { ...TerrainMaterial.Create('basic').serialize(), auto: false, hRange: [5, 6], rule: undefined };
        const tm = TerrainMaterial.parse(old);
        expect(tm.rule.elevation.enabled).toBe(false);
        expect(tm.rule.slope.enabled).toBe(false);
        expect(tm.slots).toEqual([]);
        expect(tm.allowFoliage).toBe(true);
    });

    it('an auto material keeps its elevation band exactly', () => {
        const old = { ...TerrainMaterial.Create('basic').serialize(), auto: true, hRange: [20, 60], sRange: [0, 1], rule: undefined };
        const tm = TerrainMaterial.parse(old);
        expect(tm.rule.elevation.enabled).toBe(true);
        for (const y of [17, 18, 20, 22, 40, 58, 60, 62, 63])
            expect(rangeCoverage(tm.rule.elevation, y))
                .toBeCloseTo(smoothstep(18, 22, y) * (1 - smoothstep(58, 62, y)), 9);
    });

    it('the old height blend exponent maps onto the 0..1 transition sharpness', () => {
        const old = { ...TerrainMaterial.Create('basic').serialize(), heightBlend: 4, rule: undefined };
        expect(TerrainMaterial.parse(old).rule.heightBlend).toBe(0.5);
        expect(legacyHeightBlendToRule(0)).toBe(0);
        expect(legacyHeightBlendToRule(99)).toBe(1);
    });

    it('a saved rule wins over the legacy fields beside it', () => {
        const tm = TerrainMaterial.Create('basic');
        tm.auto = true;
        tm.rule = defaultBlendRule();
        tm.rule.opacity = 0.4;
        const back = TerrainMaterial.parse(tm.serialize());
        expect(back.rule.opacity).toBe(0.4);
        expect(back.rule.elevation.enabled).toBe(false);
    });
});
