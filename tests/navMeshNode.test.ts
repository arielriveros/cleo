import { describe, it, expect } from 'vitest';
import {
    NavMeshNode, parseBakedVolume, parseLinks, parseRoutes, parseSize,
} from '../src/core/scene/nodes/navMeshNode';
import { Node } from '../src/core/scene/nodes/node';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { bakeNavMesh } from '../src/ai/navBake';

// The node is thin on purpose -- all the geometry lives in core/ai leaves -- so what is worth pinning
// here is the PERSISTENCE contract. A navmesh that silently fails to round-trip does not error; it
// produces a scene where every NPC stands still, which is a much worse way to find out.

function quad(x0: number, z0: number, x1: number, z1: number): number[] {
    return [x0, 0, z0, x0, 0, z1, x1, 0, z1, x0, 0, z0, x1, 0, z1, x1, 0, z0];
}

function bakedNode(name = 'navigation'): NavMeshNode {
    const node = new NavMeshNode(name);
    const result = bakeNavMesh({
        positions: new Float32Array([...quad(0, 0, 3, 1), ...quad(0, 1, 1, 3)]),
        indices: new Uint32Array(0),
    });
    node.setData(result.data);
    return node;
}

/** Serialize, re-parse under a fresh parent, and hand back the reconstructed node. */
async function roundTrip(node: NavMeshNode): Promise<NavMeshNode> {
    const parent = new Node('parent');
    // Through JSON, not just the object: base64 is what actually reaches a scene file, and a typed
    // array that slipped through would stringify as {"0":...} rather than fail loudly.
    parseNodeJson(parent, JSON.parse(JSON.stringify(await node.serialize())));
    return parent.children[0] as NavMeshNode;
}

describe('NavMeshNode', () => {
    it('starts unbaked, with no mesh and no complaint', () => {
        const node = new NavMeshNode('empty');
        expect(node.isBaked).toBe(false);
        expect(node.mesh).toBeNull();
    });

    it('builds its mesh lazily and caches it', () => {
        const node = bakedNode();
        expect(node.isBaked).toBe(true);
        const first = node.mesh;
        expect(first).not.toBeNull();
        expect(node.mesh).toBe(first);
    });

    it('drops the built mesh when the data is replaced', () => {
        const node = bakedNode();
        const first = node.mesh;
        node.setData(bakedNode().data);
        expect(node.mesh).not.toBe(first);
    });

    it('round-trips baked data through serialize and parse', async () => {
        const original = bakedNode();
        const copy = await roundTrip(original);

        expect(copy).toBeInstanceOf(NavMeshNode);
        expect(copy.isBaked).toBe(true);
        expect(Array.from(copy.data.counts)).toEqual(Array.from(original.data.counts));

        // And the reconstructed data still paths, which is the property that actually matters.
        const path = copy.mesh!.findPath([2.5, 0, 0.5], [0.5, 0, 2.5]);
        expect(path.length).toBeGreaterThan(0);
    });

    it('writes no navmesh field at all when nothing is baked', async () => {
        const json = await new NavMeshNode('empty').serialize() as any;
        expect(json.navMesh).toBeUndefined();
        expect(json.routes).toBeUndefined();
        expect(json.links).toBeUndefined();
    });

    it('round-trips routes and links', async () => {
        const node = bakedNode();
        node.routes = [{ name: 'patrol', points: [[0, 0, 0], [3, 0, 0]], loop: true }];
        node.links = [{ name: 'jump', from: [0, 0, 0], to: [5, 0, 0], cost: 3, bidirectional: false }];

        const copy = await roundTrip(node);
        expect(copy.routes).toEqual(node.routes);
        expect(copy.links).toEqual(node.links);
        expect(copy.route('patrol')!.points).toHaveLength(2);
        expect(copy.route('nope')).toBeNull();
    });

    it('hands routes out as gl-matrix vectors ready for setNavPath', () => {
        const node = new NavMeshNode('n');
        node.routes = [{ name: 'r', points: [[1, 2, 3]], loop: false }];
        const points = node.routePoints('r');
        expect(points).toHaveLength(1);
        expect(Array.from(points[0])).toEqual([1, 2, 3]);
        expect(node.routePoints('missing')).toHaveLength(0);
    });

    it('survives a corrupt navmesh blob by coming back unbaked', () => {
        const parent = new Node('parent');
        parseNodeJson(parent, {
            type: 'navMesh', name: 'broken', id: 'x',
            navMesh: { vertices: '%%%not base64%%%', counts: '%%%' },
        });
        const node = parent.children[0] as NavMeshNode;
        expect(node).toBeInstanceOf(NavMeshNode);
        expect(node.isBaked).toBe(false);
    });
});

describe('route and link readers', () => {
    it('drop entries that could never be used', () => {
        expect(parseRoutes([
            { name: '', points: [[0, 0, 0]] },              // unnameable
            { name: 'ok', points: [] },                      // no points
            { name: 'ok', points: [[0, 0, 0]] },
            { name: 'ok', points: [[1, 1, 1]] },             // duplicate name shadows the first
            { name: 'partial', points: [[0, 0, 0], [1, 2]] },
            'nonsense',
        ])).toEqual([
            { name: 'ok', points: [[0, 0, 0]], loop: false },
            { name: 'partial', points: [[0, 0, 0]], loop: false },
        ]);
        expect(parseRoutes(null)).toEqual([]);
    });

    it('default a link cost and treat a missing direction flag as two-way', () => {
        // Absent means true, so a link written before the flag existed keeps working both ways.
        expect(parseLinks([{ from: [0, 0, 0], to: [1, 0, 0] }])).toEqual([
            { name: '', from: [0, 0, 0], to: [1, 0, 0], cost: 1, bidirectional: true },
        ]);
        expect(parseLinks([{ from: [0, 0, 0] }, { to: [1, 0, 0] }, 7])).toEqual([]);
        expect(parseLinks(undefined)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------------------------------
// The bake volume
//
// The volume decides WHICH surfaces get baked, but the contours stay in world space. Both halves need
// pinning: a volume that failed to round-trip would silently re-bake the whole level, and a transform
// that started moving the DATA would invalidate every path the moment someone nudged the node.
// ---------------------------------------------------------------------------------------------------

describe('NavMeshNode bake volume', () => {
    it('is unbounded by default, so a scene authored before volumes is unchanged', () => {
        const node = new NavMeshNode('nav');
        expect(node.bounded).toBe(false);
        expect(node.invVolumeMatrix).toBeNull();
        expect(node.volumeBounds()).toBeNull();
    });

    it('writes nothing when unbounded', async () => {
        const json = JSON.parse(JSON.stringify(await new NavMeshNode('nav').serialize()));
        expect(json.size).toBeUndefined();
        expect(json.bakedVolume).toBeUndefined();
    });

    it('round-trips a size and a baked volume', async () => {
        const node = bakedNode();
        node.size = [10, 4, 6];
        node.setPosition([2, 0, -3]);
        node.updateTransforms();
        node.bakedVolume = node.volumeBounds();

        const back = await roundTrip(node);
        expect(back.size).toEqual([10, 4, 6]);
        expect(back.bounded).toBe(true);
        expect(back.bakedVolume).toEqual(node.bakedVolume);
    });

    it('parses an absent size as unbounded rather than as a zero-volume box', () => {
        expect(parseSize(undefined)).toEqual([0, 0, 0]);
        expect(parseSize([4, 'x', 2])).toEqual([0, 0, 0]);
        expect(parseSize([4, -2, 2])).toEqual([4, 0, 2]);
    });

    it('reads a malformed bakedVolume as never-baked, not as a stale bake', () => {
        expect(parseBakedVolume([1, 2, 3])).toBeNull();
        expect(parseBakedVolume([1, 2, 3, 4, 5, 'x'])).toBeNull();
        expect(parseBakedVolume([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('reports the world AABB of an ORIENTED box, which is wider than the box itself', () => {
        const node = new NavMeshNode('nav');
        node.size = [4, 2, 4];
        node.setRotation([0, 45, 0]);
        // Outside a scene nothing walks the graph, so the world matrix has to be asked for by hand.
        node.updateTransforms();
        const { min, max } = node.getBoundingBox();
        // A 4x4 square spun 45 degrees needs 4*sqrt(2) of AABB to hold it.
        expect(max[0] - min[0]).toBeCloseTo(4 * Math.SQRT2, 4);
        expect(max[1] - min[1]).toBeCloseTo(2, 4);
    });

    it('follows the node position, so the gizmo moves what gets baked', () => {
        const node = new NavMeshNode('nav');
        node.size = [2, 2, 2];
        node.setPosition([10, 0, 0]);
        node.updateTransforms();
        const { min, max } = node.getBoundingBox();
        expect(min[0]).toBeCloseTo(9, 6);
        expect(max[0]).toBeCloseTo(11, 6);
    });

    it('reports staleness only once the volume actually moves', () => {
        const node = bakedNode();
        node.size = [8, 4, 8];
        node.updateTransforms();
        node.bakedVolume = node.volumeBounds();
        expect(node.bakeIsStale).toBe(false);

        node.setPosition([5, 0, 0]);
        node.updateTransforms();
        expect(node.bakeIsStale).toBe(true);
    });

    it('never calls an unbaked node stale, however the volume is placed', () => {
        const node = new NavMeshNode('nav');
        node.size = [8, 4, 8];
        node.setPosition([100, 0, 0]);
        node.updateTransforms();
        expect(node.bakeIsStale).toBe(false);
    });

    it('leaves the baked contours in WORLD space when the node moves', () => {
        // The invariant the class comment promises: moving the node must not move an existing path.
        const node = bakedNode();
        const before = Array.from(node.data.vertices);
        node.setPosition([25, 9, -13]);
        expect(Array.from(node.data.vertices)).toEqual(before);
    });
});
