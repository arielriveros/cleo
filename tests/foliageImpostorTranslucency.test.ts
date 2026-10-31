import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FoliageLayer } from '../src/terrain/foliage';

// Leaf translucency (Material `translucency`) is a negative metallic in the G-buffer. The mesh levels of a
// foliage layer write it from their own materials; past the hand-off the octahedral impostor must write
// the same, or a back-lit crown stops glowing at the LOD switch. (Grass billboards light with a fixed up
// normal, so the glow — which comes from behind the surface — has nothing to add there.)

const shader = (name: string) => readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', name), 'utf8');

describe('far foliage translucency', () => {
    it('is written into the G-buffer by the impostor program, as the PBR chunk encodes it', () => {
        expect(shader('chunks/pbrGBuffer.wgsl')).toMatch(/select\(\s*[\w.]+,\s*-[\w.]*translucency[\w.]*,\s*[\w.]*translucency[\w.]* > 0/);
        const src = shader('geometryFoliageImpostor.wgsl');
        // Through a flat varying: a uniform block read by both stages does not link on GLSL ES 3.0.
        expect(src).toContain('out.translucency = u_transform.u_lodFrame.y;');
        expect(src).toContain('let translucency = in.translucency;');
        expect(src).toContain('select(0.0, -translucency, translucency > 0.0)');
    });

    it('comes from the coarsest mesh level, the one the impostor replaces', () => {
        const get = Object.getOwnPropertyDescriptor(FoliageLayer.prototype, 'farTranslucency')!.get!;
        const model = (...ts: (number | undefined)[]) => ({
            materials: ts.map(t => ({ properties: new Map(t === undefined ? [] : [['translucency', t]]) })),
        });
        // Trunk and leaves on the last level: the leaves' value. The first level does not count.
        expect(get.call({ levels: [{ models: [model(0.9)] }, { models: [model(0, 0.5)] }] })).toBe(0.5);
        // No translucent material, or no levels at all: none.
        expect(get.call({ levels: [{ models: [model(undefined, 0)] }] })).toBe(0);
        expect(get.call({ levels: [] })).toBe(0);
    });
});
