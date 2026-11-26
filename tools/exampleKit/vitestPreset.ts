// The test setup of the example projects in examples/: each example's tests/ run with `npm test` in its folder
// (examples/<slug>/vitest.config.mjs calls `exampleVitest`), and with the root's `npm test`, which spreads every
// example's projects into its own (vitest cannot nest a config's `projects` inside another's).
//
// An example's tests are the ones that play it, and the engine, editor and host tests that use it as their
// fixture, so they reach this repository's sources, not a project SDK:
//
//   cleo, cleo/*        src/ (the engine's vite.config.ts: one copy of every class, the shader plugin)
//   cleo/testing        applications/sdk/src/testing.ts (what a project folder's tests get)
//   @/X                 the example's own Assets/X (its scripts, as the scripts import each other)
//   @engine/X           src/X                      @engine-tests/X   tests/X (the engine suites' helpers)
//   @editor/X           applications/editor/src/X  @host/X           applications/host/src/X
//   @host-tests/X       applications/host/tests/X  @tools/X          tools/X
//
// example.json "tests" says what else an example's suites need: `physicsSuites`, the files that run again on
// every other physics backend (as the root's PHYSICS_SUITES do), and `heapMb`.
//
// Before an example's tests run, its data lock is brought up to the folder (lockSetup.ts), so the data an edit in
// the desktop editor stored is what its tests check.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import engineConfig from '../../vite.config'
import { appKitAlias } from '../../applications/app-kit/vite.preset'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const at = (...p: string[]) => path.join(ROOT, ...p).split(path.sep).join('/')

/** The backends besides cannon that an example's physics suites run on again. */
const OTHER_BACKENDS = ['rapier', 'jolt']

interface ExampleTests { physicsSuites?: string[]; heapMb?: number }

function testsOf(dir: string): ExampleTests {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'example.json'), 'utf8')).tests ?? {} } catch { return {} }
}

/** Whether the netsync host's own dependencies are installed (the socket suites need them). */
const hostInstalled = () =>
  fs.existsSync(path.join(ROOT, 'applications', 'host', 'node_modules', 'ws'))
  && fs.existsSync(path.join(ROOT, 'applications', 'host', 'node_modules', '@fails-components', 'webtransport'))

/** The vitest projects of the example folder `dir`: its suites, again on each other backend, and its socket suites. */
export function exampleProjects(dir: string): any[] {
  const slug = path.basename(dir)
  const tests = testsOf(dir)
  const assets = path.join(dir, 'Assets').split(path.sep).join('/')
  const base = (name: string, test: Record<string, any>, extraAlias: any[] = []) => mergeConfig(engineConfig, defineConfig({
    root: dir,
    cacheDir: at('node_modules', '.vite', `example-${slug}`),
    resolve: {
      alias: [
        ...extraAlias,
        { find: /^cleo\/testing$/, replacement: at('applications', 'sdk', 'src', 'testing.ts') },
        { find: /^cleo\/testing\/vitest$/, replacement: at('applications', 'sdk', 'src', 'vitest.ts') },
        { find: /^@\/(.+)$/, replacement: `${assets}/$1` },
        { find: /^@engine\/(.+)$/, replacement: at('src') + '/$1' },
        { find: /^@engine-tests\/(.+)$/, replacement: at('tests') + '/$1' },
        { find: /^@editor\/(.+)$/, replacement: at('applications', 'editor', 'src') + '/$1' },
        { find: /^@host\/(.+)$/, replacement: at('applications', 'host', 'src') + '/$1' },
        { find: /^@host-tests\/(.+)$/, replacement: at('applications', 'host', 'tests') + '/$1' },
        { find: /^@tools\/(.+)$/, replacement: at('tools') + '/$1' },
        ...(appKitAlias as any[]),
      ],
    },
    test: {
      name,
      root: dir,
      environment: 'node',
      // What src/cleo.ts installs (the script compiler), for the tests that reach the runtime alone.
      setupFiles: [at('tests', 'helpers', 'engineTools.ts'), ...(test.setupFiles ?? [])],
      // projectRoot() walks up from the working directory, which is the repository's in a root run.
      env: { CLEO_PROJECT: dir, ...(test.env ?? {}) },
      pool: 'forks',
      // --expose-gc: a WASM physics world dropped without dispose is freed when collected (backendSetup.ts).
      // `serial`: one file at a time, in one process (the suites that measure real time; see below).
      poolOptions: { forks: { execArgv: ['--expose-gc', `--max-old-space-size=${tests.heapMb ?? 8192}`], ...(test.serial ? { singleFork: true } : {}) } },
      // A serial project runs in a later group, after every other project is done: alone on the machine.
      ...(test.serial ? { sequence: { groupOrder: 1 } } : {}),
      testTimeout: 60_000,
      hookTimeout: 180_000,
      include: test.include,
      exclude: ['node_modules/**', '.cleo/**', ...(test.exclude ?? [])],
      globalSetup: test.globalSetup ?? [],
    },
  }))

  // The host suites measure real time (tick budgets, sockets): CLEO_TEST_HOST=0 leaves them out (CI's engine job, whose
  // runners are too busy for their budgets; the host's own suites never ran in CI either).
  const hostSuites = process.env.CLEO_TEST_HOST !== '0'
  // The main project locks the example's data first (lockSetup.ts): an edit's new data is in the lock it tests.
  const projects = [base(`example:${slug}`, {
    include: ['tests/**/*.test.ts'], exclude: ['tests/net/**', 'tests/host/**'],
    globalSetup: [at('tools', 'exampleKit', 'lockSetup.ts')],
  })]
  // The host suites in a project of their own, run serially after everything else: they measure real time (tick
  // budgets, a host's busy time), and beside a full run's other forks they timed out or blew their budgets.
  if (hostSuites && fs.existsSync(path.join(dir, 'tests', 'host')))
    projects.push(base(`example:${slug} host`, { include: ['tests/host/**/*.test.ts'], serial: true }))
  for (const backend of tests.physicsSuites?.length ? OTHER_BACKENDS : []) {
    projects.push(base(`example:${slug} on ${backend}`, {
      include: tests.physicsSuites!.map(s => `tests/${s}.test.ts`),
      env: { CLEO_TEST_PHYSICS: backend },
      setupFiles: [at('tests', 'helpers', 'backendSetup.ts')],
    }))
  }
  if (hostSuites && hostInstalled() && fs.existsSync(path.join(dir, 'tests', 'net')))
    // A test file's bare imports resolve from the example folder up, which never reaches the host's own packages.
    projects.push(base(`example:${slug} net`, { include: ['tests/net/**/*.test.ts'], serial: true }, ['ws', '@fails-components/webtransport'].map(pkg => ({
      find: new RegExp(`^${pkg}$`), replacement: at('applications', 'host', 'node_modules', ...pkg.split('/')),
    }))))
  return projects
}

/** The vitest config of an example folder: `export default exampleVitest(import.meta.url)`. */
export function exampleVitest(configUrl: string) {
  const dir = path.dirname(fileURLToPath(configUrl))
  return defineConfig({ test: { projects: exampleProjects(dir) } })
}

/** Every example folder in examples/ (with a project.cleo). */
export function exampleDirs(): string[] {
  const examples = path.join(ROOT, 'examples')
  if (!fs.existsSync(examples)) return []
  return fs.readdirSync(examples, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(examples, d.name, 'project.cleo')))
    .map(d => path.join(examples, d.name))
    .sort()
}
