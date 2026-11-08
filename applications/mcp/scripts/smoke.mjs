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

// Wait for an editor (its discovery poll runs every few seconds).
const deadline = Date.now() + 90_000;
for (;;) {
    const res = await client.callTool({ name: 'editor_status', arguments: {} });
    if (!res.isError) break;
    if (Date.now() > deadline) { console.error('No editor connected within 90 s.'); process.exit(2); }
    await new Promise(r => setTimeout(r, 2000));
}

await call('editor_status');

// Leftovers from an earlier --keep run would make the bare names below ambiguous.
const old = (await call('scene_tree', { name: 'Smoke ' })).text.match(/#[0-9a-f-]{8,}/g) ?? [];
if (old.length) await call('scene_edit', { label: 'Smoke: clean up', ops: old.map(id => ({ op: 'delete', node: id })) });
await call('scene_tree', { depth: 2 });

await call('scene_edit', {
    label: 'Smoke: build',
    ops: [
        { op: 'create', type: 'plane', name: 'Smoke Ground', position: [0, 0, 0], scale: [8, 1, 8], as: '$ground' },
        { op: 'create', type: 'cube', name: 'Smoke Cube', position: [0, 0.75, 0], as: '$cube' },
        { op: 'create', type: 'pointLight', name: 'Smoke Lamp', position: [1.5, 2.5, -1.5], as: '$lamp' },
        // The game view needs a camera of its own: behind the cube (-Z), looking along +Z and down a little.
        { op: 'create', type: 'perspectiveCamera', name: 'Smoke Camera', position: [0, 2.2, -4.5], rotation: [18, 0, 0] },
        { op: 'update', node: '$lamp', props: { 'light.intensity': 2500 } },
        { op: 'update', node: '$cube', body: { mass: 1 } },
        { op: 'update', node: '$ground', body: { mass: 0 } },
    ],
});
await call('material_write', { name: 'Smoke Orange', baseColor: [0.9, 0.35, 0.05], roughness: 0.4, assignTo: ['Smoke Cube'] });

// A script with a type error first: the diagnostics must say so.
await call('script_write', {
    name: 'Smoke Spinner',
    source: "import { Node } from 'cleo'\nexport default class SmokeSpinner extends Node {\n  public speed = 90\n  onUpdate(delta: number) { this.rotateYY(this.speed * delta) }\n}\n",
});
await call('script_write', {
    name: 'Smoke Spinner',
    source: "import { Node, Logger } from 'cleo'\nexport default class SmokeSpinner extends Node {\n  public speed = 90\n  onStart() { Logger.log(`${this.name} spinning at ${this.speed} deg/s`, 'Script') }\n  onUpdate(delta: number) { this.rotateY(this.speed * delta) }\n}\n",
    attach: ['/Smoke Cube'],
});
await call('scene_edit', { ops: [{ op: 'update', node: 'Smoke Cube', scriptFields: { speed: 180 } }] });
await call('node_get', { node: 'Smoke Cube' });
await call('scene_edit', { ops: [{ op: 'update', node: 'Nope Not Here', position: [0, 0, 0] }] }, { expectError: true });

await call('view_capture', { focus: 'Smoke Cube', yaw: 35, pitch: 25 });
await call('play_control', { action: 'play', runSeconds: 2 });
await call('view_capture', {});
await call('play_control', { action: 'stop' });
await call('logs_read', { level: 'warn', limit: 20 });
await call('execute_js', { code: 'const cube = find("Smoke Cube"); log("cube at", cube.position); return { sceneNodes: scene.nodes.size, cubeY: cube.position[1] }' });

if (!KEEP) {
    // Undo is per call; walk back everything this run added (3 scene_edit steps that changed something,
    // the material assign, the attach, the field edit, plus whatever execute recorded).
    await call('history', { action: 'undo', steps: 6 });
    await call('history', { action: 'status' });
    await call('scene_tree', { name: 'Smoke' });
}

await client.close();
console.log(`\n${failures ? `${failures} unexpected result(s)` : 'All calls behaved as expected.'} Output: ${OUT}`);
process.exit(failures ? 1 : 0);
