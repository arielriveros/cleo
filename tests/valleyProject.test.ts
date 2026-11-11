import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { defaultMaskResolution } from '../src/terrain/terrainLayerStack';
import { MAX_INSTANCES } from '../src/terrain/foliage';
import { decodePng } from '../src/terrain/heightmapIO';
import { readExample } from '../tools/exampleKit/readExample.mjs';

// The Valley example: the generated landscape (tools/valley/build.mjs) as scenery, its gameplay split off
// into the Dungeon example (tools/valley/split.ts; dungeonProject.test.ts, dungeonSouls.test.ts). This suite
// checks the valley itself — the landscape blob, its material and trail mask, the pre-baked foliage, the
// buildings — none of which fails loudly: a mask at the wrong resolution is resampled with a warning, a
// foliage layer whose key matches no rule is orphaned, a building on the wrong y floats. And that none of
// the game it used to be is left in it.

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

    it('ships no gameplay: one scene, no player, enemies, souls scripts, characters or clips', () => {
        expect(manifest().sceneMetas.map((m: any) => m.name)).toEqual(['Valley']);
        const names = new Set(nodes().map(n => n.name));
        for (const name of ['Player', 'GameManager', 'Enemy Spawns', 'Interactables', 'Barrels', 'Nav Mesh', 'Bonfire', 'Skull Cave Entrance', 'Pond Zone'])
            expect(names.has(name), name).toBe(false);
        expect(nodes().some(n => ['character', 'controller', 'navMesh'].includes(n.type))).toBe(false);
        // The only UI is the start menu and the cinematic's overlay (cinematic.ts), not the game's HUD.
        expect(nodes().filter(n => n.type === 'uiRoot').map(n => n.name).sort()).toEqual(['Cinematic Overlay', 'Start Menu']);
        // The libraries hold what the scenery uses and nothing of the game (split.ts prunes them).
        for (const s of library('scripts')) expect(s.source, s.name).not.toMatch(/class Souls\w*Node/);
        expect(library('scripts').map((s: any) => s.name).sort()).toEqual(['Day and Night', 'Fire Light', 'Fly Camera', 'Splash', 'Start Menu', 'Windmill Sails']);
        expect(library('templates').map((t: any) => t.name).sort()).toEqual(['Torch', 'Wall Torch', 'Water Splash', 'Water Step']);
        for (const lib of ['animations', 'animControllers', 'animationFields', 'rigs', 'aiBrains', 'boneMasks'])
            expect(library(lib) ?? [], lib).toHaveLength(0);
        expect(library('models').some((m: any) => /Knight|Hollow|mannequin/i.test(m.name))).toBe(false);
        expect(read('vfs.json').entries.some((e: any) => e.path.startsWith('/Characters'))).toBe(false);
    });

    it('references only assets it ships', async () => {
        const { walkRefs, edgesOfAsset } = await import('../applications/editor/src/utils/assetEdges');
        const KINDS = { materials: 'material', terrainMaterials: 'terrainMaterial', templates: 'template', models: 'model', tilesets: 'tileset', particleSystems: 'particleSystem' };
        const ids = new Set<string>([
            ...read('textures', 'index.json').map((t: any) => `texture:${t.id}`),
            ...Object.entries({ ...KINDS, scripts: 'script' }).flatMap(([lib, kind]) => (library(lib) ?? []).map((a: any) => `${kind}:${a.id}`)),
        ]);
        const edges: any[] = [];
        walkRefs(scene(), edges);
        for (const [lib, kind] of Object.entries(KINDS)) for (const a of library(lib) ?? []) edges.push(...edgesOfAsset(kind as any, a));
        const missing = edges.map(e => `${e.to.kind}:${e.to.id}`).filter(k => !ids.has(k) && !k.endsWith('__impostor') && !k.startsWith('image:'));
        expect([...new Set(missing)]).toEqual([]);
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
        for (const name of ['Spruce A Bark', 'Oak Bark', 'Shrub A Bark'])
            expect(byName.get(name)?.translucency ?? 0, name).toBe(0);
    });

    it('makes every plant a foliage material: grass and bushes part, trees barely move, all vary and weather', () => {
        const byName = new Map(library('materials').map((m: any) => [m.name, m.material]));
        // Material interactBend / interactRecovery, as the Creator set them (foliageInteraction.ts).
        for (const name of ['Meadow Grass A Grass', 'Tall Grass Grass', 'Shrub A Leaves', 'Juniper Needles', 'Forest Undergrowth A Leaves'])
            expect(byName.get(name)?.interactBend ?? 0, name).toBeGreaterThan(0.3);
        for (const name of ['Spruce A Needles', 'Oak Leaves'])
            expect(byName.get(name)?.interactBend ?? 0, name).toBeLessThan(0.1);
        // Only FOLIAGE materials run any of it (Material.Foliage): every plant's are.
        for (const name of ['Meadow Grass A Grass', 'Spruce A Needles', 'Spruce A Bark', 'Oak Leaves', 'Shrub A Leaves', 'Juniper Needles'])
            expect(byName.get(name)?.type, name).toBe('foliage');
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

    it('flies a free camera from the reference spawn, facing north', () => {
        const fly = nodes().find(n => n.name === 'Fly Camera');
        expect(fly.type).toBe('cameraRig');
        const [x, y, z] = fly.position;
        expect([x, z]).toEqual([-12, 82]);
        // Eye height over open ground.
        expect(y - heightAt(x, z)).toBeGreaterThan(1.5);
        expect(slopeAt(x, z)).toBeLessThan(20);
        expect(fly.yaw).toBe(180);
        // Its own eye: no follow target, no arm, nothing to collide with.
        expect([fly.followId, fly.armLength, fly.collisionEnabled]).toEqual([null, 0, false]);
        const script = library('scripts').find((s: any) => s.id === fly.variables.__scriptId.value);
        expect(script.name).toBe('Fly Camera');
        expect(fly.script).toBe(script.source);
        expect(script.source).toContain('class ValleyFlyCameraNode extends CameraRigNode');
        // A 2 km landscape needs more than the Playable's 100 m camera.
        const camera = fly.children.find((c: any) => c.type === 'camera');
        expect(camera.camera.far).toBeGreaterThanOrEqual(2000);
        // Every action the script reads is bound, on a keyboard and mouse and on a pad (the wheel only on a mouse).
        const map = library('inputMap');
        const actions = new Map(map.maps[0].actions.map((a: any) => [a.name, a]));
        for (const [name, pad] of [['Move', true], ['Look', true], ['Ascend', true], ['Descend', true], ['Sprint', true], ['Fly Speed', false]] as const) {
            const a: any = actions.get(name);
            expect(a, name).toBeDefined();
            expect(script.source, name).toContain(`'${name}'`);
            expect(a.bindings.some((b: any) => ['key', 'pointer', 'mouse'].includes(b.source.device)), name).toBe(true);
            if (pad) expect(a.bindings.some((b: any) => b.source.device.startsWith('gamepad')), name).toBe(true);
        }
        // A free camera has no subject to focus on.
        expect(scene().config.render.dofEnabled).toBe(false);
    });

    it('burns a campfire at the hamlet, on the ground, with nothing to rest at', () => {
        const fire = nodes().find(n => n.name === 'Campfire');
        expect(fire).toBeDefined();
        const [x, y, z] = fire.position;
        expect(Math.abs(y - heightAt(x, z))).toBeLessThan(0.1);
        expect(fire.variables.__scriptId).toBeUndefined();
        expect(fire.variables.__templateId).toBeUndefined();
        expect(fire.trigger).toBeUndefined();
        expect(fire.children.map((c: any) => c.name)).toEqual(['Model', 'Fire']);
        const light = fire.children.find((c: any) => c.name === 'Fire');
        expect(light.scriptVars.lit).toBe(true);
        expect(light.script).toContain('class ValleyFireLightNode');
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
        expect(byName.has('Cave Mouth Probe')).toBe(false);
        for (const name of ['Bonfire Probe', 'Hamlet Probe', 'Pond Probe', 'Windmill Probe']) {
            const p: any = byName.get(name);
            expect(p, name).toBeDefined();
            expect(p.size.every((v: number) => v > 0), name).toBe(true);
            // Out of doors the diffuse fill stays the sky light's: reflections only, not box-projected (the
            // horizon is far away).
            expect(p.affectsLighting, name).toBe(false);
            expect(p.affectsReflections, name).toBe(true);
            expect(p.boxProjection ?? false, name).toBe(false);
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
            // A room's reflections box-projected, so its walls land where they are on its floor.
            expect(p.boxProjection, p.name).toBe(true);
            const exposure = nodes().find(n => n.type === 'exposureVolume' && n.name === p.name.replace(' Probe', ' Exposure'));
            expect(exposure, p.name).toBeDefined();
            expect(p.position).toEqual(exposure.position);
            expect(p.size).toEqual(exposure.exposureVolume.size);
            expect(p.rotation).toEqual(exposure.rotation);
        }
    });

    it('lights the hamlet and every house interior with GI volumes, baked', async () => {
        const { decodeGiBake, readGiBakeHeader, unpackGiBake } = await import('../src/graphics/render/gi/giBakeFormat');
        const volumes = nodes().filter(n => n.type === 'giVolume');
        const byName = new Map(volumes.map(v => [v.name, v]));
        expect(byName.has('Cave Mouth GI')).toBe(false);
        for (const name of ['Hamlet GI']) {
            const v: any = byName.get(name);
            expect(v, name).toBeDefined();
            expect(v.giVolume.rays, name).toBe(64);
        }
        // An interior's volume is its exposure box grown past the walls, so its feather falls out of doors.
        const interiors = volumes.filter(v => v.name.endsWith('Interior GI'));
        expect(interiors.length).toBe(nodes().filter(n => n.type === 'exposureVolume' && n.name.endsWith('Interior Exposure')).length);
        for (const v of interiors) {
            const exposure = nodes().find(n => n.type === 'exposureVolume' && n.name === v.name.replace(' GI', ' Exposure'));
            expect(exposure, v.name).toBeDefined();
            expect(v.position).toEqual(exposure.position);
            expect(v.rotation).toEqual(exposure.rotation);
            v.giVolume.size.forEach((s: number, a: number) => expect(s, v.name).toBeCloseTo(exposure.exposureVolume.size[a] + 0.6, 3));
            expect(v.giVolume.rays, v.name).toBe(256);
            // About a metre between probes: a room's corners and its doorway resolve.
            v.giVolume.size.forEach((s: number, a: number) => expect(s / (v.giVolume.probeCounts[a] - 1), v.name).toBeLessThanOrEqual(1.25));
        }
        // Every volume names its bake, and the whole set fits the atlas a WebGL2 device is guaranteed.
        const probes = volumes.reduce((n, v) => n + v.giVolume.probeCounts.reduce((a: number, c: number) => a * c, 1), 0);
        expect(probes).toBeLessThanOrEqual(16384);
        for (const v of volumes) expect(typeof v.giVolume.bakeId, v.name).toBe('string');
        // The bakes the example carries are packed, belong to a volume, and fit its grid; every volume has one.
        const bakes: { id: string; bytes: ArrayBuffer }[] = valley!.bundle.giBakes ?? [];
        for (const v of volumes) expect(bakes.some(b => b.id === v.giVolume.bakeId), v.name).toBe(true);
        // The valley's volumes replace its ambient: the open sky's fill, which a house's walls shut out.
        for (const v of volumes) expect(v.giVolume.additive ?? false, v.name).toBe(false);
        for (const bake of bakes) {
            const v: any = volumes.find(x => x.giVolume.bakeId === bake.id);
            expect(v, bake.id).toBeDefined();
            const bytes = new Uint8Array(bake.bytes);
            const header = readGiBakeHeader(bytes);
            expect(header.packed, v.name).toBe(true);
            expect(header.counts, v.name).toEqual(v.giVolume.probeCounts);
            expect(header.rays, v.name).toBe(v.giVolume.rays);
            const decoded = decodeGiBake(await unpackGiBake(bytes));
            expect(decoded.probeData.length, v.name).toBe(header.counts[0] * header.counts[1] * header.counts[2] * 4);
        }
    });

    it('relights its probes as the sun moves, not re-captures them', () => {
        const script = readFileSync(join(__dirname, '..', 'examples', 'scripts', 'ValleyDayNight.ts'), 'utf8');
        expect(script).toMatch(/probe\.relight \?\? probe\.bake/);
        expect(script).toMatch(/public probeDegrees: number = 4/);
    });

    it('burns the campfire on the 2.7 s bonfire loop, already alight', () => {
        const tilesets = library('tilesets');
        expect(tilesets.find((t: any) => t.name === 'Bonfire Fire')).toBeDefined();
        // Lit when the valley opens, so the one-shot ignition is never played and does not ship.
        expect(tilesets.find((t: any) => t.name === 'Bonfire Ignition')).toBeUndefined();
        const sprites = allNodes(nodes().find(n => n.name === 'Campfire')).filter((n: any) => n.type === 'animatedSprite');
        const flames = sprites.filter(n => n.name === 'Flame');
        expect(flames.length).toBe(2);
        for (const f of flames) {
            expect(f.animation.frames.length).toBe(96);
            expect(f.animation.frames.length / f.animation.fps).toBeGreaterThan(2.5);
            expect(f.animation.loop).toBe(true);
        }
        expect(sprites.some(n => n.name === 'Ignition')).toBe(false);
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
            // Played and removed by the Valley's own effect script.
            expect(t.nodeJson.script, name).toContain('class ValleyFxNode');
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

    it('raises lit smoke over the campfire', () => {
        const bonfire = nodes().find(n => n.name === 'Campfire');
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

    it('leaves the cliff notch bare: no cave, no door to another scene, no torches at it', () => {
        expect(nodes().some(n => n.name === 'Skull Cave Entrance' || n.scriptVars?.targetScene)).toBe(false);
        // The cave stood at the notch, its mouth about z = -116; its torches went with it.
        for (const n of nodes().filter(n => n.script?.includes('class ValleyFireLightNode') && n.name !== 'Fire'))
            expect(Math.hypot(n.position[0], n.position[2] + 125), n.name).toBeGreaterThan(20);
    });

    it('keeps the valley clear of fog volumes but for the pond mist', () => {
        const fogs = nodes().filter(n => n.type === 'volumetricFog');
        expect(fogs.map(n => n.name)).toEqual(['Pond Mist']);
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

    it('grades the valley with AgX Punchy, so its clear sky stays blue', () => {
        expect(scene().config.render.toneMapper).toBe('agxPunchy');
    });

    // ---- the start menu and the cinematic tour (tools/valley/cinematic.ts) ----------------------------

    const tourNode = () => nodes().find(n => n.type === 'sequence');

    it('opens on a start menu offering the cinematic tour or the free camera', () => {
        const menu = nodes().find(n => n.type === 'uiRoot' && n.name === 'Start Menu');
        expect(menu.visible).toBe(true);
        const script = library('scripts').find((s: any) => s.id === menu.variables.__scriptId.value);
        expect(script.name).toBe('Start Menu');
        expect(menu.script).toBe(script.source);
        expect(script.source).toBe(readFileSync(join(__dirname, '..', 'examples', 'scripts', 'ValleyStartMenu.ts'), 'utf8'));
        expect(allNodes(menu).filter(n => n.type === 'uiButton').map(n => n.name)).toEqual(['Cinematic', 'Free']);
        // The tour it plays is in the scene, under the name the script looks for.
        expect(tourNode().name).toBe(menu.scriptVars?.tourName ?? 'Valley Tour');
        // A map of its own, which still answers while the menu has the Gameplay map switched off.
        const ui = library('inputMap').maps.find((m: any) => m.name === 'UI');
        expect(ui?.enabled).toBe(true);
        for (const action of ['Navigate', 'Submit', 'Pause']) {
            expect(ui.actions.some((a: any) => a.name === action), action).toBe(true);
            expect(script.source, action).toContain(`'${action}'`);
        }
        // The day clock can be held by the tour.
        const clock = nodes().find(n => n.name === 'Time of Day');
        expect(clock.script).toContain('public running: boolean = true');
    });

    it('ships the tour from its checked-in sequence file, every slot bound', async () => {
        const seq = tourNode().sequence;
        const file = JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'valley', 'cinematic', 'valley-tour.sequence.json'), 'utf8'));
        expect(seq).toEqual(file);
        const byId = new Map(nodes().map(n => [n.id, n]));
        for (const slot of seq.slots) expect(byId.has(tourNode().bindings[slot.id]), slot.name).toBe(true);
        const camera = byId.get(tourNode().bindings.camera);
        // A plain camera (a rig would overwrite it), off until the tour cuts to it, with the valley's reach.
        expect(camera.type).toBe('camera');
        expect(camera.active).toBe(false);
        expect(camera.camera.far).toBeGreaterThanOrEqual(2000);
        expect(byId.get(tourNode().bindings.clock).name).toBe('Time of Day');
        // The sequence parses whole: nothing dropped as malformed.
        const { parseSequence } = await import('../src/sequencer/parse');
        expect(parseSequence(seq).tracks.length).toBe(seq.tracks.length);
    });

    it('flies the tour past every part of the valley, clear of the ground and inside the Long House', async () => {
        const { Spline3 } = await import('../src/core/math');
        const { SECTIONS } = await import('../tools/valley/cinematic/tour');
        const { quat, vec3 } = await import('gl-matrix');
        const path = tourNode().sequence.tracks.find((t: any) => t.type === 'path');
        const samples: { shot: string, p: number[] }[] = [];
        for (const section of path.sections) {
            const spline = new Spline3(section.points);
            for (let i = 0; i <= 400; i++) samples.push({ shot: section.id, p: spline.pointAt(i / 400) });
        }
        for (const s of SECTIONS) {
            const nearest = Math.min(...samples.map(({ p }) => Math.hypot(p[0] - s.x, p[2] - s.z)));
            expect(nearest, s.name).toBeLessThan(30);
        }
        // Above the ground (and the pond's surface), everywhere but inside the house.
        const water = nodes().find(n => n.name === 'Pond Water');
        for (const { shot, p } of samples) {
            if (shot === 'shot:interior') continue;
            let floor = heightAt(p[0], p[2]);
            if (Math.hypot(p[0] - water.position[0], p[2] - water.position[2]) < 10.5) floor = Math.max(floor, water.position[1]);
            expect(p[1] - floor, `${shot} at ${p.map(v => v.toFixed(1))}`).toBeGreaterThan(0.7);
        }
        // Inside the Long House: within its interior exposure box (the room, inside the walls), at standing height.
        const room = nodes().find(n => n.type === 'exposureVolume' && n.name === 'Long House Interior Exposure');
        expect(room).toBeDefined();
        const q = quat.invert(quat.create(), quat.fromEuler(quat.create(), room.rotation[0], room.rotation[1], room.rotation[2]));
        const half = room.exposureVolume.size.map((v: number) => v / 2);
        for (const { shot, p } of samples) {
            if (shot !== 'shot:interior') continue;
            const local = vec3.transformQuat(vec3.create(), vec3.fromValues(p[0] - room.position[0], p[1] - room.position[1], p[2] - room.position[2]), q);
            for (let c = 0; c < 3; c++) expect(Math.abs(local[c]), `interior axis ${c} at ${p.map(v => v.toFixed(1))}`).toBeLessThan(half[c] - 0.5);
        }
    });
});
