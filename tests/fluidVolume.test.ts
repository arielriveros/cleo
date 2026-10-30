import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FLUID_BRICK, OCCUPANCY_MARGIN, floatToHalf, floatsToHalves, occupancyFromVolume } from '../src/core/scene/nodes/fluidVolumeNode';

/**
 * Smoke-and-fire volumes: the half-float packing a CPU-filled volume goes through on WebGPU, and where
 * the pass sits in the frame (source-text scanning, as the other renderer contracts do: a Renderer
 * needs a GPU).
 */

const CRLF = new RegExp(String.raw`\r\n`, 'g');
const RENDERER = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8').replace(CRLF, '\n');
const WGSL = readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'fluidVolume.wgsl'), 'utf-8').replace(CRLF, '\n');

/** binary16 bits back to a number, for round-trip checks. */
function halfToFloat(h: number): number {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) return sign * mant * 2 ** -24;
    if (exp === 0x1f) return mant ? NaN : sign * Infinity;
    return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

describe('floatToHalf', () => {
    it('encodes exact values bit for bit', () => {
        expect(floatToHalf(0)).toBe(0);
        expect(floatToHalf(-0)).toBe(0x8000);
        expect(floatToHalf(1)).toBe(0x3c00);
        expect(floatToHalf(-2)).toBe(0xc000);
        expect(floatToHalf(0.5)).toBe(0x3800);
        expect(floatToHalf(65504)).toBe(0x7bff);
    });

    it('saturates overflow to infinity and keeps NaN a NaN', () => {
        expect(floatToHalf(1e6)).toBe(0x7c00);
        expect(floatToHalf(-1e6)).toBe(0xfc00);
        expect(Number.isNaN(halfToFloat(floatToHalf(NaN)))).toBe(true);
    });

    it('round-trips within half precision, subnormals included', () => {
        for (const v of [0.1, 0.25, 0.3333, 1.7, 3.14159, 12.5, 1e-5, 3e-7, 2.2, 0.003]) {
            const back = halfToFloat(floatToHalf(v));
            expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(Math.abs(v) * 2 ** -11, 2 ** -25));
        }
    });

    it('converts arrays element for element', () => {
        const src = new Float32Array([0, 1, 0.5, -2]);
        const dst = new Uint16Array(4);
        floatsToHalves(src, dst);
        expect([...dst]).toEqual([0, 0x3c00, 0x3800, 0xc000]);
    });
});

describe('occupancyFromVolume', () => {
    it('marks the brick holding smoke or fire, plus the margin into its neighbours, and nothing else', () => {
        const n = 24;   // 3 x 3 x 3 bricks
        const data = new Float32Array(n * n * n * 4);
        const set = (x: number, y: number, z: number, d: number, t: number) => { const k = (x + n * (y + n * z)) * 4; data[k] = d; data[k + 1] = t; };
        set(12, 12, 12, 0.5, 0);                      // smoke in the middle brick, well inside it
        set(FLUID_BRICK - 1, 0, 0, 0, 0.9);           // fire at a brick edge: reaches across the margin
        const occ = occupancyFromVolume(data, [n, n, n], 0.25);
        const at = (bx: number, by: number, bz: number) => occ[(bx + 3 * (by + 3 * bz)) * 4];
        expect(at(1, 1, 1)).toBe(255);
        expect(at(0, 0, 0)).toBe(255);
        expect(at(1, 0, 0)).toBe(OCCUPANCY_MARGIN > 0 ? 255 : 0);
        expect(at(2, 2, 2)).toBe(0);
        // Below ignition, heat alone is not fire.
        const cold = new Float32Array(n * n * n * 4);
        cold[(20 + n * (20 + n * 20)) * 4 + 1] = 0.1;
        expect(occupancyFromVolume(cold, [n, n, n], 0.25).some(v => v > 0)).toBe(false);
    });
});

describe('the fluid volume pass', () => {
    const forward = (() => {
        const start = RENDERER.indexOf('\n    private _renderForwardOverlay(');
        return RENDERER.slice(start, RENDERER.indexOf('\n    }\n', start));
    })();

    it('draws after the TAA resolve and before the transparents', () => {
        const taa = forward.indexOf('this._taaResolvePass()');
        const volumes = forward.indexOf('this._renderFluidVolumes(scene)');
        const transparent = forward.indexOf("this._runForwardQueue('transparent'");
        expect(taa).toBeGreaterThan(-1);
        expect(volumes).toBeGreaterThan(taa);
        expect(transparent).toBeGreaterThan(volumes);
    });

    it('is skipped for thumbnails, whose depth snapshot is never taken', () => {
        expect(forward).toMatch(/!this\._thumbnailMode && scene\.fluidVolumes\.size > 0/);
    });

    it('reconstructs rays with the stable inverse, as everything after the resolve does', () => {
        const at = RENDERER.indexOf('private _renderFluidVolumes(');
        const body = RENDERER.slice(at, RENDERER.indexOf('\n    }\n', at));
        expect(body).toContain("sm.setUniform('u_invViewProj', this._invViewProjStable)");
        expect(body).toContain('Renderer._CLOUD_BLEND');
    });

    it('traces, then resolves (temporal only), then composites onto the scene buffer', () => {
        const at = RENDERER.indexOf('private _renderFluidVolumes(');
        const body = RENDERER.slice(at, RENDERER.indexOf('\n    }\n', at));
        const trace = body.indexOf("this._fluidTraceFBO!.renderTarget, 'fluidVolumes'");
        const resolve = body.indexOf("'fluidVolumes.resolve'");
        const composite = body.indexOf("this._sceneFBO.renderTarget, 'fluidVolumes.composite'");
        expect(trace).toBeGreaterThan(-1);
        expect(resolve).toBeGreaterThan(trace);
        expect(composite).toBeGreaterThan(resolve);
        // The resolve is gated on the lead volume's temporal flag.
        expect(body.slice(trace, resolve)).toContain('if (temporal)');
    });

    it('drops the temporal history whenever its targets are resized', () => {
        const at = RENDERER.indexOf('private _ensureFluidTargets(');
        const body = RENDERER.slice(at, RENDERER.indexOf('\n    }\n', at));
        const resize = body.indexOf('fbo.resize(w, h)');
        expect(resize).toBeGreaterThan(-1);
        expect(body.indexOf('this._fluidHistoryValid = false', resize)).toBeGreaterThan(resize);
    });

    it('keeps the vertex and fragment uniform blocks apart (a shared block fails to link on GLSL)', () => {
        const vsStart = WGSL.indexOf('@vertex');
        const vertex = WGSL.slice(vsStart, WGSL.indexOf('\n}\n', vsStart));
        expect(vertex).toContain('u_transform.');
        expect(vertex).not.toContain('u_volume.');
        const fragment = WGSL.slice(WGSL.indexOf('@fragment'));
        expect(fragment).not.toContain('u_transform.');
    });
});
