import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { TerrainMaterial } from '../src/graphics/material';
import { Terrain, TERRAIN_RELIEF_ENABLED } from '../src/terrain/terrain';

/**
 * A terrain paint layer treats its height map exactly as a standard PBR material does.
 *
 * Terrain's parallax march was removed once and is back, so the risk this guards is the plumbing going
 * missing again silently: `displacementScale` and `invertHeight` have to survive a save/load AND reach
 * the shader as the per-layer `u_dispScale{i}` / `u_invertHeight{i}` the layer stack reads. A material
 * that round-trips but never writes its uniforms renders flat with nothing to say so.
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

describe('a terrain material carries the same height controls a PBR material does', () => {
    it.each(['basic', 'pbr', 'blinn_phong'] as const)('round-trips depth and invert on a %s base', (base) => {
        const tm = TerrainMaterial.Create(base, {});
        tm.textures.set('displacementMap', 'height-id');
        tm.displacementScale = 0.17;
        tm.invertHeight = true;
        tm.heightBlend = 2.5;

        const back = TerrainMaterial.parse(tm.serialize());
        expect(back.textures.get('displacementMap')).toBe('height-id');
        expect(back.displacementScale).toBe(0.17);
        expect(back.invertHeight).toBe(true);
        expect(back.heightBlend).toBe(2.5);
    });

    it('defaults depth to the same 0.05 a standard material uses', () => {
        expect(TerrainMaterial.Create('pbr', {}).displacementScale).toBe(0.05);
        expect(TerrainMaterial.parse({ type: 'pbr', terrainMaterial: true }).displacementScale).toBe(0.05);
    });

    it('does not resurrect a stored value as something else', () => {
        // A project saved while terrain did NOT displace has no displacementScale at all; it must come
        // back as the default rather than undefined, or the uniform writes NaN.
        const back = TerrainMaterial.parse({ type: 'pbr', terrainMaterial: true, heightBlend: 3 });
        expect(Number.isFinite(back.displacementScale)).toBe(true);
        expect(back.invertHeight).toBe(false);
    });
});

describe('the layer uniforms actually reach the material', () => {
    it('writes u_dispScale{i} and u_invertHeight{i} per layer', () => {
        const terrain = new Terrain({ size: 32, resolution: 9 });
        const tm = TerrainMaterial.Create('pbr', {});
        tm.textures.set('displacementMap', 'height-id');
        tm.displacementScale = 0.11;
        tm.invertHeight = true;
        terrain.setLayer(1, tm);

        const p = (terrain as any)._material.properties as Map<string, any>;
        // ZERO WHILE TERRAIN RELIEF IS OFF, and that is the assertion — `TERRAIN_RELIEF_ENABLED` is the
        // switch, and writing the authored depth anyway would leave a march running that the flag says
        // is off. The layer still HOLDS what was authored, so nothing is lost and re-enabling is one
        // constant.
        expect(p.get('u_dispScale1')).toBe(TERRAIN_RELIEF_ENABLED ? 0.11 : 0);
        expect((terrain as any)._layers[1].dispScale, 'the layer keeps what was authored').toBe(0.11);
        // CARRIED THROUGH, not negated. Terrain used to read this slot as a DEPTH map while every
        // other material read it as a HEIGHT map, so `_deriveLayerSurface` flipped it on the way to the
        // layer; that divergence existed only because terrain relief was geometry, which adds, against
        // a march, which carves. Terrain marches now and the flag means one thing everywhere.
        expect(p.get('u_invertHeight1')).toBe(tm.invertHeight ? 1 : 0);
    });

    it('an untouched layer keeps inert defaults rather than undefined', () => {
        const terrain = new Terrain({ size: 32, resolution: 9 });
        const p = (terrain as any)._material.properties as Map<string, any>;
        for (let i = 0; i < 4; i++) {
            expect(Number.isFinite(p.get(`u_dispScale${i}`)), `u_dispScale${i}`).toBe(true);
            expect(p.get(`u_invertHeight${i}`), `u_invertHeight${i}`).toBe(0);
        }
    });
});
