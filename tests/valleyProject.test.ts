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

const PROJECT = join(__dirname, '..', 'editor', 'public', 'examples', 'valley');
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

    it('uses the library landscape material: ground, rocky dirt, a painted forest floor, rock, snow and a painted trail', () => {
        const s = terrain().layerStack;
        const asset = library('terrainMaterials').find((m: any) => m.id === s.base.materialId);
        expect(asset).toBeDefined();
        expect(s.base.material).toEqual(asset.material);
        expect(asset.material.slots.map((x: any) => x.name)).toEqual(['Rocky Dirt', 'Forest Floor', 'Rock', 'Snow', 'Trail']);
        for (const name of ['Trail', 'Forest Floor']) {
            const slot = asset.material.slots.find((x: any) => x.name === name);
            expect(slot.manual, name).toBe(true);
            expect(s.slotChannels[slot.id], name).toBeTypeOf('number');
        }
        // Two painted slots, two channels.
        expect(new Set(Object.values(s.slotChannels)).size).toBe(2);
        // The moss rocks belong to the Rocky Dirt, not the ground.
        const dirt = asset.material.slots.find((x: any) => x.name === 'Rocky Dirt');
        expect(dirt.foliageInclude.map((r: any) => r.name)).toEqual(['Moss Rock A', 'Moss Rock B', 'Moss Rock C', 'Moss Rock D']);
        // Bedded into the slope rather than standing level on it.
        for (const r of dirt.foliageInclude) expect(r.orientation, r.name).toBe('normal');
        const shipped = new Set(read('textures', 'index.json').map((t: any) => t.id));
        for (const id of asset.textureIds) expect(shipped.has(id), id).toBe(true);
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

    it('draws the source plants at LOD0, ends grass at 20 m and hands distant pines to a shipped impostor', () => {
        const rules = allRules();
        const textures = new Set(manifest().sceneMetas[0].refs.textureIds);
        const tris = (models: any[]) => models.reduce((n, m) => n + m.geometry.indices.length / 3, 0);
        for (const layer of terrain().foliage) {
            const rule = rules.find((r: any) => r.id === layer.key);
            const lod0 = tris(layer.models ?? [layer.model]);
            if (layer.name.includes('Grass') || layer.name.includes('Celandine')) {
                expect(layer.cullDistance, layer.name).toBe(20);
                expect(lod0, layer.name).toBeGreaterThan(4000);   // full clumps, not a thinned patch
                expect(layer.billboard, layer.name).toBeUndefined();
            } else if (layer.name.includes('Moss Rock')) {
                expect(lod0, layer.name).toBeGreaterThan(7000);
                expect(layer.cullDistance, layer.name).toBe(120);
            } else {
                expect(lod0, layer.name).toBeGreaterThan(400000);
                // 15% and 5% of the source, give or take what the decimator keeps.
                const [l1, l2] = layer.lods.map((l: any) => tris(l.models));
                expect(l1 / lod0).toBeGreaterThan(0.13); expect(l1 / lod0).toBeLessThan(0.17);
                expect(l2 / lod0).toBeGreaterThan(0.04); expect(l2 / lod0).toBeLessThan(0.06);
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

    it('stands every plant on the surface, keeps grass off the roads, and stays under the layer cap', () => {
        for (const layer of terrain().foliage) {
            const bytes = b64(layer.instances);
            const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
            const count = f.length / 5;
            expect(count, layer.name).toBeGreaterThan(100);
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

    it('places each building as a linked copy with a convex collider, nothing floating', () => {
        const models = library('models');
        const buildings = nodes().find(n => n.name === 'Buildings').children;
        expect(buildings.map((b: any) => b.name).sort()).toEqual(['Granary', 'Long House', 'Old House', 'Windmill']);
        for (const b of buildings) {
            expect(models.some((m: any) => m.id === b.variables.__modelId.value), b.name).toBe(true);
            expect(b.body.mass).toBe(0);
            expect(b.body.shapes[0].type).toBe('convex');
            // The base goes at the LOWEST ground under the footprint, so it never floats over the centre.
            expect(b.position[1], b.name).toBeLessThanOrEqual(heightAt(b.position[0], b.position[2]));
        }
        const sails = allNodes(buildings.find((b: any) => b.name === 'Windmill')).find(n => n.name === 'Sails');
        expect(sails.script).toContain('class ValleyWindmillNode');
    });

    it('fills the pond with water that stays below every bank, under a probe it reflects', () => {
        const water = nodes().find(n => n.name === 'Pond Water');
        const [px, level, pz] = water.position;
        for (let a = 0; a < 360; a += 5) {
            const r = 10.5;
            expect(level, `bank at ${a}°`).toBeLessThan(heightAt(px + Math.cos(a * Math.PI / 180) * r, pz + Math.sin(a * Math.PI / 180) * r));
        }
        expect(level - heightAt(px, pz)).toBeGreaterThan(0.5);    // there is a pond, not a puddle
        const probe = nodes().find(n => n.name === 'Pond Probe');
        expect(probe.type).toBe('lightProbe');
        expect(Math.hypot(probe.position[0] - px, probe.position[2] - pz)).toBeLessThan(1);
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
        // Ripples only: no splash particles.
        expect(v.splashTemplate).toBe('');
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

    it('ships the dungeon as a second scene, with the way back to the valley', () => {
        const metas = manifest().sceneMetas;
        expect(metas.map((m: any) => m.name)).toEqual(['Valley', 'Dungeon']);
        const dungeon = read('scenes', `${metas[1].id}.json`);
        const all: any[] = [];
        const walk = (n: any) => { all.push(n); (n.children ?? []).forEach(walk); };
        walk(dungeon.scene);
        expect(all.some(n => n.name === 'Player')).toBe(true);
        expect(all.some(n => n.name === 'GameManager')).toBe(true);
        const exit = all.find(n => n.name === 'Way Out');
        expect(exit.scriptVars.targetScene).toBe('Valley');
        expect(exit.trigger.shapes.length).toBe(1);
        expect(all.find(n => n.name === 'Floor').body.shapes.length).toBe(1);
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
