import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The sky bake's march (skyAtmosphere.wgsl) has to converge in physical units, where the sky is lit by
 * the real sun and nothing is left to tune it back. An even march to the atmosphere's top starved the
 * integral whenever the atmosphere was thick: the Valley's (6,100 km planet, 1,300 km of air, 15 steps)
 * put its first sample 43 km up, and its zenith came out 17x too dark — a black sky over sunlit ground.
 *
 * The march is transcribed here (single scattering, Rayleigh + Mie, the shader's step rule) and checked
 * against a converged reference; the WGSL is checked to route all three marches through the same rule.
 */

const SKY = readFileSync(join(__dirname, '../src/graphics/shaders/wgsl/skyAtmosphere.wgsl'), 'utf-8');

type Vec3 = [number, number, number];
interface Air { R: number; A: number; Hr: number; Hm: number; rayleigh: number; mie: number; g: number }

function sphere(ro: Vec3, rd: Vec3, r: number): [number, number] {
    const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
    const c = ro[0] ** 2 + ro[1] ** 2 + ro[2] ** 2 - r * r;
    const d = b * b - c;
    if (d < 0) return [1e9, -1e9];
    const s = Math.sqrt(d);
    return [-b - s, -b + s];
}

/** The shader's march: `physical` picks its top (12 scale heights) and quadratic steps. Returns luminance. */
function skyLuminance(air: Air, rd: Vec3, sun: Vec3, viewSteps: number, lightSteps: number, physical: boolean): number {
    const top = physical ? Math.min(air.A, air.R + 12 * Math.max(air.Hr, air.Hm)) : air.A;
    const warp = physical ? 2 : 1;
    const seg = (i: number, n: number, len: number): [number, number] =>
        [Math.pow((i + 0.5) / n, warp) * len, (Math.pow((i + 1) / n, warp) - Math.pow(i / n, warp)) * len];
    const bR = [5.8e-6 * air.rayleigh, 13.5e-6 * air.rayleigh, 33.1e-6 * air.rayleigh], bM = 21e-6 * air.mie;
    const ro: Vec3 = [0, air.R + 1, 0];
    const hit = sphere(ro, rd, top);
    const t0 = Math.max(hit[0], 0);
    let t1 = hit[1];
    const ground = sphere(ro, rd, air.R);
    if (ground[0] > 0) t1 = Math.min(t1, ground[0]);
    const mu = rd[0] * sun[0] + rd[1] * sun[1] + rd[2] * sun[2];
    const pR = 3 / (16 * Math.PI) * (1 + mu * mu);
    const g2 = air.g * air.g;
    const pM = 3 / (8 * Math.PI) * ((1 - g2) * (1 + mu * mu)) / ((2 + g2) * Math.pow(1 + g2 - 2 * air.g * mu, 1.5));
    const sumR = [0, 0, 0], sumM = [0, 0, 0];
    let odR = 0, odM = 0;
    for (let i = 0; i < viewSteps; i++) {
        const [tm, len] = seg(i, viewSteps, t1 - t0);
        const p: Vec3 = [ro[0] + rd[0] * (t0 + tm), ro[1] + rd[1] * (t0 + tm), ro[2] + rd[2] * (t0 + tm)];
        const h = Math.hypot(...p) - air.R;
        const hr = Math.exp(-h / air.Hr) * len, hm = Math.exp(-h / air.Hm) * len;
        odR += hr; odM += hm;
        const lightLen = Math.max(sphere(p, sun, top)[1], 0);
        let lR = 0, lM = 0, shadow = false;
        for (let j = 0; j < lightSteps; j++) {
            const [lt, ll] = seg(j, lightSteps, lightLen);
            const q: Vec3 = [p[0] + sun[0] * lt, p[1] + sun[1] * lt, p[2] + sun[2] * lt];
            const qh = Math.hypot(...q) - air.R;
            if (qh < 0) { shadow = true; break; }
            lR += Math.exp(-qh / air.Hr) * ll; lM += Math.exp(-qh / air.Hm) * ll;
        }
        if (shadow) continue;
        for (let c = 0; c < 3; c++) {
            const att = Math.exp(-(bR[c] * (odR + lR) + bM * 1.1 * (odM + lM)));
            sumR[c] += att * hr; sumM[c] += att * hm;
        }
    }
    const L = [0, 1, 2].map(c => sumR[c] * bR[c] * pR + sumM[c] * bM * pM);
    return 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2];
}

const norm = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
// The Valley's sky as shipped: the souls seed's radii and step counts, the Crisp air.
const VALLEY: Air = { R: 6.1e6, A: 7.4e6, Hr: 8000, Hm: 1000, rayleigh: 1.1, mie: 0.3, g: 0.76 };
const SUN = norm([-0.319, 0.618, 0.718]);   // 38 degrees up
const ZENITH: Vec3 = [0, 1, 0];
const UP_35 = norm([0.58, 0.57, -0.58]);

describe('the physical sky march', () => {
    it('converges on a thick atmosphere, where the even march misses the air', () => {
        for (const dir of [ZENITH, UP_35]) {
            const reference = skyLuminance(VALLEY, dir, SUN, 400, 200, false);
            const even = skyLuminance(VALLEY, dir, SUN, 15, 5, false);
            const physical = skyLuminance(VALLEY, dir, SUN, 15, 5, true);
            expect(reference / even).toBeGreaterThan(5);
            expect(Math.abs(physical / reference - 1)).toBeLessThan(0.05);
        }
    });

    it('routes the view, light and transmittance marches through the same top and step rule', () => {
        expect(SKY).toMatch(/fn marchTop\(\) -> f32/);
        expect(SKY).toMatch(/fn marchSegment\(/);
        // The atmosphere radius is read only by marchTop: nothing marches to it directly any more.
        expect(SKY.match(/u_sky\.u_atmosphereRadius/g)?.length).toBe(2);
        expect(SKY.match(/marchSegment\(/g)?.length).toBeGreaterThanOrEqual(4);
        expect(SKY).toMatch(/raySphere\(ro, rd, marchTop\(\)\)/);
        expect(SKY).toMatch(/raySphere\(pos, sunDir, top\)/);
    });

    it('keeps the legacy artistic sky on the even march its Sun Intensity was tuned against', () => {
        expect(SKY).toMatch(/select\(1\.0, 2\.0, u_sky\.u_physical > 0\.5\)/);
        expect(SKY).toMatch(/select\(u_sky\.u_atmosphereRadius, min\(u_sky\.u_atmosphereRadius, thin\), u_sky\.u_physical > 0\.5\)/);
    });
});
