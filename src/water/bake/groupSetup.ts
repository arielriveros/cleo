import { riverColumn, waterColumnAt, type ResolvedWaterShape, type WaterColumn } from '../../physics/water/waterColumn';
import { WATER_INFO_MIN_CELL, type GroundSampler, type WaterInfo } from '../waterInfo';
import { obstacleSpan, type WaterObstacle } from './obstacles';
import {
    bakeWater, CELL_DRAIN, CELL_HELD, CELL_LEAK, CELL_WALL, CELL_WATER, DEFAULT_MANNING, riverDischarge,
    type WaterBakeMember, type WaterBakeSettle, type WaterBakeSetup,
} from './shallowWater';

// The bake's SETUP: one grid over a whole connected system of water (its members), the ground and the
// static obstacles under it, and the boundaries the solver runs between (bake/shallowWater.ts).
//
// The terrain decides where the water goes, as it does in Unreal's baked river simulation: the bed is the
// landscape (and the static colliders standing in it), and every cell in reach of a member is free to hold
// water: inside a lake's or pool's outline and a few metres round it, and along a river in a corridor some
// widths wide. Nothing walls the water in at the height it was drawn at. A river drawn across ground with
// no channel runs off downhill to the corridor's edge and is lost there, and the bake says so (carve its
// channel, or draw it where the ground runs). Only where there is no landscape at all under a body does its
// own drawn bed stand in for the ground, with its banks as walls: a pool in a room, a river on a bare scene.
//
// A lake is its BASIN, not its outline: the ground beside it that lies under its level is free for its
// water too, however roughly the outline was drawn, so the water finds every bay the outline cut off. And
// the edge of the simulated region loses water only where the ground outside it is lower than the water
// standing at it: against a bank that rises outside, the water simply stands.
//
// What starts and ends the water:
//  - a river with no member upstream rises at its head, at its drawn discharge;
//  - a river starts with the water it was drawn with, where the ground holds it: between its banks, as deep
//    as drawn and no higher than its drawn surface. From there the ground and the flow decide. (Starting dry
//    settles in the same place, after the minutes its water takes to run from its head to its mouth.)
//  - a lake or pool starts full. With a river in and a river out it is left free: it finds the level its
//    outlet gives, and the flow crosses it from one to the other. With a river out and none in, it is fed
//    what its outlets carry. With no river out it is a sink: what comes in above its level is taken away;
//  - water the system runs into but does not include (the endless sea) is held at its level;
//  - a river's end that runs into nothing drains.
//
// Pure: it reads shapes, a ground sampler and obstacles, never a scene, so tools and tests call it directly.

/** One body of a system to bake. */
export interface WaterGroupMember {
    /** The body in world space (its `id` is its Water node's). */
    body: ResolvedWaterShape;
    /** Manning's roughness of its bed. Default {@link DEFAULT_MANNING}. */
    manning?: number;
    /** A river: the ids of the water it flows from and into, members of the system or not. */
    from?: string | null;
    into?: string | null;
}

export interface WaterGroupOptions {
    /** Largest grid side, cells. Default 512. */
    maxRes?: number;
    /** Seconds to run, the last third averaged, instead of running until the water settles (tests, tools). */
    duration?: number;
    /** When the bake counts as settled (see WaterBakeSettle), over the defaults. */
    settle?: Partial<WaterBakeSettle>;
    /** Metres deep still water is simulated at most. Default {@link WATER_BAKE_DEPTH_CAP}. */
    depthCap?: number;
}

/** Metres round a lake's or pool's outline its basin is followed over the ground. */
const LAKE_REACH = 24;
/** Metres over its drawn level a lake's water may come to stand (the head its outlet needs): its basin's rim. */
const LAKE_HEAD = 0.75;
/** Metres of a river's start fed with its discharge. */
const SOURCE_LENGTH = 3;
/** Depth below which a cell counts as dry (the solver's). */
const DRY = 0.005;
/**
 * Metres deep a lake, a pool or held water is simulated at most. A gravity wave's speed, which sets the time
 * step, grows with the depth: a lake 30 m deep would make the whole bake several times as long. Its current
 * comes out the stronger for the shallower water (a slow drift from its inflow to its outlet all the same,
 * and one that can be seen to carry what floats). The result keeps the real bed.
 */
export const WATER_BAKE_DEPTH_CAP = 2;

/** Metres either side of a river's banks its water may run: the corridor the bake simulates. */
export function riverCorridor(width: number): number {
    return Math.min(40, Math.max(8, 2 * width));
}

/** The world rectangle [x0, z0, x1, z1] a body's bake can reach; null for water with nothing to bake. */
export function bodyReach(body: ResolvedWaterShape): number[] | null {
    if (body.type === 'ocean' && body.endless) return null;
    let margin = LAKE_REACH;
    if (body.type === 'river') {
        let widest = 1;
        for (const q of body.samples) widest = Math.max(widest, q.width);
        margin = riverCorridor(widest);
    }
    return [body.min[0] - margin, body.min[2] - margin, body.max[0] + margin, body.max[2] + margin];
}

/** The rectangle round every member's reach. */
export function groupReach(bodies: readonly ResolvedWaterShape[]): number[] | null {
    let out: number[] | null = null;
    for (const b of bodies) {
        const r = bodyReach(b);
        if (!r) continue;
        out = out ? [Math.min(out[0], r[0]), Math.min(out[1], r[1]), Math.max(out[2], r[2]), Math.max(out[3], r[3])] : r;
    }
    return out;
}

/**
 * The solver's grid and boundaries for the system `members`, running into `boundary` (water it joins that is
 * not part of it: the endless sea), over `ground` with `obstacles` in it.
 */
export function prepareWaterGroup(members: readonly WaterGroupMember[], boundary: readonly ResolvedWaterShape[],
                                  ground: GroundSampler | null, obstacles: readonly WaterObstacle[],
                                  options: WaterGroupOptions = {}): WaterBakeSetup {
    const bodies = members.map(m => m.body);
    const reach = groupReach(bodies);
    if (!reach) throw new Error('Nothing to bake: an endless ocean has no flow to settle.');
    const maxRes = Math.max(32, Math.min(1024, Math.round(options.maxRes ?? 512)));
    const extent = Math.max(reach[2] - reach[0], reach[3] - reach[1], 1);
    const cell = Math.max(WATER_INFO_MIN_CELL, extent / (maxRes - 5));
    // Two cells of nothing round the reach, so the free region never touches the grid's edge.
    const x0 = reach[0] - 2 * cell, z0 = reach[1] - 2 * cell;
    const nx = Math.min(maxRes, Math.ceil((reach[2] - reach[0]) / cell) + 5);
    const nz = Math.min(maxRes, Math.ceil((reach[3] - reach[1]) / cell) + 5);
    const n = nx * nz;
    const bed = new Float32Array(n), kind = new Uint8Array(n), target = new Float32Array(n).fill(NaN);
    const inflow = new Float32Array(n), owner = new Uint8Array(n);
    const free = new Uint8Array(n), grounded = new Uint8Array(n);
    /** Behind a river's head: closed, so the water that rises there runs down its course and not back up it. */
    const shut = new Uint8Array(n);
    const ids = new Set(bodies.map(b => b.id));
    /** The lake or pool whose outline holds the cell, the river whose banks do; -1 for none. */
    const inLake = new Int16Array(n).fill(-1), inBanks = new Int16Array(n).fill(-1);
    /** The nearest river's centre line, in half widths, and that river. */
    const lineDist = new Float32Array(n).fill(Infinity), lineOf = new Int16Array(n).fill(-1);
    /** Between a river's banks: its drawn surface and its drawn depth there. Cells a river's own water starts in. */
    const drawnTop = new Float32Array(n), drawnDeep = new Float32Array(n), started = new Uint8Array(n);
    const col: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: 0, waveFactor: 1 };

    // The rivers' corridors, stamped along their centre lines.
    members.forEach((m, k) => {
        const r = m.body;
        if (r.type !== 'river') return;
        const stride = Math.max(1, Math.floor(cell));
        // A river that rises (no member upstream of it) is closed behind its head.
        const head = r.samples[0];
        const rises = !!head && !(m.from && ids.has(m.from));
        const headReach = head ? head.width / 2 + riverCorridor(head.width) + cell : 0;
        for (let q = 0; q < r.samples.length; q += stride) {
            const a = r.samples[Math.min(q, r.samples.length - 1)];
            const half = Math.max(a.width / 2, 1e-3), radius = half + riverCorridor(a.width);
            const c0 = Math.max(0, Math.floor((a.x - radius - x0) / cell)), c1 = Math.min(nx - 1, Math.ceil((a.x + radius - x0) / cell));
            const r0 = Math.max(0, Math.floor((a.z - radius - z0) / cell)), r1 = Math.min(nz - 1, Math.ceil((a.z + radius - z0) / cell));
            for (let z = r0; z <= r1; z++) for (let x = c0; x <= c1; x++) {
                const wx = x0 + x * cell, wz = z0 + z * cell;
                const d = Math.hypot(wx - a.x, wz - a.z);
                if (d > radius) continue;
                const i = z * nx + x;
                if (rises) {
                    const hx = wx - head.x, hz = wz - head.z;
                    if (hx * head.tx + hz * head.tz < -0.5 * cell && hx * hx + hz * hz <= headReach * headReach) { shut[i] = 1; continue; }
                }
                free[i] = 1;
                if (d / half < lineDist[i]) { lineDist[i] = d / half; lineOf[i] = k; }
            }
        }
    });
    // The ground, and whose outline or banks each cell lies in.
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const i = z * nx + x;
        const wx = x0 + x * cell, wz = z0 + z * cell;
        const g = ground ? ground(wx, wz) : null;
        let floor = NaN;
        for (let k = 0; k < members.length && inLake[i] < 0; k++) {
            const r = members[k].body;
            if (r.type === 'river' || wx < r.min[0] || wx > r.max[0] || wz < r.min[2] || wz > r.max[2]) continue;
            if (waterColumnAt([r], wx, wz, col)) { inLake[i] = k; floor = col.floor; }
        }
        if (inLake[i] < 0 && free[i]) {
            for (let k = 0; k < members.length && inBanks[i] < 0; k++) {
                const r = members[k].body;
                if (r.type === 'river' && riverColumn(r, wx, wz, col)) { inBanks[i] = k; floor = col.floor; drawnTop[i] = col.surface; drawnDeep[i] = col.surface - col.floor; }
            }
        }
        if (inLake[i] >= 0) free[i] = 1;
        if (g !== null) { grounded[i] = 1; bed[i] = g; }
        else if (floor === floor) bed[i] = floor;
        // No landscape here and no member's own bed: nothing for water to stand on. Its banks are walls.
        else free[i] = 0;
    }
    // Each lake's and pool's basin: from the water inside its outline, out over the ground that lies under its
    // level (and the head its outlet may need), as far as its reach.
    const lakeOf = new Int16Array(n).fill(-1);
    const queue = new Int32Array(n), steps = new Int32Array(n);
    const farthest = Math.ceil(LAKE_REACH / cell);
    members.forEach((m, k) => {
        const r = m.body;
        if (r.type === 'river') return;
        const rim = r.level + LAKE_HEAD;
        let head = 0, tail = 0;
        for (let i = 0; i < n; i++) if (inLake[i] === k && grounded[i] && bed[i] < rim) { steps[i] = 0; queue[tail++] = i; }
        while (head < tail) {
            const i = queue[head++];
            if (steps[i] >= farthest) continue;
            const x = i % nx, z = (i - x) / nx;
            for (let s = 0; s < 4; s++) {
                const xx = x + (s === 0 ? -1 : s === 1 ? 1 : 0), zz = z + (s === 2 ? -1 : s === 3 ? 1 : 0);
                if (xx < 0 || xx >= nx || zz < 0 || zz >= nz) continue;
                const j = zz * nx + xx;
                if (inLake[j] >= 0 || lakeOf[j] >= 0 || !grounded[j] || shut[j] || bed[j] >= rim) continue;
                lakeOf[j] = k; free[j] = 1; steps[j] = steps[i] + 1;
                queue[tail++] = j;
            }
        }
    });
    // Whose water each free cell is: a lake's inside its outline, else a river's between its banks, else the
    // lake's whose basin it is in, else the river's whose line is nearest.
    for (let i = 0; i < n; i++) {
        if (!free[i]) continue;
        kind[i] = CELL_WATER;
        const k = inLake[i] >= 0 ? inLake[i] : inBanks[i] >= 0 ? inBanks[i] : lakeOf[i] >= 0 ? lakeOf[i] : lineOf[i];
        owner[i] = k >= 0 ? k + 1 : 0;
        // A lake starts full inside its outline; the rest of its basin it fills itself.
        if (inLake[i] >= 0) {
            const level = members[inLake[i]].body.level;
            if (level > bed[i] + DRY) target[i] = level;
        } else if (inBanks[i] >= 0) {
            // A river starts as drawn where the ground holds it.
            const deep = Math.min(drawnDeep[i], drawnTop[i] - bed[i]);
            if (deep > DRY) { target[i] = bed[i] + deep; started[i] = 1; }
        }
    }
    // The edge of the free region, where the ground carries on beyond it: water standing above the ground just
    // outside is lost there. Where that ground is higher than the water ever stands, it is a bank like any other.
    const sill = new Float32Array(n).fill(NaN);
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const i = z * nx + x;
        if (!free[i] || !grounded[i]) continue;
        let lowest = Infinity;
        const look = (k: number, inside: boolean) => {
            if (!inside) lowest = Math.min(lowest, bed[i]);
            else if (!free[k] && grounded[k] === 1 && !shut[k]) lowest = Math.min(lowest, bed[k]);
        };
        look(i - 1, x > 0); look(i + 1, x < nx - 1); look(i - nx, z > 0); look(i + nx, z < nz - 1);
        if (lowest < Infinity) { kind[i] = CELL_LEAK; sill[i] = lowest; }
    }
    // Water the system runs into without being part of it, held at its level.
    const finite = boundary.filter(b => !(b.type === 'ocean' && b.endless));
    const sea = boundary.find(b => b.type === 'ocean' && b.endless) ?? null;
    if (finite.length || sea) {
        for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
            const i = z * nx + x;
            if (!free[i]) continue;
            const wx = x0 + x * cell, wz = z0 + z * cell;
            let level = NaN;
            if (finite.length && waterColumnAt(finite, wx, wz, col)) level = col.surface;
            // The sea is what lies under its level outside the system's own lakes: a deep lake's bed below the
            // sea (a crater, a fjord's basin) is still the lake's, not a hole the sea drains it into.
            else if (sea && inLake[i] < 0 && lakeOf[i] < 0) level = sea.level;
            if (level === level && level > bed[i] + DRY) { kind[i] = CELL_HELD; target[i] = level; owner[i] = 0; started[i] = 0; }
        }
    }
    // Static obstacles: a column the obstacle fills above the water is a wall (the water goes round it);
    // one under the surface raises the bed (the water speeds over it). Two by two samples per cell.
    if (obstacles.length) {
        for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
            const i = z * nx + x;
            if (kind[i] === CELL_WALL) continue;
            // Still water has its level; a river's is taken a metre over its bed, whatever it starts with.
            const level = Number.isFinite(target[i]) && !started[i] ? target[i] : bed[i] + 1;
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
            if (walls >= 2) { kind[i] = CELL_WALL; owner[i] = 0; target[i] = NaN; }
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
    const out: WaterBakeMember[] = members.map(m => ({
        id: m.body.id, waveFactor: m.body.waveFactor, manning: Math.max(0.005, m.manning ?? DEFAULT_MANNING),
        spill: NaN, level: m.body.type === 'river' ? NaN : m.body.level,
    }));
    members.forEach((m, k) => {
        const r = m.body;
        if (r.type === 'river') {
            if (!r.samples.length) return;
            // A river that does not start in other water rises: its first metres are fed its discharge.
            const first = r.samples[0];
            if (!(m.from && ids.has(m.from)) && kind[cellOf(first.x, first.z)] !== CELL_HELD) {
                const head = r.samples.filter(q => q.dist <= SOURCE_LENGTH);
                const per = riverDischarge(first) / Math.max(1, head.length);
                for (const q of head) if (!feed(q.x, q.z, q.width / 2, per)) feed(q.x, q.z, q.width / 2 + 3 * cell, per);
            }
            // An end that runs into nothing drains, right across its corridor: the water leaves there.
            const last = r.samples[r.samples.length - 1];
            if (!m.into && kind[cellOf(last.x, last.z)] !== CELL_HELD) {
                within(last.x, last.z, last.width / 2 + riverCorridor(last.width) + cell, i => {
                    if (kind[i] !== CELL_WATER && kind[i] !== CELL_LEAK) return;
                    const ex = x0 + (i % nx) * cell - last.x, ez = z0 + Math.floor(i / nx) * cell - last.z;
                    if (ex * last.tx + ez * last.tz >= -0.5 * cell) kind[i] = CELL_DRAIN;
                });
            }
            return;
        }
        // A lake or pool: free when a river brings its water and another takes it; fed what its outlets carry
        // when none brings it; a sink at its level when none takes it.
        const outlets = members.filter(o => o.body.type === 'river' && o.from === r.id);
        const inlets = members.filter(o => o.body.type === 'river' && o.into === r.id);
        if (!outlets.length) { out[k].spill = r.level; return; }
        if (inlets.length) return;
        let q = 0;
        for (const o of outlets) if (o.body.samples.length) q += riverDischarge(o.body.samples[0]);
        const cells: number[] = [];
        for (let i = 0; i < n; i++) if (inLake[i] === k && kind[i] === CELL_WATER && Number.isFinite(target[i])) cells.push(i);
        for (const i of cells) inflow[i] += q / cells.length;
    });
    // Deep still water is simulated no deeper than the cap; the result keeps the real bed.
    const floor = bed.slice();
    const cap = Math.max(0.5, options.depthCap ?? WATER_BAKE_DEPTH_CAP);
    for (let i = 0; i < n; i++) if (Number.isFinite(target[i])) bed[i] = Math.max(bed[i], target[i] - cap);
    let flowing = false;
    for (let i = 0; i < n && !flowing; i++) flowing = inflow[i] > 0;
    const settle: WaterBakeSettle | null = options.duration !== undefined ? null : {
        tolerance: 0.02, window: 15,
        // Still water has nothing to wait for.
        minSeconds: flowing ? 30 : 5, maxSeconds: flowing ? 2400 : 60, average: flowing ? 20 : 5,
        ...options.settle,
    };
    return { originX: x0, originZ: z0, cell, nx, nz, bed, floor, kind, target, inflow, owner, sill, members: out, settle, duration: options.duration ?? 0 };
}

/**
 * One body baked on its own, joined to `joined` (the water it flows from and into, held at its level): the
 * setup for a lone body, and for tools and tests that resolve shapes themselves.
 */
export function prepareWaterBake(body: ResolvedWaterShape, joined: readonly ResolvedWaterShape[], ground: GroundSampler | null,
                                 obstacles: readonly WaterObstacle[], options: WaterGroupOptions & { manning?: number } = {}): WaterBakeSetup {
    return prepareWaterGroup([{ body, manning: options.manning }], joined, ground, obstacles, options);
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
    return bakeWater(setup).members[0].info;
}
