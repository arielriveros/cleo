import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Specular antialiasing from a normal map's own mips (Toksvig): far away, a mip texel averages the bumps
// under it, comes back shorter than unit length, and the spread it lost goes into the roughness, so rock
// across the valley stays as rough as it is up close. `normalMapRoughness` in chunks/modelVarying.wgsl,
// ported here so its shape can be asserted without a GPU.

const THRESHOLD = 0.25;
function normalMapRoughness(pr: number, rawLength: number, strength = 1): number {
    const r = Math.min(Math.max(rawLength, 1e-3), 1);
    const variance = (1 - r) / r * strength * strength;
    const kernel = Math.min(2 * variance, THRESHOLD);
    const alpha = pr * pr;
    return Math.sqrt(Math.sqrt(Math.min(Math.max(alpha * alpha + kernel, 0), 1)));
}
const wgsl = (f: string) => readFileSync(`src/graphics/shaders/wgsl/${f}`, 'utf8');

describe('normalMapRoughness', () => {
    it('leaves a full-resolution texel (unit length) alone', () => {
        for (const pr of [0.05, 0.3, 0.5, 0.9]) expect(normalMapRoughness(pr, 1)).toBeCloseTo(pr, 9);
        // A texel longer than unit (8-bit rounding) is clamped, never sharpened.
        expect(normalMapRoughness(0.5, 1.01)).toBeCloseTo(0.5, 9);
    });

    it('roughens as the mip averages the bumps away, and never past the geometric filter\'s threshold', () => {
        let previous = 0;
        for (const r of [1, 0.99, 0.97, 0.93, 0.85, 0.7, 0.5, 0.2]) {
            const pr = normalMapRoughness(0.5, r);
            expect(pr).toBeGreaterThanOrEqual(previous);
            previous = pr;
        }
        // Capped where the kernel is: alpha^2 + 0.25.
        expect(normalMapRoughness(0.5, 0.01)).toBeCloseTo(Math.pow(0.0625 + THRESHOLD, 0.25), 9);
        // Rock at roughness 0.5 seen from far, its normals averaged to 0.9: well out of mirror territory.
        expect(normalMapRoughness(0.5, 0.9)).toBeGreaterThan(0.7);
    });

    it('scales with the normal strength: a map drawn flat loses no spread', () => {
        expect(normalMapRoughness(0.4, 0.8, 0)).toBeCloseTo(0.4, 9);
        expect(normalMapRoughness(0.4, 0.95, 0.5)).toBeLessThan(normalMapRoughness(0.4, 0.95, 1));
    });

    it('matches the shader, and the terrain, G-buffer and forward paths all apply it', () => {
        const fn = wgsl('chunks/modelVarying.wgsl');
        expect(fn).toContain('fn normalMapRoughness(perceptualRoughness: f32, rawLength: f32, strength: f32, enabled: i32) -> f32');
        expect(fn).toContain('let variance = (1.0 - r) / r * strength * strength;');
        expect(wgsl('chunks/terrainStack.wgsl')).toContain('surfRoughness = normalMapRoughness(surfRoughness, length(tn), blend.z, u_terrain.u_specularAA);');
        for (const f of ['chunks/pbrGBuffer.wgsl', 'chunks/pbrForward.wgsl']) {
            const src = wgsl(f);
            expect(src, f).toContain('cleoNormalMapLength = length(n);');
            expect(src, f).toContain('normalMapRoughness(roughness, cleoNormalMapLength, 1.0, u_material.specularAA)');
        }
    });
});
