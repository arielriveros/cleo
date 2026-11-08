// engine_api: the scripting API indexed from the engine's type declarations, plus the docs by section. A small
// fixture engine pins the behaviour; one test runs against this checkout's real dist when it has been built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineApi, slug, tokens } from '../src/engineApi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_ROOT = path.resolve(HERE, '..', '..', '..');

/** A tiny engine checkout: dist declarations with JSDoc, docs with headings, a source file. */
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-engine-api-'));
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    write('dist/cleo.d.ts', [
        "export { Node } from './node';",
        "export { Animator } from './animator';",
        "export type { ActionOptions } from './animator';",
        "export { lerp } from './math';",
        "export { Tween } from './tween';",
    ].join('\n'));
    write('dist/node.d.ts', [
        '/** The base of everything in a scene. */',
        'export declare class Node {',
        '    /** The name shown in the scene tree. */',
        '    name: string;',
        '    private _secret;',
        '    /** Rotates by `value` DEGREES around local Y (yaw). */',
        '    rotateY(value: number): Node;',
        '    /** Sets local-space position. */',
        '    setPosition(pos: [number, number, number]): Node;',
        '}',
    ].join('\n'));
    write('dist/animator.d.ts', [
        "import { Node } from './node';",
        '/** Options for {@link Animator.playAction}. */',
        'export interface ActionOptions {',
        '    /** Slot to play in. */',
        '    slot?: string;',
        '}',
        '/** Skeletal animation playback for a model. */',
        'export declare class Animator extends Node {',
        '    constructor(model: object);',
        '    /**',
        '     * Play a clip as a one-shot action over whatever the controller is doing.',
        '     * @param clipName The clip to play.',
        '     * @returns A handle that resolves when it ends.',
        '     */',
        '    playAction(clipName: string, options?: ActionOptions): Promise<void>;',
        '    /** Whether an action is playing. */',
        '    get isActionPlaying(): boolean;',
        '    /** Every animator alive. */',
        '    static count: number;',
        '}',
    ].join('\n'));
    write('dist/math.d.ts', '/** Linear interpolation between a and b. */\nexport declare function lerp(a: number, b: number, t: number): number;\n');
    write('dist/tween.d.ts', '/** Small eased animations of numbers. */\nexport declare namespace Tween {\n    /** Ease in and out. */\n    function easeInOut(t: number): number;\n}\n');
    write('docs/scripting/animation.md', [
        '# Animation',
        'How scripts drive animation.',
        '## Actions',
        'One-shots play by action NAME: `animator.playAction("Attack")`.',
        '```ts',
        '# not a heading inside a fence',
        '```',
        '## Blending',
        'Cross-fades between states.',
    ].join('\n'));
    write('src/node.ts', 'export class Node {}\n');
    // The declarations are newer than the source, as after a build.
    const later = new Date(Date.now() + 5000);
    for (const f of ['dist/cleo.d.ts', 'dist/node.d.ts', 'dist/animator.d.ts', 'dist/math.d.ts', 'dist/tween.d.ts']) fs.utimesSync(path.join(root, f), later, later);
    return { root, cacheDir: path.join(root, '.cache') };
}

test('words split the way identifiers and prose are read', () => {
    assert.deepEqual(tokens('playAction rotateY'), ['play', 'action', 'rotate', 'y']);
    assert.deepEqual(tokens('Actions and nodes'), ['action', 'and', 'node']);
    assert.equal(slug('Action slots (playAction)'), 'action-slots-playaction');
});

test('a search finds the member that does it, first, with its doc and the matching docs section', async () => {
    const { root, cacheDir } = fixture();
    const api = new EngineApi({ engineRoot: root, cacheDir });
    const { text } = await api.answer({ query: 'play action' });
    const lines = text.split('\n');
    assert.match(lines[1], /^Animator\.playAction\(clipName: string, options\?: ActionOptions\): Promise<void> — Play a clip as a one-shot action/);
    assert.match(lines[1], /\[src\/|\[dist\/animator\.d\.ts\]/);
    assert.match(text, /scripting\/animation\.md#actions — Animation › Actions/);
    assert.doesNotMatch(text, /_secret/);
});

test('a class lists its members, says what it extends, and a member gives its whole doc', async () => {
    const { root, cacheDir } = fixture();
    const api = new EngineApi({ engineRoot: root, cacheDir });
    const cls = (await api.answer({ symbol: 'Animator' })).text;
    assert.match(cls, /^class Animator extends Node/);
    assert.match(cls, /Skeletal animation playback/);
    assert.match(cls, /Inherits Node's members too: engine_api \{symbol:"Node"\}/);
    assert.match(cls, /Constructor:\n {2}constructor\(model: object\)/);
    assert.match(cls, /Methods:\n {2}playAction\(/);
    assert.match(cls, /get isActionPlaying\(\): boolean — Whether an action is playing\./);
    assert.match(cls, /Static:\n {2}count: number/);

    const member = (await api.answer({ symbol: 'animator.playaction' })).text;
    assert.match(member, /^method of Animator/);
    assert.match(member, /Animator\.playAction\(clipName: string/);
    assert.match(member, /@param clipName The clip to play\./);
    assert.match(member, /@returns A handle that resolves when it ends\./);

    assert.match((await api.answer({ symbol: 'lerp' })).text, /^function lerp\(a: number, b: number, t: number\): number/);
    assert.match((await api.answer({ symbol: 'Tween.easeInOut' })).text, /Ease in and out\./);
    assert.match((await api.answer({ symbol: 'Animater' })).text, /No API symbol "Animater"\. Closest: .*Animator/);
});

test('docs come back one section at a time, or as a list of a file\'s sections', async () => {
    const { root, cacheDir } = fixture();
    const api = new EngineApi({ engineRoot: root, cacheDir });
    const section = (await api.answer({ doc: 'scripting/animation.md#actions' })).text;
    assert.match(section, /^Animation › Actions {2}\[docs\/scripting\/animation\.md\]/);
    assert.match(section, /# not a heading inside a fence/, 'a code fence does not split a section');
    assert.doesNotMatch(section, /Cross-fades/);
    const list = (await api.answer({ doc: 'cleo://docs/scripting/animation.md' })).text;
    assert.match(list, /has 3 sections/);
    assert.match(list, /scripting\/animation\.md#blending — Animation › Blending/);
    await assert.rejects(api.answer({ query: 'x', symbol: 'y' }), /exactly one of/);
});

test('the index is cached, and rebuilt when a declaration changes', async () => {
    const { root, cacheDir } = fixture();
    const first = new EngineApi({ engineRoot: root, cacheDir });
    await first.load();
    assert.equal(first.lastLoad, 'build');
    assert.ok(fs.existsSync(first.cacheFile));

    const second = new EngineApi({ engineRoot: root, cacheDir });
    await second.load();
    assert.equal(second.lastLoad, 'cache');

    const file = path.join(root, 'dist', 'math.d.ts');
    fs.appendFileSync(file, '/** Clamp a value. */\nexport declare function clamp(v: number): number;\n');
    fs.writeFileSync(path.join(root, 'dist', 'cleo.d.ts'), fs.readFileSync(path.join(root, 'dist', 'cleo.d.ts'), 'utf8') + "\nexport { clamp } from './math';\n");
    const later = new Date(Date.now() + 10000);
    fs.utimesSync(file, later, later);
    const third = new EngineApi({ engineRoot: root, cacheDir });
    await third.load();
    assert.equal(third.lastLoad, 'build');
    assert.match((await third.answer({ symbol: 'clamp' })).text, /Clamp a value/);
});

test('answers say when the source is newer than its declarations, and what to do without any', async () => {
    const { root, cacheDir } = fixture();
    const later = new Date(Date.now() + 60000);
    fs.utimesSync(path.join(root, 'src', 'node.ts'), later, later);
    const api = new EngineApi({ engineRoot: root, cacheDir });
    assert.match((await api.answer({ symbol: 'Node' })).text, /run "npm run build"/);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-engine-api-empty-'));
    await assert.rejects(new EngineApi({ engineRoot: empty, cacheDir: path.join(empty, 'c') }).answer({ query: 'node' }), /Run "npm run build"/);
});

test('the real engine API indexes, and finds what a script needs', { skip: !fs.existsSync(path.join(REAL_ROOT, 'dist', 'cleo.d.ts')) && 'dist not built' }, async () => {
    const api = new EngineApi({ engineRoot: REAL_ROOT, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-engine-api-real-')) });
    const t0 = Date.now();
    await api.load();
    assert.ok(Date.now() - t0 < 30000, `built in ${Date.now() - t0} ms`);
    assert.ok(/** @type {any} */ (api.data).entries.length > 1000);
    assert.match((await api.answer({ symbol: 'Node' })).text, /setPosition\(/);
    assert.match((await api.answer({ query: 'rotate node' })).text, /Node\.rotateY\(/);
    const search = (await api.answer({ query: 'play animation action' })).text;
    assert.ok(search.length < 4000, `${search.length} characters`);
});
