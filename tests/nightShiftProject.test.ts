import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { UIRootNode } from '../src/core/scene/nodes/ui/uiRoot';
import { UIPanelNode, UIStackNode } from '../src/core/scene/nodes/ui/uiContainers';
import { UITextNode } from '../src/core/scene/nodes/ui/uiContent';
import { UIButtonNode, UIProgressBarNode } from '../src/core/scene/nodes/ui/uiWidgets';
import { LightNode } from '../src/core/scene/nodes/lightNode';
import { PointLight } from '../src/graphics/lighting';
import { parseBehaviorMachine } from '../src/core/control/behavior';
import { parseConditionNode } from '../src/core/conditions';

// The Night Shift example project is AUTHORED BY CODE (tools/nightShift/build.mjs), and that is a
// standing risk: a hand-written scene writer drifts from the parser the editor actually uses, and the
// failure mode is not an error. A dangling texture id renders as nothing. A sprite missing its embedded
// tileset renders as nothing. A `__scriptId` pointing at no asset silently drops the behaviour. All of
// it looks like "the example is broken" long after the change that broke it.
//
// So this suite reads the GENERATED FOLDER and checks the joins nothing else would: that every id
// resolves, and that the payload shapes match what the engine's own serializers produce today. It is
// deliberately free of GL — no model or landscape node is instantiated, only inspected as JSON.

const PROJECT = join(__dirname, '..', 'editor', 'public', 'examples', 'night-shift');
const present = existsSync(join(PROJECT, 'manifest.json'));

const read = (...parts: string[]) => JSON.parse(readFileSync(join(PROJECT, ...parts), 'utf8'));

/** Every node in a scene tree, depth first. */
function allNodes(root: any): any[] {
    const out: any[] = [];
    const walk = (n: any) => { out.push(n); for (const c of n.children ?? []) walk(c); };
    walk(root);
    return out;
}

describe.skipIf(!present)('the Night Shift example project', () => {
    const manifest = () => read('manifest.json');
    /** Every node the project ships, scene and templates alike. */
    const everyNode = (): any[] => [
        ...allNodes(read('scenes', `${read('manifest.json').mainSceneId}.json`).scene),
        ...read('libraries', 'templates.json').flatMap((t: any) => allNodes(t.nodeJson)),
    ];
    const scene = () => read('scenes', `${manifest().mainSceneId}.json`);
    const library = (name: string) => read('libraries', `${name}.json`);

    describe('the bundle', () => {
        it('names a main scene that exists', () => {
            const m = manifest();
            expect(m.formatVersion).toBe(1);
            expect(m.kind).toBe('project');
            expect(existsSync(join(PROJECT, 'scenes', `${m.mainSceneId}.json`))).toBe(true);
        });

        it('lists every scene it ships', () => {
            const m = manifest();
            for (const meta of m.sceneMetas)
                expect(existsSync(join(PROJECT, 'scenes', `${meta.id}.json`)), meta.name).toBe(true);
        });

        it('points every vfs entry at an asset that exists', () => {
            const ids = new Set<string>([
                ...manifest().sceneMetas.map((s: any) => s.id),
                ...['scripts', 'templates', 'models', 'materials', 'terrainMaterials', 'tilesets',
                    'animationFields'].flatMap(n => library(n).map((a: any) => a.id)),
            ]);
            for (const entry of read('vfs.json').entries)
                expect(ids.has(entry.assetId), entry.path).toBe(true);
        });

        it('ships a payload for every texture the index names', () => {
            for (const entry of read('textures', 'index.json'))
                expect(existsSync(join(PROJECT, entry.file)), entry.id).toBe(true);
        });
    });

    describe('the scene tree', () => {
        it('has a root node literally called "root"', () => {
            // Scene.parse looks the root up BY NAME. Anything else and the whole scene loads as
            // undefined, with nothing to say why.
            expect(scene().scene.name).toBe('root');
        });

        it('gives every node the keys the parser reads unguarded', () => {
            for (const n of allNodes(scene().scene)) {
                for (const key of ['id', 'name', 'type', 'position', 'rotation', 'scale', 'children',
                    'variables', 'spawnOnStart'])
                    expect(n[key], `${n.name}.${key}`).toBeDefined();
            }
        });

        it('authors the scene bright enough to see, in lux', () => {
            // `scene.ambientLight` is LUX (the engine's own default is a tenth of the 78643 reference),
            // and the editor viewport shows the AUTHORED value because the director only runs in Play.
            // Written as a 0..1 colour, the level is a black screen before you ever press Play.
            const ambient = scene().scene.ambientLight;
            expect(ambient, 'the root needs an ambientLight').toBeTruthy();
            expect(Math.max(...ambient)).toBeGreaterThan(100);
        });

        it('ships no baked light probe', () => {
            // A probe REPLACES the flat scene ambient for every pixel inside its volume, and one with
            // `mode: 'baked'` and no stored maps re-bakes itself on its first frame — at night, off a
            // black sky. Everything it covers is then lit by that black capture, and no amount of
            // `ambientLight` reaches it. Wrong tool for a level whose light sweeps night to day.
            const probes = allNodes(scene().scene).filter(n => n.type === 'lightProbe');
            expect(probes.map(p => p.name)).toEqual([]);
        });

        it('authors a metering band that cannot blow the level out', () => {
            // The editor viewport renders the AUTHORED settings — the director only runs in Play — so a
            // band left at the engine default (`exposureMinEV: 2`, an exposure of 16384) turns the
            // viewport white before you press anything. EV and brightness run in opposite directions, so
            // the MIN EV is the brightness ceiling.
            const r = scene().config.render;
            const exposureAt = (ev: number) => 78643.2 / (1.2 * Math.pow(2, ev));
            expect(r.autoExposureEnabled).toBe(true);
            expect(exposureAt(r.exposureMinEV)).toBeLessThan(r.exposure * 4);
            expect(exposureAt(r.exposureMaxEV)).toBeGreaterThan(r.exposure / 8);
            // Negative: the renderer subtracts it, so a night wants to sit under the metered value.
            expect(r.exposureCompensation).toBeLessThanOrEqual(0);
        });

        it('authors an exposure in a sane range', () => {
            // Guards the two ways this has actually gone wrong: stopped down below 1 for a night scene
            // (too dark), or pushed far above the 3d-example's daylight 2 to compensate for something
            // else being broken (washed out). Exposure trims; it does not light the level.
            const exposure = scene().config.render.exposure;
            expect(exposure).toBeGreaterThan(1);
            expect(exposure).toBeLessThanOrEqual(2);
        });

        it('holds the nodes the scripts look each other up by name', () => {
            // Every one of these is a `findNode` in a script; a rename here is a silent no-op there.
            const names = new Set(allNodes(scene().scene).map(n => n.name));
            for (const required of ['GameManager', 'ZombieSpawner', 'Playable', 'Sun', 'EndScreen', 'HUD'])
                expect(names.has(required), required).toBe(true);
        });

        it('authors the end screen hidden', () => {
            // UI is the only node family that persists `visible`, which is what makes this possible.
            const end = allNodes(scene().scene).find(n => n.name === 'EndScreen');
            expect(end.visible).toBe(false);
        });

        it('gives the HUD every widget its script binds by name', () => {
            const hud = allNodes(scene().scene).find(n => n.name === 'HUD');
            const names = new Set(allNodes(hud).map(n => n.name));
            for (const widget of ['Clock', 'Score', 'Health', 'Speed', 'Invincible', 'Aoe'])
                expect(names.has(widget), widget).toBe(true);
        });

        it('gives the end screen the buttons its script wires', () => {
            const end = allNodes(scene().scene).find(n => n.name === 'EndScreen');
            const names = new Set(allNodes(end).map(n => n.name));
            for (const widget of ['Title', 'Items', 'Score', 'Exit', 'Continue'])
                expect(names.has(widget), widget).toBe(true);
        });
    });

    describe('references', () => {
        it('resolves every attached script to a library asset', () => {
            const known = new Set(library('scripts').map((s: any) => s.id));
            for (const n of allNodes(scene().scene)) {
                const link = n.variables?.__scriptId?.value;
                if (link) expect(known.has(link), `${n.name} -> ${link}`).toBe(true);
            }
        });

        it('carries the source inline beside the link', () => {
            // The editor writes both: the link so the Script panel shows it, the source so the scene is
            // self-contained. One without the other is a node that looks wired and does nothing.
            for (const n of allNodes(scene().scene)) {
                if (!n.variables?.__scriptId) continue;
                expect(typeof n.script, n.name).toBe('string');
                expect(n.script.length, n.name).toBeGreaterThan(0);
            }
        });

        it('matches every script asset to a base type its node accepts', () => {
            const byId = new Map(library('scripts').map((s: any) => [s.id, s]));
            for (const n of allNodes(scene().scene)) {
                const link = n.variables?.__scriptId?.value;
                if (!link) continue;
                const asset: any = byId.get(link);
                // 'node' attaches to anything; otherwise the base type must equal the node's type.
                expect(asset.baseType === 'node' || asset.baseType === n.type,
                    `${n.name}: ${asset.baseType} on a ${n.type}`).toBe(true);
            }
        });

        it('resolves every texture a tileset names', () => {
            const known = new Set(read('textures', 'index.json').map((t: any) => t.id));
            for (const tileset of library('tilesets'))
                expect(known.has(tileset.textureId), tileset.name).toBe(true);
        });

        it('embeds the tileset in every sprite, not just its id', () => {
            // `Sprite.serialize` writes the whole tileset alongside the id, because the published player
            // parses a scene with no library to resolve against. Id-only renders as nothing.
            const byId = new Map(library('tilesets').map((t: any) => [t.id, t]));
            // Scene AND templates: the pickups are templates now, and the zombie's flame always was.
            const sprites = everyNode().filter(n => n.type === 'animatedSprite');
            expect(sprites.length).toBeGreaterThan(0);

            for (const s of sprites) {
                expect(s.sprite.tilesetId, s.name).toBeTruthy();
                expect(s.sprite.tileset, s.name).toBeTruthy();
                expect(s.sprite.tileset.id, s.name).toBe(s.sprite.tilesetId);
                const asset: any = byId.get(s.sprite.tilesetId);
                expect(asset, s.name).toBeTruthy();
                // The embedded copy must agree with the library, or the editor and the player disagree
                // about how the atlas is sliced.
                for (const key of ['textureId', 'imageWidth', 'imageHeight', 'tileWidth', 'tileHeight',
                    'columns', 'rows'])
                    expect(s.sprite.tileset[key], `${s.name}.${key}`).toBe(asset[key]);
            }
        });

        it('cycles frames that exist in the atlas', () => {
            for (const s of everyNode().filter(n => n.type === 'animatedSprite')) {
                const tiles = s.sprite.tileset.columns * s.sprite.tileset.rows;
                for (const frame of s.animation.frames)
                    expect(frame, s.name).toBeLessThan(tiles);
            }
        });
    });

    describe('payload shapes match the engine serializers', () => {
        // The generator writes these by hand, so each is compared against what the class itself would
        // produce. A key the parser has since renamed shows up here rather than as a blank screen.
        const uiKeys = (n: any) => Object.keys(n.ui).sort();
        // `serialize` is async — LandscapeNode's generated terrain makes it so for every node type.
        const serialized = async (n: any) => Object.keys((await n.serialize()).ui).sort();

        const CASES: [string, () => any][] = [
            ['uiRoot', () => new UIRootNode('r')],
            ['uiPanel', () => new UIPanelNode('p')],
            ['uiStack', () => new UIStackNode('s')],
            ['uiText', () => new UITextNode('t')],
            ['uiButton', () => new UIButtonNode('b')],
            ['uiProgressBar', () => new UIProgressBarNode('pb')],
        ];

        for (const [type, make] of CASES) {
            it(`writes exactly the ${type} keys`, async () => {
                const authored = allNodes(scene().scene).filter(n => n.type === type);
                expect(authored.length, `no ${type} in the scene`).toBeGreaterThan(0);
                const expected = await serialized(make());
                for (const n of authored) expect(uiKeys(n), n.name).toEqual(expected);
            });
        }

        it('writes a photometric point light for the zombie flame', async () => {
            const template = library('templates').find((t: any) => t.name === 'Zombie');
            const light = allNodes(template.nodeJson).find((n: any) => n.name === 'Fire Light');
            const reference = await new LightNode('l', new PointLight({})).serialize();
            expect(Object.keys(light.light).sort()).toEqual(Object.keys(reference.light).sort());
            // `unit` is what stops the constructor treating this as a pre-photometric payload and
            // converting it a second time.
            expect(light.light.unit).toBe(reference.light.unit);
        });
    });

    describe('the zombie template', () => {
        const zombie = () => library('templates').find((t: any) => t.name === 'Zombie');
        const playable = () => library('templates').find((t: any) => t.name === 'Playable');

        it('carries its own controller, so a spawned copy drives itself', () => {
            // possessedId is a registered node reference and is remapped per instance. Split the pair
            // across two templates and every zombie drives the template's original body.
            const t = zombie();
            const brain = allNodes(t.nodeJson).find((n: any) => n.type === 'controller');
            const ids = new Set(allNodes(t.nodeJson).map((n: any) => n.id));
            expect(brain).toBeTruthy();
            expect(ids.has(brain.possessedId)).toBe(true);
        });

        it('is not the only template that carries its own driver', () => {
            // The Playable is built the same way, so both actors are one node you can instantiate.
            const playable = library('templates').find((t: any) => t.name === 'Playable');
            const controllers = allNodes(playable.nodeJson).filter((n: any) => n.type === 'controller');
            expect(controllers).toHaveLength(1);
            expect(controllers[0].possessedId).toBe(playable.nodeJson.id);
        });

        it('orders every actor so the camera rig is found before the controller', () => {
            // `ControllerNode._findRig` walks the pawn's children depth-first and takes the first
            // CameraRigNode. With `aimSource: 'possessed'` that walk now includes the controller itself.
            // Keeping the rig ahead of it means the walk returns before ever visiting the controller —
            // and a rig lost here is a character that walks off in one fixed world direction.
            const roots = [
                ...library('templates').map((t: any) => t.nodeJson),
                allNodes(scene().scene).find(n => n.name === 'Playable'),
            ];
            for (const root of roots) {
                const kinds = (root.children ?? []).map((c: any) => c.type);
                const rig = kinds.indexOf('cameraRig');
                const controller = kinds.indexOf('controller');
                if (rig < 0 || controller < 0) continue;
                expect(rig, `${root.name}: the camera rig must come first`).toBeLessThan(controller);
            }
        });

        it('leaves auto-acquire off', () => {
            // On, the engine takes the nearest noticed Character — and a zombie is a Character, so the
            // horde hunts itself. NightShiftZombieBrain replaces it.
            const brain = allNodes(zombie().nodeJson).find((n: any) => n.type === 'controller');
            expect(brain.autoAcquire).toBe(false);
        });

        it('keeps a behaviour machine the parser accepts, whole', () => {
            const brain = allNodes(zombie().nodeJson).find((n: any) => n.type === 'controller');
            const parsed = parseBehaviorMachine(brain.behavior);
            expect(parsed.states.map(s => s.name)).toEqual(brain.behavior.states.map((s: any) => s.name));
            expect(parsed.transitions.length).toBe(brain.behavior.transitions.length);
            expect(parsed.parameters.length).toBe(brain.behavior.parameters.length);
            expect(parsed.states.filter(s => s.isEntry).length).toBe(1);
        });

        it('bands both sides of the attack range', () => {
            // A bare `< 1.8` in and `> 1.8` out flips every frame while the player stands on the
            // boundary, and the zombie lunges and retreats on the spot.
            const brain = allNodes(zombie().nodeJson).find((n: any) => n.type === 'controller');
            const pair = brain.behavior.transitions.filter((t: any) =>
                (t.from === 'Chase' && t.to === 'Attack') || (t.from === 'Attack' && t.to === 'Chase'));
            expect(pair.length).toBe(2);
            for (const t of pair) expect(t.condition.children[0].hysteresis).toBeGreaterThan(0);
        });

        it('keeps every transition condition through a parse', () => {
            const brain = allNodes(zombie().nodeJson).find((n: any) => n.type === 'controller');
            for (const t of brain.behavior.transitions)
                expect(parseConditionNode(t.condition), `${t.from} -> ${t.to}`).toBeTruthy();
        });

        // The enemies used to BE the player's mannequin with its clip list trimmed, which is why they
        // read as grey debug people walking normally. This is that regression.
        it('is its own character, not a copy of the player mannequin', () => {
            const model = allNodes(zombie().nodeJson).find((n: any) => n.type === 'model');
            expect(model.name).toBe('Ch10');

            const player = allNodes(playable().nodeJson).find((n: any) => n.type === 'model');
            expect(player.name).toBe('Ch36');
            // Different geometry, not the same buffer with a different name on it.
            expect(model.model.geometry.positions.length)
                .not.toBe(player.model.geometry.positions.length);
        });

        it('carries exactly the three clips it was authored with', () => {
            const model = allNodes(zombie().nodeJson).find((n: any) => n.type === 'model');
            const names = model.model.animations.map((a: any) => a.name).sort();
            expect(names).toEqual(['Dying', 'Idle', 'Walk']);
        });

        // Root motion on the wrong clip is the loud failure here: Idle and Walk are driven by steering,
        // so a travelling Walk would fight the controller and slide the horde across the map.
        it('travels with the death clip and only the death clip', () => {
            const model = allNodes(zombie().nodeJson).find((n: any) => n.type === 'model');
            const rooted = model.model.animations.filter((a: any) => a.rootMotion).map((a: any) => a.name);
            expect(rooted).toEqual(['Dying']);
        });

        it('paints both material tiles, over index ranges that cover the mesh', () => {
            const model = allNodes(zombie().nodeJson).find((n: any) => n.type === 'model');
            expect(model.model.materials).toHaveLength(2);
            expect(model.model.submeshes).toHaveLength(2);

            // Every submesh range must land inside the index buffer and, together, account for all of
            // it — a short range renders part of the zombie invisible and nothing reports it.
            const total = model.model.indices?.length ?? model.model.geometry.indices.length;
            const covered = model.model.submeshes.reduce((n: number, s: any) => n + s.count, 0);
            expect(covered).toBe(total);
            for (const s of model.model.submeshes) expect(s.start + s.count).toBeLessThanOrEqual(total);

            // Each tile has its own maps; sharing one would mean a UDIM tile went missing on import.
            const maps = model.model.materials.map((m: any) => m.textures.baseColorTexture);
            expect(new Set(maps).size).toBe(2);
            for (const m of model.model.materials) expect(m.textures.normalMap).toBeTruthy();
        });

        it('drives its animation from measured speed, banded', () => {
            const model = allNodes(zombie().nodeJson).find((n: any) => n.type === 'model');
            const sm = model.stateMachine;
            expect(sm.parameters[0].variable.varName).toBe('planarSpeed');
            expect(sm.parameters[0].variable.source).toBe('builtin');

            // Only the speed-driven pair. A trigger has no threshold to band, so requiring hysteresis
            // of every transition would have made the death edge un-authorable.
            const banded = sm.transitions.filter((t: any) => t.condition.children[0].param === 'Speed');
            expect(banded.length).toBe(2);
            for (const t of banded)
                expect(t.condition.children[0].hysteresis, `${t.from} -> ${t.to}`).toBeGreaterThan(0);
        });

        it('can reach Dying from every state it can be alive in, and never leaves it', () => {
            const model = allNodes(zombie().nodeJson).find((n: any) => n.type === 'model');
            const sm = model.stateMachine;
            expect(sm.parameters.some((p: any) => p.name === 'Died' && p.type === 'trigger')).toBe(true);

            const dying = sm.states.find((s: any) => s.name === 'Dying');
            expect(dying.loop).toBe(false); // it holds the last pose until the ragdoll takes over

            const alive = sm.states.filter((s: any) => s.name !== 'Dying').map((s: any) => s.name).sort();
            const into = sm.transitions.filter((t: any) => t.to === 'Dying').map((t: any) => t.from).sort();
            expect(into).toEqual(alive);
            expect(sm.transitions.some((t: any) => t.from === 'Dying')).toBe(false);
        });
    });

    describe('pickups', () => {
        it('never puts a trigger on a node that also has a body', () => {
            // The physics world registers `body || trigger` — one or the other, and the body wins. Both
            // on one node is a pickup that silently never fires.
            for (const n of everyNode())
                expect(!!(n.body && n.trigger), n.name).toBe(false);
        });

        it('keeps no controller at the scene root', () => {
            // The player is a self-contained template, like the zombie. A controller left outside the
            // instance points at the id the character USED to have the moment a template resync rebuilds
            // it — and the player silently stops moving.
            const roots = scene().scene.children.filter((n: any) => n.type === 'controller');
            expect(roots.map((n: any) => n.name)).toEqual([]);
        });

        it('puts the player controller inside the Playable, possessing it', () => {
            const playable = allNodes(scene().scene).find(n => n.name === 'Playable');
            const controllers = playable.children.filter((c: any) => c.type === 'controller');
            expect(controllers).toHaveLength(1);
            expect(controllers[0].possessedId).toBe(playable.id);
            expect(controllers[0].aimSource).toBe('possessed');
            expect(controllers[0].controlSource).toBe('player');
        });

        it('ships one spawner each, with no authored spawn points', () => {
            // Both spawners ask the director for a random spot on walkable terrain, so a hand-placed
            // point is not just redundant — it is a position nobody checked the ground under.
            const names = allNodes(scene().scene).map(n => n.name);
            expect(names.filter(n => n === 'ZombieSpawner')).toHaveLength(1);
            expect(names.filter(n => n === 'PickupSpawner')).toHaveLength(1);
            expect(names.filter(n => n === 'Spawn Point')).toHaveLength(0);
        });

        it('places no pickup in the scene — they are scattered at runtime', () => {
            const sprites = allNodes(scene().scene).filter(n => n.type === 'animatedSprite');
            expect(sprites.map(n => n.name)).toEqual([]);
        });

        it('ships a template for every pickup the spawner names', () => {
            const templates = new Set(library('templates').map((t: any) => t.name));
            for (const required of ['Score Pickup', 'Speed Powerup', 'Invincibility Powerup', 'Fire Powerup'])
                expect(templates.has(required), required).toBe(true);
        });

        it('carries every pickup trigger in the template side map', () => {
            // A template's triggers live beside it keyed by node id, the same way its bodies do. Left in
            // the tree alone, the trigger is stripped on load and the pickup never fires.
            for (const t of library('templates').filter((t: any) => t.name.match(/Pickup|Powerup/))) {
                const trigger = allNodes(t.nodeJson).find((n: any) => n.name === 'Trigger');
                expect(trigger, t.name).toBeTruthy();
                expect(t.triggers[trigger.id], t.name).toBeTruthy();
            }
        });

        it('puts the trigger on a child of the visual', () => {
            const pickups = everyNode().filter(n => n.type === 'animatedSprite' && n.children.length);
            expect(pickups.length).toBeGreaterThan(0);
            for (const p of pickups) {
                const trigger = p.children.find((c: any) => c.trigger);
                expect(trigger, p.name).toBeTruthy();
                expect(trigger.trigger.shapes.length, p.name).toBeGreaterThan(0);
                for (const shape of trigger.trigger.shapes) {
                    // finishParse indexes both unguarded.
                    expect(shape.offset, p.name).toHaveLength(3);
                    expect(shape.rotation, p.name).toHaveLength(3);
                }
            }
        });

        it('scripts both halves, so the visual spins and the trigger collects', () => {
            const pickups = everyNode().filter(n => n.type === 'animatedSprite' && n.children.length);
            for (const p of pickups) {
                expect(p.variables.__scriptId, p.name).toBeTruthy();
                expect(p.children[0].variables.__scriptId, p.name).toBeTruthy();
                expect(p.children[0].variables.__scriptId.value).toBe(p.variables.__scriptId.value);
            }
        });

        it('gives every powerup a kind the script understands', () => {
            const kinds = everyNode()
                .filter(n => n.scriptVars && 'kind' in n.scriptVars)
                .map(n => n.scriptVars.kind);
            expect(kinds.length).toBeGreaterThan(0);
            for (const kind of kinds) expect(['speed', 'invincible', 'aoe']).toContain(kind);
        });
    });
});
