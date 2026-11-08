import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { Node } from '../src/cleo';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { readExample } from '../tools/exampleKit/readExample.mjs';

// The Firing Line example (tools/fps/build.mjs). A node shape the engine does not know fails only when the
// editor opens the scene (a light of a type it does not have, a field under the wrong key), so this parses
// every scene and template the generator wrote with the engine's own parser, and checks the joins between
// the assets that nothing else would notice.

const PROJECT = join(__dirname, '..', 'applications', 'editor', 'public', 'examples', 'firing-line');
const present = existsSync(join(PROJECT, 'manifest.json'));
const project = present ? await readExample(PROJECT) : null;
const read = (...parts: string[]) => project!.read(...parts);

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

    it('has the four scenes', () => {
        expect(scenes().map((s: any) => s.name)).toEqual(['Firing Line - 1v3', 'Firing Line - 2v2', 'Firing Line - FFA', 'Minimal']);
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

    it('gives every scene a manager, a player and the bots its mode names', () => {
        for (const s of scenes()) {
            const nodes = allNodes(s.json.scene);
            const scripts = (kind: string) => nodes.filter(n => n.script && n.script.includes(`class`) && n.variables?.__scriptId && library('scripts').find((a: any) => a.id === n.variables.__scriptId.value)?.name === kind);
            expect(scripts('FpsGameManager').length, s.name).toBe(1);
            expect(scripts('FpsPlayer').length, s.name).toBe(1);
            expect(scripts('FpsBot').length, s.name).toBe(s.name === 'Minimal' ? 2 : 3);
        }
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

    it('gives every viewmodel the clips FpsPlayer plays', () => {
        const need = ['Idle', 'Walk', 'Run', 'Fire', 'Reload', 'Equip'];
        for (const m of library('models').filter((x: any) => /Viewmodel/.test(x.name))) {
            const clips = allNodes(m.nodeJson).find((n: any) => n.model?.animations)?.model.animations.map((a: any) => a.name) ?? [];
            for (const c of need) expect(clips, `${m.name} ${c}`).toContain(c);
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
