import { describe, expect, it } from 'vitest';
import { Material, TerrainMaterial } from '../src/graphics/material';

/**
 * The height map survives a save/load on EVERY material type, and legacy terrain blobs still load.
 *
 * `Material.serialize()` writes a FIXED key list per base type rather than dumping `textures`, and for a
 * long time only the `pbr` branch listed a displacement slot. A terrain paint layer can be based on any
 * of the three, so `TerrainMaterial.serialize()` carried the id as a TOP-LEVEL sibling of `textures` to
 * get around that — a terrain-only shape that four separate call sites had to special-case.
 *
 * All three branches carry the slot now and the sibling is gone from the writer. The reader must keep
 * it forever, and that is what most of this file is about: asset JSON on disk is never rewritten until
 * the user re-saves that specific asset, and the shipped `3d-example` stores its terrain height ids at
 * the top level and NOWHERE else. Dropping the legacy read loads those terrains with no height at all —
 * `u_hasHeight{i}` goes to 0 and the height-aware blend silently degrades to a plain linear splat, with
 * nothing logged and nothing to see except slightly wrong layer boundaries.
 */

const HEIGHT = 'height-tex-id';

describe('every material type round-trips a height map', () => {
    it.each([
        ['basic', () => Material.Basic({ color: [1, 1, 1], displacementMap: HEIGHT })],
        ['blinn_phong', () => Material.Default({ textures: { displacementMap: HEIGHT } })],
        ['pbr', () => Material.PBR({ textures: { displacementMap: HEIGHT } })],
    ])('%s', (_type, make) => {
        const back = Material.parse((make() as Material).serialize());
        expect(back.textures.get('displacementMap')).toBe(HEIGHT);
    });

    it('puts the id inside `textures`, where the generic reference walk can see it', () => {
        // editor/src/utils/nodeSubtree.ts only recognises a `textures` slot map. An id anywhere else is
        // invisible to it, which is why the old top-level shape needed three hand-written special cases.
        for (const m of [Material.Basic({ displacementMap: HEIGHT }),
                         Material.Default({ textures: { displacementMap: HEIGHT } }),
                         Material.PBR({ textures: { displacementMap: HEIGHT } })])
            expect(m.serialize().textures.displacementMap).toBe(HEIGHT);
    });

    it('sets hasDisplacementMap in lock step with the texture', () => {
        // The PBR shaders branch on this flag; a texture bound without it marches nothing, and a flag
        // set without a texture marches a sampler nothing bound.
        const withMap = Material.PBR({ textures: { displacementMap: HEIGHT } });
        expect(withMap.properties.get('hasDisplacementMap')).toBe(true);
        expect(Material.PBR({}).properties.get('hasDisplacementMap')).toBe(false);
    });
});

describe('a terrain material round-trips a height map on every base type', () => {
    it.each(['basic', 'pbr', 'blinn_phong'] as const)('%s', (base) => {
        const tm = TerrainMaterial.Create(base, {});
        tm.textures.set('displacementMap', HEIGHT);
        tm.heightBlend = 2.5;

        const back = TerrainMaterial.parse(tm.serialize());
        expect(back.textures.get('displacementMap')).toBe(HEIGHT);
        expect(back.heightBlend).toBe(2.5);
    });

    it('no longer writes the top-level sibling', () => {
        const tm = TerrainMaterial.Create('pbr', {});
        tm.textures.set('displacementMap', HEIGHT);
        const json = tm.serialize();
        expect(json.textures.displacementMap).toBe(HEIGHT);
        expect(json.displacementMap, 'the terrain-only top-level shape is retired').toBeUndefined();
    });
});

describe('legacy blobs still load — the shipped example is one', () => {
    it('reads a top-level displacementMap with no `textures` entry', () => {
        // Exactly the shape in editor/public/examples/3d-example/libraries/terrainMaterials.json.
        const legacy = {
            type: 'pbr', terrainMaterial: true, tiling: 20, heightBlend: 5.5,
            textures: { baseColorTexture: 'diff' },
            displacementMap: HEIGHT,
            displacementScale: 0.05,   // from when terrain displaced; deliberately not migrated
        };
        const tm = TerrainMaterial.parse(legacy);
        expect(tm.textures.get('displacementMap')).toBe(HEIGHT);
        expect(tm.heightBlend).toBe(5.5);
    });

    it('does not let a null sibling clear a value the textures map supplied', () => {
        // A blob written between the two shapes can carry both. The legacy read is truthiness-guarded
        // precisely so the newer, more specific source wins.
        const tm = TerrainMaterial.parse({
            type: 'pbr', terrainMaterial: true,
            textures: { displacementMap: HEIGHT },
            displacementMap: null,
        });
        expect(tm.textures.get('displacementMap')).toBe(HEIGHT);
    });

    it('survives a legacy load followed by a re-save, moving to the new shape', () => {
        const once = TerrainMaterial.parse({
            type: 'blinn_phong', terrainMaterial: true, displacementMap: HEIGHT, heightBlend: 3,
        });
        const json = once.serialize();
        expect(json.textures.displacementMap, 'a re-save migrates it into `textures`').toBe(HEIGHT);
        expect(TerrainMaterial.parse(json).textures.get('displacementMap')).toBe(HEIGHT);
    });
});
