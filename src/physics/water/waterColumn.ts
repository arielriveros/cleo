// The water over a point: which of a Water node's (resolved, world-space) shapes is there, its resting
// surface, bed, flow and distance to shore. Read by the physics step on either thread, by the node and by
// the renderer's CPU side. The shapes are resolved by water/waterShapes.ts on the main thread; this half
// only queries them, so it stays inside src/physics (the worker bundle imports nothing else).

export type WaterShapeKind = 'box' | 'lake' | 'river' | 'ocean';

/** One sample along a resolved river: world centre-line surface point plus what the river is like there. */
export interface RiverSample { x: number; y: number; z: number; dist: number; width: number; depth: number; speed: number; tx: number; tz: number; }

/**
 * A shape in world space, everything a query needs precomputed. Plain data (no class), so it crosses to the
 * physics worker by structured clone.
 */
export interface ResolvedWaterShape {
    id: string;
    type: WaterShapeKind;
    priority: number;
    /** List order, the tie-break when priorities match (later wins, as it is drawn on top). */
    order: number;
    min: [number, number, number];
    max: [number, number, number];
    /** box / lake / ocean: the resting surface height. */
    level: number;
    /** box: the floor. lake / ocean: level - depth. */
    floor: number;
    /** lake: the smoothed outline, flat [x0, z0, ...]. */
    outline: number[];
    /** river: samples along the centre line, about one per metre. */
    samples: RiverSample[];
    /** river: segment buckets over XZ, `cell` metres square, for fast nearest-segment lookups. */
    cell: number;
    grid: Record<string, number[]>;
    /** ocean with extent 0. */
    endless: boolean;
    /** How much of the node's waves this shape carries: rivers run nearly flat, open water takes all. */
    waveFactor: number;
}

/** What the water is like over one XZ point. */
export interface WaterColumn {
    /** Index into the resolved list. */
    shape: number;
    /** Resting surface height (no waves). */
    surface: number;
    /** Bed height under the point, from the shape alone (the landscape may be higher). */
    floor: number;
    /** Water velocity, m/s, in world XZ. */
    flowX: number;
    flowZ: number;
    /** Metres to the shape's edge (its shore), inward positive. Infinity for an endless ocean. */
    edge: number;
    /** The shape's share of the node's waves (ResolvedWaterShape.waveFactor). */
    waveFactor: number;
}

export function bucketKey(ix: number, iz: number): string { return ix + ',' + iz; }

/**
 * Closest point to (px, pz) on the XZ segment a→b: `out` = [t along the segment 0..1, squared distance].
 * The plan-view test water and river splines are measured with.
 */
export function closestOnSegmentXZ(px: number, pz: number, ax: number, az: number, bx: number, bz: number,
                                   out: number[] = [0, 0]): number[] {
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 1e-12 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + dx * t - px, cz = az + dz * t - pz;
    out[0] = t; out[1] = cx * cx + cz * cz;
    return out;
}

/** Whether (px, pz) is inside the closed XZ polygon `xz` (flat [x0, z0, x1, z1, ...]); even-odd rule. */
export function pointInPolygonXZ(px: number, pz: number, xz: ArrayLike<number>): boolean {
    const n = xz.length >> 1;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = xz[i * 2], zi = xz[i * 2 + 1], xj = xz[j * 2], zj = xz[j * 2 + 1];
        if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

/** Squared XZ distance from (px, pz) to the closed polygon's outline (flat [x0, z0, ...]). */
export function polygonEdgeDistance2XZ(px: number, pz: number, xz: ArrayLike<number>): number {
    const n = xz.length >> 1;
    let best = Infinity;
    const tmp = [0, 0];
    for (let i = 0, j = n - 1; i < n; j = i++) {
        closestOnSegmentXZ(px, pz, xz[j * 2], xz[j * 2 + 1], xz[i * 2], xz[i * 2 + 1], tmp);
        if (tmp[1] < best) best = tmp[1];
    }
    return best;
}

const _seg = [0, 0];

/** The river's column at (x, z), or false when the point is outside its banks. */
export function riverColumn(r: ResolvedWaterShape, x: number, z: number, col: WaterColumn): boolean {
    const bucket = r.grid[bucketKey(Math.floor(x / r.cell), Math.floor(z / r.cell))];
    if (!bucket) return false;
    let best = Infinity, bi = -1, bt = 0;
    for (const i of bucket) {
        const a = r.samples[i], b = r.samples[i + 1];
        closestOnSegmentXZ(x, z, a.x, a.z, b.x, b.z, _seg);
        if (_seg[1] < best) { best = _seg[1]; bi = i; bt = _seg[0]; }
    }
    if (bi < 0) return false;
    const a = r.samples[bi], b = r.samples[bi + 1];
    const half = (a.width + (b.width - a.width) * bt) / 2;
    const d = Math.sqrt(best);
    if (d > half) return false;
    const u = half > 0 ? d / half : 0;
    const depth = a.depth + (b.depth - a.depth) * bt;
    const speed = a.speed + (b.speed - a.speed) * bt;
    let tx = a.tx + (b.tx - a.tx) * bt, tz = a.tz + (b.tz - a.tz) * bt;
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    // A parabolic channel: deepest and fastest on the centre line, shallow and slow at the banks.
    const profile = 1 - u * u;
    col.surface = a.y + (b.y - a.y) * bt;
    col.floor = col.surface - depth * Math.max(0.15, profile);
    const v = speed * (0.35 + 0.65 * profile);
    col.flowX = tx * v; col.flowZ = tz * v;
    col.edge = half - d;
    return true;
}

/** Fills `col` for shape `r` at (x, z); false when the point is not over it. */
function shapeColumn(r: ResolvedWaterShape, x: number, z: number, col: WaterColumn): boolean {
    if (x < r.min[0] || x > r.max[0] || z < r.min[2] || z > r.max[2]) return false;
    col.flowX = 0; col.flowZ = 0;
    if (r.type === 'river') return riverColumn(r, x, z, col);
    col.surface = r.level; col.floor = r.floor;
    if (r.type === 'lake') {
        if (!pointInPolygonXZ(x, z, r.outline)) return false;
        col.edge = Math.sqrt(polygonEdgeDistance2XZ(x, z, r.outline));
        return true;
    }
    if (r.type === 'ocean' && r.endless) { col.edge = Infinity; return true; }
    col.edge = Math.min(x - r.min[0], r.max[0] - x, z - r.min[2], r.max[2] - z);
    return true;
}

const _col: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: 0, waveFactor: 1 };

/**
 * The water over (x, z): the highest-priority shape there (later in the list on a tie), or null. `out`
 * is filled and returned; pass one in to avoid allocating.
 */
export function waterColumnAt(shapes: readonly ResolvedWaterShape[], x: number, z: number,
                              out: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: 0, waveFactor: 1 }): WaterColumn | null {
    let found = false, bestP = -Infinity, bestO = -1;
    for (let i = 0; i < shapes.length; i++) {
        const r = shapes[i];
        if (r.priority < bestP || (r.priority === bestP && r.order < bestO)) continue;
        if (!shapeColumn(r, x, z, _col)) continue;
        found = true; bestP = r.priority; bestO = r.order;
        out.shape = i; out.surface = _col.surface; out.floor = _col.floor;
        out.flowX = _col.flowX; out.flowZ = _col.flowZ; out.edge = _col.edge; out.waveFactor = r.waveFactor;
    }
    return found ? out : null;
}

