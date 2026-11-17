import { waterColumnAt, type ResolvedWaterShape, type WaterColumn } from '../../physics/water/waterColumn';
import { buildWaterInfo, chamferDistance, handOverWaterInfo, tileWaterInfo, type GroundSampler, type WaterInfo } from '../waterInfo';

// The water BAKE: a shallow-water simulation (the virtual-pipes model, Mei, Decaudin & Hu 2007) run over a
// Water node's shapes and the ground under them until the water settles, its velocity averaged over the
// settled stretch. What comes out is a water info grid (water/waterInfo.ts) like the analytic one, but with
// the water where it actually runs: currents bending round the banks, eddies behind a bend, the water
// piling up and speeding over a drop, foam where it tumbles. The surface renderer reads it as it reads the
// analytic grid.
//
// Boundaries:
//  - outside every shape is a WALL: the shapes say where water may be, the ground says how deep;
//  - a river's first few metres are its SOURCE, held at the river's surface, so water keeps coming;
//  - a lake, box or ocean is relaxed toward its own level, so it takes what the rivers bring and keeps its
//    level, with currents free to form inside it;
//  - the grid's edge drains.
//
// Pure and deterministic (same input, same bits), on the CPU so it bakes the same on every backend; the
// caller runs it in slices (`ShallowWaterBake.step`) to keep the editor responsive.

const G = 9.81;
/** Depth below which a cell counts as dry. */
const DRY = 0.01;
/** Metres of a river's start held at its surface. */
const SOURCE_LENGTH = 3;

export interface ShallowWaterOptions {
    /** Largest grid side, cells. The bake is coarser than the analytic grid: it is many steps over it. */
    maxRes?: number;
    /** Seconds of water to simulate; default: long enough for the slowest river to run its length twice. */
    duration?: number;
    /**
     * Water the baked body joins and gives way to (a river's lake): simulated with it, as where its water
     * goes, but handed over in the result (see waterInfo.ts handOverWaterInfo), so only the body is drawn.
     */
    handOver?: readonly ResolvedWaterShape[];
}

/** A bake in progress: call `step(n)` until `done`, then `result()`. */
export class ShallowWaterBake {
    public readonly nx: number;
    public readonly nz: number;
    public readonly cell: number;
    public readonly steps: number;
    public stepped = 0;
    private readonly _base: WaterInfo;
    private readonly _bed: Float32Array;
    private readonly _d: Float32Array;
    private readonly _fl: Float32Array; private readonly _fr: Float32Array;
    private readonly _ft: Float32Array; private readonly _fb: Float32Array;
    /** 0 wall, 1 free water, 2 source (held at `_target`), 3 relaxed to `_target`. */
    private readonly _kind: Uint8Array;
    private readonly _target: Float32Array;
    private readonly _sumU: Float32Array; private readonly _sumV: Float32Array; private readonly _sumD: Float32Array;
    private _samples = 0;
    private readonly _dt: number;
    private readonly _handOver: readonly ResolvedWaterShape[];
    private readonly _ground: GroundSampler | null;

    constructor(shapes: readonly ResolvedWaterShape[], ground: GroundSampler | null, options: ShallowWaterOptions = {}) {
        this._handOver = options.handOver ?? [];
        this._ground = ground;
        const all = [...shapes, ...this._handOver.filter(h => !(h.type === 'ocean' && h.endless))];
        const base = buildWaterInfo(all, ground, { maxRes: options.maxRes ?? 256, minCell: 0.25 });
        if (!base) throw new Error('Nothing to bake: the water has no finite shape.');
        shapes = all;
        this._base = base;
        const nx = this.nx = base.nx, nz = this.nz = base.nz, cell = this.cell = base.cell;
        const n = nx * nz;
        this._bed = new Float32Array(n); this._d = new Float32Array(n); this._target = new Float32Array(n);
        this._fl = new Float32Array(n); this._fr = new Float32Array(n); this._ft = new Float32Array(n); this._fb = new Float32Array(n);
        this._kind = new Uint8Array(n);
        this._sumU = new Float32Array(n); this._sumV = new Float32Array(n); this._sumD = new Float32Array(n);
        const col: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: 0, waveFactor: 1 };
        let maxDepth = 0.1, slowest = Infinity, longest = 0;
        for (const s of shapes) if (s.type === 'river' && s.samples.length) {
            longest = Math.max(longest, s.samples[s.samples.length - 1].dist);
            for (const q of s.samples) slowest = Math.min(slowest, Math.max(0.2, q.speed));
        }
        for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
            const i = z * nx + x;
            const wx = base.originX + x * cell, wz = base.originZ + z * cell;
            const bed = base.info1[i * 4 + 2];
            this._bed[i] = bed;
            const c = waterColumnAt(shapes, wx, wz, col);
            const edgeCell = x === 0 || z === 0 || x === nx - 1 || z === nz - 1;
            if (!c || edgeCell) { this._kind[i] = 0; continue; }
            const r = shapes[c.shape];
            this._kind[i] = 1;
            this._target[i] = c.surface;
            if (r.type !== 'river') this._kind[i] = 3;
            else {
                // Within the first metres of the river: its source.
                const near = r.samples.find(q => (q.x - wx) * (q.x - wx) + (q.z - wz) * (q.z - wz) < (q.width * 0.6) * (q.width * 0.6));
                if (near && near.dist <= SOURCE_LENGTH) this._kind[i] = 2;
            }
            // Start from the analytic water, so the bake begins near where it will settle.
            const d = Math.max(0, c.surface - bed);
            this._d[i] = d;
            maxDepth = Math.max(maxDepth, d);
        }
        // CFL: a wave crosses a cell in no less than four steps.
        this._dt = Math.min(0.05, 0.25 * cell / Math.sqrt(G * maxDepth));
        const duration = options.duration ?? Math.min(240, Math.max(20, Number.isFinite(slowest) ? 2 * longest / slowest : 30));
        this.steps = Math.max(100, Math.min(20000, Math.ceil(duration / this._dt)));
    }

    public get done(): boolean { return this.stepped >= this.steps; }
    public get progress(): number { return Math.min(1, this.stepped / this.steps); }

    /** Advance up to `count` steps. */
    public step(count: number): void {
        const { nx, nz, cell } = this;
        const dt = this._dt, k = dt * G * cell;
        const bed = this._bed, d = this._d, fl = this._fl, fr = this._fr, ft = this._ft, fb = this._fb;
        const kind = this._kind, target = this._target;
        const area = cell * cell;
        const end = Math.min(this.steps, this.stepped + count);
        // The last third is the settled stretch whose velocity is averaged.
        const averageFrom = Math.floor(this.steps * 2 / 3);
        for (; this.stepped < end; this.stepped++) {
            // 1. Outflow through each pipe, driven by the head difference, scaled so no cell drains below 0.
            for (let z = 1; z < nz - 1; z++) for (let x = 1; x < nx - 1; x++) {
                const i = z * nx + x;
                if (!kind[i]) continue;
                const h = bed[i] + d[i];
                const damp = 0.9995;
                fl[i] = kind[i - 1] ? Math.max(0, fl[i] * damp + k * (h - bed[i - 1] - d[i - 1])) : 0;
                fr[i] = kind[i + 1] ? Math.max(0, fr[i] * damp + k * (h - bed[i + 1] - d[i + 1])) : 0;
                ft[i] = kind[i - nx] ? Math.max(0, ft[i] * damp + k * (h - bed[i - nx] - d[i - nx])) : 0;
                fb[i] = kind[i + nx] ? Math.max(0, fb[i] * damp + k * (h - bed[i + nx] - d[i + nx])) : 0;
                const out = (fl[i] + fr[i] + ft[i] + fb[i]) * dt;
                if (out > 0) {
                    const s = Math.min(1, d[i] * area / out);
                    fl[i] *= s; fr[i] *= s; ft[i] *= s; fb[i] *= s;
                }
            }
            // 2. Depth from the net flow; boundaries; velocity for the average.
            const sample = this.stepped >= averageFrom;
            for (let z = 1; z < nz - 1; z++) for (let x = 1; x < nx - 1; x++) {
                const i = z * nx + x;
                if (!kind[i]) continue;
                const inflow = fr[i - 1] + fl[i + 1] + fb[i - nx] + ft[i + nx];
                const outflow = fl[i] + fr[i] + ft[i] + fb[i];
                const before = d[i];
                d[i] = Math.max(0, d[i] + dt * (inflow - outflow) / area);
                if (kind[i] === 2) d[i] = Math.max(0, target[i] - bed[i]);
                else if (kind[i] === 3) d[i] += (Math.max(0, target[i] - bed[i]) - d[i]) * 0.02;
                if (sample) {
                    const dm = (before + d[i]) / 2;
                    if (dm > DRY) {
                        // Flux through the cell, both ways along each axis, over the water's cross-section.
                        this._sumU[i] += (fr[i - 1] - fl[i] + fr[i] - fl[i + 1]) / 2 / (cell * dm);
                        this._sumV[i] += (fb[i - nx] - ft[i] + fb[i] - ft[i + nx]) / 2 / (cell * dm);
                    }
                    this._sumD[i] += d[i];
                }
            }
            if (sample) this._samples++;
        }
    }

    /** The settled water as a water info grid. Call once `done`. */
    public result(id = 'bake'): WaterInfo {
        const { nx, nz, cell } = this;
        const n = nx * nz;
        const base = this._base;
        const info0 = new Float32Array(n * 4), info1 = new Float32Array(n * 4);
        const wet = new Uint8Array(n);
        const m = Math.max(1, this._samples);
        for (let i = 0; i < n; i++) {
            const depth = this._sumD[i] / m;
            info1[i * 4] = base.info1[i * 4];
            info1[i * 4 + 2] = this._bed[i];
            if (!this._kind[i] || depth <= DRY) continue;
            wet[i] = 1;
            info0[i * 4] = this._bed[i] + depth;
            // Clamp: a cell that barely holds water reports flux over almost no depth.
            const u = this._sumU[i] / m, v = this._sumV[i] / m;
            const s = Math.hypot(u, v), cap = 6;
            info0[i * 4 + 1] = s > cap ? u * cap / s : u;
            info0[i * 4 + 2] = s > cap ? v * cap / s : v;
            info1[i * 4 + 3] = 1;
        }
        // Shore distance, and dry cells taking the nearest wet cell's surface.
        const { dist, nearestSet } = chamferDistance(wet, nx, nz, cell);
        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < n; i++) {
            info0[i * 4 + 3] = dist[i];
            if (wet[i]) { minY = Math.min(minY, info0[i * 4]); maxY = Math.max(maxY, info0[i * 4]); continue; }
            const k = nearestSet[i];
            if (k >= 0) { info0[i * 4] = info0[k * 4]; info1[i * 4] = info1[k * 4]; }
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
            originX: base.originX, originZ: base.originZ, cell, nx, nz, info0, info1, minY, maxY,
            tileCells: 0, tilesX: 0, tilesZ: 0, tileWet: new Uint8Array(0), tileMinY: new Float32Array(0), tileMaxY: new Float32Array(0),
            oceanLevel: base.oceanLevel, source: id,
        };
        if (this._handOver.length) handOverWaterInfo(out, this._handOver, this._ground);
        else tileWaterInfo(out);
        return out;
    }
}

/** Run a whole bake at once (tests, tools). */
export function bakeShallowWater(shapes: readonly ResolvedWaterShape[], ground: GroundSampler | null, options?: ShallowWaterOptions): WaterInfo {
    const bake = new ShallowWaterBake(shapes, ground, options);
    while (!bake.done) bake.step(500);
    return bake.result();
}
