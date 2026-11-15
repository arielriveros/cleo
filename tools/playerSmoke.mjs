#!/usr/bin/env node
// Smoke test for the PUBLISHED player: builds a tiny game per case (physics backend x physics thread) the way
// Publish does, from the player in applications/editor/public/player (run `npm run build:player` first), runs
// each as a desktop game in Electron -- served over game:// by the real GAME_MAIN_JS, so the module entry,
// its chunks and the module worker load exactly as they do for a player of a published game -- and checks
// that it reached a frame, ran on the backend and thread it asked for, and that its crate fell onto the floor.
//
//   node tools/playerSmoke.mjs [outDir]
//
// Prints what each game ships (files, bytes) beside the result; exits 1 if any case failed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(tmpdir(), 'cleo-player-smoke', 'games'));
const electron = path.join(root, 'applications/app-kit/desktop/node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!existsSync(electron)) { console.error(`No Electron at ${electron}: run npm install in applications/app-kit/desktop.`); process.exit(1); }

// 1. Write the games (TypeScript, through vite-node with the editor's aliases).
const viteNode = path.join(root, 'node_modules/.bin', process.platform === 'win32' ? 'vite-node.cmd' : 'vite-node');
const packed = spawnSync(viteNode, ['--config', 'applications/editor/vitest.config.ts', 'tools/playerSmoke/pack.ts', out],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (packed.status !== 0) process.exit(packed.status ?? 1);
const cases = JSON.parse(readFileSync(path.join(out, '..', 'smoke-cases.json'), 'utf8'));

// 2. Run each one and read its result over the DevTools protocol.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set by VS Code-hosted shells: Electron would start as plain Node
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** End a game and every process it started: killing Electron's main process alone leaves its renderers running. */
function stop(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

async function evaluate(port, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('game://'));
  if (!page) return undefined;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const reply = new Promise(res => { ws.onmessage = e => res(JSON.parse(String(e.data))); });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  const msg = await reply;
  ws.close();
  return msg?.result?.result?.value;
}

async function run(c, port) {
  // One profile for every case: the first compiles the shaders (tens of seconds with an empty GPU cache), the
  // rest reuse them.
  const profile = path.join(out, '..', 'electron-profile');
  const child = spawn(electron, [c.dir, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { env, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(500);
      let state;
      try {
        state = await evaluate(port, `JSON.stringify({ smoke: window.CLEO_SMOKE ?? null, firstFrame: window.CLEO_FIRST_FRAME_MS ?? null, error: document.getElementById('cleo-error')?.textContent ?? null })`);
      } catch { continue; } // DevTools not up yet
      if (!state) continue;
      const s = JSON.parse(state);
      if (s.error) return { ok: false, why: s.error.split('\n').slice(0, 4).join(' | ') };
      if (s.smoke) {
        const why = [];
        if (s.smoke.backend !== c.backend) why.push(`ran on ${s.smoke.backend} (${s.smoke.fallback ?? 'no reason'})`);
        if (s.smoke.executor !== (c.worker === 'on' ? 'worker' : 'inline')) why.push(`stepped ${s.smoke.executor}`);
        if (!(Math.abs(s.smoke.crateY - 0.5) < 0.1)) why.push(`crate at y=${s.smoke.crateY}`);
        return { ok: why.length === 0, why: why.join('; '), ...s.smoke, firstFrame: s.firstFrame };
      }
    }
    return { ok: false, why: 'timed out' };
  } finally {
    stop(child);
  }
}

let failed = 0;
let port = 9420;
for (const c of cases) {
  const r = await run(c, port++);
  if (!r.ok) failed++;
  const mb = (c.bytes / 1e6).toFixed(2);
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(14)} ${String(c.files).padStart(2)} files + game.bin ${mb.padStart(6)} MB` +
    (r.ok ? `  ${r.backend}/${r.executor} on ${r.graphics ?? '?'} crate y=${r.crateY.toFixed(3)} first frame ${Math.round(r.firstFrame)} ms` : `  ${r.why}`));
}
process.exit(failed ? 1 : 0);
