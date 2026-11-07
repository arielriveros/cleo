import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PostEffects } from '../src/graphics/render/postEffects';
import type { ToneMapper } from '../src/graphics/render/settingsTypes';

/**
 * The tone curves (chunks/grade.wgsl) and the ids the renderer uploads for them.
 *
 * Two tables tie a `ToneMapper` to a curve: `PostEffects.toneMapperId` and the TONE_* constants the
 * shader switches on. A mismatch renders a plausible wrong picture, so they are compared here. The
 * AgX curves are transcribed (with their constants read back out of the WGSL) to pin AgX Punchy's
 * input gain: middle grey must come out as bright as plain AgX makes it.
 */

const GRADE = readFileSync(join(__dirname, '../src/graphics/shaders/wgsl/chunks/grade.wgsl'), 'utf-8');

function wgslConst(name: string): number {
    const m = GRADE.match(new RegExp(`const ${name}: (?:i32|f32) = (-?[0-9.]+);`));
    if (!m) throw new Error(`no const ${name} in grade.wgsl`);
    return Number(m[1]);
}

/** A `mat3x3<f32>(vec3(...), vec3(...), vec3(...))` constant, as three COLUMNS. */
function wgslMat3(name: string): number[][] {
    const start = GRADE.indexOf(`const ${name} = mat3x3<f32>(`);
    if (start < 0) throw new Error(`no mat3 ${name} in grade.wgsl`);
    const body = GRADE.slice(start, GRADE.indexOf(');', start));
    const cols = [...body.matchAll(/vec3<f32>\(([^)]*)\)/g)].map(m => m[1].split(',').map(Number));
    expect(cols.length).toBe(3);
    return cols;
}

const S2R = wgslMat3('AGX_SRGB_TO_REC2020');
const R2S = wgslMat3('AGX_REC2020_TO_SRGB');
const INSET = wgslMat3('AGX_INSET');
const OUTSET = wgslMat3('AGX_OUTSET');
const MIN_EV = wgslConst('AGX_MIN_EV');
const MAX_EV = wgslConst('AGX_MAX_EV');

const mul = (cols: number[][], v: number[]) => [0, 1, 2].map(r => cols[0][r] * v[0] + cols[1][r] * v[1] + cols[2][r] * v[2]);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const luma = (v: number[]) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

function sigmoid(x: number): number {
    const x2 = x * x, x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

function agxEncode(hdr: number[]): number[] {
    const c = mul(INSET, mul(S2R, hdr)).map(v => Math.max(1e-10, v));
    return c.map(v => sigmoid(clamp01((Math.log2(v) - MIN_EV) / (MAX_EV - MIN_EV))));
}

function agxDecode(s: number[]): number[] {
    const c = mul(OUTSET, s).map(v => Math.pow(Math.max(0, v), 2.2));
    return mul(R2S, c).map(clamp01);
}

const agx = (hdr: number[]) => agxDecode(agxEncode(hdr));

function agxPunchy(hdr: number[]): number[] {
    const c = agxEncode(hdr.map(v => v * wgslConst('AGX_PUNCHY_GAIN')));
    const l = luma(c);
    const p = c.map(v => Math.pow(Math.max(0, v), wgslConst('AGX_PUNCHY_POWER')));
    return agxDecode(p.map(v => l + wgslConst('AGX_PUNCHY_SATURATION') * (v - l)));
}

/** Chroma as max/min channel spread over luminance: how far from grey a colour sits. */
const chroma = (v: number[]) => (Math.max(...v) - Math.min(...v)) / Math.max(1e-6, luma(v));

describe('tone mapper ids', () => {
    const expected: Record<ToneMapper, string> = {
        agx: 'TONE_AGX', aces: 'TONE_ACES', neutral: 'TONE_NEUTRAL', none: 'TONE_NONE', agxPunchy: 'TONE_AGX_PUNCHY',
    };

    it('upload the id the shader switches on, for every tone mapper', () => {
        for (const [mapper, constant] of Object.entries(expected)) {
            const id = PostEffects.prototype.toneMapperId.call({ toneMapper: mapper } as unknown as PostEffects);
            expect(id, mapper).toBe(wgslConst(constant));
        }
    });

    it('are distinct, and toneCurve dispatches each one', () => {
        const ids = Object.values(expected).map(wgslConst);
        expect(new Set(ids).size).toBe(ids.length);
        for (const name of ['TONE_ACES', 'TONE_NEUTRAL', 'TONE_NONE', 'TONE_AGX_PUNCHY'])
            expect(GRADE).toMatch(new RegExp(`if \\(mapper == ${name}\\)`));
    });
});

describe('AgX Punchy', () => {
    it('keeps middle grey where plain AgX puts it', () => {
        const grey = [0.18, 0.18, 0.18];
        const plain = luma(agx(grey));
        const punchy = luma(agxPunchy(grey));
        expect(Math.abs(Math.log2(punchy / plain))).toBeLessThan(0.03);
    });

    it('keeps a clear sky bluer than plain AgX does, at the same brightness', () => {
        // Single-scattering Rayleigh: the blue of a clear sky, exposed to middle grey.
        const base = [0.25, 0.525, 1.0];
        const sky = base.map(v => v * 0.18 / luma(base));
        const plain = agx(sky), punchy = agxPunchy(sky);
        expect(punchy[2]).toBeGreaterThan(punchy[0]);
        expect(chroma(punchy)).toBeGreaterThan(chroma(plain) * 1.3);
        expect(Math.abs(Math.log2(luma(punchy) / luma(plain)))).toBeLessThan(0.35);
    });

    it('adds contrast: darker below middle grey, brighter above it', () => {
        const at = (v: number, curve: (h: number[]) => number[]) => luma(curve([v, v, v]));
        expect(at(0.05, agxPunchy)).toBeLessThan(at(0.05, agx));
        expect(at(1.0, agxPunchy)).toBeGreaterThan(at(1.0, agx));
    });

    it('stays in [0, 1] and black stays black', () => {
        for (const v of [0, 1e-4, 0.01, 0.18, 1, 4, 16, 1000]) {
            for (const tint of [[1, 1, 1], [1, 0.05, 0.02], [0.02, 0.1, 1], [0.1, 1, 0.05]]) {
                for (const c of agxPunchy(tint.map(t => t * v))) {
                    expect(c).toBeGreaterThanOrEqual(0);
                    expect(c).toBeLessThanOrEqual(1);
                }
            }
        }
        expect(luma(agxPunchy([0, 0, 0]))).toBeLessThan(1e-3);
    });
});
