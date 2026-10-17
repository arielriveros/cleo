import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Mip-aware alpha testing (chunks/alphaCutout.wgsl). A cutout against box-filtered mip alpha thins and
// shimmers with distance; every alpha test has to go through `cutoutAlpha`, or the one that does not is
// exactly where distant leaves keep sparkling.

const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
const read = (rel: string) => readFileSync(join(WGSL, rel), 'utf-8');

const CUTOUT_FILES = [
    'chunks/pbrGBuffer.wgsl', 'chunks/pbrForward.wgsl', 'chunks/blinnPhongGBuffer.wgsl', 'chunks/blinnPhongForward.wgsl',
    'chunks/celForward.wgsl', 'chunks/basicGBuffer.wgsl', 'chunks/basicForward.wgsl', 'geometryFoliageBillboard.wgsl',
    ...readdirSync(WGSL).filter(f => /^shadowMap.*Cutout\.wgsl$/.test(f)),
];

describe('every alpha test is mip-aware', () => {
    it.each(CUTOUT_FILES)('%s tests cutoutAlpha, not the raw fetch', (file) => {
        const src = read(file);
        expect(src).toMatch(/#include "\.\/(chunks\/)?alphaCutout\.wgsl"/);
        expect(src).toMatch(/cutoutAlpha\(/);
        // No bare threshold compare on a raw texel alpha is left behind.
        expect(src).not.toMatch(/texel\.a < u_material\.alphaCutoff/);
        expect(src).not.toMatch(/if \(c\.a < 0\.5\)/);
    });

    it('scales alpha up with the level the hardware reads (the larger axis), from mip 0', () => {
        const src = read('chunks/alphaCutout.wgsl');
        expect(src).toMatch(/max\(dot\(a, a\), dot\(b, b\)\)/);
        expect(src).toMatch(/alpha \* \(1\.0 \+ cutoutMip\(/);
    });
});
