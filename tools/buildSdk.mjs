// Build the project SDK: applications/sdk/dist/cleo, which the desktop app copies into every project folder
// it opens (.cleo/sdk/cleo) and ships as an extraResource. What is built here is the runtime half — the
// engine for Node and cleo/testing (applications/sdk/vite.config.ts) — and its declarations; the engine's own
// declaration tree and the CLI are added by the app when it installs the SDK into a project.
//
//   npm run build:sdk

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SDK = path.join(ROOT, 'applications', 'sdk')
const OUT = path.join(SDK, 'dist', 'cleo')
const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')

const res = spawnSync(process.execPath, [vite, 'build', '--config', path.join(SDK, 'vite.config.ts'), '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' })
if (res.status !== 0) process.exit(res.status ?? 1)

const RUNTIME = path.join(OUT, 'runtime')

// The two modules the SDK adds over the engine, declared by hand (their sources import `cleo` by the alias the
// engine's own build uses, which a declaration emit could not follow).
fs.writeFileSync(path.join(RUNTIME, 'testing.d.ts'), `import type { Scene, Node } from 'cleo'

/** The project folder: CLEO_PROJECT, else the nearest folder up from the working directory with project.cleo. */
export function projectRoot(): string
/** '@/Player/Hero' -> '/Player/Hero'. */
export function moduleIdOf(spec: string): string
/** Every script of the project (Assets/**.ts), by module id. */
export function projectScripts(root?: string): Record<string, string>
/** Register every project script as a module, so scripts can import each other (createTestWorld does it). */
export function useProjectScripts(root?: string): Record<string, string>
/** One script's source, by its path in the Assets panel ('@/Player/Hero'). */
export function scriptSource(spec: string): string
/** Forget every evaluated script module. */
export function resetProjectScripts(): void

/** Scripted input: what Input.pressed / started / vector read in scripts and Player Controllers. */
export interface FakeInput {
  setMove(x: number, y?: number): void
  press(action: string): void
  release(action: string): void
  tap(action: string): void
  endFrame(): void
  restore(): void
}
export function fakeInput(moveActions?: string | string[]): FakeInput

export interface SpawnOptions {
  type?: string
  name?: string
  id?: string
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: [number, number, number]
  /** A project script, by its path in the Assets panel: '@/Player/Hero'. */
  script?: string
  /** Its fields' values, by name. */
  vars?: Record<string, unknown>
  children?: unknown[]
  [key: string]: unknown
}

export interface TestWorld {
  scene: Scene
  input: FakeInput
  spawn<T extends Node = Node>(options: SpawnOptions): T & Record<string, any>
  start(): void
  step(seconds?: number, fps?: number, each?: () => void): void
  find<T extends Node = Node>(name: string): (T & Record<string, any>) | undefined
  dispose(): void
}
export function createTestWorld(options?: { moveActions?: string | string[] }): TestWorld

/** The project folder read the way the editor opens it, as a bundle (manifest, scenes, libraries, vfs, images, sounds). */
export function readProject(root?: string): Promise<any>

/** A project's game, running headless (openProject). */
export interface TestGame {
  /** The running game (its engine, scene switching and tick statistics). */
  runtime: any
  readonly scene: Scene
  input: FakeInput
  /** Advance seconds of game time, a tick at a time. */
  step(seconds?: number, each?: () => void): void
  find<T extends Node = Node>(name: string): (T & Record<string, any>) | undefined
  loadScene(nameOrId: string): Promise<void>
  dispose(): void
}
export interface OpenProjectOptions {
  root?: string
  /** The scene to start in, by name or id (default: the main scene). */
  scene?: string
  /** Simulation rate, Hz (default 60). */
  tickRate?: number
  physicsBackend?: string
  /** Change the game data before it is loaded. */
  edit?: (data: Record<string, any>) => void
  moveActions?: string | string[]
  /** Keep the engine's log on (default on). */
  logging?: boolean
}
/** The whole project playing: its main scene on the headless engine, every model, template, script and body, stepped tick by tick. */
export function openProject(options?: OpenProjectOptions): Promise<TestGame>
`)
fs.writeFileSync(path.join(RUNTIME, 'vitest.d.ts'), `export interface CleoVitestOptions { include?: string[]; test?: Record<string, unknown> }
/** The Vitest configuration of a Cleo project folder: tests/**/*.test.ts in Node, against the project's SDK. */
export function cleoVitest(options?: CleoVitestOptions): Record<string, unknown>
`)

// The same declarations where TypeScript's classic `node` resolution looks for a subpath (the project's tsconfig
// mirrors the in-editor one, which does not read package.json "exports").
fs.writeFileSync(path.join(OUT, 'testing.d.ts'), `export * from './runtime/testing'\n`)
fs.mkdirSync(path.join(OUT, 'testing'), { recursive: true })
fs.writeFileSync(path.join(OUT, 'testing', 'vitest.d.ts'), `export * from '../runtime/vitest'\n`)

let bytes = 0
const count = (dir) => { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, d.name); if (d.isDirectory()) count(p); else bytes += fs.statSync(p).size } }
count(OUT)
console.log(`cleo SDK: ${path.relative(ROOT, OUT)} (${(bytes / 1048576).toFixed(1)} MB)`)
