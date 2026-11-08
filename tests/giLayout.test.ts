import { describe, expect, it } from 'vitest';
import {
    GI_HIT_PROBES_PER_ROW, GI_IRRADIANCE_TILE, GI_VISIBILITY_TILE, giAtlasLayout, giAtlasSizes, giOctDecode,
    giOctEncode, giOctWrapOutside, giProbeBytes, gridCage, gridCoords, gridIndex, hitCacheSize, hitTileOrigin,
    irradianceTileOrigin, maxProbesPerVolume, probeDataTexel, tileBorderSource, tileDirections,
    tileSolidAngleIntegral, tileSolidAngles, tileTexelDirection, visibilityTileOrigin,
    giProbeDrawFlips, giProbeOfInstance, giProbeOverlayRadius,
} from '../src/graphics/render/gi/giLayout';
import { octDecodeDir, octEncodeDir, octWrapOutside } from '../src/graphics/render/reflectionAtlas';

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('the octahedral map', () => {
    it('round-trips directions', () => {
        for (const d of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-0.3, 0.8, -0.52], [0.577, -0.577, 0.577]]) {
            const len = Math.hypot(d[0], d[1], d[2]);
            const n = d.map(x => x / len);
            const e = giOctEncode(n);
            const back = giOctDecode(e[0], e[1]);
            expect(dot(back, n)).toBeGreaterThan(0.99999);
        }
    });

    it("is the reflection atlas's map, exactly", () => {
        for (const d of [[0, 0, 1], [0.2, -0.9, -0.38], [-0.7, 0.1, 0.7], [0.5, 0.5, -0.707]]) {
            expect(giOctEncode(d)).toEqual(octEncodeDir(d));
        }
        for (const [u, v] of [[0.3, -0.2], [0.9, 0.8], [-0.95, 0.6]]) {
            const a = giOctDecode(u, v), b = octDecodeDir([u, v]);
            for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], 6);
        }
        for (const [u, v] of [[1.1, 0.3], [-1.05, -0.5], [0.2, 1.2], [1.1, 1.1], [-1.1, 1.05]]) {
            const a = giOctWrapOutside(u, v), b = octWrapOutside([u, v]);
            expect(a[0]).toBeCloseTo(b[0], 9);
            expect(a[1]).toBeCloseTo(b[1], 9);
        }
    });

    it('maps the whole sphere to 4 pi, its area element du dv / |p|^3', () => {
        for (const n of [6, 8, 14, 16]) {
            expect(Math.abs(tileSolidAngleIntegral(n) / (4 * Math.PI) - 1)).toBeLessThan(0.005);
        }
    });

    it('gives per-texel solid angles summing to exactly 4 pi, largest at the face centres', () => {
        const w = tileSolidAngles(8);
        expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(4 * Math.PI, 4);
        // A centre texel (by the +Z vertex) covers less than one near the middle of the +x+y+z face.
        expect(w[3 * 8 + 3]).toBeLessThan(w[5 * 8 + 5]);
        expect(Math.max(...w) / Math.min(...w)).toBeLessThan(3 * Math.sqrt(3));
    });

    it('integrates a constant radiance L to E/pi = L for any normal', () => {
        const n = 8;
        const dirs = tileDirections(n);
        const w = tileSolidAngles(n);
        for (const normal of [[0, 0, 1], [0, 1, 0], [-1, 0, 0], [0.6, -0.48, 0.64]]) {
            let e = 0, wsum = 0;
            for (let i = 0; i < n * n; i++) {
                const c = Math.max(0, dot(normal, [dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]]));
                e += c * w[i];
                wsum += c * w[i];
            }
            // The integral of cos over the hemisphere is pi: E = pi L, E/pi = L.
            expect(Math.abs(e / Math.PI - 1)).toBeLessThan(0.05);
            // The normalized estimate the relight uses (sum L w / sum w) is exactly L.
            expect(e / wsum).toBeCloseTo(1, 10);
        }
    });

    it('gives unit directions at every texel', () => {
        const dirs = tileDirections(16);
        for (let i = 0; i < 256; i++) expect(Math.hypot(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2])).toBeCloseTo(1, 5);
    });
});

describe('tile borders', () => {
    it('copy the interior texel just across the fold, as the wrapped direction says', () => {
        for (const n of [6, 14]) {
            for (let ty = 0; ty <= n + 1; ty++) {
                for (let tx = 0; tx <= n + 1; tx++) {
                    const [sx, sy] = tileBorderSource(n, tx, ty);
                    expect(sx).toBeGreaterThanOrEqual(0);
                    expect(sy).toBeGreaterThanOrEqual(0);
                    expect(sx).toBeLessThan(n);
                    expect(sy).toBeLessThan(n);
                    // The border texel's centre, outside [-1, 1]^2, wrapped back in, is its source's centre.
                    const u = ((tx - 1 + 0.5) / n) * 2 - 1, v = ((ty - 1 + 0.5) / n) * 2 - 1;
                    const [wu, wv] = giOctWrapOutside(u, v);
                    expect(wu).toBeCloseTo(((sx + 0.5) / n) * 2 - 1, 6);
                    expect(wv).toBeCloseTo(((sy + 0.5) / n) * 2 - 1, 6);
                }
            }
        }
    });

    it('is a neighbour on the sphere: a border texel looks where the texel beside it does, near enough', () => {
        const n = 14;
        // The top border over column 3, and the interior texel below it.
        const [sx, sy] = tileBorderSource(n, 4, 0);
        const across = tileTexelDirection(n, sx, sy);
        const below = tileTexelDirection(n, 3, 0);
        expect(dot(across, below)).toBeGreaterThan(Math.cos(2 * (Math.PI / n)));
    });
});

describe('grids', () => {
    it('index and un-index probes', () => {
        const counts = [4, 3, 5];
        for (let k = 0; k < 5; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) {
            expect(gridCoords(gridIndex(i, j, k, counts), counts)).toEqual([i, j, k]);
        }
    });

    it('find the trilinear cage, clamped into the grid', () => {
        const idx = new Int32Array(8), w = new Float32Array(8);
        const counts = [3, 3, 3];
        gridCage([0.25, 1, 1.5], counts, idx, w);
        expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
        expect(idx[0]).toBe(gridIndex(0, 1, 1, counts));
        expect(w[0]).toBeCloseTo(0.75 * 1 * 0.5, 6);
        // On the last face: the cage is the last cell, weight on its far side.
        gridCage([2, 2, 2], counts, idx, w);
        expect(idx[7]).toBe(gridIndex(2, 2, 2, counts));
        expect(w[7]).toBeCloseTo(1, 6);
        // Outside: clamped.
        gridCage([-5, 9, 1], counts, idx, w);
        expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
        expect(Math.min(...idx)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...idx)).toBeLessThan(27);
    });
});

describe('atlases', () => {
    it('hold 16k probes at the WebGL2 minimum and 65k at 4096', () => {
        expect(giAtlasLayout(2048).capacity).toBe(16384);
        expect(giAtlasLayout(4096).capacity).toBe(65536);
        expect(giAtlasLayout(16384).maxSize).toBe(4096);
        expect(giAtlasLayout(0).maxSize).toBe(2048);
    });

    it('place tiles without overlap, inside the atlas', () => {
        const layout = giAtlasLayout(4096);
        const sizes = giAtlasSizes(layout, 7000);
        const seen = new Set<string>();
        for (const g of [0, 1, 511, 512, 6999]) {
            const [ix, iy] = irradianceTileOrigin(layout, g);
            expect(ix % GI_IRRADIANCE_TILE).toBe(0);
            expect(ix + GI_IRRADIANCE_TILE).toBeLessThanOrEqual(sizes.irradiance[0]);
            expect(iy + GI_IRRADIANCE_TILE).toBeLessThanOrEqual(sizes.irradiance[1]);
            const [vx, vy] = visibilityTileOrigin(layout, g);
            expect(vx + GI_VISIBILITY_TILE).toBeLessThanOrEqual(sizes.visibility[0]);
            expect(vy + GI_VISIBILITY_TILE).toBeLessThanOrEqual(sizes.visibility[1]);
            const [px, py] = probeDataTexel(layout, g);
            expect(px).toBeLessThan(sizes.probeData[0]);
            expect(py).toBeLessThan(sizes.probeData[1]);
            seen.add(`${ix},${iy}`);
        }
        expect(seen.size).toBe(5);
        expect(sizes.irradiance).toEqual([4096, 14 * 8]);
        expect(sizes.visibility).toEqual([4096, 28 * 16]);
    });

    it('lay out a hit cache 64 probes to a row', () => {
        expect(hitCacheSize(100, 64)).toEqual([512, 16]);
        expect(hitCacheSize(64, 256)).toEqual([1024, 16]);
        expect(hitTileOrigin(65, 64)).toEqual([8, 8]);
        expect(hitTileOrigin(63, 256)).toEqual([63 * 16, 0]);
        expect(maxProbesPerVolume(256, 2048)).toBe(GI_HIT_PROBES_PER_ROW * 128);
    });

    it('cost a few kilobytes a probe', () => {
        expect(giProbeBytes(64)).toBe(768 + 512 + 2048 + 16);
        expect(giProbeBytes(256)).toBe(3072 + 512 + 2048 + 16);
    });
});

describe('the probe overlay', () => {
    it('draws probes a fraction of their spacing across, held to 5-50 cm', () => {
        expect(giProbeOverlayRadius(1)).toBeCloseTo(0.12);
        expect(giProbeOverlayRadius(0.1)).toBe(0.05);
        expect(giProbeOverlayRadius(20)).toBe(0.5);
        expect(giProbeOverlayRadius(NaN)).toBe(0.05);
    });

    it('walks every probe once, farthest first and nearest last, from any side', () => {
        const counts = [4, 3, 5];
        const n = counts[0] * counts[1] * counts[2];
        for (const camera of [[-6, -2, -9], [9, 8, 12], [-6, 8, -3], [-6, 8, 1.5], [1.5, 1, 2]]) {
            const flips = giProbeDrawFlips(camera, counts);
            const seen = new Set<string>();
            const dist = (p: number[]) => Math.hypot(p[0] - camera[0], p[1] - camera[1], p[2] - camera[2]);
            const order: number[][] = [];
            for (let i = 0; i < n; i++) {
                const p = giProbeOfInstance(i, counts, flips);
                seen.add(p.join(','));
                order.push(p);
            }
            expect(seen.size).toBe(n);
            // Beyond the grid along every axis, the first is the farthest corner and the last the nearest.
            if (camera.every((c, a) => c < 0 || c > counts[a] - 1)) {
                const far = Math.max(...order.map(dist)), near = Math.min(...order.map(dist));
                expect(dist(order[0])).toBeCloseTo(far, 6);
                expect(dist(order[n - 1])).toBeCloseTo(near, 6);
            }
        }
    });
});
