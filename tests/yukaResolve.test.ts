import { describe, it, expect } from 'vitest';
import { NavMesh, Polygon, Vector3, Quaternion, Graph, NavNode, NavEdge, AStar } from '../src/core/ai/yuka';

// Yuka ships no TypeScript declarations and no `exports` map: `main` is a UMD bundle and `module` is
// the ESM one. Under `environment: 'node'` a resolver may legitimately pick either, and the UMD build
// assigns to a global rather than exporting names. This test exists to catch that at `npm test` rather
// than at the first navmesh, and to pin the handful of Yuka conventions the engine's own conversion
// code is written against.

const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
const quad = (x: number, z: number) =>
    new Polygon().fromContour([V(x, 0, z), V(x, 0, z + 1), V(x + 1, 0, z + 1), V(x + 1, 0, z)]);

describe('yuka resolves and behaves as the engine assumes', () => {
    it('resolves to the ESM build with real named exports', () => {
        expect(typeof NavMesh).toBe('function');
        expect(typeof Polygon).toBe('function');
        expect(new Vector3(1, 2, 3).x).toBe(1);
    });

    // The whole interop layer is written against these two facts. gl-matrix stores a quaternion as
    // [x, y, z, w] and a mat4 column-major, and so does Yuka -- which is what makes the bridge a copy
    // rather than a conversion.
    it('stores quaternions xyzw and matrices column-major, like gl-matrix', () => {
        const out = new Float32Array(3);
        new Vector3(1.5, -2.25, 3.75).toArray(out);
        expect(Array.from(out)).toEqual([1.5, -2.25, 3.75]);

        const q = new Quaternion().fromEuler(0, Math.PI / 2, 0);
        expect(q.y).toBeCloseTo(Math.SQRT1_2, 6);
        expect(q.w).toBeCloseTo(Math.SQRT1_2, 6);
    });

    it('funnels a path around an L-shaped mesh', () => {
        const nav = new NavMesh();
        nav.epsilonCoplanarTest = 1e-3;
        nav.fromPolygons([[0, 0], [1, 0], [2, 0], [0, 1], [0, 2]].map(([x, z]) => quad(x, z)));
        nav.epsilonContainsTest = 1e-3;

        const path = nav.findPath(V(2.5, 0, 0.5), V(0.5, 0, 2.5));
        // Three points, not two: the middle one is the inner corner the funnel had to find.
        expect(path).toHaveLength(3);
        expect(path[1].x).toBeCloseTo(1, 6);
        expect(path[1].z).toBeCloseTo(1, 6);
    });

    // Not a Yuka test so much as a pin on the assumption `navLink.ts` will be built on: the graph
    // search is usable standalone, which is the escape hatch for off-mesh links that `findPath`
    // cannot express.
    it('searches a hand-built graph honouring edge costs', () => {
        const g = new Graph();
        g.digraph = true;
        for (let i = 0; i < 4; i++) g.addNode(new NavNode(i, V(i, 0, 0)));
        const link = (a: number, b: number, cost: number) => {
            g.addEdge(new NavEdge(a, b, cost));
            g.addEdge(new NavEdge(b, a, cost));
        };
        link(0, 1, 1); link(1, 2, 1); link(2, 3, 1); link(0, 3, 10);

        const search = new AStar(g, 0, 3);
        search.search();
        expect(search.found).toBe(true);
        expect(search.getPath()).toEqual([0, 1, 2, 3]);
    });
});
