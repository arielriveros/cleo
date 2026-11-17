import { Spline3, closedSplineXZ, finiteOr, type Vec3Tuple } from '../core/math';
import {
    bucketKey, closestOnSegmentXZ, pointInPolygonXZ, riverColumn, type ResolvedWaterShape, type WaterColumn,
} from '../physics/water/waterColumn';

export {
    waterColumnAt, type ResolvedWaterShape, type RiverSample, type WaterColumn,
} from '../physics/water/waterColumn';

// The BODY of water a Water node is, as plain data, and its resolution into world space: where the water
// is, how high its surface rests, how deep it is and which way it flows. Every Water node is exactly one
// body of one type; a river joins another node (a lake it runs into, the lake it drains) by naming it.
// Shared by the node, the physics worker (which has no scene, and gets the resolved form) and the renderer.
//
// A LEAF apart from core/math: no scene, no graphics.

export type WaterBodyType = 'river' | 'lake' | 'ocean' | 'pool';

/** The types, in the order the inspector offers them. */
export const WATER_BODY_TYPES: readonly WaterBodyType[] = ['river', 'lake', 'ocean', 'pool'];

/** One control point of a river or a lake's outline: where its surface runs, and how wide, deep and fast it is there. */
export interface WaterPoint {
    /** Node-local position: a river's surface on its centre line, a lake outline's point (its height unused). */
    pos: [number, number, number];
    /** River: metres, bank to bank. */
    width: number;
    /** River: metres, surface to bed at the centre line. */
    depth: number;
    /** River: metres per second, downstream. */
    flowSpeed: number;
}

/** How a river or lake digs its bed into the landscape (only when `enabled`). */
export interface WaterCarve {
    enabled: boolean;
    /** Metres the bank slopes over, beyond the water's edge. */
    bankWidth: number;
    /** Metres dug below the water's own depth (0 = the bed is exactly `depth` down). */
    extraDepth: number;
}

/** The Water nodes (by id) a river's start and end run into or out of, so its surface meets theirs. */
export interface WaterConnect { start: string | null; end: string | null; }

/**
 * One body of water, in its node's local units (it scales with the node and moves with it; rotation is
 * ignored, water stays level). The node's position is the body's origin:
 *
 *  - `river`: an open spline through `points` (surface on the centre line), each with its own width, depth
 *    and flow speed; `connect` names what it flows from and into.
 *  - `lake`: a level surface at the node's height inside the smooth closed outline through `points`, `depth` deep.
 *  - `ocean`: a level surface at the node's height reaching `extent` metres each way (0 = endless), `depth` deep.
 *  - `pool`: a level block of water `size` big centred on the node; its top face is the surface.
 */
export interface WaterBody {
    type: WaterBodyType;
    points: WaterPoint[];
    size: [number, number, number];
    depth: number;
    extent: number;
    carve: WaterCarve;
    connect: WaterConnect;
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

/** The points a new river or lake starts with (none for an ocean or pool). */
export function defaultWaterPoints(type: WaterBodyType): WaterPoint[] {
    const src = type === 'river' ? RIVER_POINTS : type === 'lake' ? LAKE_POINTS : [];
    return src.map(p => normaliseWaterPoint(p));
}

/** Fewest points a type needs (a river is a line, a lake an outline). */
export function minWaterPoints(type: WaterBodyType): number {
    return type === 'river' ? 2 : type === 'lake' ? 3 : 0;
}

/** A body with every field filled from `json` (missing or broken values take the defaults). */
export function normaliseWaterBody(json: any, type?: WaterBodyType): WaterBody {
    const t: WaterBodyType = WATER_BODY_TYPES.includes(json?.type) ? json.type : (type ?? 'pool');
    const rawPoints = Array.isArray(json?.points) ? json.points : null;
    let points: WaterPoint[] = rawPoints ? rawPoints.map((p: any) => normaliseWaterPoint(p)) : defaultWaterPoints(t);
    if (points.length < minWaterPoints(t)) points = defaultWaterPoints(t);
    if (t !== 'river' && t !== 'lake') points = [];
    const size = vec3Or(json?.size, [10, 2, 10]).map(Math.abs) as [number, number, number];
    const carve = json?.carve ?? {};
    const connect = json?.connect ?? {};
    const river = t === 'river';
    return freezeBody({
        type: t,
        points,
        size: [Math.max(0.01, size[0]), Math.max(0.01, size[1]), Math.max(0.01, size[2])],
        depth: Math.max(0.05, finiteOr(json?.depth, t === 'ocean' ? 50 : 3)),
        extent: Math.max(0, finiteOr(json?.extent, 0)),
        carve: {
            enabled: !!carve.enabled,
            bankWidth: Math.max(0, finiteOr(carve.bankWidth, 3)),
            extraDepth: Math.max(0, finiteOr(carve.extraDepth, 0)),
        },
        // Only a river joins other water; the rest stand on their own.
        connect: {
            start: river && typeof connect.start === 'string' && connect.start ? connect.start : null,
            end: river && typeof connect.end === 'string' && connect.end ? connect.end : null,
        },
    });
}

/**
 * Bodies are values: a node replaces its body whole, so an edit is always seen (its version moves). Frozen,
 * so something writing into one in place fails loudly instead of changing water nothing knows to rebuild.
 */
function freezeBody(b: WaterBody): WaterBody {
    for (const p of b.points) { Object.freeze(p.pos); Object.freeze(p); }
    Object.freeze(b.points); Object.freeze(b.size); Object.freeze(b.carve); Object.freeze(b.connect);
    return Object.freeze(b);
}

/** A deep copy (bodies are edited by replacing them whole, as collider shapes are). */
export function cloneWaterBody(b: WaterBody): WaterBody {
    return normaliseWaterBody(JSON.parse(JSON.stringify(b)));
}

/**
 * The same body as another type: the fields both share are kept, the points are kept only between
 * types that read them the same way (none do: a river's centre line is not a lake's outline), and the
 * new type's own fields take their defaults.
 */
export function retypeWaterBody(b: WaterBody, type: WaterBodyType): WaterBody {
    if (b.type === type) return b;
    return normaliseWaterBody({ ...b, type, points: undefined, connect: { start: null, end: null } });
}

// ---------------------------------------------------------------------------------------------------
// Older saves: one node, a list of shapes
// ---------------------------------------------------------------------------------------------------

/** A shape of the list an older Water node held, made a body of its own: where it sits relative to that node, and what it was called. */
export interface LegacyWaterShape {
    /** The old shape id: what other shapes' connections named. */
    id: string;
    name: string;
    /** The shape's offset in the old node's local units. */
    offset: [number, number, number];
    body: WaterBody;
}

/**
 * The shapes of an older Water node's `shapes` list, each as a body of its own. `box` became `pool`; a
 * connection still names the OLD shape id (the caller maps those to the nodes it makes).
 */
export function legacyWaterShapes(shapes: readonly any[]): LegacyWaterShape[] {
    return shapes.map((s, i) => {
        const type: WaterBodyType = s?.type === 'box' ? 'pool' : WATER_BODY_TYPES.includes(s?.type) ? s.type : 'pool';
        const connect = s?.connect ?? {};
        return {
            id: typeof s?.id === 'string' && s.id ? s.id : `shape${i}`,
            name: typeof s?.name === 'string' ? s.name : '',
            offset: vec3Or(s?.offset, [0, 0, 0]),
            body: normaliseWaterBody({ ...s, type, connect: type === 'river' ? connect : {} }),
        };
    });
}

// ---------------------------------------------------------------------------------------------------
// Resolved: world space, connections applied, ready to query
// ---------------------------------------------------------------------------------------------------

/** Where a node puts its body: translation and per-axis scale (rotation is ignored). */
export interface WaterFrame { position: readonly number[]; scale: readonly number[]; }

/** What a river's ends join, already resolved: the water it flows from and into. */
export interface WaterTargets { start?: ResolvedWaterShape | null; end?: ResolvedWaterShape | null; }

/** Node-local → world. */
function toWorld(frame: WaterFrame, p: readonly number[]): Vec3Tuple {
    return [
        frame.position[0] + p[0] * frame.scale[0],
        frame.position[1] + p[1] * frame.scale[1],
        frame.position[2] + p[2] * frame.scale[2],
    ];
}

const RIVER_SPACING = 1;
/** Rivers carry this share of their node's waves: a chop, not a swell. */
export const RIVER_WAVE_FACTOR = 0.15;

/** How far inside the water it joins a river's connected end reaches, metres. */
const REACH_INSIDE = 2;

/** The surface of `target` over (x, z), for a river end joining it. */
function levelOn(target: ResolvedWaterShape, x: number, z: number): number {
    if (target.type !== 'river') return target.level;
    const col: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: 0, waveFactor: 1 };
    if (riverColumn(target, x, z, col)) return col.surface;
    // The nearest point of the other river's centre line, wherever the end lands.
    let best = Infinity, y = target.level;
    for (const q of target.samples) {
        const d = (q.x - x) * (q.x - x) + (q.z - z) * (q.z - z);
        if (d < best) { best = d; y = q.y; }
    }
    return y;
}

/**
 * Where a river end at world (x, z) meets the lake or pool it connects to: null when it is already inside,
 * else the nearest point of the water's edge, `REACH_INSIDE` metres in. Null for anything else (another
 * river, an endless ocean, which every end is already in).
 */
function reachInto(target: ResolvedWaterShape, x: number, z: number): [number, number] | null {
    if (target.type === 'pool' || (target.type === 'ocean' && !target.endless)) {
        const m = REACH_INSIDE;
        const cx = Math.min(target.max[0] - m, Math.max(target.min[0] + m, x));
        const cz = Math.min(target.max[2] - m, Math.max(target.min[2] + m, z));
        return cx === x && cz === z ? null : [cx, cz];
    }
    if (target.type !== 'lake' || target.outline.length < 6) return null;
    if (pointInPolygonXZ(x, z, target.outline)) return null;
    const o = target.outline, n = o.length >> 1;
    let best = Infinity, bx = x, bz = z;
    const tmp = [0, 0];
    for (let i = 0, j = n - 1; i < n; j = i++) {
        closestOnSegmentXZ(x, z, o[j * 2], o[j * 2 + 1], o[i * 2], o[i * 2 + 1], tmp);
        if (tmp[1] < best) {
            best = tmp[1];
            bx = o[j * 2] + (o[i * 2] - o[j * 2]) * tmp[0];
            bz = o[j * 2 + 1] + (o[i * 2 + 1] - o[j * 2 + 1]) * tmp[0];
        }
    }
    // In along the approach direction: the river carries on past the shore into the lake.
    const dx = bx - x, dz = bz - z, l = Math.hypot(dx, dz) || 1;
    return [bx + dx / l * REACH_INSIDE, bz + dz / l * REACH_INSIDE];
}

function resolveRiver(body: WaterBody, frame: WaterFrame, targets: WaterTargets, out: ResolvedWaterShape): void {
    const sx = Math.abs(frame.scale[0]), sz = Math.abs(frame.scale[2]), sy = Math.abs(frame.scale[1]);
    const lateral = (sx + sz) / 2;
    const raw = body.points.map(p => ({ ...p, pos: toWorld(frame, p.pos) }));
    // A connected end takes the surface of what it flows into (or out of), so the two meet.
    if (raw.length && targets.start) { const q = raw[0].pos; q[1] = levelOn(targets.start, q[0], q[2]); }
    if (raw.length && targets.end) { const q = raw[raw.length - 1].pos; q[1] = levelOn(targets.end, q[0], q[2]); }
    // An end that stops short of the lake or pool it connects to carries on into it: one more point, on
    // its surface just past its shore, so the river visibly flows in (and out of, for a start).
    const reach = (target: ResolvedWaterShape | null | undefined, end: boolean) => {
        if (!target || !raw.length) return;
        const at = end ? raw[raw.length - 1] : raw[0];
        const inside = reachInto(target, at.pos[0], at.pos[2]);
        if (!inside) return;
        const extra = { ...at, pos: [inside[0], target.level, inside[1]] as [number, number, number] };
        at.pos[1] = target.level;
        if (end) raw.push(extra); else raw.unshift(extra);
    };
    reach(targets.end, true);
    reach(targets.start, false);
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
 * The body in world space, with its connections applied (a river end that runs into a lake takes the lake's
 * level and reaches into it). `id` is the node's, so other nodes' columns can tell this water apart. Null
 * when there is nothing to resolve (a river whose points collapse to one).
 */
export function resolveWaterBody(body: WaterBody, frame: WaterFrame, id: string, targets: WaterTargets = {}): ResolvedWaterShape | null {
    const sx = Math.abs(frame.scale[0]), sy = Math.abs(frame.scale[1]), sz = Math.abs(frame.scale[2]);
    const r: ResolvedWaterShape = {
        id, type: body.type, priority: 0, order: 0,
        min: [0, 0, 0], max: [0, 0, 0], level: 0, floor: 0, outline: [], samples: [], cell: 1, grid: {}, endless: false,
        waveFactor: body.type === 'river' ? RIVER_WAVE_FACTOR : 1,
    };
    if (body.type === 'pool') {
        const c = toWorld(frame, [0, 0, 0]);
        const h = [body.size[0] * sx / 2, body.size[1] * sy / 2, body.size[2] * sz / 2];
        r.min = [c[0] - h[0], c[1] - h[1], c[2] - h[2]];
        r.max = [c[0] + h[0], c[1] + h[1], c[2] + h[2]];
        r.level = r.max[1]; r.floor = r.min[1];
    } else if (body.type === 'lake') {
        const pts = body.points.map(p => toWorld(frame, [p.pos[0], 0, p.pos[2]]));
        r.outline = closedSplineXZ(pts, 1);
        r.level = frame.position[1];
        r.floor = r.level - body.depth * sy;
        r.min = [Infinity, r.floor, Infinity]; r.max = [-Infinity, r.level, -Infinity];
        for (let i = 0; i < r.outline.length; i += 2) {
            r.min[0] = Math.min(r.min[0], r.outline[i]); r.max[0] = Math.max(r.max[0], r.outline[i]);
            r.min[2] = Math.min(r.min[2], r.outline[i + 1]); r.max[2] = Math.max(r.max[2], r.outline[i + 1]);
        }
    } else if (body.type === 'ocean') {
        const c = toWorld(frame, [0, 0, 0]);
        r.level = c[1]; r.floor = c[1] - body.depth * sy;
        r.endless = !(body.extent > 0);
        const e = r.endless ? 1e7 : body.extent;
        r.min = [c[0] - e * sx, r.floor, c[2] - e * sz];
        r.max = [c[0] + e * sx, r.level, c[2] + e * sz];
    } else {
        resolveRiver(body, frame, targets, r);
        if (!r.samples.length) return null;
    }
    return r;
}

/** World box around the shapes (endless oceans included, so it can be huge). Null with none. */
export function waterShapesBounds(shapes: readonly ResolvedWaterShape[]): { min: [number, number, number]; max: [number, number, number] } | null {
    if (!shapes.length) return null;
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const s of shapes) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], s.min[a]); max[a] = Math.max(max[a], s.max[a]); }
    return { min, max };
}

/** Rough open-water distance of a body, for fetch-limited waves (Infinity for an endless ocean). */
export function waterShapeFetch(r: ResolvedWaterShape): number {
    if (r.type === 'ocean' && r.endless) return Infinity;
    if (r.type === 'river') return Math.max(4, ...r.samples.map(s => s.width)) * 2;
    return Math.max(r.max[0] - r.min[0], r.max[2] - r.min[2]);
}
