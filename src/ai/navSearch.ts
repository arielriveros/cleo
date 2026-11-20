/**
 * A* over a navmesh's region graph, on flat typed arrays.
 *
 * Yuka's `AStar` keeps its costs, frontier and tree in Maps, allocates a queue entry per relaxation and an array of
 * edges per expanded node, and looks both nodes up for every heuristic: 3.5 ms a search on a 26k-region terrain
 * bake, 7.6 ms on a 37k-region dungeon, and a search for an unreachable goal expands every region it can reach.
 * The graph never changes once the mesh is built, so it is copied once into compressed rows (each region's
 * neighbours and edge costs side by side), and a search reuses the same scratch arrays, told apart by a
 * generation number instead of being cleared. Regions are also labelled by connected component, so a goal on an
 * island the start cannot reach is answered without searching.
 *
 * Same graph, same costs (Yuka's edge costs: centroid to centroid) and the same Euclidean heuristic, so the region
 * path is a shortest one as Yuka's is; between equally short ones it may pick another.
 */

/** The parts of a Yuka graph read once, at build: node positions and outgoing edges. */
export interface RegionGraphSource {
    getNode(index: number): { position: { x: number; y: number; z: number } } | null;
    getEdgesOfNode(index: number, result: { to: number; cost: number }[]): { to: number; cost: number }[];
}

export class RegionSearch {
    private readonly _n: number;
    private readonly _x: Float64Array;
    private readonly _y: Float64Array;
    private readonly _z: Float64Array;
    /** Region i's neighbours are `_to[_start[i] .. _start[i + 1])`, at `_cost` of the same index. */
    private readonly _start: Int32Array;
    private readonly _to: Int32Array;
    private readonly _cost: Float64Array;
    private readonly _component: Int32Array;

    // Per-search scratch: valid for a region only where its stamp is the current generation.
    private readonly _g: Float64Array;
    private readonly _parent: Int32Array;
    private readonly _seen: Uint32Array;
    private readonly _closed: Uint32Array;
    private _generation = 0;
    // A binary min-heap of (f, region), with stale entries skipped on pop rather than updated in place.
    private _heapF: Float64Array;
    private _heapI: Int32Array;
    private _heapSize = 0;

    /** Regions expanded by the last search (for tests and profiling). */
    public expanded = 0;

    /**
     * @param graph   The mesh's region graph.
     * @param count   How many regions there are: node indices are region indices, and a degenerate region has no
     *                node at all (an index the graph skips), which is kept here as a region with no neighbours.
     */
    constructor(graph: RegionGraphSource, count: number) {
        const n = count;
        this._n = n;
        this._x = new Float64Array(n);
        this._y = new Float64Array(n);
        this._z = new Float64Array(n);
        this._start = new Int32Array(n + 1);
        const to: number[] = [];
        const cost: number[] = [];
        const edges: { to: number; cost: number }[] = [];
        for (let i = 0; i < n; i++) {
            this._start[i] = to.length;
            const node = graph.getNode(i);
            if (!node) continue;
            const p = node.position;
            this._x[i] = p.x; this._y[i] = p.y; this._z[i] = p.z;
            // Cleared first: Yuka leaves `result` as it was for a node with no edges.
            edges.length = 0;
            graph.getEdgesOfNode(i, edges);
            for (const e of edges) if (e.to >= 0 && e.to < n) { to.push(e.to); cost.push(e.cost); }
        }
        this._start[n] = to.length;
        this._to = Int32Array.from(to);
        this._cost = Float64Array.from(cost);
        this._g = new Float64Array(n);
        this._parent = new Int32Array(n);
        this._seen = new Uint32Array(n);
        this._closed = new Uint32Array(n);
        this._heapF = new Float64Array(Math.max(16, n));
        this._heapI = new Int32Array(Math.max(16, n));
        this._component = this._label();
    }

    /** Whether a path can exist between two regions (they are in one connected piece of the mesh). */
    public connected(a: number, b: number): boolean {
        return a >= 0 && b >= 0 && a < this._n && b < this._n && this._component[a] === this._component[b];
    }

    /**
     * The regions of a shortest path from `source` to `target`, both included, into `out`; false (and `out`
     * empty) when there is none.
     */
    public search(source: number, target: number, out: number[] = []): boolean {
        out.length = 0;
        this.expanded = 0;
        if (!this.connected(source, target)) return false;
        if (source === target) { out.push(source); return true; }
        const gen = this._nextGeneration();
        const g = this._g, parent = this._parent, seen = this._seen, closed = this._closed;
        const x = this._x, y = this._y, z = this._z, start = this._start, to = this._to, cost = this._cost;
        const tx = x[target], ty = y[target], tz = z[target];
        this._heapSize = 0;
        g[source] = 0; parent[source] = -1; seen[source] = gen;
        this._push(Math.hypot(x[source] - tx, y[source] - ty, z[source] - tz), source);

        while (this._heapSize > 0) {
            const node = this._pop();
            if (closed[node] === gen) continue; // a stale entry: it was reached cheaper since
            closed[node] = gen;
            this.expanded++;
            if (node === target) {
                for (let r = target; r !== -1; r = parent[r]) out.push(r);
                out.reverse();
                return true;
            }
            const gNode = g[node];
            for (let e = start[node], end = start[node + 1]; e < end; e++) {
                const next = to[e];
                if (closed[next] === gen) continue;
                const gNext = gNode + cost[e];
                if (seen[next] === gen && gNext >= g[next]) continue;
                seen[next] = gen;
                g[next] = gNext;
                parent[next] = node;
                this._push(gNext + Math.hypot(x[next] - tx, y[next] - ty, z[next] - tz), next);
            }
        }
        return false; // unreachable: connected() said otherwise only if the graph is one-way somewhere
    }

    private _nextGeneration(): number {
        if (++this._generation === 0xffffffff) {
            this._seen.fill(0);
            this._closed.fill(0);
            this._generation = 1;
        }
        return this._generation;
    }

    /** Connected components, treating every edge as two-way (Yuka adds both directions of a shared edge). */
    private _label(): Int32Array {
        const n = this._n;
        const label = new Int32Array(n).fill(-1);
        const stack = new Int32Array(n);
        // Two-way: the reverse of every edge, so a one-way edge still joins its two regions' labels.
        const back: number[][] = Array.from({ length: n }, () => []);
        for (let i = 0; i < n; i++) for (let e = this._start[i]; e < this._start[i + 1]; e++) back[this._to[e]].push(i);
        let next = 0;
        for (let s = 0; s < n; s++) {
            if (label[s] !== -1) continue;
            let top = 0;
            stack[top++] = s;
            label[s] = next;
            while (top > 0) {
                const r = stack[--top];
                for (let e = this._start[r]; e < this._start[r + 1]; e++) {
                    const t = this._to[e];
                    if (label[t] === -1) { label[t] = next; stack[top++] = t; }
                }
                for (const t of back[r]) if (label[t] === -1) { label[t] = next; stack[top++] = t; }
            }
            next++;
        }
        return label;
    }

    private _push(f: number, node: number): void {
        if (this._heapSize === this._heapF.length) {
            const F = new Float64Array(this._heapF.length * 2); F.set(this._heapF); this._heapF = F;
            const I = new Int32Array(this._heapI.length * 2); I.set(this._heapI); this._heapI = I;
        }
        const hf = this._heapF, hi = this._heapI;
        let i = this._heapSize++;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (hf[p] <= f) break;
            hf[i] = hf[p]; hi[i] = hi[p];
            i = p;
        }
        hf[i] = f; hi[i] = node;
    }

    private _pop(): number {
        const hf = this._heapF, hi = this._heapI;
        const top = hi[0];
        const size = --this._heapSize;
        if (size > 0) {
            const f = hf[size], node = hi[size];
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                if (l >= size) break;
                const r = l + 1;
                const c = r < size && hf[r] < hf[l] ? r : l;
                if (hf[c] >= f) break;
                hf[i] = hf[c]; hi[i] = hi[c];
                i = c;
            }
            hf[i] = f; hi[i] = node;
        }
        return top;
    }
}
