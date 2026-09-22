import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';

/**
 * The layer-stack migration, against a landscape that was actually shipped.
 *
 * Every other migration test builds its input; this one reads `3d-example`'s scene as it sits on disk —
 * two layers, `auto` off, a 400x400 RGBA splat — and asserts that the surfaces the new stack composites
 * are the weights the old renderer would have blended, texel for texel. That is the whole promise of the
 * change: an existing project opens looking the same. The stick-breaking conversion
 * (`a1 = w1 / (1 - w3 - w2)`, see legacySplatAlphas) is what makes that exact rather than approximate,
 * and a plausible-looking simplification of it would pass every synthetic test and still shift the look
 * of every landscape ever painted.
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
            : objects.has(key) ? () => ({ id: ++n }) : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

/** The first serialized terrain anywhere in a saved scene file. */
function findTerrain(json: any): any {
    if (!json || typeof json !== 'object') return null;
    if (json.terrain && typeof json.terrain === 'object') return json.terrain;
    for (const value of Object.values(json)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                const found = findTerrain(item);
                if (found) return found;
            }
        } else {
            const found = findTerrain(value);
            if (found) return found;
        }
    }
    return null;
}

const EXAMPLE = join(__dirname, '..', 'editor', 'public', 'examples', '3d-example', 'scenes',
    'afe4727c54de62f1bafbf6ac25c32b74.json');

describe('a shipped 4-layer landscape', () => {
    const scene = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
    const json = findTerrain(scene);

    it('is still in the old format, which is what makes this a migration test', () => {
        expect(json).toBeTruthy();
        expect(json.layerStack).toBeUndefined();
        expect(typeof json.splat).toBe('string');
        expect(json.layers.length).toBe(2);
        // Both layers have auto masking OFF, so the legacy weights are the splat and nothing else —
        // which is what lets the comparison below be exact rather than "close enough".
        for (const layer of json.layers) expect(layer.auto).toBe(false);
    });

    it('becomes a base plus one paint layer, keeping both material links', () => {
        const terrain = Terrain.deserialize(json);
        const stack = terrain.layerStack;
        expect(stack.base.materialId).toBe(json.layers[0].materialId);
        expect(stack.paintLayers.length).toBe(1);
        expect(stack.paintLayers[0].materialId).toBe(json.layers[1].materialId);
        // The base covers everything under it: an old base had nowhere to fall through to.
        expect(stack.base.material!.rule.elevation.enabled).toBe(false);
        expect(stack.base.material!.rule.slope.enabled).toBe(false);
        terrain.dispose();
    });

    it('reproduces the old normalized splat weights across the whole landscape', () => {
        const terrain = Terrain.deserialize(json);
        const res = json.splatRes as number;
        const splat = Uint8Array.from(atob(json.splat), c => c.charCodeAt(0));
        expect(splat.length).toBe(res * res * 4);

        // The old splat was VERTEX-aligned: texel (c, r) is the sample at that grid position, not the
        // centre of a cell. The masks are texel-centred at their own resolution, so the migration
        // resamples — and this is the mapping that resampling was built around.
        const spacing = terrain.size / (res - 1);
        const channel = (c: number, r: number, k: number) => splat[(r * res + c) * 4 + k];

        /** True where the 3x3 neighbourhood is identical: inside a painted region, where a resample is exact. */
        const flat = (c: number, r: number): boolean => {
            if (c < 1 || r < 1 || c > res - 2 || r > res - 2) return false;
            for (let k = 0; k < 4; k++) {
                const v = channel(c, r, k);
                for (let dr = -1; dr <= 1; dr++)
                    for (let dc = -1; dc <= 1; dc++) if (channel(c + dc, r + dr, k) !== v) return false;
            }
            return true;
        };

        let compared = 0, painted = 0, interior = 0, worstInterior = 0, totalError = 0;
        // Every 7th sample, which is coprime with the row length and so walks the whole field.
        for (let i = 0; i < res * res; i += 7) {
            const r = Math.floor(i / res), c = i % res;
            const w = [splat[i * 4], splat[i * 4 + 1], splat[i * 4 + 2], splat[i * 4 + 3]];
            const total = w[0] + w[1] + w[2] + w[3];
            if (total === 0) continue;   // unpainted in the old format: nothing to reproduce

            const weights = terrain.layerWeightsAt(c * spacing, r * spacing);
            const expectedPaint = w[1] / total;
            const error = Math.max(Math.abs(weights.paint[0] - expectedPaint),
                                   Math.abs(weights.base - w[0] / total));
            totalError += error;
            compared++;
            if (expectedPaint > 0.01) painted++;
            if (flat(c, r)) { interior++; worstInterior = Math.max(worstInterior, error); }
        }

        // Not vacuous: the example really is painted, on both layers, and most of it is interior.
        expect(compared).toBeGreaterThan(1000);
        expect(painted).toBeGreaterThan(100);
        expect(interior).toBeGreaterThan(500);
        // Inside a painted region the conversion is exact to one byte of mask quantization. Only the
        // BOUNDARIES differ, and only because the mask grid is finer than the old splat (1024 vs 400 over
        // 400 m), which resamples a one-metre painted edge onto 0.39 m texels — a slightly smoother edge,
        // not a different one. Held to a small average: it measures 0.012 on this landscape.
        expect(worstInterior).toBeLessThanOrEqual(2 / 255);
        expect(totalError / compared).toBeLessThan(0.02);
        terrain.dispose();
    });
});
