// The colour of fire by temperature, the way Nguyen, Fedkiw & Jensen (2002) render it: Planck's
// black-body spectrum integrated against the CIE 1931 colour-matching functions, then von Kries / CAT02
// chromatic adaptation to the HOTTEST temperature as the white point -- the eye adapts to the brightest
// part of a fire, which is why a hot core reads white and the cooler body orange and red -- then linear
// sRGB. Brightness follows the spectrum itself, so it rises steeply (about T^4) with temperature.
//
// Colour matching: Wyman, Sloan & Shirley 2013, "Simple Analytic Approximations to the CIE XYZ Color
// Matching Functions" (the multi-lobe piecewise-Gaussian fit). Adaptation: the CIECAM02 CAT02 matrix.

type V3 = [number, number, number];

const H = 6.62607015e-34, C = 2.99792458e8, K = 1.380649e-23;

/** Planck's law: spectral radiance of a black body at `kelvin`, wavelength in nanometres (relative units). */
export function planck(nm: number, kelvin: number): number {
  const l = nm * 1e-9;
  return (2 * H * C * C) / (l ** 5 * (Math.exp((H * C) / (l * K * kelvin)) - 1));
}

const g = (x: number, mu: number, s1: number, s2: number) => {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
};

/** CIE 1931 2-degree colour-matching functions at `nm` (Wyman et al. 2013 multi-lobe fit). */
export function cie1931(nm: number): V3 {
  return [
    1.056 * g(nm, 599.8, 37.9, 31.0) + 0.362 * g(nm, 442.0, 16.0, 26.7) - 0.065 * g(nm, 501.1, 20.4, 26.2),
    0.821 * g(nm, 568.8, 46.9, 40.5) + 0.286 * g(nm, 530.9, 16.3, 31.1),
    1.217 * g(nm, 437.0, 11.8, 36.0) + 0.681 * g(nm, 459.0, 26.0, 13.8),
  ];
}

/** XYZ of a black body at `kelvin` (unnormalised; Y grows steeply with temperature). */
export function blackbodyXYZ(kelvin: number): V3 {
  const out: V3 = [0, 0, 0];
  for (let nm = 380; nm <= 780; nm += 5) {
    const b = planck(nm, kelvin);
    const m = cie1931(nm);
    out[0] += b * m[0]; out[1] += b * m[1]; out[2] += b * m[2];
  }
  return out;
}

const CAT02: number[][] = [[0.7328, 0.4296, -0.1624], [-0.7036, 1.6975, 0.0061], [0.0030, 0.0136, 0.9834]];
const XYZ_TO_SRGB: number[][] = [[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]];
const D65: V3 = [0.95047, 1, 1.08883];

const mul = (m: number[][], v: V3): V3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

function invert3(m: number[][]): number[][] {
  const [a, b, c] = m[0], [d, e, f] = m[1], [gg, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * gg), Cc = d * h - e * gg;
  const det = a * A + b * B + c * Cc;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * gg) / det, -(a * f - c * d) / det],
    [Cc / det, -(a * h - b * gg) / det, (a * e - b * d) / det],
  ];
}
const CAT02_INV = invert3(CAT02);

/**
 * Linear sRGB of a black body at `kelvin`, seen by an eye adapted to a black body at `whiteKelvin`
 * (CAT02 von Kries scaling in LMS), with luminance relative to that white (the white is Y = 1).
 * Components may exceed 1 for temperatures above the white; negatives are clipped to 0.
 */
export function blackbodyRgb(kelvin: number, whiteKelvin: number): V3 {
  const white = blackbodyXYZ(whiteKelvin);
  const xyz = blackbodyXYZ(kelvin);
  const scale = 1 / white[1];
  const src = mul(CAT02, [xyz[0] * scale, xyz[1] * scale, xyz[2] * scale]);
  const lw = mul(CAT02, [white[0] * scale, white[1] * scale, white[2] * scale]);
  const ld = mul(CAT02, D65);
  const adapted = mul(CAT02_INV, [src[0] * ld[0] / lw[0], src[1] * ld[1] / lw[1], src[2] * ld[2] / lw[2]]);
  const rgb = mul(XYZ_TO_SRGB, adapted);
  return [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])];
}
