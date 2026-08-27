import { describe, expect, it } from 'vitest';
import { Material } from '../src/graphics/material';

/**
 * The cutout mask, across all three shading models.
 *
 * The slot itself is old — Blinn-Phong has had `maskMap` for a long time — but it discarded at a
 * hardcoded `0.5` with no property behind it, and neither Basic nor PBR had it at all. The threshold is
 * now `alphaCutoff`, shared by all three, which makes the DEFAULT the delicate part: giving it the
 * usual 0 ("off") would have silently switched masking off on every material authored before this.
 */

const basic = (p: any = {}) => Material.Basic(p);
const blinn = (p: any = {}) => Material.Default(p);
const pbr = (textures: any = {}, rest: any = {}) => Material.PBR({ textures, ...rest });

describe('the mask slot exists on every textured material', () => {
    it('Basic accepts a mask', () => {
        const m = basic({ texture: 'albedo', mask: 'cut' });
        expect(m.textures.get('maskMap')).toBe('cut');
        expect(m.properties.get('hasMaskMap')).toBe(true);
    });

    it('PBR accepts a mask', () => {
        const m = pbr({ baseColorTexture: 'albedo', mask: 'cut' });
        expect(m.textures.get('maskMap')).toBe('cut');
        expect(m.properties.get('hasMaskMap')).toBe(true);
    });

    it('Blinn-Phong still accepts one, under its historical authoring key', () => {
        const m = blinn({ textures: { base: 'albedo', mask: 'cut' } });
        expect(m.textures.get('maskMap')).toBe('cut');
        expect(m.properties.get('hasMaskMap')).toBe(true);
    });

    it('leaves the flag false and the slot empty when no mask is given', () => {
        for (const m of [basic({ texture: 'a' }), pbr({ baseColorTexture: 'a' }), blinn({ textures: { base: 'a' } })]) {
            expect(m.properties.get('hasMaskMap')).toBe(false);
            expect(m.textures.has('maskMap')).toBe(false);
        }
    });
});

describe('the threshold default is conditional, so old content is unaffected', () => {
    it('a mask with no stated cutoff gets 0.5 — the constant it replaced', () => {
        expect(basic({ mask: 'cut' }).properties.get('alphaCutoff')).toBe(0.5);
        expect(pbr({ mask: 'cut' }).properties.get('alphaCutoff')).toBe(0.5);
        expect(blinn({ textures: { mask: 'cut' } }).properties.get('alphaCutoff')).toBe(0.5);
    });

    it('no mask means no cutout, so a material that never had one is untouched', () => {
        expect(basic({ texture: 'a' }).properties.get('alphaCutoff')).toBe(0);
        expect(pbr({ baseColorTexture: 'a' }).properties.get('alphaCutoff')).toBe(0);
        expect(blinn({ textures: { base: 'a' } }).properties.get('alphaCutoff')).toBe(0);
    });

    it('an explicit cutoff always wins, including an explicit 0 that disables a mask', () => {
        expect(pbr({ mask: 'cut' }, { alphaCutoff: 0.25 }).properties.get('alphaCutoff')).toBe(0.25);
        expect(pbr({ mask: 'cut' }, { alphaCutoff: 0 }).properties.get('alphaCutoff')).toBe(0);
    });

    it('a glTF alphaMode:MASK import keeps its own cutoff and needs no mask texture', () => {
        // The PBR shader falls back to the base colour's alpha when no mask is bound, so this is the
        // path every existing glTF cutout takes and it must be unchanged.
        const m = pbr({ baseColorTexture: 'leaf' }, { alphaCutoff: 0.5 });
        expect(m.properties.get('alphaCutoff')).toBe(0.5);
        expect(m.properties.get('hasMaskMap')).toBe(false);
    });
});

describe('round trip', () => {
    it('carries the mask and the cutoff through serialize/parse on all three types', () => {
        const cases = [
            basic({ texture: 'albedo', mask: 'cut', alphaCutoff: 0.3 }),
            pbr({ baseColorTexture: 'albedo', mask: 'cut' }, { alphaCutoff: 0.3 }),
            blinn({ textures: { base: 'albedo', mask: 'cut' }, alphaCutoff: 0.3 }),
        ];
        for (const m of cases) {
            const round = Material.parse(m.serialize());
            expect(round.textures.get('maskMap'), m.type).toBe('cut');
            expect(round.properties.get('hasMaskMap'), m.type).toBe(true);
            expect(round.properties.get('alphaCutoff'), m.type).toBe(0.3);
        }
    });

    it('reloads a material saved BEFORE the cutoff existed without changing how it renders', () => {
        // The stored blob has a mask and no `alphaCutoff` at all — exactly what the old serializer
        // wrote. It has to come back at 0.5, the literal the Blinn-Phong shader used to hardcode.
        const legacyMasked = { type: 'blinn_phong', textures: { base: 'a', mask: 'cut' } };
        expect(Material.parse(legacyMasked).properties.get('alphaCutoff')).toBe(0.5);

        // ...and one with no mask must stay at 0, or every unmasked surface would start discarding.
        const legacyPlain = { type: 'blinn_phong', textures: { base: 'a' } };
        expect(Material.parse(legacyPlain).properties.get('alphaCutoff')).toBe(0);
    });

    it('an explicitly-disabled cutoff survives a round trip rather than reverting to 0.5', () => {
        const off = Material.parse({ type: 'pbr', alphaCutoff: 0, textures: { mask: 'cut' } });
        expect(off.properties.get('alphaCutoff')).toBe(0);
        expect(Material.parse(off.serialize()).properties.get('alphaCutoff')).toBe(0);
    });
});
