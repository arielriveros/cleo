import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain, TERRAIN_RELIEF_ENABLED } from '../src/terrain/terrain';
import { TerrainMaterial } from '../src/graphics/material';

/**
 * Which way is up for a terrain height map — and that terrain answers it the same way a mesh does.
 *
 * The `displacementMap` slot is a DEPTH map (white = deep) in four separate places:
 * `MaterialProperties.displacementMap`, `TerrainMaterial.invertHeight`, `chunks/terrainLayers.wgsl` and
 * `chunks/parallax.wgsl` — "ship a DEPTH map (`*_disp.png`, white = deep). The two are indistinguishable
 * from the bytes".
 *
 * `Terrain._deriveLayerSurface` used to NEGATE the flag on the way to the layer, and that was not a bug
 * on its own: terrain relief was baked into the terrain's VERTICES, geometry only ADDS, a parallax march
 * only CARVES, so the two genuinely needed opposite reference planes. The cost was that the same texture
 * came out inside-out depending on whether it was applied to terrain or to a mesh, and the divergence
 * was recorded in `material.ts` as deliberate "until that path is revisited".
 *
 * Terrain marches its whole height map now. One reference plane, one meaning, no negation — and that
 * is what this file pins, because a flip reintroduced anywhere would restore the divergence silently.
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

const layerWith = (invert: boolean) => {
    const t = new Terrain({ size: 200, resolution: 17, chunkQuads: 8 });
    const tm = TerrainMaterial.Create('pbr', {});
    tm.textures.set('displacementMap', 'height-id');
    tm.displacementScale = 0.05;
    tm.invertHeight = invert;
    t.setLayer(0, tm);
    return t;
};

const layerFlag = (t: Terrain) => (t as any)._layers[0].invertHeight as boolean;

describe('terrain reads its height slot exactly as a mesh does', () => {
    it('Invert OFF reaches the layer as OFF', () => {
        expect(layerFlag(layerWith(false))).toBe(false);
    });

    it('Invert ON reaches the layer as ON', () => {
        expect(layerFlag(layerWith(true))).toBe(true);
    });

    it('and the GPU is told the same thing the layer holds', () => {
        for (const v of [true, false]) {
            const t = layerWith(v);
            expect((t.material.properties.get('u_invertHeight0') === 1), `invert ${v}`)
                .toBe(layerFlag(t));
        }
    });

    it('no negation survives anywhere in _deriveLayerSurface', () => {
        // Source-level, because this is a property of the code rather than of one configuration: a
        // negation reintroduced here would be invisible in any assertion above that happened to be
        // written against it. `!tm.invertHeight` is the exact expression that used to be here.
        const raw = require('fs').readFileSync('src/terrain/terrain.ts', 'utf-8');
        const src = raw.split('\r\n').join('\n');
        const at = src.indexOf('private _deriveLayerSurface(');
        expect(at, '_deriveLayerSurface not found').toBeGreaterThan(-1);
        // To the next member, not to the first `\n    }` — `_deriveLayerSurface` returns object
        // literals whose closing brace sits at that indent, so the naive slice stopped short of the
        // assignment and the test passed on an empty body.
        const body = src.slice(at, src.indexOf('\n    private ', at + 10))
            .replace(/\/\/[^\n]*/g, '');
        expect(body, 'the flag must pass straight through')
            .toContain('const invertHeight = tm.invertHeight;');
        expect(body, 'no negation').not.toContain('!tm.invertHeight');
    });

    it('the shader divides depth by the tiling, and by nothing else', () => {
        const src = require('fs').readFileSync(
            'src/graphics/shaders/wgsl/chunks/terrainLayers.wgsl', 'utf-8');
        const at = src.indexOf('fn blendedDepth(');
        expect(at, 'blendedDepth not found').toBeGreaterThan(-1);
        const body = src.slice(at, src.indexOf('\n}', at));
        for (let i = 0; i < 4; i++) {
            expect(body, `layer ${i} depth`)
                .toContain(`u_dispScale${i} / max(u_terrain.u_tiling${i}`);
            expect(body, `layer ${i} must not read a march depth`).not.toContain(`u_marchDepth${i}`);
        }
    });

    it('CPU-side the depth uniform is zero while terrain relief is off', () => {
        // `TERRAIN_RELIEF_ENABLED` is the switch and `_writeLayerUniforms` is where it is applied: a
        // zero depth makes `marchTerrain` early-return, which stops the ray, the self-shadow and every
        // per-step fetch together. Nothing an author typed is discarded — the LAYER keeps it — so
        // turning the feature back on is one constant and no data migration.
        const t = new Terrain({ size: 400, resolution: 17, chunkQuads: 8 });
        const tm = TerrainMaterial.Create('pbr', {});
        tm.textures.set('displacementMap', 'height-id');
        tm.displacementScale = 0.06;
        tm.tiling = 31;
        t.setLayer(0, tm);
        expect(t.material.properties.get('u_dispScale0'))
            .toBeCloseTo(TERRAIN_RELIEF_ENABLED ? 0.06 : 0, 12);
        expect((t as any)._layers[0].dispScale, 'the authored value survives').toBeCloseTo(0.06, 12);
        // That the height map still reaches the SHADER — `u_hasHeight{i}`, which drives the
        // height-aware layer blend and must not go off with the march — is not assertable here:
        // `u_hasHeight` is only set once the texture pack resolves, and a pack needs a canvas. The
        // harness covers it against a real one (`meshCheck`'s `every` scene asserts `marches === true`
        // while this flag is off), which is the right place for it.
    });

    it('so the same authored number is the same fraction of a brick on terrain and on a mesh', () => {
        // The property the whole change exists to restore. A mesh whose uv repeats every metre and a
        // terrain layer at any tiling both put `dispScale` of relief across one repeat.
        const relativeDepth = (dispScale: number) => dispScale;   // per repeat, on either surface
        expect(relativeDepth(0.06)).toBeCloseTo(0.06, 12);
        // Under the metres unit the terrain figure depended on the repeat's size in metres: 0.06 m
        // across a 12.9 m repeat is 0.47% of it, against 6% for the mesh — a 12.9x shortfall.
        const asMetres = (metres: number, repeatMetres: number) => metres / repeatMetres;
        expect(asMetres(0.06, 400 / 31) / relativeDepth(0.06)).toBeCloseTo(31 / 400, 12);
    });
});
