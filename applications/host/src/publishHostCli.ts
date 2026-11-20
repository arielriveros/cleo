// npm run publish-host -- (--game <web build folder> | --example <project folder>) --out <folder> [--name <name>]
//
// Writes a game's dedicated-host folder (publishHost.ts): from a web build (Publish ▸ Web's folder: game.bin and
// game.scripts.js) or, for development, an example project published on the fly. Needs `npm run build:host` first.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { publishHostFiles } from './publishHost';
import { buildExampleWeb } from './webBuild';

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = arg('--out');
if (!out || (!arg('--game') && !arg('--example'))) {
    console.error('usage: npm run publish-host -- (--game <web build folder> | --example <project folder>) --out <folder> [--name <name>]');
    process.exit(2);
}
let bin: Uint8Array, scripts: string;
if (arg('--game')) {
    const dir = arg('--game')!;
    bin = new Uint8Array(readFileSync(path.join(dir, 'game.bin')));
    scripts = readFileSync(path.join(dir, 'game.scripts.js'), 'utf8');
} else {
    const web = await buildExampleWeb(arg('--example')!);
    bin = web.bin;
    scripts = web.scripts;
}
const name = arg('--name') ?? path.basename(path.resolve(arg('--game') ?? arg('--example')!));
const files = publishHostFiles({ bin, scripts, name });
for (const [p, bytes] of files) {
    const full = path.join(out, p);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, bytes);
}
console.log(`wrote ${files.size} files to ${path.resolve(out)}`);
