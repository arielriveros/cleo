import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseInputMap } from '../src/input/actionMap';
import { buildNavMesh, parseNavMeshData } from '../src/ai/navMesh';
import { parseBehaviorMachine, createBehaviorRuntime, stepBehavior } from '../src/core/control/behavior';
import { KIND_EXT } from '../editor/src/utils/vfs';
import { hashAsset, assetHashKey } from '../editor/src/utils/assetHash';
import { materializeVariant } from '../editor/src/utils/templateVariants';
import { readExample } from '../tools/exampleKit/readExample.mjs';
import { UIRootNode } from '../src/core/scene/nodes/ui/uiRoot';
import { UIPanelNode } from '../src/core/scene/nodes/ui/uiContainers';
import { UITextNode } from '../src/core/scene/nodes/ui/uiContent';
import { UIButtonNode, UIProgressBarNode } from '../src/core/scene/nodes/ui/uiWidgets';

// The Valley example is AUTHORED BY CODE (tools/valley/build.mjs, on the souls content of
// tools/soulsDemo/build.mjs) and wired together by NAME:
// scripts find nodes with findNode('HUD'), moves name their clips, spawns name their templates, sounds
// are played by node name. Every one of those joins fails silently — a missing clip is a warning and a
// frozen pose, a missing sound is simply quiet. This suite reads the generated folder and checks each
// join, so a rename in the generator or a script breaks a test instead of the demo.
//
// It is also the safety net for the ASSET SWAP the example exists for (SOULS_DEMO.md): after replacing
// a clip, re-running the generator and this suite says whether every reference still resolves.

const SCRIPTS = join(__dirname, '..', 'examples', 'scripts');
const allNodes = (root: any): any[] => {
    const out: any[] = [];
    const walk = (n: any) => { out.push(n); for (const c of n.children ?? []) walk(c); };
    walk(root);
    return out;
};
const scriptSources = () => readdirSync(SCRIPTS).filter(f => f.startsWith('Souls') && f.endsWith('.ts'))
    .map(f => readFileSync(join(SCRIPTS, f), 'utf8'));

const PROJECT = join(__dirname, '..', 'editor', 'public', 'examples', 'valley');
const present = existsSync(join(PROJECT, 'manifest.json'));

// Read once, up front, through the editor's own bundle reader: the example is checked in as format 2,
// whose JSON holds markers into assets.bin rather than the payloads these tests look at. Every test
// treats what it reads as read-only.
const valley = present ? await readExample(PROJECT) : null;
const read = (...parts: string[]) => valley!.read(...parts);

describe.skipIf(!present)('the Valley example project', () => {
    const manifest = () => read('manifest.json');
    const scene = () => read('scenes', `${manifest().mainSceneId}.json`);
    const library = (name: string) => read('libraries', `${name}.json`);
    const templates = () => library('templates');
    let nodes: any[] | null = null;
    // The first read parses ~120 MB of JSON. Done once up front, so no single test carries it into a timeout.
    beforeAll(() => { scene(); templates(); library('scripts'); }, 120_000);
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
        const names = readdirSync(SCRIPTS).filter(f => /^(Souls|Valley)/.test(f));
        for (const asset of library('scripts'))
            expect(names.some(f => readFileSync(join(SCRIPTS, f), 'utf8') === asset.source), `${asset.name} is stale — re-run the generator`).toBe(true);
    });

    // A script imports another by its PROJECT PATH (the explorer path without `.script`). A base class or
    // module whose asset is named differently from its file resolves in VS Code and tsc, and then fails at
    // Play with "no such module" — every subclass's node loses its script.
    it('resolves every script import to a script asset at that path', () => {
        const entries = read('vfs.json').entries.filter((e: any) => e.kind === 'script');
        const pathOf = new Map(entries.map((e: any) => [e.assetId, e.path.replace(/\.script$/, '')]));
        const known = new Set(pathOf.values());
        let imports = 0;
        for (const asset of library('scripts')) {
            const from = pathOf.get(asset.id) as string;
            for (const [, spec] of asset.source.matchAll(/from\s+['"](\.{1,2}\/[^'"]+|@\/[^'"]+)['"]/g)) {
                const target = spec.startsWith('@/') ? spec.slice(1) : from.slice(0, from.lastIndexOf('/')) + '/' + spec.replace(/^\.\//, '');
                expect(known.has(target), `${asset.name} imports '${spec}', but no script lives at ${target}.script`).toBe(true);
                imports++;
            }
        }
        expect(imports).toBeGreaterThan(20);
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
        // No boss: the fog wall became the skull cave, which loads the dungeon scene.
        for (const name of ['GameManager', 'Player', 'HUD', 'Banner', 'BonfireMenu', 'ConfirmDialog', 'LockReticle', 'Sounds',
            'Shortcut Gate', 'Bonfire', 'Skull Cave Entrance']) {
            expect(names.has(name), name).toBe(true);
        }
    });

    it('has every HUD, banner and menu widget the UI scripts bind', () => {
        const under = (root: string) => new Set(allNodes(allNodes(scene().scene).find(n => n.name === root)).map(n => n.name));
        const hud = under('HUD');
        for (const w of ['Health', 'HealthLag', 'Stamina', 'Estus', 'Weapon', 'Souls', 'SoulsGain', 'Prompt', 'PromptText',
            'Notice', 'Message', 'MessageTitle', 'MessageBody']) expect(hud.has(w), w).toBe(true);
        expect(under('Banner').has('BannerText')).toBe(true);
        const menu = under('BonfireMenu');
        for (const w of ['Row_Vigor', 'Row_Endurance', 'Row_Strength', 'Row_Dexterity', 'Confirm', 'Leave', 'Derived', 'LevelText', 'SoulsText'])
            expect(menu.has(w), w).toBe(true);
        const warden = templates().find((t: any) => t.name === 'Hollow Warden');
        const bossBar = new Set(allNodes(warden.nodeJson.children.find((c: any) => c.name === 'BossBar')).map((n: any) => n.name));
        for (const w of ['Bar', 'BossName', 'BossHealth', 'BossLag']) expect(bossBar.has(w), w).toBe(true);
    });

    // Every UI belongs to the entity it shows: the player's HUD, menu and reticle are the player's
    // children, each enemy carries its own bar (the boss's on screen), the banners are the game flow's.
    it('keeps every UI under its owner, and none loose at the scene root', () => {
        const root = scene().scene;
        const uiAtRoot = root.children.filter((c: any) => c.type?.startsWith('ui'));
        expect(uiAtRoot.map((c: any) => c.name)).toEqual([]);
        const player = root.children.find((c: any) => c.name === 'Player');
        expect(player.children.map((c: any) => c.name)).toEqual(expect.arrayContaining(['HUD', 'BonfireMenu', 'LockReticle']));
        expect(player.children.at(-1).type).toBe('controller');
        expect(root.children.find((c: any) => c.name === 'GameManager').children.map((c: any) => c.name)).toContain('Banner');
        for (const t of templates().filter((t: any) => t.variant && valueOf(t.nodeJson, 'team') === 'enemy')) {
            const kids = t.nodeJson.children.map((c: any) => c.name);
            const isBoss = valueOf(t.nodeJson, 'isBoss') === true;
            expect(kids, t.name).toContain(isBoss ? 'BossBar' : 'HealthBar');
            expect(kids, t.name).not.toContain(isBoss ? 'HealthBar' : 'BossBar');
        }
    });

    // Every sound is OWNED: SoulsAudio.playSound walks up from the playing node to the nearest `Sounds`
    // group, so each cue a script plays must sit in the Sounds of the template (or scene node) running it.
    it('keeps no Sounds group loose at the scene root', () => {
        expect(scene().scene.children.map((c: any) => c.name)).not.toContain('Sounds');
    });

    it('has a SoundNode in its owner for every cue a script plays', () => {
        // The literal cues each script file plays, and the files a class runs (itself and its bases).
        const cuesOf = new Map<string, string[]>();
        const baseOf = new Map<string, string>();
        for (const f of readdirSync(SCRIPTS).filter(f => f.startsWith('Souls') && f.endsWith('.ts'))) {
            const src = readFileSync(join(SCRIPTS, f), 'utf8');
            const file = f.replace(/\.ts$/, '');
            const cues: string[] = [];
            for (const call of src.matchAll(/(?:playSound|playDetached|stopSound)\(this, ([^)]*)\)|\bsfx\('([^']+)'\)|_music\('([^']+)'/g)) {
                // Every literal argument, except a ternary's condition operand (`kind === 'heavy' ? …`).
                if (call[1]) for (const lit of call[1].matchAll(/'([^']+)'(\s*\?)?/g)) { if (!lit[2]) cues.push(lit[1]); }
                else cues.push(call[2] ?? call[3]);
            }
            cuesOf.set(file, cues);
            const ext = /export\s+default\s+class\s+\w+\s+extends\s+(\w+)/.exec(src);
            const imp = ext && new RegExp(`import\\s+${ext[1]}\\s+from\\s+['"](?:\\./|@/(?:[^'"]*/)?)(\\w+)['"]`).exec(src);
            if (imp) baseOf.set(file, imp[1]);
        }
        const fileOf = (source: string) => /export\s+default\s+class\s+(\w+)Node\b/.exec(source)?.[1];

        // Walk each tree (the scene, every template) with parents, so a node's owner can be found.
        let checked = 0;
        const owners = new Set<string>();
        const check = (root: any) => {
            const walk = (n: any, chain: any[]) => {
                const asset = scriptOf(n);
                if (asset) {
                    const owner = [n, ...chain].find(a => a.children?.some((c: any) => c.name === 'Sounds'));
                    const have = new Set(owner?.children.find((c: any) => c.name === 'Sounds').children
                        .filter((c: any) => c.type === 'sound').map((c: any) => c.name) ?? []);
                    const files: string[] = [];
                    for (let f = fileOf(asset.source); f; f = baseOf.get(f)) files.push(f);
                    const cues = files.flatMap(f => cuesOf.get(f) ?? []);
                    // Data-driven cues: an attack's `sound` (played by its enemy), a weapon's `hitSound`.
                    if (n.scriptVars?.sound) cues.push(n.scriptVars.sound);
                    if (files.includes('SoulsWeapon')) cues.push(n.scriptVars?.hitSound ?? 'Hit');
                    for (const cue of cues) {
                        expect(have.has(cue), `${n.name} plays "${cue}", but ${owner?.name ?? 'nothing above it'} has no such SoundNode in its Sounds`).toBe(true);
                        checked++;
                    }
                    if (cues.length && owner) owners.add(owner.name);
                }
                for (const c of n.children ?? []) walk(c, [n, ...chain]);
            };
            walk(root, []);
        };
        check(scene().scene);
        for (const t of templates()) check(t.nodeJson);
        expect(checked).toBeGreaterThan(30);
        for (const name of ['GameManager', 'Player', 'Hollow', 'Hollow Warden', 'Straight Sword', 'Magic Bolt', 'Lever', 'Gate', 'Fog Gate', 'Pickup'])
            expect(owners.has(name), `${name} owns no sounds`).toBe(true);
        // An enemy attack's own cue (Cast, Boss Leap) is played by its enemy, from the enemy's Sounds.
        const warden = templates().find((t: any) => t.name === 'Hollow Warden').nodeJson;
        const wardenSounds = warden.children.find((c: any) => c.name === 'Sounds').children.map((c: any) => c.name);
        expect(wardenSounds).toEqual(expect.arrayContaining(['Boss Leap', 'Cast', 'Boss Roar']));
    });

    // ----- enemy spawns ------------------------------------------------------------------------------

    it('places every spawn as a copy of the Enemy Spawn template, picking from its spawnables', () => {
        const spawnTemplate = templates().find((t: any) => t.name === 'Enemy Spawn');
        expect(spawnTemplate).toBeDefined();
        const list: string[] = spawnTemplate.nodeJson.scriptVars.spawnables;
        const names = new Set(templates().map((t: any) => t.name));
        expect(list.length).toBeGreaterThanOrEqual(4);
        for (const name of list) expect(names.has(name), name).toBe(true);
        // The script reflects the list as a string list, and templateName as picked from it.
        const asset = scriptOf(spawnTemplate.nodeJson);
        expect(asset.variables.find((v: any) => v.name === 'spawnables')?.type).toBe('stringList');
        expect(asset.variables.find((v: any) => v.name === 'templateName')?.options).toBe('spawnables');
        const placed = allNodes(scene().scene).filter(n => scriptOf(n) === asset);
        // The original seven, the patrolling hollows and the landmarks' guards.
        expect(placed.length).toBeGreaterThanOrEqual(15);
        // Every patrol walks a route the Nav Mesh actually has.
        const nav = allNodes(scene().scene).find(n => n.type === 'navMesh');
        const routes = new Set((nav?.routes ?? []).map((r: any) => r.name));
        const patrols = placed.filter(n => n.scriptVars.patrolRoute);
        expect(patrols.length).toBeGreaterThan(4);
        for (const n of patrols) expect(routes.has(n.scriptVars.patrolRoute), n.name).toBe(true);
        for (const n of placed) {
            expect(n.variables.__templateId?.value, n.name).toBe(spawnTemplate.id);
            expect(list, n.name).toContain(n.scriptVars.templateName);
        }
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

    it('links every enemy brain to its type’s AI graph asset, and runs exactly that graph', () => {
        const brains = new Map<string, any>(library('aiBrains').map((b: any) => [b.id, b]));
        expect(brains.size).toBe(5); // the base Enemy + four types
        for (const n of withScript('SoulsEnemyBrain')) {
            expect(n.autoAcquire).toBe(false);
            const asset = brains.get(n.brainId);
            expect(asset, n.name).toBeTruthy();
            expect(asset.kind).toBe('behavior');
            // The embedded copy is what runs; it must be the asset, or the AI editor shows a different brain.
            expect(n.behavior).toEqual(asset.machine);
            const machine = parseBehaviorMachine(n.behavior);
            expect(machine.states.map(s => s.name)).toEqual(expect.arrayContaining(['Idle', 'Chase', 'Approach', 'Strafe', 'Attack', 'Stagger', 'Return', 'Dead']));
        }
        const named = (name: string) => parseBehaviorMachine([...brains.values()].find(b => b.name === name).machine);
        expect(named('Hollow Sorcerer Brain').states.some(s => s.name === 'Retreat')).toBe(true);
        expect(named('Hollow Brain').states.some(s => s.name === 'Retreat')).toBe(false);
        expect(named('Hollow Warden Brain').states.some(s => s.name === 'Phase Shift')).toBe(true);
    });

    it('decides the whole fight in the graph: chase, close in, strafe, attack, stagger, leash home', () => {
        const brain = library('aiBrains').find((b: any) => b.name === 'Hollow Brain');
        const machine = parseBehaviorMachine(brain.machine);
        let rt = createBehaviorRuntime();
        const v = rt.ctx.values;
        const set = (o: Record<string, number | boolean>) => { for (const [k, x] of Object.entries(o)) v.set(k, x); };
        set({ Dead: false, Awake: true, 'Has Target': false, Distance: 0, Height: 0, 'Target Dead': false, 'From Home': 0,
              'Attack Ready': false, Attacking: false, Reacting: false });
        const step = (dt = 0.5) => { rt = stepBehavior(machine, rt, dt).next; return rt.current; };

        expect(step()).toBe('Idle');
        set({ 'Has Target': true, Distance: 12 });
        expect(step()).toBe('Chase');
        set({ Distance: 3 });                              // inside the Hollow's engage range (4)
        expect(step()).toBe('Approach');
        set({ Distance: 1 });                              // inside its spacing band (1.5)
        expect(step()).toBe('Strafe');
        set({ 'Attack Ready': true, Height: 3 });          // on a ledge overhead: planar reach, but out of it
        expect(step()).toBe('Strafe');
        set({ Height: 0 });
        expect(step()).toBe('Attack');
        set({ 'Attack Ready': false, Attacking: true });
        expect(step()).toBe('Attack');                     // held while the swing plays
        set({ Attacking: false });
        expect(step()).toBe('Strafe');
        set({ Reacting: true });
        expect(step()).toBe('Stagger');
        set({ Reacting: false });
        expect(step()).toBe('Strafe');
        set({ Distance: 4.5 });                            // inside engage + 0.75: still fighting
        expect(step()).not.toBe('Chase');
        set({ 'From Home': 30 });                          // past its leash (18)
        expect(['Return']).toContain(step());
        set({ Distance: 1, 'From Home': 5 });              // the player is right there, but Return latches
        expect(step()).toBe('Return');
        set({ 'From Home': 0.5 });
        expect(step()).toBe('Idle');
        set({ Dead: true });
        expect(step()).toBe('Dead');
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

    it('gives every melee clip an active window: hit, then hitEnd, before recovery', () => {
        const have = clips();
        for (const n of [...withScript('SoulsMove'), ...withScript('SoulsEnemyAttack')]) {
            if (n.scriptVars.projectileTemplate || n.scriptVars.aoeRadius) continue;
            const events = have.get(n.scriptVars.clip).events ?? [];
            const at = (name: string) => events.find((e: any) => e.name === name)?.time;
            expect(at('hitEnd'), `${n.scriptVars.clip} has no hitEnd`).toBeGreaterThan(at('hit'));
            if (at('recover') !== undefined) expect(at('hitEnd')).toBeLessThan(at('recover'));
            // The fallback fields agree with the clip, so a marker-less replacement behaves the same.
            expect(n.scriptVars.hitTime).toBeCloseTo(at('hit'), 3);
            expect(n.scriptVars.hitTime + n.scriptVars.activeSeconds).toBeCloseTo(at('hitEnd'), 3);
        }
    });

    // ----- weapons and fighters own their data ------------------------------------------------------

    /** A script asset's resolved field (inherited ones included), or undefined. */
    const field = (asset: any, name: string) => asset?.variables?.find((v: any) => v.name === name);
    /** A node's value for a script field: its own scriptVars, else the script's (subclass) default. */
    const valueOf = (n: any, name: string) => n.scriptVars?.[name] ?? field(scriptOf(n), name)?.default;
    const weaponTemplateList = () => templates().filter((t: any) => valueOf(t.nodeJson, 'isWeapon') === true);

    it('makes every weapon its own template, each with a blade hitbox from its own script', () => {
        const weapons = weaponTemplateList();
        expect(weapons.map((t: any) => t.name).sort()).toEqual(['Club', 'Greatsword', 'Halberd', 'Sorcerer Staff', 'Straight Sword', 'Weapon']);
        for (const t of weapons) {
            const start = valueOf(t.nodeJson, 'bladeStart'), end = valueOf(t.nodeJson, 'bladeEnd');
            expect(end[1], t.name).toBeGreaterThan(start[1]);
            expect(valueOf(t.nodeJson, 'bladeRadius'), t.name).toBeGreaterThan(0);
            expect(t.nodeJson.socketAttachment, t.name).toEqual({ target: 'parent', socket: 'RightHand' });
            expect(t.nodeJson.children.some((c: any) => c.name === 'Mesh'), `${t.name} has no Mesh`).toBe(true);
        }
        // Each concrete weapon is a variant of the base, on a script EXTENDING the base weapon script.
        for (const t of weapons.filter((w: any) => w.name !== 'Weapon')) {
            expect(templates().find((b: any) => b.id === t.variant?.baseTemplateId)?.name, t.name).toBe('Weapon');
            expect(scriptOf(t.nodeJson).source, t.name).toMatch(/extends SoulsWeaponNode/);
        }
        // The player's weapons carry their movesets; every move names a clip.
        for (const name of ['Straight Sword', 'Greatsword']) {
            const moves = weapons.find((t: any) => t.name === name).nodeJson.children.filter((c: any) => valueOf(c, 'isMove'));
            expect(moves.length, name).toBeGreaterThanOrEqual(3);
            for (const m of moves) expect(valueOf(m, 'clip'), `${name}/${m.name}`).toMatch(/^Souls_/);
        }
    });

    it('lets every fighter name weapon templates that exist, and carries no weapon in its own template', () => {
        const names = new Set(weaponTemplateList().map((t: any) => t.name));
        const fighters = everyNode().filter(n => field(scriptOf(n), 'weaponTemplates'));
        expect(fighters.length).toBeGreaterThanOrEqual(7);   // player (template + copy), the base enemy, 4 types
        for (const f of fighters) {
            const value = valueOf(f, 'weaponTemplates') ?? [];
            expect(Array.isArray(value), `${f.name}.weaponTemplates is a list`).toBe(true);
            const list = value as string[];
            for (const w of list) expect(names.has(w), `${f.name} names a missing weapon "${w}"`).toBe(true);
            const group = f.children.find((c: any) => c.name === 'Weapons');
            expect(group?.children ?? [], `${f.name} still holds weapons inline`).toEqual([]);
        }
        const player = allNodes(scene().scene).find(n => n.name === 'Player');
        expect(valueOf(player, 'weaponTemplates')).toEqual(['Straight Sword', 'Greatsword']);
    });

    it('gives each enemy type its own script extending SoulsEnemy, holding its stats, on its own variant', () => {
        const types = library('scripts').filter((s: any) => /extends SoulsEnemyNode/.test(s.source));
        expect(types.map((s: any) => s.name).sort()).toEqual(['Elite Knight', 'Hollow', 'Hollow Sorcerer', 'Hollow Warden']);
        for (const type of types) {
            const t = templates().find((x: any) => scriptOf(x.nodeJson)?.id === type.id);
            expect(t?.name, type.name).toBe(type.name);
            expect(templates().find((b: any) => b.id === t.variant?.baseTemplateId)?.name).toBe('Enemy');
            expect(field(type, 'maxHp').default, type.name).toBeGreaterThan(100);
            expect(t.nodeJson.scriptVars ?? {}, `${type.name} sets stats on the node instead of its script`).toEqual({});
        }
        const warden = templates().find((t: any) => t.name === 'Hollow Warden');
        const kids = warden.nodeJson.children.map((c: any) => c.name);
        expect(kids).toContain('PhaseAura');
        expect(kids).not.toContain('HealthBar');
    });

    it('stores every variant exactly as its base + diff materializes', () => {
        const variants = templates().filter((t: any) => t.variant);
        expect(variants.length).toBe(9);
        for (const v of variants) {
            const base = templates().find((b: any) => b.id === v.variant.baseTemplateId);
            expect(base, `${v.name}'s base`).toBeDefined();
            expect(templates().indexOf(base), `${v.name} listed before its base`).toBeLessThan(templates().indexOf(v));
            const m = materializeVariant(base, v.id, v.variant.diff);
            expect(JSON.stringify(m.nodeJson) === JSON.stringify(v.nodeJson), `${v.name} nodeJson`).toBe(true);
            expect(m.bodies).toEqual(v.bodies);
            expect(m.triggers).toEqual(v.triggers);
            // Patches to INHERITED nodes stay small: a tint or a scale, never the mannequin's mesh or skin.
            // (Nodes the variant adds — a sword's blade boxes — are its own content and carry their own.)
            expect(JSON.stringify(v.variant.diff.nodes), `${v.name}'s patches copy geometry`).not.toMatch(/"positions"|"skin"/);
        }
    });

    it('never shares a node id between two templates (the published script table is keyed by them)', () => {
        const owner = new Map<string, string>();
        for (const t of templates()) for (const n of allNodes(t.nodeJson)) {
            expect(owner.get(n.id), `${n.name} in ${t.name} reuses an id of ${owner.get(n.id)}`).toBeUndefined();
            owner.set(n.id, t.name);
        }
    });

    it('gives every interactable a trigger zone (inline in the scene, side-mapped in templates)', () => {
        const interactable = /public (interact|canInteract)\(/;
        const files = ['SoulsBonfire', 'SoulsPickup', 'SoulsMessage', 'SoulsLever', 'SoulsDoor', 'SoulsFogGate', 'SoulsBloodstain'];
        for (const f of files) expect(readFileSync(join(SCRIPTS, `${f}.ts`), 'utf8')).toMatch(interactable);
        const inScene = allNodes(scene().scene);
        for (const f of files) {
            for (const n of withScript(f)) {
                const template = templates().find((t: any) => allNodes(t.nodeJson).includes(n));
                const trigger = template ? template.triggers?.[n.id] : n.trigger;
                if (!template && !inScene.includes(n)) continue;
                expect(trigger?.shapes?.length, `${n.name} (${f}) has no trigger zone`).toBeGreaterThan(0);
            }
        }
    });


    it('ships the character controllers, and every character embeds one (so a swapped model can get it back)', () => {
        const controllers = library('animControllers');
        expect(controllers.map((c: any) => c.name)).toEqual(['Souls Character', 'Souls Enemy']);
        for (const c of controllers) expect(c.rigId).toBe(library('rigs')[0].id);
        const machines = everyNode().filter(n => n.stateMachine?.states?.length).map(n => n.stateMachine);
        expect(machines.length).toBeGreaterThan(4);
        const ids = new Set(controllers.map((c: any) => c.id));
        for (const sm of machines) expect(ids.has(sm.controllerId)).toBe(true);
        // The player falls with Dying; enemies with Standing Death Right (then the ragdoll).
        const dead = (c: any) => c.machine.states.find((st: any) => st.name === 'Dead').clipName;
        expect(dead(controllers[0])).toBe('Souls_Dying');
        expect(dead(controllers[1])).toBe('Souls_Death');
    });

    // "Run With Sword" on the sword arm: a masked override layer over the locomotion blend, on while running.
    it('runs with the sword on the weapon arm only', () => {
        const [mask] = library('boneMasks');
        expect(mask.name).toBe('Weapon Arm');
        const bones = Object.keys(mask.weights);
        // The right shoulder down: the torso, the head and the left arm keep the locomotion's swing.
        expect(bones.some(b => /:RightShoulder$/.test(b))).toBe(true);
        expect(bones.some(b => /:RightHand$/.test(b))).toBe(true);
        expect(bones.some(b => /:(Spine\d?|Head|Neck|LeftArm|LeftShoulder)$/.test(b))).toBe(false);
        expect(bones.some(b => /(UpLeg|:Hips)$/.test(b))).toBe(false);
        for (const c of library('animControllers')) {
            const layer = c.machine.layers.find((l: any) => l.name === 'UpperBody');
            expect(layer.maskId).toBe(mask.id);
            expect(layer.mask).toEqual(mask.weights);
            expect(layer.states.map((st: any) => st.clipName)).toEqual(['', 'Souls_RunWithSword']);
        }
        const names = library('animations').map((a: any) => a.name);
        expect(names).toContain('Souls_RunWithSword');
    });

    it('fights with the imported Mixamo clips, each marked where its blade lands', () => {
        const byName = new Map(library('animations').map((a: any) => [a.name, a.clips[0]]));
        for (const name of ['Souls_Sword_L1', 'Souls_Sword_L2', 'Souls_Sword_L3', 'Souls_Sword_Heavy', 'Souls_GS_L1', 'Souls_GS_L2',
            'Souls_GS_Heavy', 'Souls_Enemy_Swing', 'Souls_Enemy_Sweep', 'Souls_Enemy_Overhead', 'Souls_Enemy_Thrust', 'Souls_Leap']) {
            const clip: any = byName.get(name);
            const end = Math.max(...clip.samplers.map((sm: any) => sm.input[sm.input.length - 1]));
            expect(end, name).toBeGreaterThan(1.5);   // a real download, not a 1-second pose stub
            const ev = (e: string) => clip.events.filter((x: any) => x.name === e).map((x: any) => x.time);
            expect(ev('hit').length, name).toBeGreaterThan(0);
            expect(ev('hitEnd')[0], name).toBeGreaterThan(ev('hit')[0]);
            expect(ev('recover')[0], name).toBeGreaterThan(ev('hitEnd')[0]);
        }
        // The combos swing more than once.
        for (const name of ['Souls_Knight_Combo1', 'Souls_Knight_Combo2'])
            expect((byName.get(name) as any).events.filter((e: any) => e.name === 'hit').length, name).toBeGreaterThan(1);
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
            ...manifest().sceneMetas.map((m: any) => m.id),
            ...['scripts', 'templates', 'models', 'materials', 'animationFields', 'animControllers', 'boneMasks', 'animations', 'rigs', 'particleSystems', 'aiBrains', 'terrainMaterials', 'tilesets']
                .flatMap(l => library(l).map((a: any) => a.id)),
        ]);
        // Textures have no library: the editor re-derives a texture record and its source image (same id)
        // from textures/index.json on import, and keeps them at these entries' paths.
        const textureIds = new Set<string>(read('textures/index.json').map((t: any) => t.id));
        for (const e of vfs.entries) {
            if (e.kind === 'image') {
                expect(textureIds.has(e.assetId), e.path).toBe(true);
                expect(/\.(png|jpg)$/.test(e.path), e.path).toBe(true);
                continue;
            }
            expect((e.kind === 'texture' ? textureIds : ids).has(e.assetId), e.path).toBe(true);
            expect(e.path.endsWith((KIND_EXT as any)[e.kind]), e.path).toBe(true);
        }
        for (const id of textureIds) expect(vfs.entries.some((e: any) => e.kind === 'texture' && e.assetId === id), id).toBe(true);
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
        // The cave mouth's pair, and the hamlet's lamps for the night, well apart: down the road and on the walls.
        expect(count('Torch')).toBeGreaterThanOrEqual(4);
        expect(count('Wall Torch')).toBeGreaterThanOrEqual(2);
        expect(count('Message')).toBe(6);
        expect(count('Pickup')).toBe(3);
        for (const name of ['Bonfire', 'Lever', 'Gate']) expect(count(name), name).toBe(1);
        expect(count('Fog Gate')).toBe(0);
        expect(count('Skull Cave Entrance')).toBe(1);
        expect(count('Breakable Barrel')).toBeGreaterThan(8);
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
        for (const name of ['Shortcut Gate', 'Shortcut Lever']) {
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

    // The generator writes UI payloads by hand (tools/exampleKit/bundle.mjs uiNode), so each is compared
    // against what the class itself would produce. A key the parser has since renamed shows up here
    // rather than as a blank screen.
    const UI_CASES: [string, () => any][] = [
        ['uiRoot', () => new UIRootNode('r')],
        ['uiPanel', () => new UIPanelNode('p')],
        ['uiText', () => new UITextNode('t')],
        ['uiButton', () => new UIButtonNode('b')],
        ['uiProgressBar', () => new UIProgressBarNode('pb')],
    ];
    for (const [type, make] of UI_CASES) {
        it(`writes exactly the ${type} keys`, async () => {
            const authored = everyNode().filter(n => n.type === type);
            expect(authored.length, `no ${type} anywhere`).toBeGreaterThan(0);
            // `serialize` is async: LandscapeNode's generated terrain makes it so for every node type.
            const expected = Object.keys((await make().serialize()).ui).sort();
            for (const n of authored) expect(Object.keys(n.ui).sort(), n.name).toEqual(expected);
        });
    }

    // Baked by the generator (tools/navBakeHeadless.mjs), obstacles carved. Without a bake every
    // `path` goal falls back to a straight line and enemies walk into walls and trees.
    it('ships a baked navmesh every enemy spawn can be reached on from the player', () => {
        const nav = allNodes(scene().scene).find((n: any) => n.type === 'navMesh');
        expect(nav?.navMesh, 'baked navmesh').toBeTruthy();
        expect(nav.bake.carve).toBe(true);
        const mesh = buildNavMesh(parseNavMeshData(nav.navMesh), { merge: false })!;
        const player = allNodes(scene().scene).find((n: any) => n.type === 'character');
        const spawns = allNodes(scene().scene).filter((n: any) => n.name?.startsWith('Spawn '));
        expect(spawns.length).toBeGreaterThan(4);
        for (const spawn of spawns) expect(mesh.findPath(player.position, spawn.position).length, spawn.name).toBeGreaterThan(1);
    });
});
