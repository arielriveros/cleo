import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readExample } from '../tools/exampleKit/readExample.mjs';
import { readExampleFolder, writeExampleFolder, projectFiles, settleScriptCopies } from '../tools/exampleKit/folder.mjs';
import { folderModules } from '../tools/exampleKit/editorModules.mjs';
import { moduleRegistry } from '../tools/exampleKit/tsLoader.mjs';

// The tools that read and write the shipped examples as project folders (tools/exampleKit/folder.mjs), on the
// smallest example, Duskwell: from its folder when the repository has one, else from its gallery bundle.

const ROOT = join(__dirname, '..');
const FOLDER = join(ROOT, 'examples', 'duskwell');
const BUNDLE = join(ROOT, 'applications', 'editor', 'public', 'examples', 'duskwell');
const SOURCE = existsSync(join(FOLDER, 'project.cleo')) ? FOLDER : existsSync(join(BUNDLE, 'manifest.json')) ? BUNDLE : null;

const fresh = async () => structuredClone((await readExample(SOURCE!)).bundle);
const filesOf = (dir: string) => new Map(projectFiles(dir).map(rel => [rel, readFileSync(join(dir, ...rel.split('/')))]));
const scriptCopies = (bundle: any) => {
    let n = 0;
    const walk = (node: any) => { if (typeof node?.script === 'string') n++; (node?.children ?? []).forEach(walk); };
    for (const s of Object.values(bundle.scenes) as any[]) walk(s.scene);
    return n;
};

describe.skipIf(!SOURCE)('example folders', { timeout: 120_000 }, () => {
    let dir = '';
    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'cleo-example-'));
        await writeExampleFolder(dir, await fresh(), { uid: 'u1', name: 'Duskwell' });
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('reads back as the same project', async () => {
        const original = await fresh();
        const { bundle } = await readExampleFolder(dir);
        for (const lib of ['materials', 'scripts', 'templates', 'tilesets', 'aiBrains', 'animations']) {
            const byId = new Map((bundle.libraries as any)[lib].map((r: any) => [r.id, r]));
            for (const r of (original.libraries as any)[lib] ?? []) expect(byId.has(r.id), `${lib} ${r.name}`).toBe(true);
        }
        expect(Object.keys(bundle.scenes)).toEqual(Object.keys(original.scenes));
        expect(bundle.manifest.mainSceneId).toBe(original.manifest.mainSceneId);
    });

    it('keeps no script copies in its scenes, and gives them back to a reader', async () => {
        for (const rel of projectFiles(dir).filter(r => r.endsWith('.scene')))
            expect(readFileSync(join(dir, ...rel.split('/')), 'utf8').includes('"script":'), rel).toBe(false);
        const { bundle } = await readExampleFolder(dir);
        expect(scriptCopies(bundle)).toBe(scriptCopies(await fresh()));
        expect(scriptCopies(bundle)).toBeGreaterThan(0);
    });

    it('writes nothing the second time, and keeps its uid and name', async () => {
        const before = filesOf(dir);
        const stats = await writeExampleFolder(dir, await fresh(), { uid: 'other' });
        expect(stats.written).toEqual([]);
        expect(stats.deleted).toEqual([]);
        expect(filesOf(dir)).toEqual(before);
        const project = JSON.parse(readFileSync(join(dir, 'project.cleo'), 'utf8'));
        expect([project.uid, project.name]).toEqual(['u1', 'Duskwell']);
    });

    it('stores every script LF, whatever the bundle had', async () => {
        const bundle = await fresh();
        for (const s of bundle.libraries.scripts) s.source = s.source.replace(/\n/g, '\r\n');
        await writeExampleFolder(dir, bundle);
        for (const rel of projectFiles(dir).filter(r => r.endsWith('.ts')))
            expect(readFileSync(join(dir, ...rel.split('/')), 'utf8').includes('\r'), rel).toBe(false);
    });

    it('deletes what the project no longer has, and never touches anything outside its own folders', async () => {
        mkdirSync(join(dir, 'tests'), { recursive: true });
        writeFileSync(join(dir, 'tests', 'game.test.ts'), 'test');
        writeFileSync(join(dir, 'README.md'), '# Duskwell');
        writeFileSync(join(dir, 'example.json'), '{}');
        writeFileSync(join(dir, 'Assets', 'Stray.mat'), '{"id":"stray","name":"Stray"}\n');
        writeFileSync(join(dir, 'Assets', 'Stray.mat.meta'), '{"cleo":1,"guid":"stray","kind":"material"}\n');
        const stats = await writeExampleFolder(dir, await fresh());
        expect(stats.deleted.sort()).toEqual(['Assets/Stray.mat', 'Assets/Stray.mat.meta']);
        expect(existsSync(join(dir, 'Assets', 'Stray.mat'))).toBe(false);
        for (const kept of ['tests/game.test.ts', 'README.md', 'example.json']) expect(existsSync(join(dir, kept)), kept).toBe(true);
    });

    it('refuses to read a folder whose data is not all there, and says how to get it', async () => {
        const copy = mkdtempSync(join(tmpdir(), 'cleo-example-'));
        try {
            await writeExampleFolder(copy, await fresh(), { uid: 'u2' });
            const image = projectFiles(copy).find(r => /\.png$/i.test(r))!;
            writeFileSync(join(copy, 'data.lock.json'), JSON.stringify({ cleoData: 1, repo: 'x/y', buckets: 1, packs: [], files: { [image]: ['0'.repeat(64), 1, 0] } }));
            rmSync(join(copy, ...image.split('/')));
            await expect(readExampleFolder(copy)).rejects.toThrow(/examples:fetch/);
        } finally { rmSync(copy, { recursive: true, force: true }); }
    });

    it('refreshes a stale script copy instead of keeping it', async () => {
        const bundle = await fresh();
        const script = bundle.libraries.scripts[0];
        const template = bundle.libraries.templates.find((t: any) => JSON.stringify(t.nodeJson).includes(script.id));
        const walk = (n: any) => { if (n?.variables?.__scriptId?.value === script.id && typeof n.script === 'string') n.script = '// stale'; (n?.children ?? []).forEach(walk); };
        for (const s of Object.values(bundle.scenes) as any[]) walk(s.scene);
        if (template) walk(template.nodeJson);
        expect(settleScriptCopies(bundle, { fill: true })).toBeGreaterThan(0);
        expect(JSON.stringify(bundle).includes('// stale')).toBe(false);
    });
});

describe('the folder codec, run from Node', () => {
    it('reaches no module the tools cannot run (no engine, DOM or editor state)', () => {
        // An empty stub table: anything outside the editor's pure modules throws "reached for an unstubbed module".
        const load = moduleRegistry();
        expect(() => load(join(ROOT, 'applications', 'editor', 'src', 'utils', 'folder', 'projectCodec.ts'))).not.toThrow();
        expect(typeof folderModules().isDataRel).toBe('function');
    });

    it('tells data from text', () => {
        const { isDataRel } = folderModules();
        const cases: [string, boolean][] = [
            ['Blobs/ab/' + 'ab'.repeat(32) + '.bin', true],
            ['Baked/hamlet.bake', true],
            ['Assets/Props/Textures/Source/Rock.png', true],
            ['Assets/Props/Textures/Source/Rock.PNG', true],
            ['Assets/Sfx/Source/hit.ogg', true],
            ['Assets/Props/Textures/Source/Rock.png.meta', false],
            ['Assets/Props/Rock.tex', false],
            ['Assets/Props/Rock.mat', false],
            ['Assets/Scenes/Main.scene', false],
            ['Assets/Player/Hero.ts', false],
            ['Derived/rock.png%40lod1', true],
            ['Derived/rock%40lod1.tex', false],
            ['ProjectSettings/settings.json', false],
            ['project.cleo', false],
            ['tests/hero.test.ts', false],
        ];
        for (const [rel, data] of cases) expect(isDataRel(rel), rel).toBe(data);
    });
});


describe('an example written as the editor saves it once opened (editorNormalize.mjs)', () => {
    const bundle = () => ({
        manifest: {}, scenes: {}, vfs: { entries: [{ path: '/Scripts/Mover.script', kind: 'script', assetId: 's1' }] },
        libraries: {
            projectSettings: { version: 5, collisionLayers: [] },
            materials: [{ id: 'm1', name: 'Grid', material: { type: 'pbr' } }],
            particleSystems: [{ id: 'p1', name: 'Dust', thumbnail: '' }],
            models: [{
                id: 'mo1', name: 'Crate', thumbnail: '', materialIds: [], order: 4,
                nodeJson: { id: 'h', name: 'Crate', type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2], children: [
                    { id: 'c', name: 'crate_mesh', type: 'model', position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], model: {} },
                ] },
            }],
            scripts: [
                { id: 's1', name: 'Mover', baseType: 'node', kind: 'class', variables: [],
                  source: "import { attribute } from 'cleo/decorators'\nexport default class Mover { @attribute speed = 3 }\n" },
                { id: 's2', name: 'Maths', baseType: 'node', kind: 'module', variables: [], source: 'export const two = 2\n' },
            ],
        },
    });

    it('fills the settings, flattens a holder model, keeps a blank thumbnail key and stamps the reflection rules', async () => {
        const { normalizeForEditor } = await import('../tools/exampleKit/editorNormalize.mjs');
        const b: any = bundle();
        expect(normalizeForEditor(b)).toEqual(['settings', '1 model(s) flattened', '1 model order(s) dropped', '1 thumbnail key(s)', '2 script(s) re-reflected']);
        expect(b.libraries.projectSettings.engine.physicsBackend).toBe('jolt');
        expect(b.libraries.projectSettings.publish.width).toBe(1280);
        // The holder collapses into its ModelNode, under the asset's name, its scale folded in.
        expect(b.libraries.models[0].nodeJson).toMatchObject({ id: 'c', name: 'Crate', type: 'model', position: [0, 2, 0], scale: [2, 2, 2] });
        expect('order' in b.libraries.models[0]).toBe(false);
        expect(Object.keys(b.libraries.materials[0]).at(-1)).toBe('thumbnail');
        expect(b.libraries.materials[0].thumbnail).toBe('');
        const [mover, maths] = b.libraries.scripts;
        expect(mover.variables.map((v: any) => v.name)).toEqual(['speed']);
        expect(mover.reflect).toBeGreaterThan(0);
        expect(maths).toMatchObject({ variables: [], reflect: mover.reflect });
        // And it is a fixed point.
        expect(normalizeForEditor(b)).toEqual([]);
    });
});

describe('script copies in a bundle installed into a folder (openFolder.ts installBundleToFolder)', () => {
    it('drops the scene nodes\' copies and leaves the templates\' as the bundle brought them', () => {
        const bundle: any = {
            scenes: { s: { scene: { id: 'root', children: [{ id: 'n', variables: { __scriptId: { value: 'k' } }, script: 'old' }] } } },
            libraries: {
                scripts: [{ id: 'k', source: 'export default class K {}\n' }],
                templates: [{ id: 't', nodeJson: { id: 'tn', variables: { __scriptId: { value: 'k' } }, script: 'export default class K { stale = 1 }\n' } }],
            },
        };
        expect(settleScriptCopies(bundle, { fill: false, templates: false })).toBe(1);
        expect('script' in bundle.scenes.s.scene.children[0]).toBe(false);
        expect(bundle.libraries.templates[0].nodeJson.script).toBe('export default class K { stale = 1 }\n');
    });
});
