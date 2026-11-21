// `cleo/testing`: script unit tests for a Cleo project folder, in Node (`npm test`).
//
// A test builds a small world, spawns nodes with the project's scripts on them, steps it and looks at what
// happened — the engine headless, with no window, no GPU and no editor:
//
//   import { describe, it, expect } from 'vitest'
//   import { createTestWorld } from 'cleo/testing'
//
//   describe('Hero', () => {
//     it('walks right while Move is held', () => {
//       const world = createTestWorld()
//       const hero = world.spawn({ type: 'characterBody2D', name: 'Hero', script: '@/Characters/Hero', characterBody2D: { size: [1, 2] } })
//       world.start()
//       world.input.setMove(1)
//       world.step(1)
//       expect(hero.position[0]).toBeGreaterThan(0)
//       world.dispose()
//     })
//   })
//
// Scripts run through the engine's own script compiler, exactly as in the game — their imports of other
// scripts ('@/Shared/Math', './Util'), their decorators, the 'cleo' they import — never through the test
// runner's TypeScript. Every script of the project is registered as a module, so imports resolve.

import fs from 'node:fs'
import path from 'node:path'
import { CleoEngine, InputSystem, Scene, parseNodeJson, setScriptModuleSources, resetScriptModules } from 'cleo'
import type { Node } from 'cleo'

/** The project folder: CLEO_PROJECT, else the nearest folder up from the working directory with project.cleo. */
export function projectRoot(): string {
  if (process.env.CLEO_PROJECT) return path.resolve(process.env.CLEO_PROJECT)
  let dir = process.cwd()
  for (;;) {
    if (fs.existsSync(path.join(dir, 'project.cleo'))) return dir
    const up = path.dirname(dir)
    if (up === dir) throw new Error('cleo/testing: not inside a Cleo project folder (no project.cleo found)')
    dir = up
  }
}

/** A file name segment as the editor named it (the folder %-escapes what a file system cannot hold). */
const decodeSegment = (s: string) => (s === '%00' ? '' : s.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))))

/** '@/Player/Hero', '/Player/Hero' or 'Player/Hero' -> the module id '/Player/Hero'. */
export function moduleIdOf(spec: string): string {
  const bare = spec.replace(/^@\//, '').replace(/^\/+/, '').replace(/\.(ts|script)$/, '')
  return '/' + bare
}

/** Every script of the project, by module id. */
export function projectScripts(root = projectRoot()): Record<string, string> {
  const out: Record<string, string> = {}
  const assets = path.join(root, 'Assets')
  const walk = (dir: string, segments: string[]) => {
    let items: fs.Dirent[] = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const abs = path.join(dir, item.name)
      if (item.isDirectory()) { walk(abs, [...segments, decodeSegment(item.name)]); continue }
      const lower = item.name.toLowerCase()
      if (!lower.endsWith('.ts') || lower.endsWith('.d.ts') || lower.endsWith('.test.ts') || lower.endsWith('.spec.ts')) continue
      const stem = decodeSegment(item.name.slice(0, -3))
      out['/' + [...segments, stem].join('/')] = fs.readFileSync(abs, 'utf-8')
    }
  }
  walk(assets, [])
  return out
}

let registered: Record<string, string> | null = null

/** Register every project script as a module (what Play does), so scripts can import each other. */
export function useProjectScripts(root = projectRoot()): Record<string, string> {
  registered = projectScripts(root)
  setScriptModuleSources(registered)
  return registered
}

/** One script's source, by its path in the Assets panel ('@/Player/Hero'). */
export function scriptSource(spec: string): string {
  const scripts = registered ?? useProjectScripts()
  const id = moduleIdOf(spec)
  const source = scripts[id]
  if (source === undefined) throw new Error(`cleo/testing: no script ${id} (looked under Assets/${id.slice(1)}.ts)`)
  return source
}

// ---------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------

/**
 * Scripted input: what `Input.pressed(...)`, `started(...)` and `vector(...)` read in a script, and what a
 * Player Controller reads. A press is a STARTED edge for exactly one frame (the world's `step` ends frames),
 * held until released — the input system's own contract.
 */
export interface FakeInput {
  /** The move vector (x right, y up) every action named as a move action reads. */
  setMove(x: number, y?: number): void
  press(action: string): void
  release(action: string): void
  /** Pressed now, released a frame later. */
  tap(action: string): void
  endFrame(): void
  restore(): void
}

export function fakeInput(moveActions: string | string[] = 'Move'): FakeInput {
  const moves = new Set(Array.isArray(moveActions) ? moveActions : [moveActions])
  const held = new Set<string>()
  const edges = new Set<string>()
  const tapped = new Set<string>()
  const move: [number, number] = [0, 0]
  const sys = InputSystem.instance as any
  const original = { vector: sys.vector, pressed: sys.pressed, started: sys.started }
  sys.vector = (action: string) => (moves.has(action) ? [move[0], move[1]] : [0, 0])
  sys.pressed = (action: string) => held.has(action)
  sys.started = (action: string) => edges.has(action)
  return {
    setMove(x, y = 0) { move[0] = x; move[1] = y },
    press(action) { if (!held.has(action)) edges.add(action); held.add(action) },
    release(action) { held.delete(action) },
    tap(action) { this.press(action); tapped.add(action) },
    endFrame() {
      edges.clear()
      for (const action of tapped) held.delete(action)
      tapped.clear()
    },
    restore() { sys.vector = original.vector; sys.pressed = original.pressed; sys.started = original.started },
  }
}

// ---------------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------------

/** A node to spawn: its scene JSON, with `script` naming a project script and `vars` its field values. */
export interface SpawnOptions {
  type?: string
  name?: string
  id?: string
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: [number, number, number]
  /** A project script, by its path in the Assets panel: '@/Player/Hero'. */
  script?: string
  /** Its fields' values, by name (what the inspector sets). */
  vars?: Record<string, unknown>
  children?: unknown[]
  /** Anything else the node type reads from its JSON (`characterBody2D: { size }`, …). */
  [key: string]: unknown
}

export interface TestWorld {
  scene: Scene
  input: FakeInput
  /** Add a node (before `start`, or after — a node spawned later starts on the next step). */
  spawn<T extends Node = Node>(options: SpawnOptions): T & Record<string, any>
  /** Start the scene: every script's onStart runs. */
  start(): void
  /** Advance `seconds` of game time at `fps` frames a second; `each` runs before every frame. */
  step(seconds?: number, fps?: number, each?: () => void): void
  /** A node by its name. */
  find<T extends Node = Node>(name: string): (T & Record<string, any>) | undefined
  dispose(): void
}

let serial = 0

export function createTestWorld(options: { moveActions?: string | string[] } = {}): TestWorld {
  // A test plays the game, never the editor's authoring view of it.
  CleoEngine.authoringMode = false
  if (!registered) useProjectScripts()
  const scene = new Scene()
  const input = fakeInput(options.moveActions)
  let started = false

  const world: TestWorld = {
    scene,
    input,
    spawn(o) {
      const { script, vars, ...rest } = o
      const json: any = {
        type: 'node', id: `test-${++serial}`, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [],
        ...rest,
        name: o.name ?? o.type ?? 'Node',
      }
      if (script) {
        json.script = scriptSource(script)
        json.scriptPath = moduleIdOf(script)
        json.scriptVars = vars ?? {}
      }
      parseNodeJson(scene.root, json)
      const node = scene.getNodeById(json.id)
      if (!node) throw new Error(`cleo/testing: could not spawn ${json.type} "${json.name}"`)
      return node as any
    },
    start() { if (!started) { started = true; scene.start() } },
    step(seconds = 1 / 60, fps = 60, each) {
      if (!started) world.start()
      for (let t = 0; t < seconds - 1e-9; t += 1 / fps) {
        each?.()
        scene.update(1 / fps, 0, false)
        input.endFrame()
      }
    },
    find(name) {
      let found: any
      const visit = (node: any) => { if (found) return; if (node.name === name) { found = node; return } for (const c of node.children ?? []) visit(c) }
      visit(scene.root)
      return found
    },
    dispose() {
      input.restore()
      scene.dispose()
    },
  }
  return world
}

/** Forget every evaluated script module (between test files that change scripts). */
export function resetProjectScripts(): void {
  registered = null
  resetScriptModules()
}
