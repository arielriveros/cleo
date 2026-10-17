import { describe, it, expect } from 'vitest';
import { TerrainMaterial, shallowCloneTerrainMaterial, setTerrainSurfaceFrom, Material } from '../src/graphics/material';
import type { TerrainMaterialSlot } from '../src/graphics/material';
import { TerrainLayerStack } from '../src/terrain/terrainLayerStack';
import { defaultBlendRule, MAX_PAINT_LAYERS } from '../src/terrain/terrainLayers';

// Paint-only slots: a slot of the landscape's own (base) material that shows only where it has been
// brushed — the road over the grass. The stack gives each one a mask channel of its own, and the old
// paint layers fold into them.

const mat = (color: number[] = [1, 1, 1]) => TerrainMaterial.Create('basic', { color });
const stack = (res = 16, size = 16) => new TerrainLayerStack(size, res);
const slot = (id: string, manual: boolean, patch: Partial<TerrainMaterialSlot> = {}): TerrainMaterialSlot => ({
    id, name: id, material: Material.Basic({ color: [0.5, 0.4, 0.3] }), surfaceMaterialId: null, tiling: 20,
    rule: defaultBlendRule(), allowFoliage: false, manual, ...patch,
});
const road = { brush: { x: -4, z: 0, radius: 2, falloff: 0 }, amount: 1, target: 1 };

describe('paint-only slots', () => {
    it('get a channel, draw nothing until painted, then exactly where painted', () => {
        const s = stack();
        const base = mat();
        base.slots.push(slot('road', true));
        s.setBase(base);
        expect(s.slotChannel('road')).toBe(0);
        expect(s.paintSlots.map(x => x.id)).toEqual(['road']);

        expect(s.layerWeightsAt(-4, 0, 0, 1, -4, 0).slots).toEqual([1, 0]);
        s.paint('road', road);
        const on = s.layerWeightsAt(-4, 0, 0, 1, -4, 0);
        expect(on.slots[1]).toBeCloseTo(1, 6);
        expect(on.base).toBeCloseTo(1, 6);
        expect(s.layerWeightsAt(5, 5, 0, 1, 5, 5).slots[1]).toBe(0);
    });

    it('an auto slot keeps covering by rule, with no channel', () => {
        const s = stack();
        const base = mat();
        base.slots.push(slot('snow', false));
        s.setBase(base);
        expect(s.slotChannel('snow')).toBeUndefined();
        expect(s.layerWeightsAt(5, 5, 0, 1, 5, 5).slots[1]).toBe(1);
    });

    it('switching paint-only off frees and clears the channel; a new owner starts clean', () => {
        const s = stack();
        const base = mat();
        base.slots.push(slot('road', true));
        s.setBase(base);
        s.fillMask('road', 1);
        const next = shallowCloneTerrainMaterial(base);
        next.slots[0].manual = false;
        s.setBase(next);
        expect(s.slotChannel('road')).toBeUndefined();
        expect(s.masks.coverage(0)).toBe(0);
    });

    it('share the channel budget with paint layers', () => {
        const s = stack();
        for (let i = 0; i < MAX_PAINT_LAYERS - 1; i++) s.addPaintLayer(mat());
        const base = mat();
        base.slots.push(slot('a', true));
        s.setBase(base);
        expect(s.slotChannel('a')).toBe(MAX_PAINT_LAYERS - 1);
        expect(s.addPaintLayer(mat())).toBeNull();
    });

    it('round-trip their channel and mask through serialize/load', () => {
        const s = stack();
        const base = mat();
        base.slots.push(slot('auto', false), slot('road', true));
        s.setBase(base);
        s.paint('road', road);
        const back = stack();
        back.load(JSON.parse(JSON.stringify(s.serialize())));
        expect(back.base.material!.slots.map(x => x.manual)).toEqual([false, true]);
        expect(back.slotChannel('road')).toBe(s.slotChannel('road'));
        expect(back.maskAt('road', -4, 0)).toBeGreaterThan(0.9);
        expect(back.maskAt('road', 5, 5)).toBe(0);
    });

    it('undo snapshots carry the channel map', () => {
        const s = stack();
        s.setBase(mat());
        const before = s.snapshotLayers();
        const next = shallowCloneTerrainMaterial(s.base.material!);
        next.slots.push(slot('road', true));
        s.setBase(next);
        expect(s.slotChannel('road')).toBe(0);
        s.restoreLayers(before);
        expect(s.slotChannel('road')).toBeUndefined();
        s.restoreLayers({ ...before, base: { material: next, materialId: null }, slotChannels: { road: 3 } });
        expect(s.slotChannel('road')).toBe(3);
    });
});

describe('converting paint layers to slots', () => {
    it('keeps every weight, moves the masks, and leaves no paint layers', () => {
        const s = stack();
        const base = mat([0.3, 0.6, 0.2]);
        const rock = defaultBlendRule();
        rock.slope = { enabled: true, min: 35, max: 90, falloff: 0 };
        base.slots.push(slot('rock', false, { rule: rock }));
        s.setBase(base, 'lib-base');
        const a = s.addPaintLayer(mat([0.4, 0.3, 0.2]), { name: 'Road' })!;
        s.paint(a.id, road);
        const b = s.addPaintLayer(mat([0.9, 0.9, 0.9]), { name: 'Half' })!;
        s.fillMask(b.id, 1);
        s.updatePaintLayer(b.id, { opacity: 0.5 });

        const points: [number, number, number][] = [[-4, 0, 1], [5, 5, 1], [5, 5, 0.4], [-4, 0, 0.4]];
        const before = points.map(([x, z, ny]) => s.layerWeightsAt(x, z, 0, ny, x, z));

        expect(s.convertPaintLayersToSlots()).toBe(true);
        expect(s.paintLayers.length).toBe(0);
        expect(s.base.materialId).toBeNull();
        expect(base.slots.length).toBe(1);                 // the linked original was not touched
        const slots = s.base.material!.slots;
        expect(slots.map(x => [x.name, x.manual])).toEqual([['rock', false], ['Road', true], ['Half', true]]);

        points.forEach(([x, z, ny], i) => {
            const w = s.layerWeightsAt(x, z, 0, ny, x, z);
            expect(w.slots[2]).toBeCloseTo(before[i].paint[0], 5);
            expect(w.slots[3]).toBeCloseTo(before[i].paint[1], 5);
            expect(w.slots[0] + w.slots[1]).toBeCloseTo(before[i].base, 5);
        });
    });

    it('does nothing without paint layers', () => {
        const s = stack();
        s.setBase(mat());
        expect(s.convertPaintLayersToSlots()).toBe(false);
    });
});

describe('landscape material helpers', () => {
    it('slot 0 takes a plain material surface and its link round-trips', () => {
        const tm = mat();
        setTerrainSurfaceFrom(tm, Material.PBR({ baseColor: [0.1, 0.2, 0.3], roughness: 0.4, metallic: 0 }));
        tm.surfaceMaterialId = 'm1';
        const back = TerrainMaterial.parse(JSON.parse(JSON.stringify(tm.serialize())));
        expect(back.type).toBe(tm.type);
        expect(back.properties.get('baseColor')).toEqual([0.1, 0.2, 0.3]);
        expect(back.surfaceMaterialId).toBe('m1');
    });

    it('a shallow clone shares surfaces but not the slot list or rules', () => {
        const tm = mat();
        tm.slots.push(slot('a', false));
        const c = shallowCloneTerrainMaterial(tm);
        c.slots[0].rule.opacity = 0.2;
        c.slots.push(slot('b', true));
        expect(tm.slots.length).toBe(1);
        expect(tm.slots[0].rule.opacity).toBe(1);
        expect(c.slots[0].material).toBe(tm.slots[0].material);
    });
});
