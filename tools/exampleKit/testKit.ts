// What an example's tests (examples/<slug>/tests) share: where their example is, whether its data is on disk, and
// the example read once per test file. The example's vitest project sets CLEO_PROJECT to its folder
// (tools/exampleKit/vitestPreset.ts), so a test never spells out its own path.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readExample } from './readExample.mjs'
import { dataPresent, scriptSourceAt } from './folder.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The repository's root (for what a test reads outside the example: build/ inputs, other suites' fixtures). */
export const REPO_ROOT = ROOT

/** The folder of the example whose tests are running. */
export const EXAMPLE: string = process.env.CLEO_PROJECT ? path.resolve(process.env.CLEO_PROJECT) : ''

/** The folder of the example `slug` (a test that reads another example as well). */
export const exampleDir = (slug: string): string => path.join(ROOT, 'examples', slug)

/** Whether the example's binary data is on disk (npm run examples:fetch); a test that needs it skips without. */
export const dataReady = (dir: string = EXAMPLE): boolean => !!dir && dataPresent(dir)

const cache = new Map<string, Promise<{ bundle: any; read: (...parts: string[]) => any }>>()

/** The example read as the editor would open it (readExample: `{ bundle, read }`), once per test file. */
export function readThisExample(dir: string = EXAMPLE) {
  if (!cache.has(dir)) cache.set(dir, readExample(dir))
  return cache.get(dir)!
}

/** The source of a script of the example, by its explorer path ('/Characters/Warrior/Scripts/DuskPlayer.script'). */
export const exampleScript = (vfsPath: string, dir: string = EXAMPLE): string => scriptSourceAt(dir, vfsPath)

/**
 * Every script file of the example by the name it had in the old flat examples/scripts/ folder: a class script's
 * class without its `Node` suffix (SoulsPlayerNode -> 'SoulsPlayer'), a module's file name. For suites that walk the
 * scripts by those names.
 */
export function scriptFiles(dir: string = EXAMPLE): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name)
      if (e.isDirectory()) { walk(abs); continue }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) continue
      const cls = /export\s+default\s+(?:abstract\s+)?class\s+(\w+)/.exec(fs.readFileSync(abs, 'utf8'))?.[1]
      out.set(cls ? cls.replace(/Node$/, '') : e.name.slice(0, -3), abs)
    }
  }
  if (dir && fs.existsSync(path.join(dir, 'Assets'))) walk(path.join(dir, 'Assets'))
  return new Map([...out].sort((a, b) => a[0].localeCompare(b[0])))
}
