import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// A cutout's colour map authored over black (a grass JPG plus a separate mask) went black at a distance
// and kept a dark fringe up close: mips and bilinear filtering averaged the hidden black into the blades.
// TexturePacker now edge-pads the colour by push-pull (colorDilate.wgsl). This file pins the algorithm
// with a CPU mirror of the shader's five modes, and the wiring that makes the renderer use the result.

const ROOT = join(__dirname, '..', 'src', 'graphics');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

type Img = { w: number; h: number; px: number[][] };   // px[i] = [r, g, b, a]

/** Bilinear at a uv, clamp-to-edge — what the GPU sampler does on the intermediate levels. */
function sample(img: Img, u: number, v: number): number[] {
    const x = u * img.w - 0.5, y = v * img.h - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const at = (i: number, j: number) =>
        img.px[Math.min(img.h - 1, Math.max(0, j)) * img.w + Math.min(img.w - 1, Math.max(0, i))];
    return [0, 1, 2, 3].map(c =>
        (at(x0, y0)[c] * (1 - fx) + at(x0 + 1, y0)[c] * fx) * (1 - fy) +
        (at(x0, y0 + 1)[c] * (1 - fx) + at(x0 + 1, y0 + 1)[c] * fx) * fy);
}

function pass(w: number, h: number, f: (u: number, v: number) => number[]): Img {
    const px: number[][] = [];
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px.push(f((i + 0.5) / w, (j + 0.5) / h));
    return { w, h, px };
}

/** The bake, mode for mode as `TexturePacker._bakeDilation` chains them. */
function dilate(base: Img, mask: Img, cutoff: number): Img {
    const push = [pass(base.w, base.h, (u, v) => {
        const b = sample(base, u, v), w = sample(mask, u, v)[0] >= cutoff ? 1 : 0;
        return [b[0] * w, b[1] * w, b[2] * w, w];
    })];
    while (push[push.length - 1].w > 1 || push[push.length - 1].h > 1) {
        const top = push[push.length - 1];
        push.push(pass(Math.max(1, top.w >> 1), Math.max(1, top.h >> 1), (u, v) => sample(top, u, v)));
    }
    let filled = pass(1, 1, (u, v) => {
        const a = sample(push[push.length - 1], u, v);
        return [a[0] / Math.max(a[3], 1e-4), a[1] / Math.max(a[3], 1e-4), a[2] / Math.max(a[3], 1e-4), 1];
    });
    for (let i = push.length - 2; i >= 0; i--) {
        const fine = push[i], coarse = filled;
        filled = pass(fine.w, fine.h, (u, v) => {
            const a = sample(fine, u, v), b = sample(coarse, u, v);
            return [a[0] + (1 - a[3]) * b[0], a[1] + (1 - a[3]) * b[1], a[2] + (1 - a[3]) * b[2], 1];
        });
    }
    return pass(base.w, base.h, (u, v) => [...sample(filled, u, v).slice(0, 3), sample(base, u, v)[3]]);
}

/** 16x16 grass card: a green blade in the middle columns, black everywhere else; the mask matches. */
function grass(): { base: Img; mask: Img } {
    const n = 16, base: number[][] = [], mask: number[][] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const blade = i >= 6 && i <= 9;
        base.push(blade ? [0.2, 0.7, 0.1, 1] : [0, 0, 0, 1]);
        mask.push(blade ? [1, 1, 1, 1] : [0, 0, 0, 1]);
    }
    return { base: { w: n, h: n, px: base }, mask: { w: n, h: n, px: mask } };
}

describe('push-pull edge padding', () => {
    it('keeps every texel the cutout draws exactly as authored', () => {
        const { base, mask } = grass();
        const out = dilate(base, mask, 0.5);
        for (let k = 0; k < out.px.length; k++) {
            if (mask.px[k][0] < 0.5) continue;
            for (let c = 0; c < 3; c++) expect(out.px[k][c]).toBeCloseTo(base.px[k][c], 5);
        }
    });

    it('repaints the hidden black with the blade colour, so a box filter has no black to average in', () => {
        const { base, mask } = grass();
        const out = dilate(base, mask, 0.5);
        for (let k = 0; k < out.px.length; k++) {
            expect(out.px[k][1]).toBeGreaterThan(0.6);          // green everywhere, not black
            expect(out.px[k][1] / Math.max(out.px[k][0], 1e-6)).toBeGreaterThan(3);  // and still grass-hued
        }
        // The 1x1 average of the result — the last mip — is the blade colour, where before it was a
        // quarter of it: 4 blade columns out of 16, the rest black.
        const mean = [0, 1, 2].map(c => out.px.reduce((s, p) => s + p[c], 0) / out.px.length);
        expect(mean[1]).toBeCloseTo(0.7, 2);
        const before = base.px.reduce((s, p) => s + p[1], 0) / base.px.length;
        expect(before).toBeCloseTo(0.175, 3);
    });

    it('uses base alpha as coverage when there is no mask map', () => {
        const { base } = grass();
        const alphaBase: Img = { ...base, px: base.px.map(p => [p[0], p[1], p[2], p[1] > 0 ? 1 : 0]) };
        const out = dilate(alphaBase, { ...alphaBase, px: alphaBase.px.map(p => [p[3], 0, 0, 1]) }, 0.5);
        expect(out.px[0][1]).toBeGreaterThan(0.6);
        expect(out.px[0][3]).toBe(0);          // the cutout itself is untouched
    });
});

describe('wiring', () => {
    it('the renderer binds the edge-padded colour in place of the authored base colour', () => {
        const renderer = read('renderer.ts');
        expect(renderer).toContain("field === 'baseColorTexture' ? material.textures.get(DILATED_BASE_SLOT)");
    });

    it('foliage prototype materials are synced, so foliage gets the padded colour (and its ORM pack)', () => {
        const renderer = read('renderer.ts');
        const at = renderer.indexOf('private _ensurePackedTextures');
        const body = renderer.slice(at, renderer.indexOf('\n    }\n', at));
        expect(body).toContain('node.terrain.foliage');
        expect(body).toContain('packer.sync(mat, this._frameIndex)');
    });

    it('billboard cards and impostors are padded too: requested before any pass opens, bound at draw', () => {
        const renderer = read('renderer.ts');
        const at = renderer.indexOf('private _ensurePackedTextures');
        const body = renderer.slice(at, renderer.indexOf('\n    }\n', at));
        expect(body).toContain('packer.ensureDilated(card, 0.5, this._frameIndex)');
        expect(renderer).toContain('TexturePacker.Instance.dilatedId(texId, 0.5)');
        // An impostor re-bake reuses its texture id, so the cache must notice the source object changed.
        expect(read('systems/texturePacker.ts')).toContain('entry.source === TextureManager.Instance.getTexture(sourceId)');
    });

    it('only cutout materials are padded, and the derived slot never reaches an asset', () => {
        const packer = read('systems/texturePacker.ts');
        expect(packer).toContain("!(cutoff > 0)");
        expect(packer).toContain("export const DILATED_BASE_SLOT = 'baseColorDilated'");
        // Material.serialize writes a fixed key list; the derived slot must not be on it.
        expect(read('material.ts')).not.toContain('baseColorDilated');
    });

    it('the shader carries covered texels through the pull untouched', () => {
        const wgsl = read('shaders/wgsl/colorDilate.wgsl');
        expect(wgsl).toContain('a.rgb + (1.0 - a.a) * b.rgb');
        expect(wgsl).toContain('textureSampleLevel');
        expect(wgsl).not.toMatch(/textureSample\(/);
    });
});
