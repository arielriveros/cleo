import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseInputMap } from '../src/input/actionMap';
import { parseBehaviorMachine } from '../src/core/control/behavior';
import { KIND_EXT } from '../editor/src/utils/vfs';
import { hashAsset, assetHashKey } from '../editor/src/utils/assetHash';

// The Hollow Keep example is AUTHORED BY CODE (tools/soulsDemo/build.mjs) and wired together by NAME:
// scripts find nodes with findNode('HUD'), moves name their clips, spawns name their templates, sounds
// are played by node name. Every one of those joins fails silently — a missing clip is a warning and a
// frozen pose, a missing sound is simply quiet. This suite reads the generated folder and checks each
// join, so a rename in the generator or a script breaks a test instead of the demo.
//
// It is also the safety net for the ASSET SWAP the example exists for (SOULS_DEMO.md): after replacing
// a clip, re-running the generator and this suite says whether every reference still resolves.

const PROJECT = join(__dirname, '..', 'editor', 'public', 'examples', 'souls-demo');
const SCRIPTS = join(__dirname, '..', 'examples', 'scripts');
const present = existsSync(join(PROJECT, 'manifest.json'));

// Memoised: templates.json alone is ~23 MB, and re-parsing it per assertion times tests out under a
// full-suite run. Every test treats what it reads as read-only.
const cache = new Map<string, any>();
const read = (...parts: string[]) => {
    const key = parts.join('/');
    if (!cache.has(key)) cache.set(key, JSON.parse(readFileSync(join(PROJECT, ...parts), 'utf8')));
    return cache.get(key);
};
const allNodes = (root: any): any[] => {
    const out: any[] = [];
    const walk = (n: any) => { out.push(n); for (const c of n.children ?? []) walk(c); };
    walk(root);
    return out;
};
const scriptSources = () => readdirSync(SCRIPTS).filter(f => f.startsWith('Souls') && f.endsWith('.ts'))
    .map(f => readFileSync(join(SCRIPTS, f), 'utf8'));

describe.skipIf(!present)('the Hollow Keep example project', () => {
    const manifest = () => read('manifest.json');
    const scene = () => read('scenes', `${manifest().mainSceneId}.json`);
    const library = (name: string) => read('libraries', `${name}.json`);
    const templates = () => library('templates');
    let nodes: any[] | null = null;
    const everyNode = (): any[] => nodes ??= [...allNodes(scene().scene), ...templates().flatMap((t: any) => allNodes(t.nodeJson))];
    const scriptOf = (n: any) => library('scripts').find((s: any) => s.id === n.variables?.__scriptId?.value);
    const withScript = (file: string) => everyNode().filter(n => scriptOf(n)?.source?.includes(`export default class ${file}Node`));

    // ---------------------------------------------------------------------------------------------

    it('names a main scene that exists', () => {
        expect(existsSync(join(PROJECT, 'scenes', `${manifest().mainSceneId}.json`))).toBe(true);
    });

    it('links every scripted node to a script asset that matches the file on disk', () => {
        const scripted = everyNode().filter(n => n.variables?.__scriptId);
        expect(scripted.length).toBeGreaterThan(40);
        for (const n of scripted) {
            const asset = scriptOf(n);
            expect(asset, `${n.name} links a missing script`).toBeDefined();
            expect(n.script).toBe(asset.source);
        }
        const names = readdirSync(SCRIPTS).filter(f => f.startsWith('Souls'));
        for (const asset of library('scripts'))
            expect(names.some(f => readFileSync(join(SCRIPTS, f), 'utf8') === asset.source), `${asset.name} is stale — re-run the generator`).toBe(true);
    });

    it('only sets script fields the script declares', () => {
        for (const n of everyNode().filter(n => n.scriptVars)) {
            const declared = new Set(scriptOf(n).variables.map((v: any) => v.name));
            for (const key of Object.keys(n.scriptVars)) expect(declared.has(key), `${n.name}.${key}`).toBe(true);
        }
    });

    // ----- names the scripts look up ---------------------------------------------------------------

    it('has every node the scripts find by name', () => {
        const names = new Set(allNodes(scene().scene).map(n => n.name));
        for (const name of ['GameManager', 'Player', 'HUD', 'Banner', 'BonfireMenu', 'LockReticle', 'Sounds',
            'Shortcut Gate', 'Fog Gate', 'Boss Reward', 'Epilogue Message', 'Bonfire']) {
            expect(names.has(name), name).toBe(true);
        }
    });

    it('has every HUD, banner and menu widget the UI scripts bind', () => {
        const under = (root: string) => new Set(allNodes(allNodes(scene().scene).find(n => n.name === root)).map(n => n.name));
        const hud = under('HUD');
        for (const w of ['Health', 'HealthLag', 'Stamina', 'Estus', 'Weapon', 'Souls', 'SoulsGain', 'Prompt', 'PromptText',
            'Notice', 'Message', 'MessageTitle', 'MessageBody', 'Boss', 'BossName', 'BossHealth', 'BossLag']) expect(hud.has(w), w).toBe(true);
        expect(under('Banner').has('BannerText')).toBe(true);
        const menu = under('BonfireMenu');
        for (const w of ['Row_Vigor', 'Row_Endurance', 'Row_Strength', 'Row_Dexterity', 'Confirm', 'Leave', 'Derived', 'LevelText', 'SoulsText'])
            expect(menu.has(w), w).toBe(true);
    });

    it('has a SoundNode for every cue a script plays', () => {
        const sounds = new Set(allNodes(scene().scene).find(n => n.name === 'Sounds').children.map((c: any) => c.name));
        const cues = new Set<string>();
        for (const src of scriptSources()) for (const m of src.matchAll(/sfx\?\.\('([^']+)'\)|sfx\('([^']+)'\)|_music\('([^']+)'/g)) cues.add(m[1] ?? m[2] ?? m[3]);
        for (const n of everyNode()) if (n.scriptVars?.sound) cues.add(n.scriptVars.sound);
        expect(cues.size).toBeGreaterThan(15);
        for (const cue of cues) expect(sounds.has(cue), `no SoundNode "${cue}" under Sounds`).toBe(true);
    });

    // ----- templates ---------------------------------------------------------------------------------

    it('resolves every template a spawn, attack or the manager instantiates', () => {
        const names = new Set(templates().map((t: any) => t.name));
        for (const n of withScript('SoulsEnemySpawn')) expect(names.has(n.scriptVars.templateName), n.name).toBe(true);
        for (const n of withScript('SoulsEnemyAttack')) {
            if (n.scriptVars.projectileTemplate) expect(names.has(n.scriptVars.projectileTemplate)).toBe(true);
            if (n.scriptVars.impactTemplate) expect(names.has(n.scriptVars.impactTemplate)).toBe(true);
        }
        for (const name of ['Bloodstain', 'Hit Spark', 'Bolt Impact', 'Magic Bolt', 'Slam Dust',
                            'Blood Spray', 'Blood Splat', 'Blood Drops']) expect(names.has(name), name).toBe(true);
    });

    it('gives every decal a PBR library material whose textures ship with the project', () => {
        const decals = everyNode().filter(n => n.type === 'decal');
        expect(decals.length).toBeGreaterThanOrEqual(3);    // splat, drops, the bloodstain's pool
        const materials = library('materials');
        const shipped = new Set(read('textures', 'index.json').map((t: any) => t.id));
        const refs = new Set(manifest().sceneMetas[0].refs.textureIds);
        for (const d of decals) {
            const asset = materials.find((m: any) => m.id === d.variables.__materialId?.value);
            expect(asset, d.name).toBeDefined();
            expect(asset.material.type).toBe('pbr');
            expect(d.decal.material.type).toBe('pbr');
            const tex = asset.material.textures.baseColorTexture;
            expect(shipped.has(tex), d.name).toBe(true);
            expect(refs.has(tex), d.name).toBe(true);
        }
        // The splat templates carry the script that snaps them to the floor and fades them.
        for (const name of ['Blood Splat', 'Blood Drops']) {
            const t = templates().find((x: any) => x.name === name);
            expect(scriptOf(t.nodeJson)?.source).toContain('class SoulsBloodSplatNode');
            expect(t.nodeJson.children.some((c: any) => c.type === 'decal')).toBe(true);
        }
    });

    it('spawns exactly one boss', () => {
        expect(withScript('SoulsEnemySpawn').filter(n => n.scriptVars.isBossSpawn)).toHaveLength(1);
    });

    it('keeps every controller the LAST child of its character, after the camera rig', () => {
        for (const n of everyNode().filter(n => n.type === 'character')) {
            const kinds = n.children.map((c: any) => c.type);
            expect(kinds[kinds.length - 1], n.name).toBe('controller');
            expect(n.children.at(-1).possessedId).toBe(n.id);
            const rig = kinds.indexOf('cameraRig');
            if (rig >= 0) expect(rig).toBeLessThan(kinds.length - 1);
        }
    });

    it('gives every character a capsule body (inline in the scene, side-mapped in templates)', () => {
        const player = allNodes(scene().scene).find(n => n.name === 'Player');
        expect(player.body.shapes[0].type).toBe('capsule');
        for (const t of templates().filter((t: any) => t.nodeJson.type === 'character'))
            expect(t.bodies[t.nodeJson.id]?.shapes[0].type, t.name).toBe('capsule');
    });

    it('turns auto-acquire off on every enemy brain and runs a machine that parses', () => {
        for (const n of withScript('SoulsEnemyBrain')) {
            expect(n.autoAcquire).toBe(false);
            const machine = parseBehaviorMachine(n.behavior);
            expect(machine.states.map(s => s.name)).toEqual(['Idle', 'Chase', 'Engage', 'Return', 'Dead']);
            expect(machine.states.find(s => s.name === 'Engage')!.goal).toBe('script');
        }
    });

    // ----- animation ---------------------------------------------------------------------------------

    const clips = () => new Map<string, any>(library('animations').map((a: any) => [a.name, a.clips[0]]));
    const duration = (clip: any) => Math.max(...clip.samplers.map((s: any) => s.input[s.input.length - 1]));

    it('has every clip a move, an attack or a script default names', () => {
        const have = clips();
        const wanted = new Set<string>();
        for (const n of [...withScript('SoulsMove'), ...withScript('SoulsEnemyAttack')]) wanted.add(n.scriptVars.clip);
        for (const src of scriptSources()) for (const m of src.matchAll(/Clip: string = '([^']+)'/g)) wanted.add(m[1]);
        for (const src of scriptSources()) for (const m of src.matchAll(/playGesture\?\.\('([^']+)'/g)) wanted.add(m[1]);
        for (const clip of wanted) expect(have.has(clip), `no clip "${clip}"`).toBe(true);
    });

    it('marks every attack clip with a contact event inside the clip', () => {
        const have = clips();
        for (const n of [...withScript('SoulsMove'), ...withScript('SoulsEnemyAttack')]) {
            const clip = have.get(n.scriptVars.clip);
            const contact = (clip.events ?? []).filter((e: any) => e.name === 'hit' || e.name === 'cast');
            expect(contact.length, `${n.scriptVars.clip} has no hit/cast event`).toBeGreaterThan(0);
            for (const e of clip.events) expect(e.time).toBeLessThan(duration(clip));
        }
    });

    it('owns every clip on the rig, and embeds none', () => {
        const rig = library('rigs')[0];
        expect(new Set(rig.animationIds)).toEqual(new Set(library('animations').map((a: any) => a.id)));
        for (const n of everyNode().filter(n => n.model?.skin)) expect(n.model.animations).toBeNull();
    });

    it('carries the hand sockets on every skin that ships', () => {
        const skins = [...everyNode(), ...library('models').flatMap((m: any) => allNodes(m.nodeJson))].filter(n => n.model?.skin);
        expect(skins.length).toBeGreaterThan(4);
        for (const n of skins) expect(n.model.skin.sockets.map((s: any) => s.name)).toEqual(['RightHand', 'LeftHand']);
    });

    it('gives every character the Died and Revive triggers', () => {
        for (const n of everyNode().filter(n => n.model?.skin)) {
            const names = n.stateMachine.parameters.map((p: any) => p.name);
            expect(names).toContain('Died');
            expect(names).toContain('Revive');
        }
    });

    // ----- input --------------------------------------------------------------------------------------

    it('ships an input map with every action the scripts read, bound on both devices', () => {
        const raw = library('inputMap');
        const map = parseInputMap(raw);
        expect(map.maps.map(m => m.name)).toEqual(['Gameplay', 'UI']);
        const actions = new Map(map.maps.flatMap(m => m.actions.map(a => [a.name, a] as const)));
        const used = new Set<string>();
        for (const src of scriptSources()) for (const m of src.matchAll(/Input\.(?:started|pressed|released|heldSeconds|vector|device)\('([^']+)'\)/g)) used.add(m[1]);
        expect(used.size).toBeGreaterThan(8);
        for (const name of used) {
            const action = actions.get(name);
            expect(action, `no action "${name}"`).toBeDefined();
            const devices = new Set(action!.bindings.map(b => b.source.device));
            const keyboardOrMouse = devices.has('key') || devices.has('mouse') || devices.has('pointer');
            const pad = devices.has('gamepad') || devices.has('gamepadAxis');
            expect(keyboardOrMouse, `${name} has no keyboard/mouse binding`).toBe(true);
            expect(pad, `${name} has no gamepad binding`).toBe(true);
        }
    });

    it('turns jump and sprint off on the player controller (Roll owns sprint)', () => {
        const controller = allNodes(scene().scene).find(n => n.name === 'Player Controller');
        expect(controller.jumpAction).toBe('');
        expect(controller.sprintAction).toBe('');
    });

    // ----- the asset explorer ------------------------------------------------------------------------

    it('indexes every asset once, with an extension the explorer can classify', () => {
        const vfs = read('vfs.json');
        const paths = vfs.entries.map((e: any) => e.path);
        expect(new Set(paths).size).toBe(paths.length);
        const ids = new Set<string>([
            manifest().mainSceneId,
            ...['scripts', 'templates', 'models', 'materials', 'animationFields', 'animations', 'rigs', 'particleSystems']
                .flatMap(l => library(l).map((a: any) => a.id)),
        ]);
        for (const e of vfs.entries) {
            expect(ids.has(e.assetId), e.path).toBe(true);
            expect(e.path.endsWith((KIND_EXT as any)[e.kind]), e.path).toBe(true);
        }
    });

    // ----- linked level templates ------------------------------------------------------------------

    const instances = () => allNodes(scene().scene).filter(n => n.variables?.__templateId);
    const templateOf = (n: any) => templates().find((t: any) => t.id === n.variables.__templateId.value);
    // Name paths, as templateOverrides.ts builds them: `Name`, then `Name#k` for a later namesake.
    const byPath = (root: any): Map<string, any> => {
        const out = new Map<string, any>();
        const walk = (n: any, p: string) => {
            out.set(p, n);
            const seen = new Map<string, number>();
            for (const c of n.children ?? []) {
                const k = seen.get(c.name) ?? 0;
                seen.set(c.name, k + 1);
                walk(c, (p ? p + '/' : '') + (k ? `${c.name}#${k}` : c.name));
            }
        };
        walk(root, '');
        return out;
    };

    it('places the player, torches and interactables as linked template copies', () => {
        const count = (name: string) => instances().filter(n => templateOf(n)?.name === name).length;
        expect(count('Player')).toBe(1);
        expect(count('Torch')).toBe(19);
        expect(count('Message')).toBe(7);
        expect(count('Pickup')).toBe(4);
        for (const name of ['Bonfire', 'Lever', 'Gate', 'Fog Gate']) expect(count(name), name).toBe(1);
        for (const n of instances()) expect(templateOf(n), n.name).toBeDefined();
    });

    it('builds every copy from its template: same nodes, and anything else it holds is an override', () => {
        for (const copy of instances()) {
            const tpl = templateOf(copy);
            const mine = byPath(copy), theirs = byPath(tpl.nodeJson);
            expect([...mine.keys()], copy.name).toEqual([...theirs.keys()]);
            const overrides = JSON.parse(copy.variables.__overrides?.value ?? '{}');
            for (const [p, n] of mine) {
                const t = theirs.get(p);
                expect(n.type, `${copy.name}/${p}`).toBe(t.type);
                if (p) expect(n.name).toBe(t.name);
                // What a rebuild from the template produces, overrides replayed, must be what the copy holds.
                const fields = overrides[p]?.fields ?? {};
                expect({ ...(t.scriptVars ?? {}), ...fields }, `${copy.name}/${p}`).toEqual(n.scriptVars ?? {});
            }
            expect(overrides['']?.name ?? tpl.nodeJson.name).toBe(copy.name);
        }
    });

    it('keeps the names scripts look up as name overrides, so a template rebuild cannot lose them', () => {
        const named = (name: string) => instances().find(n => n.name === name);
        for (const name of ['Boss Reward', 'Epilogue Message', 'Shortcut Gate', 'Shortcut Lever']) {
            const n = named(name);
            expect(n, name).toBeDefined();
            expect(JSON.parse(n.variables.__overrides.value)[''].name).toBe(name);
        }
        expect(named('Player')).toBeDefined();
        const lever = named('Shortcut Lever');
        expect(named(lever.scriptVars.doorName)).toBeDefined();
    });

    it('records the asset hashes the editor computes, so opening the scene rebuilds nothing', () => {
        const hashes = scene().assetHashes;
        for (const t of templates()) expect(hashes[assetHashKey('template', t.id)], t.name).toBe(hashAsset(t));
    });
});
