import { describe, it, expect } from 'vitest';
import {
    blendStatesEqual, uniformTargetBlend, DEFAULT_BLEND, ADDITIVE_BLEND, OVERLAY_BLEND,
} from '../src/graphics/rhi/types';
import type { BlendComponent, BlendState, ColorTargetState } from '../src/graphics/rhi/types';

// WebGL2 has ONE blend state for every colour attachment (this engine never enables
// OES_draw_buffers_indexed), so a pipeline asking for per-target blending asks for something the
// backend cannot do. It used to refuse any second blending target outright. The decal buffer needs three
// attachments blended the same way, which GL CAN express, so the rule moved to where the real line is:
// identical states pass, and anything GL would silently get wrong -- differing states, or a target that
// asked not to blend but would be blended anyway -- throws at pipeline apply time instead.

/** The decal buffer's blend: premultiplied "over", with alpha accumulating the product of (1 - a). */
const DBUFFER: BlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/** A deep copy: equality here must be by value, never by object identity. */
const copy = (b: BlendState): BlendState => JSON.parse(JSON.stringify(b));

const target = (blend?: BlendState): ColorTargetState =>
    blend ? { format: 'rgba8unorm', blend } : { format: 'rgba8unorm' };

describe('blendStatesEqual', () => {
    it('compares by value', () => {
        expect(blendStatesEqual(DBUFFER, copy(DBUFFER))).toBe(true);
        expect(blendStatesEqual(DEFAULT_BLEND, DEFAULT_BLEND)).toBe(true);
    });

    it('notices a change to any one of the six fields, in either direction', () => {
        const edits: [keyof BlendState, keyof BlendComponent, string][] = [
            ['color', 'srcFactor', 'src-alpha'],
            ['color', 'dstFactor', 'one'],
            ['color', 'operation', 'max'],
            ['alpha', 'srcFactor', 'one'],
            ['alpha', 'dstFactor', 'one'],
            ['alpha', 'operation', 'subtract'],
        ];
        for (const [half, field, value] of edits) {
            const edited = copy(DBUFFER);
            (edited[half] as any)[field] = value;
            expect(blendStatesEqual(DBUFFER, edited), `${half}.${field}`).toBe(false);
            expect(blendStatesEqual(edited, DBUFFER), `${half}.${field}`).toBe(false);
        }
    });

    it('tells the default blend from the overlay blend, which differ only in alpha', () => {
        // That alpha half is the whole difference between leaving the bloom mask alone and accumulating
        // coverage into it, so it must count as much as the colour half.
        expect(DEFAULT_BLEND.color).toEqual(OVERLAY_BLEND.color);
        expect(blendStatesEqual(DEFAULT_BLEND, OVERLAY_BLEND)).toBe(false);
    });
});

describe('uniformTargetBlend', () => {
    it('has nothing to apply when no target blends', () => {
        expect(uniformTargetBlend([])).toBeUndefined();
        expect(uniformTargetBlend([target()])).toBeUndefined();
        expect(uniformTargetBlend([target(), target(), target()])).toBeUndefined();
    });

    it('keeps the historical rule for a single blending target: target 0 decides', () => {
        expect(uniformTargetBlend([target(DEFAULT_BLEND)])).toBe(DEFAULT_BLEND);
        // The G-buffer pattern: a blended first attachment over unblended others.
        expect(uniformTargetBlend([target(DEFAULT_BLEND), target(), target()])).toBe(DEFAULT_BLEND);
        // ...and, as before, a lone blending target anywhere else is not what GL gets told to do.
        expect(uniformTargetBlend([target(), target(ADDITIVE_BLEND)])).toBeUndefined();
    });

    it('lets every target blend when they all blend the same way', () => {
        // Separate-but-equal objects: the rule is about the states, not about sharing one constant.
        const blend = uniformTargetBlend([target(copy(DBUFFER)), target(copy(DBUFFER)), target(copy(DBUFFER))]);
        expect(blend).toEqual(DBUFFER);
        expect(uniformTargetBlend([target(ADDITIVE_BLEND), target(ADDITIVE_BLEND)])).toBe(ADDITIVE_BLEND);
    });

    it('throws, naming the pipeline, when blending targets disagree', () => {
        expect(() => uniformTargetBlend([target(DBUFFER), target(DBUFFER), target(DEFAULT_BLEND)], 'decals'))
            .toThrow('decals: WebGL2 cannot blend colour targets independently');
        // One field is enough: the colour halves here are identical.
        expect(() => uniformTargetBlend([target(DEFAULT_BLEND), target(OVERLAY_BLEND)]))
            .toThrow('pipeline: WebGL2 cannot blend colour targets independently');
    });

    it('throws when several targets blend and another does not, since GL would blend that one too', () => {
        expect(() => uniformTargetBlend([target(DBUFFER), target(), target(DBUFFER)], 'decals')).toThrow(/decals/);
        expect(() => uniformTargetBlend([target(), target(DBUFFER), target(DBUFFER)])).toThrow();
    });
});
