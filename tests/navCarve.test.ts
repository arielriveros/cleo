import { describe, it, expect } from 'vitest';
import { mat4, quat } from 'gl-matrix';
import { bakeNavMesh } from '../src/ai/navBake';
import type { TriangleSoup } from '../src/ai/navBake';
import { buildNavMesh } from '../src/ai/navMesh';
import { carveSoup, navObstacleFor, navSourceForShape, tessellateSources } from '../src/ai/navSources';
import type { NavCarveOptions, NavObstacle, NavPrimitive, NavSource } from '../src/ai/navSources';

// Carving is measured from the floor's own PLANE, and most of these tests exist because the cheap
// "obstacle top vs floor height" version gets one of them wrong: a ramp carving itself, a slab carving
// its own top, a lintel overhead closing the doorway under it.

const OPTIONS: NavCarveOptions = { agentRadius: 0.5, agentHeight: 1.8, stepHeight: 0.3, maxSlope: 45 };

function floor(x0: number, z0: number, x1: number, z1: number, y = 0): TriangleSoup {
    return {
        positions: new Float32Array([
            x0, y, z0, x0, y, z1, x1, y, z1,
            x0, y, z0, x1, y, z1, x1, y, z0,
        ]),
        indices: new Uint32Array(0),
    };
}

function placed(primitive: NavPrimitive, position: [number, number, number], rotation?: quat): NavSource {
    return {
        primitive,
        transform: mat4.fromRotationTranslation(mat4.create(), rotation ?? quat.create(), position),
    };
}

function box(size: [number, number, number], position: [number, number, number], rotation?: quat): NavObstacle {
    return navObstacleFor(placed({ kind: 'box', size }, position, rotation))!;
}

/** Total XZ-projected area of the soup's upward triangles. */
function area(soup: TriangleSoup): number {
    let total = 0;
    const p = soup.positions;
    for (let i = 0; i + 8 < p.length; i += 9) {
        const ux = p[i + 3] - p[i], uz = p[i + 5] - p[i + 2];
        const vx = p[i + 6] - p[i], vz = p[i + 8] - p[i + 2];
        total += Math.abs(ux * vz - uz * vx) / 2;
    }
    return total;
}

/** Whether any triangle covers the XZ point. */
function covers(soup: TriangleSoup, x: number, z: number): boolean {
    const p = soup.positions;
    for (let i = 0; i + 8 < p.length; i += 9) {
        const s = (ax: number, az: number, bx: number, bz: number) => (bx - ax) * (z - az) - (bz - az) * (x - ax);
        const d1 = s(p[i], p[i + 2], p[i + 3], p[i + 5]);
        const d2 = s(p[i + 3], p[i + 5], p[i + 6], p[i + 8]);
        const d3 = s(p[i + 6], p[i + 8], p[i], p[i + 2]);
        const neg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
        const pos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
        if (!(neg && pos)) return true;
    }
    return false;
}

describe('carveSoup', () => {
    it('cuts a pillar out of the floor, padded by the agent radius', () => {
        const carved = carveSoup(floor(-5, -5, 5, 5), [box([1, 3, 1], [0, 1.5, 0])], OPTIONS);
        expect(covers(carved, 0, 0)).toBe(false);
        expect(covers(carved, 0.9, 0)).toBe(false);   // inside the pad
        expect(covers(carved, 1.2, 0)).toBe(true);    // clear of it
        // A 1x1 square grown by 0.5 with rounded corners is 1 + 4*0.5 + pi*0.25 = 3.79; the octagonal
        // pad circumscribes the disc, so a little more is removed, never less.
        const removed = 100 - area(carved);
        expect(removed).toBeGreaterThan(3.78);
        expect(removed).toBeLessThan(4.1);
    });

    it('leaves the floor under a lintel higher than the agent', () => {
        const carved = carveSoup(floor(-5, -5, 5, 5), [box([4, 0.5, 1], [0, 2.25, 0])], OPTIONS);
        expect(area(carved)).toBeCloseTo(100, 4);
    });

    it('does not carve a slab out of its own top, nor anything below the floor', () => {
        const slab = box([10, 0.5, 10], [0, -0.25, 0]);
        const buried = box([2, 2, 2], [0, -2, 0]);
        expect(area(carveSoup(floor(-5, -5, 5, 5), [slab, buried], OPTIONS))).toBeCloseTo(100, 4);
    });

    it('steps over something lower than the step height', () => {
        const kerb = box([1, 0.2, 1], [0, 0.1, 0]);
        expect(area(carveSoup(floor(-5, -5, 5, 5), [kerb], OPTIONS))).toBeCloseTo(100, 4);
    });

    it('keeps a ramp surface its own solid lies under', () => {
        const tilt = quat.setAxisAngle(quat.create(), [1, 0, 0], -16 * Math.PI / 180);
        const ramp = placed({ kind: 'box', size: [2, 0.4, 5] }, [0, 0.6, 0], tilt);
        const surface = tessellateSources([ramp]);
        const carved = carveSoup(surface, [navObstacleFor(ramp)!], OPTIONS);
        expect(area(carved)).toBeCloseTo(area(surface), 3);
    });

    it('carves a rotated box at its rotated footprint', () => {
        const yaw = quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI / 4);
        const wall = box([6, 2, 0.4], [0, 1, 0], yaw);
        const carved = carveSoup(floor(-5, -5, 5, 5), [wall], { ...OPTIONS, agentRadius: 0 });
        // +X rotated 45 degrees about +Y lands on (+x, -z).
        expect(covers(carved, 2, -2)).toBe(false);
        expect(covers(carved, 2, 2)).toBe(true);
    });

    it('passes walls and ceilings through untouched', () => {
        const wall: TriangleSoup = {
            positions: new Float32Array([0, 0, 0, 0, 4, 0, 4, 4, 0]),
            indices: new Uint32Array(0),
        };
        expect(carveSoup(wall, [box([1, 3, 1], [1, 1.5, 0])], OPTIONS).positions).toEqual(wall.positions);
    });
});

describe('bakeNavMesh with obstacles', () => {
    const pillar = box([1, 3, 1], [0, 1.5, 0]);

    it('routes around a pillar instead of through it', () => {
        const result = bakeNavMesh(floor(-5, -5, 5, 5), undefined, { obstacles: [pillar], agentRadius: 0.5 });
        const mesh = buildNavMesh(result.data, { merge: false })!;
        const path = mesh.findPath([-4, 0, 0], [4, 0, 0]);
        expect(path.length).toBeGreaterThan(2);
        // Sample every leg: none may cross the pillar's own square.
        for (let i = 0; i + 1 < path.length; i++) {
            for (let s = 0; s <= 20; s++) {
                const x = path[i][0] + (path[i + 1][0] - path[i][0]) * s / 20;
                const z = path[i][2] + (path[i + 1][2] - path[i][2]) * s / 20;
                expect(Math.abs(x) > 0.5 || Math.abs(z) > 0.5).toBe(true);
            }
        }
    });

    it('closes a gap narrower than the agent', () => {
        const walls = [box([4.7, 3, 0.4], [-2.65, 1.5, 0]), box([4.7, 3, 0.4], [2.65, 1.5, 0])];
        const narrow = bakeNavMesh(floor(-5, -5, 5, 5), undefined, { obstacles: walls, agentRadius: 0.45 });
        expect(buildNavMesh(narrow.data, { merge: false })!.findPath([0, 0, -4], [0, 0, 4])).toHaveLength(0);

        const slim = bakeNavMesh(floor(-5, -5, 5, 5), undefined, { obstacles: walls, agentRadius: 0.1 });
        expect(buildNavMesh(slim.data, { merge: false })!.findPath([0, 0, -4], [0, 0, 4]).length).toBeGreaterThan(0);
    });

    it('changes nothing with carving off', () => {
        const plain = bakeNavMesh(floor(-5, -5, 5, 5));
        const off = bakeNavMesh(floor(-5, -5, 5, 5), { carve: false }, { obstacles: [pillar], agentRadius: 0.5 });
        expect(off.regions).toBe(plain.regions);
        expect(Array.from(off.data.vertices)).toEqual(Array.from(plain.data.vertices));
    });
});

describe('navSourceForShape', () => {
    it('folds the owner scale into box dimensions, not the matrix', () => {
        const source = navSourceForShape(
            { type: 'box', offset: [0, 1, 0], rotation: [0, 0, 0], width: 1, height: 2, depth: 1 },
            mat4.create(), [2, 3, 2])!;
        expect(source.primitive).toEqual({ kind: 'box', size: [2, 6, 2] });
        // The offset is scaled too: 1 * 3.
        expect(source.transform[13]).toBeCloseTo(3);
        expect(source.transform[0]).toBeCloseTo(1);
    });

    it('turns spheres and capsules into obstacles with no surface', () => {
        const capsule = navSourceForShape(
            { type: 'capsule', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 0.4, height: 2 },
            mat4.fromTranslation(mat4.create(), [0, 1, 0]), [1, 1, 1])!;
        expect(tessellateSources([capsule]).positions.length).toBe(0);
        const obstacle = navObstacleFor(capsule)!;
        expect(obstacle.min[1]).toBeLessThanOrEqual(0);
        expect(obstacle.max[1]).toBeGreaterThanOrEqual(2);
        expect(obstacle.max[0]).toBeGreaterThanOrEqual(0.4);
    });
});
