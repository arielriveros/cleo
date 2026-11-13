import { describe, it, expect } from 'vitest';
import { Tileset } from '../src/graphics/tilemap/tileset';
import { Sprite } from '../src/graphics/sprite';
import { usageFromSceneJson, createProgramUsage } from '../src/graphics/programUsage';
import { FORWARD_PROGRAMS } from '../src/graphics/render/programs';

// Lit sprites (Sprite.lit): the tileset carries the lighting maps -- six-way lightmaps for smoke, or a
// normal and an ORM map for a surface -- and a lit sprite draws with the `spriteLit` program through a
// private material kept in step with the sprite and its tileset. Pinned here: the data round-trips without
// churning old files, the mode follows the maps, and an unlit sprite still draws exactly as before.

const tileset = (maps: Partial<Record<'sixWayPositiveTextureId' | 'sixWayNegativeTextureId' | 'normalTextureId' | 'ormTextureId', string>> = {}) => new Tileset({
    id: 'smoke', textureId: 'smoke.png',
    imageWidth: 1024, imageHeight: 2048, tileWidth: 128, tileHeight: 256,
    columns: 8, rows: 8, ...maps,
});

describe('Tileset lighting maps', () => {
    it('are absent by default, and leave the serialized form untouched', () => {
        const ts = tileset();
        expect(ts.lighting).toBe('flat');
        expect(ts.lightingTextureIds).toEqual([]);
        const json = ts.serialize();
        for (const key of ['sixWayPositiveTextureId', 'sixWayNegativeTextureId', 'normalTextureId', 'ormTextureId'])
            expect(key in json, key).toBe(false);
    });

    it('round-trip through serialize/parse', () => {
        const ts = Tileset.parse(tileset({ sixWayPositiveTextureId: 'p.png', sixWayNegativeTextureId: 'n.png' }).serialize());
        expect(ts.sixWayPositiveTextureId).toBe('p.png');
        expect(ts.sixWayNegativeTextureId).toBe('n.png');
        expect(ts.lightingTextureIds).toEqual(['p.png', 'n.png']);
    });

    it('pick the mode: six-way needs both of its maps, a surface a normal map', () => {
        expect(tileset({ sixWayPositiveTextureId: 'p', sixWayNegativeTextureId: 'n' }).lighting).toBe('sixWay');
        expect(tileset({ sixWayPositiveTextureId: 'p' }).lighting).toBe('flat');
        expect(tileset({ normalTextureId: 'nrm', ormTextureId: 'orm' }).lighting).toBe('surface');
        expect(tileset({ normalTextureId: 'nrm', sixWayPositiveTextureId: 'p', sixWayNegativeTextureId: 'n' }).lighting).toBe('sixWay');
        expect(tileset({ ormTextureId: 'orm' }).lighting).toBe('flat');
    });
});

describe('Sprite.lit', () => {
    it('is off by default and serializes only when on', () => {
        const sprite = new Sprite({ tileset: tileset() });
        expect(sprite.lit).toBe(false);
        expect('lit' in sprite.serialize()).toBe(false);
        sprite.lit = true;
        expect(sprite.serialize().lit).toBe(true);
        expect(Sprite.parse(sprite.serialize()).lit).toBe(true);
    });

    it('an unlit sprite draws with its Basic material, untouched', () => {
        const sprite = new Sprite({ tileset: tileset({ normalTextureId: 'nrm' }) });
        expect(sprite.drawMaterial()).toBe(sprite.material);
        expect(sprite.material.type).toBe('basic');
    });

    it('a six-way sprite binds the lightmaps beside its colour atlas', () => {
        const sprite = new Sprite({ tileset: tileset({ sixWayPositiveTextureId: 'p.png', sixWayNegativeTextureId: 'n.png' }), lit: true, tint: [0.5, 0.5, 0.5], opacity: 0.8 });
        const m = sprite.drawMaterial();
        expect(m.type).toBe('spriteLit');
        expect(m.textures.get('texture')).toBe('smoke.png');
        expect(m.textures.get('mapA')).toBe('p.png');
        expect(m.textures.get('mapB')).toBe('n.png');
        expect(m.properties.get('mode')).toBe(1);
        expect(m.properties.get('color')).toEqual([0.5, 0.5, 0.5]);
        expect(m.properties.get('opacity')).toBe(0.8);
        // Kept in step: a later change of tint reaches the lit material on the next draw.
        sprite.tint = [1, 0, 0];
        expect(sprite.drawMaterial().properties.get('color')).toEqual([1, 0, 0]);
        expect(sprite.drawMaterial()).toBe(m);
    });

    it('a surface sprite binds its normal and ORM maps, and a flat one none', () => {
        const surface = new Sprite({ tileset: tileset({ normalTextureId: 'nrm.png', ormTextureId: 'orm.png' }), lit: true }).drawMaterial();
        expect([surface.textures.get('mapA'), surface.textures.get('mapB'), surface.properties.get('mode'), surface.properties.get('hasOrm')])
            .toEqual(['nrm.png', 'orm.png', 2, true]);
        const flat = new Sprite({ tileset: tileset(), lit: true }).drawMaterial();
        expect(flat.textures.has('mapA')).toBe(false);
        expect(flat.textures.has('mapB')).toBe(false);
        expect(flat.properties.get('mode')).toBe(0);
    });

    it('draws through a registered forward program, which a published game ships when a scene has a lit sprite', () => {
        expect(FORWARD_PROGRAMS.spriteLit).toBeTruthy();
        const names = (FORWARD_PROGRAMS.spriteLit.resources as any[]).map(r => r.glslName);
        for (const n of ['u_material_texture', 'u_material_mapA', 'u_material_mapB', 'u_sceneDepth', 'u_shadowCascades'])
            expect(names, n).toContain(n);
        const use = createProgramUsage();
        usageFromSceneJson({ type: 'animatedSprite', sprite: { lit: true } }, use);
        expect(use.names.has('spriteLit')).toBe(true);
        const unlit = createProgramUsage();
        usageFromSceneJson({ type: 'animatedSprite', sprite: {} }, unlit);
        expect(unlit.names.has('spriteLit')).toBe(false);
    });
});

describe('lit sprite light radius', () => {
    it('is half the placed quad\'s smaller extent: the depth of medium a light inside the smoke lights', async () => {
        const { mat4 } = await import('gl-matrix');
        const { spriteLightRadius } = await import('../src/graphics/render/sprites2d');
        // The Valley's smoke: 1.5 m wide, 3 m tall.
        expect(spriteLightRadius(mat4.fromScaling(mat4.create(), [1.5, 3, 1]))).toBeCloseTo(0.75, 6);
        // Turned and moved, the extent is the same.
        const m = mat4.fromRotationTranslationScale(mat4.create(), [0, 0.38268, 0, 0.92388], [4, 1, -2], [2, 0.8, 1]);
        expect(spriteLightRadius(m)).toBeCloseTo(0.4, 5);
    });

    it('floors only the six-way and flat modes in the shader; a surface keeps the true distance', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync('src/graphics/shaders/wgsl/spriteLit.wgsl', 'utf8');
        // Per instance since sprites batch: the vertex stage takes spriteLightRadius's formula from the
        // instance's own matrix, and the fragment floors the local lights by it.
        expect(src).toContain('0.5 * min(length(model[0].xyz), length(model[1].xyz))');
        expect(src).toContain('spriteLightRadius = in.params.x;');
        expect(src).toContain('select(cl.light.sourceRadius, max(cl.light.sourceRadius, spriteLightRadius), mode != 2)');
    });
});
