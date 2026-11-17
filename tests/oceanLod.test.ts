import { describe, it, expect } from 'vitest';
import { OCEAN_LEVELS, oceanMorph, oceanRange, selectOceanTiles, type OceanTile } from '../src/water/oceanLod';

// The endless ocean's tiles (water/oceanLod.ts): wherever the camera is, every point of the sea within the
// top level's range is under exactly one tile, and where two tiles meet their morphed edges are the same
// vertices, so the surface has no hole, no overlap and no crack. The old ring layout failed the first for
// any camera at negative coordinates (the sea ended at x = 0).

const LEVEL = 32;
const CAMERAS: [number, number, number][] = [
    [-100, 30, -100], [0, 10, 0], [4096, 50, -4096], [-1500, 80, 2000], [123.4, 2, -77.7], [-30000, 400, 15000],
];

const covering = (tiles: OceanTile[], x: number, z: number) =>
    tiles.filter(t => x >= t.x0 && x < t.x0 + t.size && z >= t.z0 && z < t.z0 + t.size);

describe('ocean LOD', () => {
    it('covers every point round the camera exactly once, from any position', () => {
        for (const cam of CAMERAS) {
            const tiles = selectOceanTiles(cam, LEVEL, 2);
            // Rings of points out to a long way, and a dense patch near the camera.
            const reach = oceanRange(OCEAN_LEVELS - 1) * 0.6;
            for (let r = 1; r < reach; r *= 1.37) for (let a = 0; a < 24; a++) {
                const x = cam[0] + Math.cos(a / 24 * Math.PI * 2 + r) * r, z = cam[2] + Math.sin(a / 24 * Math.PI * 2 + r) * r;
                expect(covering(tiles, x, z).length, `camera ${cam} point ${x},${z}`).toBe(1);
            }
            for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) {
                expect(covering(tiles, cam[0] + i * 3.1, cam[2] + j * 3.1).length).toBe(1);
            }
            // Fine near the camera, coarse far away.
            const near = covering(tiles, cam[0] + 1, cam[2] + 1)[0];
            const far = covering(tiles, cam[0] + 50000, cam[2])[0];
            expect(near.size).toBeLessThan(far.size);
        }
    });

    it('stays a few hundred draws all round, and a couple of hundred in a view', () => {
        for (const cam of CAMERAS) {
            expect(selectOceanTiles(cam, LEVEL, 2).length).toBeLessThan(600);
            // A 90 degree view toward +X.
            const inView = (min: number[], max: number[]) => max[0] - cam[0] > Math.abs(Math.max(min[2] - cam[2], 0, cam[2] - max[2])) - 1e-6;
            expect(selectOceanTiles(cam, LEVEL, 2, inView).length).toBeLessThan(250);
        }
    });

    it('shares its edge vertices with every neighbour once morphed (no cracks)', () => {
        const key = (p: number[]) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)}`;
        for (const cam of CAMERAS.slice(0, 4)) {
            const tiles = selectOceanTiles(cam, LEVEL, 2);
            const edgeVertices = (t: OceanTile, side: number): number[][] => {
                const out: number[][] = [];
                for (let i = 0; i <= t.quads; i++) {
                    const u = i / t.quads;
                    const [gx, gz] = side === 0 ? [u, 0] : side === 1 ? [1, u] : side === 2 ? [u, 1] : [0, u];
                    out.push(oceanMorph(t, gx, gz, cam, LEVEL, [0, 0]));
                }
                return out;
            };
            let checked = 0;
            for (const a of tiles) {
                if (Math.hypot(a.x0 - cam[0], a.z0 - cam[2]) > 5000) continue;
                for (let side = 0; side < 4; side++) {
                    // The neighbour across the middle of this edge.
                    const mx = side === 1 ? a.x0 + a.size + 0.01 : side === 3 ? a.x0 - 0.01 : a.x0 + a.size / 2;
                    const mz = side === 0 ? a.z0 - 0.01 : side === 2 ? a.z0 + a.size + 0.01 : a.z0 + a.size / 2;
                    const b = covering(tiles, mx, mz)[0];
                    // Only from the smaller side: a bigger neighbour's edge is longer than this one's.
                    if (!b || b.size < a.size) continue;
                    const mine = new Set(edgeVertices(a, side).map(key));
                    const along = side === 0 || side === 2;
                    const lo = along ? a.x0 : a.z0, hi = lo + a.size;
                    const theirs = new Set(edgeVertices(b, (side + 2) % 4)
                        .filter(p => (along ? p[0] : p[1]) >= lo - 1e-6 && (along ? p[0] : p[1]) <= hi + 1e-6).map(key));
                    expect([...mine].sort(), `levels ${a.level} / ${b.level}`).toEqual([...theirs].sort());
                    checked++;
                }
            }
            expect(checked).toBeGreaterThan(20);
        }
    });

    it('culls tiles the frustum rejects', () => {
        // Only what lies to +X of the camera.
        const cam: [number, number, number] = [0, 20, 0];
        const all = selectOceanTiles(cam, LEVEL, 2).length;
        const half = selectOceanTiles(cam, LEVEL, 2, (_min, max) => max[0] > cam[0]).length;
        expect(half).toBeLessThan(all);
        expect(half).toBeGreaterThan(all / 4);
    });
});
