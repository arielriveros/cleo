import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TerrainMaterial, Material } from '../src/graphics/material';
import { deriveSurface } from '../src/terrain/terrainLayers';
import { TerrainLayerStack } from '../src/terrain/terrainLayerStack';
import { albedoPackSpec, normalPackSpec, packKey } from '../src/terrain/terrainSurfaceArrays';

/**
 * Everything a surface is derived from has to reach the shader.
 *
 * This file used to check, as source text, that the four-layer `setLayer` copied every field
 * `_deriveLayerSurface` returned — because terrain ambient occlusion once shipped threaded through the
 * whole chain except ONE assignment, and stayed inert while every gate was green. The layer stack has no
 * field-by-field copy any more (a surface is the derived object itself), so the same guard is now
 * functional: derive, pack, write uniforms, and assert each map arrives where the shader reads it.
 */

describe('surface derivation reads every base type', () => {
    it('pbr', () => {
        const m = Material.PBR({ baseColor: [0.2, 0.3, 0.4], metallic: 0.5, roughness: 0.6 });
        m.textures.set('baseColorTexture', 'alb'); m.textures.set('normalMap', 'nrm');
        m.textures.set('occlusionMap', 'ao'); m.textures.set('displacementMap', 'h');
        const s = deriveSurface(m, 12);
        expect([s.albedoId, s.normalId, s.aoId, s.heightId]).toEqual(['alb', 'nrm', 'ao', 'h']);
        expect([s.metallic, s.roughness, s.tiling]).toEqual([0.5, 0.6, 12]);
        expect(s.color).toEqual([0.2, 0.3, 0.4]);
    });

    it('basic and blinn-phong', () => {
        const b = Material.Basic({ texture: 'tex', color: [1, 0, 0] });
        expect(deriveSurface(b, 1).albedoId).toBe('tex');
        const d = Material.Default({});
        d.textures.set('baseTexture', 'bt');
        d.textures.set('normalMap', 'n');
        const s = deriveSurface(d, 1);
        expect([s.albedoId, s.normalId]).toEqual(['bt', 'n']);
    });
});

describe('surface packing', () => {
    const surface = (over: any = {}) => ({
        albedoId: null, aoId: null, normalId: null, heightId: null, invertHeight: false,
        color: [1, 1, 1], metallic: 0, roughness: 1, tiling: 20, ...over,
    });

    it('packs occlusion into the albedo alpha, albedo into rgb, and REPEATS', () => {
        const spec = albedoPackSpec(surface({ albedoId: 'alb', aoId: 'ao' }));
        expect(spec.r).toEqual({ textureId: 'alb', channel: 0 });
        expect(spec.b).toEqual({ textureId: 'alb', channel: 2 });
        expect(spec.a).toEqual({ textureId: 'ao', channel: 0 });
        expect(spec.wrapping).toBe('repeat');
    });

    it('an occlusion-only surface keeps white albedo, so the tint alone shows', () => {
        const spec = albedoPackSpec(surface({ aoId: 'ao' }));
        expect(spec.r).toEqual({ constant: 1 });
        expect(spec.a).toEqual({ textureId: 'ao', channel: 0 });
    });

    it('packs height into the normal alpha, with a flat normal where there is none', () => {
        const spec = normalPackSpec(surface({ heightId: 'h' }));
        expect([spec.r, spec.g, spec.b]).toEqual([{ constant: 0.5 }, { constant: 0.5 }, { constant: 1 }]);
        expect(spec.a).toEqual({ textureId: 'h', channel: 0 });
        expect(spec.wrapping).toBe('repeat');
    });

    it('re-bakes exactly when an input changes', () => {
        expect(packKey(albedoPackSpec(surface({ albedoId: 'a' })))).toBe(packKey(albedoPackSpec(surface({ albedoId: 'a' }))));
        expect(packKey(albedoPackSpec(surface({ albedoId: 'a' })))).not.toBe(packKey(albedoPackSpec(surface({ albedoId: 'b' }))));
    });
});

describe('what the shader is told', () => {
    it('reports albedo and occlusion presence SEPARATELY', () => {
        // One packed texture, two flags: reusing the albedo flag for occlusion would multiply the
        // packer's white rgb in as if it were an albedo map.
        const stack = new TerrainLayerStack(16, 16);
        const tm = TerrainMaterial.Create('pbr', {});
        tm.textures.set('occlusionMap', 'ao');
        stack.setBase(tm);
        const m = Material.Terrain();
        stack.writeUniforms(m);
        const flags = m.properties.get('u_surfFlags');
        expect([flags[0], flags[1]]).toEqual([0, 1]);
    });

    it('reads occlusion from the albedo alpha, linear, and blends it by the same weights', () => {
        const chunk = readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks', 'terrainStack.wgsl'), 'utf-8');
        // Albedo is sRGB, occlusion is not: one fetch serves both, and only the rgb goes through toLinear.
        expect(chunk).toMatch(/if \(flags\.x > 0\.5\) \{ alb \*= toLinear\(texel\.rgb\); \}/);
        expect(chunk).toMatch(/if \(flags\.y > 0\.5\) \{ occlusion = texel\.a; \}/);
        expect(chunk).toMatch(/ao \+= w \* occlusion;/);
        // Uncovered ground is unoccluded.
        expect(chunk).toMatch(/ao \+= remaining;/);
    });
});
