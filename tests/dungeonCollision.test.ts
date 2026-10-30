import { describe, it, expect } from 'vitest';
import { blockedAt, buildColliders, reachability, topAt, walkableSoup } from '../tools/valley/dungeon/collision.mjs';
import { doorFrames, openDoorways } from '../tools/valley/dungeon/structure.mjs';

// The Valley dungeon's colliders are generated from its render mesh (tools/valley/dungeon/collision.mjs):
// boxes over floors and walls, ramps over stairs, wedges over steps. These build a small room the same way
// the dungeon is modelled — a floor, walls with a doorway cut in them, a staircase up to a ledge — and check
// that what a capsule can do over the result is what the room means.

type Part = { name: string; material: number; positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array };

/** An axis-aligned box as a part, every face wound outward. */
function boxPart(name: string, min: number[], max: number[]): Part {
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
    const faces: [number, number][] = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
    for (const [axis, sign] of faces) {
        const u = (axis + 1) % 3, v = (axis + 2) % 3;
        const base = positions.length / 3;
        for (const [su, sv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
            const p = [0, 0, 0];
            p[axis] = sign > 0 ? max[axis] : min[axis];
            p[u] = su ? max[u] : min[u];
            p[v] = sv ? max[v] : min[v];
            positions.push(...p);
            const n = [0, 0, 0]; n[axis] = sign;
            normals.push(...n);
            uvs.push(su, sv);
        }
        // (u, v) counter-clockwise has normal +axis; flip for the negative face.
        if (sign > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    return { name, material: 0, positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

function merge(name: string, parts: Part[]): Part {
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
    for (const p of parts) {
        const base = positions.length / 3;
        positions.push(...p.positions); normals.push(...p.normals); uvs.push(...p.uvs);
        indices.push(...Array.from(p.indices, i => i + base));
    }
    return { name, material: 0, positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

const boundsOf = (parts: Part[]) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of parts) for (let k = 0; k < p.positions.length; k += 3)
        for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p.positions[k + a]); max[a] = Math.max(max[a], p.positions[k + a]); }
    return { min, max, size: max.map((v, a) => v - min[a]) };
};

/**
 * A 10 x 10 room, walls 4 m high and 0.4 thick. The east wall (x = 5) has a doorway framed but not cut, the
 * way the dungeon's file has some. A staircase of eight 0.5 m risers on 0.6 m treads climbs along +X to a
 * ledge 4 m up against the west wall's outside... kept inside: it climbs from x = -4 to a ledge at x -0.2..4.
 */
function room() {
    const floor = boxPart('Floors', [-5, -0.3, -5], [5, 0, 5]);
    const ledge = boxPart('Floors', [0.6, 3.7, -5], [5, 4, -2]);
    const walls = merge('Walls', [
        boxPart('Walls', [-5.4, 0, -5.4], [5.4, 6, -5]),
        boxPart('Walls', [-5.4, 0, 5], [5.4, 6, 5.4]),
        boxPart('Walls', [-5.4, 0, -5], [-5, 6, 5]),
        boxPart('Walls', [5, 0, -5], [5.4, 6, 5]),
    ]);
    // Outside the doorway, so there is somewhere to go through it to.
    const yard = boxPart('Floors', [5, -0.3, -2], [9, 0, 2]);
    // A frame round the east doorway, z -0.8..0.8, 2.4 m up to its lintel.
    const frame = merge('Frames', [
        boxPart('Frames', [4.8, 0, -1.1], [5.6, 2.4, -0.8]),
        boxPart('Frames', [4.8, 0, 0.8], [5.6, 2.4, 1.1]),
        boxPart('Frames', [4.8, 2.4, -1.1], [5.6, 2.7, 1.1]),
    ]);
    // Eight steps along +X from x = -4.2, each 0.6 deep and 0.5 higher, z -5..-2, up to the ledge at 4.
    const steps = merge('Stairs', Array.from({ length: 8 }, (_, i) =>
        boxPart('Stairs', [-4.2 + i * 0.6, 0, -5], [-3.6 + i * 0.6, 0.5 * (i + 1), -2])));
    return [floor, ledge, walls, yard, frame, steps];
}

describe('dungeon colliders from a render mesh', () => {
    it('lays floor boxes under the floor and wall boxes along the walls', () => {
        const parts = room();
        const { boxes } = buildColliders(parts, boundsOf(parts));
        const floors = boxes.filter(b => b.kind === 'floor');
        expect(floors.some(b => topAt(b, 0, 0) !== null && Math.abs(topAt(b, 0, 0)! - 0) < 0.03)).toBe(true);
        const walls = boxes.filter(b => b.kind === 'wall');
        // Something solid at the north wall's face, standing a body's height.
        expect(walls.some(b => Math.abs(b.center[2] - -4.9) < 0.3 && b.center[1] + b.size[1] / 2 > 1.6)).toBe(true);
    });

    it('turns a staircase into one ramp under 45 degrees, resting on the nosings', () => {
        const parts = room();
        const { boxes } = buildColliders(parts, boundsOf(parts));
        const ramps = boxes.filter(b => b.kind === 'ramp');
        expect(ramps).toHaveLength(1);
        const slope = Math.abs(ramps[0].rotation[0]);
        expect(slope).toBeGreaterThan(35);
        expect(slope).toBeLessThan(45);
        // Over the middle of a tread the ramp is above the tread, never below it.
        const tread = 0.5 * 4;  // the 4th step's top, at x -2.1 .. -1.5
        expect(topAt(ramps[0], -1.8, -3.5)!).toBeGreaterThanOrEqual(tread - 0.01);
    });

    it('leaves a framed doorway shut until it is cut, and passable after', () => {
        const shut = room();
        const before = reachability(buildColliders(shut, boundsOf(shut)).boxes, [0, 0, 2]);
        expect(before.reaches([7, 0, 0])).toBe(false);

        const open = room();
        const frames = doorFrames(open);
        expect(frames).toHaveLength(1);
        expect(openDoorways(open, frames)).toBeGreaterThan(0);
        const after = reachability(buildColliders(open, boundsOf(open)).boxes, [0, 0, 2]);
        expect(after.reaches([7, 0, 0])).toBe(true);
    });

    it('lets a capsule walk up the stairs to the ledge, and builds a navmesh soup over all of it', () => {
        const parts = room();
        const { boxes } = buildColliders(parts, boundsOf(parts));
        const reach = reachability(boxes, [0, 0, 2]);
        expect(reach.reaches([3, 4, -3.5])).toBe(true);
        const soup = walkableSoup(reach);
        expect(soup.indices.length / 3).toBe(reach.cells.size * 2);
        // Every triangle faces up.
        const P = soup.positions, I = soup.indices;
        for (let k = 0; k < I.length; k += 3) {
            const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
            const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
            expect(e1[2] * e2[0] - e1[0] * e2[2]).toBeGreaterThan(0);
        }
    });
});

/** A thin wall slab from (x0, z0) to (x1, z1), `thick` across, `height` tall, as a part: two quads, one each side. */
function diagonalWall(name: string, x0: number, z0: number, x1: number, z1: number, thick: number, height: number): Part {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const nx = -(z1 - z0) / len * thick / 2, nz = (x1 - x0) / len * thick / 2;
    const positions: number[] = [], indices: number[] = [];
    for (const s of [1, -1]) {
        const base = positions.length / 3;
        const ax = x0 + nx * s, az = z0 + nz * s, bx = x1 + nx * s, bz = z1 + nz * s;
        positions.push(ax, 0, az, bx, 0, bz, bx, height, bz, ax, height, az);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { name, material: 0, positions: Float32Array.from(positions), normals: new Float32Array(positions.length), uvs: new Float32Array(positions.length / 3 * 2), indices: Uint32Array.from(indices) };
}

describe('dungeon colliders: few boxes', () => {
    it('makes a hollow pillar one box, flagged see-through', () => {
        const floor = boxPart('Floors', [-3, -0.3, -3], [3, 0, 3]);
        // Four faces of a 1 m square pillar, open inside the way the dungeon's are modelled.
        const pillar = boxPart('Pillars', [-0.5, 0, -0.5], [0.5, 4, 0.5]);
        const parts = [floor, pillar];
        const walls = buildColliders(parts, boundsOf(parts)).boxes.filter(b => b.kind === 'wall');
        expect(walls).toHaveLength(1);
        expect(walls[0].seeThrough).toBe(true);
        expect(walls[0].size[0]).toBeGreaterThanOrEqual(1);
        expect(walls[0].size[2]).toBeGreaterThanOrEqual(1);
    });

    it('lays a diagonal wall as one turned box that still blocks along its whole length', () => {
        const floor = boxPart('Floors', [-6, -0.3, -6], [6, 0, 6]);
        const wall = diagonalWall('Walls', -4, -3, 4, 3, 0.3, 3);
        const parts = [floor, wall];
        const walls = buildColliders(parts, boundsOf(parts)).boxes.filter(b => b.kind === 'wall');
        expect(walls.length).toBeLessThanOrEqual(2);
        const turned = walls.find(b => b.rotation[1] !== 0)!;
        expect(turned).toBeDefined();
        // Blocks a capsule standing on the wall's line anywhere along it, and not one 1.5 m off it.
        for (const t of [-0.8, -0.4, 0, 0.4, 0.8])
            expect(blockedAt(walls, 4 * t, 0, 3 * t)).not.toBeNull();
        expect(blockedAt(walls, -0.9, 0, 1.2)).toBeNull();
    });
});
