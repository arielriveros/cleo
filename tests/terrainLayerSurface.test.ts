import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Everything `_deriveLayerSurface` returns has to actually reach the layer.
 *
 * Terrain layers are DERIVED state: a `TerrainMaterial` goes into `setLayer`, `_deriveLayerSurface`
 * reduces it to the flat ids and scalars the composite terrain material can bind, and `setLayer`
 * copies those onto the `TerrainLayer` field by field. Nothing checks that the copy is complete —
 * the derived object is structurally typed, the layer is a separate interface, and a field present
 * in one and forgotten in the other type-checks perfectly.
 *
 * That is not hypothetical. Terrain ambient occlusion shipped with `aoId` threaded through the whole
 * chain — the layer field, the derive, the packer spec, the `u_hasAO{i}` uniform, the shader blend,
 * the G-buffer alpha, both the deferred and forward composites — and one missing line in `setLayer`.
 * `aoId` stayed null forever, `u_hasAO0` stayed 0, the packer took its identity path, and the whole
 * feature was inert while every gate stayed green: an unused code path renders exactly like no code
 * path. Only a fixture built to carry an occlusion map found it, and only because the shader was
 * force-broken first to prove the pixels could move at all.
 *
 * So the invariant is checked structurally, once, for every field: whatever the derive returns, the
 * material branch of `setLayer` must assign. A new surface field added to one and not the other
 * fails here rather than shipping inert.
 */

const SRC = readFileSync(join(__dirname, '..', 'src', 'terrain', 'terrain.ts'), 'utf-8');

/** The field names in `_deriveLayerSurface`'s inline return type. */
const derivedFields = (): string[] => {
    const start = SRC.indexOf('private _deriveLayerSurface(');
    expect(start).toBeGreaterThan(-1);
    const open = SRC.indexOf('{', SRC.indexOf('): ', start));
    const close = SRC.indexOf('} {', open);
    expect(close).toBeGreaterThan(open);
    return SRC.slice(open + 1, close)
        .split(';').map(s => s.trim().split(':')[0].trim()).filter(Boolean);
};

/** The body of `setLayer`'s `source instanceof TerrainMaterial` branch. */
const materialBranch = (): string => {
    const start = SRC.indexOf('if (source instanceof TerrainMaterial) {');
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf('} else if', start);
    expect(end).toBeGreaterThan(start);
    return SRC.slice(start, end);
};

describe('terrain layer surface derivation', () => {
    it('derives the fields the layer is known to need', () => {
        // A floor, so a derive that loses a field cannot pass by shrinking both sides at once.
        expect(derivedFields()).toEqual(expect.arrayContaining(
            ['albedoId', 'aoId', 'normalId', 'heightId', 'color', 'metallic', 'roughness']));
    });

    it('assigns every derived field onto the layer', () => {
        const branch = materialBranch();
        for (const field of derivedFields())
            expect(branch, `setLayer never assigns L.${field}`).toContain(`L.${field} = `);
    });

    it('clears the derived ids on the legacy plain-albedo branch', () => {
        // The legacy branch replaces a material with a bare texture id, so every OTHER derived id has
        // to be cleared or the previous material's maps stay bound to the layer.
        const start = SRC.indexOf("} else if (source && 'textureId' in source) {");
        const branch = SRC.slice(start, SRC.indexOf('// else: keep existing', start));
        for (const field of ['aoId', 'normalId', 'heightId'])
            expect(branch, `legacy branch leaves L.${field} stale`).toContain(`L.${field} = null`);
    });
});

describe('terrain occlusion packing', () => {
    const packFn = () => {
        const start = SRC.indexOf('private _syncAlbedoPack(');
        return SRC.slice(start, SRC.indexOf('\n    }', start));
    };

    it('packs occlusion into alpha and albedo into rgb', () => {
        const body = packFn();
        for (const ch of ['r', 'g', 'b'])
            expect(body).toContain(`${ch}: L.albedoId ?`);
        expect(body).toMatch(/a: L\.aoId \?/);
    });

    it('keeps the layer when it has occlusion but no albedo', () => {
        // An occlusion-only layer is legitimate — the tint is applied on top — so the early-out must
        // test BOTH ids. Testing albedo alone would throw the occlusion map away.
        expect(packFn()).toMatch(/if \(!L\.albedoId && !L\.aoId\)/);
    });

    it('reports occlusion presence separately from albedo presence', () => {
        // One packed texture, two independent flags: `u_hasAlbedo{i}` must not be reused for AO, or an
        // occlusion-only layer would multiply in the packer's white rgb as if it were an albedo map.
        const body = packFn();
        expect(body).toMatch(/u_hasAlbedo\$\{index\}`, L\.albedoId \? 1 : 0/);
        expect(body).toMatch(/u_hasAO\$\{index\}`, L\.aoId \? 1 : 0/);
    });
});

describe('terrain occlusion in the shader', () => {
    const CHUNK = readFileSync(
        join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks', 'terrainLayers.wgsl'), 'utf-8');

    it('reads occlusion from the albedo alpha, linear', () => {
        // Albedo is sRGB and occlusion is not. One fetch serves both, so only the rgb may go through
        // `toLinear` — decoding occlusion as sRGB would read it far too dark.
        expect(CHUNK).toMatch(/if \(hasAlbedo == 1\) \{ alb \*= toLinear\(texel\.rgb\); \}/);
        expect(CHUNK).toMatch(/if \(hasAO == 1\) \{ ao = texel\.a; \}/);
    });

    it('defaults to unoccluded on the zero-weight fallback', () => {
        const fallback = CHUNK.slice(CHUNK.indexOf('if (wSum < 1e-4) {'));
        expect(fallback.slice(0, fallback.indexOf('return out;'))).toMatch(/out\.ao = 1\.0;/);
    });

    it('blends occlusion by the same weights as everything else', () => {
        expect(CHUNK).toMatch(/out\.ao = \(l0\.ao \+ l1\.ao \+ l2\.ao \+ l3\.ao\) \/ sum;/);
    });
});
