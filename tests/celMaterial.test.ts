import { describe, expect, it, beforeAll } from 'vitest';
import { Material } from '../src/graphics/material';
import { AnimatedModel } from '../src/graphics/animatedModel';
import { Geometry } from '../src/core/geometry';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';

/**
 * The Cel material's serialize/parse round trip.
 *
 * Worth its own file because a fourth shading model is the case every fallthrough in this codebase was
 * written against. `Material.serialize` ends in `else { type: 'blinn_phong', ... }` and `Material.parse`
 * ends in `else { Material.Default(...) }`, so a type with no branch of its own does not fail — it is
 * silently REWRITTEN, dropping every property it had and stamping a different type into the saved file.
 * The `type` assertions below are the ones that catch that; the property assertions only catch typos.
 *
 * `AnimatedModel` carries a SECOND copy of both functions, with its own `normalizeType`. Fixing only
 * `material.ts` leaves skinned meshes broken, so the same round trip runs through it as well.
 */

/**
 * The same stub context tests/submeshRoundTrip.test.ts uses. `Mesh` allocates a VAO and buffers in its
 * constructor and `AnimatedModel` uploads bone attributes eagerly, so building one calls into the device
 * even though nothing is ever drawn. Unknown members resolve to a no-op rather than being enumerated.
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
            : objects.has(key) ? () => ({ id: ++n })
            : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

const FULL = {
    diffuse: [0.2, 0.4, 0.6],
    ambient: [0.1, 0.1, 0.2],
    specular: [0.9, 0.8, 0.7],
    emissive: [0.3, 0.0, 0.1],
    emissiveIntensity: 2.5,
    shininess: 64,
    opacity: 0.75,
    alphaCutoff: 0.25,
    bands: 5,
    bandSoftness: 0.15,
    specularThreshold: 0.8,
    rimColor: [1, 0.5, 0.25],
    rimPower: 7,
    rimStrength: 1.5,
    textures: {
        base: 'base-id', ramp: 'ramp-id', normal: 'normal-id',
        emissive: 'emissive-id', mask: 'mask-id', displacementMap: 'height-id',
    },
};

describe('a Cel material survives serialize -> parse', () => {
    it('comes back as cel, not as blinn_phong', () => {
        // THE assertion. Everything else in this file passes even when the serialize fallthrough has
        // swallowed the material, because Material.Default happens to store several of the same keys.
        const back = Material.parse(Material.Cel(FULL as any).serialize());
        expect(back.type).toBe('cel');
    });

    it('keeps every scalar and colour', () => {
        const back = Material.parse(Material.Cel(FULL as any).serialize());
        expect(back.properties.get('diffuse')).toEqual([0.2, 0.4, 0.6]);
        expect(back.properties.get('ambient')).toEqual([0.1, 0.1, 0.2]);
        expect(back.properties.get('specular')).toEqual([0.9, 0.8, 0.7]);
        expect(back.properties.get('emissive')).toEqual([0.3, 0.0, 0.1]);
        expect(back.properties.get('emissiveIntensity')).toBe(2.5);
        expect(back.properties.get('shininess')).toBe(64);
        expect(back.properties.get('opacity')).toBe(0.75);
        expect(back.properties.get('alphaCutoff')).toBe(0.25);
        expect(back.properties.get('bands')).toBe(5);
        expect(back.properties.get('bandSoftness')).toBe(0.15);
        expect(back.properties.get('specularThreshold')).toBe(0.8);
        expect(back.properties.get('rimColor')).toEqual([1, 0.5, 0.25]);
        expect(back.properties.get('rimPower')).toBe(7);
        expect(back.properties.get('rimStrength')).toBe(1.5);
    });

    it('keeps every texture slot, under the runtime map keys', () => {
        // The authoring spellings differ from the runtime keys (`base`/`baseTexture`, `ramp`/`rampMap`,
        // `mask`/`maskMap`), exactly as they do for Basic and Blinn-Phong. Anything that walks the
        // serialized `textures` object generically stays correct across that split; a hand-written list
        // of slot names would not, which is why the editor's reference walks are generic.
        const back = Material.parse(Material.Cel(FULL as any).serialize());
        expect(back.textures.get('baseTexture')).toBe('base-id');
        expect(back.textures.get('rampMap')).toBe('ramp-id');
        expect(back.textures.get('normalMap')).toBe('normal-id');
        expect(back.textures.get('emissiveMap')).toBe('emissive-id');
        expect(back.textures.get('maskMap')).toBe('mask-id');
        expect(back.textures.get('displacementMap')).toBe('height-id');
    });

    it('sets each has* flag in lock step with its texture', () => {
        // The shader gates on these. A texture bound with no flag is never read; a flag with no texture
        // reads the 1x1 white fallback, which for the ramp means a solid unbanded surface.
        const withAll = Material.parse(Material.Cel(FULL as any).serialize());
        for (const f of ['hasBaseTexture', 'hasRampMap', 'hasNormalMap', 'hasEmissiveMap', 'hasMaskMap'])
            expect(withAll.properties.get(f), f).toBe(true);

        const bare = Material.Cel({});
        for (const f of ['hasBaseTexture', 'hasRampMap', 'hasNormalMap', 'hasEmissiveMap', 'hasMaskMap'])
            expect(bare.properties.get(f), f).toBe(false);
    });

    it('puts the height id inside `textures`, where the generic reference walk can see it', () => {
        expect(Material.Cel(FULL as any).serialize().textures.displacementMap).toBe('height-id');
    });
});

describe('the defaults make a cel material look like cel shading on creation', () => {
    it('a bare Material.Cel already bands, highlights and rims', () => {
        // Not cosmetic. One band, no highlight and no rim is indistinguishable from a broken shader, so
        // the "correct" additive default of 0 for rimStrength is the wrong one here.
        const m = Material.Cel({});
        expect(m.properties.get('bands')).toBe(3);
        expect(m.properties.get('bandSoftness')).toBe(0.02);
        expect(m.properties.get('specularThreshold')).toBe(0.5);
        expect(m.properties.get('rimStrength')).toBeGreaterThan(0);
        expect(m.properties.get('rimPower')).toBe(4);
    });

    it('ambient falls back to the diffuse tint, not to grey', () => {
        // The darkest band should read as a dark version of the surface.
        expect(Material.Cel({ diffuse: [0.2, 0.4, 0.6] }).properties.get('ambient')).toEqual([0.2, 0.4, 0.6]);
    });

    it('parses a bare `{ type: "cel" }` to those same defaults', () => {
        // An asset written before a property existed must reload sane rather than with a zero.
        const back = Material.parse({ type: 'cel' });
        expect(back.type).toBe('cel');
        expect(back.properties.get('bands')).toBe(3);
        expect(back.properties.get('bandSoftness')).toBe(0.02);
        expect(back.properties.get('rimPower')).toBe(4);
        expect(back.properties.get('shininess')).toBe(32);
        expect(back.properties.get('opacity')).toBe(1);
    });

    it('accepts an explicit 0 rather than treating it as absent', () => {
        // `||` would swallow every one of these. They are all legal values: no rim, no cutout, a fully
        // soft ramp, and a highlight that covers the whole lobe.
        const m = Material.Cel({ rimStrength: 0, bandSoftness: 0, specularThreshold: 0, opacity: 0 });
        expect(m.properties.get('rimStrength')).toBe(0);
        expect(m.properties.get('bandSoftness')).toBe(0);
        expect(m.properties.get('specularThreshold')).toBe(0);
        expect(m.properties.get('opacity')).toBe(0);
    });
});

describe('the skinned type normalizes to the base type', () => {
    it('celSkinned serializes as cel', () => {
        // The renderer promotes `cel` to `celSkinned` for an animated model, so the type on a live
        // material is not necessarily the one that should be written to disk.
        const m = Material.Cel({ diffuse: [1, 0, 0] });
        (m as any).type = 'celSkinned';
        expect(m.serialize().type).toBe('cel');
        expect(Material.parse(m.serialize()).properties.get('diffuse')).toEqual([1, 0, 0]);
    });
});

describe('AnimatedModel carries its own copy of both functions', () => {
    it('round-trips a cel material through the skinned path', () => {
        // A second, independent implementation of serialize/parse. Fixing material.ts alone leaves this
        // one falling through to Blinn-Phong, and only skinned meshes would be affected — which is
        // exactly the kind of half-fix that ships.
        const geometry = new Geometry(
            [0, 0, 0, 1, 0, 0, 0, 1, 0],   // positions
            [0, 0, 1, 0, 0, 1, 0, 0, 1],   // normals
            [0, 0, 1, 0, 0, 1],            // uvs
            [0, 1, 2],                     // indices
        );
        const model = new AnimatedModel(geometry, Material.Cel(FULL as any));
        const back = AnimatedModel.parse(JSON.parse(JSON.stringify(model.serialize())));

        expect(back.material.type).toBe('cel');
        expect(back.material.properties.get('bands')).toBe(5);
        expect(back.material.properties.get('bandSoftness')).toBe(0.15);
        expect(back.material.properties.get('specularThreshold')).toBe(0.8);
        expect(back.material.properties.get('rimColor')).toEqual([1, 0.5, 0.25]);
        expect(back.material.properties.get('rimPower')).toBe(7);
        expect(back.material.properties.get('rimStrength')).toBe(1.5);
        expect(back.material.textures.get('rampMap')).toBe('ramp-id');
        // The height slot and the cutout, which the Blinn-Phong arm beside this one still drops.
        expect(back.material.textures.get('displacementMap')).toBe('height-id');
        expect(back.material.properties.get('alphaCutoff')).toBe(0.25);
    });
});
