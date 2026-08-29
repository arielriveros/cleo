import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Per-frame camera and sun reach the MATERIAL uniform block on every draw path.
 *
 * `viewPos` and `sunDirection` are not material constants — they change every frame — but the deferred
 * geometry stage has no other group-1 block to read, so they ride in `PBRMaterial` and parallax
 * occlusion mapping marches against them.
 *
 * They were written in exactly one place, `_applyMaterial`, which the RHI migration demoted to the
 * legacy no-reflection fallback. Every real PBR draw took an inline
 *
 *     for (const [name, value] of mat.properties)
 *         this._shaderManager.setUniform(`u_material.${name}`, value);
 *
 * instead, and wrote neither. Six such loops existed. `UniformBlockSet.set` returns false for a name it
 * does not know and `setUniform` swallows that, so nothing anywhere reported it.
 *
 * The symptom is the reason this is worth a test rather than a comment. A zero `viewPos` does not turn
 * parallax OFF — it moves the eye to the world origin, so `toEye` becomes `normalize(-fragPos)`, which
 * still varies per fragment and still produces relief that looks real in a screenshot. It simply cannot
 * respond to the camera: the effect is welded to the object and sits still while you orbit it. No image
 * baseline can catch that, because every baseline is a single fixed camera.
 */

const SRC = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8');

/** The inline write that bypasses the helper, in any of the spellings the call sites used. */
const INLINE_LOOP = /for \(const \[name, value\] of [A-Za-z0-9_.!]+\.properties\)\s*\n\s*this\._shaderManager\.setUniform\(`u_material\.\$\{name\}`, value\);/g;

describe('material uniform writes go through one place', () => {
    it('has exactly one loop writing u_material.<property>', () => {
        const hits = SRC.match(INLINE_LOOP) ?? [];
        expect(
            hits.length,
            'Every material property loop must live in _applyMaterialProperties. A second one is a draw ' +
            'path that writes the material\'s own uniforms but NOT the per-frame viewPos/sunDirection ' +
            'beside them — which is exactly how parallax stopped responding to the camera while still ' +
            'looking like it worked.',
        ).toBe(1);
    });

    it('that loop is inside _applyMaterialProperties, next to the per-frame writes', () => {
        const fn = SRC.match(/private _applyMaterialProperties\(material: Material\): void \{([\s\S]*?)\n    \}/);
        expect(fn, '_applyMaterialProperties not found').not.toBeNull();
        const body = fn![1];
        expect(body).toMatch(INLINE_LOOP);
        expect(body, 'the eye position the march builds toEye from').toMatch(/u_material\.viewPos/);
        expect(body, 'the sun the height-field self-shadow marches toward').toMatch(/u_material\.sunDirection/);
    });

    it('nothing writes those two members anywhere else', () => {
        // If a second site starts writing them, the helper has stopped being the single point of truth
        // and the next path added will forget them again.
        for (const member of ['viewPos', 'sunDirection']) {
            const n = (SRC.match(new RegExp("u_material\." + member, 'g')) ?? []).length;
            expect(n, `u_material.${member} is written in ${n} places, expected 1`).toBe(1);
        }
    });

    it('every draw path that sets a pipeline also applies the material properties', () => {
        // A cheap structural proxy: the helper must be reached from more than the legacy fallback.
        // Six inline loops were replaced; fewer callers than that means one was dropped, not refactored.
        const callers = (SRC.match(/this\._applyMaterialProperties\(/g) ?? []).length;
        expect(callers, 'expected the 6 migrated call sites plus _applyMaterial itself')
            .toBeGreaterThanOrEqual(7);
    });
});
