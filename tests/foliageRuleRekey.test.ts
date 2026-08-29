import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';
import { FoliageLayer } from '../src/terrain/foliage';
import { Model } from '../src/graphics/model';
import { Geometry } from '../src/core/geometry';
import { Material, TerrainMaterial, TerrainFoliageRule, foliageRuleKey } from '../src/graphics/material';

/**
 * Foliage layers are filed under a rule's STABLE key, not its display name.
 *
 * Renaming a rule used to orphan its populated layer: the terrain looked up by the new name, missed,
 * built a second layer, and left the scattered instances drawn by one nothing could reach — and which
 * `pruneFoliage` would not collect, because it was not empty.
 *
 * The migration is the delicate half. Every layer saved before this existed is filed under its name, so
 * a lookup that only tried the new key would miss it and strand exactly the instances this is meant to
 * protect.
 */

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

const quadJson = () => {
    const g = new Geometry(
        [[-1, 0, 0], [1, 0, 0], [1, 2, 0], [-1, 2, 0]],
        [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
        [[0, 0], [1, 0], [1, 1], [0, 1]],
        [], [], [0, 1, 2, 0, 2, 3],
    );
    return new Model(g, Material.Basic({ color: [1, 1, 1] })).serialize();
};

const meshRule = (over: Partial<TerrainFoliageRule> = {}): TerrainFoliageRule => ({
    kind: 'mesh', name: 'oak', models: [quadJson()],
    density: 0.01, minScale: 1, maxScale: 1, ...over,
} as TerrainFoliageRule);

/** A terrain whose layer 0 material declares `rule`, with a populated layer already filed under `key`. */
function terrainWith(rule: TerrainFoliageRule, filedUnder: string, instances = 5): Terrain {
    const terrain = new Terrain({ size: 32, resolution: 9 });
    const tm = TerrainMaterial.Create('basic', {});
    tm.foliageInclude = [rule];
    terrain.setLayer(0, tm);
    // Paint layer 0 across the terrain, or the splat is empty, no sample finds a dominant layer, and a
    // "scatter" places nothing at all — which would make the assertions below pass vacuously.
    for (let z = -16; z <= 16; z += 4)
        for (let x = -16; x <= 16; x += 4)
            terrain.paint([x, 0, z], { layer: 0, radius: 8, strength: 40, falloff: 1 } as any, 1);

    const layer = FoliageLayer.fromRule(rule);
    layer.key = filedUnder;                       // simulate however it was filed
    for (let i = 0; i < instances; i++) layer.pushInstance(i, 0, i);
    layer.commit();
    terrain.addFoliage(layer);
    (terrain as any)._foliageByKey.set(filedUnder, layer);
    return terrain;
}

describe('the key a layer is filed under', () => {
    it('prefers the rule id over everything else', () => {
        expect(foliageRuleKey(meshRule({ id: 'RULE', modelId: 'MODEL', name: 'oak' }))).toBe('RULE');
    });

    it('falls back to modelId for a library-linked rule authored before ids existed', () => {
        expect(foliageRuleKey(meshRule({ modelId: 'MODEL', name: 'oak' }))).toBe('MODEL');
    });

    it('falls back to the name, which is exactly the old behaviour', () => {
        expect(foliageRuleKey(meshRule({ name: 'oak' }))).toBe('oak');
    });
});

describe('a rename keeps the scattered instances', () => {
    it('follows the rule and adopts the new display name', () => {
        const rule = meshRule({ id: 'RULE', name: 'oak' });
        const terrain = terrainWith(rule, 'RULE');
        expect(terrain.foliage).toHaveLength(1);

        // The user renames the rule; the material is the same object the terrain holds.
        rule.name = 'birch';
        terrain.refreshFoliagePrototypes();

        // One layer still, still populated, now answering to the new name.
        expect(terrain.foliage).toHaveLength(1);
        expect(terrain.foliage[0].count).toBe(5);
        expect(terrain.foliage[0].name).toBe('birch');
        expect(terrain.foliage[0].key).toBe('RULE');
    });

    it('does not build a second layer for the renamed rule', () => {
        const rule = meshRule({ id: 'RULE', name: 'oak' });
        const terrain = terrainWith(rule, 'RULE');
        rule.name = 'birch';

        // Scattering after the rename must reuse the existing layer, not start a fresh one.
        const placed = terrain.generateFoliageEverywhere().placed;

        expect(placed, 'the scatter must actually place something').toBeGreaterThan(0);
        expect(terrain.foliage).toHaveLength(1);
    });

    it('does not collect a renamed rule as an orphan', () => {
        const rule = meshRule({ id: 'RULE', name: 'oak' });
        const terrain = terrainWith(rule, 'RULE', 0);   // empty, so prune is free to take it
        rule.name = 'birch';

        expect(terrain.pruneFoliage()).toBe(0);
        expect(terrain.foliage).toHaveLength(1);
    });
});

describe('migrating a layer filed under the old name key', () => {
    it('re-files it under the stable key on the first refresh', () => {
        // Exactly what a project saved before this change looks like: filed by name, rule has an id.
        const rule = meshRule({ id: 'RULE', name: 'oak' });
        const terrain = terrainWith(rule, 'oak');

        terrain.refreshFoliagePrototypes();

        const byKey = (terrain as any)._foliageByKey as Map<string, FoliageLayer>;
        expect(byKey.get('RULE')).toBe(terrain.foliage[0]);
        expect(byKey.has('oak')).toBe(false);
        expect(terrain.foliage[0].key).toBe('RULE');
        expect(terrain.foliage[0].count).toBe(5);
    });

    it('reuses the SAME layer object rather than rebuilding one beside it', () => {
        // Identity is what makes this test able to fail. A rebuild-and-prune leaves exactly one layer
        // with the right key too, so counting layers cannot tell the two apart — only "is it still the
        // object that held the instances" can.
        const rule = meshRule({ id: 'RULE', name: 'oak' });
        const terrain = terrainWith(rule, 'oak');
        const original = terrain.foliage[0];

        const placed = terrain.generateFoliageEverywhere().placed;

        expect(placed, 'the scatter must actually place something').toBeGreaterThan(0);
        expect(terrain.foliage).toHaveLength(1);
        expect(terrain.foliage[0]).toBe(original);
        expect(terrain.foliage[0].key).toBe('RULE');
    });
});

describe('the key survives a save/load', () => {
    it('round-trips, so a reload does not re-file everything by name', () => {
        const layer = FoliageLayer.fromRule(meshRule({ id: 'RULE', name: 'oak' }));
        layer.pushInstance(0, 0, 0);
        layer.commit();

        const back = FoliageLayer.deserialize(layer.serialize());
        expect(back.key).toBe('RULE');
        expect(back.name).toBe('oak');
    });

    it('defaults to the name for a blob written before keys existed', () => {
        const layer = FoliageLayer.fromRule(meshRule({ name: 'oak' }));
        const json = layer.serialize();
        delete json.key;   // a pre-migration save

        expect(FoliageLayer.deserialize(json).key).toBe('oak');
    });
});
