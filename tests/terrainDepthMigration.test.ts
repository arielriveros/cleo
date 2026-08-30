import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';
import { TerrainMaterial } from '../src/graphics/material';

/**
 * Relief depth changed unit — tiled uv converted by `size / tiling`, now plain world metres — and every
 * terrain already saved was authored against the old one. Migration scales the stored number by the
 * factor that used to be applied, so a landscape draws exactly what it drew before and only the number
 * in the Depth box changes.
 *
 * The failure worth guarding is not "migration does nothing". It is **migrating twice**: the factor is
 * 10 on a default landscape, so a second pass would square it and turn 5 cm of gravel into 5 metres of
 * cliff. That is what the `depthUnit` marker is for, and it is what the round-trip case below checks.
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
            : objects.has(key) ? () => ({ id: ++n }) : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

/** A terrain with one displaced layer, serialized. */
const blob = (size: number, tiling: number, dispScale: number) => {
    const t = new Terrain({ size, resolution: 17, chunkQuads: 8 });
    const tm = TerrainMaterial.Create('pbr', {});
    tm.textures.set('displacementMap', 'height-id');
    tm.displacementScale = dispScale;
    tm.tiling = tiling;
    t.setLayer(0, tm);
    return t.serialize();
};

const depthOf = (t: Terrain) => (t as any)._layers[0].dispScale;

/**
 * A blob as a project saved before the unit changed actually looks: NEITHER marker.
 *
 * There are two now — `depthUnit` on the terrain, and `depthUnit` inside each embedded terrain material
 * — and `deserialize` migrates only when both are absent. That conjunction is what makes the conversion
 * happen exactly once: a project saved between the two changes has the terrain's marker and an unmarked
 * material whose number is ALREADY metres, and migrating it again would square the factor.
 */
const legacy = (size: number, tiling: number, dispScale: number) => {
    const json = blob(size, tiling, dispScale) as any;
    delete json.depthUnit;
    for (const l of json.layers ?? []) if (l?.material) delete l.material.depthUnit;
    return json;
};

describe('a terrain saved under the METRES unit is converted back', () => {
    // The conversion this file used to pin ran the other way. Relief depth is a fraction of one texture
    // repeat — the same unit a standard material uses, which is what makes a library material read the
    // same on terrain and on a mesh. For a while terrain relief was baked into the terrain's VERTICES
    // instead; geometry works in metres, so every authored depth was multiplied by `size / tiling` and
    // the blob stamped `depthUnit: 'metres'`.
    //
    // That stamp now means "this number was mechanically converted", and the same factor is divided
    // back out so the value returns to what its author typed. A blob WITHOUT the stamp was never
    // converted and must be left exactly alone — which covers everything written before the bake and
    // everything written after it was removed.

    const parsed = (json: any) => {
        const t = Terrain.deserialize(json);
        return (t as any)._layers[0].dispScale as number;
    };
    const blob = (over: any = {}) => ({
        size: 200, resolution: 5, chunkQuads: 4,
        layers: [{ material: { terrainMaterial: true, displacementScale: 0.5, tiling: 20 }, tiling: 20 }],
        ...over,
    });

    it('an unstamped blob is left exactly as stored', () => {
        expect(parsed(blob())).toBeCloseTo(0.5, 12);
    });

    it('a stamped blob has size / tiling divided back out', () => {
        expect(parsed(blob({ depthUnit: 'metres' }))).toBeCloseTo(0.5 * 20 / 200, 12);
    });

    it('using the blob own size and the layer own tiling', () => {
        expect(parsed(blob({ depthUnit: 'metres', size: 400 }))).toBeCloseTo(0.5 * 20 / 400, 12);
        const t50 = blob({ depthUnit: 'metres' });
        t50.layers[0].tiling = 50;
        expect(parsed(t50)).toBeCloseTo(0.5 * 50 / 200, 12);
    });

    it('and it exactly inverts the conversion that produced the stamp', () => {
        // The round trip is the whole claim: whatever the author typed comes back.
        const authored = 0.06, size = 400, tiling = 31;
        const asMetres = authored * size / tiling;          // what the removed migration wrote
        const t = blob({ depthUnit: 'metres', size });
        t.layers[0].tiling = tiling;
        t.layers[0].material.displacementScale = asMetres;
        t.layers[0].material.tiling = tiling;
        expect(parsed(t)).toBeCloseTo(authored, 12);
    });

    it('a degenerate tiling does not divide by zero', () => {
        const t = blob({ depthUnit: 'metres' });
        t.layers[0].tiling = 0;
        expect(Number.isFinite(parsed(t))).toBe(true);
    });
});

describe('nothing stamps the metres marker any more', () => {
    it('so a terrain saved today is never converted tomorrow', () => {
        const t = new Terrain({ size: 200, resolution: 5, chunkQuads: 4 });
        expect((t.serialize() as any).depthUnit).toBeUndefined();
    });

    it('nor does a terrain material', () => {
        expect((TerrainMaterial.Create('pbr', {}).serialize() as any).depthUnit).toBeUndefined();
    });
});

describe('the height polarity is NOT migrated, deliberately', () => {
    // There was a migration here for one round and it was a mistake worth leaving a marker about.
    //
    // Terrain reads its height slot as the DEPTH map it is documented to be, so `_deriveLayerSurface`
    // inverts the material's flag on the way to the layer. The migration flipped the STORED value the
    // other way on load, so that "nothing already authored changes on screen" — and for every saved
    // material that composed to `X -> !X -> X`. Newly created materials were fixed; every existing one
    // rendered exactly as wrongly as before. Preserving the appearance was the error, because the
    // appearance was the bug.
    //
    // So `parse` carries the stored value through untouched, and existing materials flip on load. If a
    // migration is ever added here again, it must not be a second negation.

    it('parse carries the stored value through unchanged', () => {
        for (const v of [true, false])
            expect(TerrainMaterial.parse({ terrainMaterial: true, invertHeight: v } as any).invertHeight,
                   `stored ${v}`).toBe(v);
    });

    it('and serialize writes no polarity marker', () => {
        expect(TerrainMaterial.Create('pbr', {}).serialize().heightPolarity).toBeUndefined();
    });

    it('a round trip is a no-op, however many times it is repeated', () => {
        const tm = TerrainMaterial.Create('pbr', {});
        tm.invertHeight = true;
        let json: any = tm.serialize();
        for (let i = 0; i < 3; i++) {
            const back = TerrainMaterial.parse(json);
            expect(back.invertHeight, `round ${i}`).toBe(true);
            json = back.serialize();
        }
    });
});

