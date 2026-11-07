import { describe, expect, it } from 'vitest';
import {
    REFLECTION_BORDER, ReflectionLayerAllocator, octAtlasDir, octAtlasUv, octWrapOutside, reflectionAtlasCapacity,
} from '../src/graphics/render/reflectionAtlas';

const norm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const angle = (a: number[], b: number[]) => Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

describe('the octahedral reflection atlas layout', () => {
    it('maps a direction to a uv inside the border and back', () => {
        for (const d of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [0, -1, 0], [0.3, 0.8, -0.5], [-0.7, -0.2, -0.68], [0.5, -0.5, 0.7]]) {
            const n = norm(d);
            const uv = octAtlasUv(n);
            expect(uv[0]).toBeGreaterThanOrEqual(REFLECTION_BORDER - 1e-9);
            expect(uv[0]).toBeLessThanOrEqual(1 - REFLECTION_BORDER + 1e-9);
            expect(uv[1]).toBeGreaterThanOrEqual(REFLECTION_BORDER - 1e-9);
            expect(uv[1]).toBeLessThanOrEqual(1 - REFLECTION_BORDER + 1e-9);
            expect(angle(octAtlasDir(uv), n)).toBeLessThan(1e-5);
        }
    });

    it('fills the border with the directions just across the folds, so a fetch there is seamless', () => {
        // Just outside each edge, the texel holds what is just inside the mirrored edge: neighbouring
        // texels on either side of a seam are neighbouring directions.
        const s = 1 - 2 * REFLECTION_BORDER;
        const step = 0.01;
        for (const t of [-0.8, -0.3, 0.1, 0.6]) {
            const edges: [number, number][][] = [
                [[1 + step, t], [1 - step, -t]], [[-1 - step, t], [-1 + step, -t]],
                [[t, 1 + step], [-t, 1 - step]], [[t, -1 - step], [-t, -1 + step]],
            ];
            for (const [outside, inside] of edges) {
                expect(octWrapOutside(outside)[0]).toBeCloseTo(inside[0], 9);
                expect(octWrapOutside(outside)[1]).toBeCloseTo(inside[1], 9);
                const toUv = (p: [number, number]) => [REFLECTION_BORDER + (p[0] * 0.5 + 0.5) * s, REFLECTION_BORDER + (p[1] * 0.5 + 0.5) * s];
                const a = octAtlasDir(toUv(outside));
                const b = octAtlasDir(toUv(inside));
                expect(angle(a, b)).toBeLessThan(1e-6);
                // And the texel just inside the edge on THIS side is a close neighbour of both.
                const near = octAtlasDir(toUv([outside[0] - (outside[0] > 1 ? 2 * step : outside[0] < -1 ? -2 * step : 0),
                                              outside[1] - (outside[1] > 1 ? 2 * step : outside[1] < -1 ? -2 * step : 0)]));
                expect(angle(a, near)).toBeLessThan(0.1);
            }
        }
    });

    it('keeps the same mapping at every mip, so one trilinear fetch serves them all', () => {
        // The border is a FRACTION of each mip's side: at 256 and at 16 the same uv is the same direction.
        for (const size of [256, 128, 64, 32, 16]) {
            const border = REFLECTION_BORDER * size;
            expect(Number.isInteger(border) || size < 16).toBe(true);
            expect(border).toBeGreaterThanOrEqual(1);
        }
    });
});

describe('reflection atlas layers (ReflectionLayerAllocator)', () => {
    it('hands out the lowest free layer, takes it back, and never twice', () => {
        const layers = new ReflectionLayerAllocator(3);
        expect([layers.acquire(), layers.acquire(), layers.acquire()]).toEqual([0, 1, 2]);
        expect(layers.acquire()).toBe(-1);
        layers.release(1);
        layers.release(1);
        expect(layers.freeCount).toBe(1);
        expect(layers.acquire()).toBe(1);
    });

    it('swaps a probe into a fresh layer before freeing its old one', () => {
        const layers = new ReflectionLayerAllocator(reflectionAtlasCapacity(2));
        const a = layers.acquire(), b = layers.acquire();
        // Probe a re-filters: a spare layer is taken, filled, then a is given back.
        const next = layers.acquire();
        expect(next).not.toBe(a);
        expect(next).not.toBe(b);
        layers.release(a);
        expect(layers.acquire()).toBe(a);
    });

    it('grows keeping what is taken, and resets to all free', () => {
        const layers = new ReflectionLayerAllocator(2);
        layers.acquire(); layers.acquire();
        layers.grow(4);
        expect(layers.capacity).toBe(4);
        expect(layers.acquire()).toBe(2);
        layers.reset(8);
        expect(layers.freeCount).toBe(8);
    });

    it('sizes the atlas for every probe plus one spare, in steps of four', () => {
        expect(reflectionAtlasCapacity(0)).toBe(4);
        expect(reflectionAtlasCapacity(3)).toBe(4);
        expect(reflectionAtlasCapacity(4)).toBe(8);
        expect(reflectionAtlasCapacity(8)).toBe(12);
    });
});
