// `cleo/testing/vitest`: the Vitest configuration a project folder's vitest.config.mjs uses.
//
//   import { cleoVitest } from 'cleo/testing/vitest'
//   export default cleoVitest()
//
// Tests live in tests/ (outside Assets/, so the editor never takes them for scripts), run in Node, and get
// the engine as `cleo` from the project's own SDK (.cleo/sdk/cleo, linked as node_modules/cleo).

export interface CleoVitestOptions {
  /** Extra globs of test files, besides tests/**\/*.test.ts. */
  include?: string[]
  /** Anything else for Vitest's `test` section. */
  test?: Record<string, unknown>
}

export function cleoVitest(options: CleoVitestOptions = {}): Record<string, unknown> {
  return {
    test: {
      include: ['tests/**/*.test.ts', ...(options.include ?? [])],
      environment: 'node',
      // One engine per worker: scripts and their modules are process-wide, as in a game.
      pool: 'forks',
      testTimeout: 30_000,
      // A new project has no tests yet; `npm test` says so instead of failing.
      passWithNoTests: true,
      // The SDK is already built for Node: loaded as it is rather than transformed again (node_modules/cleo
      // resolves to .cleo/sdk/cleo, which is outside node_modules, so Vitest would otherwise inline it).
      server: { deps: { external: [/[\\/]\.cleo[\\/]sdk[\\/]/] } },
      ...(options.test ?? {}),
    },
  }
}
