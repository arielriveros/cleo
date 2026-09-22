import { describe, it, expect } from 'vitest';
import { TerrainMaterial } from '../src/graphics/material';
import { TerrainLayerStack, defaultMaskResolution, materialSlots } from '../src/terrain/terrainLayerStack';
import { defaultBlendRule, legacySplatAlphas, compositeWeights, MAX_PAINT_LAYERS } from '../src/terrain/terrainLayers';

// The landscape's layer stack, CPU side: which channel a layer paints, what each layer weighs at a
// point, and the migration of every landscape saved as a four-layer normalized splat. The GPU half
// (`sync`) needs a device and is exercised in the editor, not here.

const mat = (color: number[] = [1, 1, 1]) => TerrainMaterial.Create('basic', { color });
const stack = (res = 16, size = 16) => new TerrainLayerStack(size, res);
const full = { x: 0, z: 0, radius: 100, falloff: 0 };

describe('paint layers', () => {
    it('get the lowest free channel, keep it through a reorder, and give it back when removed', () => {
        const s = stack();
        const a = s.addPaintLayer(mat())!, b = s.addPaintLayer(mat())!, c = s.addPaintLayer(mat())!;
        expect([a.channel, b.channel, c.channel]).toEqual([0, 1, 2]);
        s.movePaintLayer(c.id, 0);
        expect(s.paintLayers.map(l => l.id)).toEqual([c.id, a.id, b.id]);
        expect(c.channel).toBe(2);
        s.removePaintLayer(a.id);
        const d = s.addPaintLayer(mat())!;
        expect(d.channel).toBe(0);
    });

    it('a new layer on a reused channel starts unpainted', () => {
        const s = stack();
        const a = s.addPaintLayer(mat())!;
        s.fillMask(a.id, 1);
        s.removePaintLayer(a.id);
        const b = s.addPaintLayer(mat())!;
        expect(b.channel).toBe(a.channel);
        expect(s.coverage(b.id)).toBe(0);
    });

    it('grows past four layers into another mask slice, up to the cap', () => {
        const s = stack();
        for (let i = 0; i < MAX_PAINT_LAYERS; i++) expect(s.addPaintLayer(mat())).not.toBeNull();
        expect(s.masks.slices).toBe(Math.ceil(MAX_PAINT_LAYERS / 4));
        expect(s.addPaintLayer(mat())).toBeNull();
    });

    it('painting one layer never changes another', () => {
        const s = stack();
        const a = s.addPaintLayer(mat())!, b = s.addPaintLayer(mat())!;
        s.fillMask(a.id, 1);
        s.paint(b.id, { brush: { x: 0, z: 0, radius: 3, falloff: 0 }, amount: 1, target: 1 });
        expect(s.maskAt(a.id, 0, 0)).toBe(1);
        expect(s.maskAt(b.id, 0, 0)).toBe(1);
        expect(s.maskAt(b.id, 6, 6)).toBe(0);
    });

    it('the clear-to-base brush erases every layer under it', () => {
        const s = stack();
        const a = s.addPaintLayer(mat())!, b = s.addPaintLayer(mat())!;
        s.fillMask(a.id, 1); s.fillMask(b.id, 1);
        s.paintAllToZero({ brush: { x: 0, z: 0, radius: 3, falloff: 0 }, amount: 1 });
        expect(s.maskAt(a.id, 0, 0)).toBe(0);
        expect(s.maskAt(b.id, 0, 0)).toBe(0);
        expect(s.maskAt(a.id, 7, 7)).toBe(1);
    });

    it('undo patches restore every layer in a region', () => {
        const s = stack();
        const a = s.addPaintLayer(mat())!;
        const region = { c0: 4, r0: 4, c1: 11, r1: 11 };
        const before = s.readMaskPatches(region);
        s.paint(a.id, { brush: { x: 0, z: 0, radius: 3, falloff: 0 }, amount: 1, target: 1 });
        s.writeMaskPatches(before);
        expect(s.coverage(a.id)).toBe(0);
    });
});

describe('what each layer weighs at a point', () => {
    it('a base with a slope slot, and a road painted over it', () => {
        const s = stack();
        const base = mat([0.3, 0.6, 0.2]);
        const rock = defaultBlendRule();
        rock.slope = { enabled: true, min: 35, max: 90, falloff: 0 };
        base.slots.push({ id: 'r', name: 'Rock', material: mat([0.5, 0.5, 0.5]), surfaceMaterialId: null, tiling: 20, rule: rock, allowFoliage: false });
        s.setBase(base);
        const road = s.addPaintLayer(mat([0.4, 0.3, 0.2]))!;
        s.paint(road.id, { brush: { x: -4, z: 0, radius: 2, falloff: 0 }, amount: 1, target: 1 });

        const flat = s.layerWeightsAt(4, 4, 0, 1, 4, 4);
        expect(flat.base).toBe(1);
        expect(flat.noFoliage).toBe(0);
        const steep = s.layerWeightsAt(4, 4, 0, Math.cos(60 * Math.PI / 180), 4, 4);
        expect(steep.base).toBe(1);            // still the base LAYER...
        expect(steep.noFoliage).toBe(1);       // ...but its rock slot, which forbids foliage
        const onRoad = s.layerWeightsAt(-4, 0, 0, 1, -4, 0);
        expect(onRoad.paint[0]).toBeCloseTo(1, 6);
        expect(onRoad.base).toBeCloseTo(0, 6);
    });

    it('a hidden layer contributes nothing, and layer opacity scales it', () => {
        const s = stack();
        s.setBase(mat());
        const a = s.addPaintLayer(mat())!;
        s.fillMask(a.id, 1);
        s.updatePaintLayer(a.id, { opacity: 0.25 });
        expect(s.layerWeightsAt(0, 0, 0, 1, 0, 0).paint[0]).toBeCloseTo(0.25, 6);
        s.updatePaintLayer(a.id, { visible: false });
        expect(s.layerWeightsAt(0, 0, 0, 1, 0, 0).paint[0]).toBe(0);
    });

    it('flattens every slot of every material, base first', () => {
        const s = stack();
        const base = mat();
        base.slots.push({ id: 'a', name: 'A', material: mat(), surfaceMaterialId: null, tiling: 5, rule: defaultBlendRule(), allowFoliage: true });
        s.setBase(base);
        s.addPaintLayer(mat());
        expect(s.surfaces().map(x => [x.layer, x.slot, x.fill])).toEqual([[0, 0, true], [0, 1, false], [1, 0, false]]);
        expect(materialSlots(base).length).toBe(2);
    });
});

describe('serialization', () => {
    it('round-trips layers, masks and the base', () => {
        const s = stack();
        s.setBase(mat([0.1, 0.2, 0.3]), 'asset-base');
        const a = s.addPaintLayer(mat(), { name: 'Road', materialId: 'asset-road' })!;
        s.paint(a.id, { brush: { x: 0, z: 0, radius: 3, falloff: 0 }, amount: 1, target: 0.5 });
        s.updatePaintLayer(a.id, { opacity: 0.8, visible: false });

        const back = stack();
        back.load(JSON.parse(JSON.stringify(s.serialize())));
        expect(back.base.materialId).toBe('asset-base');
        expect(back.base.material!.properties.get('color')).toEqual([0.1, 0.2, 0.3]);
        const L = back.paintLayers[0];
        expect([L.id, L.name, L.materialId, L.opacity, L.visible, L.channel])
            .toEqual([a.id, 'Road', 'asset-road', 0.8, false, a.channel]);
        expect(back.maskAt(L.id, 0, 0)).toBeCloseTo(s.maskAt(a.id, 0, 0), 6);
    });

    it('resamples masks saved at another resolution', () => {
        const s = stack(16, 16);
        const a = s.addPaintLayer(mat())!;
        s.paint(a.id, { brush: { x: -4, z: 0, radius: 3, falloff: 0 }, amount: 1, target: 1 });
        const back = stack(32, 16);
        back.load(s.serialize());
        expect(back.maskAt(back.paintLayers[0].id, -4, 0)).toBeGreaterThan(0.9);
        expect(back.maskAt(back.paintLayers[0].id, 4, 0)).toBeLessThan(0.1);
    });
});

describe('migration from the four-layer splat', () => {
    it('keeps every layer and reproduces the normalized weights at the samples', () => {
        // A 3x3 splat, vertex-aligned over a 16 m landscape. Masks at 3x3 texels would not line up
        // with vertices, so pick a mask resolution whose texel centres land on them: res 3 over the same
        // footprint puts centres at 1/6, 1/2, 5/6 — only the middle one is a vertex. Test that one.
        const splat = new Uint8Array(3 * 3 * 4);
        const set = (c: number, r: number, w: number[]) => splat.set(w, (r * 3 + c) * 4);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) set(c, r, [255, 0, 0, 0]);
        set(1, 1, [100, 60, 40, 55]);
        const layers = [0, 1, 2, 3].map(k => ({ material: mat([k / 3, 0, 0]).serialize(), materialId: `m${k}`, tiling: 10 + k }));

        const s = stack(3, 16);
        s.loadLegacy(layers, splat, 3, 0);
        expect(s.base.materialId).toBe('m0');
        expect(s.paintLayers.map(l => l.materialId)).toEqual(['m1', 'm2', 'm3']);
        expect(s.paintLayers.map(l => l.material!.tiling)).toEqual([11, 12, 13]);

        const w = s.layerWeightsAt(0, 0, 0, 1, 0, 0);
        const sum = 100 + 60 + 40 + 55;
        expect(w.base).toBeCloseTo(100 / sum, 2);
        expect(w.paint[0]).toBeCloseTo(60 / sum, 2);
        expect(w.paint[1]).toBeCloseTo(40 / sum, 2);
        expect(w.paint[2]).toBeCloseTo(55 / sum, 2);
    });

    it('drops an unused legacy slot but keeps a painted one without a material', () => {
        const splat = new Uint8Array(2 * 2 * 4);
        for (let i = 0; i < 4; i++) splat.set([128, 0, 127, 0], i * 4);
        const s = stack(4, 16);
        s.loadLegacy([{ material: mat().serialize() }, null, null, null], splat, 2);
        expect(s.paintLayers.length).toBe(1);        // legacy layer 2: painted, no material
        expect(s.paintLayers[0].channel).toBe(1);
    });

    it('converts a legacy plain-albedo layer into a Basic landscape material', () => {
        const s = stack(4, 16);
        s.loadLegacy([{ textureId: 'grass.png', tiling: 30 }], null, 0);
        expect(s.base.material!.textures.get('texture')).toBe('grass.png');
        expect(s.base.material!.tiling).toBe(30);
    });

    it('the stick-breaking alphas are exact (the identity the migration relies on)', () => {
        const a = [0, 0, 0], out: number[] = [];
        legacySplatAlphas(100, 60, 40, 55, a);
        compositeWeights([1, a[0], a[1], a[2]], out);
        expect(out.map(x => +(x * 255).toFixed(6))).toEqual([100, 60, 40, 55]);
    });

    it('default mask resolution is twice the height grid, capped', () => {
        expect(defaultMaskResolution(129)).toBe(256);
        expect(defaultMaskResolution(513)).toBe(1024);
        expect(defaultMaskResolution(2049)).toBe(1024);
        expect(defaultMaskResolution(9)).toBe(64);
    });
});

describe('layer snapshots (undo)', () => {
    it('restore the layer list exactly, and leave masks alone', () => {
        const s = stack();
        const a = s.addPaintLayer(mat(), { name: 'A' })!;
        s.fillMask(a.id, 1);
        const snap = s.snapshotLayers();
        const b = s.addPaintLayer(mat(), { name: 'B' })!;
        s.updatePaintLayer(a.id, { name: 'renamed', opacity: 0.2 });
        s.removePaintLayer(a.id);
        s.restoreLayers(snap);
        expect(s.paintLayers.map(l => [l.id, l.name, l.opacity])).toEqual([[a.id, 'A', 1]]);
        expect(s.paintLayer(b.id)).toBeUndefined();
        // Removing cleared A's channel; restoring the list does not bring the paint back (patches do).
        expect(s.coverage(a.id)).toBe(0);
    });

    it('a snapshot is not aliased by later edits', () => {
        const s = stack();
        const a = s.addPaintLayer(mat(), { name: 'A' })!;
        const snap = s.snapshotLayers();
        s.updatePaintLayer(a.id, { name: 'changed' });
        expect(snap.paint[0].name).toBe('A');
    });
});
