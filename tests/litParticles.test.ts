import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import './helpers/features';
import { heightToTangentNormal, multiScatter } from '../src/core/math';
import { sixWayFromDensity } from '../src/particles/sixWaySprites';
import {
    BUILTIN_FOAM_NORMAL, BUILTIN_MIST_NORMAL, BUILTIN_MIST_SIXWAY_NEG, BUILTIN_MIST_SIXWAY_POS, BUILTIN_MIST_SPRITE,
    BUILTIN_SPRAY_NORMAL, BUILTIN_SPRAY_SPRITE,
} from '../src/particles/spraySprites';
import { BUILTIN_SPRITE_LAYOUT, builtinSpriteSheet, isDerivedBuiltin } from '../src/particles/precipitationSprites';
import { SURFACE, surfaceFlags } from '../src/particles/particlePack';
import { defaultParticleSystem, parseParticleSystem, particleSystemReferences } from '../src/particles/particleSystemAsset';
import { particleDrawProgramName } from '../src/graphics/particles/particlePrograms';
import { hemisphereFill, skyAmbient, skyIrradianceAt } from '../src/graphics/particles/particleLighting';
import { createProgramUsage, usageFromSceneJson } from '../src/graphics/programUsage';

const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
const read = (...p: string[]) => readFileSync(join(WGSL, ...p), 'utf-8');

describe('lit particle maths', () => {
    it('a height field leans its normal away from the rise, in the OpenGL convention', () => {
        // A ramp rising to the right (x) and toward the top of the image (row 0): the normal leans left and down.
        const w = 5, h = 5;
        const right = new Float32Array(w * h), top = new Float32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { right[y * w + x] = x * 0.1; top[y * w + x] = (h - 1 - y) * 0.1; }
        const nr = heightToTangentNormal(right, w, h, 2, 2, 1);
        expect(nr[0]).toBeLessThan(0);
        expect(Math.abs(nr[1])).toBeLessThan(1e-6);
        const nt = heightToTangentNormal(top, w, h, 2, 2, 1);
        expect(nt[1]).toBeLessThan(0);
        for (const n of [nr, nt]) {
            expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 6);
            expect(n[2]).toBeGreaterThan(0);
        }
        const flat = heightToTangentNormal(new Float32Array(w * h), w, h, 2, 2, 5);
        expect(flat[0]).toBeCloseTo(0, 9); expect(flat[1]).toBeCloseTo(0, 9); expect(flat[2]).toBeCloseTo(1, 9);
    });

    it('multiple scattering is 1 at no depth and falls to a floor above zero', () => {
        expect(multiScatter(0)).toBeCloseTo(1, 6);
        expect(multiScatter(-3)).toBeCloseTo(1, 6);
        let last = 1;
        for (const tau of [0.5, 1, 2, 4, 8, 16]) {
            const v = multiScatter(tau);
            expect(v).toBeLessThan(last);
            expect(v).toBeGreaterThan(0);
            last = v;
        }
        // A thick cloud's shaded side is not black: more than a bare exp(-tau).
        expect(multiScatter(4)).toBeGreaterThan(Math.exp(-4) * 2);
    });

    it('the sky irradiance of a uniform sky is the same facing every way, and equals its mean', () => {
        const sh = new Float32Array(36);
        sh[0] = 2; sh[1] = 3; sh[2] = 4;
        const mean = skyAmbient(sh, 1);
        for (const n of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0, -1]]) {
            const e = skyIrradianceAt(sh, n, 1);
            for (let c = 0; c < 3; c++) expect(e[c]).toBeCloseTo(mean[c], 5);
        }
        expect(skyIrradianceAt(null, [0, 1, 0], 1)).toEqual([0, 0, 0]);
    });

    it('a brighter sky overhead lights an up-facing surface more than a down-facing one', () => {
        const sh = new Float32Array(36);
        sh[0] = 1; sh[1] = 1; sh[2] = 1;
        sh[4] = 0.6; sh[5] = 0.6; sh[6] = 0.6; // L1,-1: the Y band, +Y bright
        const up = skyIrradianceAt(sh, [0, 1, 0], 1), down = skyIrradianceAt(sh, [0, -1, 0], 1);
        expect(up[0]).toBeGreaterThan(down[0]);
    });

    it('the hemisphere fill keeps the probe fill when the sky is even, and brightens with the sky above', () => {
        expect(hemisphereFill([0.2, 0.2, 0.2], [0.3, 0.3, 0.3], [0.3, 0.3, 0.3])).toEqual([0.2, 0.2, 0.2]);
        const lifted = hemisphereFill([0.2, 0.2, 0.2], [0.3, 0.3, 0.3], [0.45, 0.45, 0.45]);
        expect(lifted[0]).toBeGreaterThan(0.2);
        const never = hemisphereFill([0.01, 0.01, 0.01], [0.5, 0.5, 0.5], [0, 0, 0]);
        for (const v of never) expect(v).toBeGreaterThanOrEqual(0);
    });
});

describe('six-way lightmaps from a density', () => {
    const w = 32, h = 32;
    const D = new Float32Array(w * h), alpha = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const r2 = ((x - 15.5) / 12) ** 2 + ((y - 15.5) / 12) ** 2;
        D[y * w + x] = Math.max(0, 1 - r2);
        alpha[y * w + x] = 1 - Math.exp(-1.8 * D[y * w + x]);
    }
    const opts = { sigma: 2.2, column: 1.6, floor: 0.45 };
    const cell = sixWayFromDensity(D, alpha, w, h, opts);

    it('is deterministic and the size of the cell', () => {
        const again = sixWayFromDensity(D, alpha, w, h, opts);
        expect(Buffer.from(again.pos)).toEqual(Buffer.from(cell.pos));
        expect(Buffer.from(again.neg)).toEqual(Buffer.from(cell.neg));
        expect(cell.pos.length).toBe(w * h * 4);
    });

    it('never goes darker than the floor, and the side facing the light is the brighter', () => {
        const at = (x: number, y: number) => (y * w + x) * 4;
        // Light from the right (pos.r) reaches the right half more than the left; light from the left (neg.r), the reverse.
        const L = at(8, 16), R = at(23, 16);
        expect(cell.pos[R]).toBeGreaterThan(cell.pos[L]);
        expect(cell.neg[L]).toBeGreaterThan(cell.neg[R]);
        for (let i = 0; i < w * h; i++) {
            if (alpha[i] <= 0.05) continue;
            expect(cell.pos[i * 4]).toBeGreaterThanOrEqual(Math.floor(0.45 * 255) - 1);
            expect(cell.neg[i * 4]).toBeGreaterThanOrEqual(Math.floor(0.45 * 255) - 1);
        }
    });

    it('carries the coverage in the positive map alpha', () => {
        for (const i of [0, 16 * w + 16, 8 * w + 8]) expect(cell.pos[i * 4 + 3]).toBe(Math.round(Math.min(1, Math.max(0, alpha[i])) * 255));
    });
});

describe('the built-in spray, foam and mist maps', () => {
    const ids = [BUILTIN_SPRAY_NORMAL, BUILTIN_MIST_NORMAL, BUILTIN_FOAM_NORMAL, BUILTIN_MIST_SIXWAY_POS, BUILTIN_MIST_SIXWAY_NEG];

    it('are registered as derived sheets of their alpha sheets', () => {
        for (const id of ids) {
            expect(isDerivedBuiltin(id), id).toBe(true);
            const layout = BUILTIN_SPRITE_LAYOUT[id], base = BUILTIN_SPRITE_LAYOUT[layout.of!];
            expect(base, id).toBeDefined();
            expect([layout.width, layout.height, layout.columns, layout.rows, layout.frames])
                .toEqual([base.width, base.height, base.columns, base.rows, base.frames]);
        }
        for (const id of [BUILTIN_SPRAY_SPRITE, BUILTIN_MIST_SPRITE]) expect(isDerivedBuiltin(id)).toBe(false);
    });

    it('alpha sheets are white with the shape in alpha; normal maps are unit length facing out, flat at the border', () => {
        const sprite = builtinSpriteSheet(BUILTIN_MIST_SPRITE)!;
        for (let i = 0; i < sprite.pixels.length; i += 4 * 97) expect([sprite.pixels[i], sprite.pixels[i + 1], sprite.pixels[i + 2]]).toEqual([255, 255, 255]);
        for (const id of [BUILTIN_SPRAY_NORMAL, BUILTIN_FOAM_NORMAL, BUILTIN_MIST_NORMAL]) {
            const s = builtinSpriteSheet(id)!;
            let tilted = 0;
            for (let i = 0; i < s.pixels.length; i += 4) {
                const n = [s.pixels[i] / 255 * 2 - 1, s.pixels[i + 1] / 255 * 2 - 1, s.pixels[i + 2] / 255 * 2 - 1];
                expect(Math.hypot(n[0], n[1], n[2]), id).toBeGreaterThan(0.97);
                expect(Math.hypot(n[0], n[1], n[2]), id).toBeLessThan(1.03);
                expect(n[2], id).toBeGreaterThan(0);
                if (Math.hypot(n[0], n[1]) > 0.1) tilted++;
            }
            expect(tilted, `${id} has relief`).toBeGreaterThan(50);
            expect([...s.pixels.slice(0, 4)], `${id} corner`).toEqual([128, 128, 255, 255]);
        }
    }, 60000);

    it('the mist six-way maps cover exactly where the mist sprite does, and are deterministic', () => {
        const mist = builtinSpriteSheet(BUILTIN_MIST_SPRITE)!, pos = builtinSpriteSheet(BUILTIN_MIST_SIXWAY_POS)!;
        for (let i = 3; i < mist.pixels.length; i += 4) expect(Math.abs(pos.pixels[i] - mist.pixels[i])).toBeLessThanOrEqual(1);
        expect(pos.pixels.slice(0, 4)[3]).toBe(0);
        const neg = builtinSpriteSheet(BUILTIN_MIST_SIXWAY_NEG)!;
        expect(builtinSpriteSheet(BUILTIN_MIST_SIXWAY_NEG)).toBe(neg);
    }, 60000);

    it('the mist has no round outline: its alpha eases to nothing before the cell edge', () => {
        const s = builtinSpriteSheet(BUILTIN_MIST_SPRITE)!;
        const cw = s.width / s.columns, ch = s.height / s.rows;
        for (let cell = 0; cell < s.frames; cell++) {
            const ox = (cell % s.columns) * cw, oy = Math.floor(cell / s.columns) * ch;
            let edgeMax = 0;
            for (let t = 0; t < cw; t++) {
                for (const [x, y] of [[t, 0], [t, ch - 1], [0, t], [cw - 1, t]]) edgeMax = Math.max(edgeMax, s.pixels[((oy + y) * s.width + ox + x) * 4 + 3]);
            }
            expect(edgeMax, `cell ${cell} edge`).toBeLessThan(4);
            // A step the eye would read as a disc: no neighbouring pixels on the middle row differ by a large jump.
            let jump = 0;
            for (let x = 1; x < cw; x++) jump = Math.max(jump, Math.abs(s.pixels[((oy + ch / 2) * s.width + ox + x) * 4 + 3] - s.pixels[((oy + ch / 2) * s.width + ox + x - 1) * 4 + 3]));
            expect(jump, `cell ${cell} outline`).toBeLessThan(40);
        }
    }, 60000);
});

describe('a lit emitter\'s surface', () => {
    const lit = { lit: true, shading: undefined, roughness: 1, metallic: 0 } as const;
    const none = { normal: false, orm: false, sixWay: false };

    it('an unlit emitter has none', () => {
        expect(surfaceFlags({ ...lit, lit: false }, { normal: true, orm: true, sixWay: true }, false)).toBe(0);
    });

    it('a normal map alone is relief, not PBR', () => {
        expect(surfaceFlags(lit, { ...none, normal: true }, false)).toBe(SURFACE.NORMAL_MAP);
        expect(surfaceFlags(lit, none, false)).toBe(0);
    });

    it('PBR needs roughness below 1, metallic or an ORM map', () => {
        expect(surfaceFlags({ ...lit, roughness: 0.4 }, { ...none, normal: true }, false)).toBe(SURFACE.NORMAL_MAP | SURFACE.PBR);
        expect(surfaceFlags({ ...lit, metallic: 1 }, none, false)).toBe(SURFACE.PBR);
        expect(surfaceFlags(lit, { ...none, orm: true }, false)).toBe(SURFACE.ORM_MAP | SURFACE.PBR);
    });

    it('rain is exclusive, and six-way needs both maps and a billboard', () => {
        expect(surfaceFlags({ ...lit, shading: 'rain' }, { normal: true, orm: true, sixWay: true }, false)).toBe(SURFACE.RAIN);
        expect(surfaceFlags({ ...lit, shading: 'sixWay' }, { ...none, sixWay: true }, false)).toBe(SURFACE.SIX_WAY);
        expect(surfaceFlags({ ...lit, shading: 'sixWay' }, { ...none, sixWay: true }, true)).toBe(0);
        expect(surfaceFlags({ ...lit, shading: 'sixWay' }, none, false)).toBe(0);
    });

    it('mirrors every SURFACE bit in the draw chunk', () => {
        const core = read('chunks', 'particleDraw.wgsl');
        for (const [key, bit] of Object.entries(SURFACE)) {
            const m = new RegExp(`const SURFACE_${key}: u32\\s*= (\\d+)u;`).exec(core);
            expect(m, `SURFACE_${key}`).not.toBeNull();
            expect(Number(m![1]), `SURFACE_${key}`).toBe(bit);
        }
    });
});

describe('six-way shading in the asset', () => {
    it('round-trips the new fields and saves nothing for an effect that does not use them', () => {
        const def = defaultParticleSystem();
        Object.assign(def.emitters[0].render, { lit: true, shading: 'sixWay', sixWayPositiveTextureId: 'p', sixWayNegativeTextureId: 'n', occlusion: 0.75 });
        const back = parseParticleSystem(JSON.parse(JSON.stringify(def))).emitters[0].render;
        expect([back.shading, back.sixWayPositiveTextureId, back.sixWayNegativeTextureId, back.occlusion]).toEqual(['sixWay', 'p', 'n', 0.75]);
        const old = parseParticleSystem({ emitters: [{ render: { lit: true, textureId: 't' } }] }).emitters[0].render;
        for (const k of ['shading', 'sixWayPositiveTextureId', 'sixWayNegativeTextureId', 'occlusion']) expect(k in old, k).toBe(false);
    });

    it('references the six-way textures, and never a built-in id', () => {
        const def = defaultParticleSystem();
        Object.assign(def.emitters[0].render, {
            lit: true, shading: 'sixWay', sixWayPositiveTextureId: 'p', sixWayNegativeTextureId: BUILTIN_MIST_SIXWAY_NEG,
            normalTextureId: BUILTIN_SPRAY_NORMAL,
        });
        expect(particleSystemReferences(def).textures).toEqual(['p']);
    });
});

describe('the per-pixel draw programs', () => {
    it('are named for the variant', () => {
        expect(particleDrawProgramName(false, false)).toBe('particleBillboard');
        expect(particleDrawProgramName(false, true)).toBe('particleBillboard~lit');
        expect(particleDrawProgramName(true, false)).toBe('particleMesh');
        expect(particleDrawProgramName(true, true)).toBe('particleMesh~lit');
    });

    it('ship with a game that has a lit particle effect, and not otherwise', () => {
        const system = (lit: boolean) => {
            const def = defaultParticleSystem();
            def.emitters[0].render.lit = lit;
            return { type: 'particleSystem', particleSystem: JSON.parse(JSON.stringify(def)) };
        };
        const withLit = createProgramUsage();
        usageFromSceneJson(system(true), withLit);
        expect(withLit.names.has('particleBillboard~lit')).toBe(true);
        const without = createProgramUsage();
        usageFromSceneJson(system(false), without);
        expect(without.names.has('particleBillboard~lit')).toBe(false);
        expect(without.names.has('particleBillboard')).toBe(true);
    });

    it('declare the frame lighting only in the lit variant', () => {
        for (const file of ['particleBillboard.wgsl', 'particleMesh.wgsl']) {
            const src = read(file);
            expect(src, file).toMatch(/\/\/ @variant lit PARTICLE_LIT/);
        }
        const draw = read('chunks', 'particleDraw.wgsl');
        // The shadow, PBR and cluster includes live inside the lit branch, so the base program never declares group 3.
        const litStart = draw.indexOf('#ifdef PARTICLE_LIT');
        expect(litStart).toBeGreaterThan(-1);
        for (const inc of ['shadows.wgsl', 'clusteredLights.wgsl']) {
            const at = draw.indexOf(inc);
            expect(at, inc).toBeGreaterThan(litStart);
        }
    });
});
