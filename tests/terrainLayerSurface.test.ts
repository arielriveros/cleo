import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TerrainMaterial, Material } from '../src/graphics/material';
import { deriveSurface } from '../src/terrain/terrainLayers';
import { TerrainLayerStack } from '../src/terrain/terrainLayerStack';
import { albedoPackSpec, normalPackSpec, ormPackSpec, packKey } from '../src/terrain/terrainSurfaceArrays';

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

    it('packs albedo into rgb and REPEATS', () => {
        const spec = albedoPackSpec(surface({ albedoId: 'alb', aoId: 'ao' }));
        expect(spec.r).toEqual({ textureId: 'alb', channel: 0 });
        expect(spec.b).toEqual({ textureId: 'alb', channel: 2 });
        expect(spec.wrapping).toBe('repeat');
    });

    it('an occlusion-only surface keeps white albedo, so the tint alone shows', () => {
        expect(albedoPackSpec(surface({ aoId: 'ao' })).r).toEqual({ constant: 1 });
        expect(ormPackSpec(surface({ aoId: 'ao' })).r).toEqual({ textureId: 'ao', channel: 0 });
    });

    it('packs occlusion, roughness and metallic like the mesh ORM, scalars where a map is missing', () => {
        const separate = ormPackSpec(surface({ aoId: 'ao', roughnessId: 'rough', roughness: 0.4, metallic: 0.2 }));
        expect(separate.r).toEqual({ textureId: 'ao', channel: 0 });
        expect(separate.g).toEqual({ textureId: 'rough', channel: 0 });   // a lone map is grayscale: red
        expect(separate.b).toEqual({ constant: 0.2 });                    // no map: the scalar
        // One ARM texture in all three slots is packed: each slot reads its own channel.
        const arm = ormPackSpec(surface({ aoId: 'arm', roughnessId: 'arm', metallicId: 'arm' }));
        expect([arm.r, arm.g, arm.b]).toEqual([
            { textureId: 'arm', channel: 0 }, { textureId: 'arm', channel: 1 }, { textureId: 'arm', channel: 2 }]);
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

    it('reads occlusion and roughness from the ORM layer, linear, and blends them by the same weights', () => {
        const chunk = readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks', 'terrainStack.wgsl'), 'utf-8');
        // Albedo is sRGB and linearised; occlusion, roughness and metallic come linear from the ORM layer.
        expect(chunk).toMatch(/alb \*= toLinear\(sampleSurfaceArray\(u_surfAlbedo_texture/);
        expect(chunk).toMatch(/occlusion = orm\.r;/);
        expect(chunk).toMatch(/surfRoughness = orm\.g;/);
        expect(chunk).toMatch(/ao \+= w \* occlusion;/);
        // Uncovered ground is unoccluded.
        expect(chunk).toMatch(/ao \+= remaining;/);
    });
});

describe('the look a landscape surface inherits from its PBR material', () => {
    it('reads roughness and metallic maps, and an ARM map in several slots', () => {
        const m = Material.PBR({ baseColor: [1, 1, 1], metallic: 0, roughness: 1 });
        m.textures.set('occlusionMap', 'arm'); m.textures.set('roughnessMap', 'arm'); m.textures.set('metallicMap', 'arm');
        const s = deriveSurface(m, 10);
        expect([s.aoId, s.roughnessId, s.metallicId]).toEqual(['arm', 'arm', 'arm']);
    });

    it('writes ORM presence, normal strength and anti-tiling into their lanes', () => {
        const stack = new TerrainLayerStack(16, 16);
        const tm = TerrainMaterial.Create('pbr', {});
        tm.textures.set('roughnessMap', 'r');
        tm.textures.set('displacementMap', 'h');
        tm.normalStrength = 1.5; tm.antiTiling = 0.4;
        stack.setBase(tm);
        const m = Material.Terrain();
        stack.writeUniforms(m);
        expect(m.properties.get('u_surfFlags')[1]).toBe(1);                       // a roughness map flags the ORM layer
        const blend = m.properties.get('u_surfBlend');
        expect([blend[2], blend[3]]).toEqual([1.5, Math.fround(0.4)]);
    });

    it('round-trips the landscape-only look fields', () => {
        const tm = TerrainMaterial.Create('pbr', {});
        tm.normalStrength = 0.5; tm.antiTiling = 0.7;
        tm.slots.push({ ...TerrainMaterial.parseSlot({}), normalStrength: 2, antiTiling: 0.3 });
        const back = TerrainMaterial.parse(JSON.parse(JSON.stringify(tm.serialize())));
        expect([back.normalStrength, back.antiTiling]).toEqual([0.5, 0.7]);
        expect([back.slots[0].normalStrength, back.slots[0].antiTiling]).toEqual([2, 0.3]);
    });
});

describe('reflectance reaches the landscape', () => {
    it('writes each surface\'s PBR reflectance, 0.5 where the material has none', () => {
        const stack = new TerrainLayerStack(16, 16);
        const tm = TerrainMaterial.Create('pbr', {});
        tm.properties.set('reflectance', 0.8);
        const rock = Material.Basic({ color: [1, 1, 1] });
        tm.slots.push({ ...TerrainMaterial.parseSlot({}), material: rock });
        stack.setBase(tm);
        const m = Material.Terrain();
        stack.writeUniforms(m);
        const shade = m.properties.get('u_surfShade');
        expect([shade[0], shade[4]]).toEqual([Math.fround(0.8), 0.5]);
        expect(shade.length).toBe(64);
    });

    it('the deferred terrain pass writes it to the G-buffer instead of a constant', () => {
        const src = readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'geometryTerrain.wgsl'), 'utf-8');
        expect(src).toMatch(/vec4<f32>\(octN\.x, octN\.y, surface\.reflectance,/);
    });
});
