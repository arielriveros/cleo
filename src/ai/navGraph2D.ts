/**
 * 2D navigation: where a side-view agent can stand, and how it gets from one place to another -- walking,
 * jumping between platforms, dropping off a ledge or through a one-way platform, or, for a flier, flying
 * through the open air. Baked from the 2D collision world (tilemaps' tiles and 2D colliders) for one agent
 * profile, stored on a NavMeshNode in 2D space, and searched with A* when a controller asks for a path.
 *
 * ## Every jump is flown before it is kept
 *
 * A jump edge is not an arc a formula says should work: the bake FLIES it, with the follower the
 * controller uses (navFollow2D.followPath2D) and the body step the game uses (physics2d/body2d), from
 * rest and at a run, from a little either side of the take-off, and keeps it only if every flight lands
 * where it should. A ceiling, a lip, a slope at the landing -- whatever the formula would miss, the
 * flight meets. Drops are found the same way: the bake walks off each ledge and sees where it lands.
 *
 * A LEAF: gl-matrix, the 2D collision functions and the follower; no Node, no scene.
 */

import { vec3 } from "gl-matrix";
import { floorBetween, overlapsSolid } from "../physics2d/collide2d";
import type { CollisionWorld2D } from "../physics2d/types";
import { createNavPath, setNavPath } from "./navPath";
import type { NavAction, NavPath } from "./navPath";
import { jumpFlightTime, navAgent2D, simulatePath2D } from "./navFollow2D";
import type { NavAgent2D } from "./navFollow2D";

export type { NavAgent2D } from "./navFollow2D";

/** An edge's kind, as stored. */
export const EDGE_WALK = 0, EDGE_JUMP = 1, EDGE_DROP = 2, EDGE_DROP_THROUGH = 3, EDGE_FLY = 4;
const EDGE_ACTIONS: NavAction[] = ['walk', 'jump', 'drop', 'dropThrough', 'fly'];

/** The bounds a graph is baked over: [minX, minY, maxX, maxY]. */
export type NavBounds2D = [number, number, number, number];

/** A baked 2D graph, as stored. */
export interface NavGraph2DData {
    movement: 'walk' | 'fly';
    bounds: NavBounds2D;
    /** Surface samples, x then y (the feet). Walk graphs only. */
    nodes: Float32Array;
    /** One-way surface (1) or solid (0), per node. */
    oneWay: Uint8Array;
    /** Edges as node pairs, each with its kind, cost (seconds) and throttle (share of walk speed). */
    edges: Uint32Array;
    kinds: Uint8Array;
    costs: Float32Array;
    throttles: Float32Array;
    /** The column spacing samples were taken at. */
    step: number;
    /** A flier's grid: cell size, columns and rows over the bounds, and whether each cell is free. */
    cell: number;
    cols: number;
    rows: number;
    free: Uint8Array;
}

export interface NavBakeStats2D {
    nodes: number;
    edges: Record<NavAction, number>;
    freeCells: number;
    ms: number;
}

export const EMPTY_NAV_GRAPH_2D: NavGraph2DData = {
    movement: 'walk', bounds: [0, 0, 0, 0], nodes: new Float32Array(0), oneWay: new Uint8Array(0),
    edges: new Uint32Array(0), kinds: new Uint8Array(0), costs: new Float32Array(0), throttles: new Float32Array(0),
    step: 0.5, cell: 0.5, cols: 0, rows: 0, free: new Uint8Array(0),
};

// =====================================================================================================
// Baking
// =====================================================================================================

/** Options of a bake. */
export interface NavBake2DOptions {
    /** Column spacing of the surface samples (walk), or the cell size (fly). */
    step?: number;
}

/** Bake a graph for `agent` over `bounds` of `world`. */
export function bakeNavGraph2D(world: CollisionWorld2D, bounds: NavBounds2D, agentIn: Partial<NavAgent2D>,
                               opts: NavBake2DOptions = {}): { data: NavGraph2DData, stats: NavBakeStats2D } {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const agent = navAgent2D(agentIn);
    const data = agent.movement === 'fly' ? bakeFly(world, bounds, agent, opts.step ?? 0.5) : bakeWalk(world, bounds, agent, opts.step ?? 0.5);
    const edges = { walk: 0, jump: 0, drop: 0, dropThrough: 0, fly: 0 } as Record<NavAction, number>;
    for (const k of data.kinds) edges[EDGE_ACTIONS[k]]++;
    let freeCells = 0;
    for (const f of data.free) freeCells += f;
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
    return { data, stats: { nodes: data.nodes.length / 2, edges, freeCells, ms } };
}

interface Span { nodes: number[]; minX: number; maxX: number }

function bakeWalk(world: CollisionWorld2D, bounds: NavBounds2D, agent: NavAgent2D, step: number): NavGraph2DData {
    const [minX, minY, maxX, maxY] = bounds;
    const hw = agent.width / 2;
    const probe = Math.min(0.2, hw * 0.5);
    const xs: number[] = [], ys: number[] = [], oneWay: number[] = [], column: number[] = [];
    const clear = (x: number, y: number) => !overlapsSolid(world, x - hw + 0.01, y + 0.02, x + hw - 0.01, y + agent.height);

    // --- surfaces: every floor top in each column where the agent's box fits ------------------------
    const cols = Math.max(0, Math.floor((maxX - minX) / step));
    const byColumn: number[][] = [];
    for (let c = 0; c < cols; c++) {
        const x = minX + (c + 0.5) * step;
        const list: number[] = [];
        let from = maxY;
        for (let guard = 0; guard < 256 && from > minY; guard++) {
            const top = floorBetween(world, { x, y: from, halfWidth: probe, height: 0.1 }, from, minY, false);
            if (!(top > -Infinity) || top < minY) break;
            if (clear(x, top)) {
                const solid = floorBetween(world, { x, y: top + 0.01, halfWidth: probe, height: 0.1 }, top + 0.01, top - 0.01, true);
                list.push(xs.length);
                xs.push(x); ys.push(top); column.push(c);
                oneWay.push(solid > -Infinity && Math.abs(solid - top) < 1e-3 ? 0 : 1);
            }
            from = top - 0.05;
        }
        byColumn.push(list);
    }
    const n = xs.length;
    const edges: number[] = [], kinds: number[] = [], costs: number[] = [], throttles: number[] = [];
    const add = (a: number, b: number, kind: number, cost: number, throttle = 1) => {
        edges.push(a, b); kinds.push(kind); costs.push(cost); throttles.push(throttle);
    };

    // --- walks between neighbouring columns, within step height and clear of walls -------------------
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let c = 0; c + 1 < cols; c++) {
        for (const a of byColumn[c]) for (const b of byColumn[c + 1]) {
            if (Math.abs(ys[a] - ys[b]) > agent.stepHeight + 1e-3) continue;
            const top = Math.max(ys[a], ys[b]);
            if (overlapsSolid(world, xs[a] - hw + 0.01, top + 0.02, xs[b] + hw - 0.01, top + agent.height)) continue;
            const cost = step / agent.walkSpeed;
            add(a, b, EDGE_WALK, cost); add(b, a, EDGE_WALK, cost);
            parent[find(a)] = find(b);
        }
    }
    const spanOf = new Map<number, Span>();
    const spanIndex: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const root = find(i);
        let s = spanOf.get(root);
        if (!s) { s = { nodes: [], minX: Infinity, maxX: -Infinity }; spanOf.set(root, s); }
        s.nodes.push(i);
        s.minX = Math.min(s.minX, xs[i]); s.maxX = Math.max(s.maxX, xs[i]);
    }
    const spans = [...spanOf.values()];
    spans.forEach((s, k) => { s.nodes.sort((a, b) => xs[a] - xs[b]); for (const i of s.nodes) spanIndex[i] = k; });

    // Which node of `span` the feet at (x, y) stand on: the one under x at about y.
    const nodeAt = (x: number, y: number): number => {
        let best = -1, bestD = Infinity;
        const c = Math.round((x - minX) / step - 0.5);
        for (let cc = c - 1; cc <= c + 1; cc++) {
            for (const i of byColumn[cc] ?? []) {
                const d = Math.abs(ys[i] - y) * 4 + Math.abs(xs[i] - x);
                if (Math.abs(ys[i] - y) < 0.35 && d < bestD) { bestD = d; best = i; }
            }
        }
        return best;
    };
    const fly = (path: NavPath, x: number, y: number, vx: number) =>
        simulatePath2D(world, agent, path, x, y, vx, { floorY: minY - 0.5, maxSeconds: 4 });
    const leg = (fromX: number, fromY: number, toX: number, toY: number, action: NavAction, throttle = 1) => {
        const path = createNavPath();
        setNavPath(path, [vec3.fromValues(fromX, fromY, 0), vec3.fromValues(toX, toY, 0)], ['walk', action], [1, throttle]);
        path.index = 1;
        return path;
    };

    // --- drops: walk off each end of each span, slow and at a run, and see where the feet land -------
    for (const s of spans) {
        for (const dir of [-1, 1]) {
            const edge = dir < 0 ? s.nodes[0] : s.nodes[s.nodes.length - 1];
            const ex = xs[edge], ey = ys[edge];
            // Off the end: nothing to stand on just past it.
            const past = floorBetween(world, { x: ex + dir * (hw + step), y: ey + 0.05, halfWidth: probe, height: 0.1 }, ey + 0.05, ey - agent.stepHeight - 0.05, false);
            if (past > -Infinity) continue;
            const seen = new Set<number>();
            for (const throttle of [1, 0.35]) {
                // Aim well out past the edge; the follower walks off toward it and steers in the air.
                const aimX = ex + dir * (hw + 2.5 * throttle + 0.5);
                const result = fly(leg(ex, ey, aimX, ey - agent.maxDrop - 1, 'drop', throttle), ex, ey, dir * agent.walkSpeed * throttle);
                if (result.ok || result.y < minY) continue;
                // The flight lands somewhere: the follower calls that a missed landing (repath), which it is
                // for this aim -- the landing it found is what the edge records.
                const land = nodeAt(result.x, result.y);
                if (land < 0 || spanIndex[land] === spanIndex[edge] || seen.has(land) || ey - ys[land] > agent.maxDrop) continue;
                // Flown again aimed at that landing, so the follower's own landing check agrees.
                const check = fly(leg(ex, ey, xs[land], ys[land], 'drop', throttle), ex, ey, dir * agent.walkSpeed * throttle);
                if (!check.ok) continue;
                seen.add(land);
                add(edge, land, EDGE_DROP, check.seconds + 0.3, throttle);
            }
        }
    }

    // --- drop-throughs: down + jump from a one-way surface -------------------------------------------
    for (let i = 0; i < n; i += 1) {
        if (!oneWay[i] || (i % 2 === 1 && i > 0 && column[i] === column[i - 1])) continue;
        if (column[i] % 2 !== 0) continue;
        const result = fly(leg(xs[i], ys[i], xs[i], ys[i] - agent.maxDrop - 1, 'dropThrough'), xs[i], ys[i], 0);
        if (result.y < minY) continue;
        const land = nodeAt(result.x, result.y);
        if (land < 0 || land === i || ys[i] - ys[land] > agent.maxDrop) continue;
        const check = fly(leg(xs[i], ys[i], xs[land], ys[land], 'dropThrough'), xs[i], ys[i], 0);
        if (check.ok) add(i, land, EDGE_DROP_THROUGH, check.seconds + 0.3);
    }

    // --- jumps: between spans within the agent's reach, each flown before it is kept -------------------
    const reachUp = agent.jumpHeight - 0.15;
    for (let a = 0; a < spans.length; a++) {
        for (let b = 0; b < spans.length; b++) {
            if (a === b) continue;
            const A = spans[a], B = spans[b];
            const yA = ys[A.nodes[0]], yB = ys[B.nodes[0]];
            const dy = yB - yA;
            if (dy > reachUp) continue;
            // Jumping DOWN to a lower span is a drop's job unless the gap needs the jump to clear it.
            const t = jumpFlightTime(agent, dy);
            const gap = Math.max(0, Math.max(A.minX, B.minX) - Math.min(A.maxX, B.maxX));
            if (!(t < Infinity) || gap > agent.walkSpeed * t + hw * 2) continue;
            const candidates = jumpCandidates(A, B, xs, hw, agent);
            for (const [from, to] of candidates) {
                const fx = xs[from], fy = ys[from], tx = xs[to], ty = ys[to];
                if (Math.abs(tx - fx) > agent.walkSpeed * t + 0.5) continue;
                const variants: [number, number][] = [[fx, 0], [fx - 0.25 * Math.sign(tx - fx || 1), agent.walkSpeed * Math.sign(tx - fx || 1)], [fx + 0.2, 0], [fx - 0.2, 0]];
                let ok = true, seconds = 0;
                for (const [sx, vx] of variants) {
                    const path = leg(fx, fy, tx, ty, 'jump');
                    const r = fly(path, sx, fy, vx);
                    if (!r.ok) { ok = false; break; }
                    seconds = Math.max(seconds, r.seconds);
                }
                if (!ok) continue;
                add(from, to, EDGE_JUMP, seconds + 0.25);
                break;
            }
        }
    }

    return {
        movement: 'walk', bounds: [...bounds] as NavBounds2D,
        nodes: Float32Array.from(xs.flatMap((x, i) => [x, ys[i]])), oneWay: Uint8Array.from(oneWay),
        edges: Uint32Array.from(edges), kinds: Uint8Array.from(kinds), costs: Float32Array.from(costs),
        throttles: Float32Array.from(throttles), step, cell: 0, cols: 0, rows: 0, free: new Uint8Array(0),
    };
}

/**
 * The take-off and landing node pairs worth flying from span A to span B, best first: the nearest ends
 * (landing a body's width in from B's edge), and, where B hangs over A, straight up through a one-way
 * platform and around B's end.
 */
function jumpCandidates(A: Span, B: Span, xs: number[], hw: number, agent: NavAgent2D): [number, number][] {
    const out: [number, number][] = [];
    const nearest = (span: Span, x: number) => span.nodes.reduce((best, i) => (Math.abs(xs[i] - x) < Math.abs(xs[best] - x) ? i : best), span.nodes[0]);
    const inset = (span: Span, i: number, dir: number) => nearest(span, xs[i] + dir * Math.min(hw * 2 + 0.2, (span.maxX - span.minX) / 2));
    const bCentre = (B.minX + B.maxX) / 2;
    const from = nearest(A, bCentre < A.minX ? A.minX : bCentre > A.maxX ? A.maxX : bCentre);
    const fx = xs[from];
    const landEdge = nearest(B, fx);
    // Land a little in from B's edge, toward its middle.
    const towardMiddle = Math.sign(bCentre - xs[landEdge]) || 1;
    out.push([from, inset(B, landEdge, towardMiddle)]);
    if (fx >= B.minX && fx <= B.maxX) {
        // B is above the take-off: straight up (a one-way platform lets the agent through)...
        out.push([from, nearest(B, fx)]);
        // ...or around either end of B, from a run-up outside it: the further out, the more the rise
        // clears the edge before it gets there.
        for (const end of [B.minX, B.maxX]) {
            const dir = end === B.minX ? -1 : 1;
            for (const runUp of [0.5, 1.1, 1.7]) {
                const outside = nearest(A, end + dir * (hw + runUp));
                if (xs[outside] * dir > end * dir) out.push([outside, inset(B, nearest(B, end), -dir)]);
            }
        }
    }
    void agent;
    return out;
}

function bakeFly(world: CollisionWorld2D, bounds: NavBounds2D, agent: NavAgent2D, cell: number): NavGraph2DData {
    const [minX, minY, maxX, maxY] = bounds;
    const cols = Math.max(0, Math.floor((maxX - minX) / cell));
    const rows = Math.max(0, Math.floor((maxY - minY) / cell));
    const free = new Uint8Array(cols * rows);
    const hw = agent.width / 2, hh = agent.height / 2;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = minX + (c + 0.5) * cell, y = minY + (r + 0.5) * cell;
        free[r * cols + c] = overlapsSolid(world, x - hw, y - hh, x + hw, y + hh) ? 0 : 1;
    }
    return {
        movement: 'fly', bounds: [...bounds] as NavBounds2D, nodes: new Float32Array(0), oneWay: new Uint8Array(0),
        edges: new Uint32Array(0), kinds: new Uint8Array(0), costs: new Float32Array(0), throttles: new Float32Array(0),
        step: 0, cell, cols, rows, free,
    };
}

// =====================================================================================================
// Searching
// =====================================================================================================

/** A baked graph, built for searching: adjacency arrays and a column index. */
export class NavGraph2D {
    public readonly data: NavGraph2DData;
    private readonly _first: Int32Array;
    private readonly _next: Int32Array;
    private readonly _byColumn = new Map<number, number[]>();

    constructor(data: NavGraph2DData) {
        this.data = data;
        const n = data.nodes.length / 2, m = data.kinds.length;
        this._first = new Int32Array(n).fill(-1);
        this._next = new Int32Array(m).fill(-1);
        for (let e = m - 1; e >= 0; e--) {
            const a = data.edges[e * 2];
            this._next[e] = this._first[a];
            this._first[a] = e;
        }
        for (let i = 0; i < n; i++) {
            const c = this._column(data.nodes[i * 2]);
            let list = this._byColumn.get(c);
            if (!list) { list = []; this._byColumn.set(c, list); }
            list.push(i);
        }
    }

    public get movement(): 'walk' | 'fly' { return this.data.movement; }
    public get nodeCount(): number { return this.data.nodes.length / 2; }
    public get edgeCount(): number { return this.data.kinds.length; }

    private _column(x: number): number {
        return Math.floor((x - this.data.bounds[0]) / Math.max(1e-6, this.data.step));
    }

    /** Edge `e`: its two nodes, kind and cost. */
    public edge(e: number): { from: number, to: number, kind: number, cost: number, throttle: number } {
        const d = this.data;
        return { from: d.edges[e * 2], to: d.edges[e * 2 + 1], kind: d.kinds[e], cost: d.costs[e], throttle: d.throttles[e] };
    }

    public node(i: number): [number, number] { return [this.data.nodes[i * 2], this.data.nodes[i * 2 + 1]]; }

    /**
     * The surface a walker at (x, y) stands on, or would land on: the highest node at or below y + 0.3 in
     * its column (or the next ones out), else the nearest. -1 for an empty graph.
     */
    public nodeUnder(x: number, y: number): number {
        const c = this._column(x);
        let best = -1, bestScore = Infinity;
        for (let r = 0; r <= 4 && best < 0; r++) {
            for (const cc of r === 0 ? [c] : [c - r, c + r]) {
                for (const i of this._byColumn.get(cc) ?? []) {
                    const ny = this.data.nodes[i * 2 + 1];
                    if (ny > y + 0.3) continue;
                    const score = (y - ny) + Math.abs(this.data.nodes[i * 2] - x);
                    if (score < bestScore) { bestScore = score; best = i; }
                }
            }
        }
        if (best >= 0) return best;
        const n = this.nodeCount;
        for (let i = 0; i < n; i++) {
            const d = Math.hypot(this.data.nodes[i * 2] - x, this.data.nodes[i * 2 + 1] - y);
            if (d < bestScore) { bestScore = d; best = i; }
        }
        return best;
    }

    /**
     * A path from `from` to `to` (feet for a walker, middles for a flier) into `out`: its waypoints and the
     * action that reaches each. Returns false (and leaves `out` empty) when there is no way.
     */
    public findPath(from: ArrayLike<number>, to: ArrayLike<number>, out: NavPath): boolean {
        out.points.length = 0; out.actions.length = 0; out.throttles.length = 0; out.index = 0;
        return this.data.movement === 'fly' ? this._findFly(from, to, out) : this._findWalk(from, to, out);
    }

    private _findWalk(from: ArrayLike<number>, to: ArrayLike<number>, out: NavPath): boolean {
        const start = this.nodeUnder(from[0], from[1]);
        const goal = this.nodeUnder(to[0], to[1]);
        if (start < 0 || goal < 0) return false;
        const d = this.data;
        const n = this.nodeCount;
        const g = new Float64Array(n).fill(Infinity);
        const via = new Int32Array(n).fill(-1);
        const open = new MinHeap();
        const speed = 1 / Math.max(0.1, this._maxSpeed());
        const h = (i: number) => Math.hypot(d.nodes[i * 2] - d.nodes[goal * 2], d.nodes[i * 2 + 1] - d.nodes[goal * 2 + 1]) * speed;
        g[start] = 0;
        open.push(start, h(start));
        while (open.size > 0) {
            const i = open.pop();
            if (i === goal) break;
            for (let e = this._first[i]; e >= 0; e = this._next[e]) {
                const j = d.edges[e * 2 + 1];
                const cost = g[i] + d.costs[e];
                if (cost < g[j]) { g[j] = cost; via[j] = e; open.push(j, cost + h(j)); }
            }
        }
        if (start !== goal && via[goal] < 0) return false;
        // Back from the goal, then forward: a waypoint where a walk run ends and at each non-walk landing.
        const chain: number[] = [];
        for (let i = goal; i !== start; i = d.edges[via[i] * 2]) chain.push(via[i]);
        chain.reverse();
        const push = (i: number, action: NavAction, throttle: number) => {
            out.points.push(vec3.fromValues(d.nodes[i * 2], d.nodes[i * 2 + 1], 0));
            out.actions.push(action);
            out.throttles.push(throttle);
        };
        for (let k = 0; k < chain.length; k++) {
            const e = chain[k];
            const kind = d.kinds[e];
            const a = d.edges[e * 2], b = d.edges[e * 2 + 1];
            if (kind === EDGE_WALK) {
                const next = chain[k + 1];
                // A walk run ends where the next leg is not a walk, or where the height changes.
                if (next === undefined || d.kinds[next] !== EDGE_WALK || Math.abs(d.nodes[b * 2 + 1] - d.nodes[a * 2 + 1]) > 1e-3) push(b, 'walk', 1);
            } else {
                if (out.points.length === 0 || out.points[out.points.length - 1][0] !== d.nodes[a * 2] || out.points[out.points.length - 1][1] !== d.nodes[a * 2 + 1])
                    push(a, 'walk', 1);
                push(b, EDGE_ACTIONS[kind], d.throttles[e]);
            }
        }
        // End where the target is, along the last surface, not at a column centre short of it.
        if (out.points.length === 0) push(goal, 'walk', 1);
        const last = out.points[out.points.length - 1];
        if (out.actions[out.actions.length - 1] === 'walk' && Math.abs(last[1] - to[1]) < 0.5) last[0] = to[0];
        return true;
    }

    private _maxSpeed(): number {
        let best = 0;
        const d = this.data;
        for (let e = 0; e < d.kinds.length; e++) {
            if (d.kinds[e] !== EDGE_WALK) continue;
            const a = d.edges[e * 2], b = d.edges[e * 2 + 1];
            const dist = Math.abs(d.nodes[a * 2] - d.nodes[b * 2]);
            if (d.costs[e] > 0) best = Math.max(best, dist / d.costs[e]);
        }
        return best || 8;
    }

    // --- flying ---------------------------------------------------------------------------------------

    private _cellOf(x: number, y: number): [number, number] {
        const d = this.data;
        return [Math.floor((x - d.bounds[0]) / d.cell), Math.floor((y - d.bounds[1]) / d.cell)];
    }

    private _free(c: number, r: number): boolean {
        const d = this.data;
        return c >= 0 && r >= 0 && c < d.cols && r < d.rows && d.free[r * d.cols + c] === 1;
    }

    /** The free cell nearest (c, r), searching outward a few rings. */
    private _nearestFree(c: number, r: number): [number, number] | null {
        if (this._free(c, r)) return [c, r];
        for (let ring = 1; ring <= 6; ring++) {
            for (let dc = -ring; dc <= ring; dc++) for (let dr = -ring; dr <= ring; dr++) {
                if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
                if (this._free(c + dc, r + dr)) return [c + dc, r + dr];
            }
        }
        return null;
    }

    private _centre(c: number, r: number): [number, number] {
        const d = this.data;
        return [d.bounds[0] + (c + 0.5) * d.cell, d.bounds[1] + (r + 0.5) * d.cell];
    }

    /** Whether a straight flight from a to b stays in free cells (sampled every half cell). */
    private _clearLine(ax: number, ay: number, bx: number, by: number): boolean {
        const len = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(len / (this.data.cell * 0.5)));
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const [c, r] = this._cellOf(ax + (bx - ax) * t, ay + (by - ay) * t);
            if (!this._free(c, r)) return false;
        }
        return true;
    }

    private _findFly(from: ArrayLike<number>, to: ArrayLike<number>, out: NavPath): boolean {
        const d = this.data;
        const s = this._nearestFree(...this._cellOf(from[0], from[1]));
        const t = this._nearestFree(...this._cellOf(to[0], to[1]));
        if (!s || !t) return false;
        const cols = d.cols, total = d.cols * d.rows;
        const start = s[1] * cols + s[0], goal = t[1] * cols + t[0];
        const g = new Float64Array(total).fill(Infinity);
        const via = new Int32Array(total).fill(-1);
        const open = new MinHeap();
        const h = (i: number) => Math.hypot((i % cols) - t[0], Math.floor(i / cols) - t[1]);
        g[start] = 0;
        open.push(start, h(start));
        while (open.size > 0) {
            const i = open.pop();
            if (i === goal) break;
            const c = i % cols, r = Math.floor(i / cols);
            for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
                if (dc === 0 && dr === 0) continue;
                const nc = c + dc, nr = r + dr;
                if (!this._free(nc, nr)) continue;
                // No cutting a corner: a diagonal needs both of its sides open.
                if (dc !== 0 && dr !== 0 && (!this._free(c + dc, r) || !this._free(c, r + dr))) continue;
                const j = nr * cols + nc;
                const cost = g[i] + (dc !== 0 && dr !== 0 ? Math.SQRT2 : 1);
                if (cost < g[j]) { g[j] = cost; via[j] = i; open.push(j, cost + h(j)); }
            }
        }
        if (start !== goal && via[goal] < 0) return false;
        const cells: number[] = [];
        for (let i = goal; i !== start; i = via[i]) cells.push(i);
        cells.push(start);
        cells.reverse();
        // String-pull: from each kept point, on to the furthest cell in a clear straight line.
        const pts: [number, number][] = [[from[0], from[1]]];
        let k = 0;
        while (k < cells.length - 1) {
            const [ax, ay] = pts[pts.length - 1];
            let far = k + 1;
            for (let j = cells.length - 1; j > k + 1; j--) {
                const [cx, cy] = this._centre(cells[j] % cols, Math.floor(cells[j] / cols));
                if (this._clearLine(ax, ay, cx, cy)) { far = j; break; }
            }
            pts.push(this._centre(cells[far] % cols, Math.floor(cells[far] / cols)));
            k = far;
        }
        if (this._clearLine(pts[pts.length - 1][0], pts[pts.length - 1][1], to[0], to[1])) pts[pts.length - 1] = [to[0], to[1]];
        for (let i = 1; i < pts.length; i++) {
            out.points.push(vec3.fromValues(pts[i][0], pts[i][1], 0));
            out.actions.push('fly');
            out.throttles.push(1);
        }
        if (out.points.length === 0) { out.points.push(vec3.fromValues(to[0], to[1], 0)); out.actions.push('fly'); out.throttles.push(1); }
        return true;
    }

    /** The points an edge is drawn along: a straight walk, or the flown arc of a jump or drop. */
    public edgeArc(world: CollisionWorld2D, e: number, agentIn: Partial<NavAgent2D>): number[] {
        const { from, to, kind, throttle } = this.edge(e);
        const [ax, ay] = this.node(from), [bx, by] = this.node(to);
        if (kind === EDGE_WALK) return [ax, ay, bx, by];
        const agent = navAgent2D(agentIn);
        const path = createNavPath();
        setNavPath(path, [vec3.fromValues(ax, ay, 0), vec3.fromValues(bx, by, 0)], ['walk', EDGE_ACTIONS[kind]], [1, throttle]);
        path.index = 1;
        const r = simulatePath2D(world, agent, path, ax, ay, 0, { arc: true });
        return r.arc ?? [ax, ay, bx, by];
    }
}

/** A binary min-heap of (item, priority). */
class MinHeap {
    private readonly _items: number[] = [];
    private readonly _keys: number[] = [];
    public get size(): number { return this._items.length; }
    public push(item: number, key: number): void {
        const items = this._items, keys = this._keys;
        let i = items.length;
        items.push(item); keys.push(key);
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (keys[p] <= key) break;
            items[i] = items[p]; keys[i] = keys[p];
            i = p;
        }
        items[i] = item; keys[i] = key;
    }
    public pop(): number {
        const items = this._items, keys = this._keys;
        const top = items[0];
        const lastItem = items.pop()!, lastKey = keys.pop()!;
        if (items.length > 0) {
            let i = 0;
            const n = items.length;
            for (;;) {
                const l = i * 2 + 1, r = l + 1;
                let m = i;
                let mk = lastKey;
                if (l < n && keys[l] < mk) { m = l; mk = keys[l]; }
                if (r < n && keys[r] < mk) { m = r; mk = keys[r]; }
                if (m === i) break;
                items[i] = items[m]; keys[i] = keys[m];
                i = m;
            }
            items[i] = lastItem; keys[i] = lastKey;
        }
        return top;
    }
}

// =====================================================================================================
// Storage
// =====================================================================================================

const b64 = (bytes: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
};
const unb64 = (text: string): Uint8Array => {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
};
const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** A graph as plain JSON: its typed arrays as base64. Null for an empty graph. */
export function serializeNavGraph2D(data: NavGraph2DData): any | null {
    if (data.nodes.length === 0 && data.free.length === 0) return null;
    return {
        version: 1, movement: data.movement, bounds: [...data.bounds], step: data.step, cell: data.cell,
        cols: data.cols, rows: data.rows,
        nodes: b64(bytesOf(data.nodes)), oneWay: b64(data.oneWay), edges: b64(bytesOf(data.edges)),
        kinds: b64(data.kinds), costs: b64(bytesOf(data.costs)), throttles: b64(bytesOf(data.throttles)),
        free: b64(data.free),
    };
}

/** The reverse of {@link serializeNavGraph2D}; an unreadable blob reads as empty. */
export function parseNavGraph2D(raw: any): NavGraph2DData {
    if (!raw || typeof raw !== 'object') return EMPTY_NAV_GRAPH_2D;
    try {
        const f32 = (s: string) => { const b = unb64(s); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
        const u32 = (s: string) => { const b = unb64(s); return new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
        const bounds = Array.isArray(raw.bounds) && raw.bounds.length === 4 ? raw.bounds.map(Number) as NavBounds2D : [0, 0, 0, 0] as NavBounds2D;
        return {
            movement: raw.movement === 'fly' ? 'fly' : 'walk', bounds,
            nodes: f32(raw.nodes ?? ''), oneWay: unb64(raw.oneWay ?? ''), edges: u32(raw.edges ?? ''),
            kinds: unb64(raw.kinds ?? ''), costs: f32(raw.costs ?? ''), throttles: f32(raw.throttles ?? ''),
            step: Number(raw.step) || 0.5, cell: Number(raw.cell) || 0.5, cols: raw.cols | 0, rows: raw.rows | 0,
            free: unb64(raw.free ?? ''),
        };
    } catch {
        return EMPTY_NAV_GRAPH_2D;
    }
}

/**
 * A fingerprint of what a bake read: the collision world inside the bounds (sampled per cell) and the
 * agent profile. A NavMeshNode compares it to tell a stale bake from a current one.
 */
export function navGraph2DSourceHash(world: CollisionWorld2D, bounds: NavBounds2D, agent: Partial<NavAgent2D>): string {
    let h = 2166136261 >>> 0;
    const mix = (v: number) => { h ^= v & 0xff; h = Math.imul(h, 16777619) >>> 0; };
    const text = JSON.stringify(navAgent2D(agent)) + JSON.stringify(bounds);
    for (let i = 0; i < text.length; i++) mix(text.charCodeAt(i));
    const [minX, minY, maxX, maxY] = bounds;
    for (let y = minY + 0.25; y < maxY; y += 0.5) for (let x = minX + 0.25; x < maxX; x += 0.5) {
        mix(overlapsSolid(world, x - 0.2, y - 0.2, x + 0.2, y + 0.2) ? 1 : 0);
        const top = floorBetween(world, { x, y: y + 0.25, halfWidth: 0.2, height: 0.1 }, y + 0.25, y - 0.25, false);
        mix(top > -Infinity ? 2 : 0);
    }
    for (const b of world.boxes) for (const v of [b.minX, b.minY, b.maxX, b.maxY]) mix(Math.round(v * 100));
    return h.toString(16);
}
