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
    it("writes each surface's height flag and depth-map invert into the stack's arrays", () => {
        const terrain = new Terrain({ size: 32, resolution: 9 });
        const tm = TerrainMaterial.Create('pbr', {});
        tm.textures.set('displacementMap', 'height-id');
        tm.displacementScale = 0.11;
        tm.invertHeight = true;
        terrain.setLayer(1, tm);                       // shim index 1 = the first paint layer
        const material = (terrain as any)._material;
        terrain.layerStack.writeUniforms(material);
        const p = material.properties as Map<string, any>;

        // No base material, so the paint layer's one slot is the whole stack.
        expect(p.get('u_surfCount')).toBe(1);
        // CARRIED THROUGH, not negated: the invert flag means what it means on a mesh.
        expect(p.get('u_surfColor')[3], 'invert rides in the colour alpha').toBe(1);
        expect(p.get('u_surfFlags')[3], 'the height map is present').toBe(1);
        expect(p.get('u_surfMaterial')[3], 'painted through mask channel 0').toBe(0);
        // Relief is not marched on terrain, but the authored number is kept on the material.
        expect(terrain.layers[1].dispScale, 'the layer keeps what was authored').toBe(0.11);
    });

    it('an untouched terrain draws its flat base colour, every surface slot zeroed', () => {
        const terrain = new Terrain({ size: 32, resolution: 9 });
        const p = (terrain as any)._material.properties as Map<string, any>;
        expect(p.get('u_surfCount')).toBe(0);
        for (const name of ['u_surfColor', 'u_surfMaterial', 'u_surfFlags', 'u_surfElevation', 'u_surfSlope', 'u_surfNoise', 'u_surfBlend']) {
            const v = p.get(name);
            expect(v.length, `${name} is written whole`).toBe(64);
            expect(Array.from(v).every((x: number) => x === 0), name).toBe(true);
        }
    });

    it('the base slot 0 is a fill, and the elevation rule is measured from the landscape origin', () => {
        const terrain = new Terrain({ size: 32, resolution: 9 });
        terrain.setLayer(0, TerrainMaterial.Create('basic', {}));
        terrain.setOrigin([0, 12, 0] as any);
        const material = (terrain as any)._material;
        terrain.layerStack.setOriginY(12);
        terrain.layerStack.writeUniforms(material);
        const p = material.properties as Map<string, any>;
        expect(p.get('u_surfMaterial')[3]).toBe(-2);
        expect(p.get('u_elevRemap')).toEqual([1, -12]);
    });
});

describe('the four-slot shim over the layer stack', () => {
    it('never writes a per-layer override into the material it was handed', () => {
        // The landscape-material preview passes the material being EDITED with a preview-scaled tiling;
        // writing that into the material would get it saved.
        const terrain = new Terrain({ size: 32, resolution: 9 });
        const tm = TerrainMaterial.Create('basic', {});
        tm.tiling = 20;
        terrain.setLayer(0, tm, { tiling: 0.8, auto: false });
        expect(tm.tiling, 'the caller keeps its value').toBe(20);
        expect(terrain.layers[0].tiling, 'the layer gets the override').toBe(0.8);
    });

    it('maps index 0 to the base and i >= 1 to the i-th paint layer, creating layers on demand', () => {
        const terrain = new Terrain({ size: 32, resolution: 9 });
        terrain.setLayer(2, TerrainMaterial.Create('basic', {}), { materialId: 'm2' });
        expect(terrain.layerStack.paintLayers.length).toBe(2);
        expect(terrain.layerStack.paintLayers[1].materialId).toBe('m2');
        expect(terrain.layers.map(l => l.materialId)).toEqual([null, null, 'm2']);
    });
});
