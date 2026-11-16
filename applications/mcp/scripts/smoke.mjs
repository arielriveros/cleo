#!/usr/bin/env node
// End-to-end smoke test: starts the MCP server the way Claude Code does (stdio), waits for a Cleo editor to
// connect, then drives the authoring loop through the real tools -- an all-or-nothing edit that fails, a
// build seen from four sides, a stray field refused, a cel material, a script written and patched, a Play
// run driven by WASD and checked by its numbers, a cancelled run, a template made and placed -- undoes it
// all, and saves what it saw.
//
//   1. start an editor:  npm run editor:dev   (open a project you do not mind changing, with the MCP server addon on)
//   2. node applications/mcp/scripts/smoke.mjs [--out <dir>] [--keep] [--workspace]
//
// Everything it adds to the scene and the libraries is undone at the end unless --keep is given.
// --workspace also makes a scene "Smoke Scene", builds in it and goes back (saving the open scene first):
// a new scene is not undoable, so it stays in the project.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const OUT = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : path.resolve('cleo-mcp-smoke');
const KEEP = args.includes('--keep');
const WORKSPACE = args.includes('--workspace');
fs.mkdirSync(OUT, { recursive: true });

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(HERE, '..', 'src', 'index.mjs')],
    env: { ...process.env },
    stderr: 'inherit',
});
const client = new Client({ name: 'cleo-mcp-smoke', version: '0.2.0' });
await client.connect(transport);

let shot = 0;
let failures = 0;
async function call(name, args = {}, { expectError = false, signal } = {}) {
    const t = Date.now();
    let res;
    try { res = await client.callTool({ name, arguments: args }, signal ? { signal } : undefined); } catch (err) {
        if (!expectError) failures++;
        console.log(`\n=== ${name} ${JSON.stringify(args).slice(0, 160)} threw: ${err?.message ?? err}${expectError ? '' : '   <-- UNEXPECTED'}`);
        return { text: String(err?.message ?? err), res: { content: [], isError: true }, threw: true };
    }
    const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    for (const img of res.content.filter(c => c.type === 'image')) {
        const file = path.join(OUT, `${String(++shot).padStart(2, '0')}-${name}.${img.mimeType === 'image/png' ? 'png' : 'jpg'}`);
        fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
        console.log(`   [image saved: ${file}]`);
    }
    const bad = !!res.isError !== expectError;
    if (bad) failures++;
    console.log(`\n=== ${name} ${JSON.stringify(args).slice(0, 160)} (${Date.now() - t} ms)${bad ? '   <-- UNEXPECTED' : ''}\n${text.slice(0, 2500)}`);
    return { text, res };
}
function check(ok, what) {
    if (!ok) failures++;
    console.log(`   [${ok ? 'ok' : 'FAILED'}: ${what}]`);
}
const none = (/** @type {string} */ text) => /^0 matches/m.test(text);

// Wait for an editor (its discovery poll runs every few seconds) that has finished loading its project.
const deadline = Date.now() + 180_000;
for (;;) {
    const res = await client.callTool({ name: 'editor_status', arguments: {} });
    if (!res.isError && /"loading":false/.test(res.content[0]?.text ?? '')) break;
    if (Date.now() > deadline) { console.error('No ready editor within 180 s.'); process.exit(2); }
    await new Promise(r => setTimeout(r, 2000));
}

const status = await call('editor_status');
const openScene = JSON.parse(status.text).scenes.find(s => s.open)?.name;

// Leftovers from an earlier --keep run would make the bare names below ambiguous.
// Only top-level ones: deleting a node takes its children with it, and an op naming a child already gone
// would fail the call (it is all or nothing).
const old = [...(await call('scene_tree', { name: 'Smoke ' })).text.matchAll(/^\/Smoke [^/[]+\[[^\]]+\][^#\n]*#([0-9a-f-]{8,})/gm)].map(m => m[1]);
if (old.length) await call('scene_edit', { label: 'Smoke: clean up', ops: old.map(id => ({ op: 'delete', node: `#${id}` })) });
await call('scene_tree', { depth: 2, with: ['pos'] });
// What the libraries hold before the run: undoing it must leave exactly this.
const assetsBefore = (await call('asset_list', { query: 'Smoke' })).text;

// All or nothing: the second op fails, so the first one is rolled back too.
const atomic = await call('scene_edit', { ops: [{ op: 'create', type: 'cube', name: 'Smoke Atomic' }, { op: 'update', node: 'Nope Not Here', position: [0, 0, 0] }] }, { expectError: true });
check(/Nothing was changed/.test(atomic.text), 'a failed op rolls the whole call back');
check(none((await call('scene_tree', { name: 'Smoke Atomic' })).text), 'nothing of the failed call is left');

// A stray field is refused by name (bodies are Collider nodes now), before anything runs.
const stray = await call('scene_edit', { ops: [{ op: 'create', type: 'cube', name: 'Smoke Stray', body: { mass: 1 } }] }, { expectError: true });
check(/"body" is gone/.test(stray.text), 'a retired field is named, with what replaced it');

// One call builds whole objects (bodies, shapes and material inline) and shows them from four sides.
const build = await call('scene_edit', {
    label: 'Smoke: build',
    ops: [
        { op: 'create', type: 'collider', name: 'Smoke Ground', as: '$g', props: { mass: 0 } },
        { op: 'create', type: 'cube', parent: '$g', name: 'Smoke Ground Mesh', position: [0, -0.25, 0], scale: [12, 0.5, 12] },
        { op: 'update', node: '$g', shapes: 'fit' },
        { op: 'create', type: 'collider', name: 'Smoke Cube', position: [0, 0.75, 0], as: '$cube', props: { mass: 1, angularConstraints: [0, 0, 0] } },
        { op: 'create', type: 'cube', parent: '$cube', name: 'Smoke Cube Mesh', material: { name: 'Smoke Orange', baseColor: [0.9, 0.35, 0.05], roughness: 0.4 } },
        { op: 'update', node: '$cube', shapes: 'fit' },
        { op: 'create', type: 'pointLight', name: 'Smoke Lamp', position: [1.5, 2.5, -1.5], props: { 'light.intensity': 2500 } },
        // The game view needs a camera of its own: behind the cube (-Z), looking along +Z and down a little.
        { op: 'create', type: 'perspectiveCamera', name: 'Smoke Camera', position: [0, 2.2, -4.5], rotation: [18, 0, 0] },
        { op: 'select', node: '$cube' },
    ],
    capture: { focus: '$cube', views: 'quad' },
});
check(build.res.content.some(c => c.type === 'image') && /4 views of/.test(build.text), 'scene_edit captured the cube from four sides in one image');
check(/material=Smoke Orange/.test(build.text), 'the inline material was made and linked');
const many = await call('node_get', { nodes: ['Smoke Cube', 'Smoke Ground', 'Nope'], fields: ['transform', 'bounds', 'material'] });
check(/"error":"No node named \\"Nope\\"/.test(many.text) && /"bounds":\{"center"/.test(many.text), 'node_get reads several nodes, a miss reported in place');

// Another shading model, with a property only it has.
const toon = await call('material_write', { name: 'Smoke Toon', type: 'cel', baseColor: [0.2, 0.6, 1], props: { bands: 4 }, assignTo: ['Smoke Cube Mesh'], capture: true });
check(/\(cel\)/.test(toon.text) && /bands=4/.test(toon.text), 'a cel material with its own property');
await call('material_write', { name: 'Smoke Toon', roughness: 0.5 }, { expectError: true });

// A script that drives the cube from the Move action; first with a type error, then patched.
const mover = "import { ColliderNode, Input } from 'cleo'\nexport default class SmokeMover extends ColliderNode {\n  public speed = 3\n  onUpdate(delta: number) {\n    const [x, y] = Input.vectr('Move')\n    const v = this.velocity\n    this.velocity = [x * this.speed, v[1], y * this.speed]\n  }\n}\n";
const bad = await call('script_write', { name: 'Smoke Mover', source: mover, attach: ['Smoke Cube'] });
check(/TS\d+ error/.test(bad.text), 'the type error is reported');
const fixed = await call('script_write', { name: 'Smoke Mover', edits: [{ old: 'Input.vectr', new: 'Input.vector' }] });
check(/Patched \(1 edit\)/.test(fixed.text) && /Type check: no errors/.test(fixed.text), 'the patch fixed it');

// A test run in one call: hold W, watch the cube, stop.
const run = await call('play_control', { action: 'play', input: [{ at: 0.3, key: 'KeyW', hold: 1.2 }], watch: ['Smoke Cube'], stopAfter: true });
const moved = Number(/Smoke Cube: moved ([\d.]+) m/.exec(run.text)?.[1] ?? 0);
check(moved > 1, `holding W moved the cube (${moved} m)`);
// The numbers say more than a picture: it slid along the fitted floor instead of falling through it.
const endY = Number(/Smoke Cube: moved [\d.]+ m \[[^\]]*\] -> \[[^,]*,([-\d.]+)/.exec(run.text)?.[1] ?? -1);
check(!/airborne throughout/.test(run.text) && endY > 0.4, `the cube stayed on the floor its collider was fitted to (y ${endY})`);
check(/Stopped; back to editing/.test(run.text), 'the run stopped itself');

// A long run cancelled from the client stops the game in the editor.
const ac = new AbortController();
setTimeout(() => ac.abort(), 1500);
await call('play_control', { action: 'simulate', runSeconds: 30 }, { expectError: true, signal: ac.signal });
await new Promise(r => setTimeout(r, 1500));
check(/State: editing/.test((await call('play_control', { action: 'status' })).text), 'a cancelled run stopped the game');

// A built object becomes a template, replaced by a copy of it, and placed again in the same call.
const tpl = await call('scene_edit', {
    label: 'Smoke: template',
    ops: [
        { op: 'makeTemplate', node: 'Smoke Lamp', name: 'Smoke Lamp Prefab' },
        { op: 'create', template: 'Smoke Lamp Prefab', name: 'Smoke Lamp 2', position: [-1.5, 2.5, -1.5] },
    ],
});
check(/placed copy of it/.test(tpl.text) && /template Smoke Lamp Prefab/.test(tpl.text), 'makeTemplate and a placement in one call');
await call('execute_js', { code: 'const cube = find("Smoke Cube"); await track(cube); cube.setPosition([0, 3, 0]); return cube.position' });

if (WORKSPACE) {
    const made = await call('workspace', { action: 'newScene', name: 'Smoke Scene', unsaved: 'save' });
    check(/Created and opened scene "Smoke Scene/.test(made.text), 'a new scene was made and opened');
    await call('scene_edit', { ops: [{ op: 'create', type: 'cube', name: 'Smoke Box' }] });
    const back = await call('workspace', { action: 'openScene', scene: openScene, unsaved: 'discard' });
    check(new RegExp(`Opened scene "${openScene}"`).test(back.text), 'back in the scene it started in');
}

if (!KEEP && !WORKSPACE) {
    // Undo is per call: walk back one step at a time until nothing this run added is left.
    for (let i = 0; i < 16; i++) {
        const tree = (await client.callTool({ name: 'scene_tree', arguments: { name: 'Smoke' } })).content[0].text;
        if (!/Smoke (Ground|Cube|Lamp|Camera)/.test(tree)) break;
        await call('history', { action: 'undo', steps: 1 });
    }
    await call('history', { action: 'status' });
    const left = await call('scene_tree', { name: 'Smoke' });
    check(!/Smoke (Ground|Cube|Lamp|Camera)/.test(left.text), 'undo removed everything the run added');
    const assets = await call('asset_list', { query: 'Smoke' });
    check(assets.text === assetsBefore, 'undo put the libraries back as they were (materials, script, template)');
}

await client.close();
console.log(`\n${failures ? `${failures} unexpected result(s)` : 'All calls behaved as expected.'} Output: ${OUT}`);
process.exit(failures ? 1 : 0);
