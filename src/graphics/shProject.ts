/**
 * L2 spherical harmonics from an 8-bit equirect readback (skyProject.wgsl). Pure, so the projection the
 * sky light and the light probes are lit by can be tested without a GPU.
 *
 * Layout: 9 coefficients, rgb each, 4 floats apart (WGSL's 16-byte uniform array stride), in the order
 * chunks/pbrLighting.wgsl `shEval` reads them: L00, L1-1 (y), L10 (z), L11 (x), L2-2, L2-1, L20, L21, L22.
 */

/** How the readback's four bytes hold linear HDR. Must match `u_encoding` in skyProject.wgsl. */
export type EquirectEncoding = 'rgbm' | 'rgbe';

/** skyProject.wgsl's RGBM_RANGE: the multiplier byte spans 0..this. */
export const SKY_RGBM_RANGE = 64.0;

/** skyProject.wgsl's RGBE exponent bias: the alpha byte stores `exponent + this`. */
export const RGBE_BIAS = 128;

/** Floats one SH set takes: 9 coefficients padded to vec4. */
export const SH_FLOATS = 36;

/**
 * Project an equirect map onto L2 spherical harmonics. Row 0 is the south pole on BOTH backends, so no
 * per-backend flip. The `cos(lat)` weight is the solid angle a texel subtends; without it the
 * oversampled poles dominate the integral.
 */
export function projectEquirectToSH(pixels: Uint8Array, w: number, h: number, tint: [number, number, number],
                                    encoding: EquirectEncoding = 'rgbm'): Float32Array {
    const sh = new Float32Array(SH_FLOATS);
    const basis = new Float64Array(9);
    let weightSum = 0;
    for (let row = 0; row < h; row++) {
        const v = (row + 0.5) / h;
        const lat = (v - 0.5) * Math.PI;
        const cosLat = Math.cos(lat);
        const sinLat = Math.sin(lat);
        for (let col = 0; col < w; col++) {
            const u = (col + 0.5) / w;
            const lon = (u - 0.5) * 2 * Math.PI;
            const x = cosLat * Math.sin(lon);
            const y = sinLat;
            const z = -cosLat * Math.cos(lon);

            const i = (row * w + col) * 4;
            // RGBM: rgb x (a x range). RGBE: rgb x 2^(a - bias), a shared exponent, so any range survives.
            const m = encoding === 'rgbe'
                ? (pixels[i + 3] === 0 ? 0 : Math.pow(2, pixels[i + 3] - RGBE_BIAS))
                : pixels[i + 3] / 255 * SKY_RGBM_RANGE;
            const r = (pixels[i] / 255) * m * tint[0];
            const g = (pixels[i + 1] / 255) * m * tint[1];
            const b = (pixels[i + 2] / 255) * m * tint[2];

            const weight = cosLat;
            weightSum += weight;

            // Real SH basis, l = 0..2, in the order chunks/pbrLighting.wgsl evaluates them.
            basis[0] = 0.282095;
            basis[1] = 0.488603 * y; basis[2] = 0.488603 * z; basis[3] = 0.488603 * x;
            basis[4] = 1.092548 * x * y; basis[5] = 1.092548 * y * z;
            basis[6] = 0.315392 * (3 * z * z - 1);
            basis[7] = 1.092548 * x * z; basis[8] = 0.546274 * (x * x - y * y);
            for (let k = 0; k < 9; k++) {
                const c = basis[k] * weight;
                sh[k * 4] += r * c;
                sh[k * 4 + 1] += g * c;
                sh[k * 4 + 2] += b * c;
            }
        }
    }
    // 4*PI is the sphere's solid angle and the weight sum is its discrete counterpart, so this turns
    // the Riemann sum into the integral the coefficients are defined as.
    const norm = weightSum > 0 ? (4 * Math.PI) / weightSum : 0;
    for (let k = 0; k < SH_FLOATS; k++) sh[k] *= norm;
    return sh;
}

/**
 * CPU twin of chunks/pbrLighting.wgsl `shEval` (before its clamp and the intensity / pi): the irradiance
 * E arriving at a surface facing `n` from radiance coefficients. For tests and CPU consumers.
 */
export function shEvalIrradiance(sh: ArrayLike<number>, n: [number, number, number], channel: number): number {
    const c1 = 0.429043, c2 = 0.511664, c3 = 0.743125, c4 = 0.886227, c5 = 0.247708;
    const [x, y, z] = n;
    const L = (k: number) => sh[k * 4 + channel];
    return c4 * L(0)
        + 2 * c2 * (L(3) * x + L(1) * y + L(2) * z)
        + c3 * L(6) * (z * z) - c5 * L(6)
        + c1 * L(8) * (x * x - y * y)
        + 2 * c1 * (L(4) * (x * y) + L(7) * (x * z) + L(5) * (y * z));
}

/** RGBE-encode one linear colour the way skyProject.wgsl does (`u_encoding` 1), for tests. */
export function encodeRGBE(r: number, g: number, b: number): [number, number, number, number] {
    const peak = Math.max(r, g, b);
    if (!(peak > 1e-30)) return [0, 0, 0, 0];
    // The smallest exponent that puts the peak at or under 1, so no channel clips.
    const e = Math.ceil(Math.log2(peak));
    const s = Math.pow(2, -e);
    const q = (v: number) => Math.min(255, Math.max(0, Math.round(v * s * 255)));
    return [q(r), q(g), q(b), Math.min(255, Math.max(1, e + RGBE_BIAS))];
}
