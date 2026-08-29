import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HeightField, sampleHeight } from '../src/graphics/systems/displacement';

/**
 * Which row of a height map is `v = 0` — the bug that made relief land in the wrong place.
 *
 * `getImageData` hands back row 0 = the TOP of the image. But every `HTMLImageElement` upload in this
 * engine is FLIPPED: `Texture._flipY` defaults to false and both backends negate it —
 * `gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, !this._flipY)` and WebGPU's `flipY: !(config.flipY ?? true)`.
 * So on the GPU `v = 0` is the image's LAST row.
 *
 * Reading the pixels straight therefore displaced at `v` while the shader shaded at `1 - v`: relief came
 * out mirrored about each tile's V centre, and a rock in one corner of the texture raised the ground in
 * a different corner. `heightField` now draws the image upside down so the rows it returns are already
 * in texture space.
 *
 * The reason it went unnoticed is worth keeping in view: `terrainDisplaceParity.test.ts` builds its
 * synthetic fields in the CPU's own row order, so it held two identically-mirrored implementations equal.
 * A test that constructs its own data cannot catch an orientation bug; it has to assert against the
 * convention the GPU actually uses.
 */

const ROOT = join(__dirname, '..');
const src = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf-8');

/** A field whose value encodes its own row, so a flip is visible rather than plausible. */
const rowRamp = (h: number, w = 4): HeightField => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) data[(y * w + x) * 4] = y * 16;
    return { data, width: w, height: h };
};

describe('the sampler reads rows in TEXTURE order', () => {
    it('v = 0 is the first row of the field it is given', () => {
        // `sampleHeight` itself is unchanged and stays a plain bottom-up reader; the flip happens once,
        // at ingest, so everything downstream — the pyramid, the mean, the compute twin — agrees without
        // remembering a correction.
        const f = rowRamp(8);
        expect(sampleHeight(f, 0.5, 0.5 / 8, false)).toBeCloseTo(0 / 255, 6);
        expect(sampleHeight(f, 0.5, 7.5 / 8, false)).toBeCloseTo((7 * 16) / 255, 6);
    });

    it('a feature at field row r samples at v = (r + 0.5) / height', () => {
        const f = rowRamp(16);
        for (const r of [0, 3, 9, 15])
            expect(sampleHeight(f, 0.5, (r + 0.5) / 16, false), `row ${r}`).toBeCloseTo((r * 16) / 255, 6);
    });
});

describe('the ingest flip', () => {
    it('heightField draws the image upside down', () => {
        // The one line that fixes the alignment. Asserted structurally because the real path needs a
        // canvas and a decoded HTMLImageElement, neither of which exists in a unit test.
        const body = src('src', 'graphics', 'systems', 'displacement.ts')
            .match(/export function heightField[\s\S]*?\n\}/);
        expect(body, 'heightField not found').not.toBeNull();
        expect(body![0], 'the canvas must be flipped before the draw').toMatch(/ctx\.scale\(1,\s*-1\)/);
        expect(body![0]).toMatch(/ctx\.translate\(0,\s*image\.height\)/);
        // And the flip must come BEFORE drawImage, or it does nothing.
        expect(body![0].indexOf('ctx.scale(1, -1)')).toBeLessThan(body![0].indexOf('ctx.drawImage'));
    });

    it('the upload really is flipped on both backends', () => {
        // The premise the flip corrects. If either of these stops negating, this whole correction
        // inverts and the bug comes back the other way round — so they are pinned here rather than
        // trusted to a comment.
        expect(src('src', 'graphics', 'rhi', 'webgl2', 'webgl2Device.ts'))
            .toMatch(/UNPACK_FLIP_Y_WEBGL,\s*!this\._flipY/);
        expect(src('src', 'graphics', 'rhi', 'webgpu', 'webgpuDevice.ts'))
            .toMatch(/flipY:\s*!\(this\._config\?\.flipY\s*\?\?\s*true\)/);
        expect(src('src', 'graphics', 'texture.ts'), 'and flipY defaults to false')
            .toMatch(/this\._flipY = options\?\.flipY \|\| false/);
    });
});

describe('the splat is deliberately the other way round', () => {
    it('is uploaded unflipped, so its CPU reader stays top-down', () => {
        // This asymmetry is real and would otherwise look like a second bug. The splat is written from
        // raw bytes through `uploadBytes`, which disables the flip so the data maps 1:1 to uv — which is
        // why `Terrain._splatAt` indexes it directly while the height field has to be flipped at ingest.
        expect(src('src', 'graphics', 'rhi', 'webgl2', 'webgl2Device.ts'))
            .toMatch(/UNPACK_FLIP_Y_WEBGL,\s*false/);
        const splatAt = src('src', 'terrain', 'terrain.ts')
            .match(/_splatAt\([^)]*\)[^{]*\{([\s\S]*?)\n    \}/);
        expect(splatAt, '_splatAt not found').not.toBeNull();
        expect(splatAt![1], 'no flip on the splat').not.toMatch(/1\s*-\s*gz|height\s*-\s*1\s*-/);
    });
});
