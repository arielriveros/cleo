#!/usr/bin/env node
// End-to-end smoke test: starts the MCP server the way Claude Code does (stdio), waits for a Cleo editor to
// connect, then drives one small authoring loop through the real tools -- build a scene, write and attach
// a script, look at it, play it, undo -- and saves what it saw.
//
//   1. start an editor:  npm run editor:dev   (open a project you do not mind changing)
//   2. node applications/mcp/scripts/smoke.mjs [--out <dir>] [--keep]
//
// Everything it adds is undone at the end unless --keep is given.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const OUT = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : path.resolve('cleo-mcp-smoke');
const KEEP = args.includes('--keep');
fs.mkdirSync(OUT, { recursive: true });

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(HERE, '..', 'src', 'index.mjs')],
    env: { ...process.env },
    stderr: 'inherit',
});
const client = new Client({ name: 'cleo-mcp-smoke', version: '0.1.0' });
await client.connect(transport);

let shot = 0;
let failures = 0;
async function call(name, args = {}, { expectError = false } = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    for (const img of res.content.filter(c => c.type === 'image')) {
        const file = path.join(OUT, `${String(++shot).padStart(2, '0')}-${name}.${img.mimeType === 'image/png' ? 'png' : 'jpg'}`);
        fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
        console.log(`   [image saved: ${file}]`);
    }
    const bad = !!res.isError !== expectError;
    if (bad) failures++;
    console.log(`\n=== ${name} ${JSON.stringify(args).slice(0, 160)}${bad ? '   <-- UNEXPECTED' : ''}\n${text.slice(0, 2500)}`);
    return { text, res };
}
function check(ok, what) {
    if (!ok) failures++;
    console.log(`   [${ok ? 'ok' : 'FAILED'}: ${what}]`);
}

// Wait for an editor (its discovery poll runs every few seconds) that has finished loading its project.
const deadline = Date.now() + 180_000;
for (;;) {
    const res = await client.callTool({ name: 'editor_status', arguments: {} });
    if (!res.isError && /"loading":false/.test(res.content[0]?.text ?? '')) break;
    if (Date.now() > deadline) { console.error('No ready editor within 180 s.'); process.exit(2); }
    await new Promise(r => setTimeout(r, 2000));
}

await call('editor_status');

// Leftovers from an earlier --keep run would make the bare names below ambiguous.
const old = (await call('scene_tree', { name: 'Smoke ' })).text.match(/#[0-9a-f-]{8,}/g) ?? [];
if (old.length) await call('scene_edit', { label: 'Smoke: clean up', ops: old.map(id => ({ op: 'delete', node: id })) });
await call('scene_tree', { depth: 2 });

// One call builds whole objects (material and body inline) and shows them.
const build = await call('scene_edit', {
    label: 'Smoke: build',
    ops: [
        { op: 'create', type: 'plane', name: 'Smoke Ground', position: [0, 0, 0], scale: [8, 1, 8], body: { mass: 0 } },
        { op: 'create', type: 'cube', name: 'Smoke Cube', position: [0, 0.75, 0], as: '$cube',
            material: { name: 'Smoke Orange', baseColor: [0.9, 0.35, 0.05], roughness: 0.4 }, body: { mass: 1 } },
        { op: 'create', type: 'pointLight', name: 'Smoke Lamp', position: [1.5, 2.5, -1.5], props: { 'light.intensity': 2500 } },
        // The game view needs a camera of its own: behind the cube (-Z), looking along +Z and down a little.
        { op: 'create', type: 'perspectiveCamera', name: 'Smoke Camera', position: [0, 2.2, -4.5], rotation: [18, 0, 0] },
        { op: 'select', node: '$cube' },
    ],
    capture: { focus: '$cube' },
});
check(build.res.content.some(c => c.type === 'image'), 'scene_edit capture returned an image');
check(/material=Smoke Orange/.test(build.text), 'the inline material was made and linked');
// A field an op does not take is refused with what it does take.
await call('scene_edit', { ops: [{ op: 'move', node: 'Smoke Cube', parent: '/', material: 'Smoke Orange' }] }, { expectError: true });
await call('material_write', { name: 'Smoke Orange', roughness: 0.6, capture: true });

// A script with a type error first: the diagnostics must say so.
await call('script_write', {
    name: 'Smoke Spinner',
    source: "import { Node } from 'cleo'\nexport default class SmokeSpinner extends Node {\n  public speed = 90\n  onUpdate(delta: number) { this.rotateYY(this.speed * delta) }\n}\n",
});
// While a script is written and checked, reads do not wait for it.
const t0 = Date.now();
const done = {};
const timed = (name, p) => p.then(r => { done[name] = Date.now() - t0; return r; });
await Promise.all([
    timed('script_write', call('script_write', {
        name: 'Smoke Spinner',
        source: "import { Node, Logger } from 'cleo'\nexport default class SmokeSpinner extends Node {\n  public speed = 90\n  onStart() { Logger.log(`${this.name} spinning at ${this.speed} deg/s`, 'Script') }\n  onUpdate(delta: number) { this.rotateY(this.speed * delta) }\n}\n",
        attach: ['@selected'],
    })),
    timed('scene_tree', call('scene_tree', { name: 'Smoke' })),
    timed('node_get', call('node_get', { node: '@selected' })),
]);
console.log(`\n   [finish times ms: ${JSON.stringify(done)}]`);
check(done.scene_tree <= done.script_write && done.node_get <= done.script_write, 'reads answered before the script write finished');

await call('scene_edit', { ops: [{ op: 'update', node: '@selected', scriptFields: { speed: 180 } }] });
const cube = await call('node_get', { node: 'Smoke Cube' });
check(/"bounds":\{"center"/.test(cube.text), 'node_get reports world bounds');
await call('scene_edit', { ops: [{ op: 'update', node: 'Nope Not Here', position: [0, 0, 0] }] }, { expectError: true });

const run = await call('play_control', { action: 'simulate', runSeconds: 2, capture: true, stopAfter: true });
check(run.res.content.some(c => c.type === 'image') && /Stopped; back to editing/.test(run.text), 'play_control ran, captured and stopped in one call');
await call('logs_read', { level: 'warn', limit: 20 });
// Play and Stop clear the editor's selection, so "@selected" would rightly fail here.
await call('execute_js', { code: 'const cube = find("Smoke Cube"); log("cube at", cube.position); return { sceneNodes: scene.nodes.size, cubeY: cube.position[1] }' });

if (!KEEP) {
    // Undo is per call: walk back one step at a time until nothing this run added is left.
    for (let i = 0; i < 12; i++) {
        const tree = (await client.callTool({ name: 'scene_tree', arguments: { name: 'Smoke' } })).content[0].text;
        if (!/Smoke (Ground|Cube|Lamp|Camera)/.test(tree)) break;
        await call('history', { action: 'undo', steps: 1 });
    }
    await call('history', { action: 'status' });
    const left = await call('scene_tree', { name: 'Smoke' });
    check(!/Smoke (Ground|Cube|Lamp|Camera)/.test(left.text), 'undo removed everything the run added');
}

await client.close();
console.log(`\n${failures ? `${failures} unexpected result(s)` : 'All calls behaved as expected.'} Output: ${OUT}`);
process.exit(failures ? 1 : 0);
