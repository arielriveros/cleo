import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';
import { TerrainMaterial } from '../src/graphics/material';
import { deriveSurface } from '../src/terrain/terrainLayers';

/**
 * Which way is up for a terrain height map — and that terrain answers it the same way a mesh does.
 *
 * The `displacementMap` slot is a DEPTH map (white = deep) and `invertHeight` says "my source is already
 * a height map". Terrain once NEGATED that flag on the way to the layer, because its relief was geometry
 * (which adds) against a march (which carves). The march is retired now, but the height map still
 * decides which way a surface's transition leans, so the flag still has to mean exactly what it means on
 * a mesh. That is what this file pins: a negation reintroduced anywhere would flip every height-blended
 * edge silently.
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

const baseWith = (invert: boolean) => {
    const t = new Terrain({ size: 200, resolution: 17, chunkQuads: 8 });
    const tm = TerrainMaterial.Create('pbr', {});
    tm.textures.set('displacementMap', 'height-id');
    tm.invertHeight = invert;
    t.setLayer(0, tm);
    return t;
};

describe('terrain reads its height slot exactly as a mesh does', () => {
    it('Invert reaches the layer unchanged, OFF and ON', () => {
        expect(baseWith(false).layers[0].invertHeight).toBe(false);
        expect(baseWith(true).layers[0].invertHeight).toBe(true);
    });

    it('and the GPU is told the same thing the layer holds', () => {
        for (const v of [true, false]) {
            const t = baseWith(v);
            t.layerStack.writeUniforms(t.material);
            expect(t.material.properties.get('u_surfColor')[3] === 1, `invert ${v}`).toBe(v);
        }
    });

    it('a slot surface reads its own material flag the same way', () => {
        const plain = TerrainMaterial.Create('pbr', {});
        plain.properties.set('invertHeight', true);
        expect(deriveSurface(plain, 20, !!plain.properties.get('invertHeight')).invertHeight).toBe(true);
    });

    it('no negation survives in the derivation', () => {
        // Source-level: a property of the code rather than of one configuration.
        const src = readFileSync('src/terrain/terrainLayerStack.ts', 'utf-8').replace(/\/\/[^\n]*/g, '');
        expect(src, 'slot 0 passes the flag straight through').toContain('deriveSurface(tm, tm.tiling, tm.invertHeight)');
        expect(src, 'no negation').not.toContain('!tm.invertHeight');
    });

    it('the shader applies it as a plain select, not a second flip', () => {
        const src = readFileSync('src/graphics/shaders/wgsl/chunks/terrainStack.wgsl', 'utf-8');
        expect(src).toContain('select(texel.a, 1.0 - texel.a, color.a > 0.5)');
    });
});
