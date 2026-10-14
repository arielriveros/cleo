import { describe, it, expect } from 'vitest';
import { Material, applyUvMapping, uvConfigOf } from '../src/graphics/material';

// Texture mapping on the lit materials: tiling/offset plus box/triplanar projection, so a texture on a
// scaled wall keeps its size. Pinned: every lit type carries the uniforms (an unset member would read 0 —
// zero tiling, every texel one colour), old assets load unchanged and serialize unchanged, and authored
// values round-trip.

const lit = () => [Material.PBR({}), Material.Default({}), Material.Cel({})];

describe('uv mapping defaults', () => {
    it('gives every lit type mesh-uv, tiling 1, offset 0', () => {
        for (const m of lit()) {
            expect(m.properties.get('uvTransform')).toEqual([1, 1, 0, 0]);
            expect(m.properties.get('uvProjection')).toBe(0);
            expect(m.properties.get('uvSpace')).toBe(0);
            expect(m.properties.get('uvWorldSize')).toBe(1);
            expect(m.properties.get('uvBlend')).toBe(4);
        }
    });

    it('writes no uv key at all for a material that never changed them', () => {
        for (const m of lit()) {
            const json = JSON.stringify(m.serialize());
            expect(json).not.toMatch(/"uv[A-Z]/);
        }
    });

    it('loads an asset written before the feature in mesh mode', () => {
        const old = { type: 'pbr', baseColor: [1, 1, 1], metallic: 0, roughness: 1, textures: {} };
        const m = Material.parse(old);
        expect(uvConfigOf(m)).toEqual({
            uvProjection: 'mesh', uvSpace: 'object', uvTiling: [1, 1], uvOffset: [0, 0], uvWorldSize: 1, uvBlend: 4,
        });
    });
});

describe('uv mapping round trip', () => {
    it('survives serialize/parse on every lit type', () => {
        for (const m of lit()) {
            applyUvMapping(m, { uvProjection: 'box', uvSpace: 'world', uvTiling: [2, 3], uvOffset: [0.25, 0.5], uvWorldSize: 2.5, uvBlend: 8 });
            const back = Material.parse(JSON.parse(JSON.stringify(m.serialize())));
            expect(uvConfigOf(back)).toEqual({
                uvProjection: 'box', uvSpace: 'world', uvTiling: [2, 3], uvOffset: [0.25, 0.5], uvWorldSize: 2.5, uvBlend: 8,
            });
            expect(back.properties.get('uvTransform')).toEqual([2, 3, 0.25, 0.5]);
            expect(back.properties.get('uvProjection')).toBe(1);
        }
    });

    it('accepts triplanar and rejects nonsense', () => {
        const m = Material.parse({ type: 'pbr', uvProjection: 'triplanar', uvWorldSize: -3, uvBlend: 0, uvTiling: ['a', 2] });
        expect(m.properties.get('uvProjection')).toBe(2);
        expect(m.properties.get('uvWorldSize')).toBeGreaterThan(0);
        expect(m.properties.get('uvBlend')).toBeGreaterThanOrEqual(1);
        expect(m.properties.get('uvTransform')).toEqual([1, 2, 0, 0]);
        expect(Material.parse({ type: 'pbr', uvProjection: 'sideways' }).properties.get('uvProjection')).toBe(0);
    });
});
