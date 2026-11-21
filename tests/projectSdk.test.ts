import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, cp, symlink } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

// `npm test` in a project folder, for real: a generated project with a script and a test, the SDK installed the
// way the desktop app installs it (.cleo/sdk/cleo, node_modules/cleo linked to it), and the REAL vitest run over
// it in a child process. Needs the SDK built (npm run build:sdk); skipped when it is not.

const require = createRequire(import.meta.url);
const folder = require('../applications/app-kit/desktop/projectFolder.js') as any;
const ROOT = path.resolve(__dirname, '..');
const SDK = path.join(ROOT, 'applications', 'sdk', 'dist', 'cleo');
const CLI = path.join(ROOT, 'applications', 'app-kit', 'desktop', 'sdk', 'cleo.mjs');
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const exec = promisify(execFile);
const built = existsSync(path.join(SDK, 'runtime', 'testing.mjs'));

let temp = '';
let project = '';

beforeAll(async () => {
  if (!built) return;
  temp = await mkdtemp(path.join(tmpdir(), 'cleo-sdk-'));
  project = path.join(temp, 'Game');
  await mkdir(path.join(project, 'Assets', 'Shared'), { recursive: true });
  await mkdir(path.join(project, 'Assets', 'Characters'), { recursive: true });
  await mkdir(path.join(project, 'tests'), { recursive: true });
  await writeFile(path.join(project, 'project.cleo'), '{"cleo":1,"format":1,"uid":"u","name":"Game"}\n');
  await writeFile(path.join(project, 'Assets', 'Shared', 'Speed.ts'), `export const double = (v: number) => v * 2\n`);
  // A class script importing another script and a decorator, reading input: what a game's scripts do.
  await writeFile(path.join(project, 'Assets', 'Characters', 'Mover.ts'), `import { Node, Input } from 'cleo'
import { attribute } from 'cleo/decorators'
import { double } from '@/Shared/Speed'

export default class Mover extends Node {
  @attribute() speed = 1
  steps = 0
  onUpdate(dt: number) {
    const [x] = Input.vector('Move')
    this.setPosition([this.position[0] + x * double(this.speed) * dt, this.position[1], this.position[2]])
    this.steps++
  }
}
`);
  await writeFile(path.join(project, 'tests', 'mover.test.ts'), `import { describe, it, expect } from 'vitest'
import { createTestWorld } from 'cleo/testing'

describe('Mover', () => {
  it('moves at twice its speed while Move is held right', () => {
    const world = createTestWorld()
    const mover = world.spawn({ name: 'Mover', script: '@/Characters/Mover', vars: { speed: 3 } })
    world.start()
    world.input.setMove(1)
    world.step(1)
    expect(mover.steps).toBe(60)
    expect(mover.position[0]).toBeCloseTo(6, 3)
    world.dispose()
  })
})
`);
  await writeFile(path.join(project, 'vitest.config.mjs'), `import { cleoVitest } from 'cleo/testing/vitest'\nexport default cleoVitest()\n`);
  await cp(SDK, path.join(project, '.cleo', 'sdk', 'cleo'), { recursive: true });
  folder.allow(project);
  await folder.installSdk(project, { version: '1.0.0', sdkDir: SDK, cliFile: CLI });
  // `npm install` would put vitest here; the repository's stands in.
  await symlink(path.join(ROOT, 'node_modules', 'vitest'), path.join(project, 'node_modules', 'vitest'), process.platform === 'win32' ? 'junction' : 'dir');
}, 300_000);

afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
});

describe('npm test in a project folder', () => {
  it.skipIf(!built)('runs a project script, its imports and decorators, on the headless engine', async () => {
    let out = '';
    let code = 0;
    try {
      const res = await exec(process.execPath, [VITEST, 'run', '--root', project], { cwd: project, env: { ...process.env, CI: '1' }, timeout: 240_000 });
      out = res.stdout + res.stderr;
    } catch (e: any) {
      code = e.code ?? 1;
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(code, out).toBe(0);
    expect(out).toMatch(/1 passed/);
  }, 300_000);

  it.skipIf(!built || !existsSync(path.join(ROOT, 'dist', 'cleo.d.ts')))('and its tests and scripts type-check (npm run typecheck)', async () => {
    // What the editor writes into the SDK from its bundle: the engine's declaration tree, and the scaffold's tsconfig.
    await cp(path.join(ROOT, 'dist'), path.join(project, '.cleo', 'sdk', 'cleo'), { recursive: true, filter: src => !src.endsWith('package.json') });
    const { TSCONFIG } = await import('../applications/editor/src/features/projectFolder/scaffold');
    await writeFile(path.join(project, 'tsconfig.json'), TSCONFIG);
    await mkdir(path.join(project, '.cleo', 'types'), { recursive: true });
    await writeFile(path.join(project, '.cleo', 'types', 'gl-matrix.d.ts'), await (await import('fs/promises')).readFile(path.join(ROOT, 'applications', 'node_modules', 'gl-matrix', 'index.d.ts'), 'utf8'));
    let out = '';
    try { await exec(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', project], { cwd: project }); }
    catch (e: any) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
    expect(out).toBe('');
  }, 120_000);
});
