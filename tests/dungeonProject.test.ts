import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { readExample } from '../tools/exampleKit/readExample.mjs';

// The Dungeon example: the three-level dungeon under the valley's skull cave, built by tools/valley/build.mjs
// (tools/valley/dungeon/) and split out of the Valley into a project of its own by tools/valley/split.ts. The
// souls joins (scripts, clips, templates by name) are checked by dungeonSouls.test.ts; this suite checks the
// level: that it stands alone, its structure, colliders, fires, GI and props.

const PROJECT = join(__dirname, '..', 'applications', 'editor', 'public', 'examples', 'dungeon');
const present = existsSync(join(PROJECT, 'manifest.json'));

// Read through the editor's own bundle reader: the example is checked in as format 2, whose JSON holds
// markers into assets.bin rather than the payloads these tests look at.
const dungeon = present ? await readExample(PROJECT) : null;
const read = (...parts: string[]) => dungeon!.read(...parts);
const allNodes = (root: any): any[] => {
    const out: any[] = [];
    const walk = (n: any) => { out.push(n); for (const c of n.children ?? []) walk(c); };
    walk(root);
    return out;
};

describe.skipIf(!present)('the Dungeon example project', { timeout: 60_000 }, () => {
    const manifest = () => read('manifest.json');
    const scene = () => read('scenes', `${manifest().mainSceneId}.json`);
    const nodes = () => allNodes(scene().scene);
    const library = (name: string) => read('libraries', `${name}.json`);

    it('stands alone: one scene, the player at its spawn, no way out to another scene', () => {
        const metas = manifest().sceneMetas;
        expect(metas.map((m: any) => m.name)).toEqual(['Dungeon']);
        expect(manifest().mainSceneId).toBe(metas[0].id);
        expect(manifest().projectName).toBe('Dungeon');
        const all = nodes();
        const player = all.find(n => n.name === 'Player');
        expect(player.type).toBe('character');
        expect(all.some(n => n.name === 'GameManager')).toBe(true);
        // The ladder and the hatch stay; the door up them, back to the valley, is gone.
        expect(all.some(n => n.scriptVars?.targetScene !== undefined)).toBe(false);
        expect(library('scripts').some((s: any) => s.name === 'Scene Door')).toBe(false);
        expect(all.some(n => n.name === 'Ladder')).toBe(true);
        // Nothing speaks of the valley any more.
        for (const n of all) for (const v of Object.values(n.scriptVars ?? {}))
            if (typeof v === 'string') expect(v, n.name).not.toMatch(/valley/i);
    });

    it('ships nothing of the valley: no landscape, plants, buildings, water or time of day', () => {
        expect(nodes().some(n => ['landscape', 'waterVolume', 'skyAtmosphere'].includes(n.type))).toBe(false);
        expect(library('terrainMaterials') ?? []).toHaveLength(0);
        for (const m of library('models')) expect(m.name).not.toMatch(/Spruce|Oak|Grass|Shrub|Juniper|Boxwood|Undergrowth|Old House|Long House|Granary|Windmill/);
        for (const s of library('scripts')) expect(['Day and Night', 'Windmill Sails', 'Fly Camera', 'Splash']).not.toContain(s.name);
        for (const t of library('templates')) expect(['Skull Cave Entrance', 'Water Splash', 'Water Step']).not.toContain(t.name);
        // What it does share with the valley (the houses' planks, the moss rock, the hatch's darkness) is filed under the Dungeon.
        for (const e of read('vfs.json').entries) expect(e.path, e.path).not.toMatch(/^\/(Environment\/(Landscape|Buildings|Foliage)|Props\/Skull Cave)\//);
    });

    it('ships no cloth simulation', () => {
        const player = library('templates').find((t: any) => t.name === 'Player');
        const knight = player.nodeJson.children.find((c: any) => c.name === 'Knight');
        expect(knight.model.skinnedCloth).toBeUndefined();
    });

    it('gives every enemy type a draw distance on its root, the base template and each variant alike', () => {
        const enemies = library('templates').filter((t: any) => t.nodeJson?.type === 'character' && t.name !== 'Player');
        expect(enemies.length).toBeGreaterThanOrEqual(3);
        for (const t of enemies) expect(t.nodeJson.drawDistance, t.name).toBe(60);
        expect(library('templates').find((t: any) => t.name === 'Player').nodeJson.drawDistance).toBeUndefined();
    });

    it('lays its rubble in moss rock, a plain PBR surface', () => {
        const rock = library('materials').find((m: any) => m.name === 'Moss Rock')?.material;
        expect(rock?.type).toBe('pbr');
        expect(rock?.translucency ?? 0).toBe(0);
    });

    it('burns a 2.7 s bonfire loop, and lights a bonfire with its ignition played once', () => {
        const tilesets = library('tilesets');
        const loop = tilesets.find((t: any) => t.name === 'Bonfire Fire');
        const ignition = tilesets.find((t: any) => t.name === 'Bonfire Ignition');
        expect(loop).toBeDefined();
        expect(ignition).toBeDefined();
        const bonfire = library('templates').find((t: any) => t.name === 'Bonfire').nodeJson;
        const sprites = allNodes(bonfire).filter((n: any) => n.type === 'animatedSprite');
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
        const lightsOf = (name: string) => allNodes(templates.find((t: any) => t.name === name).nodeJson).filter((n: any) => n.type === 'light');
        for (const name of ['Torch', 'Wall Torch']) expect(lightsOf(name).map(l => l.castShadows), name).toEqual([true]);
        for (const name of ['Candle', 'Hanging Brazier']) expect(lightsOf(name).map(l => l.castShadows), name).toEqual([false]);
    });

    it('grades the dungeon with plain AgX', () => {
        expect(scene().config.render.toneMapper ?? 'agx').toBe('agx');
    });

    it('carries a packed bake for every GI volume, fitting its grid', async () => {
        const { decodeGiBake, readGiBakeHeader, unpackGiBake } = await import('../src/graphics/render/gi/giBakeFormat');
        const volumes = nodes().filter(n => n.type === 'giVolume');
        const bakes: { id: string; bytes: ArrayBuffer }[] = dungeon!.bundle.giBakes ?? [];
        expect(bakes.length).toBe(volumes.length);
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

    it('lights every dungeon room with an additive GI volume, baked', () => {
        const volumes = nodes().filter(n => n.type === 'giVolume');
        expect(volumes.length).toBe(13);
        const probes = volumes.reduce((n, v) => n + v.giVolume.probeCounts.reduce((a: number, c: number) => a * c, 1), 0);
        expect(probes).toBeLessThanOrEqual(16384);
        const baked = new Set((dungeon!.bundle.giBakes ?? []).map((b: { id: string }) => b.id));
        for (const v of volumes) {
            // On top of the dungeon's ambient, which is the dark's own light: in its place, the corners went black.
            expect(v.giVolume.additive, v.name).toBe(true);
            expect([64, 256], v.name).toContain(v.giVolume.rays);
            // A probe every 2.5 m or so at most: a hall's pillars and a room's torch resolve.
            v.giVolume.size.forEach((s: number, a: number) => expect(s / (v.giVolume.probeCounts[a] - 1), v.name).toBeLessThanOrEqual(2.75));
            expect(baked.has(v.giVolume.bakeId), v.name).toBe(true);
        }
    });

    it('places the dungeon props as LOD groups that cull with distance', () => {
        const models = new Map(library('models').map((m: any) => [m.id, m]));
        const placed = nodes().filter(n => {
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
        const all = nodes();
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
        const all = nodes();
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
        const all = nodes();
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
        const all = nodes();
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
