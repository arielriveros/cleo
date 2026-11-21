import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, realpath, lstat } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

// The project's `cleo` CLI (npm run play / debug) against the editor's control pipe, with the editor window
// faked: a renderer that answers what the main process relays. Both halves are the real modules.

const require = createRequire(import.meta.url);
const control = require('../applications/app-kit/desktop/controlPipe.js') as any;
const folder = require('../applications/app-kit/desktop/projectFolder.js') as any;
const CLI = path.resolve(__dirname, '..', 'applications', 'app-kit', 'desktop', 'sdk', 'cleo.mjs');
const exec = promisify(execFile);

let temp = '';
let project = '';
const handlers = new Map<string, (...args: any[]) => any>();
const sent: any[] = [];
const app = { getVersion: () => '9.9.9', isPackaged: false };

/** The editor window: takes commands, answers play with a port. */
const webContents = {
  isDestroyed: () => false,
  on: () => {},
  send(channel: string, command: any) {
    sent.push(command);
    if (channel !== 'control:command') return;
    const result = command.cmd === 'ping' ? { ok: true, root: project }
      : command.cmd === 'play' ? { ok: true, port: command.debug ? 9339 : undefined }
      : { ok: true };
    setTimeout(() => handlers.get('control:reply')!({ sender: webContents }, command.id, result), 20);
  },
};

async function cli(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { cwd: project, env: { ...process.env, ...env } });
    return { code: 0, out: stdout + stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeAll(async () => {
  temp = await mkdtemp(path.join(tmpdir(), 'cleo-control-'));
  project = path.join(temp, 'Game');
  await mkdir(path.join(project, 'Assets'), { recursive: true });
  await writeFile(path.join(project, 'project.cleo'), '{"cleo":1,"format":1,"uid":"u","name":"Game"}\n');
  control.start(path.join(temp, 'userData'));
  control.registerIpc({ ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) }, allow: (r: string) => r });
  control.attach(webContents);
  await handlers.get('control:ready')!({ sender: webContents });
  // What the editor writes into a project it opens.
  await mkdir(path.join(project, '.cleo', 'local'), { recursive: true });
  await writeFile(path.join(project, '.cleo', 'local', 'editor.json'), JSON.stringify(control.editorRecord(app)));
});

afterAll(async () => {
  await rm(temp, { recursive: true, force: true }).catch(() => {});
});

describe('the cleo CLI', () => {
  it('plays the project in the running editor', async () => {
    const res = await cli(['play']);
    expect(res.code).toBe(0);
    expect(res.out).toContain('Playing in a window.');
    expect(sent.at(-1)).toMatchObject({ cmd: 'play', debug: false });
    expect(sent.at(-1).root.toLowerCase()).toBe(project.toLowerCase());
  });

  it('debug turns VS Code debugging on and reports the port', async () => {
    const res = await cli(['play', '--debug']);
    expect(res.code).toBe(0);
    expect(res.out).toContain('port 9339');
    expect(sent.at(-1)).toMatchObject({ cmd: 'play', debug: true });
  });

  it('finds the project from a subfolder', async () => {
    const { stdout } = await exec(process.execPath, [CLI, 'status'], { cwd: path.join(project, 'Assets') });
    expect(stdout).toContain('has');
  });

  it('is refused without the token the editor wrote', async () => {
    const record = JSON.parse(await readFile(path.join(project, '.cleo', 'local', 'editor.json'), 'utf8'));
    await writeFile(path.join(project, '.cleo', 'local', 'editor.json'), JSON.stringify({ ...record, token: 'f'.repeat(32) }));
    const res = await cli(['play']);
    expect(res.code).toBe(1);
    expect(res.out).toContain('bad token');
    await writeFile(path.join(project, '.cleo', 'local', 'editor.json'), JSON.stringify(record));
  });

  it('says what to do when no Cleo is running and none is known', async () => {
    const lonely = path.join(temp, 'Lonely');
    await mkdir(lonely, { recursive: true });
    await writeFile(path.join(lonely, 'project.cleo'), '{}');
    const env = { ...process.env } as Record<string, string>;
    delete env.CLEO_EDITOR;
    try {
      await exec(process.execPath, [CLI, 'play'], { cwd: lonely, env });
      expect.fail('it should have failed');
    } catch (e: any) {
      expect(e.code).toBe(1);
      expect(`${e.stderr}`).toContain('has not been opened in Cleo on this machine');
    }
  });

  it('outside a project it says so', async () => {
    try {
      await exec(process.execPath, [CLI, 'play'], { cwd: temp });
      expect.fail('it should have failed');
    } catch (e: any) {
      expect(`${e.stderr}`).toContain('not in a Cleo project folder');
    }
  });
});

describe('the project SDK', () => {
  it('writes the cleo package with its CLI and links node_modules/cleo to it', async () => {
    folder.allow(project);
    const res = await folder.installSdk(project, { version: '9.9.9', cliFile: CLI, typesHash: 'abc' });
    expect(res.ok).toBe(true);
    expect(res.needTypes).toBe(true);
    const pkg = JSON.parse(await readFile(path.join(project, '.cleo', 'sdk', 'cleo', 'package.json'), 'utf8'));
    expect(pkg).toMatchObject({ name: 'cleo', version: '9.9.9', bin: { cleo: 'bin/cleo.mjs' } });
    expect(existsSync(path.join(project, '.cleo', 'sdk', 'cleo', 'bin', 'cleo.mjs'))).toBe(true);
    const link = path.join(project, 'node_modules', 'cleo');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await realpath(link)).toLowerCase()).toBe((await realpath(path.join(project, '.cleo', 'sdk', 'cleo'))).toLowerCase());
    // The declarations written, the second install has nothing to do.
    await writeFile(path.join(project, '.cleo', 'sdk', 'cleo', '.types'), 'abc');
    const again = await folder.installSdk(project, { version: '9.9.9', cliFile: CLI, typesHash: 'abc' });
    expect(again).toMatchObject({ installed: false, needTypes: false });
  });
});
