import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { staticScaffold } from '../src/features/scriptWorkspace/scaffold';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]editor[\\/]tests[\\/]?$/, '');

// The point of the script workspace is that a folder on disk types a script exactly the way the in-editor
// Monaco does: `import { Node } from 'cleo'` resolves, F12 walks into the engine's declaration tree, and
// `Vec.vec3` is real rather than `any`.
//
// Nothing else in the suite can prove that -- it is a property of the GENERATED tsconfig plus the layout
// the declarations are written into, and it fails silently (every type quietly degrades to `any`). So
// this builds a workspace the way the editor does and runs the real compiler over it.
//
// The declaration payload is gathered from dist/ here rather than through `workspaceTypeFiles()`, which
// depends on an `import.meta.glob` the app bundler resolves. The LAYOUT is what is under test, and
// it is reproduced exactly: node_modules/cleo/<same rel path>, the synthetic package.json, and the two
// ambient files under .cleo/types.

let root = '';
let skip = false;

/** Copy every .d.ts under `from` into `to`, preserving the tree. */
async function copyDeclarations(from: string, to: string): Promise<number> {
  let count = 0;
  async function walk(dir: string, rel: string) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name === 'node_modules') continue;
      const abs = path.join(dir, item.name);
      const nextRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) { await walk(abs, nextRel); continue; }
      if (!item.name.endsWith('.d.ts')) continue;
      const dest = path.join(to, nextRel);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, await readFile(abs, 'utf-8'), 'utf-8');
      count++;
    }
  }
  await walk(from, '');
  return count;
}

beforeAll(async () => {
  const dist = path.join(repo, 'dist');
  const glMatrix = path.join(repo, 'editor', 'node_modules', 'gl-matrix', 'index.d.ts');
  const cannon = path.join(repo, 'editor', 'node_modules', 'cannon-es', 'dist', 'cannon-es.d.ts');
  // dist/ is gitignored and written by `npm run build`, so a clean checkout has nothing to check against.
  if (!existsSync(path.join(dist, 'cleo.d.ts')) || !existsSync(glMatrix) || !existsSync(cannon)) {
    skip = true;
    return;
  }

  root = await mkdtemp(path.join(tmpdir(), 'cleo-ws-types-'));

  for (const file of staticScaffold()) {
    const abs = path.join(root, file.rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, file.content, 'utf-8');
  }

  const cleoDir = path.join(root, 'node_modules', 'cleo');
  const copied = await copyDeclarations(dist, cleoDir);
  expect(copied).toBeGreaterThan(50); // the real tree, not an empty dist
  await writeFile(
    path.join(cleoDir, 'package.json'),
    JSON.stringify({ name: 'cleo', version: '1.0.0', types: 'cleo.d.ts' }, null, 2),
    'utf-8',
  );

  await mkdir(path.join(root, '.cleo', 'types'), { recursive: true });
  await writeFile(path.join(root, '.cleo', 'types', 'gl-matrix.d.ts'), await readFile(glMatrix, 'utf-8'), 'utf-8');
  await writeFile(path.join(root, '.cleo', 'types', 'cannon-es.d.ts'), await readFile(cannon, 'utf-8'), 'utf-8');
}, 120000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
});

/** Run the real tsc over the generated workspace and return its (combined) output. */
async function typecheck(): Promise<{ ok: boolean; out: string }> {
  const tsc = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    await exec(process.execPath, [tsc, '--noEmit', '-p', path.join(root, 'tsconfig.json')], { cwd: root });
    return { ok: true, out: '' };
  } catch (e: any) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

async function writeScript(rel: string, source: string) {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, source, 'utf-8');
}

describe('generated script workspace', () => {
  it('type-checks a script that imports the engine', async () => {
    if (skip) return;
    await writeScript('Player/Hero.ts', `
import { ModelNode } from 'cleo'

export default class HeroNode extends ModelNode {
  public speed = 5
  private _elapsed = 0

  onStart() {
    this.setPosition([0, 1, 0])
  }

  onUpdate(delta: number) {
    this._elapsed += delta
    if (this.isGrounded) this.velocity = [0, this.speed, 0]
  }
}
`);
    const res = await typecheck();
    expect(res.out).toBe('');
    expect(res.ok).toBe(true);
  }, 180000);

  it('enforces the engine API rather than treating the import as any', async () => {
    if (skip) return;
    // The failure mode this whole layout guards against is silent degradation: an unresolved 'cleo'
    // makes every member `any`, so a script that is quietly wrong still type-checks clean. `position`
    // is a read-only getter (writes are lost on the next updateTransforms), so rejecting an assignment
    // to it proves the real declarations are in play.
    await writeScript('Player/Hero.ts', `
import { Node } from 'cleo'

export default class ReadOnlyNode extends Node {
  onStart() {
    this.position = [0, 1, 0]
  }
}
`);
    const res = await typecheck();
    expect(res.ok).toBe(false);
    expect(res.out).toMatch(/read-only property/);
  }, 180000);

  it('resolves gl-matrix through the engine barrel rather than degrading to any', async () => {
    if (skip) return;
    // `export * as Vec from "gl-matrix"` in src/cleo.ts is the common way scripts do vector maths. Before
    // gl-matrix's declarations were shipped alongside, this was silently `any` -- which type-checks
    // either way, so the assertion has to be that a WRONG call is actually rejected.
    await writeScript('Player/Hero.ts', `
import { Node, Vec } from 'cleo'

export default class MathNode extends Node {
  onStart() {
    const out = Vec.vec3.create()
    Vec.vec3.add(out, [1, 2, 3], [4, 5, 6])
  }
}
`);
    expect((await typecheck()).ok).toBe(true);

    await writeScript('Player/Hero.ts', `
import { Node, Vec } from 'cleo'

export default class MathNode extends Node {
  onStart() {
    Vec.vec3.add('not a vector', 1, 2)
  }
}
`);
    const bad = await typecheck();
    expect(bad.ok).toBe(false);
    expect(bad.out).toMatch(/Player[\\/]Hero\.ts/);
  }, 180000);

  it('reports a real mistake in a script', async () => {
    if (skip) return;
    await writeScript('Player/Hero.ts', `
import { Node } from 'cleo'

export default class BrokenNode extends Node {
  onStart() {
    this.definitelyNotAMember()
  }
}
`);
    const res = await typecheck();
    expect(res.ok).toBe(false);
    expect(res.out).toMatch(/definitelyNotAMember/);
  }, 180000);

  it('does not type-check the mirrored declarations themselves', async () => {
    if (skip) return;
    // `exclude: ["node_modules"]` plus skipLibCheck: a user script is checked, the engine's shipped
    // declarations are not. Without this an engine-side type quirk would surface as an error in the
    // user's workspace, which they cannot act on.
    await writeScript('Player/Hero.ts', `
import { Node } from 'cleo'
export default class OkNode extends Node {}
`);
    const res = await typecheck();
    expect(res.out).not.toMatch(/node_modules/);
    expect(res.ok).toBe(true);
  }, 180000);
});
