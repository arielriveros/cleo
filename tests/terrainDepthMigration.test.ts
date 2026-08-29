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

describe('a terrain saved under the old unit', () => {
    it('comes back scaled by size / tiling, so it renders unchanged', () => {
        // 200 m at tiling 20 is a factor of 10: a stored 0.05 was drawing 0.5 m, and after migration it
        // says 0.5 m. Same picture, honest number.
        expect(depthOf(Terrain.deserialize(legacy(200, 20, 0.05)))).toBeCloseTo(0.5, 10);
    });

    it('uses the terrain&apos;s own size, not a fixed one', () => {
        // The old unit depended on the terrain, which is exactly why it had to go — and why the
        // migration has to be per terrain rather than a single constant.
        for (const [size, tiling, stored, expected] of
                [[400, 20, 0.05, 1.0], [100, 10, 0.02, 0.2], [24, 8, 0.35, 1.05]] as number[][]) {
            expect(depthOf(Terrain.deserialize(legacy(size, tiling, stored))), `${size}m/${tiling}`)
                .toBeCloseTo(expected, 10);
        }
    });

    it('is not migrated a second time', () => {
        // The one that would destroy content: the factor squares, and 5 cm becomes 5 m.
        const once = Terrain.deserialize(legacy(200, 20, 0.05));
        expect(depthOf(once)).toBeCloseTo(0.5, 10);

        const again = Terrain.deserialize(once.serialize());
        expect(depthOf(again), 'the marker must stop a second pass').toBeCloseTo(0.5, 10);
    });

    it('a blob already carrying the marker is left alone', () => {
        const json = blob(200, 20, 0.05);
        expect((json as any).depthUnit).toBe('metres');
        expect(depthOf(Terrain.deserialize(json))).toBeCloseTo(0.05, 10);
    });

    it('a degenerate tiling does not divide by zero', () => {
        expect(Number.isFinite(depthOf(Terrain.deserialize(legacy(200, 0, 0.05))))).toBe(true);
    });

    it('the terrain marker alone is enough to stop it', () => {
        // A project saved between the two changes: the terrain carries `depthUnit` and its embedded
        // material does not, because materials only started stamping it later. That number is already
        // metres, and migrating on the missing material marker would square the factor.
        const json = blob(200, 20, 0.05) as any;
        for (const l of json.layers ?? []) if (l?.material) delete l.material.depthUnit;
        expect(depthOf(Terrain.deserialize(json))).toBeCloseTo(0.05, 10);
    });
});

describe('the marker is written on every save', () => {
    it('so a terrain saved today is never migrated tomorrow', () => {
        expect((blob(200, 20, 0.05) as any).depthUnit).toBe('metres');
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

describe('reliefDetail survives the round trip', () => {
    it('defaults to 1 and carries its value', () => {
        expect(TerrainMaterial.parse({ terrainMaterial: true } as any).reliefDetail).toBe(1);
        const tm = TerrainMaterial.Create('pbr', {});
        tm.reliefDetail = 6;
        expect(TerrainMaterial.parse(tm.serialize()).reliefDetail).toBe(6);
    });
});

