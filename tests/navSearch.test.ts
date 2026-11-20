import { describe, expect, it } from 'vitest';
import { RegionSearch, type RegionGraphSource } from '../src/ai/navSearch';

/** A graph in Yuka's shape: nodes by index (some missing), edges both ways, cost = distance. */
function graph(points: ([number, number] | null)[], links: [number, number][]): RegionGraphSource & { cost(path: number[]): number } {
    const edges = new Map<number, { to: number; cost: number }[]>();
    const d = (a: number, b: number) => Math.hypot(points[a]![0] - points[b]![0], points[a]![1] - points[b]![1]);
    for (const [a, b] of links) {
        if (!edges.has(a)) edges.set(a, []);
        if (!edges.has(b)) edges.set(b, []);
        edges.get(a)!.push({ to: b, cost: d(a, b) });
        edges.get(b)!.push({ to: a, cost: d(a, b) });
    }
    return {
        getNode: (i) => points[i] ? { position: { x: points[i]![0], y: 0, z: points[i]![1] } } : null,
        // As Yuka: `result` left alone for a node with no edges.
        getEdgesOfNode: (i, result) => { const e = edges.get(i); if (e) { result.length = 0; result.push(...e); } return result; },
        cost: (path) => { let c = 0; for (let k = 1; k < path.length; k++) c += d(path[k - 1], path[k]); return c; },
    };
}

/** Plain Dijkstra, for the shortest cost to compare with. */
function dijkstra(g: ReturnType<typeof graph>, n: number, s: number, t: number): number {
    const dist = new Array(n).fill(Infinity);
    const done = new Array(n).fill(false);
    dist[s] = 0;
    for (;;) {
        let u = -1;
        for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
        if (u < 0) return Infinity;
        if (u === t) return dist[t];
        done[u] = true;
        for (const e of g.getEdgesOfNode(u, [])) dist[e.to] = Math.min(dist[e.to], dist[u] + e.cost);
    }
}

describe('RegionSearch', () => {
    it('finds a shortest region path, as long as Dijkstra’s, on a grid with walls', () => {
        // 12 x 12 grid, some cells walled off (no node), jittered positions.
        const N = 12;
        let seed = 7;
        const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        const points: ([number, number] | null)[] = [];
        for (let i = 0; i < N * N; i++) points.push(rand() < 0.2 ? null : [i % N + rand() * 0.4, Math.floor(i / N) + rand() * 0.4]);
        const links: [number, number][] = [];
        for (let i = 0; i < N * N; i++) {
            if (!points[i]) continue;
            if (i % N < N - 1 && points[i + 1]) links.push([i, i + 1]);
            if (i + N < N * N && points[i + N]) links.push([i, i + N]);
        }
        const g = graph(points, links);
        const search = new RegionSearch(g, N * N);
        const path: number[] = [];
        let checked = 0;
        for (let k = 0; k < 200; k++) {
            const a = Math.floor(rand() * N * N), b = Math.floor(rand() * N * N);
            if (!points[a] || !points[b]) continue;
            const best = dijkstra(g, N * N, a, b);
            const found = search.search(a, b, path);
            expect(found).toBe(best < Infinity);
            if (!found) { expect(path).toEqual([]); continue; }
            expect(path[0]).toBe(a);
            expect(path[path.length - 1]).toBe(b);
            for (let i = 1; i < path.length; i++) expect(g.getEdgesOfNode(path[i - 1], []).some((e) => e.to === path[i])).toBe(true);
            expect(g.cost(path)).toBeCloseTo(best, 9);
            checked++;
        }
        expect(checked).toBeGreaterThan(50);
    });

    it('answers an unreachable region at once, without searching', () => {
        // Two islands: 0-1-2 and 3-4. Node 5 is missing (a degenerate region), and 6 has no edges.
        const g = graph([[0, 0], [1, 0], [2, 0], [10, 0], [11, 0], null, [20, 0]], [[0, 1], [1, 2], [3, 4]]);
        const search = new RegionSearch(g, 7);
        const path: number[] = [9];
        expect(search.search(0, 4, path)).toBe(false);
        expect(path).toEqual([]);
        expect(search.expanded).toBe(0);
        expect(search.search(0, 6, path)).toBe(false);
        expect(search.search(0, 5, path)).toBe(false);
        expect(search.search(0, 2, path)).toBe(true);
        expect(path).toEqual([0, 1, 2]);
        expect(search.search(4, 4, path)).toBe(true);
        expect(path).toEqual([4]);
        // A node with no edges after one with edges does not inherit them (Yuka leaves `result` as it was).
        expect(search.connected(4, 6)).toBe(false);
    });
});
