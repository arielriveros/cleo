import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FoliageLayer } from '../src/terrain/foliage';
import { impostorShadowFrom } from '../src/graphics/render/foliage';

// Far trees cast and receive through their octahedral impostor. Three things broke the illusion: the impostor
// cast into cascades whose trees the camera still sees as meshes (shadowing their sunlit side with a round
// blob), its shadow and its G-buffer depth were sized by the capture sphere (metres wider than the crown), and
// the shadow snapped from one baked view to the next as the sun moved. And a far tree took no snow.

const shader = (name: string) => readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', name), 'utf8');

describe('which cascades a tree casts through its impostor', () => {
    it('only where the camera sees impostors: the near edge, less its blend, at or past the hand-off', () => {
        // The Valley: four cascades ending ~19, 39, 68 and 150 m out, a 10% blend, pines turning impostor at 50 m.
        const splits = [19, 39, 68, 150];
        const casts = (c: number) => impostorShadowFrom(c, c > 0 ? splits[c - 1] : 0, 0.1, 50);
        expect([0, 1, 2, 3].map(casts)).toEqual([false, false, false, true]);
        // A layer that turns impostor early casts through it sooner, never in cascade 0.
        expect(impostorShadowFrom(1, 19, 0.1, 10)).toBe(true);
        expect(impostorShadowFrom(0, 0, 0.1, 0)).toBe(false);
        // No impostor hand-off at all: never.
        expect(impostorShadowFrom(3, 68, 0.1, Infinity)).toBe(false);
    });
});

describe('the impostor shadow pass', () => {
    const src = shader('shadowMapImpostor.wgsl');

    it('blends the three views round the sun by an ordered dither, instead of snapping to the nearest', () => {
        expect(src).not.toContain('round(hemiOctEncode(view)');
        expect(src).toContain('#include "./chunks/dither.wgsl"');
        expect(src).toMatch(/lodDitherThreshold\(in\.position\.xy/);
        // All three sampled in uniform control flow.
        expect((src.match(/textureSample\(u_albedo_texture/g) ?? []).length).toBe(3);
    });

    it('rounds its depth by the crown, not the capture sphere', () => {
        expect(src).toContain('let crown = select(u_depth.u_impostor.y, u_depth.u_impostor.w, u_depth.u_impostor.w > 0.0) * s;');
        expect(src).toContain('0.5 * crown * u_depth.u_lightDir.w');
    });
});

describe('the impostor colour pass', () => {
    const src = shader('geometryFoliageImpostor.wgsl');

    it('is drawn the crown, not the capture sphere, toward the eye', () => {
        expect(src).toContain('let pulled = world + normalize(eye - world) * crown;');
        expect(src).not.toContain('radius * 0.5;');
    });

    it('reads the weather per plant and wets and snows the crown like the mesh levels', () => {
        expect(src).toContain('u_weatherInfo: vec4<f32>,');
        expect(src).toContain('u_snowColor: vec4<f32>,');
        expect(src).toContain('#include "./chunks/weatherVolumes.wgsl"');
        expect(src).toMatch(/weather = vec2<f32>\(ws\.wet, ws\.snow\) \* u_transform\.u_lodFrame\.zw/);
        // Through flat varyings: the fragment stage reads no uniform block.
        expect(src).toMatch(/@location\(11\) @interpolate\(flat\) weather/);
        expect(src).toMatch(/@location\(12\) @interpolate\(flat\) snowColor/);
        expect(src).not.toMatch(/fn fs_main[\s\S]*u_transform\./);
        // foliageSurface.wgsl's maths.
        expect(src).toContain('lin *= mix(1.0, 0.55, wet);');
        expect(src).toContain('smoothstep(0.2, 0.8, nWorld.y)');
    });
});

describe('what the far impostor takes from the mesh level it replaces', () => {
    const model = (props: Record<string, number>, box?: [number[], number[]]) => ({
        materials: [{ properties: new Map(Object.entries(props)) }],
        geometry: box ? { boundingBox: { min: box[0], max: box[1] } } : undefined,
    });

    it('the coarsest level\'s weather responses', () => {
        const get = Object.getOwnPropertyDescriptor(FoliageLayer.prototype, 'farWeather')!.get!;
        expect(get.call({ levels: [{ models: [model({ wetResponse: 0.9, snowCover: 0.9 })] },
                                    { models: [model({ wetResponse: 0.6 }), model({ snowCover: 0.5 })] }] })).toEqual([0.6, 0.5]);
        expect(get.call({ levels: [] })).toEqual([0, 0]);
    });

    it('a crown radius from the coarsest level\'s horizontal span, capped by the capture sphere', () => {
        const get = Object.getOwnPropertyDescriptor(FoliageLayer.prototype, 'farCrownRadius')!.get!;
        // A 12 m by 8 m spread: a 5 m crown.
        const layer = (radius: number) => ({ billboardOctahedral: { radius },
            levels: [{ models: [model({}, [[-6, 0, -4], [6, 15, 4]])] }] });
        expect(get.call(layer(8.46))).toBeCloseTo(5, 9);
        expect(get.call(layer(3))).toBe(3);
        expect(get.call({ billboardOctahedral: null, levels: [{ models: [model({})] }] })).toBe(0);
    });
});
