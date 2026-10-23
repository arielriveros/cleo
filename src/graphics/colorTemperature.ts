/**
 * The colour of a black body at `kelvin`, as an RGB tint whose brightest channel is 1 — brightness belongs
 * in a light's intensity, not its colour. Tanner Helland's fit to the Planckian locus, good from about
 * 1000 K to 40 000 K, returned in the same 0..1 display-referred space the colour pickers write.
 */
export function kelvinToRgb(kelvin: number): [number, number, number] {
    const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const g = t <= 66
        ? 99.4708025861 * Math.log(t) - 161.1195681661
        : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    const c = [r, g, b].map(v => Math.min(255, Math.max(0, v)));
    const max = Math.max(c[0], c[1], c[2]) || 1;
    return [c[0] / max, c[1] / max, c[2] / max];
}
