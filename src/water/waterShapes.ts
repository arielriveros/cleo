import { Spline3, closedSplineXZ, finiteOr, type Vec3Tuple } from '../core/math';
import {
    bucketKey, riverColumn, type ResolvedWaterShape, type WaterColumn,
} from '../physics/water/waterColumn';

export {
    waterColumnAt, type ResolvedWaterShape, type RiverSample, type WaterColumn,
} from '../physics/water/waterColumn';

// The shapes a Water node is made of, as plain data, and the geometry queries over them: where the water
// is, how high its surface rests, how deep it is and which way it flows. Shared by the node, the physics
// worker (which has no scene) and the renderer, so all three agree on where the water is.
//
// A LEAF apart from core/math: no scene, no graphics.

export type WaterShapeType = 'box' | 'lake' | 'river' | 'ocean';

/** One control point of a river: where its surface runs, and how wide, deep and fast it is there. */
export interface WaterPoint {
    /** Node-local position of the SURFACE at the river's centre line. */
    pos: [number, number, number];
    /** Metres, bank to bank. */
    width: number;
    /** Metres, surface to bed at the centre line. */
    depth: number;
    /** Metres per second, downstream. */
    flowSpeed: number;
}

/** How a shape digs its bed into the landscape (only when `enabled`). */
export interface WaterCarve {
    enabled: boolean;
    /** Metres the bank slopes over, beyond the water's edge. */
    bankWidth: number;
    /** Metres dug below the water's own depth (0 = the bed is exactly `depth` down). */
    extraDepth: number;
}

/** Which shape a river's start and end run into (shape ids), so its surface meets theirs. */
export interface WaterConnect { start: string | null; end: string | null; }

/**
 * One shape of a Water node, in the node's local units (it scales with the node, and moves with it;
 * rotation is ignored, water stays level).
 *
 *  - `box`: a level block of water `size` big, centred on `offset`; the top face is the surface.
 *  - `lake`: a level surface at `offset[1]` inside the smooth closed outline through `points`, `depth` deep.
 *  - `river`: an open spline through `points`, each with its own width, depth and flow speed.
 *  - `ocean`: a level surface at `offset[1]` reaching `extent` metres each way (0 = endless), `depth` deep.
 */
export interface WaterShape {
    id: string;
    type: WaterShapeType;
    name: string;
    offset: [number, number, number];
    size: [number, number, number];
    points: WaterPoint[];
    depth: number;
    extent: number;
    /** Water material asset (id); null = the node's own. */
    materialId: string | null;
    /** Where two shapes overlap, the higher priority's water is the one there. */
    priority: number;
    carve: WaterCarve;
    connect: WaterConnect;
}

export const WATER_SHAPE_TYPES: readonly WaterShapeType[] = ['river', 'lake', 'box', 'ocean'];

let _idCounter = 0;
/** A short id unique within a node (shape ids only need to be unique among siblings). */
export function newWaterShapeId(): string {
    _idCounter = (_idCounter + 1) % 1679616;
    return `w${Date.now().toString(36).slice(-5)}${_idCounter.toString(36)}`;
}

const vec3Or = (v: unknown, d: [number, number, number]): [number, number, number] =>
    Array.isArray(v) ? [finiteOr(v[0], d[0]), finiteOr(v[1], d[1]), finiteOr(v[2], d[2])] : [...d] as [number, number, number];

/** A point with every field present and in range. */
export function normaliseWaterPoint(p: any, fallback?: Partial<WaterPoint>): WaterPoint {
    return {
        pos: vec3Or(p?.pos, fallback?.pos ?? [0, 0, 0]),
        width: Math.max(0.1, finiteOr(p?.width, fallback?.width ?? 4)),
        depth: Math.max(0.05, finiteOr(p?.depth, fallback?.depth ?? 1)),
        flowSpeed: Math.max(0, finiteOr(p?.flowSpeed, fallback?.flowSpeed ?? 1)),
    };
}

/** Default river: a gentle 30 m run down the node's +Z, 1 m of drop. */
const RIVER_POINTS: WaterPoint[] = [
    { pos: [0, 1, -15], width: 4, depth: 1, flowSpeed: 1.2 },
    { pos: [0, 0.5, 0], width: 5, depth: 1.2, flowSpeed: 1 },
    { pos: [0, 0, 15], width: 6, depth: 1.4, flowSpeed: 0.8 },
];

/** Default lake: an oval about 24 × 16 m. */
const LAKE_POINTS: WaterPoint[] = [
    [12, 0, 0], [6, 0, 7], [-6, 0, 8], [-12, 0, 0], [-6, 0, -7], [6, 0, -8],
].map(pos => ({ pos: pos as [number, number, number], width: 1, depth: 1, flowSpeed: 0 }));

/** A shape of `type` with every field filled from `json` (missing or broken values take the defaults). */
export function normaliseWaterShape(json: any, type?: WaterShapeType): WaterShape {
    const t: WaterShapeType = WATER_SHAPE_TYPES.includes(json?.type) ? json.type : (type ?? 'box');
    const defaults = t === 'river' ? RIVER_POINTS : t === 'lake' ? LAKE_POINTS : [];
    const rawPoints = Array.isArray(json?.points) ? json.points : defaults;
    const points = rawPoints.map((p: any) => normaliseWaterPoint(p));
    const size = vec3Or(json?.size, [10, 2, 10]).map(Math.abs) as [number, number, number];
    const carve = json?.carve ?? {};
    const connect = json?.connect ?? {};
    return {
        id: typeof json?.id === 'string' && json.id ? json.id : newWaterShapeId(),
        type: t,
        name: typeof json?.name === 'string' ? json.name : '',
        offset: vec3Or(json?.offset, [0, 0, 0]),
        size: [Math.max(0.01, size[0]), Math.max(0.01, size[1]), Math.max(0.01, size[2])],
        points: t === 'river' && points.length < 2 ? RIVER_POINTS.map(p => normaliseWaterPoint(p))
            : t === 'lake' && points.length < 3 ? LAKE_POINTS.map(p => normaliseWaterPoint(p)) : points,
        depth: Math.max(0.05, finiteOr(json?.depth, t === 'ocean' ? 50 : 3)),
        extent: Math.max(0, finiteOr(json?.extent, 0)),
        materialId: typeof json?.materialId === 'string' && json.materialId ? json.materialId : null,
        priority: Math.round(finiteOr(json?.priority, t === 'river' ? 1 : 0)),
        carve: {
            enabled: !!carve.enabled,
            bankWidth: Math.max(0, finiteOr(carve.bankWidth, 3)),
            extraDepth: Math.max(0, finiteOr(carve.extraDepth, 0)),
        },
        connect: {
            start: typeof connect.start === 'string' && connect.start ? connect.start : null,
            end: typeof connect.end === 'string' && connect.end ? connect.end : null,
        },
    };
}

/** A deep copy (shapes are edited by replacing the list, as collider shapes are). */
export function cloneWaterShape(s: WaterShape): WaterShape {
    return normaliseWaterShape(JSON.parse(JSON.stringify(s)));
}

// ---------------------------------------------------------------------------------------------------
// Resolved shapes: world space, connections applied, ready to query
// ---------------------------------------------------------------------------------------------------

/** Where a node puts its shapes: translation and per-axis scale (rotation is ignored). */
export interface WaterFrame { position: readonly number[]; scale: readonly number[]; }

/** Shape-local → world. */
function toWorld(frame: WaterFrame, p: readonly number[]): Vec3Tuple {
    return [
        frame.position[0] + p[0] * frame.scale[0],
        frame.position[1] + p[1] * frame.scale[1],
        frame.position[2] + p[2] * frame.scale[2],
    ];
}

const RIVER_SPACING = 1;
/** Rivers carry this share of the node's waves: a chop, not a swell. */
export const RIVER_WAVE_FACTOR = 0.15;

/** The surface level a lake / box / ocean rests at, in world space. */
function levelOf(shape: WaterShape, frame: WaterFrame): number {
    if (shape.type === 'box') return frame.position[1] + (shape.offset[1] + shape.size[1] / 2) * frame.scale[1];
    return frame.position[1] + shape.offset[1] * frame.scale[1];
}

/** The surface of shape `id` over (x, z), for a river end joining it; undefined when unknown. */
type LevelOf = (id: string, x: number, z: number) => number | undefined;

function resolveRiver(shape: WaterShape, frame: WaterFrame, levelAt: LevelOf, out: ResolvedWaterShape): void {
    const sx = Math.abs(frame.scale[0]), sz = Math.abs(frame.scale[2]), sy = Math.abs(frame.scale[1]);
    const lateral = (sx + sz) / 2;
    const raw = shape.points.map(p => ({ ...p, pos: toWorld(frame, [p.pos[0] + shape.offset[0], p.pos[1] + shape.offset[1], p.pos[2] + shape.offset[2]]) }));
    // A connected end takes the surface of what it flows into (or out of), so the two meet.
    if (raw.length && shape.connect.start) {
        const q = raw[0].pos, l = levelAt(shape.connect.start, q[0], q[2]);
        if (l !== undefined) q[1] = l;
    }
    if (raw.length && shape.connect.end) {
        const q = raw[raw.length - 1].pos, l = levelAt(shape.connect.end, q[0], q[2]);
        if (l !== undefined) q[1] = l;
    }
    // Spline3 drops consecutive duplicates; drop the same ones here so control indices line up.
    const kept = raw.filter((p, i) => i === 0 || Math.hypot(p.pos[0] - raw[i - 1].pos[0], p.pos[1] - raw[i - 1].pos[1], p.pos[2] - raw[i - 1].pos[2]) > 1e-6);
    if (kept.length < 2) return;
    const spline = new Spline3(kept.map(p => p.pos));
    const total = spline.length;
    const controlDist = kept.map((_, i) => spline.distanceAtPoint(i));
    const count = Math.max(2, Math.min(8192, Math.ceil(total / RIVER_SPACING) + 1));
    const p: Vec3Tuple = [0, 0, 0], t: Vec3Tuple = [0, 0, 0];
    let seg = 0;
    let maxWidth = 0;
    for (let i = 0; i < count; i++) {
        const d = total * i / (count - 1);
        while (seg < kept.length - 2 && d > controlDist[seg + 1]) seg++;
        const span = controlDist[seg + 1] - controlDist[seg];
        const f = span > 1e-9 ? Math.min(1, Math.max(0, (d - controlDist[seg]) / span)) : 0;
        // Smoothstep between control points, so width and depth ease rather than kink.
        const s = f * f * (3 - 2 * f);
        const a = kept[seg], b = kept[seg + 1];
        spline.pointAtDistance(d, p);
        spline.tangentAt(total > 0 ? d / total : 0, t);
        const tl = Math.hypot(t[0], t[2]) || 1;
        const width = (a.width + (b.width - a.width) * s) * lateral;
        maxWidth = Math.max(maxWidth, width);
        out.samples.push({
            x: p[0], y: p[1], z: p[2], dist: d, width,
            depth: (a.depth + (b.depth - a.depth) * s) * sy,
            speed: a.flowSpeed + (b.flowSpeed - a.flowSpeed) * s,
            tx: t[0] / tl, tz: t[2] / tl,
        });
    }
    const half = maxWidth / 2;
    let floor = Infinity, top = -Infinity;
    out.min = [Infinity, Infinity, Infinity]; out.max = [-Infinity, -Infinity, -Infinity];
    for (const q of out.samples) {
        out.min[0] = Math.min(out.min[0], q.x - half); out.max[0] = Math.max(out.max[0], q.x + half);
        out.min[2] = Math.min(out.min[2], q.z - half); out.max[2] = Math.max(out.max[2], q.z + half);
        floor = Math.min(floor, q.y - q.depth); top = Math.max(top, q.y);
    }
    out.min[1] = floor; out.max[1] = top;
    out.level = top; out.floor = floor;
    // Bucket every segment into the cells its widened box touches.
    out.cell = Math.max(4, maxWidth * 2);
    for (let i = 0; i + 1 < out.samples.length; i++) {
        const a = out.samples[i], b = out.samples[i + 1];
        const r = Math.max(a.width, b.width) / 2;
        const x0 = Math.floor((Math.min(a.x, b.x) - r) / out.cell), x1 = Math.floor((Math.max(a.x, b.x) + r) / out.cell);
        const z0 = Math.floor((Math.min(a.z, b.z) - r) / out.cell), z1 = Math.floor((Math.max(a.z, b.z) + r) / out.cell);
        for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
            (out.grid[bucketKey(ix, iz)] ??= []).push(i);
        }
    }
}

/**
 * The node's shapes in world space, with connections applied (a river end that runs into a lake takes the
 * lake's level). Order is kept: `order` is the index in `shapes`.
 */
export function resolveWaterShapes(shapes: readonly WaterShape[], frame: WaterFrame): ResolvedWaterShape[] {
    const levels = new Map<string, number>();
    for (const s of shapes) if (s.type !== 'river') levels.set(s.id, levelOf(s, frame));
    // A river joining another river takes that river's surface where they meet, so rivers resolve in
    // dependency order: one whose target is a river not yet resolved waits for it (a cycle just ignores
    // the joins that close it).
    const rivers = new Map<string, ResolvedWaterShape>();
    const col: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: 0, waveFactor: 1 };
    const levelAt: LevelOf = (id, x, z) => {
        const level = levels.get(id);
        if (level !== undefined) return level;
        const r = rivers.get(id);
        if (!r) return undefined;
        // The nearest point of the other river's centre line, wherever the end lands.
        let best = Infinity, y: number | undefined;
        for (const q of r.samples) {
            const d = (q.x - x) * (q.x - x) + (q.z - z) * (q.z - z);
            if (d < best) { best = d; y = q.y; }
        }
        return riverColumn(r, x, z, col) ? col.surface : y;
    };
    const out: (ResolvedWaterShape | null)[] = shapes.map(() => null);
    const sx = Math.abs(frame.scale[0]), sy = Math.abs(frame.scale[1]), sz = Math.abs(frame.scale[2]);
    const resolveOne = (shape: WaterShape, order: number): void => {
        const r: ResolvedWaterShape = {
            id: shape.id, type: shape.type, priority: shape.priority, order,
            min: [0, 0, 0], max: [0, 0, 0], level: 0, floor: 0, outline: [], samples: [], cell: 1, grid: {}, endless: false,
            waveFactor: shape.type === 'river' ? RIVER_WAVE_FACTOR : 1,
        };
        if (shape.type === 'box') {
            const c = toWorld(frame, shape.offset);
            const h = [shape.size[0] * sx / 2, shape.size[1] * sy / 2, shape.size[2] * sz / 2];
            r.min = [c[0] - h[0], c[1] - h[1], c[2] - h[2]];
            r.max = [c[0] + h[0], c[1] + h[1], c[2] + h[2]];
            r.level = r.max[1]; r.floor = r.min[1];
        } else if (shape.type === 'lake') {
            const pts = shape.points.map(p => toWorld(frame, [p.pos[0] + shape.offset[0], 0, p.pos[2] + shape.offset[2]]));
            r.outline = closedSplineXZ(pts, 1);
            r.level = levelOf(shape, frame);
            r.floor = r.level - shape.depth * sy;
            r.min = [Infinity, r.floor, Infinity]; r.max = [-Infinity, r.level, -Infinity];
            for (let i = 0; i < r.outline.length; i += 2) {
                r.min[0] = Math.min(r.min[0], r.outline[i]); r.max[0] = Math.max(r.max[0], r.outline[i]);
                r.min[2] = Math.min(r.min[2], r.outline[i + 1]); r.max[2] = Math.max(r.max[2], r.outline[i + 1]);
            }
        } else if (shape.type === 'ocean') {
            const c = toWorld(frame, shape.offset);
            r.level = c[1]; r.floor = c[1] - shape.depth * sy;
            r.endless = !(shape.extent > 0);
            const e = r.endless ? 1e7 : shape.extent;
            r.min = [c[0] - e * sx, r.floor, c[2] - e * sz];
            r.max = [c[0] + e * sx, r.level, c[2] + e * sz];
        } else {
            resolveRiver(shape, frame, levelAt, r);
            if (!r.samples.length) return;
            rivers.set(shape.id, r);
        }
        out[order] = r;
    };
    const ids = new Set(shapes.map(s => s.id));
    const done = new Set<string>();
    const pending = shapes.map((s, i) => ({ s, i })).filter(({ s, i }) => {
        if (s.type !== 'river') { resolveOne(s, i); done.add(s.id); return false; }
        return true;
    });
    const waitsOn = (s: WaterShape) => [s.connect.start, s.connect.end]
        .filter((id): id is string => !!id && ids.has(id) && id !== s.id && !done.has(id));
    while (pending.length) {
        let k = pending.findIndex(({ s }) => waitsOn(s).length === 0);
        if (k < 0) k = 0;   // a cycle: resolve the first, its unresolved joins ignored
        const [{ s, i }] = pending.splice(k, 1);
        resolveOne(s, i);
        done.add(s.id);
    }
    return out.filter((r): r is ResolvedWaterShape => r !== null);
}

/** World box around every shape (endless oceans included, so it can be huge). Null with no shapes. */
export function waterShapesBounds(shapes: readonly ResolvedWaterShape[]): { min: [number, number, number]; max: [number, number, number] } | null {
    if (!shapes.length) return null;
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const s of shapes) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], s.min[a]); max[a] = Math.max(max[a], s.max[a]); }
    return { min, max };
}

/** Rough open-water distance of a shape, for fetch-limited waves (Infinity for an endless ocean). */
export function waterShapeFetch(r: ResolvedWaterShape): number {
    if (r.type === 'ocean' && r.endless) return Infinity;
    if (r.type === 'river') return Math.max(4, ...r.samples.map(s => s.width)) * 2;
    return Math.max(r.max[0] - r.min[0], r.max[2] - r.min[2]);
}
