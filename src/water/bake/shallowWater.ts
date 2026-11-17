import { waterColumnAt, type ResolvedWaterShape, type WaterColumn } from '../../physics/water/waterColumn';
import { chamferDistance, tileWaterInfo, WATER_INFO_MIN_CELL, type GroundSampler, type WaterInfo } from '../waterInfo';
import { obstacleSpan, type WaterObstacle } from './obstacles';

// The water BAKE: the shallow-water equations solved over one body of water and the ground and static
// obstacles under it until the water settles, its depth and velocity averaged over the settled stretch.
// What comes out is a water info grid (water/waterInfo.ts) like the analytic one, but with the water where it
// actually runs: currents bending round the banks and round a rock, wakes and eddies behind it, the water
// speeding up over a shallow bar and piling up before a narrows, foam where it tumbles. The surface renderer
// draws it, and physics carries what floats on it.
//
// The solver is the height-field one of Chentanez & Müller ("Real-time Simulation of Large Bodies of Water
// with Small Scale Details", 2010), without its particles: depths at cell centres, velocities on the faces
// between them (a staggered grid); each step the velocities are carried along by themselves
// (semi-Lagrangian advection, which is what lets eddies form), the depths change by the flux through each
// face (the depth upwind of the face times its velocity, scaled down where a cell would run dry), and the
// velocities are pushed down the surface's slope. Bed friction follows Manning: u /= 1 + dt·g·n²·|u|/h^(4/3),
// so a river settles at the speed its slope and depth give (v = h^(2/3)·S^(1/2)/n for a wide channel).
//
// Boundaries (cell kinds):
//  - WALL: outside the water's reach, or a static obstacle standing out of it;
//  - WATER: free;
//  - HELD: the water the body joins (a river's lake, the lake it drains): held at that water's level, so it
//    takes what the river brings, or feeds it;
//  - DRAIN: the grid's edge, a river's unjoined end, where a river flows out of a lake: the water leaves;
//  - water is INJECTED where a river rises (its authored discharge: width x depth x flow speed at its
//    first point) and where rivers run into a lake.
//
// Pure and deterministic (same input, same bits), on the CPU so it bakes the same everywhere; the setup
// (prepareWaterBake) reads the ground and the obstacles, the solver (ShallowWaterBake) only arrays, so it
// runs in a worker. `step(n)` runs in slices.

const G = 9.81;
/** Depth below which a cell counts as dry. */
const DRY = 0.005;
/** Metres of a river's start fed with its discharge. */
const SOURCE_LENGTH = 3;

export const CELL_WALL = 0;
export const CELL_WATER = 1;
export const CELL_HELD = 2;
export const CELL_DRAIN = 3;

/** The default Manning roughness: a natural channel, clean and winding. */
export const DEFAULT_MANNING = 0.03;

/** Everything the solver needs, as plain arrays (structured-cloneable, transferable). */
export interface WaterBakeSetup {
    originX: number; originZ: number; cell: number; nx: number; nz: number;
    /** Bed height per cell (the ground, raised by obstacles under the water). */
    bed: Float32Array;
    /** CELL_* per cell. */
    kind: Uint8Array;
    /** Held cells: the level they are held at. Others: the analytic surface to start from (NaN: start dry). */
    target: Float32Array;
    /** Water added per cell, m³/s (a river's source, a river running into a lake). */
    inflow: Float32Array;
    /** 1 where the cell holds the body's own water. */
    own: Uint8Array;
    /** A weak pull toward `target` on the body's own cells, per second (a lake keeps its level; 0 for a river). */
    hold: number;
    manning: number;
    /** Seconds of water to simulate. */
    duration: number;
    /** The body's share of its node's waves, for the result. */
    waveFactor: number;
}

export interface WaterInflow { x: number; z: number; radius: number; discharge: number; }
export interface WaterOutflow { x: number; z: number; radius: number; }

export interface PrepareOptions {
    /** Largest grid side, cells. */
    maxRes?: number;
    manning?: number;
    duration?: number;
    /** Rivers running into this water: where, and how much (m³/s). */
    inflows?: readonly WaterInflow[];
    /** Rivers running out of it: where the water leaves. */
    outflows?: readonly WaterOutflow[];
}

/** A river's discharge at sample `q`: its parabolic channel's area times its speed (m³/s). */
export function riverDischarge(q: { width: number; depth: number; speed: number }): number {
    return q.width * q.depth * (2 / 3) * q.speed;
}

/**
 * The bake's grid and boundaries for `body` (world space) joined to `joined` (the water it flows from and
 * into), over `ground` with `obstacles` in it. The water may leave the body's own outline by a bank margin
 * where the ground is lower (the terrain decides the banks), never further.
 */
export function prepareWaterBake(body: ResolvedWaterShape, joined: readonly ResolvedWaterShape[], ground: GroundSampler | null,
                                 obstacles: readonly WaterObstacle[], options: PrepareOptions = {}): WaterBakeSetup {
    if (body.type === 'ocean' && body.endless) throw new Error('Nothing to bake: an endless ocean has no flow to settle.');
    const river = body.type === 'river';
    const widest = river ? Math.max(1, ...body.samples.map(s => s.width)) : 0;
    const margin = Math.max(4, widest);
    const maxRes = Math.max(32, Math.min(1024, options.maxRes ?? 384));
    const x0 = body.min[0] - margin, z0 = body.min[2] - margin;
    const extent = Math.max(body.max[0] - body.min[0], body.max[2] - body.min[2]) + 2 * margin;
    const cell = Math.max(WATER_INFO_MIN_CELL, extent / (maxRes - 1));
    const nx = Math.min(maxRes, Math.ceil((body.max[0] - body.min[0] + 2 * margin) / cell) + 1);
    const nz = Math.min(maxRes, Math.ceil((body.max[2] - body.min[2] + 2 * margin) / cell) + 1);
    const n = nx * nz;
    const bed = new Float32Array(n), kind = new Uint8Array(n), target = new Float32Array(n).fill(NaN);
    const inflow = new Float32Array(n), own = new Uint8Array(n);
    const ownSurface = new Float32Array(n);
    const col: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: 0, waveFactor: 1 };
    const held: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: 0, waveFactor: 1 };
    const shapes = [body];
    const finiteJoined = joined.filter(j => !(j.type === 'ocean' && j.endless));
    const sea = joined.find(j => j.type === 'ocean' && j.endless) ?? null;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const i = z * nx + x;
        const wx = x0 + x * cell, wz = z0 + z * cell;
        const g = ground ? ground(wx, wz) : null;
        const c = waterColumnAt(shapes, wx, wz, col);
        bed[i] = c ? (g !== null ? Math.max(g, c.floor) : c.floor) : (g ?? body.floor);
        if (c && c.surface > bed[i] + DRY) { own[i] = 1; ownSurface[i] = c.surface; }
        // The water it joins, at that water's level.
        let j: WaterColumn | null = waterColumnAt(finiteJoined, wx, wz, held);
        if (!j && sea && (g === null || g < sea.level)) { held.surface = sea.level; j = held; }
        if (j && j.surface > bed[i] + DRY) { kind[i] = CELL_HELD; target[i] = j.surface; }
    }
    // The water it joins only holds a level: a reservoir no deeper than twice the body's own water. The sea
    // beyond a river's mouth may be a hundred metres deep, and that depth, not the river's, would set the
    // step (a gravity wave's speed) and make the bake hundreds of times slower for nothing.
    let ownDepth = 0.5;
    for (let i = 0; i < n; i++) if (own[i]) ownDepth = Math.max(ownDepth, ownSurface[i] - bed[i]);
    for (let i = 0; i < n; i++) if (kind[i] === CELL_HELD) bed[i] = Math.max(bed[i], target[i] - 2 * ownDepth);
    // The bank margin: within `margin` of the body's own water, ground lower than the water beside it may
    // fill; everything else is a wall.
    const { dist, nearestSet } = chamferDistance(own, nx, nz, cell);
    for (let i = 0; i < n; i++) {
        if (kind[i] === CELL_HELD) continue;
        if (own[i]) { kind[i] = CELL_WATER; target[i] = ownSurface[i]; continue; }
        const k = nearestSet[i];
        if (k >= 0 && -dist[i] <= margin && bed[i] < ownSurface[k] - DRY) { kind[i] = CELL_WATER; target[i] = NaN; }
    }
    // Static obstacles: a column the obstacle fills above the water is a wall (the water goes round it);
    // one under the surface raises the bed (the water speeds over it). Two by two samples per cell.
    if (obstacles.length) {
        for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
            const i = z * nx + x;
            if (kind[i] === CELL_WALL) continue;
            const level = Number.isFinite(target[i]) ? target[i] : bed[i] + 1;
            let walls = 0, raised = 0;
            for (let s = 0; s < 4; s++) {
                const wx = x0 + (x + ((s & 1) ? 0.25 : -0.25)) * cell, wz = z0 + (z + ((s & 2) ? 0.25 : -0.25)) * cell;
                let top = bed[i], wall = false;
                for (const o of obstacles) {
                    const span = obstacleSpan(o, wx, wz);
                    // Only what reaches down to (near) the bed blocks the water; a bridge deck above it does not.
                    if (!span || span[0] > Math.max(bed[i], level - 0.25)) continue;
                    if (span[1] >= level) wall = true;
                    else top = Math.max(top, span[1]);
                }
                if (wall) walls++;
                raised += top;
            }
            if (walls >= 2) kind[i] = CELL_WALL;
            else bed[i] = Math.max(bed[i], raised / 4);
        }
    }
    const cellOf = (x: number, z: number): number => {
        const cx = Math.min(nx - 1, Math.max(0, Math.round((x - x0) / cell)));
        const cz = Math.min(nz - 1, Math.max(0, Math.round((z - z0) / cell)));
        return cz * nx + cx;
    };
    const within = (x: number, z: number, radius: number, each: (i: number) => void) => {
        const r = Math.max(radius, cell);
        const c0 = Math.max(0, Math.floor((x - r - x0) / cell)), c1 = Math.min(nx - 1, Math.ceil((x + r - x0) / cell));
        const r0 = Math.max(0, Math.floor((z - r - z0) / cell)), r1 = Math.min(nz - 1, Math.ceil((z + r - z0) / cell));
        for (let zz = r0; zz <= r1; zz++) for (let xx = c0; xx <= c1; xx++) {
            const dx = x0 + xx * cell - x, dz = z0 + zz * cell - z;
            if (dx * dx + dz * dz <= r * r) each(zz * nx + xx);
        }
    };
    const feed = (x: number, z: number, radius: number, q: number): number => {
        const cells: number[] = [];
        within(x, z, radius, i => { if (kind[i] === CELL_WATER) cells.push(i); });
        for (const i of cells) inflow[i] += q / cells.length;
        return cells.length;
    };
    const drain = (x: number, z: number, radius: number) => within(x, z, radius, i => { if (kind[i] === CELL_WATER) kind[i] = CELL_DRAIN; });
    if (river && body.samples.length) {
        // A river that does not start in other water rises: its first metres are fed its discharge.
        const first = body.samples[0];
        if (kind[cellOf(first.x, first.z)] !== CELL_HELD) {
            const head = body.samples.filter(q => q.dist <= SOURCE_LENGTH);
            const per = riverDischarge(first) / Math.max(1, head.length);
            for (const q of head) feed(q.x, q.z, q.width / 2, per);
        }
        // An end that runs into nothing drains.
        const last = body.samples[body.samples.length - 1];
        if (kind[cellOf(last.x, last.z)] !== CELL_HELD) drain(last.x, last.z, last.width / 2);
    }
    for (const f of options.inflows ?? []) if (!feed(f.x, f.z, f.radius, f.discharge)) feed(f.x, f.z, f.radius + 3 * cell, f.discharge);
    for (const f of options.outflows ?? []) drain(f.x, f.z, f.radius);
    // The grid's own edge drains whatever reaches it.
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        if (x > 0 && z > 0 && x < nx - 1 && z < nz - 1) continue;
        const i = z * nx + x;
        if (kind[i] === CELL_WATER) kind[i] = CELL_DRAIN;
    }
    let slowest = Infinity, longest = 0;
    if (river) {
        longest = body.samples[body.samples.length - 1]?.dist ?? 0;
        for (const q of body.samples) slowest = Math.min(slowest, Math.max(0.3, q.speed));
    }
    const duration = options.duration ?? (river
        ? Math.min(600, Math.max(30, 2 * longest / slowest))
        : Math.min(120, Math.max(30, Math.max(body.max[0] - body.min[0], body.max[2] - body.min[2]) / 0.5)));
    return {
        originX: x0, originZ: z0, cell, nx, nz, bed, kind, target, inflow, own,
        hold: river ? 0 : 0.05, manning: Math.max(0.005, options.manning ?? DEFAULT_MANNING), duration, waveFactor: body.waveFactor,
    };
}

/** A bake in progress: call `step(n)` until `done`, then `result()`. */
export class ShallowWaterBake {
    public readonly nx: number;
    public readonly nz: number;
    public readonly cell: number;
    public readonly steps: number;
    public stepped = 0;
    private readonly _s: WaterBakeSetup;
    private readonly _h: Float32Array;
    private readonly _hNext: Float32Array;
    /** Velocities on the x faces ((nx + 1) x nz) and the z faces (nx x (nz + 1)); swapped with the next each step. */
    private _u: Float32Array; private _w: Float32Array;
    private _uNext: Float32Array; private _wNext: Float32Array;
    /** The faces between two cells that can hold water (the only ones whose velocity is ever not 0): face index, then its two cells. */
    private readonly _xFaces: Int32Array; private readonly _zFaces: Int32Array;
    /** Per cell: how much of its outflow this step keeps it from running dry (1 = all of it). */
    private readonly _limit: Float32Array;
    private readonly _active: Int32Array;
    private readonly _sumU: Float32Array; private readonly _sumV: Float32Array; private readonly _sumD: Float32Array;
    private _samples = 0;
    private readonly _dt: number;
    private readonly _maxU: number;

    constructor(setup: WaterBakeSetup) {
        this._s = setup;
        const nx = this.nx = setup.nx, nz = this.nz = setup.nz, cell = this.cell = setup.cell;
        const n = nx * nz;
        this._h = new Float32Array(n); this._hNext = new Float32Array(n);
        this._u = new Float32Array((nx + 1) * nz); this._uNext = new Float32Array((nx + 1) * nz);
        this._w = new Float32Array(nx * (nz + 1)); this._wNext = new Float32Array(nx * (nz + 1));
        this._limit = new Float32Array(n).fill(1);
        this._sumU = new Float32Array(n); this._sumV = new Float32Array(n); this._sumD = new Float32Array(n);
        const active: number[] = [];
        let maxDepth = 0.2;
        for (let i = 0; i < n; i++) {
            if (setup.kind[i] === CELL_WALL) continue;
            active.push(i);
            // Start from the analytic water, so the bake begins near where it will settle.
            const t = setup.target[i];
            this._h[i] = Number.isFinite(t) ? Math.max(0, t - setup.bed[i]) : 0;
            maxDepth = Math.max(maxDepth, this._h[i]);
        }
        if (!active.length) throw new Error('Nothing to bake: no cell can hold water.');
        this._active = Int32Array.from(active);
        const xf: number[] = [], zf: number[] = [];
        for (let j = 0; j < nz; j++) for (let i = 1; i < nx; i++) {
            const a = j * nx + i - 1, c = a + 1;
            if (setup.kind[a] !== CELL_WALL && setup.kind[c] !== CELL_WALL) xf.push(j * (nx + 1) + i, a, c);
        }
        for (let j = 1; j < nz; j++) for (let i = 0; i < nx; i++) {
            const a = (j - 1) * nx + i, c = a + nx;
            if (setup.kind[a] !== CELL_WALL && setup.kind[c] !== CELL_WALL) zf.push(j * nx + i, a, c);
        }
        this._xFaces = Int32Array.from(xf); this._zFaces = Int32Array.from(zf);
        // CFL: a gravity wave crosses a cell in no less than about four steps; velocities are capped to match.
        this._dt = Math.min(0.1, 0.25 * cell / Math.sqrt(G * maxDepth * 1.5));
        this._maxU = 0.5 * cell / this._dt;
        this.steps = Math.max(200, Math.min(60000, Math.ceil(setup.duration / this._dt)));
    }

    public get done(): boolean { return this.stepped >= this.steps; }
    public get progress(): number { return Math.min(1, this.stepped / this.steps); }
    /** Seconds per step. */
    public get dt(): number { return this._dt; }

    /** Advance up to `count` steps. */
    public step(count: number): void {
        const end = Math.min(this.steps, this.stepped + count);
        // The last third is the settled stretch whose depth and velocity are averaged.
        const averageFrom = Math.floor(this.steps * 2 / 3);
        for (; this.stepped < end; this.stepped++) {
            this._advect();
            this._integrateDepth();
            this._accelerate();
            if (this.stepped >= averageFrom) this._sample();
        }
    }

    /** The x-face velocity field at a point in cell-centre units (faces sit at (i - 0.5, j)), bilinear. */
    private _sampleU(px: number, pz: number): number {
        const nx = this.nx, nz = this.nz, row = nx + 1, u = this._u;
        const fx = Math.min(nx, Math.max(0, px + 0.5)), fz = Math.min(nz - 1, Math.max(0, pz));
        const i0 = Math.min(nx - 1, Math.floor(fx)), j0 = Math.floor(fz);
        const j1 = Math.min(nz - 1, j0 + 1);
        const tx = fx - i0, tz = fz - j0;
        return (u[j0 * row + i0] * (1 - tx) + u[j0 * row + i0 + 1] * tx) * (1 - tz)
             + (u[j1 * row + i0] * (1 - tx) + u[j1 * row + i0 + 1] * tx) * tz;
    }

    /** The z-face field likewise (faces at (i, j - 0.5)). */
    private _sampleW(px: number, pz: number): number {
        const nx = this.nx, nz = this.nz, w = this._w;
        const fx = Math.min(nx - 1, Math.max(0, px)), fz = Math.min(nz, Math.max(0, pz + 0.5));
        const i0 = Math.floor(fx), j0 = Math.min(nz - 1, Math.floor(fz));
        const i1 = Math.min(nx - 1, i0 + 1);
        const tx = fx - i0, tz = fz - j0;
        return (w[j0 * nx + i0] * (1 - tx) + w[j0 * nx + i1] * tx) * (1 - tz)
             + (w[(j0 + 1) * nx + i0] * (1 - tx) + w[(j0 + 1) * nx + i1] * tx) * tz;
    }

    /** 1. The velocities carried along by themselves (semi-Lagrangian), where there is water to carry them. */
    private _advect(): void {
        const nx = this.nx, row = nx + 1;
        const k = this._dt / this.cell;
        const h = this._h, u = this._u, w = this._w, un = this._uNext, wn = this._wNext;
        const xf = this._xFaces, zf = this._zFaces;
        for (let q = 0; q < xf.length; q += 3) {
            const f = xf[q], a = xf[q + 1], c = xf[q + 2];
            if (h[a] < DRY && h[c] < DRY) { un[f] = 0; continue; }
            const j = (f / row) | 0, i = f - j * row;
            const vw = 0.25 * (w[j * nx + i - 1] + w[j * nx + i] + w[(j + 1) * nx + i - 1] + w[(j + 1) * nx + i]);
            un[f] = this._sampleU(i - 0.5 - u[f] * k, j - vw * k);
        }
        for (let q = 0; q < zf.length; q += 3) {
            const f = zf[q], a = zf[q + 1], c = zf[q + 2];
            if (h[a] < DRY && h[c] < DRY) { wn[f] = 0; continue; }
            const j = (f / nx) | 0, i = f - j * nx;
            const vu = 0.25 * (u[(j - 1) * row + i] + u[(j - 1) * row + i + 1] + u[j * row + i] + u[j * row + i + 1]);
            wn[f] = this._sampleW(i - vu * k, j - 0.5 - w[f] * k);
        }
        // Only the listed faces are ever written; the rest stay 0 in both buffers.
        this._u = un; this._uNext = u; this._w = wn; this._wNext = w;
    }

    /** 2. Depths from the flux through each face (upwind depth times velocity), never below dry; boundaries. */
    private _integrateDepth(): void {
        const { nx } = this;
        const s = this._s, dt = this._dt, k = dt / this.cell, area = this.cell * this.cell;
        const h = this._h, u = this._u, w = this._w, limit = this._limit, row = nx + 1;
        // Each cell's outflow this step, scaled down so no cell gives more than it has.
        for (const i of this._active) {
            const x = i % nx, j = (i - x) / nx;
            const out = (Math.max(0, u[j * row + x + 1]) + Math.max(0, -u[j * row + x])
                       + Math.max(0, w[(j + 1) * nx + x]) + Math.max(0, -w[j * nx + x])) * h[i] * k;
            limit[i] = out > h[i] && out > 0 ? h[i] / out : 1;
        }
        const hn = this._hNext;
        for (const i of this._active) {
            const x = i % nx, j = (i - x) / nx;
            const fl = u[j * row + x], fr = u[j * row + x + 1], fb = w[j * nx + x], ft = w[(j + 1) * nx + x];
            // Flux through a face: its velocity times the depth upwind of it, at that cell's limit. A face on
            // the grid's edge has no velocity (closed in _accelerate): its missing neighbour is never read.
            const qL = fl > 0 ? fl * h[i - 1] * limit[i - 1] : fl < 0 ? fl * h[i] * limit[i] : 0;
            const qR = fr > 0 ? fr * h[i] * limit[i] : fr < 0 ? fr * h[i + 1] * limit[i + 1] : 0;
            const qB = fb > 0 ? fb * h[i - nx] * limit[i - nx] : fb < 0 ? fb * h[i] * limit[i] : 0;
            const qT = ft > 0 ? ft * h[i] * limit[i] : ft < 0 ? ft * h[i + nx] * limit[i + nx] : 0;
            let d = h[i] + k * (qL - qR + qB - qT) + s.inflow[i] * dt / area;
            const kd = s.kind[i];
            if (kd === CELL_HELD) d = Math.max(0, s.target[i] - s.bed[i]);
            else if (kd === CELL_DRAIN) d *= Math.exp(-2 * dt);
            else if (s.hold > 0 && s.own[i] && Number.isFinite(s.target[i])) d += (Math.max(0, s.target[i] - s.bed[i]) - d) * s.hold * dt;
            hn[i] = d > 0 ? d : 0;
        }
        for (const i of this._active) h[i] = hn[i];
    }

    /** 3. Velocities down the surface's slope, with Manning's bed friction; closed at walls and dry banks. */
    private _accelerate(): void {
        const s = this._s, dt = this._dt, g = G * dt / this.cell, fr = G * dt * s.manning * s.manning;
        const h = this._h, bed = s.bed, maxU = this._maxU;
        for (let pass = 0; pass < 2; pass++) {
            const faces = pass === 0 ? this._xFaces : this._zFaces, vel = pass === 0 ? this._u : this._w;
            for (let q = 0; q < faces.length; q += 3) {
                const f = faces[q], a = faces[q + 1], c = faces[q + 2];
                let v = vel[f] - g * ((bed[c] + h[c]) - (bed[a] + h[a]));
                // Water flows only out of a cell that has some.
                const up = v > 0 ? h[a] : h[c];
                if (up < DRY) { vel[f] = 0; continue; }
                const hf = up > 0.02 ? up : 0.02;
                v /= 1 + fr * Math.abs(v) / Math.pow(hf, 4 / 3);
                vel[f] = v > maxU ? maxU : v < -maxU ? -maxU : v;
            }
        }
    }

    private _sample(): void {
        const { nx } = this;
        const h = this._h, u = this._u, w = this._w, row = nx + 1;
        for (const i of this._active) {
            const x = i % nx, j = (i - x) / nx;
            this._sumD[i] += h[i];
            if (h[i] > DRY) {
                this._sumU[i] += 0.5 * (u[j * row + x] + u[j * row + x + 1]);
                this._sumV[i] += 0.5 * (w[j * nx + x] + w[(j + 1) * nx + x]);
            }
        }
        this._samples++;
    }

    /** The settled water as a water info grid. Call once `done`. */
    public result(id = 'bake'): WaterInfo {
        const { nx, nz, cell } = this;
        const s = this._s;
        const n = nx * nz;
        const info0 = new Float32Array(n * 4), info1 = new Float32Array(n * 4);
        const wet = new Uint8Array(n), handed = new Uint8Array(n);
        const m = Math.max(1, this._samples);
        for (let i = 0; i < n; i++) {
            const depth = this._sumD[i] / m;
            info1[i * 4] = s.waveFactor;
            info1[i * 4 + 2] = s.bed[i];
            if (s.kind[i] === CELL_WALL || depth <= DRY * 2) continue;
            // The water it joins is drawn by its own node: handed over, not drawn here (but no shore either).
            if (s.kind[i] === CELL_HELD) { handed[i] = 1; continue; }
            wet[i] = 1;
            info0[i * 4] = s.bed[i] + depth;
            // Clamp: a cell that barely holds water reports flux over almost no depth.
            const u = this._sumU[i] / m, v = this._sumV[i] / m;
            const sp = Math.hypot(u, v), cap = 6;
            info0[i * 4 + 1] = sp > cap ? u * cap / sp : u;
            info0[i * 4 + 2] = sp > cap ? v * cap / sp : v;
            info1[i * 4 + 3] = 1;
        }
        // Shore distance (the handed-over water counts as water), and dry cells taking the nearest wet surface.
        const mask = new Uint8Array(n);
        for (let i = 0; i < n; i++) mask[i] = wet[i] | handed[i];
        const { dist } = chamferDistance(mask, nx, nz, cell);
        const near = chamferDistance(wet, nx, nz, cell).nearestSet;
        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < n; i++) {
            info0[i * 4 + 3] = dist[i];
            if (wet[i]) { minY = Math.min(minY, info0[i * 4]); maxY = Math.max(maxY, info0[i * 4]); continue; }
            const k = near[i];
            if (k >= 0) info0[i * 4] = info0[k * 4];
        }
        // Foam: where the flow converges, shears or swirls hard, runs fast, or drops.
        for (let z = 1; z < nz - 1; z++) for (let x = 1; x < nx - 1; x++) {
            const i = z * nx + x;
            if (!wet[i]) continue;
            const ux = (info0[(i + 1) * 4 + 1] - info0[(i - 1) * 4 + 1]) / (2 * cell);
            const vz = (info0[(i + nx) * 4 + 2] - info0[(i - nx) * 4 + 2]) / (2 * cell);
            const uz = (info0[(i + nx) * 4 + 1] - info0[(i - nx) * 4 + 1]) / (2 * cell);
            const vx = (info0[(i + 1) * 4 + 2] - info0[(i - 1) * 4 + 2]) / (2 * cell);
            const div = ux + vz, curl = vx - uz;
            const slope = Math.hypot((info0[(i + 1) * 4] - info0[(i - 1) * 4]) / (2 * cell), (info0[(i + nx) * 4] - info0[(i - nx) * 4]) / (2 * cell));
            const speed = Math.hypot(info0[i * 4 + 1], info0[i * 4 + 2]);
            info1[i * 4 + 1] = Math.min(1, Math.max(0, -div) * 0.3 + Math.abs(curl) * 0.04
                + Math.max(0, slope - 0.05) * 3 + Math.max(0, speed - 1.5) * 0.25);
        }
        if (!Number.isFinite(minY)) { minY = 0; maxY = 0; }
        const out: WaterInfo = {
            originX: s.originX, originZ: s.originZ, cell, nx, nz, info0, info1, minY, maxY,
            tileCells: 0, tilesX: 0, tilesZ: 0, tileWet: new Uint8Array(0), tileMinY: new Float32Array(0), tileMaxY: new Float32Array(0),
            oceanLevel: null, source: id,
        };
        tileWaterInfo(out);
        return out;
    }

    /** The water at grid cell (x, z) right now: depth and cell-centre velocity. For tests and tools. */
    public probe(x: number, z: number): { depth: number; u: number; v: number } {
        const i = z * this.nx + x, row = this.nx + 1;
        return { depth: this._h[i], u: 0.5 * (this._u[z * row + x] + this._u[z * row + x + 1]), v: 0.5 * (this._w[z * this.nx + x] + this._w[(z + 1) * this.nx + x]) };
    }
}

/** Run a whole bake at once (tests, tools). */
export function bakeWater(setup: WaterBakeSetup, id = 'bake'): WaterInfo {
    const bake = new ShallowWaterBake(setup);
    while (!bake.done) bake.step(500);
    return bake.result(id);
}

/**
 * The first shape baked, joined to the rest (and `handOver`): the older list form, for tools and tests that
 * resolve shapes themselves. The editor goes through bakeNode.ts, which also reads the scene's obstacles.
 */
export function bakeShallowWater(shapes: readonly ResolvedWaterShape[], ground: GroundSampler | null,
                                 options: { maxRes?: number; duration?: number; handOver?: readonly ResolvedWaterShape[] } = {}): WaterInfo {
    const [body, ...rest] = shapes;
    if (!body) throw new Error('Nothing to bake: the water has no finite shape.');
    const setup = prepareWaterBake(body, [...rest, ...(options.handOver ?? [])], ground, [], { maxRes: options.maxRes, duration: options.duration });
    return bakeWater(setup);
}
