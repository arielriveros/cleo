import { chamferDistance, tileWaterInfo, type WaterInfo } from '../waterInfo';
import { transportFoam } from './foam';

// The water BAKE: the shallow-water equations solved over a whole connected system of water (a river, the
// lake it runs into, the river that drains it, down to the sea) and the ground and static obstacles under
// it, until what flows in is what flows out, its depth and velocity then averaged over a settled stretch.
// It is how Unreal's Water Advanced plugin bakes its rivers (one simulation from the sources to the sinks
// over the captured terrain, run to a steady state, baked to static textures for rendering and physics), on
// the CPU. What comes out is one water info grid (water/waterInfo.ts) per member, cut from the one field, with
// the water where it actually runs: downhill, round a rock and over a bar, pooling behind a sill and spilling
// over it, through the lake from its inflow to its outlet. The surface renderer draws it, and physics carries
// what floats on it.
//
// The solver is the height-field one of Chentanez & Müller ("Real-time Simulation of Large Bodies of Water
// with Small Scale Details", 2010), without its particles: depths at cell centres, velocities on the faces
// between them (a staggered grid); each step the velocities are carried along by themselves
// (semi-Lagrangian advection, which is what lets eddies form), the depths change by the flux through each
// face (the depth upwind of the face times its velocity, scaled down where a cell would run dry), and the
// velocities are pushed down the surface's slope. Bed friction follows Manning: u /= 1 + dt·g·n²·|u|/h^(4/3),
// so a river settles at the speed its slope and depth give (v = h^(2/3)·S^(1/2)/n for a wide channel). On
// steep ground the roughness is at least what Jarrett measured in mountain streams ("Hydraulics of
// High-Gradient Streams", 1984: n = 0.32·S^0.38·R^-0.16, R in metres): boulders and steps hold a torrent to a
// metre or three a second, where a smooth bed would let it sheet down at ten. S is the slope the water runs
// down, its surface's along the flow: not the bed's, whose slope across a channel (its banks) says nothing of
// how steeply the stream falls. It holds for natural beds: one smoother than a natural channel's (Manning's
// n under NATURAL_BED: concrete, a flume) is taken at its word and runs as fast as its slope lets it.
// Something standing in a cell without filling it (a post, a pier narrower than the grid can draw the water
// parting round) holds it back by its drag, as Manning's friction does: u /= 1 + dt·D·|u|, D the obstacle's
// (bake/groupSetup.ts), so the water slows through it, piles a little before it and loses its head behind it.
//
// Cell kinds (the boundaries):
//  - WALL: not simulated: outside every member's reach, or a static obstacle standing out of the water;
//  - WATER: free;
//  - HELD: water the system runs into but does not include (the endless sea): held at its level, it takes what
//    the rivers bring;
//  - DRAIN: a river's end that runs into nothing: the water leaves;
//  - LEAK: the edge of the simulated region where the ground carries on beyond it: water standing there above
//    the ground just outside has left the course it was drawn on, and is lost (and reported);
//  - water is INJECTED where a river rises (its drawn discharge: width x depth x flow speed at its head).
//
// A lake between two rivers is slow to find its level: it holds far more water than the rivers bring in a
// minute, and a bake would spend most of its time waiting for it to rise or fall. Only the settled state is
// kept, so every few steps the water a lake gained or lost is counted many times over (up to LAKE_HASTE), as
// one lift or drop of its whole surface: its level moves that much faster, no wave is raised by it, and where
// it settles (inflow equal to outflow, no change left to amplify) is the same. How many times over is set by
// the lake's size against how sharply an outlet answers a change of level, so the level closes on its
// balance in some tens of seconds without overshooting it.
//
// Pure and deterministic (same input, same bits), on the CPU so it bakes the same everywhere; the setup
// (bake/groupSetup.ts) reads the ground and the obstacles, the solver (ShallowWaterBake) only arrays, so it
// runs in a worker. `step(n)` runs in slices.

const G = 9.81;
/** Depth below which a cell counts as dry. */
const DRY = 0.005;
/** Manning's n from which a bed counts as a natural one, never smoother than a stream on its slope measures. */
const NATURAL_BED = 0.025;
/** Metres of water under which a cell is left out of the result as dry. */
const THIN = 0.03;
/** Metres under dry ground the surface is carried on at, beside the water. */
const BANK_UNDER = 0.03;
/** Steps between re-reading the time step from the water as it is. */
const RETIME = 16;
/** How many times faster than real a lake's or pool's level moves at most while the bake settles (see the header). */
const LAKE_HASTE = 200;
/** Metres a lake's surface is lifted or dropped at most at a time. */
const LAKE_LIFT = 0.02;

export const CELL_WALL = 0;
export const CELL_WATER = 1;
export const CELL_HELD = 2;
export const CELL_DRAIN = 3;
export const CELL_LEAK = 4;

/** The default Manning roughness: a natural channel, clean and winding. */
export const DEFAULT_MANNING = 0.03;

/** One body of the system, as the solver needs it. */
export interface WaterBakeMember {
    /** The Water node's id: its result is `WaterBakeOutput.members` under it. */
    id: string;
    /** The body's share of its node's waves, for its result. */
    waveFactor: number;
    /** Manning's roughness of its bed. */
    manning: number;
    /**
     * A lake or pool with no river out of it: the level above which its water is taken away (it takes what
     * its rivers bring without rising). NaN: none.
     */
    spill: number;
    /** A lake's or pool's drawn level (NaN for a river), for the report. */
    level: number;
}

/** When a bake is settled: what flows in and what leaves agree, and the water has stopped rising. */
export interface WaterBakeSettle {
    /** The imbalance allowed, as a share of the flow. */
    tolerance: number;
    /** Seconds each check is taken over (long enough to average the waves a steep reach never stops making). */
    window: number;
    /** Seconds before the first check counts. */
    minSeconds: number;
    /** Seconds after which the bake stops whether settled or not. */
    maxSeconds: number;
    /** Seconds the settled water is averaged over. */
    average: number;
}

/** Everything the solver needs, as plain arrays (structured-cloneable, transferable). */
export interface WaterBakeSetup {
    originX: number; originZ: number; cell: number; nx: number; nz: number;
    /** The bed the water runs over (the ground, raised by obstacles under the water; deep still water capped). */
    bed: Float32Array;
    /** The real bed, for the result: `bed` without the cap on deep still water. */
    floor: Float32Array;
    /** CELL_* per cell. */
    kind: Uint8Array;
    /** Held cells: the level they are held at. Others: the surface to start from (NaN: start dry). */
    target: Float32Array;
    /** Water added per cell, m³/s (a river's source, a lake feeding the river that drains it). */
    inflow: Float32Array;
    /** Which member's water a cell is: 1 + its index in `members`, 0 for none. */
    owner: Uint8Array;
    /** LEAK cells: the height of the ground just outside the simulated region; only water standing above it leaves. */
    sill: Float32Array;
    /**
     * Per cell: the drag (1/m) of what stands in it without filling it (a post, a pier narrower than a cell):
     * the water through it slows by du/dt = -drag u|u|. None: nothing does.
     */
    drag?: Float32Array;
    /** The static colliders the water met; narrow: those it is held back by but not seen to part round. */
    obstacles?: { count: number; narrow: number };
    members: WaterBakeMember[];
    /** Run until settled; null runs `duration` seconds and averages the last third (tests, tools). */
    settle: WaterBakeSettle | null;
    duration: number;
}

/** How a bake went. Rates are over its last check, m³/s. */
export interface WaterBakeReport {
    /** Whether what flows in and what leaves agreed before the time ran out. */
    settled: boolean;
    /** Seconds of water simulated. */
    seconds: number;
    /** Water coming in (sources, and what held water gave). */
    inflow: number;
    /** Water leaving where it should: into held water, out of a river's open end, over a sink lake's level. */
    outflow: number;
    /** Water that left the course it was drawn on (over the edge of the simulated region). */
    lost: number;
    /** Where most of it left, world x and z. */
    lostAt: [number, number] | null;
    /** How fast the water held is still changing (positive: still filling). */
    filling: number;
    /** Where it was still rising fastest, world x and z (a hollow on a river's way). */
    fillingAt: [number, number] | null;
    /** Each lake's and pool's settled level against the level it was drawn at. */
    levels: { id: string; level: number; drawn: number }[];
    /** The static colliders standing in the water (see WaterBakeSetup.obstacles). */
    obstacles?: { count: number; narrow: number };
}

export interface WaterBakeOutput {
    /** One water info grid per member, in the members' order. */
    members: { id: string; info: WaterInfo }[];
    report: WaterBakeReport;
}

/** A river's discharge at sample `q`: its parabolic channel's area times its speed (m³/s). */
export function riverDischarge(q: { width: number; depth: number; speed: number }): number {
    return q.width * q.depth * (2 / 3) * q.speed;
}

/** A bake in progress: call `step(n)` until `done`, then `results()`. */
export class ShallowWaterBake {
    public readonly nx: number;
    public readonly nz: number;
    public readonly cell: number;
    /** Steps taken, and seconds of water simulated. */
    public stepped = 0;
    public seconds = 0;
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
    /** Per cell: its member's roughness. */
    private readonly _rough: Float32Array;
    /** Per cell: the drag of what stands in it (WaterBakeSetup.drag); null when nothing does. */
    private readonly _drag: Float32Array | null;
    /** Each lake or pool with water running through it: its cells, and the water in them when last looked at (m x cells). */
    private readonly _lakes: { cells: Int32Array; held: number }[] = [];
    /** Cubic metres the lakes were lifted by (or dropped, negative) since the check in progress opened. */
    private _lifted = 0;
    /** Per active cell: its row, so its faces are found without dividing. */
    private readonly _row: Int32Array;
    /** Time-weighted sums over the settled stretch. */
    private readonly _sumU: Float32Array; private readonly _sumV: Float32Array; private readonly _sumD: Float32Array;
    private _sampleTime = 0;
    private _dt = 0.01;
    private _maxU = 1;
    private _fastest = 0;
    private readonly _source: number;
    // The check in progress: volumes in and out since it opened, and the depths it opened with.
    private _windowEnd: number;
    private _in = 0; private _out = 0; private _lost = 0;
    /** What the held water took, less what it gave back, since the check opened (m3): it laps at a river's mouth. */
    private _taken = 0;
    private _volume: number;
    private readonly _leaked: Float32Array;
    private readonly _hAtWindow: Float32Array;
    private _calm = 0;
    private _averaging = false;
    private _averageUntil = Infinity;
    private _finished = false;
    private readonly _report: WaterBakeReport = {
        settled: false, seconds: 0, inflow: 0, outflow: 0, lost: 0, lostAt: null, filling: 0, fillingAt: null, levels: [],
    };

    constructor(setup: WaterBakeSetup) {
        this._s = setup;
        const nx = this.nx = setup.nx, nz = this.nz = setup.nz, cell = this.cell = setup.cell;
        const n = nx * nz;
        this._h = new Float32Array(n); this._hNext = new Float32Array(n);
        this._u = new Float32Array((nx + 1) * nz); this._uNext = new Float32Array((nx + 1) * nz);
        this._w = new Float32Array(nx * (nz + 1)); this._wNext = new Float32Array(nx * (nz + 1));
        this._limit = new Float32Array(n).fill(1);
        this._sumU = new Float32Array(n); this._sumV = new Float32Array(n); this._sumD = new Float32Array(n);
        this._rough = new Float32Array(n);
        this._drag = setup.drag && setup.drag.some(d => d > 0) ? setup.drag : null;
        if (setup.obstacles) this._report.obstacles = { ...setup.obstacles };
        this._leaked = new Float32Array(n); this._hAtWindow = new Float32Array(n);
        const active: number[] = [];
        let source = 0;
        for (let i = 0; i < n; i++) {
            if (setup.kind[i] === CELL_WALL) continue;
            active.push(i);
            // Start from the water as drawn where it is given (a lake at its level), dry elsewhere.
            const t = setup.target[i];
            this._h[i] = Number.isFinite(t) ? Math.max(0, t - setup.bed[i]) : 0;
            source += setup.inflow[i];
            const m = setup.owner[i] ? setup.members[setup.owner[i] - 1] : undefined;
            this._rough[i] = Math.max(0.005, m ? m.manning : DEFAULT_MANNING);
        }
        // The lakes and pools with water running through them (not a sink, which takes what comes at its level).
        if (setup.settle) setup.members.forEach((m, k) => {
            if (!Number.isFinite(m.level) || Number.isFinite(m.spill)) return;
            const cells = active.filter(i => setup.owner[i] === k + 1 && setup.kind[i] === CELL_WATER);
            let held = 0;
            for (const i of cells) held += this._h[i];
            if (cells.length) this._lakes.push({ cells: Int32Array.from(cells), held });
        });
        if (!active.length) throw new Error('Nothing to bake: no cell can hold water.');
        this._active = Int32Array.from(active);
        this._row = Int32Array.from(active, i => Math.floor(i / nx));
        this._source = source;
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
        this._volume = this._held();
        this._hAtWindow.set(this._h);
        const st = setup.settle;
        this._windowEnd = st ? st.window : setup.duration * 2 / 3;
        this._retime();
    }

    public get done(): boolean { return this._finished; }
    public get progress(): number {
        if (this._finished) return 1;
        const st = this._s.settle;
        return Math.min(0.99, this.seconds / Math.max(1e-6, st ? st.maxSeconds : this._s.duration));
    }
    /** Seconds per step, as of the last re-reading. */
    public get dt(): number { return this._dt; }
    /** How the bake is going (complete once `done`). */
    public get report(): WaterBakeReport { return this._report; }

    /** Advance up to `count` steps. */
    public step(count: number): void {
        for (let k = 0; k < count && !this._finished; k++) {
            if (this.stepped % RETIME === 0) { this._hasten(); this._retime(); }
            this._advect();
            this._integrateDepth();
            this._accelerate();
            this.seconds += this._dt;
            this.stepped++;
            if (this._averaging) {
                this._sample();
                if (this.seconds >= this._averageUntil) this._finish();
            } else if (this.seconds >= this._windowEnd) this._check();
        }
    }

    /**
     * The time step from the water as it is: a gravity wave (and the fastest water) crosses a cell in no less
     * than two and a half steps, and velocities are capped to match. The water starts dry and pools, so the
     * depth the bake began with says nothing about the depth it reaches.
     */
    private _retime(): void {
        const h = this._h;
        let deepest = 0.2;
        for (const i of this._active) if (h[i] > deepest) deepest = h[i];
        const speed = Math.sqrt(G * deepest * 1.5) + Math.min(this._fastest, 20);
        this._dt = Math.min(0.1, 0.4 * this.cell / speed);
        this._maxU = 0.5 * this.cell / this._dt;
        this._fastest = 0;
    }

    /**
     * Each lake's level moved on by what it gained or lost since the last time, many times over (see the
     * header): one lift of its whole wet surface. A lift of dz changes what leaves by about K dz, K the
     * outlet's answer (m2/s); counted F times over, the level's error shrinks each time by F T K / area, which
     * must stay well under 1. K is taken as steep as an outlet gets, so F errs low.
     */
    private _hasten(): void {
        const h = this._h, area = this.cell * this.cell;
        // The outlet's answer (5/3 of Q over a depth of water of half a metre, Manning's), over the time between two lifts.
        const answer = Math.max(1, 3.3 * this._source) * RETIME * this._dt;
        for (const lake of this._lakes) {
            const cells = lake.cells;
            let held = 0, wet = 0;
            for (let a = 0; a < cells.length; a++) { const d = h[cells[a]]; held += d; if (d > DRY) wet++; }
            const gain = Math.min(LAKE_HASTE, 1 + 0.1 * wet * area / answer);
            let lift = wet && this.stepped > 0 ? (gain - 1) * (held - lake.held) / wet : 0;
            lift = lift > LAKE_LIFT ? LAKE_LIFT : lift < -LAKE_LIFT ? -LAKE_LIFT : lift;
            if (lift !== 0) {
                let after = 0;
                for (let a = 0; a < cells.length; a++) {
                    const i = cells[a];
                    if (h[i] > DRY) h[i] = Math.max(0, h[i] + lift);
                    after += h[i];
                }
                this._lifted += (after - held) * area;
                held = after;
            }
            lake.held = held;
        }
    }

    /** Cubic metres of free water (held water is a boundary, not part of the count). */
    private _held(): number {
        const h = this._h, kind = this._s.kind;
        let v = 0;
        for (const i of this._active) if (kind[i] !== CELL_HELD) v += h[i];
        return v * this.cell * this.cell;
    }

    /** One check closes: is what comes in what leaves, and has the water stopped rising? */
    private _check(): void {
        const s = this._s, st = s.settle;
        const span = st ? st.window : Math.max(1e-6, s.duration * 2 / 3);
        const volume = this._held();
        const r = this._report;
        // Held water takes a river's water and gives some back with every lap at its mouth: only the balance
        // of the two came in or went out.
        r.inflow = (this._in + Math.max(0, -this._taken)) / span;
        r.outflow = (this._out + Math.max(0, this._taken)) / span;
        r.lost = this._lost / span;
        this._taken = 0;
        // What the water itself did: the lifts given to the lakes are not its doing.
        r.filling = (volume - this._volume - this._lifted) / span;
        this._lifted = 0;
        // Where the water left its course, and where it is still rising.
        let worst = 0, at = -1, rise = 0, riseAt = -1;
        const h = this._h, before = this._hAtWindow;
        for (const i of this._active) {
            if (this._leaked[i] > worst) { worst = this._leaked[i]; at = i; }
            const d = h[i] - before[i];
            if (d > rise && s.kind[i] !== CELL_HELD) { rise = d; riseAt = i; }
        }
        const world = (i: number): [number, number] => [s.originX + (i % this.nx) * this.cell, s.originZ + Math.floor(i / this.nx) * this.cell];
        r.lostAt = at >= 0 && r.lost > 0 ? world(at) : null;
        r.fillingAt = riseAt >= 0 ? world(riseAt) : null;
        this._in = 0; this._out = 0; this._lost = 0; this._volume = volume;
        this._leaked.fill(0);
        before.set(h);
        if (!st) { this._average(s.duration - this.seconds, false); return; }
        const through = Math.max(r.inflow, r.outflow + r.lost);
        // Still water has nothing to settle; flowing water has settled when its store has stopped changing.
        const calm = through <= 1e-9 ? Math.abs(r.filling) <= 1e-6 : Math.abs(r.filling) <= st.tolerance * through;
        this._calm = calm ? this._calm + 1 : 0;
        if (this._calm >= 3 && this.seconds >= st.minSeconds) this._average(st.average, true);
        else if (this.seconds + st.window + st.average > st.maxSeconds) this._average(st.average, false);
        else this._windowEnd = this.seconds + st.window;
    }

    private _average(seconds: number, settled: boolean): void {
        this._averaging = true;
        this._report.settled = settled;
        this._averageUntil = this.seconds + Math.max(seconds, this._dt);
    }

    private _finish(): void {
        this._finished = true;
        const s = this._s, r = this._report;
        r.seconds = this.seconds;
        if (!r.settled) r.fillingAt = r.filling > 0 ? r.fillingAt : null; else { r.fillingAt = null; r.filling = 0; }
        // Each lake's and pool's level as it settled: the mean surface over its cells that started full.
        const sums = s.members.map(() => [0, 0]);
        const T = Math.max(this._sampleTime, 1e-9);
        for (const i of this._active) {
            const o = s.owner[i];
            if (!o || !Number.isFinite(s.members[o - 1].level) || !Number.isFinite(s.target[i]) || s.kind[i] === CELL_HELD) continue;
            const depth = this._sumD[i] / T;
            if (depth <= DRY * 2) continue;
            sums[o - 1][0] += s.bed[i] + depth; sums[o - 1][1]++;
        }
        r.levels = [];
        s.members.forEach((m, k) => {
            if (Number.isFinite(m.level) && sums[k][1] > 0) r.levels.push({ id: m.id, level: sums[k][0] / sums[k][1], drawn: m.level });
        });
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
        const h = this._h, u = this._u, w = this._w, limit = this._limit;
        const active = this._active, rows = this._row, count = active.length;
        // Each cell's outflow this step, scaled down so no cell gives more than it has.
        for (let a = 0; a < count; a++) {
            const i = active[a];
            if (h[i] <= 0) { limit[i] = 1; continue; }
            // The cell's x faces are at i + its row and the next; its z faces at i and i + nx.
            const fx = i + rows[a];
            const out = (Math.max(0, u[fx + 1]) + Math.max(0, -u[fx]) + Math.max(0, w[i + nx]) + Math.max(0, -w[i])) * h[i] * k;
            limit[i] = out > h[i] && out > 0 ? h[i] / out : 1;
        }
        const hn = this._hNext;
        let gone = 0, lost = 0, taken = 0;
        const came = this._source * dt;
        for (let a = 0; a < count; a++) {
            const i = active[a];
            const fx = i + rows[a];
            const fl = u[fx], fr = u[fx + 1], fb = w[i], ft = w[i + nx];
            // Dry, and nothing coming: most of a corridor is its banks.
            if (h[i] <= 0 && fl <= 0 && fr >= 0 && fb <= 0 && ft >= 0 && s.inflow[i] <= 0 && s.kind[i] !== CELL_HELD) { hn[i] = 0; continue; }
            // Flux through a face: its velocity times the depth upwind of it, at that cell's limit. A face on
            // the grid's edge has no velocity (closed in _accelerate): its missing neighbour is never read.
            const qL = fl > 0 ? fl * h[i - 1] * limit[i - 1] : fl < 0 ? fl * h[i] * limit[i] : 0;
            const qR = fr > 0 ? fr * h[i] * limit[i] : fr < 0 ? fr * h[i + 1] * limit[i + 1] : 0;
            const qB = fb > 0 ? fb * h[i - nx] * limit[i - nx] : fb < 0 ? fb * h[i] * limit[i] : 0;
            const qT = ft > 0 ? ft * h[i] * limit[i] : ft < 0 ? ft * h[i + nx] * limit[i + nx] : 0;
            let d = h[i] + k * (qL - qR + qB - qT) + s.inflow[i] * dt / area;
            if (d < 0) d = 0;
            const kd = s.kind[i];
            if (kd === CELL_HELD) {
                // Held at its level: what it took, less what it gave, is the system's outflow (or its inflow).
                const keep = Math.max(0, s.target[i] - s.bed[i]);
                taken += (d - keep) * area;
                d = keep;
            } else if (kd === CELL_DRAIN || kd === CELL_LEAK) {
                // An open end: the water leaves at least as fast as it arrives, so the end never backs up. Over
                // the region's edge only what stands above the ground outside it leaves.
                const stay = kd === CELL_LEAK ? Math.max(0, s.sill[i] - s.bed[i]) : 0;
                if (d > stay) {
                    const speed = Math.max(Math.abs(fl), Math.abs(fr), Math.abs(fb), Math.abs(ft));
                    const left = (d - stay) * (1 - Math.exp(-(2 + 2 * speed / this.cell) * dt));
                    d -= left;
                    if (kd === CELL_LEAK) { lost += left * area; this._leaked[i] += left; } else gone += left * area;
                }
            } else {
                const o = s.owner[i];
                const spill = o ? s.members[o - 1].spill : NaN;
                if (spill === spill && s.bed[i] + d > spill) {
                    // A lake no river drains: it takes what comes without rising.
                    const over = (s.bed[i] + d - spill) * Math.min(1, 4 * dt);
                    d -= over; gone += over * area;
                }
            }
            hn[i] = d;
        }
        for (let a = 0; a < count; a++) { const i = active[a]; h[i] = hn[i]; }
        this._in += came; this._out += gone; this._lost += lost; this._taken += taken;
    }

    /** 3. Velocities down the surface's slope, with the bed's friction; closed at walls and dry banks. */
    private _accelerate(): void {
        const s = this._s, dt = this._dt, g = G * dt / this.cell, fr = G * dt;
        const h = this._h, bed = s.bed, maxU = this._maxU, rough = this._rough, cell = this.cell, drag = this._drag;
        let fastest = this._fastest;
        for (let pass = 0; pass < 2; pass++) {
            const faces = pass === 0 ? this._xFaces : this._zFaces, vel = pass === 0 ? this._u : this._w;
            for (let q = 0; q < faces.length; q += 3) {
                const f = faces[q], a = faces[q + 1], c = faces[q + 2];
                const drop = (bed[c] + h[c]) - (bed[a] + h[a]);
                let v = vel[f] - g * drop;
                // Water flows only out of a cell that has some.
                const up = v > 0 ? h[a] : h[c];
                if (up < DRY) { vel[f] = 0; continue; }
                const hf = up > 0.02 ? up : 0.02;
                const root = Math.cbrt(hf);
                // Manning's n: the bed's own, or on steep ground what mountain streams measure (Jarrett):
                // 0.32·S^0.38 over R^(1/6).
                let n = 0.5 * (rough[a] + rough[c]);
                if (n >= NATURAL_BED) {
                    // S: the surface's slope across this face, to the power 3/8 by square roots.
                    const slope = (drop < 0 ? -drop : drop) / cell;
                    const quarter = Math.sqrt(Math.sqrt(slope > 1 ? 1 : slope));
                    const torrent = 0.32 * quarter * Math.sqrt(quarter) / Math.sqrt(root);
                    if (torrent > n) n = torrent;
                }
                // Implicit, as one: the bed's friction, and the drag of anything standing in either cell
                // (the face's water is half in each).
                let resist = fr * n * n * Math.abs(v) / (hf * root);
                if (drag) resist += 0.5 * (drag[a] + drag[c]) * dt * Math.abs(v);
                v /= 1 + resist;
                v = v > maxU ? maxU : v < -maxU ? -maxU : v;
                vel[f] = v;
                const speed = v < 0 ? -v : v;
                if (speed > fastest) fastest = speed;
            }
        }
        this._fastest = fastest;
    }

    private _sample(): void {
        const { nx } = this;
        const h = this._h, u = this._u, w = this._w, row = nx + 1, dt = this._dt;
        for (const i of this._active) {
            const x = i % nx, j = (i - x) / nx;
            this._sumD[i] += h[i] * dt;
            if (h[i] > DRY) {
                this._sumU[i] += 0.5 * (u[j * row + x] + u[j * row + x + 1]) * dt;
                this._sumV[i] += 0.5 * (w[j * nx + x] + w[(j + 1) * nx + x]) * dt;
            }
        }
        this._sampleTime += dt;
    }

    /**
     * The settled water as one water info grid per member, each cut from the one field: the whole field round
     * its cells (so a neighbour's water is there to filter against), `wet` only on its own cells, and the
     * shore distance measured over all the system's water, so where two members meet is no shore of either
     * and they are drawn without a gap. Call once `done`.
     */
    public results(source = 'bake'): WaterBakeOutput {
        const { nx, nz, cell } = this;
        const s = this._s;
        const n = nx * nz;
        const T = Math.max(this._sampleTime, 1e-9);
        const surface = new Float32Array(n), fu = new Float32Array(n), fv = new Float32Array(n), deep = new Float32Array(n);
        const water = new Uint8Array(n), drawn = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            if (s.kind[i] === CELL_WALL) continue;
            const depth = this._sumD[i] / T;
            // A film thinner than a finger is wet ground, not water to draw or float in.
            if (depth <= THIN) continue;
            water[i] = 1;
            deep[i] = depth;
            surface[i] = s.bed[i] + depth;
            // Held water is drawn by its own node (the sea): water for the shore distance, not drawn here.
            if (s.kind[i] === CELL_HELD) continue;
            drawn[i] = 1;
            fu[i] = this._sumU[i] / T; fv[i] = this._sumV[i] / T;
        }
        const { dist } = chamferDistance(water, nx, nz, cell);
        const near = chamferDistance(drawn, nx, nz, cell).nearestSet;
        // Foam: made where the water churns, carried downstream by the settled current, fading (bake/foam.ts).
        const foam = transportFoam({ nx, nz, cell, water: drawn, surface, depth: deep, u: fu, v: fv });
        const members = s.members.map((member, k) => {
            // The member's own cells, a few cells of the field round them.
            let x0 = nx, z0 = nz, x1 = -1, z1 = -1;
            for (let i = 0; i < n; i++) {
                if (s.owner[i] !== k + 1) continue;
                const x = i % nx, z = (i - x) / nx;
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
            }
            if (x1 < 0) { x0 = 0; z0 = 0; x1 = 0; z1 = 0; }
            const pad = 3;
            x0 = Math.max(0, x0 - pad); z0 = Math.max(0, z0 - pad); x1 = Math.min(nx - 1, x1 + pad); z1 = Math.min(nz - 1, z1 + pad);
            const cx = x1 - x0 + 1, cz = z1 - z0 + 1;
            const info0 = new Float32Array(cx * cz * 4), info1 = new Float32Array(cx * cz * 4);
            let minY = Infinity, maxY = -Infinity;
            for (let z = 0; z < cz; z++) for (let x = 0; x < cx; x++) {
                const i = (z + z0) * nx + x + x0, o = (z * cx + x) * 4;
                const k2 = water[i] ? i : near[i];
                let top = k2 >= 0 ? surface[k2] : 0;
                // Dry ground beside the water: the surface is carried on just under it, so the landscape's
                // own depth test draws the waterline where the water meets the bank, not along the grid's
                // cells (the surface is drawn a cell past its wet ones, see the water shader).
                if (!water[i] && k2 >= 0 && top > s.floor[i] - BANK_UNDER) top = s.floor[i] - BANK_UNDER;
                info0[o] = top;
                info0[o + 1] = fu[i]; info0[o + 2] = fv[i];
                info0[o + 3] = dist[i];
                info1[o] = member.waveFactor;
                info1[o + 1] = foam[i];
                info1[o + 2] = s.floor[i];
                if (drawn[i] && s.owner[i] === k + 1) {
                    info1[o + 3] = 1;
                    if (surface[i] < minY) minY = surface[i];
                    if (surface[i] > maxY) maxY = surface[i];
                }
            }
            if (!Number.isFinite(minY)) { minY = 0; maxY = 0; }
            const info: WaterInfo = {
                originX: s.originX + x0 * cell, originZ: s.originZ + z0 * cell, cell, nx: cx, nz: cz, info0, info1, minY, maxY,
                tileCells: 0, tilesX: 0, tilesZ: 0, tileWet: new Uint8Array(0), tileMinY: new Float32Array(0), tileMaxY: new Float32Array(0),
                oceanLevel: null, source,
            };
            tileWaterInfo(info);
            return { id: member.id, info };
        });
        return { members, report: this._report };
    }

    /** The water at grid cell (x, z) right now: depth and cell-centre velocity. For tests and tools. */
    public probe(x: number, z: number): { depth: number; u: number; v: number } {
        const i = z * this.nx + x, row = this.nx + 1;
        return { depth: this._h[i], u: 0.5 * (this._u[z * row + x] + this._u[z * row + x + 1]), v: 0.5 * (this._w[z * this.nx + x] + this._w[(z + 1) * this.nx + x]) };
    }
}

/** Run a whole bake at once (tests, tools). */
export function bakeWater(setup: WaterBakeSetup, source = 'bake'): WaterBakeOutput {
    const bake = new ShallowWaterBake(setup);
    while (!bake.done) bake.step(500);
    return bake.results(source);
}
