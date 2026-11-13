import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { mat4, quat, vec3 } from 'gl-matrix';
import { readExample } from '../tools/exampleKit/readExample.mjs';
import { ROADS, HAMLET, catmullRom, distanceToPolyline } from '../tools/valley/layout.mjs';
import { terrainHeightSampler } from '../tools/valley/cinematic/terrainHeight';
import { imageSize, jpegDcStep } from '../tools/valley/interiorProps';
import {
    LANTERN, LIGHT_POLE_DRAW_DISTANCE, WELL_DRAW_DISTANCE, ROAD_POLES, SQUARE_POLES, POLE_LIGHT, modelIdOf,
} from '../tools/valley/hamletDressing';

// The hamlet's set dressing (tools/valley/hamletDressing.ts), read back from the shipped Valley: the well on the
// square and the light poles along the stone trail that replaced the standing torches. A misplaced prop fails
// silently: a pole floating over a bank or standing in the road, a lamp the tour's camera flies through, a well
// inside a house all load and render without a word. So this measures each against the landscape, the main
// road, the houses' own triangles and every camera sample of the Valley Tour.

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

/** Every model vertex under `node` in the world (its parent at the origin), and their bounds. */
function worldVertices(node: any) {
    const verts: number[] = [];
    const walk = (n: any, parent: mat4) => {
        const m = mat4.multiply(mat4.create(), parent, trs(n));
        if (n.type === 'model' && n.model?.geometry) {
            const P = n.model.geometry.positions, v = vec3.create();
            for (let i = 0; i < P.length; i += 3) { vec3.transformMat4(v, [P[i], P[i + 1], P[i + 2]], m); verts.push(v[0], v[1], v[2]); }
        }
        for (const c of n.children ?? []) walk(c, m);
    };
    walk(node, mat4.create());
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < verts.length; i++) { min[i % 3] = Math.min(min[i % 3], verts[i]); max[i % 3] = Math.max(max[i % 3], verts[i]); }
    return { verts, min, max };
}

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

/** Horizontal distance from (x, z) to a box's footprint. */
const toFootprint = (x: number, z: number, min: number[], max: number[]) =>
    Math.hypot(Math.max(min[0] - x, 0, x - max[0]), Math.max(min[2] - z, 0, z - max[2]));

describe.skipIf(!present)('the hamlet\'s well and light poles', { timeout: 180_000 }, () => {
    const bundle = valley!.bundle;
    const manifest = bundle.manifest;
    const root = bundle.scenes[manifest.mainSceneId].scene;
    const refs = manifest.sceneMetas.find((m: any) => m.id === manifest.mainSceneId).refs;
    const models = new Map<string, any>(bundle.libraries.models.map((m: any) => [m.id, m]));
    const materials = new Map<string, any>(bundle.libraries.materials.map((m: any) => [m.id, m]));
    const textures = new Map<string, any>(bundle.textures.map((t: any) => [t.id, t]));
    const heightAt = terrainHeightSampler(root);
    const road = catmullRom(ROADS.find((r: any) => r.key === 'main').points, 0.5) as number[][];

    const group = root.children.find((c: any) => c.name === 'Light Poles');
    const well = root.children.find((c: any) => c.name === 'Well');
    const poles: any[] = group?.children ?? [];
    const roadPoles = poles.filter(p => p.name.startsWith('Light Pole'));
    const squarePoles = poles.filter(p => p.name.startsWith('Square Light Pole'));
    const placed = [...poles, ...(well ? [well] : [])].map(node => ({ node, ...worldVertices(node) }));

    /** The houses' level 0, in the world, without the ground skirt the Old House's source came with: it lies under the landscape. */
    const houseTriangles = (() => {
        const out: number[] = [];
        for (const lod of root.children.find((c: any) => c.name === 'Buildings').children) {
            const walk = (n: any, parent: mat4) => {
                const m = mat4.multiply(mat4.create(), parent, trs(n));
                if (n.type === 'model' && n.model?.geometry) {
                    const { positions: P, indices: I } = n.model.geometry, v = vec3.create();
                    for (let i = 0; i < I.length; i += 3) {
                        const tri: number[] = [];
                        for (let k = 0; k < 3; k++) { vec3.transformMat4(v, [P[I[i + k] * 3], P[I[i + k] * 3 + 1], P[I[i + k] * 3 + 2]], m); tri.push(v[0], v[1], v[2]); }
                        const grounded = [0, 3, 6].every(k => tri[k + 1] - heightAt(tri[k], tri[k + 2]) < 0.3);
                        if (!grounded) out.push(...tri);
                    }
                }
                for (const c of n.children ?? []) walk(c, m);
            };
            walk(lod.children[0], trs(lod));
        }
        return Float64Array.from(out);
    })();

    it('replaces the standing torches with light poles beside them, and keeps the wall torches', () => {
        const torches = root.children.find((c: any) => c.name === 'Torches');
        expect(group).toBeDefined();
        expect(root.children.indexOf(group)).toBe(root.children.indexOf(torches) + 1);
        expect(allNodes(root).filter(n => n.name === 'Torch')).toHaveLength(0);
        expect(torches.children.map((c: any) => c.name)).toEqual(['Wall Torch', 'Wall Torch', 'Wall Torch', 'Wall Torch']);
        // Their template went with them, and its material and maps: nothing else used them.
        expect(bundle.libraries.templates.map((t: any) => t.name)).not.toContain('Torch');
        expect(bundle.libraries.materials.map((m: any) => m.name)).not.toContain('Standing Torch');
        expect(poles).toHaveLength(ROAD_POLES.length + SQUARE_POLES.length);
        expect(roadPoles).toHaveLength(ROAD_POLES.length);
        expect(squarePoles).toHaveLength(SQUARE_POLES.length);
    });

    it('stands each pole upright on the landscape, a linked copy of the library pole with a body and a draw distance', () => {
        const pole = models.get(modelIdOf('light-pole'));
        expect(pole?.name).toBe('Light Pole');
        for (const { node, verts } of placed.filter(p => p.node !== well)) {
            const [x, y, z] = node.position;
            expect(node.variables.__modelId.value, node.name).toBe(pole.id);
            expect(node.variables.__modelBaseTRS.value, node.name).toBe('[0,0,0,0,0,0,1,1,1]');
            expect([node.scale, node.rotation[0], node.rotation[2]], node.name).toEqual([[1, 1, 1], 0, 0]);
            // Its base on the surface at its post.
            expect(Math.abs(y - heightAt(x, z)), `${node.name}: base over the ground`).toBeLessThan(0.05);
            // The four braces' feet under the ground, wherever the bank falls away: none floats.
            let feet = 0;
            for (let i = 0; i < verts.length; i += 3) {
                if (verts[i + 1] > y - 0.2 || Math.hypot(verts[i] - x, verts[i + 2] - z) < 0.3) continue;
                feet++;
                expect(verts[i + 1], `${node.name}: a brace's foot at (${verts[i].toFixed(2)}, ${verts[i + 2].toFixed(2)})`).toBeLessThan(heightAt(verts[i], verts[i + 2]));
            }
            expect(feet, node.name).toBeGreaterThan(0);
            expect(node.drawDistance, node.name).toBe(LIGHT_POLE_DRAW_DISTANCE);
            expect(node.body?.mass, node.name).toBe(0);
            expect(node.body.shapes.some((s: any) => s.type === 'cylinder'), node.name).toBe(true);
            const parts = allNodes(node).filter(n => n.type === 'model');
            expect(parts, node.name).toHaveLength(1);
            expect(parts[0].model.material, node.name).toEqual(materials.get(parts[0].variables.__materialId.value).material);
        }
    });

    it('lines both sides of the stone trail, off its graded core, the lanterns over the road', () => {
        let west = 0, east = 0;
        for (const node of roadPoles) {
            const [x, , z] = node.position;
            const off = distanceToPolyline(x, z, road);
            expect(off, `${node.name}: off the centreline`).toBeGreaterThanOrEqual(3.0);
            expect(off, `${node.name}: off the centreline`).toBeLessThan(4.0);
            // The nearest point of the road, and which side of it the pole is on.
            let best = 0;
            for (let i = 1; i < road.length; i++) if (Math.hypot(road[i][0] - x, road[i][1] - z) < Math.hypot(road[best][0] - x, road[best][1] - z)) best = i;
            const a = road[Math.max(0, best - 1)], b = road[Math.min(road.length - 1, best + 1)];
            const t = [b[0] - a[0], b[1] - a[1]];
            const toward = [road[best][0] - x, road[best][1] - z], l = Math.hypot(toward[0], toward[1]);
            // The road runs north (its points from the spawn end): a pole west of it has the road on its east.
            if (t[0] * toward[1] - t[1] * toward[0] > 0) west++; else east++;
            // The lantern (the model's +Z) hangs toward the road.
            const yaw = node.rotation[1] * Math.PI / 180;
            expect((Math.sin(yaw) * toward[0] + Math.cos(yaw) * toward[1]) / l, `${node.name}: lantern toward the road`).toBeGreaterThan(0.95);
        }
        expect(west).toBeGreaterThanOrEqual(5);
        expect(east).toBeGreaterThanOrEqual(5);
        // Through the hamlet (the road from z 62 down to z 14) the road is never more than 7 m from a lamp.
        const lamps = poles.map(p => p.position);
        for (const [x, z] of road) {
            if (z > 62 || z < 14) continue;
            const nearest = Math.min(...lamps.map(p => Math.hypot(p[0] - x, p[2] - z)));
            expect(nearest, `the road at (${x.toFixed(1)}, ${z.toFixed(1)})`).toBeLessThan(7);
        }
    });

    it('rings the well with poles, their lanterns toward it, and keeps every pole off the road and clear of the campfire', () => {
        for (const node of squarePoles) {
            const [x, , z] = node.position;
            const d = Math.hypot(x - HAMLET.x, z - HAMLET.z);
            expect(d, node.name).toBeGreaterThan(3);
            expect(d, node.name).toBeLessThan(8);
            const yaw = node.rotation[1] * Math.PI / 180;
            expect((Math.sin(yaw) * (HAMLET.x - x) + Math.cos(yaw) * (HAMLET.z - z)) / d, `${node.name}: lantern toward the well`).toBeGreaterThan(0.95);
        }
        const campfire = root.children.find((c: any) => c.name === 'Campfire');
        for (const { node, min, max } of placed) {
            expect(distanceToPolyline(node.position[0], node.position[2], road), `${node.name}: off the road's core`).toBeGreaterThanOrEqual(3.0);
            expect(toFootprint(campfire.position[0], campfire.position[2], min, max), `${node.name}: from the campfire`).toBeGreaterThanOrEqual(2.5);
        }
        // Clear of one another, too.
        for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
            const p = placed[i], q = placed[j];
            const overlap = [0, 2].every(a => p.min[a] < q.max[a] + 1 && q.min[a] < p.max[a] + 1);
            expect(overlap, `${p.node.name} and ${q.node.name}`).toBe(false);
        }
    });

    it('carries the Valley\'s fire in each lantern: a flame, embers and a bright light, lit by the Fire Light script', () => {
        const script = bundle.libraries.scripts.find((s: any) => s.name === 'Fire Light');
        for (const node of poles) {
            expect(node.variables.__scriptId?.value, node.name).toBe(script.id);
            expect(node.script, node.name).toBe(script.source);
            const parts = Object.fromEntries(['Flame', 'Embers', 'Light'].map(name => [name, node.children.filter((c: any) => c.name === name)]));
            for (const [name, list] of Object.entries(parts)) {
                expect(list, `${node.name} / ${name}`).toHaveLength(1);
                // In the lantern's cage: over the wick, under its roof.
                const [lx, ly, lz] = list[0].position;
                expect(Math.hypot(lx - LANTERN.x, lz - LANTERN.z), `${node.name} / ${name}`).toBeLessThan(0.03);
                expect(ly, `${node.name} / ${name}`).toBeGreaterThan(LANTERN.y);
                expect(ly, `${node.name} / ${name}`).toBeLessThan(LANTERN.y + 0.15);
            }
            const [flame] = parts.Flame, [embers] = parts.Embers, [light] = parts.Light;
            expect(flame.type).toBe('animatedSprite');
            expect(flame.sprite.tileset.name).toBe('Torch Fire');
            expect(flame.sprite.followLight).toBe('Light');
            expect(flame.animation.loop).toBe(true);
            // Small enough for the cage (13 cm inside).
            expect(flame.scale[0]).toBeLessThan(0.13);
            expect(embers.type).toBe('particleSystem');
            expect(embers.particleSystem.followLight).toBe('Light');
            expect(light.type).toBe('light');
            expect(light.lightType).toBe('point');
            expect(light.castShadows).toBe(true);
            expect(light.light.unit).toBe('photometric');
            expect(light.light.intensity).toBe(POLE_LIGHT.intensity);
            expect(light.light.intensity).toBeGreaterThanOrEqual(1400);
            expect(light.light.range).toBeGreaterThanOrEqual(10);
            // The lantern's own cage and dish sit inside its source radius, the point shadow's near plane: they
            // cast nothing on the road under it.
            expect(light.position[1] - light.light.sourceRadius).toBeLessThan(LANTERN.bottom);
        }
    });

    it('stands the well on the ground at the hamlet\'s centre, a linked copy with a body', () => {
        expect(well).toBeDefined();
        expect(root.children.indexOf(well)).toBe(root.children.indexOf(group) + 1);
        const asset = models.get(modelIdOf('well'));
        expect(asset?.name).toBe('Well');
        expect(well.variables.__modelId.value).toBe(asset.id);
        expect(Math.hypot(well.position[0] - HAMLET.x, well.position[2] - HAMLET.z)).toBeLessThan(0.01);
        expect(Math.abs(well.position[1] - heightAt(HAMLET.x, HAMLET.z))).toBeLessThan(0.05);
        const { min, max } = placed.find(p => p.node === well)!;
        expect(min[1]).toBeCloseTo(well.position[1], 3);
        // A well's size: a ring about 1.8 m across under a roof about 2.7 m up.
        expect(max[0] - min[0]).toBeGreaterThan(1.5);
        expect(max[0] - min[0]).toBeLessThan(2.5);
        expect(max[1] - min[1]).toBeGreaterThan(2.2);
        expect(max[1] - min[1]).toBeLessThan(3.2);
        expect(well.drawDistance).toBe(WELL_DRAW_DISTANCE);
        expect(well.body?.mass).toBe(0);
        expect(well.body.shapes.length).toBeGreaterThan(0);
        const parts = allNodes(well).filter(n => n.type === 'model');
        expect(parts.map(p => p.name)).toEqual(['Well', 'Well Roof', 'Well Bucket', 'Well Rope']);
        for (const part of parts) expect(part.model.material).toEqual(materials.get(part.variables.__materialId.value).material);
    });

    it('keeps the well and every pole out of the houses and clear of the Valley Tour\'s camera', async () => {
        const { Spline3 } = await import('../src/core/math');
        const tour = allNodes(root).find(n => n.type === 'sequence' && n.name === 'Valley Tour');
        expect(tour).toBeDefined();
        const samples: number[][] = [];
        for (const track of tour.sequence.tracks) if (track.type === 'path') for (const section of track.sections) {
            const s = new Spline3(section.points);
            for (let k = 0; k <= 400; k++) samples.push([...s.pointAt(k / 400)]);
        }
        expect(samples.length).toBeGreaterThan(400);
        // The walls, roofs and floors of all four buildings are still in it, only the buried skirt out.
        expect(houseTriangles.length / 9).toBeGreaterThan(50_000);
        for (const { node, min, max } of placed) {
            // No house triangle within half a metre of it.
            const lo = min.map(v => v - 0.5), hi = max.map(v => v + 0.5);
            const c = [0, 1, 2].map(a => (lo[a] + hi[a]) / 2), h = [0, 1, 2].map(a => (hi[a] - lo[a]) / 2);
            let near = 0;
            for (let i = 0; i < houseTriangles.length; i += 9) if (triangleOverlapsBox(houseTriangles, i, c, h)) near++;
            expect(near, `${node.name}: house triangles within 0.5 m`).toBe(0);
            // No camera sample within 1.5 m of its bounding box, horizontally, wherever the camera is within
            // 1.5 m of the box's height (and so none within 1.5 m of it at all).
            let nearest = Infinity;
            for (const [x, y, z] of samples) if (y > min[1] - 1.5 && y < max[1] + 1.5) nearest = Math.min(nearest, toFootprint(x, z, min, max));
            expect(nearest, `${node.name}: from the tour's camera`).toBeGreaterThanOrEqual(1.5);
        }
    });

    it('keeps the pole and the well as library models under /Props/Hamlet, named in the scene\'s refs, their maps small JPEGs', () => {
        const entries = new Map<string, string[]>();
        for (const e of bundle.vfs.entries) entries.set(e.assetId, [...(entries.get(e.assetId) ?? []), e.path]);
        let bytes = 0;
        for (const [key, name, count] of [['light-pole', 'Light Pole', 1], ['well', 'Well', 4]] as const) {
            const asset = models.get(modelIdOf(key));
            expect(asset, name).toBeDefined();
            expect(entries.get(asset.id), name).toEqual([`/Props/Hamlet/Models/${name}.model`]);
            expect(asset.materialIds, name).toHaveLength(count);
            expect(refs.modelIds, name).toContain(asset.id);
            for (const m of asset.materialIds) {
                expect(materials.has(m), name).toBe(true);
                expect(entries.get(m)?.[0], name).toMatch(/^\/Props\/Hamlet\/Materials\//);
                expect(refs.materialIds, name).toContain(m);
            }
            expect(asset.textureIds.length, name).toBeGreaterThanOrEqual(3 * count - 1);
            for (const t of asset.textureIds) {
                const tex = textures.get(t);
                expect(tex?.mime, name).toBe('image/jpeg');
                const b = new Uint8Array(tex.bytes);
                expect(Math.max(...imageSize(b)), name).toBeLessThanOrEqual(1024);
                expect(jpegDcStep(b), name).toBeGreaterThanOrEqual(3);
                expect(entries.get(t)?.sort(), name).toHaveLength(2);
                expect(refs.textureIds, name).toContain(t);
                bytes += b.byteLength;
            }
        }
        expect(bytes).toBeLessThan(5 * 1048576);
    });
});
