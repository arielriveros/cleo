import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Node } from '../src/cleo';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { readExample } from '../tools/exampleKit/readExample.mjs';

// The Firing Line example (applications/editor/public/examples/firing-line, refreshed by tools/fps/ingest.mjs from
// a project exported out of the editor). A node shape the engine does not know fails only when the editor opens
// the scene (a light of a type it does not have, a field under the wrong key), so this parses the scene and every
// template with the engine's own parser, and checks the joins between the assets that nothing else would notice.

const PROJECT = join(__dirname, '..', 'applications', 'editor', 'public', 'examples', 'firing-line');
const present = existsSync(join(PROJECT, 'manifest.json'));
const project = present ? await readExample(PROJECT) : null;
const read = (...parts: string[]) => project!.read(...parts);
const lf = (text: string) => text.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));

const allNodes = (root: any): any[] => {
    const out: any[] = [];
    const walk = (n: any) => { out.push(n); for (const c of n.children ?? []) walk(c); };
    walk(root);
    return out;
};

/** A copy with every model node a plain node: a model builds GPU buffers, and there is no device here. */
const withoutModels = (n: any): any => ({
    ...n,
    ...(n.type === 'model' ? { type: 'node', model: undefined, stateMachine: undefined, ragdoll: undefined } : {}),
    children: (n.children ?? []).map(withoutModels),
});

describe.skipIf(!present)('the Firing Line example project', { timeout: 120_000 }, () => {
    const manifest = () => read('manifest.json');
    const library = (name: string) => read('libraries', `${name}.json`);
    const scenes = () => manifest().sceneMetas.map((m: any) => ({ id: m.id, name: m.name, json: read('scenes', `${m.id}.json`) }));

    it('has the one scene', () => {
        expect(scenes().map((s: any) => s.name)).toEqual(['Firing Line']);
        expect(manifest().mainSceneId).toBe(scenes()[0].id);
    });

    it('parses every scene with the engine parser', async () => {
        for (const s of scenes()) {
            const root = new Node('root');
            await parseNodeJson(root, withoutModels(s.json.scene));
            expect(root.children.length, s.name).toBeGreaterThan(0);
        }
    });

    it('parses every template with the engine parser', async () => {
        for (const t of library('templates')) {
            const root = new Node('root');
            await parseNodeJson(root, withoutModels(t.nodeJson));
            expect(root.children.length, t.name).toBe(1);
        }
    });

    it('gives the scene a manager, a player and the three bots of one against three', () => {
        for (const s of scenes()) {
            const nodes = allNodes(s.json.scene);
            const scripts = (kind: string) => nodes.filter(n => n.script && n.script.includes(`class`) && n.variables?.__scriptId && library('scripts').find((a: any) => a.id === n.variables.__scriptId.value)?.name === kind);
            expect(scripts('FpsGameManager').length, s.name).toBe(1);
            expect(scripts('FpsPlayer').length, s.name).toBe(1);
            expect(scripts('FpsBot').length, s.name).toBe(3);
        }
    });

    it('has one Game Manager template, whose game type is a dropdown over GAME_TYPES', () => {
        const manager = library('scripts').find((a: any) => a.name === 'FpsGameManager');
        expect(library('templates').filter((t: any) => /Game Manager/.test(t.name)).length).toBe(1);
        const field = manager.variables.find((v: any) => v.name === 'gameType');
        expect(field, 'gameType field').toBeTruthy();
        expect([...field.choices].sort()).toEqual(['ffa', 'oneVsThree', 'team2v2']);
        expect(manager.variables.find((v: any) => v.name === 'mode')).toBeUndefined();
        const shared = library('scripts').find((a: any) => a.name === 'FpsShared').source;
        for (const type of field.choices) expect(shared, type).toMatch(new RegExp(type + ':\\s*\\{ label'));
    });

    it('sets the manager to a valid game type and lists bot templates that exist', () => {
        const managerId = library('scripts').find((a: any) => a.name === 'FpsGameManager').id;
        const node = allNodes(scenes()[0].json.scene).find((n: any) => n.variables?.__scriptId?.value === managerId);
        expect(['ffa', 'oneVsThree', 'team2v2']).toContain(node.scriptVars.gameType);
        expect(node.scriptVars.mode).toBeUndefined();
        const names = new Set(library('templates').map((t: any) => t.name));
        const defaults = library('scripts').find((a: any) => a.name === 'FpsGameManager').variables.find((v: any) => v.name === 'botTemplates');
        for (const t of node.scriptVars.botTemplates ?? defaults.default) expect(names.has(t), t).toBe(true);
    });

    it('fills a scene with too few fighters up to the game type minimum before dealing teams', () => {
        const src = lf(library('scripts').find((a: any) => a.name === 'FpsGameManager').source);
        expect(src).toMatch(/_begin\(\): void \{[\s\S]*?_fillIn\(\)[\s\S]*?_deal\(\)/);
        expect(src).toContain('GAME_TYPES[this.gameType]');
    });

    it('keeps the scripts in the project the same as examples/scripts', () => {
        for (const a of library('scripts')) {
            const file = join(__dirname, '..', 'examples', 'scripts', `${a.name}.ts`);
            if (existsSync(file)) expect(lf(a.source), a.name).toBe(lf(readFileSync(file, 'utf8')));
        }
    });

    it('drives the shot, reload, equip and death effects from clip events and controller Event Actions', () => {
        const controllers = library('animControllers');
        const templates = library('templates');
        const names = new Set(templates.map((t: any) => t.name));
        const clipEventNames = (assetPrefix: RegExp) => new Set(library('animations')
            .filter((a: any) => assetPrefix.test(a.name)).flatMap((a: any) => a.clips.flatMap((c: any) => (c.events ?? []).map((e: any) => e.name))));
        /** A path ('Sounds/Shot') exists in a template tree: its first name anywhere, the rest as direct children. */
        const hasPath = (root: any, path: string) => {
            const [first, ...rest] = path.split('/');
            return allNodes(root).some((n: any) => n.name === first && rest.reduce((at: any, seg) => at?.children?.find((c: any) => c.name === seg) ?? null, n));
        };
        const treeOf = (name: string) => templates.find((t: any) => t.name === name).nodeJson;

        const expected: Record<string, { tree: string; events: string[]; clips: RegExp }> = {
            'AK-47 Viewmodel': { tree: 'FPS Player', events: ['shot', 'reload', 'equip'], clips: /^AK-47 / },
            'Pistol Viewmodel': { tree: 'FPS Player', events: ['shot', 'reload', 'equip'], clips: /^Pistol / },
            'SAPS-12 Viewmodel': { tree: 'FPS Player', events: ['shot', 'reload', 'equip'], clips: /^SAPS-12 / },
            'Fps Bot': { tree: 'FPS Bot', events: ['shot.ak47', 'shot.pistol', 'shot.shotgun', 'death'], clips: /^Fps_Death/ },
        };
        for (const [name, want] of Object.entries(expected)) {
            const controller = controllers.find((c: any) => c.name === name);
            const bindings = controller.machine.eventActions ?? [];
            expect(bindings.map((b: any) => b.event).sort(), name).toEqual([...want.events].sort());
            const root = treeOf(want.tree);
            for (const b of bindings) {
                for (const a of b.actions) {
                    if (a.kind === 'spawn') { expect(names.has(a.template), `${name} ${b.event}: ${a.template}`).toBe(true); if (a.at) expect(hasPath(root, a.at), `${name} ${b.event} at ${a.at}`).toBe(true); }
                    else expect(hasPath(root, a.target), `${name} ${b.event} -> ${a.target}`).toBe(true);
                }
            }
            // The clips carry the markers the script-free bindings wait for (a bot's `shot.*` is fired by name).
            const carried = clipEventNames(want.clips);
            for (const e of want.events.filter(e => !e.startsWith('shot.'))) expect(carried.has(e), `${name}: a clip marker "${e}"`).toBe(true);
        }
        // And every embedded copy of a machine carries them, so a node edited in a scene runs the same.
        for (const t of templates) for (const n of allNodes(t.nodeJson).filter((x: any) => x.stateMachine?.controllerId)) {
            const controller = controllers.find((c: any) => c.id === n.stateMachine.controllerId);
            expect(n.stateMachine.eventActions, `${t.name}/${n.name}`).toEqual(controller.machine.eventActions);
        }
    });

    it('keeps the effect timing out of the scripts', () => {
        const source = (name: string) => lf(library('scripts').find((a: any) => a.name === name).source);
        const player = source('FpsPlayer'), bot = source('FpsBot');
        for (const cue of ['ShotRifle', 'ShotPistol', 'ShotShotgun', "'Equip'", "'Reload'"]) expect(player, cue).not.toMatch(new RegExp('playCue\\([^)]*' + cue));
        expect(player).not.toContain('_flash()');
        expect(bot).toContain('fireEvent');
        expect(bot).not.toMatch(/playCue\(this, '(Shot|Death)'\)/);
        expect(bot).not.toContain("spawnFx('FPS Muzzle Flash'");
    });

    it('keeps a controller as the last child of every character', () => {
        for (const t of library('templates')) {
            for (const n of allNodes(t.nodeJson).filter((x: any) => x.type === 'character')) {
                expect(n.children[n.children.length - 1].type, `${t.name}/${n.name}`).toBe('controller');
            }
        }
    });

    it('marks the player viewmodels and gives their camera a lens', () => {
        const player = library('templates').find((t: any) => t.name === 'FPS Player');
        const nodes = allNodes(player.nodeJson);
        const views = nodes.filter((n: any) => n.variables?.fpsViewmodel);
        expect(views.map((n: any) => n.variables.fpsViewmodel.value).sort()).toEqual(['ak47', 'pistol', 'shotgun']);
        for (const v of views) expect(v.viewmodel, v.name).toBe(true);
        expect(nodes.find((n: any) => n.type === 'camera').camera.viewmodelFov).toBeGreaterThan(0);
    });

    it('links every death trigger to a clip on the clip rig', () => {
        const controller = library('animControllers')[0];
        const names = new Set(library('animations').map((a: any) => a.name));
        const actions = controller.machine.layers.find((l: any) => l.name === 'Actions');
        const deaths = actions.states.filter((s: any) => /^Die\d$/.test(s.name));
        expect(deaths.length).toBe(6);
        for (const d of deaths) expect(names.has(d.clipName), d.clipName).toBe(true);
    });

    it('gives every viewmodel a rig holding the clips FpsPlayer plays, and keeps its flags in the library', () => {
        const need = ['Idle', 'Walk', 'Run', 'Fire', 'Reload', 'Equip'];
        const rigs = library('rigs'), anims = library('animations');
        for (const m of library('models').filter((x: any) => /Viewmodel/.test(x.name))) {
            const rig = rigs.find((r: any) => r.id === m.rigId);
            expect(rig, `${m.name} rig`).toBeTruthy();
            const clips = rig.animationIds.map((id: any) => anims.find((a: any) => a.id === id).clips[0].name);
            for (const c of need) expect(clips, `${m.name} ${c}`).toContain(c);
            // The clips are on the rig, not embedded: a rebuild from the library takes them from there.
            const node = allNodes(m.nodeJson).find((n: any) => n.model?.skin);
            expect(node.model.animations, m.name).toBeNull();
            // And the flags survive a rebuild from the library.
            expect(node.viewmodel, m.name).toBe(true);
            expect(node.motionBlur, m.name).toBe('none');
            // A model with no machine is held in its bind pose every frame: the weapon plays through one.
            expect(node.stateMachine?.layers?.some((l: any) => l.name === 'Actions'), m.name).toBe(true);
        }
    });

    it('spawns on markers the manager finds, in every scene', () => {
        for (const s of scenes()) {
            const markers = allNodes(s.json.scene).filter((n: any) => n.scriptVars && n.scriptVars.kind === 'spawn');
            expect(markers.length, s.name).toBeGreaterThanOrEqual(4);
        }
    });

    it('resolves every script import against the Assets tree', () => {
        // An import path is the explorer path: `@/FPS/Scripts/FpsShared` is the script asset FpsShared in /FPS/Scripts.
        const vfs = read('vfs.json');
        const paths = new Set(vfs.entries.filter((e: any) => e.kind === 'script').map((e: any) => e.path.replace(/\.[^./]+$/, '')));
        for (const script of library('scripts')) {
            for (const m of script.source.matchAll(/from\s+'@(\/[^']+)'/g)) expect(paths.has(m[1]), `${script.name} imports ${m[1]}`).toBe(true);
            expect(script.source, script.name).not.toMatch(/from\s+'\.\.?\//);
        }
    });
});
