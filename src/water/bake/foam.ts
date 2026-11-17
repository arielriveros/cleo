// FOAM on baked water: whitewater made where the water churns and carried downstream by the current, fading
// as it goes, so a rapid trails foam below it and an eddy behind a rock gathers some. As Unreal's baked river
// simulation makes its foam mask: emitted from the surface's curvature, the water's speed, its swirl and its
// drop, moved with the velocity, dissipating.
//
// Where it is made: where the water loses its energy. Water that runs down a slope or over a drop turns the
// height it falls into speed, and what the bed and its own tumbling take back out of it is what whitens it:
// the head it loses per second, speed times the slope of its energy line (surface height plus v2/2g, along
// the flow). A gentle river loses a centimetre a second and stays clear; a torrent on a one-in-five slope
// some 40 cm a second, and is streaked; the foot of a weir a metre and more, and is white. The smooth tongue
// over the weir's lip is not: it is falling, not yet breaking. Foam grows faster than the loss (to the power
// LOSS_POWER), so a short hard drop makes more than a long steady chute that loses as much.
// The shear beside a jet and the eddy behind a rock add a little. Slow or very thin water makes none.
//
// It is then the steady answer to "carried by the flow, fading over FOAM_LIFE seconds, topped up where it is
// made": each pass every cell takes the foam of the water one cell upstream of it, faded by the time that
// water took to arrive, plus what was made on the way. A pass moves foam one cell, and it fades within a few
// tens of metres, so a hundred passes settle it.

const G = 9.81;
/** Seconds a patch of foam lasts. */
const FOAM_LIFE = 4;
/** Foam made a second by water losing a metre of head a second, and the power it grows with that loss. */
const LOSS_FOAM = 0.5, LOSS_POWER = 2;
/** Passes of the transport: foam travels a cell a pass, and is gone long before it has gone this far. */
const PASSES = 120;
/** The slowest the foam is taken to drift, m/s: in nearly still water it sits and fades. */
const SLOWEST = 0.3;

export interface FoamField {
    nx: number; nz: number; cell: number;
    /** 1 where there is water to carry foam. */
    water: Uint8Array;
    /** The surface height, the water's depth and its velocity, per cell. */
    surface: Float32Array; depth: Float32Array; u: Float32Array; v: Float32Array;
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** How much foam the water makes at each cell, per second. */
export function foamEmission(f: FoamField): Float32Array {
    const { nx, nz, cell, water, surface, depth, u, v } = f;
    const out = new Float32Array(nx * nz);
    const head = (i: number) => surface[i] + (u[i] * u[i] + v[i] * v[i]) / (2 * G);
    for (let z = 1; z < nz - 1; z++) for (let x = 1; x < nx - 1; x++) {
        const i = z * nx + x;
        if (!water[i]) continue;
        const speed = Math.hypot(u[i], v[i]);
        // Slow water makes no foam, nor a film too thin to tumble.
        const live = smooth(0.25, 0.7, speed) * smooth(0.02, 0.08, depth[i]);
        if (live <= 0) continue;
        const l = water[i - 1] ? i - 1 : i, r = water[i + 1] ? i + 1 : i, d = water[i - nx] ? i - nx : i, t = water[i + nx] ? i + nx : i;
        const dx = Math.max(1, r - l) * cell, dz = Math.max(1, (t - d) / nx) * cell;
        const uz = (u[t] - u[d]) / dz, vx = (v[r] - v[l]) / dx;
        // Metres of head lost a second: the speed times the fall of the energy line along the flow.
        const loss = Math.max(0, -(u[i] * (head(r) - head(l)) / dx + v[i] * (head(t) - head(d)) / dz));
        out[i] = live * (LOSS_FOAM * Math.pow(Math.min(loss, 3), LOSS_POWER) + 0.05 * Math.abs(vx - uz));
    }
    return out;
}

/** The foam the water carries at each cell, 0..1: what {@link foamEmission} makes, moved and faded by the flow. */
export function transportFoam(f: FoamField): Float32Array {
    const { nx, nz, cell, water, u, v } = f;
    const n = nx * nz;
    const made = foamEmission(f);
    // Where each cell's water came from one pass ago (in cells), and how long it took.
    const bx = new Float32Array(n), bz = new Float32Array(n), keep = new Float32Array(n), gain = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        if (!water[i]) continue;
        const speed = Math.hypot(u[i], v[i]);
        const drift = Math.max(speed, SLOWEST);
        const time = cell / drift;
        bx[i] = -u[i] / drift; bz[i] = -v[i] / drift;
        keep[i] = Math.exp(-time / FOAM_LIFE);
        gain[i] = made[i] * time;
    }
    let foam = new Float32Array(n), next = new Float32Array(n);
    for (let pass = 0; pass < PASSES; pass++) {
        for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
            const i = z * nx + x;
            if (!water[i]) { next[i] = 0; continue; }
            // The foam of the water upstream, bilinear (banks carry none).
            const px = Math.min(nx - 1.001, Math.max(0, x + bx[i])), pz = Math.min(nz - 1.001, Math.max(0, z + bz[i]));
            const x0 = Math.floor(px), z0 = Math.floor(pz), tx = px - x0, tz = pz - z0;
            const a = z0 * nx + x0;
            const from = (foam[a] * (1 - tx) + foam[a + 1] * tx) * (1 - tz) + (foam[a + nx] * (1 - tx) + foam[a + nx + 1] * tx) * tz;
            next[i] = from * keep[i] + gain[i];
        }
        const swap = foam; foam = next; next = swap;
    }
    for (let i = 0; i < n; i++) foam[i] = foam[i] > 1 ? 1 : foam[i];
    return foam;
}
