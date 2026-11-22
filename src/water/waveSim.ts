// The LIVE WAVES a river's surface carries: a simulation of surface waves riding the baked current, run every
// frame on the GPU round the camera (graphics/render/waterWaves.ts; shaders/wgsl/waterWave*.wgsl). This file is
// its arithmetic, on the CPU: the wave operator's kernel, which the shader is handed, and a small reference
// stepper the tests hold the scheme to.
//
// The model is the one Jeschke and Wojtan give in "Generalizing Shallow Water Simulations with Dispersive
// Surface Waves" (ACM TOG 2023): the water is a BULK FLOW that obeys the shallow-water equations (here: the
// flow bake's settled heights and currents, water/bake/) and SURFACE WAVES on top of it that obey Airy's
// linear theory, carried through the bulk velocity u:
//
//     d(eta)/dt = -u . grad(eta) - eta (div u)          the waves ride the current, and steepen where it slows
//     d2(eta)/dt2 = -g K eta                             and they propagate, each length at its own speed
//
// K is the operator whose Fourier symbol is k tanh(k h): the dispersion relation of water waves over a depth h
// (omega^2 = g k tanh(k h)). Short waves run as deep-water waves, sqrt(g / k); long ones no faster than
// sqrt(g h). That, and nothing else, is what makes a wave train stand still below a drop: the one length
// whose speed against the current equals the current's stays where it is, and the rest are swept away or
// escape upstream. A height-field wave equation with one speed for every length cannot do it.
//
// On a grid K is a convolution, as in Tessendorf's iWave ("Interactive Water Surfaces", Game Programming
// Gems 4): a (2P + 1) square kernel, P = 6. iWave's own kernel is the deep-water one, smoothed and scaled by
// eye; this one is fitted to the symbol itself for a given depth, in metres, so the waves run at their real
// speeds (waveSimKernel). Over a finite depth the symbol is smooth at k = 0 and its kernel dies off within a
// few depths, which is what lets thirteen taps a side hold it: a river is shallow.
//
// The transport is semi-Lagrangian (each cell takes what the current brings it) with a Catmull-Rom cubic,
// because a linear lookup smears a four-cell wave away within ten steps.
//
// What RAISES the waves is in the shader alone (waterWaveStep.wgsl: the bulk flow's turns, turbulence, the
// stones of the bed, and what stands in the water), and so is the foam they make. The stepper here takes any
// forcing as a field, which is how the tests hold the shader's forcing to what it should do: a push that
// stands still in a current leaves a wake that stands still, downstream of it.
//
// What stands in the water (a static collider: a post, a pier, a rock; water/bake/obstacles.ts footprints) is
// SOLID to the waves, as an obstruction is in iWave: no wave inside it, so waves that reach it are thrown back.
// The current piling against it and parting round it is the local flow's (water/localFlow.ts), which the waves
// ride.
//
// What MOVES through the water (a body crossing the surface: something dropped in, a floating crate bobbing,
// a character wading, a hull; core/scene/nodes/waterVolumeNode.ts disturbances) pushes the surface under it
// (bodyWavePush): down as it sinks into it, up as it rises out, up ahead of it and down behind as it goes
// through, all against the water's own motion. The wave operator turns that into what water does with it:
// the ring a stone throws, the bow wave and the V of a wake. The waves then ride the current like any other,
// so the rings a body throws into a river are carried off downstream with it.

import { catmullRomWeights, clamp, smoothstep } from '../core/math';

/** Texels along a side of the simulated window, and metres a texel. */
export const WAVE_SIM_SIZE = 512;
export const WAVE_SIM_CELL = 0.15;
/** Seconds a step: fixed, so the waves run the same at every frame rate. */
export const WAVE_SIM_DT = 1 / 60;
/** The kernel's reach, texels each way (iWave's P). */
export const WAVE_SIM_REACH = 6;
/** Distinct weights in the kernel: it depends on the offset's two parts unordered and unsigned. */
export const WAVE_SIM_TAPS = (WAVE_SIM_REACH + 1) * (WAVE_SIM_REACH + 2) / 2;
/** The two depths (m) a kernel is built for; the shader blends them by the water's depth at each texel. */
export const WAVE_SIM_DEPTHS: readonly [number, number] = [0.25, 1.2];
export const WAVE_SIM_GRAVITY = 9.81;

/** Bodies the step is handed at most (waterWaveStep.wgsl BODY_MAX): the nearest the window's centre. */
export const WAVE_SIM_BODY_MAX = 32;
/**
 * Per second: how fast waves die down, on still water and on running water. A river's surface forgets in a
 * second or two, so its waves stay near what raised them; a pond carries a stone's rings for many seconds.
 */
export const WAVE_DAMPING_STILL = 0.12;
export const WAVE_DAMPING_RUNNING = 0.6;

/** Per second: how fast waves die down on water running at `speed` m/s (waterWaveStep.wgsl waveDamping). */
export function waveDamping(speed: number): number {
    return WAVE_DAMPING_STILL + (WAVE_DAMPING_RUNNING - WAVE_DAMPING_STILL) * smoothstep(0.1, 0.6, speed);
}

/** A body crossing the surface, as the step takes it (WaterVolumeNode's WaterDisturbance). */
export interface WaveSimBody {
    /** World x and z of its centre, and its waterline's radius (m). */
    x: number; z: number; radius: number;
    /** 0..1: how much of it the surface cuts. */
    share: number;
    /** Its velocity against the water's own (m/s). */
    vx: number; vy: number; vz: number;
}

/** 1/s: the surface's acceleration under a body per m/s it sinks (or rises) at. */
export const BODY_PUSH_VERTICAL = 1.6;
/** 1/s: the surface's acceleration at a body's leading edge per m/s it moves through the water at. */
export const BODY_PUSH_HORIZONTAL = 1.5;
/** m/s a body's speed against the water is taken as at most: faster is a splash the grid cannot hold anyway. */
export const BODY_SPEED_CAP = 6;
/** Radii from a body's centre past which it pushes nothing (its profile is exp(-2 d^2): 1e-8 there). */
export const BODY_REACH = 3;

/**
 * The surface's acceleration (m/s2) at world (`x`, `z`) from `body`, as waterWaveStep.wgsl adds it: a smooth
 * bump the body's waterline wide (no narrower than a texel and a half), pressed down as the body sinks and
 * raised as it rises, raised ahead of it and drawn down behind as it moves through the water.
 */
export function bodyWavePush(x: number, z: number, body: WaveSimBody, cell = WAVE_SIM_CELL): number {
    const r = Math.max(body.radius, 1.5 * cell);
    const dx = (x - body.x) / r, dz = (z - body.z) / r;
    const d2 = dx * dx + dz * dz;
    if (d2 > BODY_REACH * BODY_REACH || !(body.share > 0)) return 0;
    const profile = Math.exp(-2 * d2) * body.share;
    const vy = clamp(body.vy, -BODY_SPEED_CAP, BODY_SPEED_CAP);
    const planar = Math.hypot(body.vx, body.vz);
    const k = planar > BODY_SPEED_CAP ? BODY_SPEED_CAP / planar : 1;
    return profile * (BODY_PUSH_VERTICAL * vy + BODY_PUSH_HORIZONTAL * (dx * body.vx + dz * body.vz) * k);
}


/** Where the weight for the offset (i, j) sits in a packed kernel. */
export function waveKernelIndex(i: number, j: number): number {
    const a = Math.abs(i), b = Math.abs(j);
    const lo = a < b ? a : b, hi = a < b ? b : a;
    return hi * (hi + 1) / 2 + lo;
}

/** What the grid lets through of a wave of `q` radians a texel: all of the long ones, none at two texels a wave. */
function passed(q: number): number {
    const q0 = 0.5 * Math.PI, q1 = 0.95 * Math.PI;
    if (q <= q0) return 1;
    if (q >= q1) return 0;
    const c = Math.cos(0.5 * Math.PI * (q - q0) / (q1 - q0));
    return c * c;
}

/** The symbol the kernel is built from, per texel: k tanh(k h) for a depth of `depthCells` texels, band-limited. */
export function waveSymbol(q: number, depthCells: number): number {
    return q * Math.tanh(q * depthCells) * passed(q);
}

/**
 * The wave operator's kernel for water `depth` metres deep on a grid of `cell` metres: WAVE_SIM_TAPS weights
 * (see {@link waveKernelIndex}), in units of 1 / texel. Applied to a height field and multiplied by g / cell it
 * gives minus the surface's acceleration.
 *
 * The weights are FITTED to the symbol, not cut out of its inverse transform: a transform cut off at six
 * texels runs every wave longer than a dozen of them a fifth too slow or worse, because what it cuts off is
 * the part of the kernel long waves are made of. The fit is least squares over the whole band, each
 * wavenumber weighted by the inverse square of what the symbol should be there (so it is the relative error,
 * the wave's speed, that is kept small), under the one constraint that the weights sum to nothing: a level
 * surface stays level. Where the fit dips under zero near the grid's own scale (a wave whose operator is
 * negative grows without bound), a little of the grid's Laplacian is added, which is nothing to a long wave.
 */
export function waveSimKernel(depth: number, cell = WAVE_SIM_CELL): Float32Array {
    const P = WAVE_SIM_REACH, H = depth / cell, T = WAVE_SIM_TAPS, U = T - 1;
    // How many offsets share each weight.
    const shared = new Float64Array(T);
    for (let j = -P; j <= P; j++) for (let i = -P; i <= P; i++) shared[waveKernelIndex(i, j)]++;
    // The normal equations of the fit, in the weights but the centre's (which the constraint gives).
    const N = new Float64Array(U * U), rhs = new Float64Array(U), basis = new Float64Array(T);
    const M = 44, dq = Math.PI / M;
    for (let b = 0; b < M; b++) for (let a = 0; a < M; a++) {
        const qx = (a + 0.5) * dq, qy = (b + 0.5) * dq, q = Math.hypot(qx, qy);
        basis.fill(0);
        for (let j = -P; j <= P; j++) for (let i = -P; i <= P; i++) basis[waveKernelIndex(i, j)] += Math.cos(qx * i + qy * j);
        const want = waveSymbol(q, H), scale = q * Math.tanh(q * H);
        const w = 1 / (scale * scale + 0.0025);
        for (let r = 0; r < U; r++) {
            const fr = basis[r + 1] - shared[r + 1];
            rhs[r] += w * fr * want;
            for (let c = r; c < U; c++) N[r * U + c] += w * fr * (basis[c + 1] - shared[c + 1]);
        }
    }
    for (let r = 0; r < U; r++) { for (let c = 0; c < r; c++) N[r * U + c] = N[c * U + r]; N[r * U + r] *= 1 + 1e-9; }
    // Gaussian elimination, the largest pivot first.
    for (let col = 0; col < U; col++) {
        let pivot = col;
        for (let r = col + 1; r < U; r++) if (Math.abs(N[r * U + col]) > Math.abs(N[pivot * U + col])) pivot = r;
        if (pivot !== col) {
            for (let c = 0; c < U; c++) { const t = N[col * U + c]; N[col * U + c] = N[pivot * U + c]; N[pivot * U + c] = t; }
            const t = rhs[col]; rhs[col] = rhs[pivot]; rhs[pivot] = t;
        }
        const d = N[col * U + col];
        for (let r = col + 1; r < U; r++) {
            const f = N[r * U + col] / d;
            if (f === 0) continue;
            for (let c = col; c < U; c++) N[r * U + c] -= f * N[col * U + c];
            rhs[r] -= f * rhs[col];
        }
    }
    const out = new Float32Array(T);
    for (let r = U - 1; r >= 0; r--) {
        let v = rhs[r];
        for (let c = r + 1; c < U; c++) v -= N[r * U + c] * out[c + 1];
        out[r + 1] = v / N[r * U + r];
    }
    let rest = 0;
    for (let i = 1; i < T; i++) rest += shared[i] * out[i];
    out[0] = -rest;
    // Never negative: the lowest the fitted symbol goes, made up with the grid's Laplacian (4 at the centre,
    // -1 at each neighbour: 4 - 2 cos qx - 2 cos qy, which is at least a quarter of q squared).
    let low = 0;
    const F = 48;
    for (let b = 0; b <= F; b++) for (let a = 0; a <= F; a++) {
        const qx = a * Math.PI / F, qy = b * Math.PI / F;
        const lap = 4 - 2 * Math.cos(qx) - 2 * Math.cos(qy);
        if (lap > 1e-6) low = Math.min(low, (waveKernelSymbol(out, qx, qy) - 0.01 * lap) / lap);
    }
    if (low < 0) { out[0] += -low * 4; out[waveKernelIndex(1, 0)] -= -low; }
    return out;
}

/** The symbol a packed kernel really has at (qx, qy) radians a texel: what the grid's waves obey. */
export function waveKernelSymbol(kernel: ArrayLike<number>, qx: number, qy: number): number {
    const P = WAVE_SIM_REACH;
    let s = 0;
    for (let j = -P; j <= P; j++) for (let i = -P; i <= P; i++) s += kernel[waveKernelIndex(i, j)] * Math.cos(qx * i + qy * j);
    return s;
}

/** The speed (m/s) a wave `wavelength` metres long really runs at over `depth` metres of water. */
export function waterWaveSpeed(wavelength: number, depth: number): number {
    const k = 2 * Math.PI / wavelength;
    return Math.sqrt(WAVE_SIM_GRAVITY * Math.tanh(k * depth) / k);
}

// ---- the reference stepper ------------------------------------------------------------------------------------

/** A window of simulated waves: heights (m) and their rates (m/s), row-major, `nx` by `nz` texels of `cell` metres. */
export interface WaveSimGrid {
    nx: number; nz: number; cell: number;
    eta: Float32Array; vel: Float32Array;
}

export function createWaveSimGrid(nx: number, nz: number, cell = WAVE_SIM_CELL): WaveSimGrid {
    return { nx, nz, cell, eta: new Float32Array(nx * nz), vel: new Float32Array(nx * nz) };
}

/** What one step of the reference stepper takes. */
export interface WaveSimStep {
    /** The wave operator's kernel ({@link waveSimKernel}). */
    kernel: ArrayLike<number>;
    /** The current (m/s) carrying the waves: one for the whole grid. */
    flowX?: number; flowZ?: number;
    /** The surface's acceleration (m/s2) from outside the waves, per texel. */
    force?: ArrayLike<number>;
    /** Per texel, 1 inside something standing in the water: no wave there (what reaches it is thrown back). */
    solid?: ArrayLike<number>;
    /** Per second: how fast the waves die down. */
    damping?: number;
    /** The share of each texel's rate shared with its four neighbours a step: what the grid cannot carry dies out. */
    viscosity?: number;
    dt?: number;
}

const _w = [0, 0, 0, 0], _v = [0, 0, 0, 0];

/**
 * One step of the scheme the shaders run (waterWaveAdvect.wgsl, then waterWaveStep.wgsl): the waves are
 * carried by the current, then pushed by the wave operator and whatever forces them. Outside the grid the
 * water is level. In place.
 */
export function stepWaveSim(grid: WaveSimGrid, step: WaveSimStep): void {
    const { nx, nz, cell } = grid;
    const dt = step.dt ?? WAVE_SIM_DT, P = WAVE_SIM_REACH;
    const n = nx * nz;
    // 1. Carried by the current: each texel takes the waves from where the water it now holds was.
    let eta = grid.eta, vel = grid.vel;
    const ux = (step.flowX ?? 0) * dt / cell, uz = (step.flowZ ?? 0) * dt / cell;
    if (ux !== 0 || uz !== 0) {
        const e2 = new Float32Array(n), v2 = new Float32Array(n);
        for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
            const px = x - ux, pz = z - uz;
            const ix = Math.floor(px), iz = Math.floor(pz);
            catmullRomWeights(px - ix, _w); catmullRomWeights(pz - iz, _v);
            let e = 0, v = 0;
            for (let b = 0; b < 4; b++) {
                const zz = iz - 1 + b;
                if (zz < 0 || zz >= nz) continue;
                for (let a = 0; a < 4; a++) {
                    const xx = ix - 1 + a;
                    if (xx < 0 || xx >= nx) continue;
                    const w = _w[a] * _v[b];
                    e += w * eta[zz * nx + xx]; v += w * vel[zz * nx + xx];
                }
            }
            e2[z * nx + x] = e; v2[z * nx + x] = v;
        }
        eta = e2; vel = v2;
    }
    // 2. Pushed: the rate by the operator and the forcing, then the height by the rate.
    const k = WAVE_SIM_GRAVITY / cell, keep = Math.exp(-(step.damping ?? 0) * dt), viscosity = step.viscosity ?? 0;
    const outE = grid.eta, outV = grid.vel;
    const nextE = new Float32Array(n), nextV = new Float32Array(n);
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        let conv = 0;
        for (let j = -P; j <= P; j++) {
            const zz = z + j;
            if (zz < 0 || zz >= nz) continue;
            for (let i = -P; i <= P; i++) {
                const xx = x + i;
                if (xx < 0 || xx >= nx) continue;
                conv += step.kernel[waveKernelIndex(i, j)] * eta[zz * nx + xx];
            }
        }
        const c = z * nx + x;
        if (step.solid && step.solid[c]) { nextV[c] = 0; nextE[c] = 0; continue; }
        let v = vel[c] + dt * (-k * conv + (step.force ? step.force[c] : 0));
        if (viscosity > 0) {
            const around = (x > 0 ? vel[c - 1] : 0) + (x < nx - 1 ? vel[c + 1] : 0) + (z > 0 ? vel[c - nx] : 0) + (z < nz - 1 ? vel[c + nx] : 0);
            v += (0.25 * around - v) * viscosity;
        }
        v *= keep;
        nextV[c] = v;
        nextE[c] = eta[c] + dt * v;
    }
    outE.set(nextE); outV.set(nextV);
}
