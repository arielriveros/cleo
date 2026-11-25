// Which parts of the repository a change touches, and so what CI tests and what a merge ships.
//
//   node tools/ci/affected.mjs --base <sha> --head <sha>   the changes of a pull request: merge-base(base, head)..head
//   node tools/ci/affected.mjs --all                        everything (a manual run)
//   node tools/ci/affected.mjs path…                         the areas these paths touch (by hand)
//
// The areas, and what each one means downstream (ci.yml, tests.yml, release.yml):
//
//   engine    src/, the root tests and tooling, the pipeline itself. Everything else is built on it, so it turns on
//             every other area: an engine change tests and ships every app.
//   appkit    applications/app-kit (outside desktop/), shared by the editor and Cleo Creator: turns on both.
//   editor    the editor, the desktop shell and what its installer ships (the host, the SDK, the MCP server), and
//             docs/, which the editor's docs viewer bundles. Ships: installers, a release, the editor's site.
//   creator   Cleo Creator. Ships: the Creator's site.
//   examples  examples/<slug>/ (that example only), or the tools and editor codec that turn a folder into the
//             bundle the gallery installs (every example). Ships: the `examples` release.
//   worker    tools/ci/examples-worker, the Cloudflare Worker the web editor downloads examples through.
//
// The diff is merge-base..head on purpose: what the pull request itself changed, whatever the merge strategy, and
// never the release's own version-bump commits on main. A path no rule names is treated as engine, so a new
// top-level folder runs everything until someone decides otherwise; the paths that ship nothing are listed.
//
// Output: `area=true|false` lines and `example_slugs=<slug …>|all` into $GITHUB_OUTPUT (stdout as JSON without it),
// and a table into $GITHUB_STEP_SUMMARY when that is set.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TOOL_SOURCES } from '../examples/toolSources.mjs'

export const AREAS = ['engine', 'appkit', 'editor', 'creator', 'examples', 'worker']

/** The editor modules the gallery's bundles are written with: a change there re-publishes every example. */
const CODEC_FILES = new Set(TOOL_SOURCES.filter(f => f.startsWith('applications/')))

/**
 * The rules, first match wins. `areas` lists what a path turns on; `examples: 'slug'` marks the example named by
 * the path's second segment, `examples: 'all'` every example. An empty `areas` ships nothing.
 */
export const RULES = [
  // Nothing ships for these.
  { test: p => /^[^/]+\.md$/.test(p), areas: [] },
  { test: p => p === 'examples/README.md' || p === 'applications/README.md', areas: [] },
  { test: p => p === '.github/pull_request_template.md', areas: [] },
  { test: p => p.startsWith('graphify-out/') || p.startsWith('coverage/'), areas: [] },
  { test: p => p === '.gitignore' || p === '.gitattributes', areas: [] },

  // The examples.
  { test: p => p.startsWith('examples/assets/'), areas: ['examples'], examples: 'all' },
  { test: p => /^examples\/[^/]+\//.test(p), areas: ['examples'], examples: 'slug' },
  { test: p => p.startsWith('tools/examples/') || p.startsWith('tools/exampleKit/'), areas: ['examples'], examples: 'all' },
  { test: p => CODEC_FILES.has(p), areas: ['editor', 'examples'], examples: 'all' },

  // The Cloudflare Worker, before the rest of tools/ci.
  { test: p => p.startsWith('tools/ci/examples-worker/'), areas: ['worker'] },

  // The applications.
  { test: p => p.startsWith('applications/app-kit/desktop/'), areas: ['editor'] },
  { test: p => p.startsWith('applications/app-kit/'), areas: ['appkit', 'editor', 'creator'] },
  { test: p => p === 'applications/package.json' || p === 'applications/package-lock.json', areas: ['appkit', 'editor', 'creator'] },
  { test: p => p.startsWith('applications/editor/'), areas: ['editor'] },
  { test: p => p.startsWith('applications/creator/'), areas: ['creator'] },
  { test: p => /^applications\/(host|sdk|mcp)\//.test(p), areas: ['editor'] },
  { test: p => p.startsWith('docs/'), areas: ['editor'] },

  // The engine: its sources, tests and tools, the root config, and the pipeline. Also any path no rule above names.
  { test: () => true, areas: ['engine'] },
]

/** The areas a list of changed paths touches: `{ engine, appkit, …, any, exampleSlugs: 'all' | string[] }`. */
export function affected(paths) {
  const on = new Set()
  const slugs = new Set()
  let allExamples = false
  for (const raw of paths) {
    const p = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!p) continue
    const rule = RULES.find(r => r.test(p))
    for (const a of rule.areas) on.add(a)
    if (rule.examples === 'all') allExamples = true
    else if (rule.examples === 'slug') slugs.add(p.split('/')[1])
  }
  // The dependency closure: the apps are built on the engine, and on the app-kit they share.
  if (on.has('engine')) { on.add('appkit'); on.add('editor'); on.add('creator'); on.add('examples'); allExamples = true }
  if (on.has('appkit')) { on.add('editor'); on.add('creator') }
  const out = Object.fromEntries(AREAS.map(a => [a, on.has(a)]))
  out.any = AREAS.some(a => on.has(a))
  out.exampleSlugs = !on.has('examples') ? [] : allExamples ? 'all' : [...slugs].sort()
  return out
}

/** Every area on: a manual run. */
export function everything() {
  return { ...Object.fromEntries(AREAS.map(a => [a, true])), any: true, exampleSlugs: 'all' }
}

/** What changed between the merge base of `base` and `head`, and `head`: the pull request's own changes. */
export function changedPaths(base, head, cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })
  const mergeBase = git('merge-base', base, head).trim()
  // --no-renames: a move lists both the old path and the new one, so a file moved out of an area still counts there.
  return git('diff', '--name-only', '--no-renames', '-z', mergeBase, head).split('\0').filter(Boolean)
}

/** The `$GITHUB_OUTPUT` lines for a result. */
export function outputLines(r) {
  const slugs = r.exampleSlugs === 'all' ? 'all' : r.exampleSlugs.join(' ')
  return [...AREAS.map(a => `${a}=${r[a]}`), `any=${r.any}`, `example_slugs=${slugs}`]
}

function summary(r, how, count) {
  const rows = AREAS.map(a => `| ${a} | ${r[a] ? 'yes' : ''} |`)
  const slugs = r.exampleSlugs === 'all' ? 'all' : r.exampleSlugs.join(', ') || 'none'
  return [`### Changed areas (${how})`, '', '| Area | Changed |', '|---|---|', ...rows, '', `Examples: ${slugs}${count === undefined ? '' : ` · ${count} file(s) changed`}`, ''].join('\n')
}

const SELF = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const args = process.argv.slice(2)
  const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  let result, how, count
  if (args.includes('--all')) {
    result = everything(); how = 'everything'
  } else if (args.includes('--base') || args.includes('--head')) {
    const base = flag('--base'), head = flag('--head') ?? 'HEAD'
    if (!base) { console.error('--base <sha> is required with --head'); process.exit(2) }
    try {
      const paths = changedPaths(base, head)
      result = affected(paths); how = `${base.slice(0, 8)}…${head.slice(0, 8)}`; count = paths.length
    } catch (e) {
      // A base the clone does not have (a shallow checkout, a force-pushed base): test and ship everything rather
      // than nothing.
      console.log(`::warning title=Change check failed::${String(e.message).split('\n')[0]} -- treating every area as changed`)
      result = everything(); how = 'everything (the diff failed)'
    }
  } else {
    const paths = args.filter(a => !a.startsWith('--'))
    result = affected(paths); how = 'the paths given'; count = paths.length
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, outputLines(result).join('\n') + '\n')
  else console.log(JSON.stringify(result, null, 2))
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(result, how, count))
}
