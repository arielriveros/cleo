import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { defaultMaskResolution } from '../src/terrain/terrainLayerStack';
import { MAX_INSTANCES } from '../src/terrain/foliage';
import { decodePng } from '../src/terrain/heightmapIO';
import { readExample } from '../tools/exampleKit/readExample.mjs';

// The Valley example (tools/valley/build.mjs) is the souls content on a generated landscape. The joins
// it shares with Hollow Keep are checked by soulsDemoProject.test.ts; this suite checks what the valley
// adds — the landscape blob, its material and trail mask, the pre-baked foliage, the buildings — none of
// which fails loudly: a mask at the wrong resolution is resampled with a warning, a foliage layer whose
// key matches no rule is orphaned, a building on the wrong y floats.

const PROJECT = join(__dirname, '..', 'applications', 'editor', 'public', 'examples', 'valley');
const HEIGHTMAP = join(__dirname, '..', 'build', 'valley_height_4097_16bit.png');
const present = existsSync(join(PROJECT, 'manifest.json'));

// Read through the editor's own bundle reader: the example is checked in as format 2, whose JSON holds
// markers into assets.bin rather than the payloads these tests look at.
const valley = present ? await readExample(PROJECT) : null;
const read = (...parts: string[]) => valley!.read(...parts);
const allNodes = (root: any): any[] => {
    const out: any[] = [];
    const walk = (n: any) => { out.push(n); for (const c of n.children ?? []) walk(c); };
    walk(root);
    return out;
};
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

// Generous: the first test parses the ~50 MB scene, which under a full parallel run takes several seconds.
describe.skipIf(!present)('the Valley example project', { timeout: 60_000 }, () => {
    const manifest = () => read('manifest.json');
    const scene = () => read('scenes', `${manifest().mainSceneId}.json`);
    const nodes = () => allNodes(scene().scene);
    const landscape = () => nodes().find(n => n.type === 'landscape');
    const terrain = () => landscape().terrain;
    const library = (name: string) => read('libraries', `${name}.json`);

    let grid: Float32Array | null = null;
    const heights = (): Float32Array => {
        if (grid) return grid;
        const t = terrain();
        const bytes = b64(t.heights);
        const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
        grid = new Float32Array(u16.length);
        for (let i = 0; i < u16.length; i++) grid[i] = t.heightMin + (u16[i] / 65535) * (t.heightMax - t.heightMin);
        return grid;
    };
    /** Bilinear height of the shipped surface at world x/z (the landscape sits at the origin). */
    const heightAt = (x: number, z: number) => {
        const { size, resolution: R } = terrain();
        const e = size / (R - 1);
        const fx = (x + size / 2) / e, fz = (z + size / 2) / e;
        const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r;
        const h = heights(), at = (cc: number, rr: number) => h[rr * R + cc];
        const a = at(c, r) + (at(c + 1, r) - at(c, r)) * tx;
        const b = at(c, r + 1) + (at(c + 1, r + 1) - at(c, r + 1)) * tx;
        return a + (b - a) * tz;
    };
    const slopeAt = (x: number, z: number) => {
        const dx = (heightAt(x + 1, z) - heightAt(x - 1, z)) / 2, dz = (heightAt(x, z + 1) - heightAt(x, z - 1)) / 2;
        return Math.atan(Math.hypot(dx, dz)) * 180 / Math.PI;
    };
    let maskBytes: Uint8Array | null = null;
    const trailAt = (x: number, z: number) => {
        const s = terrain().layerStack, R = s.maskRes, size = terrain().size;
        const masks = maskBytes ??= b64(s.masks);
        const c = Math.min(R - 1, Math.max(0, Math.floor((x + size / 2) / size * R)));
        const r = Math.min(R - 1, Math.max(0, Math.floor((z + size / 2) / size * R)));
        return masks[(r * R + c) * 4 + s.slotChannels.slot_trail] / 255;
    };

    it('ships the whole 2 km map at a 1 m grid, at the landscape origin', () => {
        const t = terrain();
        expect([t.size, t.resolution]).toEqual([2048, 2049]);
        expect(t.heightFormat).toBe('u16');
        expect(heights().length).toBe(2049 * 2049);
        expect(landscape().position).toEqual([0, 0, 0]);
        // The gate plaza was cut at a fixed height; the reference gives it as 4.59 m.
        expect(Math.abs(heightAt(0, -130.09) - 4.59)).toBeLessThan(0.02);
    });

    it.skipIf(!existsSync(HEIGHTMAP))('keeps the heightmap within a centimetre', async () => {
        const img = await decodePng(new Uint8Array(readFileSync(HEIGHTMAP)));
        const h = heights();
        for (const [r, c] of [[0, 0], [1024, 1024], [2048, 2048], [700, 1500], [1900, 33]]) {
            const fine = -0.84 + img.data[(r * 2) * 4097 + c * 2] * 430.35;
            expect(Math.abs(h[r * 2049 + c] - fine), `${r},${c}`).toBeLessThan(0.01);
        }
    });

    it('carries its mask at the resolution the engine gives this landscape (no resample on load)', () => {
        const s = terrain().layerStack;
        expect(s.layerFormat).toBe(2);
        expect(s.maskRes).toBe(defaultMaskResolution(terrain().resolution));
        expect(b64(s.masks).length).toBe(s.maskSlices * s.maskRes * s.maskRes * 4);
    });

    it('uses the library landscape material: ground, dirt, rocky dirt, forest floor, rock, snow, a clay and sand pond and painted roads', () => {
        const s = terrain().layerStack;
        const asset = library('terrainMaterials').find((m: any) => m.id === s.base.materialId);
        expect(asset).toBeDefined();
        expect(s.base.material).toEqual(asset.material);
        expect(asset.material.slots.map((x: any) => x.name)).toEqual([
            'Dirt', 'Rocky Dirt', 'Forest Floor', 'Rock', 'Snow', 'Pond Clay', 'Shore Sand', 'Dirt Road', 'Trail', 'Stone Path',
        ]);
        const painted = ['Dirt', 'Forest Floor', 'Pond Clay', 'Shore Sand', 'Dirt Road', 'Trail', 'Stone Path'];
        for (const name of painted) {
            const slot = asset.material.slots.find((x: any) => x.name === name);
            expect(slot.manual, name).toBe(true);
            expect(s.slotChannels[slot.id], name).toBeTypeOf('number');
        }
        // One channel per painted slot, over two RGBA slices.
        expect(new Set(Object.values(s.slotChannels)).size).toBe(painted.length);
        expect(s.maskSlices).toBe(2);
        // The undergrowth belongs to the Forest Floor.
        const forest = asset.material.slots.find((x: any) => x.name === 'Forest Floor');
        expect(forest.foliageInclude.map((r: any) => r.name)).toEqual(['Forest Undergrowth A', 'Forest Undergrowth B', 'Boxwood']);
        // The scree carries nothing: only plants grow in the valley, and only on the ground and the litter.
        const dirt = asset.material.slots.find((x: any) => x.name === 'Rocky Dirt');
        expect(dirt.foliageInclude ?? []).toEqual([]);
        const shipped = new Set(read('textures', 'index.json').map((t: any) => t.id));
        for (const id of asset.textureIds) expect(shipped.has(id), id).toBe(true);
    });

    it('links every surface of the landscape to a library material, the Snow among them', () => {
        const tmat = library('terrainMaterials')[0].material;
        const materials = library('materials');
        const byId = new Map(materials.map((m: any) => [m.id, m]));
        const linked = [{ name: 'Ground', surfaceMaterialId: tmat.surfaceMaterialId, material: null }, ...tmat.slots];
        for (const slot of linked) {
            const asset: any = byId.get(slot.surfaceMaterialId);
            expect(asset, slot.name).toBeDefined();
            // The slot holds a copy of what the library holds (a library edit is pushed into it).
            if (slot.material) expect(slot.material, slot.name).toEqual(asset.material);
        }
        const snow: any = materials.find((m: any) => m.name === 'Snow');
        expect(snow).toBeDefined();
        expect(tmat.slots.find((x: any) => x.name === 'Snow').surfaceMaterialId).toBe(snow.id);
        expect(Object.values(snow.material.textures).length).toBeGreaterThanOrEqual(4);
        // Listed in the explorer, under the landscape.
        const vfs = read('vfs.json');
        const entries = (vfs.entries ?? vfs) as any[];
        const entry = entries.find((e: any) => e.assetId === snow.id || e.id === snow.id);
        expect(entry, 'a vfs entry for Snow').toBeDefined();
        expect(JSON.stringify(entry)).toContain('/Environment/Landscape/Materials');
    });

    it('gives the Rock slot weathered rock\'s roughness, above the screen-space reflections\' cut-off', () => {
        // build/valley_prepared/rock_arm.jpg's green, remapped by prepare.py (ROCK_ROUGHNESS): the map replaces
        // the scalar in the shader, so only the shipped texture can say it. Checked where the source is present.
        const arm = join(__dirname, '..', 'build', 'valley_prepared', 'rock_arm.jpg');
        if (!existsSync(arm)) return;
        const src = readFileSync(join(__dirname, '..', 'tools', 'valley', 'prepare.py'), 'utf8');
        expect(src).toMatch(/ROCK_ROUGHNESS = \(0\.45, 0\.65\)/);
        expect(src).toContain('terrain("rock", "rock_05_1k", "rock_05", roughness=ROCK_ROUGHNESS)');
    });

    it('paints the trail along the roads and nowhere far from them', () => {
        for (const [x, z] of [[-12, 82], [-30, 48], [-22, 10], [-4, -50], [5, -8], [54, -38]]) expect(trailAt(x, z), `${x},${z}`).toBeGreaterThan(0.6);
        for (const [x, z] of [[40, 60], [-80, -20], [300, 300]]) expect(trailAt(x, z), `${x},${z}`).toBe(0);
    });

    /** Every foliage rule of the landscape material: the ground's and each surface's own. */
    const allRules = () => {
        const m = terrain().layerStack.base.material;
        return [...m.groundFoliageInclude, ...m.slots.flatMap((x: any) => x.foliageInclude ?? [])];
    };

    it('files every foliage layer under a rule of the material, linked to a library model', () => {
        const rules = allRules();
        const models = new Set(library('models').map((m: any) => m.id));
        const foliageIds = new Set(manifest().sceneMetas[0].refs.foliageModelIds);
        expect(terrain().foliage.length).toBe(rules.length);
        for (const layer of terrain().foliage) {
            const rule = rules.find((r: any) => r.id === layer.key);
            expect(rule, layer.name).toBeDefined();
            expect(models.has(rule.modelId), rule.name).toBe(true);
            expect(foliageIds.has(rule.modelId), rule.name).toBe(true);
            expect(layer.model?.geometry?.positions?.length, layer.name).toBeGreaterThan(0);
            expect(layer.lods.length, layer.name).toBe(2);
        }
    });

    it('draws the Foliage Creator plants with their LOD ladders, ends grass by 30 m and hands distant trees to a shipped impostor', () => {
        const rules = allRules();
        const textures = new Set(manifest().sceneMetas[0].refs.textureIds);
        const tris = (models: any[]) => models.reduce((n, m) => n + m.geometry.indices.length / 3, 0);
        for (const layer of terrain().foliage) {
            const rule = rules.find((r: any) => r.id === layer.key);
            const lod0 = tris(layer.models ?? [layer.model]);
            const [l1, l2] = layer.lods.map((l: any) => tris(l.models));
            // Every level cheaper than the one before it.
            expect(l1, layer.name).toBeLessThan(lod0);
            expect(l2, layer.name).toBeLessThan(l1);
            if (layer.name.includes('Grass')) {
                // A clump of blades, then fewer, then a few: blades all the way, never a billboard card.
                expect(layer.cullDistance, layer.name).toBeLessThanOrEqual(30);
                expect(lod0, layer.name).toBeGreaterThan(200);
                expect(l2, layer.name).toBeGreaterThan(6);   // three crossed cards would be 6
                expect(layer.lods.flatMap((l: any) => l.models).some((m: any) => /card/i.test(JSON.stringify(m.material ?? m.materialId ?? ''))), layer.name).toBe(false);
                expect(layer.billboard, layer.name).toBeUndefined();
            } else if (/Undergrowth|Boxwood|Shrub|Juniper/.test(layer.name)) {
                // Bushes: walked through, no impostor, culled well short of the trees.
                expect(lod0, layer.name).toBeGreaterThan(1000);
                expect(lod0, layer.name).toBeLessThan(10000);
                expect(layer.billboard, layer.name).toBeUndefined();
                expect(layer.collision, layer.name).toBeUndefined();
                expect(layer.cullDistance, layer.name).toBeLessThanOrEqual(90);
            } else {
                // Trees: a few thousand to some tens of thousands of triangles, never a scan's hundreds of thousands.
                expect(lod0, layer.name).toBeGreaterThan(5000);
                expect(lod0, layer.name).toBeLessThan(40000);
                expect(l2 / lod0, layer.name).toBeLessThan(0.15);
                expect(layer.collision?.shape, layer.name).toBe('cylinder');
                expect(layer.billboard?.distance).toBeGreaterThan(layer.lods[1].distance);
                expect(layer.billboard.textureId).toBe(`${rule.modelId}__impostor`);
                expect(rule.billboard).toEqual(layer.billboard);
                expect(textures.has(layer.billboard.textureId)).toBe(true);
                // Octahedral: 8 x 8 views around the tree, and the normals they are lit with.
                expect(layer.billboard.octahedral.frames).toBe(8);
                expect(layer.billboard.octahedral.radius).toBeGreaterThan(3);
                expect(layer.billboard.textures.normal).toBe(`${rule.modelId}__impostorNormal`);
                expect(textures.has(layer.billboard.textures.normal)).toBe(true);
            }
        }
    });

    it('ships no cloth simulation', () => {
        const player = library('templates').find((t: any) => t.name === 'Player');
        const knight = player.nodeJson.children.find((c: any) => c.name === 'Knight');
        expect(knight.model.skinnedCloth).toBeUndefined();
    });

    it('lets light through the leaves, and only the leaves', () => {
        const byName = new Map(library('materials').map((m: any) => [m.name, m.material]));
        // Leaves, needles and grass glow back-lit (Material translucency), double-sided so the back face
        // draws; bark and rock do not. The Creator's materials, named "<plant> <material>".
        for (const name of ['Meadow Grass A Grass', 'Spruce A Needles', 'Highland Spruce Needles', 'Oak Leaves',
                            'Shrub A Leaves', 'Juniper Needles', 'Forest Undergrowth A Leaves']) {
            const m = byName.get(name);
            expect(m?.translucency, name).toBeGreaterThan(0);
            expect(m?.config.side, name).toBe('double');
        }
        // Cards cut out on their base colour's alpha (no separate mask).
        for (const name of ['Spruce A Needles', 'Oak Leaves', 'Shrub A Leaves']) expect(byName.get(name)?.alphaCutoff, name).toBe(0.5);
        for (const name of ['Spruce A Bark', 'Oak Bark', 'Shrub A Bark', 'Moss Rock'])
            expect(byName.get(name)?.translucency ?? 0, name).toBe(0);
    });

    it('makes every plant a foliage material: grass and bushes part, trees barely move, all vary and weather', () => {
        const byName = new Map(library('materials').map((m: any) => [m.name, m.material]));
        // Material interactBend / interactRecovery, as the Creator set them (foliageInteraction.ts).
        for (const name of ['Meadow Grass A Grass', 'Tall Grass Grass', 'Shrub A Leaves', 'Juniper Needles', 'Forest Undergrowth A Leaves'])
            expect(byName.get(name)?.interactBend ?? 0, name).toBeGreaterThan(0.3);
        for (const name of ['Spruce A Needles', 'Oak Leaves'])
            expect(byName.get(name)?.interactBend ?? 0, name).toBeLessThan(0.1);
        // Only FOLIAGE materials run any of it (Material.Foliage): every plant's are, the rock's is not.
        for (const name of ['Meadow Grass A Grass', 'Spruce A Needles', 'Spruce A Bark', 'Oak Leaves', 'Shrub A Leaves', 'Juniper Needles'])
            expect(byName.get(name)?.type, name).toBe('foliage');
        expect(byName.get('Moss Rock')?.type).toBe('pbr');
        // Grass varies plant by plant and shows gusts as waves; broad leaves flip in gusts, needles do not.
        expect(byName.get('Meadow Grass A Grass')?.variationValue ?? 0).toBeGreaterThan(0);
        expect(byName.get('Meadow Grass A Grass')?.rippleSheen ?? 0).toBeGreaterThan(0);
        expect(byName.get('Oak Leaves')?.leafFlip ?? 0).toBeGreaterThan(0);
        expect(byName.get('Spruce A Needles')?.leafFlip ?? 0).toBe(0);
    });

    it('stands every plant on the surface, keeps grass off the roads, and stays under the layer cap', () => {
        for (const layer of terrain().foliage) {
            const bytes = b64(layer.instances);
            const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
            const count = f.length / 5;
            // Trees and bushes stand on the small valley floor; everything else numbers in the hundreds.
            expect(count, layer.name).toBeGreaterThan(/Oak|Shrub|Juniper|Boxwood/.test(layer.name) ? 10 : /Spruce/.test(layer.name) ? 50 : 100);
            expect(count, layer.name).toBeLessThan(MAX_INSTANCES);
            for (let i = 0; i < f.length; i += 5 * 37) {
                const [x, y, z] = [f[i], f[i + 1], f[i + 2]];
                expect(Math.abs(y - heightAt(x, z)), `${layer.name} at ${x},${z}`).toBeLessThan(0.3);
                // The road's graded core is mask 1; grass may reach into the noisy blend edge, as the engine allows.
                if (layer.name.includes('Grass')) expect(trailAt(x, z), `${layer.name} at ${x},${z}`).toBeLessThan(0.6);
            }
        }
    });

    it('starts the player on open ground at the reference spawn, facing north', () => {
        const player = nodes().find(n => n.name === 'Player');
        const [x, y, z] = player.position;
        expect([x, z]).toEqual([-12, 82]);
        expect(Math.abs(y - heightAt(x, z) - 0.05)).toBeLessThan(0.01);
        expect(slopeAt(x, z)).toBeLessThan(20);
        expect(player.rotation[1]).toBe(180);
        // A 2 km landscape needs more than the Playable's 100 m camera.
        const camera = allNodes(player).find(n => n.type === 'camera');
        expect(camera.camera.far).toBeGreaterThanOrEqual(2000);
    });

    it('stands every interactable and spawn on the ground', () => {
        for (const group of ['Interactables', 'Enemy Spawns']) {
            for (const n of nodes().find(g => g.name === group).children) {
                const [x, y, z] = n.position;
                // The gate hangs 2 m up its posts; the cave is sunk into the plaza so its base never floats.
                const lift = n.name === 'Shortcut Gate' ? 2 : n.name === 'Skull Cave Entrance' ? -0.4 : 0;
                expect(Math.abs(y - lift - heightAt(x, z)), n.name).toBeLessThan(0.1);
            }
        }
    });

    it('places each building as a linked copy, the houses enterable, nothing floating', () => {
        const models = library('models');
        const buildings = nodes().find(n => n.name === 'Buildings').children;
        expect(buildings.map((b: any) => b.name).sort()).toEqual(['Granary', 'Long House', 'Old House', 'Windmill']);
        for (const b of buildings) {
            expect(models.some((m: any) => m.id === b.variables.__modelId.value), b.name).toBe(true);
            expect(b.body.mass).toBe(0);
            // The two houses are walled in boxes with their doorways open, under one hull for the roof
            // (houses.mjs) — a few dozen shapes, not hundreds; the granary and the windmill keep a hull
            // over their whole body.
            const enterable = b.name === 'Old House' || b.name === 'Long House';
            if (enterable) {
                const shapes = b.body.shapes;
                expect(shapes.length, b.name).toBeGreaterThan(10);
                expect(shapes.length, b.name).toBeLessThan(200);
                expect(shapes.filter((s: any) => s.type === 'convex'), b.name).toHaveLength(1);
                expect(shapes.filter((s: any) => s.type !== 'convex').every((s: any) => s.type === 'box'), b.name).toBe(true);
            } else {
                expect(b.body.shapes[0].type).toBe('convex');
            }
            // The base goes at the LOWEST ground under the footprint, so it never floats over the centre —
            // and inside a house the ground is raised to its raised floor (a third of a metre or so up).
            const lift = heightAt(b.position[0], b.position[2]) - b.position[1];
            if (enterable) {
                expect(lift, b.name).toBeGreaterThan(0.2);
                expect(lift, b.name).toBeLessThan(0.6);
            } else expect(lift, b.name).toBeGreaterThanOrEqual(0);
        }
        const sails = allNodes(buildings.find((b: any) => b.name === 'Windmill')).find(n => n.name === 'Sails');
        expect(sails.script).toContain('class ValleyWindmillNode');
    });

    it('places the buildings as LOD groups whose levels are the asset’s, decimated (lods.mjs)', () => {
        const models = library('models');
        const tris = (n: any) => allNodes(n).reduce((t, x) => t + (x.type === 'model' ? x.model.geometry.indices.length / 3 : 0), 0);
        for (const b of nodes().find(n => n.name === 'Buildings').children) {
            const asset = models.find((m: any) => m.id === b.variables.__modelId.value);
            // The wrapper instantiateModelAsset builds: lodGroup, one child per level, no cull for landmarks.
            expect(b.type, b.name).toBe('lodGroup');
            expect(b.distances, b.name).toEqual([0, ...asset.lods.map((l: any) => l.distance)]);
            expect(b.children.length, b.name).toBe(asset.lods.length + 1);
            expect(asset.lods.every((l: any) => l.generated), b.name).toBe(true);
            expect(asset.cullDistance ?? 0, b.name).toBe(0);
            // Each level fewer triangles than the last, and linked by level links, never __materialId.
            const counts = b.children.map(tris);
            for (let i = 1; i < counts.length; i++) expect(counts[i], `${b.name} level ${i}`).toBeLessThan(counts[i - 1]);
            for (const level of b.children.slice(1)) for (const m of allNodes(level).filter(x => x.type === 'model')) {
                expect(m.variables.__materialId, m.name).toBeUndefined();
                expect(m.variables.__lodMaterialId?.value, m.name).toBeTruthy();
            }
        }
        // Every windmill level keeps its turning sails, so a level switch never stops them.
        const windmill = nodes().find(n => n.name === 'Windmill' && n.type === 'lodGroup');
        for (const level of windmill.children)
            expect(allNodes(level).find(n => n.name === 'Sails')?.script, level.name).toContain('class ValleyWindmillNode');
    });

    it('gives every enemy type a draw distance on its root, the base template and each variant alike', () => {
        const enemies = library('templates').filter((t: any) => t.nodeJson?.type === 'character' && t.name !== 'Player');
        expect(enemies.length).toBeGreaterThanOrEqual(3);
        for (const t of enemies) expect(t.nodeJson.drawDistance, t.name).toBe(60);
        expect(library('templates').find((t: any) => t.name === 'Player').nodeJson.drawDistance).toBeUndefined();
    });

    it('fills the pond with water that stays below every bank, under a probe it reflects', () => {
        const water = nodes().find(n => n.name === 'Pond Water');
        const [px, level, pz] = water.position;
        for (let a = 0; a < 360; a += 5) {
            const r = 10.5;
            expect(level, `bank at ${a}°`).toBeLessThan(heightAt(px + Math.cos(a * Math.PI / 180) * r, pz + Math.sin(a * Math.PI / 180) * r));
        }
        expect(level - heightAt(px, pz)).toBeGreaterThan(0.5);    // there is a pond, not a puddle
        // The pond's own probe, just over the water, holds the water's surface: what the water reflects.
        const pond = nodes().find(n => n.type === 'lightProbe' && n.name === 'Pond Probe');
        expect(pond).toBeDefined();
        for (let i = 0; i < 3; i++) expect(Math.abs(water.position[i] - pond.position[i]), `axis ${i}`).toBeLessThan(pond.size[i] / 2);
        expect(pond.position[1] - level).toBeGreaterThan(0.5);
    });

    it('lights and reflects the valley with one unbounded probe, and its places with probes of their own', () => {
        const probes = nodes().filter(n => n.type === 'lightProbe');
        const byName = new Map(probes.map(p => [p.name, p]));
        // The fallback everywhere: unbounded, reflections only.
        const valleyProbe: any = byName.get('Valley Probe');
        expect(valleyProbe.size).toEqual([0, 0, 0]);
        expect(valleyProbe.affectsLighting).toBe(false);
        for (const name of ['Bonfire Probe', 'Hamlet Probe', 'Pond Probe', 'Windmill Probe', 'Cave Mouth Probe']) {
            const p: any = byName.get(name);
            expect(p, name).toBeDefined();
            expect(p.size.every((v: number) => v > 0), name).toBe(true);
            // Out of doors the diffuse fill stays the sky light's: reflections only.
            expect(p.affectsLighting, name).toBe(false);
            expect(p.affectsReflections, name).toBe(true);
            // Captured near the ground it stands over, at about eye height.
            const lift = p.position[1] - heightAt(p.position[0], p.position[2]);
            if (name !== 'Pond Probe') expect(lift, name).toBeGreaterThan(1.5);
            if (name !== 'Pond Probe') expect(lift, name).toBeLessThan(4);
        }
        // Each house interior is lit by its own probe, its box the interior exposure volume's.
        const interiors = probes.filter(p => p.name.endsWith('Interior Probe'));
        expect(interiors.length).toBe(2);
        for (const p of interiors) {
            expect(p.affectsLighting, p.name).toBe(true);
            const exposure = nodes().find(n => n.type === 'exposureVolume' && n.name === p.name.replace(' Probe', ' Exposure'));
            expect(exposure, p.name).toBeDefined();
            expect(p.position).toEqual(exposure.position);
            expect(p.size).toEqual(exposure.exposureVolume.size);
            expect(p.rotation).toEqual(exposure.rotation);
        }
    });

    it('burns a 2.7 s bonfire loop, and lights a bonfire with its ignition played once', () => {
        const tilesets = library('tilesets');
        const loop = tilesets.find((t: any) => t.name === 'Bonfire Fire');
        const ignition = tilesets.find((t: any) => t.name === 'Bonfire Ignition');
        expect(loop).toBeDefined();
        expect(ignition).toBeDefined();
        const bonfire = library('templates').find((t: any) => t.name === 'Bonfire').nodeJson;
        const sprites: any[] = [];
        const walk = (n: any) => { if (n.type === 'animatedSprite') sprites.push(n); (n.children ?? []).forEach(walk); };
        walk(bonfire);
        const flames = sprites.filter(n => n.name === 'Flame');
        expect(flames.length).toBe(2);
        for (const f of flames) {
            expect(f.animation.frames.length).toBe(96);
            expect(f.animation.frames.length / f.animation.fps).toBeGreaterThan(2.5);
            expect(f.animation.loop).toBe(true);
        }
        const ign = sprites.find(n => n.name === 'Ignition');
        expect(ign, "an Ignition sprite under the bonfire's fire").toBeDefined();
        expect(ign.animation.loop).toBe(false);
        expect(ign.animation.randomStart ?? false).toBe(false);
        expect(ign.visible).toBe(false);
        expect(ign.sprite.tilesetId).toBe(ignition.id);
        // The same frame as the loop flame it hands over to.
        expect(ign.position).toEqual(flames[0].position);
        expect(ign.scale).toEqual(flames[0].scale);
    });

    it("shadows the torches' lights, and only theirs", () => {
        const templates = library('templates');
        const lightsOf = (name: string) => {
            const out: any[] = [];
            const walk = (n: any) => { if (n.type === 'light') out.push(n); (n.children ?? []).forEach(walk); };
            walk(templates.find((t: any) => t.name === name).nodeJson);
            return out;
        };
        for (const name of ['Torch', 'Wall Torch']) expect(lightsOf(name).map(l => l.castShadows), name).toEqual([true]);
        for (const name of ['Candle', 'Hanging Brazier']) expect(lightsOf(name).map(l => l.castShadows), name).toEqual([false]);
    });

    it('gives the water a transparent forward custom material with WGSL a published WebGPU game can use', async () => {
        const water = nodes().find(n => n.name === 'Pond Water');
        const asset = library('materials').find((m: any) => m.id === water.variables.__materialId.value);
        const m = asset.material;
        expect(asset.name).toBe('Water');
        expect([m.customMaterial, m.renderMode, m.config.transparent, m.config.probeable]).toEqual([true, 'forward', true, false]);
        const { WATER_SOURCE, WATER_UNIFORMS } = await import('../tools/valley/water.mjs');
        expect(m.fragmentSource).toBe(WATER_SOURCE);
        expect(m.uniforms.map((u: any) => u.name)).toEqual(WATER_UNIFORMS.map((u: any) => u.name));
        expect(asset.textureIds).toContain(m.textures.normalMap);
        const { customWgslHash } = await import('../src/graphics/systems/customShaders');
        expect(m.compiledWgsl).toContain('@fragment');
        expect(m.compiledWgslHash).toBe(customWgslHash('forward', m.fragmentSource, m.uniforms));
        const { CustomMaterial } = await import('../src/graphics/material');
        expect(m.compiledWgslType).toBe(CustomMaterial.parse(m).type);
    });

    it('buoys the pond through a water volume whose surface is the water mesh, feeding its ripples', () => {
        const water = nodes().find(n => n.name === 'Pond Water');
        const volume = nodes().find(n => n.type === 'waterVolume');
        expect(volume.name).toBe('Pond Water Volume');
        const v = volume.waterVolume;
        expect(v.surfaceNodeId).toBe(water.id);
        expect(v.affectCharacters).toBe(false);
        expect(v.density).toBe(1000);
        // Its top face is the water level, and it reaches below the deepest point of the basin.
        expect(volume.position[1] + v.size[1] / 2).toBeCloseTo(water.position[1], 3);
        expect(volume.position[1] - v.size[1] / 2).toBeLessThan(heightAt(water.position[0], water.position[2]));
        // The FX Creator's splashes: a crown for something entering it, a small one for each wading step.
        expect(v.splashTemplate).toBe('Water Splash');
        expect(v.wadeSplashTemplate).toBe('Water Step');
        const templates = library('templates');
        for (const name of ['Water Splash', 'Water Step']) {
            const t = templates.find((x: any) => x.name === name);
            expect(t, name).toBeTruthy();
            const ps = t.nodeJson.children.find((c: any) => c.type === 'particleSystem');
            // A crown sprite and droplets, both on Creator flipbooks, lit like the water they are.
            for (const e of ps.particleSystem.system.emitters) {
                expect(e.render.textureId, `${name} ${e.name}`).toBeTruthy();
                expect(e.render.lit).toBe(true);
                expect(e.render.blend).toBe('alpha');
            }
            // Big enough to read against the pond: the crown about two metres across, a step's under one.
            const crown = ps.particleSystem.system.emitters.find((e: any) => e.name === 'Burst');
            const size = crown.init.find((m: any) => m.type === 'size').params.range;
            expect(size[0], name).toBeGreaterThanOrEqual(name === 'Water Splash' ? 1.8 : 0.75);
        }
    });

    it('raises lit smoke over the valley bonfire', () => {
        const bonfire = nodes().find(n => n.name === 'Bonfire' && n.type === 'node');
        const smoke = allNodes(bonfire).filter((n: any) => n.type === 'animatedSprite' && n.name === 'Smoke');
        expect(smoke).toHaveLength(1);
        expect(smoke[0].sprite.lit).toBe(true);
        expect(smoke[0].sprite.tileset.sixWayPositiveTextureId).toBeTruthy();
        // A fireplace's fire (a hearth) has none.
        for (const h of nodes().filter(n => n.name === 'Hearth'))
            expect(allNodes(h).some((n: any) => n.name === 'Smoke'), h.id).toBe(false);
    });

    it('lays rain puddles from the FX Creator in the low spots of the trails', () => {
        const group = nodes().find(n => n.name === 'Puddles');
        expect(group).toBeTruthy();
        const puddles = group.children;
        expect(puddles.length).toBeGreaterThanOrEqual(15);
        expect(puddles.length).toBeLessThanOrEqual(35);
        const materials = library('materials');
        for (const p of puddles) {
            const d = p.children.find((c: any) => c.type === 'decal');
            expect(d, p.name).toBeTruthy();
            // The Water Puddle bake's settled decal: a still, on the ground only.
            expect(d.decal.flipbook).toBeUndefined();
            expect(d.decal.receivers).toBe('terrain');
            const m = materials.find((x: any) => x.id === d.variables.__materialId?.value);
            expect(m?.name, p.name).toBe('Water Puddle Decal');
            // On the ground it marks: its box stands at the terrain height there.
            expect(Math.abs(p.position[1] - heightAt(p.position[0], p.position[2]))).toBeLessThan(0.05);
        }
        // Sparse: never two within a few metres.
        for (let i = 0; i < puddles.length; i++) for (let j = i + 1; j < puddles.length; j++) {
            const a = puddles[i].position, b = puddles[j].position;
            expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeGreaterThan(8.5);
        }
    });

    it('slows and grounds whoever wades in through a water zone at the water level', () => {
        const water = nodes().find(n => n.name === 'Pond Water');
        const zone = nodes().find(n => n.name === 'Pond Zone');
        expect(zone.variables.isWater.value).toBe(true);
        expect(zone.variables.waterSpeedScale.value).toBeGreaterThan(0);
        expect(zone.variables.waterSpeedScale.value).toBeLessThan(1);
        expect(zone.variables.waterLevel.value).toBeCloseTo(water.position[1], 3);
        const shape = zone.trigger.shapes[0];
        expect(shape.type).toBe('cylinder');
        expect(shape.radius).toBeGreaterThan(5);
        // From the basin floor to above the surface, so a wading capsule is inside it.
        expect(zone.position[1] + shape.offset[1] + shape.height / 2).toBeGreaterThan(water.position[1] + 1.5);
    });

    it('drops props of different densities into the pond, above the water', () => {
        const water = nodes().find(n => n.name === 'Pond Water');
        const named = (name: string) => nodes().find(n => n.name === name);
        const density = (n: any) => {
            const [sx, sy, sz] = n.scale;
            const shape = n.body.shapes[0];
            const vol = shape.type === 'box' ? sx * sy * sz : Math.PI * (0.5 * sx) * (0.5 * sz) * sy;
            return n.body.mass / vol;
        };
        for (const name of ['Floating Crate', 'Floating Log', 'Floating Barrel', 'Iron Chest']) {
            const n = named(name);
            expect(n, name).toBeDefined();
            expect(n.body.mass, name).toBeGreaterThan(0);
            expect(n.position[1], name).toBeGreaterThan(water.position[1]);
        }
        expect(density(named('Floating Crate'))).toBeLessThan(500);
        expect(density(named('Floating Log'))).toBeLessThan(1000);
        expect(density(named('Iron Chest'))).toBeGreaterThan(1000);   // the one that sinks
    });

    it('carries ripple slots instead of foam on the water material', () => {
        const water = nodes().find(n => n.name === 'Pond Water');
        const asset = library('materials').find((m: any) => m.id === water.variables.__materialId.value);
        const names = asset.material.uniforms.map((u: any) => u.name);
        for (let i = 0; i < 12; i++) expect(names).toContain(`ripple${i}`);
        for (const foam of ['foamColor', 'foamWidth', 'foamAmount']) expect(names).not.toContain(foam);
        expect(asset.material.fragmentSource).not.toMatch(/foam/i);
    });

    it('fills the cliff notch with the skull cave, which asks before loading the dungeon scene', () => {
        expect(nodes().some(n => n.name === 'Fog Gate')).toBe(false);
        expect(nodes().some(n => n.scriptVars?.isBossSpawn === true)).toBe(false);
        const cave = nodes().find(n => n.name === 'Skull Cave Entrance');
        expect(cave.scriptVars.targetScene).toBe('Dungeon');
        expect(cave.scriptVars.frontOnly).toBe(true);
        // Its face on the notch line, the rest of it back over the plaza.
        expect(cave.position[2]).toBeLessThan(-117.5);
        const template = library('templates').find((t: any) => t.id === cave.variables.__templateId.value);
        expect(template.bodies[template.nodeJson.id].shapes[0].type).toBe('convex');
        expect(template.triggers[template.nodeJson.id].shapes[0].offset[2]).toBeGreaterThan(0);
    });

    it('breathes a mist out of the skull cave, and keeps the rest of the valley clear but the pond', () => {
        const fogs = nodes().filter(n => n.type === 'volumetricFog');
        expect(fogs.map(n => n.name).sort()).toEqual(['Cave Mouth Mist', 'Pond Mist']);
        const mist = fogs.find(n => n.name === 'Cave Mouth Mist');
        // Round the cave's door (its trigger, in front of the arch), and low on the plaza.
        const door = [0, 6.19, -116];
        const half = mist.volumetricFog.size.map((s: number) => s / 2);
        for (let a = 0; a < 3; a++) expect(Math.abs(door[a] - mist.position[a])).toBeLessThan(half[a]);
        expect(mist.volumetricFog.heightFalloff).toBeGreaterThan(0);
    });

    it('fills the shade with the sky, a little bounce and a third of the overcast grade, not a flat floor', () => {
        // The flat ambient lights like pi times its lux (it is added straight onto the albedo): kept to the
        // ground's bounce, so open shade is about a quarter of the sunlit ground, not more than half.
        const ambient = scene().scene.ambientLight ?? scene().ambientLight;
        const lum = 0.2126 * ambient[0] + 0.7152 * ambient[1] + 0.0722 * ambient[2];
        expect(lum).toBeGreaterThan(300);
        expect(lum).toBeLessThan(1000);
        const sky = nodes().find(n => n.type === 'skyLight');
        expect(sky.skyLight.cloudShadows).toBe(true);
        expect(sky.skyLight.cloudResponse).toBeCloseTo(0.35, 6);
    });

    it('grades the valley with AgX Punchy, so its clear sky stays blue, and the dungeon with plain AgX', () => {
        expect(scene().config.render.toneMapper).toBe('agxPunchy');
        const dungeon = read('scenes', `${manifest().sceneMetas[1].id}.json`);
        expect(dungeon.config.render.toneMapper ?? 'agx').toBe('agx');
    });

    const dungeonNodes = () => allNodes(read('scenes', `${manifest().sceneMetas[1].id}.json`).scene);

    it('ships the dungeon as a second scene, with the way back to the valley', () => {
        const metas = manifest().sceneMetas;
        expect(metas.map((m: any) => m.name)).toEqual(['Valley', 'Dungeon']);
        const all = dungeonNodes();
        expect(all.some(n => n.name === 'Player')).toBe(true);
        expect(all.some(n => n.name === 'GameManager')).toBe(true);
        const exit = all.find(n => n.name === 'Way Out' && n.scriptVars);
        expect(exit.scriptVars.targetScene).toBe('Valley');
        expect(exit.trigger.shapes.length).toBe(1);
        // The cave and the ladder name each other, so a trip down and back ends where it began.
        expect(exit.scriptVars.exitTo).toBe('Skull Cave Entrance');
        expect(nodes().find(n => n.name === 'Skull Cave Entrance').scriptVars.exitTo).toBe('Way Out');
    });

    it('places the dungeon props as LOD groups that cull with distance', () => {
        const models = new Map(library('models').map((m: any) => [m.id, m]));
        const placed = dungeonNodes().filter(n => {
            const m: any = models.get(n.variables?.__modelId?.value);
            return m && (m.lods?.length || m.cullDistance);
        });
        expect(placed.length).toBeGreaterThan(20);
        for (const n of placed) {
            const m: any = models.get(n.variables.__modelId.value);
            expect(n.type, n.name).toBe('lodGroup');
            expect(n.cullDistance, n.name).toBe(m.cullDistance);
            expect(n.cullDistance, n.name).toBeGreaterThan(0);
            expect(n.children.length, n.name).toBe((m.lods?.length ?? 0) + 1);
        }
        // The scanned props really have levels; the bookcase and the weapons are the big ones.
        for (const name of ['Bookcase', 'Ornate Mace', 'Barrel'])
            expect([...models.values()].find((m: any) => m.name === name)?.lods?.length, name).toBeGreaterThan(0);
    });

    it('builds the dungeon from the medieval structure, chunked, every glb material mapped', () => {
        const all = dungeonNodes();
        const structure = all.find(n => n.name === 'Dungeon Structure');
        const chunks = allNodes(structure).filter(n => n.type === 'model');
        expect(chunks.length).toBeGreaterThan(60);
        const materials = new Map(library('materials').map((m: any) => [m.id, m.name]));
        const used = new Set(chunks.map(n => materials.get(n.variables.__materialId.value)));
        // Rocky walls and slabs from build/wall_textures, wood and metal the model's own.
        for (const name of ['Dungeon Castle Slates', 'Dungeon Cobblestone Floor', 'Dungeon Stone Brick Wall', 'Dungeon Stone Slabs',
            'Dungeon Wood Planks', 'Dungeon Old Wood', 'Dungeon Iron']) expect(used.has(name), name).toBe(true);
        // No chunk spans the dungeon: each is one 10 m cell's triangles (and their overhang).
        for (const c of chunks.slice(0, 40)) {
            const p = c.model.geometry.positions;
            let minX = Infinity, maxX = -Infinity;
            for (let i = 0; i < p.length; i += 3) { minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]); }
            expect(maxX - minX, c.name).toBeLessThan(25);
        }
    });

    it('gives the dungeon box colliders over its floors, walls, ramps and steps', () => {
        const all = dungeonNodes();
        const bodies = allNodes(all.find(n => n.name === 'Collision')).filter(n => n.body);
        const shapes = bodies.flatMap(n => n.body.shapes);
        // Merged hard (dungeon/collision.mjs: tolerances, pillars one box, diagonals one turned box): it
        // was over 3000 boxes before.
        expect(shapes.length).toBeGreaterThan(1000);
        expect(shapes.length).toBeLessThan(2000);
        expect(shapes.every((s: any) => s.type === 'box')).toBe(true);
        // The stairs are ramps under 45 degrees.
        const ramps = shapes.filter((s: any) => Math.abs(s.rotation[0]) > 20);
        expect(ramps.length).toBeGreaterThanOrEqual(2);
        for (const r of ramps) expect(Math.abs(r.rotation[0])).toBeLessThan(45);
        // Walls and pillars are what swings bounce off; floors are walked on, never carved out of the navmesh.
        // The pillars' bodies are see-through to the player camera, like the pillars; the walls' are not.
        for (const n of bodies) {
            if (n.name.startsWith('Walls') || n.name.startsWith('Pillars')) expect(n.variables.blocksSwings?.value, n.name).toBe(true);
            else expect(n.variables.navObstacle?.value, n.name).toBe(false);
            expect(!!n.cameraDither, n.name).toBe(n.name.startsWith('Pillars'));
        }
        expect(bodies.some(n => n.name.startsWith('Pillars'))).toBe(true);
    });

    it('hangs wall torches at the light rig sconces, spaced apart, and lights the dungeon with fire', () => {
        const all = dungeonNodes();
        const templates = library('templates');
        const templateOf = (n: any) => templates.find((t: any) => t.id === n.variables?.__templateId?.value);
        const count = (name: string) => all.filter(n => templateOf(n)?.name === name).length;
        // Thinned (layout SCONCE_SPACING and the FIRES list): enough to light every room, never a cluster.
        expect(count('Wall Torch')).toBeGreaterThan(12);
        expect(count('Wall Torch')).toBeLessThan(30);
        expect(count('Torch')).toBe(4);
        expect(count('Candle')).toBe(8);
        expect(count('Fire Pit')).toBe(3);
        expect(count('Bonfire')).toBe(1);
        expect(count('Hanging Brazier')).toBe(2);
        // Fire is the FX Creator's: the torches' and the hearths' flames, each in tall 128 x 256 frames;
        // additive (a flame is light: it never darkens what is behind it) and taking a tenth of the
        // exposure (fire at noon as at night), each burning copy on a frame of its own. The torch loops in
        // 32 frames (8 x 4), the bonfire in 96 (2.7 s); the bonfire's ignition plays once, from its start.
        const flames = all.filter(n => n.type === 'animatedSprite' && n.name !== 'Smoke');
        expect(flames.length).toBeGreaterThan(30);
        const tilesets = new Set(flames.map(f => f.sprite.tileset.name));
        expect([...tilesets].sort()).toEqual(['Bonfire Fire', 'Bonfire Ignition', 'Torch Fire']);
        const frames: Record<string, number> = { 'Torch Fire': 32, 'Bonfire Fire': 96, 'Bonfire Ignition': 64 };
        for (const f of flames) {
            const t = f.sprite.tileset;
            expect([t.tileWidth, t.tileHeight], t.name).toEqual([128, 256]);
            expect(t.columns * t.rows, t.name).toBeGreaterThanOrEqual(frames[t.name]);
            expect(f.sprite.blend).toBe('additive');
            expect(f.sprite.exposureWeight).toBe(0.1);
            const once = f.name === 'Ignition';
            expect(f.animation.randomStart ?? false, f.name).toBe(!once);
            expect(f.animation.loop, f.name).toBe(!once);
            expect(f.animation.frames, t.name).toHaveLength(frames[t.name]);
            // The flame's base sits inside its torch or pit: it fades into it over a few centimetres, never
            // more than a torch head is deep (the head in front of it must still hide it).
            expect(f.sprite.softness, f.name).toBeGreaterThan(0);
            expect(f.sprite.softness, f.name).toBeLessThanOrEqual(0.15);
        }
        // Embers always; sparks one at a time, falling and bouncing off the floor.
        const fx = library('particleSystems').find((p: any) => p.name === 'Torch Embers');
        const sparks = fx.system.emitters.find((e: any) => e.name === 'Sparks');
        const burst = sparks.spawn.find((m: any) => m.type === 'spawnBurst').params.bursts[0];
        // Three single sparks a cycle, seconds apart: a crackle, not a fountain.
        expect(burst.count).toBe(1);
        expect(burst.cycles).toBe(3);
        expect(burst.interval).toBeGreaterThan(1);
        const collision = sparks.update.find((m: any) => m.type === 'collision').params;
        // Off the scene depth, where the floor they land on is drawn; not the physics bodies, which would
        // pack every collider near every torch into the simulation each frame.
        expect(collision.depth).toBe(true);
        expect(collision.bodies).toBe(false);
        expect(collision.restitution).toBeGreaterThan(0.2);
        expect(fx.system.emitters.some((e: any) => e.name === 'Embers')).toBe(true);

        // Smoke over the bonfire and the fire pits: a LIT sprite relit by the Creator's six-way lightmaps
        // (the fire below lights it), alpha-blended, soft where it meets the logs and the ceiling.
        const smokes = all.filter(n => n.type === 'animatedSprite' && n.name === 'Smoke');
        expect(smokes).toHaveLength(4);
        const shipped = new Set(read('textures', 'index.json').map((t: any) => t.id));
        for (const s of smokes) {
            expect(s.sprite.lit, s.id).toBe(true);
            expect(s.sprite.blend ?? 'alpha').toBe('alpha');
            expect(s.sprite.softness).toBeGreaterThan(0.1);
            expect(s.animation.loop).toBe(true);
            const t = s.sprite.tileset;
            expect(t.name).toBe('Fire Smoke');
            for (const key of ['textureId', 'sixWayPositiveTextureId', 'sixWayNegativeTextureId']) expect(shipped.has(t[key]), key).toBe(true);
            // Under the entry hall's 4.2 m ceiling: the column's top below 4 m over the fire.
            expect(s.position[1] + s.scale[1] / 2).toBeLessThan(4.2);
        }
    });

    it('makes the dungeon a level: enemies, a bonfire, and the Warden behind a fog gate', () => {
        const all = dungeonNodes();
        const spawns = all.filter(n => n.name?.startsWith('Spawn '));
        expect(spawns.length).toBeGreaterThanOrEqual(10);
        const boss = spawns.find(n => n.scriptVars?.isBossSpawn === true);
        expect(boss.scriptVars.templateName).toBe('Hollow Warden');
        expect(all.some(n => n.name === 'Fog Gate')).toBe(true);
        expect(all.some(n => n.variables?.isBossArena?.value === true)).toBe(true);
        for (const name of ['Boss Reward', 'Epilogue Message']) expect(all.some(n => n.name === name), name).toBe(true);
        const nav = all.find(n => n.type === 'navMesh');
        expect(nav?.navMesh, 'baked navmesh').toBeTruthy();
    });

    it('breaks barrels into a debris template whose pieces stand inside the barrel', () => {
        const templates = library('templates');
        const barrel = templates.find((t: any) => t.name === 'Breakable Barrel');
        const debris = templates.find((t: any) => t.name === 'Barrel Debris');
        expect(barrel.nodeJson.scriptVars.debrisTemplate ?? 'Barrel Debris').toBe(debris.name);
        expect(barrel.bodies[barrel.nodeJson.id].mass).toBe(0);
        expect(barrel.triggers[barrel.nodeJson.id].shapes.length).toBe(1);
        expect(debris.nodeJson.children).toHaveLength(17);
        for (const p of debris.nodeJson.children) {
            expect(Math.hypot(p.position[0], p.position[2]), p.name).toBeLessThan(0.5);
            expect(p.position[1], p.name).toBeGreaterThanOrEqual(0);
            expect(p.position[1], p.name).toBeLessThan(1);
        }
        expect(nodes().filter(n => n.name === 'Breakable Barrel').length).toBeGreaterThan(8);
    });
});
