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
import { KIND_EXT } from '../editor/src/utils/vfs';
import { SCENE_REFS_VERSION } from '../editor/src/utils/references';

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

/** Every library the project ships. Named once, because three separate checks iterate all of them. */
const LIBRARIES = ['scripts', 'templates', 'models', 'materials', 'terrainMaterials', 'tilesets',
    'animationFields', 'animations', 'rigs'];

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
                ...LIBRARIES.flatMap(n => library(n).map((a: any) => a.id)),
            ]);
            for (const entry of read('vfs.json').entries)
                expect(ids.has(entry.assetId), entry.path).toBe(true);
        });

        it('gives every vfs entry the virtual extension its kind is classified by', () => {
            // The path is also the SVAR file-manager id, and `kindOfExt` reads the part after the LAST
            // dot to decide what an entry IS. The generator used to interpolate the kind name — writing
            // `.material` and `.animationField`, which classify as nothing — so the asset explorer could
            // not place a single row it wrote. Nothing reported it.
            for (const entry of read('vfs.json').entries) {
                const ext = KIND_EXT[entry.kind as keyof typeof KIND_EXT];
                expect(ext, `no virtual extension for kind ${entry.kind}`).toBeTruthy();
                expect(entry.path.endsWith(ext), entry.path).toBe(true);
            }
        });

        it('records each scene reference list at the version the reader expects', () => {
            // `hasFullRefs` compares this; an older or missing version marks the scene PARTIAL in the
            // reference viewer, which reads as "this scene uses almost nothing" rather than as a stamp
            // the generator forgot.
            for (const meta of manifest().sceneMetas)
                expect(meta.refs.version, meta.name).toBe(SCENE_REFS_VERSION);
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

        it('is a real model asset, not an orphaned subtree', () => {
            // The enemies had no model asset at all: the Ch10 subtree lived only inside this template,
            // with `__modelId: null`. Nothing propagated a mesh or material edit to them, they appeared
            // in no library — and since the RIG is reached through the model, the clip set they play had
            // no owner to come from.
            const model = allNodes(zombie().nodeJson).find((n: any) => n.type === 'model');
            const id = model.variables?.__modelId?.value;
            expect(id, 'the Ch10 node must name a model asset').toBeTruthy();

            const asset = library('models').find((m: any) => m.id === id);
            expect(asset, `no model asset ${id}`).toBeTruthy();
            expect(asset.rigId, 'the model asset must name a rig').toBeTruthy();
        });

        it('carries exactly the five clips it was authored with, on its own rig', () => {
            const asset = library('models').find((m: any) => m.name === 'Zombie');
            const rig = library('rigs').find((r: any) => r.id === asset.rigId);
            const byId = new Map(library('animations').map((a: any) => [a.id, a]));

            // Its OWN clips: the ones authored against this rig. Its `animationIds` list is wider —
            // both rigs own every clip in the project, which is what sharing a rig is for.
            const own = library('animations')
                .filter((a: any) => a.rigId === rig.id).map((a: any) => a.name).sort();
            expect(own).toEqual(
                ['Zombie Attack', 'Zombie Dying', 'Zombie Idle', 'Zombie Running', 'Zombie Walk']);
            for (const id of rig.animationIds) expect(byId.has(id), id).toBe(true);
        });

        // Root motion on the wrong clip is the loud failure here: Idle and Walk are driven by steering,
        // so a travelling Walk would fight the controller and slide the horde across the map.
        it('travels with the death clip and only the death clip', () => {
            const asset = library('models').find((m: any) => m.name === 'Zombie');
            const rooted = library('animations')
                .filter((a: any) => a.rigId === asset.rigId)
                .filter((a: any) => a.clips.some((c: any) => c.rootMotion))
                .map((a: any) => a.name);
            expect(rooted).toEqual(['Zombie Dying']);
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

        it('blends its gait by measured speed rather than switching on a threshold', () => {
            const model = allNodes(zombie().nodeJson).find((n: any) => n.type === 'model');
            const sm = model.stateMachine;
            expect(sm.parameters[0].variable.varName).toBe('planarSpeed');
            expect(sm.parameters[0].variable.source).toBe('builtin');

            const loco = sm.states.find((s: any) => s.isEntry);
            // The state plays a FIELD, and the axis it samples is fed by the speed parameter. Both halves
            // matter: a field with no `fieldInputs` entry samples a constant and the character freezes in
            // one gait, which looks like a broken clip rather than a broken binding.
            expect(loco.fieldId, 'the entry state must play a blend space').toBeTruthy();
            expect(loco.field, 'the field must be EMBEDDED — fieldId cannot be resolved at runtime').toBeTruthy();
            expect(loco.fieldInputs.x).toBe(sm.parameters[0].name);

            // `toRuntimeField` drops yAxis in 1D mode, so a copy carrying one was not written through it.
            expect(loco.field.mode).toBe('1d');
            expect(loco.field.yAxis).toBeUndefined();
        });

        it('places every gait sample at a speed the character can actually reach', () => {
            // The idiom the player's field established: a sample coordinate is the speed at which that
            // clip is the whole answer, so it has to be a speed the character can hit. A run sample above
            // `runSpeed` is a gait that never fully arrives — the blend stays permanently mid-stride.
            const character = allNodes(zombie().nodeJson).find((n: any) => n.type === 'character');
            const model = allNodes(zombie().nodeJson).find((n: any) => n.type === 'model');
            const field = model.stateMachine.states.find((s: any) => s.isEntry).field;

            const top = Math.max(...field.samples.map((s: any) => s.x));
            expect(top).toBe(character.runSpeed);
            expect(field.xAxis.max).toBe(character.runSpeed);
            expect(field.samples.some((s: any) => s.x === character.walkSpeed)).toBe(true);
            // Standing still has to be IN the field, or the lowest gait plays at zero speed and slides.
            expect(field.samples.some((s: any) => s.x === 0)).toBe(true);
        });

        it('wanders fast enough to reach its own walk sample', () => {
            // The bug this pins: wander used to run at `walkSpeed * 0.3` = 0.33 m/s while the Idle->Walk
            // threshold engaged at 0.45 (hysteresis is CENTRED), so a wandering zombie never left the idle
            // clip and slid across the ground. Nothing reported it.
            const character = allNodes(zombie().nodeJson).find((n: any) => n.type === 'character');
            const brain = allNodes(zombie().nodeJson).find((n: any) => n.type === 'controller');
            const wander = brain.behavior.states.find((s: any) => s.goal === 'wander');

            // Sprint is what selects runSpeed, and NightShiftZombie only sets it while hunting.
            const wanderSpeed = character.walkSpeed * (wander.speedScale ?? 1);
            const model = allNodes(zombie().nodeJson).find((n: any) => n.type === 'model');
            const field = model.stateMachine.states.find((s: any) => s.isEntry).field;
            const walkSample = Math.min(...field.samples.filter((s: any) => s.x > 0).map((s: any) => s.x));

            expect(wanderSpeed).toBeGreaterThanOrEqual(walkSample);
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

    // The two characters are different Mixamo exports of different bodies, so they are two rigs — but
    // `normalizeBoneName` strips the `mixamorigN:` namespace, so a curve authored on either matches the
    // other by bone name. That is what lets both rigs own the whole clip set, and it is the thing this
    // example exists to demonstrate. Every check below guards a failure mode that is otherwise silent.
    describe('rigs and shared clips', () => {
        const rigs = () => library('rigs');
        const animations = () => library('animations');

        /** Every skeleton the project ships: each rig's, and the copy every model subtree embeds. */
        const everySkin = (): any[] => {
            const out: any[] = [];
            const walk = (value: any) => {
                if (!value || typeof value !== 'object') return;
                if (Array.isArray(value)) { for (const v of value) walk(v); return; }
                if (value.model?.skin) out.push(value.model.skin);
                for (const v of Object.values(value)) walk(v);
            };
            for (const rig of rigs()) out.push(rig.skin);
            walk(library('models'));
            walk(library('templates'));
            return out;
        };

        it('embeds no clip anywhere — the library is the only copy', () => {
            // THE invariant. `refreshModelClips` re-pushes `nodeJson.animations` and THEN layers the
            // rig's clips on top, so a clip left in both places comes back from `addAnimation`'s de-dupe
            // as `Idle (2)` — a name no state machine and no blend-space sample says. The character
            // stops animating and the only trace is a per-frame "model does not have clip Idle".
            //
            // The mannequin's clips lived in THREE places at once (its model asset, the Playable
            // template, and the placed scene node), so a check that looks at one of them is not enough.
            const leaks: string[] = [];
            const scan = (label: string, value: any) => {
                if (!value || typeof value !== 'object') return;
                if (Array.isArray(value)) { for (const v of value) scan(label, v); return; }
                if (value.model?.skin && value.model.animations?.length)
                    leaks.push(`${label}:${value.name} (${value.model.animations.length})`);
                for (const v of Object.values(value)) scan(label, v);
            };
            for (const meta of manifest().sceneMetas) scan(meta.name, read('scenes', `${meta.id}.json`));
            for (const name of LIBRARIES) scan(name, library(name));
            expect(leaks).toEqual([]);
        });

        it('gives every skinned character a rig that exists', () => {
            const ids = new Set(rigs().map((r: any) => r.id));
            for (const model of library('models')) {
                expect(model.rigId, `${model.name} names no rig`).toBeTruthy();
                expect(ids.has(model.rigId), `${model.name} -> ${model.rigId}`).toBe(true);
            }
            // Two bodies, two rigs. Collapsing them onto one would play every clip at one character's
            // proportions; `skeletonFingerprint` separates them because the bind poses genuinely differ.
            expect(new Set(library('models').map((m: any) => m.rigId)).size).toBe(2);
        });

        it('folds assimp’s pivots out of every skeleton it ships', () => {
            // Assimp wraps each FBX bone in synthetic `$AssimpFbx$` nodes carrying its pre-rotation.
            // `GltfLoader` folds them away for every character the EDITOR imports, because a character
            // and its clips must BOTH be collapsed or their chains disagree — and the offline tool
            // `importZombie.mjs` did not, for a long time.
            //
            // The result was silent and severe: the zombie's whole rest orientation sat in the pivots
            // (`LeftUpLeg` alone is 175.8°), its clips were stored folded, and `_recomputePose`
            // applied the pre-rotation twice. Nothing logged it — and the cross-rig retarget path
            // actively hid it, because its `Bt·Bs⁻¹` correction cancels a pivot present
            // in both terms. The clips looked perfect on every OTHER character.
            for (const skin of everySkin())
                for (const [, name] of skin.nodeNames ?? [])
                    expect(String(name).includes('$AssimpFbx$'), `${skin.name}: ${name}`).toBe(false);
        });

        it('parents every joint onto another joint or the single armature root', () => {
            // The same invariant from the other side, and the one that actually bites: an unfolded
            // skeleton parents most of its bones onto synthetic nodes — 49 of the zombie's 65, where
            // the mannequin has 1.
            for (const skin of everySkin()) {
                const jointNodes = new Set(skin.joints.map((j: any) => j.nodeIndex));
                const orphans = skin.joints
                    .filter((j: any) => j.parentIndex !== undefined && !jointNodes.has(j.parentIndex));
                // Exactly one is right: the root bone hangs off the armature node carrying the
                // centimetre-to-metre scale. More than one means a pivot chain survived.
                expect(orphans.length, `${skin.name}: ${orphans.length} joints parent onto a non-joint`)
                    .toBeLessThanOrEqual(1);
            }
        });

        it('lets only a turn-in-place clip travel', () => {
            // THE invariant behind the sliding player. A Mixamo download carries its real authored travel
            // — a run covers 2.9 m per cycle — and through the ROOT MOTION path that is exactly right:
            // the engine extracts the delta and moves the character with it. But the player's gait plays
            // through a blend FIELD, and a field disarms that path outright ("A field has no single root
            // to extract"), then weight-averages the hips translation into the pose. The mesh rides
            // metres off its own capsule and snaps back at the loop point.
            //
            // So: a clip may DISPLACE its root horizontally only if it is flagged `rootMotion`.
            //
            // Measured as net first-to-last, not as maximum deviation, and that distinction matters: a
            // real walk cycle sways its hips about 6 cm side to side as the weight transfers, and ends
            // where it started. Sway is animation; displacement is travel. The vertical axis is left
            // alone entirely — that is the gait's bob, and flattening it makes every walk a glide.
            const bad: string[] = [];
            for (const rig of rigs()) {
                const names = new Map<number, string>(rig.skin.nodeNames);
                const hips = [...names.entries()].find(([, n]) => n.endsWith(':Hips'))?.[0];
                expect(hips, `${rig.name} has no Hips bone`).toBeDefined();

                const joint = rig.skin.joints.find((j: any) => j.nodeIndex === hips);
                const rest = (rig.skin.nodeTransforms as [number, number[]][])
                    .find(([n]) => n === hips)![1];
                expect(joint, 'Hips must be a joint').toBeTruthy();
                // Derive the vertical the same way the importer does: the root sits about a metre up one
                // axis and near zero on the other two, whether the skeleton was authored Y-up or Z-up.
                const up = [12, 13, 14].reduce((b, i) => (Math.abs(rest[i]) > Math.abs(rest[b]) ? i : b), 12) - 12;

                for (const asset of animations().filter((a: any) => a.rigId === rig.id)) {
                    for (const clip of asset.clips) {
                        const ch = clip.channels.find((c: any) =>
                            c.targetNodeIndex === hips && c.targetPath === 'translation');
                        if (!ch) continue;
                        const out = clip.samplers[ch.samplerIndex].output;
                        const last = out.length - 3;
                        let moved = 0;
                        for (let a = 0; a < 3; a++)
                            if (a !== up) moved = Math.hypot(moved, out[last + a] - out[a]);
                        // Centimetres. A travelling gait covers 160-290 of them; an in-place one ends
                        // within 3 of where it began, so 20 separates the two with room to spare.
                        if (moved > 20 && !clip.rootMotion) bad.push(`${clip.name} (${moved.toFixed(0)})`);
                    }
                }
            }
            expect(bad, 'clips that travel without root motion').toEqual([]);
        });

        it('gives every one-shot state a way back', () => {
            // A non-looping state with no way out is a character frozen mid-action, and nothing else in
            // the machine can rescue it. `Dying` is the ONE state allowed to be a dead end — the ragdoll
            // takes the skeleton over from there.
            //
            // Note this does NOT require an EXIT-TIME edge specifically. A one-shot may legitimately
            // return on a condition instead — an in-air state ending on landing rather than on its clip,
            // say — so what is checked is that something leads out at all.
            for (const node of everyNode()) {
                const sm = (node as any).stateMachine;
                if (!sm) continue;
                for (const state of sm.states) {
                    if (state.loop !== false || state.name === 'Dying') continue;
                    const out = sm.transitions.filter((t: any) =>
                        (t.from === state.name || t.from === '*') && t.to !== state.name);
                    expect(out.length, `${node.name}/${state.name} is a dead end`).toBeGreaterThan(0);
                }
            }
        });

        it('never leaves a state on an unconditional edge that is not gated on the clip', () => {
            // An edge with neither a condition nor `hasExitTime` is vacuously true — `gateMet` on an empty
            // list returns true — so it fires on the state's first frame and the state is skipped
            // entirely. Every unconditional edge here is a "when the clip finishes" return, and must say so.
            for (const node of everyNode()) {
                const sm = (node as any).stateMachine;
                if (!sm) continue;
                for (const t of sm.transitions) {
                    const gated = t.condition?.children?.length || t.conditions?.length;
                    if (gated) continue;
                    expect(t.hasExitTime, `${node.name}: ${t.from} -> ${t.to} fires immediately`).toBe(true);
                }
            }
        });

        it('selects each turn-in-place clip on its own turnRequest code', () => {
            // `turnRequest` is a CLIP SELECTOR, not an angle: +1/+2 right, -1/-2 left, 2 past 135 degrees.
            // The sign is the trap — inverted, the turn clip's root motion drives the body AWAY from the
            // aim, the release angle is never reached and the machine ping-pongs on one side of centre.
            const tpl = library('templates').find((t: any) => t.name === 'Playable');
            const player = allNodes(tpl.nodeJson).find((n: any) => n.name === 'Ch36');
            const sm = player.stateMachine;

            const turnParam = sm.parameters.find((p: any) => p.variable?.varName === 'turnRequest');
            expect(turnParam, 'no parameter bound to turnRequest').toBeTruthy();
            // A native CharacterNode field, so it must NOT claim to be a builtin — that path reads a
            // different table and would silently return the default forever.
            expect(turnParam.variable.source).toBe('variable');

            const codeOf = (state: string) => sm.transitions
                .filter((t: any) => t.to === state)
                .flatMap((t: any) => t.condition?.children ?? [])
                .filter((c: any) => c.param === turnParam.name && c.op === 'eq')
                .map((c: any) => c.value);

            expect(codeOf('Turn90Right')).toEqual([1]);
            expect(codeOf('Turn90Left')).toEqual([-1]);
            expect(codeOf('Turn180Right')).toEqual([2]);
            expect(codeOf('Turn180Left')).toEqual([-2]);
        });

        it('lands the zombie’s hit from a marker inside the swing it plays', () => {
            // The damage is fired by a clip event marker, not a timer, so it moves with the animation.
            // Two numbers on the `Attack` state bound where the marker may sit, and BOTH can silently
            // break it: the state cuts the clip at `exitTime`, so a later marker is never reached, and it
            // plays at `speed`, which only shifts when the hit arrives in wall-clock terms. A marker past
            // the cut is a zombie that swings and never damages anyone.
            const tpl = library('templates').find((t: any) => t.name === 'Zombie');
            const model = allNodes(tpl.nodeJson).find((n: any) => n.type === 'model');
            const sm = model.stateMachine;

            const marker = sm.events.find((e: any) => e.eventName === 'hit');
            expect(marker, 'the attack needs a hit marker').toBeTruthy();

            const state = sm.states.find((s: any) => s.clipName === marker.clipName);
            expect(state, `no state plays ${marker.clipName}`).toBeTruthy();

            const clip = animations()
                .flatMap((a: any) => a.clips)
                .find((c: any) => c.name === marker.clipName);
            expect(clip, `${marker.clipName} is not in the library`).toBeTruthy();
            const duration = Math.max(...clip.samplers.map((x: any) => x.input[x.input.length - 1] ?? 0));

            const cut = sm.transitions
                .filter((t: any) => t.from === state.name && t.hasExitTime)
                .map((t: any) => (t.exitTime ?? 1) * duration);
            expect(cut.length, 'the attack state must return on exit time').toBeGreaterThan(0);
            expect(marker.time, 'the marker is past the point the state cuts away')
                .toBeLessThan(Math.min(...cut));
            expect(marker.time).toBeGreaterThan(0); // t=0 never fires: the window is half-open
        });

        it('drives the player gait from planar speed, not total speed', () => {
            // `currentSpeed` is the full 3D magnitude, so a jump or a fall inflates it and the character
            // reads as sprinting in mid-air — which is exactly what the copied machine did.
            const tpl = library('templates').find((t: any) => t.name === 'Playable');
            const player = allNodes(tpl.nodeJson).find((n: any) => n.name === 'Ch36');
            const speed = player.stateMachine.parameters.find((p: any) => p.name === 'Speed');
            expect(speed.variable.varName).toBe('planarSpeed');
        });

        it('shares one clip set between both rigs, and resolves all of it', () => {
            const ids = new Set(animations().map((a: any) => a.id));
            const lists = rigs().map((r: any) => r.animationIds);
            expect(lists.length).toBe(2);
            expect([...lists[0]].sort()).toEqual([...lists[1]].sort());
            for (const list of lists)
                for (const id of list) expect(ids.has(id), id).toBe(true);
        });

        it('leaves the clip list to the rig, not to the model', () => {
            // `modelAnimationIds` unions both, so a leftover list on the model is not an error — it is a
            // second place the answer lives, which is what `moveClipsToRigs` exists to collapse.
            for (const model of library('models'))
                expect(model.animationIds ?? [], model.name).toEqual([]);
        });

        it('gives every animation a source skeleton to retarget from', () => {
            const ids = new Set(rigs().map((r: any) => r.id));
            for (const a of animations()) {
                expect(ids.has(a.rigId), `${a.name} -> ${a.rigId}`).toBe(true);
                // `player/animations.ts` reads `sourceSkin` DIRECTLY and falls through to playing the
                // clips unretargeted when it is missing — a subtly wrong character, not an absent one.
                expect(a.sourceSkin?.joints?.length, `${a.name} has no source skin`).toBeGreaterThan(0);
            }
        });

        it('resolves every clip name any state machine or blend space asks for', () => {
            // `AnimationState.clipName` and every Animation Field sample name their clip as a STRING,
            // looked up on the live model. Nothing type-checks that, and a miss reports only at play
            // time — which is exactly why the two characters' clips had to stop both being called Idle.
            const known = new Set(animations().flatMap((a: any) => a.clips.map((c: any) => c.name)));
            const wanted = new Map<string, string>();
            const collect = (label: string, value: any) => {
                if (!value || typeof value !== 'object') return;
                if (Array.isArray(value)) { for (const v of value) collect(label, v); return; }
                if (typeof value.clipName === 'string' && value.clipName) wanted.set(value.clipName, label);
                for (const v of Object.values(value)) collect(label, v);
            };
            for (const meta of manifest().sceneMetas) collect(meta.name, read('scenes', `${meta.id}.json`));
            for (const name of ['templates', 'animationFields']) collect(name, library(name));

            expect(wanted.size).toBeGreaterThan(0);
            for (const [clip, where] of wanted) expect(known.has(clip), `${where} wants "${clip}"`).toBe(true);
        });

        it('points the blend space at a rig, and at nothing else', () => {
            for (const field of library('animationFields')) {
                expect(field.rigId, `${field.name}`).toBeTruthy();
                expect(rigs().some((r: any) => r.id === field.rigId), field.name).toBe(true);
                // Both keys would leave two answers to "what does this field blend"; the v4 migration
                // drops `modelId` for the same reason.
                expect(field.modelId, `${field.name} still names a model`).toBeUndefined();
            }
        });

        it('keeps every sample of the blend space in agreement across all three copies', () => {
            // The ten samples exist standalone, inline on the scene's state, and inline on the
            // template's — and a state machine reads the INLINE one. A fix applied to the library alone
            // changes nothing at play time.
            const byId = new Map(library('animationFields').map((f: any) => [f.id, f]));
            const key = (f: any) => f.samples
                .map((s: any) => `${s.clipName}@${s.x},${s.y}`).sort().join('|');

            // Paired by `fieldId`: the project ships more than one blend space now, so an embedded copy
            // has to be checked against the library asset it actually names.
            const inline: { id: string; field: any }[] = [];
            const collect = (value: any) => {
                if (!value || typeof value !== 'object') return;
                if (Array.isArray(value)) { for (const v of value) collect(v); return; }
                if (value.fieldId && value.field?.samples) inline.push({ id: value.fieldId, field: value.field });
                for (const v of Object.values(value)) collect(v);
            };
            for (const meta of manifest().sceneMetas) collect(read('scenes', `${meta.id}.json`));
            collect(library('templates'));

            expect(inline.length).toBeGreaterThan(0);
            for (const { id, field } of inline) {
                const asset = byId.get(id);
                expect(asset, `embedded field names no asset: ${id}`).toBeTruthy();
                expect(key(field), (asset as any).name).toBe(key(asset));
            }
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
