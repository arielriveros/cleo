import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { mat4, quat, vec3 } from 'gl-matrix';
import { readExample } from '../tools/exampleKit/readExample.mjs';
import { LAYOUT, PIECES, FURNITURE_DRAW_DISTANCE, CANDLES, CANDLE_LUMENS, CANDLE_MODEL, modelIdOf, imageSize, jpegDcStep } from '../tools/valley/interiorProps';
import { INTERIOR_SHOTS } from '../tools/valley/cinematic/tour';

// The furniture in the Valley's two enterable houses (tools/valley/interiorProps.ts), read back from the shipped
// example. Nothing about a misplaced piece fails loudly: a cabinet through a wall, a bed floating over the boards
// or a table in the cinematic's aisle all load and render without a word. So this measures each piece against its
// house's own triangles (level 0, in the house's frame), and against the Long House shot's camera path.

const PROJECT = join(__dirname, '..', 'applications', 'editor', 'public', 'examples', 'valley');
const present = existsSync(join(PROJECT, 'manifest.json'));
const valley = present ? await readExample(PROJECT) : null;

const allNodes = (root: any): any[] => {
    const out: any[] = [];
    const walk = (n: any) => { out.push(n); for (const c of n.children ?? []) walk(c); };
    walk(root);
    return out;
};
const trs = (n: any) => mat4.fromRotationTranslationScale(mat4.create(),
    quat.fromEuler(quat.create(), ...((n.rotation ?? [0, 0, 0]) as [number, number, number])), n.position ?? [0, 0, 0], n.scale ?? [1, 1, 1]);

/** The Long House's frame to the world: the cinematic's `lh` (tools/valley/cinematic/tour.ts). */
const LONG_HOUSE = { x: -9, z: 39, yaw: -137.51 };
const lh = (lx: number, lz: number, y: number) => {
    const a = LONG_HOUSE.yaw * Math.PI / 180;
    return [LONG_HOUSE.x + Math.cos(a) * lx + Math.sin(a) * lz, y, LONG_HOUSE.z - Math.sin(a) * lx + Math.cos(a) * lz];
};
/** The interior shot's dolly, as the brief for the furniture states it: down the aisle at x -1.65, 4.2 m up. */
const DOLLY = [lh(-1.65, -6.5, 4.2), lh(-1.65, 2.2, 4.2)];
/** Long House boxes (its own frame, x/z) no piece may reach into. */
const LONG_HOUSE_CLEAR: [string, [number, number], [number, number]][] = [
    ['the aisle', [-3.07, -0.25], [-9.5, 8.4]],
    ['the sunlit patch', [0.2, 3.2], [-1.6, 1.6]],
    ['the +X door', [2.0, 4.0], [-0.9, 0.9]],
    ['the end door', [-0.9, 1.1], [7.0, 8.6]],
];
const OLD_HOUSE_CLEAR: [string, [number, number], [number, number]][] = [
    ['the door', [-1.2, 1.4], [5.4, 7.6]],
];

/** Whether a triangle (9 floats at `o`) overlaps the box at `c` with half extents `h` (Akenine-Möller's SAT). */
function triangleOverlapsBox(t: ArrayLike<number>, o: number, c: number[], h: number[]): boolean {
    const v = [0, 1, 2].map(k => [t[o + 3 * k] - c[0], t[o + 3 * k + 1] - c[1], t[o + 3 * k + 2] - c[2]]);
    for (let a = 0; a < 3; a++) {
        if (Math.min(v[0][a], v[1][a], v[2][a]) > h[a] || Math.max(v[0][a], v[1][a], v[2][a]) < -h[a]) return false;
    }
    const e = [0, 1, 2].map(k => [0, 1, 2].map(a => v[(k + 1) % 3][a] - v[k][a]));
    const cross = (p: number[], q: number[]) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const separates = (axis: number[]) => {
        const r = h[0] * Math.abs(axis[0]) + h[1] * Math.abs(axis[1]) + h[2] * Math.abs(axis[2]);
        const p = v.map(x => dot(axis, x));
        return Math.min(...p) > r || Math.max(...p) < -r;
    };
    for (const edge of e) for (const unit of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) if (separates(cross(unit, edge))) return false;
    return !separates(cross(e[0], e[1]));
}

/** Nearest hit of the ray o + t*d (t > 0) on the triangles, or Infinity (Möller-Trumbore, both faces). */
function cast(tris: Float64Array, o: number[], d: number[]): number {
    let best = Infinity;
    for (let i = 0; i < tris.length; i += 9) {
        const e1 = [tris[i + 3] - tris[i], tris[i + 4] - tris[i + 1], tris[i + 5] - tris[i + 2]];
        const e2 = [tris[i + 6] - tris[i], tris[i + 7] - tris[i + 1], tris[i + 8] - tris[i + 2]];
        const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
        const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
        if (Math.abs(det) < 1e-12) continue;
        const s = [o[0] - tris[i], o[1] - tris[i + 1], o[2] - tris[i + 2]];
        const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
        if (u < 0 || u > 1) continue;
        const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
        const w = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
        if (w < 0 || u + w > 1) continue;
        const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
        if (t > 1e-6 && t < best) best = t;
    }
    return best;
}

/** Distance from a point to an axis-aligned box. */
const pointToBox = (p: number[], min: number[], max: number[]) =>
    Math.hypot(...[0, 1, 2].map(a => Math.max(min[a] - p[a], 0, p[a] - max[a])));

describe.skipIf(!present)('the furniture in the Valley\'s houses', { timeout: 120_000 }, () => {
    const bundle = valley!.bundle;
    const manifest = bundle.manifest;
    const root = bundle.scenes[manifest.mainSceneId].scene;
    const buildings = root.children.find((c: any) => c.name === 'Buildings');
    const furniture = root.children.find((c: any) => c.name === 'Furniture');
    const models = new Map<string, any>(bundle.libraries.models.map((m: any) => [m.id, m]));
    const materials = new Map<string, any>(bundle.libraries.materials.map((m: any) => [m.id, m]));
    const textures = new Map<string, any>(bundle.textures.map((t: any) => [t.id, t]));

    /** Per house: its lodGroup, level 0's triangles in its frame, and each piece's vertices in that frame. */
    const houses = LAYOUT.map(layout => {
        const lod = buildings.children.find((b: any) => b.name === layout.house);
        const group = furniture?.children.find((g: any) => g.name === layout.group);
        const out: number[] = [];
        for (const n of allNodes(lod.children[0])) {
            if (n.type !== 'model') continue;
            const { positions: P, indices: I } = n.model.geometry;
            for (let i = 0; i < I.length; i++) out.push(P[I[i] * 3], P[I[i] * 3 + 1], P[I[i] * 3 + 2]);
        }
        const pieces = (group?.children ?? []).map((piece: any) => {
            const verts: number[] = [];
            const walk = (n: any, parent: mat4) => {
                const m = mat4.multiply(mat4.create(), parent, trs(n));
                if (n.type === 'model') {
                    const P = n.model.geometry.positions, v = vec3.create();
                    for (let i = 0; i < P.length; i += 3) { vec3.transformMat4(v, [P[i], P[i + 1], P[i + 2]], m); verts.push(v[0], v[1], v[2]); }
                }
                for (const c of n.children ?? []) walk(c, m);
            };
            walk(piece, mat4.create());
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < verts.length; i++) { min[i % 3] = Math.min(min[i % 3], verts[i]); max[i % 3] = Math.max(max[i % 3], verts[i]); }
            return { node: piece, verts, min, max };
        });
        return { layout, lod, group, tris: Float64Array.from(out), pieces };
    });

    it('stands a group per house where the house stands, beside the buildings, its pieces linked copies of library models', () => {
        expect(furniture).toBeDefined();
        expect(root.children.indexOf(furniture)).toBe(root.children.indexOf(buildings) + 1);
        expect(furniture.children.map((g: any) => g.name)).toEqual(LAYOUT.map(l => l.group));
        const refs = manifest.sceneMetas.find((m: any) => m.id === manifest.mainSceneId).refs;
        for (const { layout, lod, group, pieces } of houses) {
            expect([group.position, group.rotation, group.scale], layout.group).toEqual([lod.position, lod.rotation, [1, 1, 1]]);
            expect(pieces.map((p: any) => p.node.name), layout.group).toEqual(layout.pieces.map(p => p.name));
            for (const { node } of pieces) {
                const what = `${layout.house} / ${node.name}`;
                const asset = models.get(node.variables.__modelId.value);
                expect(asset, what).toBeDefined();
                expect(node.variables.__modelBaseTRS.value, what).toBe('[0,0,0,0,0,0,1,1,1]');
                // Culled from afar like any small prop, drawn in shadow maps, never moved: no script, no body.
                expect(node.drawDistance, what).toBe(FURNITURE_DRAW_DISTANCE);
                expect([node.scale, node.rotation[0], node.rotation[2]], what).toEqual([[1, 1, 1], 0, 0]);
                for (const n of allNodes(node)) {
                    expect(n.body ?? null, what).toBeNull();
                    expect(n.script ?? null, what).toBeNull();
                }
                const parts = allNodes(node).filter(n => n.type === 'model');
                expect(parts.length, what).toBeGreaterThan(0);
                for (const part of parts) {
                    const material = materials.get(part.variables.__materialId?.value);
                    expect(material, what).toBeDefined();
                    expect(part.model.material.config.castShadow, what).toBe(true);
                    expect(part.model.material, what).toEqual(material.material);
                }
                expect(refs.modelIds, what).toContain(asset.id);
                for (const m of asset.materialIds) expect(refs.materialIds, what).toContain(m);
                for (const t of asset.textureIds) expect(refs.textureIds, what).toContain(t);
            }
        }
    });

    it('keeps one library model per piece, with its material and maps filed under /Props/Furniture, the maps small JPEGs', () => {
        const entries = new Map<string, string[]>();
        for (const e of bundle.vfs.entries) entries.set(e.assetId, [...(entries.get(e.assetId) ?? []), e.path]);
        let bytes = 0;
        for (const spec of PIECES) {
            const asset = models.get(modelIdOf(spec.key));
            expect(asset, spec.name).toBeDefined();
            expect(asset.name).toBe(spec.name);
            expect(entries.get(asset.id), spec.name).toEqual([`/Props/Furniture/Models/${spec.name}.model`]);
            for (const m of asset.materialIds) {
                expect(materials.has(m), spec.name).toBe(true);
                expect(entries.get(m)?.[0], spec.name).toMatch(/^\/Props\/Furniture\/Materials\//);
            }
            expect(asset.textureIds.length, spec.name).toBeGreaterThanOrEqual(3);
            for (const t of asset.textureIds) {
                const tex = textures.get(t);
                expect(tex?.mime, spec.name).toBe('image/jpeg');
                const b = new Uint8Array(tex.bytes);
                expect(Math.max(...imageSize(b)), spec.name).toBeLessThanOrEqual(1024);
                // Quality 90 or below: none of the near-lossless maps some of the sources carry.
                expect(jpegDcStep(b), spec.name).toBeGreaterThanOrEqual(3);
                expect(entries.get(t)?.sort(), spec.name).toHaveLength(2);
                bytes += b.byteLength;
            }
        }
        expect(bytes).toBeLessThan(8 * 1048576);
    });

    it('stands every piece on its house\'s floor, inside its walls and clear of the other pieces', () => {
        for (const { layout, lod, tris, pieces } of houses) {
            // The house's interior exposure box, in the house's frame: every piece inside it.
            const room = allNodes(root).find(n => n.type === 'exposureVolume' && n.name === `${layout.house} Interior Exposure`);
            expect(room.rotation).toEqual(lod.rotation);
            const centre = vec3.transformMat4(vec3.create(), room.position, mat4.invert(mat4.create(), trs(lod)));
            const half = room.exposureVolume.size.map((s: number) => s / 2);
            for (const { node, verts, min, max } of pieces) {
                const what = `${layout.house} / ${node.name}`;
                for (const a of [0, 2]) {
                    expect(min[a], `${what} axis ${a}`).toBeGreaterThan(centre[a] - half[a]);
                    expect(max[a], `${what} axis ${a}`).toBeLessThan(centre[a] + half[a]);
                }
                expect(min[1], what).toBeCloseTo(node.position[1], 3);
                // On the boards: rays down over its footprint find nothing proud of its base (the sleepers
                // across the Long House stand seven centimetres up), and most land on the boards, within a few
                // centimetres of it. The rest fall through gaps the houses have: between boards, and along the
                // Long House's cross walls, which stand in a slot where the boards stop short.
                let on = 0;
                for (const fx of [0.05, 0.35, 0.65, 0.95]) for (const fz of [0.05, 0.35, 0.65, 0.95]) {
                    const x = min[0] + fx * (max[0] - min[0]), z = min[2] + fz * (max[2] - min[2]);
                    const t = cast(tris, [x, min[1] + 0.6, z], [0, -1, 0]);
                    const rise = Number.isFinite(t) ? 0.6 - t : -Infinity;
                    expect(rise, `${what}: floor at (${x.toFixed(2)}, ${z.toFixed(2)})`).toBeLessThan(0.035);
                    if (rise > -0.035) on++;
                }
                expect(on, `${what}: samples on the boards`).toBeGreaterThanOrEqual(12);
                // Through no wall, post or sill: no house triangle in its box (a centimetre in from its sides,
                // from just over the boards to its top).
                const lo = [min[0] + 0.01, min[1] + 0.12, min[2] + 0.01], hi = [max[0] - 0.01, max[1] - 0.01, max[2] - 0.01];
                const c = [0, 1, 2].map(a => (lo[a] + hi[a]) / 2), h = [0, 1, 2].map(a => (hi[a] - lo[a]) / 2);
                let through = 0;
                for (let i = 0; i < tris.length; i += 9) if (triangleOverlapsBox(tris, i, c, h)) through++;
                expect(through, `${what}: house triangles inside it`).toBe(0);
                expect(verts.length, what).toBeGreaterThan(0);
            }
            for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
                const p = pieces[i], q = pieces[j];
                const overlap = [0, 2].every(a => p.min[a] + 0.01 < q.max[a] && q.min[a] + 0.01 < p.max[a]);
                expect(overlap, `${layout.house}: ${p.node.name} and ${q.node.name}`).toBe(false);
            }
        }
    });

    it('backs each piece onto the walls it is laid against', () => {
        for (const { layout, tris, pieces } of houses) {
            pieces.forEach(({ node, min, max }: any, i: number) => {
                for (const wall of layout.pieces[i].against ?? []) {
                    const axis = wall[1] === 'x' ? 0 : 2, sign = wall[0] === '+' ? 1 : -1, other = 2 - axis;
                    const face = sign > 0 ? max[axis] : min[axis];
                    // The nearest of the wall (or a post or the sill beam at its foot) across the piece's back,
                    // low to high: a few centimetres off, never into it.
                    let gap = Infinity;
                    for (let f = 0.05; f < 1; f += 0.1) for (const up of [0.04, 0.2 * (max[1] - min[1]), 0.5 * (max[1] - min[1]), 0.85 * (max[1] - min[1])]) {
                        const o = [0, min[1] + up, 0];
                        o[axis] = (min[axis] + max[axis]) / 2;
                        o[other] = min[other] + f * (max[other] - min[other]);
                        const d = [0, 0, 0]; d[axis] = sign;
                        gap = Math.min(gap, cast(tris, o, d) - Math.abs(face - o[axis]));
                    }
                    expect(gap, `${layout.house} / ${node.name} against ${wall}`).toBeGreaterThan(0);
                    expect(gap, `${layout.house} / ${node.name} against ${wall}`).toBeLessThan(0.08);
                }
            });
        }
    });

    it('keeps the Long House\'s aisle, its sunlit patch and its doorways clear, a metre and more off the dolly', async () => {
        const { Spline3 } = await import('../src/core/math');
        const long = houses.find(h => h.layout.house === 'Long House')!;
        const world = mat4.multiply(mat4.create(), trs(furniture), trs(long.group));
        const paths = (allNodes(root).find(n => n.type === 'sequence' && n.name === 'Valley Tour')
            ?.sequence.tracks.find((t: any) => t.type === 'path')?.sections ?? []).filter((s: any) => INTERIOR_SHOTS.includes(s.id));
        expect(paths.length).toBe(INTERIOR_SHOTS.length);
        for (const { node, verts } of long.pieces) {
            const what = `Long House / ${node.name}`;
            // In the house's frame: not one vertex in the aisle, the patch or before a door. A rug lies flat
            // on the boards, so it may lie in the sun before the +X door: the patch is there to land on it.
            let lo = Infinity, hi = -Infinity;
            for (let i = 1; i < verts.length; i += 3) { lo = Math.min(lo, verts[i]); hi = Math.max(hi, verts[i]); }
            const flat = hi - lo < 0.1;
            for (const [label, [x0, x1], [z0, z1]] of LONG_HOUSE_CLEAR) {
                if (flat && (label === 'the sunlit patch' || label === 'the +X door')) continue;
                let inside = 0;
                for (let i = 0; i < verts.length; i += 3) if (verts[i] > x0 && verts[i] < x1 && verts[i + 2] > z0 && verts[i + 2] < z1) inside++;
                expect(inside, `${what}: vertices in ${label}`).toBe(0);
            }
            // In the world: its bounding box a metre or more from the dolly's line, and from the shipped shot.
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], v = vec3.create();
            for (let i = 0; i < verts.length; i += 3) {
                vec3.transformMat4(v, [verts[i], verts[i + 1], verts[i + 2]], world);
                for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], v[a]); max[a] = Math.max(max[a], v[a]); }
            }
            let nearest = Infinity;
            for (let k = 0; k <= 400; k++) {
                const t = k / 400, p = [0, 1, 2].map(a => DOLLY[0][a] + t * (DOLLY[1][a] - DOLLY[0][a]));
                nearest = Math.min(nearest, pointToBox(p, min, max));
            }
            expect(nearest, `${what}: from the dolly`).toBeGreaterThanOrEqual(1.0);
            for (const path of paths) {
                const s = new Spline3(path.points);
                let shot = Infinity;
                for (let k = 0; k <= 400; k++) shot = Math.min(shot, pointToBox(s.pointAt(k / 400), min, max));
                expect(shot, `${what}: from ${path.id}`).toBeGreaterThanOrEqual(1.0);
            }
        }
    });

    it('lays the rug flat in the Long House\'s sunlit patch, before the +X door and inside its posts', () => {
        const long = houses.find(h => h.layout.house === 'Long House')!;
        const rug = long.pieces.find((p: any) => p.node.name === 'Rug')!;
        expect(rug).toBeDefined();
        expect(rug.max[1] - rug.min[1]).toBeLessThan(0.1);
        // Across the door's whole width (z -0.8..0.8) and most of the patch's depth, short of its posts (x 3.61).
        expect(rug.min[2]).toBeLessThan(-0.8);
        expect(rug.max[2]).toBeGreaterThan(0.8);
        expect(rug.max[0]).toBeLessThan(3.6);
        expect(rug.max[0]).toBeGreaterThan(3.4);
        expect(rug.min[0]).toBeLessThan(2.0);
        expect(rug.min[0]).toBeGreaterThan(-0.25);
    });

    it('stands the candles on the furniture\'s tops, each with a flame and a small unshadowed light under the Fire Light', () => {
        const candles = root.children.find((c: any) => c.name === 'Candles');
        expect(candles).toBeDefined();
        expect(root.children.indexOf(candles)).toBe(root.children.indexOf(furniture) + 1);
        const fireLight = bundle.libraries.scripts.find((s: any) => s.name === 'Fire Light');
        expect(models.get(CANDLE_MODEL)?.name).toBe('Candle');
        for (const { layout, lod, pieces } of houses) {
            const group = candles.children.find((g: any) => g.name === `${layout.house} Candles`);
            expect(group.position).toEqual(lod.position);
            expect(group.rotation).toEqual(lod.rotation);
            const spots = CANDLES[layout.house];
            expect(group.children.length).toBe(spots.reduce((n, s) => n + s.at.length, 0));
            let k = 0;
            for (const { on, at } of spots) {
                const under = pieces.find((p: any) => p.node.name === on)!;
                for (const _ of at) {
                    const c = group.children[k++], what = `${layout.house}: a candle on the ${on}`;
                    // On the piece's top, well inside its edges.
                    expect(c.position[1], what).toBeCloseTo(under.max[1], 2);
                    for (const a of [0, 2]) {
                        expect(c.position[a], `${what} axis ${a}`).toBeGreaterThan(under.min[a] + 0.05);
                        expect(c.position[a], `${what} axis ${a}`).toBeLessThan(under.max[a] - 0.05);
                    }
                    expect(c.variables.__scriptId.value, what).toBe(fireLight.id);
                    // The wax a linked copy of the library's candle (a node over its model), its flame and its light.
                    expect(c.children.map((n: any) => n.type).sort(), what).toEqual(['animatedSprite', 'light', 'node']);
                    const light = c.children.find((n: any) => n.type === 'light');
                    expect(light.castShadows, what).toBe(false);
                    expect(light.light.intensity, what).toBe(CANDLE_LUMENS);
                    expect(light.bake, what).not.toBe(false);
                    expect(c.children.find((n: any) => n.name === 'Wax').variables.__modelId.value, what).toBe(CANDLE_MODEL);
                }
            }
        }
    });

    it('keeps the Old House\'s doorway clear', () => {
        const old = houses.find(h => h.layout.house === 'Old House')!;
        for (const { node, verts } of old.pieces) for (const [label, [x0, x1], [z0, z1]] of OLD_HOUSE_CLEAR) {
            let inside = 0;
            for (let i = 0; i < verts.length; i += 3) if (verts[i] > x0 && verts[i] < x1 && verts[i + 2] > z0 && verts[i + 2] < z1) inside++;
            expect(inside, `Old House / ${node.name}: vertices in ${label}`).toBe(0);
        }
    });
});
