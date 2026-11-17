// The LOCAL FLOW: the water simulated finely round the camera, so what stands in it shapes it. Run every frame
// on the GPU over the live waves' window (graphics/render/localFlow.ts; shaders/wgsl/waterFlow*.wgsl); this
// file is its arithmetic on the CPU, a reference stepper the tests hold the scheme to, and the constants the
// shaders share.
//
// The flow bake (water/bake/) settles a whole river on cells of 0.6 to 3 m: too coarse for the water to part
// round a post, pile against a pier or pour over a boulder. Round the camera the same equations are solved
// again on cells of 0.3 m, with the bake as their reference: far from anything in the water the result is the
// bake, and near an obstacle it is what the shallow-water equations do there. The water piles up against the
// face it runs into (a bow cushion of about the velocity head), draws down and speeds up along the sides, leaves
// a sheltered dip and a wake behind; over a boulder just under the surface it rises in a pillow, pours over,
// drops into a hole and stands up again in a hydraulic jump.
//
// The scheme is the bake's (Chentanez and Müller 2010; water/bake/shallowWater.ts): depths at cell centres,
// velocities on the faces between them; each substep the velocities are carried along by themselves
// (semi-Lagrangian), the depths change by the upwind flux through each face (scaled down where a cell would run
// dry), and the velocities are pushed down the surface's slope against Manning's friction (Jarrett's on steep
// natural beds) and the drag of anything narrower than a cell standing in it. What is different here:
//
//  - The bake is the REFERENCE. Every cell is drawn gently toward the bake's surface and current (over
//    LOCAL_FLOW_NUDGE seconds), so the window never drifts from the river it sits on, and hard toward it in a
//    sponge along the window's edges (water comes in as the bake has it and leaves the same way). What the
//    obstacles do, they keep doing: they re-make it in the moment the water takes to pass them.
//  - Obstacles are found from their footprints at the surface (water/bake/obstacles.ts obstacleFootprint):
//    a cell blocked over half its area is SOLID; one blocked over less keeps its water and holds it back by the
//    obstacle's drag; one under a collider whose top is under the surface has its bed raised to that top.
//  - Heights are relative to a datum (the bake's surface at the window's centre), so single floats hold them.
//  - Still water deeper than LOCAL_FLOW_DEPTH_CAP is simulated no deeper, as the bake caps it: a gravity wave's
//    speed sets the time step.
//
// The window's edges are clamped (a cell past the edge is the edge cell), as the shaders' `textureLoad` of a
// clamped coordinate is. Arrays are row-major, `n` cells a side; u at index (j, i) is the velocity on the face
// between cells (i - 1, j) and (i, j), w the one between (i, j - 1) and (i, j).

/** Cells a side of the window: the live waves' field (half their texels). */
export const LOCAL_FLOW_SIZE = 256;
/** Metres a cell. */
export const LOCAL_FLOW_CELL = 0.3;
/** Seconds a substep: two to each of the live waves' steps. */
export const LOCAL_FLOW_DT = 1 / 120;
export const LOCAL_FLOW_GRAVITY = 9.81;
/** Metres of water simulated at most: deeper still water is taken as this deep. */
export const LOCAL_FLOW_DEPTH_CAP = 3;
/** Depth under which a cell is dry. */
export const LOCAL_FLOW_DRY = 0.005;
/** Seconds over which every cell is drawn to the bake. */
export const LOCAL_FLOW_NUDGE = 8;
/** Seconds over which the cells at the window's edge are drawn to it, and the cells of the sponge they lie in. */
export const LOCAL_FLOW_EDGE_NUDGE = 0.1;
export const LOCAL_FLOW_SPONGE = 10;
/** The drag code of a solid cell (anything else is a drag, 1/m). */
export const LOCAL_FLOW_SOLID = -1;
/** Manning's n from which a bed counts as a natural one (shallowWater.ts NATURAL_BED). */
export const LOCAL_FLOW_NATURAL_BED = 0.025;

/** What the window's water stands on and is drawn toward, per cell. */
export interface LocalFlowGround {
    n: number;
    cell: number;
    /** The bed (m, relative to the datum), raised under submerged obstacles and under deep still water. */
    bed: Float32Array;
    /** The drag (1/m) of what stands in the cell without filling it; LOCAL_FLOW_SOLID where it fills it. */
    drag: Float32Array;
    /** Manning's n of the bed. */
    manning: Float32Array;
    /** The bake's surface (m, relative to the datum); under the bed where the bake is dry. */
    refSurface: Float32Array;
    /** The bake's current at the cell's centre (m/s). */
    refU: Float32Array;
    refW: Float32Array;
}

/** The window's water: depths per cell, velocities per face (see the header), and each cell's outflow limit. */
export interface LocalFlowState {
    n: number;
    h: Float32Array;
    u: Float32Array;
    w: Float32Array;
    limit: Float32Array;
}

export interface LocalFlowStepOptions {
    dt?: number;
    /** Draw the water toward the bake (default true): off, the window is closed and keeps its own water. */
    nudge?: boolean;
}

/** A ground of `n` cells, flat and dry: the tests and tools fill it. */
export function createLocalFlowGround(n: number, cell = LOCAL_FLOW_CELL): LocalFlowGround {
    const m = n * n;
    return {
        n, cell, bed: new Float32Array(m), drag: new Float32Array(m), manning: new Float32Array(m).fill(0.03),
        refSurface: new Float32Array(m).fill(-1e3), refU: new Float32Array(m), refW: new Float32Array(m),
    };
}

/** The water the bake has there: its depth over the (local) bed, and its current on each face. */
export function createLocalFlow(g: LocalFlowGround): LocalFlowState {
    const n = g.n, m = n * n;
    const s: LocalFlowState = { n, h: new Float32Array(m), u: new Float32Array(m), w: new Float32Array(m), limit: new Float32Array(m).fill(1) };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const c = j * n + i;
        s.h[c] = refDepth(g, c);
        s.u[c] = refFace(g, i, j, 0);
        s.w[c] = refFace(g, i, j, 1);
    }
    return s;
}

const clampIndex = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);
const solid = (g: LocalFlowGround, c: number) => g.drag[c] < 0;

/** The bake's depth over the local bed (none in a solid). */
export function refDepth(g: LocalFlowGround, c: number): number {
    return solid(g, c) ? 0 : Math.max(0, g.refSurface[c] - g.bed[c]);
}

/** The bake's current on the face of cell (i, j) toward -x (axis 0) or -z (axis 1): the mean of the two cells. */
export function refFace(g: LocalFlowGround, i: number, j: number, axis: 0 | 1): number {
    const n = g.n, c = j * n + i;
    const a = axis === 0 ? j * n + clampIndex(i - 1, n) : clampIndex(j - 1, n) * n + i;
    if (solid(g, c) || solid(g, a)) return 0;
    const ref = axis === 0 ? g.refU : g.refW;
    return 0.5 * (ref[a] + ref[c]);
}

/** How hard a cell is drawn to the bake a substep: a share of the difference (the sponge's edge, all but all of it). */
export function nudgeShare(n: number, i: number, j: number, dt: number): number {
    const edge = Math.min(i, j, n - 1 - i, n - 1 - j);
    const t = Math.min(1, Math.max(0, edge / LOCAL_FLOW_SPONGE));
    const sponge = 1 - t * t * (3 - 2 * t);
    const rate = 1 / LOCAL_FLOW_NUDGE + sponge / LOCAL_FLOW_EDGE_NUDGE;
    return 1 - Math.exp(-rate * dt);
}

/** The x-face field at (px, pz) in cell units (face (i, j) sits at (i - 0.5, j)), bilinear, clamped. */
function sampleFaces(f: Float32Array, n: number, px: number, pz: number, axis: 0 | 1): number {
    // In the face lattice's own units.
    const fx = axis === 0 ? px + 0.5 : px, fz = axis === 0 ? pz : pz + 0.5;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const tx = fx - x0, tz = fz - z0;
    const a = clampIndex(x0, n), b = clampIndex(x0 + 1, n), c = clampIndex(z0, n), d = clampIndex(z0 + 1, n);
    return (f[c * n + a] * (1 - tx) + f[c * n + b] * tx) * (1 - tz) + (f[d * n + a] * (1 - tx) + f[d * n + b] * tx) * tz;
}

/**
 * One substep, in place: advect, limit, depth, accelerate (waterFlowAdvect, waterFlowLimit, waterFlowDepth and
 * waterFlowAccelerate.wgsl, in that order).
 */
export function stepLocalFlow(s: LocalFlowState, g: LocalFlowGround, options: LocalFlowStepOptions = {}): void {
    const n = s.n, m = n * n, cell = g.cell;
    const dt = options.dt ?? LOCAL_FLOW_DT, nudge = options.nudge !== false;
    const k = dt / cell, DRY = LOCAL_FLOW_DRY;
    const h = s.h;
    const at = (i: number, j: number) => clampIndex(j, n) * n + clampIndex(i, n);

    // 1. Advect: each face takes the velocity of the water that reaches it, from where that water was.
    const u2 = new Float32Array(m), w2 = new Float32Array(m);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const c = j * n + i;
        const ax = at(i - 1, j), az = at(i, j - 1);
        if (!(h[ax] < DRY && h[c] < DRY) && !solid(g, c) && !solid(g, ax)) {
            const vw = 0.25 * (s.w[at(i - 1, j)] + s.w[c] + s.w[at(i - 1, j + 1)] + s.w[at(i, j + 1)]);
            u2[c] = sampleFaces(s.u, n, i - 0.5 - s.u[c] * k, j - vw * k, 0);
        }
        if (!(h[az] < DRY && h[c] < DRY) && !solid(g, c) && !solid(g, az)) {
            const vu = 0.25 * (s.u[at(i, j - 1)] + s.u[at(i + 1, j - 1)] + s.u[c] + s.u[at(i + 1, j)]);
            w2[c] = sampleFaces(s.w, n, i - vu * k, j - 0.5 - s.w[c] * k, 1);
        }
    }
    s.u.set(u2); s.w.set(w2);
    const u = s.u, w = s.w;

    // 2. Limit: no cell gives more water than it has.
    const limit = s.limit;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const c = j * n + i;
        if (h[c] <= 0) { limit[c] = 1; continue; }
        const out = (Math.max(0, u[at(i + 1, j)]) + Math.max(0, -u[c]) + Math.max(0, w[at(i, j + 1)]) + Math.max(0, -w[c])) * h[c] * k;
        limit[c] = out > h[c] && out > 0 ? h[c] / out : 1;
    }

    // 3. Depth: the upwind flux through each face; drawn to the bake.
    const h2 = new Float32Array(m);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const c = j * n + i;
        if (solid(g, c)) continue;
        const l = at(i - 1, j), r = at(i + 1, j), b = at(i, j - 1), t = at(i, j + 1);
        // Past the window's edge the face is the edge cell's own (a clamped load, as the shader's).
        const fl = u[c], fr = u[r], fb = w[c], ft = w[t];
        const qL = fl > 0 ? fl * h[l] * limit[l] : fl * h[c] * limit[c];
        const qR = fr > 0 ? fr * h[c] * limit[c] : fr * h[r] * limit[r];
        const qB = fb > 0 ? fb * h[b] * limit[b] : fb * h[c] * limit[c];
        const qT = ft > 0 ? ft * h[c] * limit[c] : ft * h[t] * limit[t];
        let d = h[c] + k * (qL - qR + qB - qT);
        if (nudge) d += (refDepth(g, c) - d) * nudgeShare(n, i, j, dt);
        h2[c] = d > 0 ? d : 0;
    }
    h.set(h2);

    // 4. Accelerate: down the surface's slope, against the bed's friction and the drag of what stands in it.
    const G = LOCAL_FLOW_GRAVITY, slopeK = G * dt / cell, maxU = 0.5 * cell / dt;
    for (let pass = 0; pass < 2; pass++) {
        const axis = pass as 0 | 1;
        const vel = axis === 0 ? u : w;
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const c = j * n + i;
            const a = axis === 0 ? at(i - 1, j) : at(i, j - 1);
            if (a === c || solid(g, a) || solid(g, c)) {
                // The window's edge (no neighbour) carries the bake's current; a solid, none.
                vel[c] = a === c && !solid(g, c) && nudge ? refFace(g, i, j, axis) : 0;
                continue;
            }
            const drop = (g.bed[c] + h[c]) - (g.bed[a] + h[a]);
            let v = vel[c] - slopeK * drop;
            const up = v > 0 ? h[a] : h[c];
            if (up < DRY) { vel[c] = 0; continue; }
            const hf = up > 0.02 ? up : 0.02;
            const root = Math.cbrt(hf);
            let nm = 0.5 * (g.manning[a] + g.manning[c]);
            if (nm >= LOCAL_FLOW_NATURAL_BED) {
                const slope = Math.min(1, Math.abs(drop) / cell);
                const quarter = Math.sqrt(Math.sqrt(slope));
                const torrent = 0.32 * quarter * Math.sqrt(quarter) / Math.sqrt(root);
                if (torrent > nm) nm = torrent;
            }
            let resist = G * dt * nm * nm * Math.abs(v) / (hf * root);
            resist += 0.5 * (g.drag[a] + g.drag[c]) * dt * Math.abs(v);
            v /= 1 + resist;
            if (nudge) v += (refFace(g, i, j, axis) - v) * nudgeShare(n, i, j, dt);
            vel[c] = v > maxU ? maxU : v < -maxU ? -maxU : v;
        }
    }
}

/** What the surface and the live waves take from the local flow, per cell. */
export interface LocalFlowOutput {
    /** The surface against the bake's (m): what the surface adds to the baked one. */
    lift: Float32Array;
    /** The current at the cell's centre (m/s). */
    u: Float32Array;
    w: Float32Array;
    /** Whitewater made here (0..1), over the bake's foam: a jump, shear round an obstacle, a drag cell. */
    white: Float32Array;
}

/** Metres of water under which a cell shows nothing of its own. */
const THIN = 0.01;

/**
 * The surface's lift and current, and the whitewater the local flow makes (waterFlowOut.wgsl):
 *  - a hydraulic JUMP: the Froude number a metre upstream over 1, and fallen by a third here;
 *  - SHEAR: the water turning on itself (its vorticity) hard as it tears past an obstacle (a bank's gentler
 *    shear makes little), in water faster than a metre a second;
 *  - a DRAG cell: water tearing past something narrower than a cell.
 * A solid cell's lift is its wet neighbours' (the surface does not cliff inside a post).
 */
export function localFlowOutput(s: LocalFlowState, g: LocalFlowGround): LocalFlowOutput {
    const n = s.n, m = n * n, cell = g.cell;
    const at = (i: number, j: number) => clampIndex(j, n) * n + clampIndex(i, n);
    const out: LocalFlowOutput = { lift: new Float32Array(m), u: new Float32Array(m), w: new Float32Array(m), white: new Float32Array(m) };
    const cu = (i: number, j: number) => 0.5 * (s.u[at(i, j)] + s.u[at(i + 1, j)]);
    const cw = (i: number, j: number) => 0.5 * (s.w[at(i, j)] + s.w[at(i, j + 1)]);
    const wet = (c: number) => !solid(g, c) && s.h[c] > THIN && g.refSurface[c] > g.bed[c] - 1e-3;
    const liftOf = (c: number) => g.bed[c] + s.h[c] - g.refSurface[c];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const c = j * n + i;
        if (solid(g, c)) {
            let sum = 0, count = 0;
            for (const q of [at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1)]) if (wet(q)) { sum += liftOf(q); count++; }
            out.lift[c] = count ? sum / count : 0;
            continue;
        }
        if (!wet(c)) continue;
        const u = cu(i, j), w = cw(i, j);
        out.lift[c] = liftOf(c);
        out.u[c] = u; out.w[c] = w;
        out.white[c] = whiteAt(s, g, i, j, u, w, cell, cu, cw, at);
    }
    return out;
}

/** The whitewater rule (waterFlowOut.wgsl `whiteAt`). */
function whiteAt(s: LocalFlowState, g: LocalFlowGround, i: number, j: number, u: number, w: number, cell: number,
                 cu: (i: number, j: number) => number, cw: (i: number, j: number) => number, at: (i: number, j: number) => number): number {
    const c = j * s.n + i;
    const speed = Math.hypot(u, w);
    const G = LOCAL_FLOW_GRAVITY;
    let white = 0;
    if (speed > 0.05) {
        // A metre upstream.
        const back = 1 / cell;
        const bi = Math.round(i - u / speed * back), bj = Math.round(j - w / speed * back);
        const b = at(bi, bj);
        if (!solid(g, b) && s.h[b] > THIN) {
            const froudeUp = Math.hypot(cu(bi, bj), cw(bi, bj)) / Math.sqrt(G * s.h[b]);
            const froude = speed / Math.sqrt(G * Math.max(s.h[c], THIN));
            white = Math.max(white, smooth(0.9, 1.3, froudeUp) * smooth(0.15, 0.6, froudeUp - froude));
        }
    }
    // The vorticity, over two cells.
    const curl = ((cw(i + 1, j) - cw(i - 1, j)) - (cu(i, j + 1) - cu(i, j - 1))) / (2 * cell);
    white = Math.max(white, smooth(2, 6, Math.abs(curl)) * smooth(0.8, 1.6, speed));
    if (g.drag[c] > 0) white = Math.max(white, smooth(0.3, 1.2, speed) * Math.min(1, g.drag[c] * cell * 4));
    return white;
}

function smooth(a: number, b: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

/**
 * A footprint's cover of a cell (water/bake/obstacles.ts WaterObstacleFootprint): the share of its area inside,
 * from 2 x 2 samples (waterFlowGround.wgsl does the same). For tests and tools that build a ground by hand.
 */
export function footprintDistance(f: { x: number; z: number; ax: number; az: number; a: number; b: number; r: number }, x: number, z: number): number {
    const rx = x - f.x, rz = z - f.z;
    const p0 = Math.abs(rx * f.ax + rz * f.az) - f.a, p1 = Math.abs(-rx * f.az + rz * f.ax) - f.b;
    const ox = Math.max(p0, 0), oz = Math.max(p1, 0);
    return Math.hypot(ox, oz) + Math.min(Math.max(p0, p1), 0) - f.r;
}
