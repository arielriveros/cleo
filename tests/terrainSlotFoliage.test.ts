import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';
import { Model } from '../src/graphics/model';
import { Geometry } from '../src/core/geometry';
import {
    Material, TerrainMaterial, TerrainFoliageRule, TerrainMaterialSlot, shallowCloneTerrainMaterial,
    terrainFoliageRules, allTerrainFoliageRules,
} from '../src/graphics/material';
import { defaultBlendRule } from '../src/terrain/terrainLayers';

// Per-slot foliage: each surface of the landscape material (the Ground and every slot) can carry its own
// foliage — grass only on the grass slot — and keep named foliage off wherever it shows (a road slot
// excluding the grass and the trees).

beforeAll(() => {
    let n = 0;
    const constants: Record<string, number> = {
        UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
    };
    const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
    const gl = new Proxy({}, {
        get: (_t, key: string) => (key in constants ? constants[key]
            : objects.has(key) ? () => ({ id: ++n })
            : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

const quadJson = () => new Model(new Geometry(
    [[-1, 0, 0], [1, 0, 0], [1, 2, 0], [-1, 2, 0]], [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
    [[0, 0], [1, 0], [1, 1], [0, 1]], [], [], [0, 1, 2, 0, 2, 3],
), Material.Basic({ color: [1, 1, 1] })).serialize();

const rule = (name: string, id: string, density = 0.4): TerrainFoliageRule =>
    ({ kind: 'mesh', id, name, models: [quadJson()], density, minScale: 1, maxScale: 1 } as TerrainFoliageRule);

const slot = (id: string, patch: Partial<TerrainMaterialSlot> = {}): TerrainMaterialSlot => ({
    id, name: id, material: Material.Basic({ color: [0.5, 0.4, 0.3] }), surfaceMaterialId: null, tiling: 20,
    rule: defaultBlendRule(), allowFoliage: true, manual: true, ...patch,
});

/** A 32 m landscape: grass painted everywhere, a road painted as a disc at (8, 0). */
function landscape(setup: (tm: TerrainMaterial) => void): Terrain {
    const terrain = new Terrain({ size: 32, resolution: 33 });
    const tm = TerrainMaterial.Create('basic', {});
    tm.slots.push(slot('grass'), slot('road'));
    setup(tm);
    terrain.layerStack.setBase(tm);
    terrain.layerStack.fillMask('grass', 1);
    terrain.layerStack.paint('road', { brush: { x: 8, z: 0, radius: 5, falloff: 0 }, amount: 1, target: 1 } as any);
    return terrain;
}

const ON_ROAD: [number, number] = [8, 0];
const ON_GRASS: [number, number] = [-8, -8];

describe('per-surface foliage placement', () => {
    it('a slot\'s own foliage grows only where that slot dominates', () => {
        const t = landscape(tm => { tm.slots[0].foliageInclude = [rule('grass tuft', 'g1')]; });
        expect(t.foliageNamesAllowedAt(...ON_GRASS)).toEqual(['grass tuft']);
        expect(t.foliageNamesAllowedAt(...ON_ROAD)).toEqual([]);           // the road is on top there

        t.generateFoliageEverywhere();
        const layer = t.foliage.find(f => f.name === 'grass tuft')!;
        expect(layer.count).toBeGreaterThan(50);
        let onRoad = 0;
        layer.forEachInstanceNear(8, 0, 4, () => { onRoad++; });
        expect(onRoad).toBe(0);
    });

    it('a slot\'s exclude keeps whole-landscape foliage off it, and nothing else', () => {
        const t = landscape(tm => {
            tm.foliageInclude = [rule('oak', 'o1', 0.05)];
            tm.slots[1].foliageExclude = ['oak'];
        });
        expect(t.foliageNamesAllowedAt(...ON_GRASS)).toEqual(['oak']);
        expect(t.foliageNamesAllowedAt(...ON_ROAD)).toEqual([]);
    });

    it('the Ground carries foliage of its own, which a slot painted over it hides', () => {
        const t = new Terrain({ size: 32, resolution: 33 });
        const tm = TerrainMaterial.Create('basic', {});
        tm.slots.push(slot('road'));
        tm.groundFoliageInclude = [rule('clover', 'c1')];
        t.layerStack.setBase(tm);
        t.layerStack.paint('road', { brush: { x: 8, z: 0, radius: 5, falloff: 0 }, amount: 1, target: 1 } as any);
        expect(t.foliageNamesAllowedAt(...ON_GRASS)).toEqual(['clover']);
        expect(t.foliageNamesAllowedAt(...ON_ROAD)).toEqual([]);
    });

    it('the same model on two slots makes two layers, and pruning keeps both', () => {
        const t = landscape(tm => {
            tm.slots[0].foliageInclude = [rule('bush', 'b-grass')];
            tm.slots[1].foliageInclude = [rule('bush', 'b-road', 0.2)];
        });
        t.generateFoliageEverywhere();
        expect(t.foliage.filter(f => f.count > 0).map(f => f.key).sort()).toEqual(['b-grass', 'b-road']);
        t.pruneFoliage();
        expect(t.foliage.length).toBe(2);
    });
});

describe('per-surface foliage data', () => {
    it('round-trips through serialize/parse, geometry stripped only where a model can rebuild it', () => {
        const tm = TerrainMaterial.Create('basic', {});
        tm.slots.push(slot('grass', { foliageInclude: [rule('tuft', 't1')], foliageExclude: ['oak'] }));
        tm.groundFoliageInclude = [{ ...rule('clover', 'c1'), modelId: 'clover-model' }];
        tm.groundFoliageExclude = ['tuft'];
        const json = JSON.parse(JSON.stringify(tm.serialize()));
        expect(json.groundFoliageInclude[0].models).toBeUndefined();   // rebuilt from its model
        const back = TerrainMaterial.parse(json);
        expect(back.slots[0].foliageInclude!.map(r => r.name)).toEqual(['tuft']);
        expect(back.slots[0].foliageExclude).toEqual(['oak']);
        expect(back.groundFoliageInclude.map(r => r.name)).toEqual(['clover']);
        expect(back.groundFoliageExclude).toEqual(['tuft']);
    });

    it('writes nothing new for a material without per-surface foliage', () => {
        const tm = TerrainMaterial.Create('basic', {});
        tm.slots.push(slot('grass'));
        const json = tm.serialize();
        expect('groundFoliageInclude' in json).toBe(false);
        expect('foliageInclude' in json.slots[0]).toBe(false);
    });

    it('a shallow clone does not share a slot\'s foliage lists', () => {
        const tm = TerrainMaterial.Create('basic', {});
        tm.slots.push(slot('grass', { foliageInclude: [rule('tuft', 't1')] }));
        const c = shallowCloneTerrainMaterial(tm);
        c.slots[0].foliageInclude!.push(rule('weed', 'w1'));
        expect(tm.slots[0].foliageInclude!.length).toBe(1);
    });

    it('terrainFoliageRules walks every list, with its scope', () => {
        const tm = TerrainMaterial.Create('basic', {});
        tm.foliageInclude = [rule('oak', 'o')];
        tm.groundFoliageInclude = [rule('clover', 'c')];
        tm.slots.push(slot('grass', { foliageInclude: [rule('tuft', 't')] }));
        expect(terrainFoliageRules(tm).map(e => [e.rule.name, typeof e.scope === 'string' ? e.scope : e.scope.slotId]))
            .toEqual([['oak', 'all'], ['clover', 'ground'], ['tuft', 'grass']]);
        expect(allTerrainFoliageRules(JSON.parse(JSON.stringify(tm.serialize()))).length).toBe(3);
    });
});
