import type { BenchOptions, BenchScenario } from './scenarios'
import { BENCH_DEFAULTS } from './scenarios'

// What the Reactions tab and its bench in the viewport share: the scenario and its options, the tools, the
// clock, and the last seconds of what the reaction did (the timeline and the replay read them). A plain store
// with listeners, like poseEditStore: the tab unmounts behind its siblings while the bench keeps running.

/** One recorded frame: where every part was, and what the reaction was doing. */
export interface BenchFrame {
  t: number
  state: string
  /** Every part's pose [px py pz qx qy qz qw], packed. */
  poses: Float32Array
  /** Running behaviours and their weights. */
  behaviours: Record<string, number>
}

/** A fixed ring of the last frames (20 s at 60 fps). */
export class BenchRecorder {
  private _frames: (BenchFrame | undefined)[]
  private _next = 0
  private _count = 0

  constructor(public readonly capacity = 1200) { this._frames = new Array(capacity) }

  public push(frame: BenchFrame): void {
    this._frames[this._next] = frame
    this._next = (this._next + 1) % this.capacity
    this._count = Math.min(this.capacity, this._count + 1)
  }

  public get count(): number { return this._count }

  /** The `i`-th frame kept, oldest first. */
  public at(i: number): BenchFrame | undefined {
    if (i < 0 || i >= this._count) return undefined
    return this._frames[(this._next - this._count + i + this.capacity) % this.capacity]
  }

  /** The frame nearest a fraction 0..1 of what is kept (0 the oldest). */
  public atFraction(f: number): BenchFrame | undefined {
    if (this._count === 0) return undefined
    return this.at(Math.round(Math.max(0, Math.min(1, f)) * (this._count - 1)))
  }

  public clear(): void { this._frames = new Array(this.capacity); this._next = 0; this._count = 0 }
}

export type BenchTool = 'none' | 'shoot' | 'push'

export interface BenchState {
  scenario: BenchScenario
  options: BenchOptions
  /** The scenario is set up (props built, character placed, reactions live). */
  running: boolean
  paused: boolean
  /** Game-time scale while running: 1, 0.5, 0.25, 0.1. */
  slow: number
  tool: BenchTool
  /** N·s a shot or a click-push lands with. */
  impulse: number
  /** Which of the rig's sets the bench runs (index), -1 the built-in default. */
  set: number
  overlays: { target: boolean; balance: boolean; impact: boolean }
  /** What the reaction is doing now (for the tab to show). */
  live: { state: string; behaviours: Record<string, number>; health: number } | null
  /** While paused, the replay position 0..1 (null: live). */
  scrub: number | null
}

type Listener = (s: BenchState) => void

let state: BenchState = {
  scenario: 'flat', options: { ...BENCH_DEFAULTS }, running: false, paused: false, slow: 1, tool: 'shoot', impulse: 20, set: 0,
  overlays: { target: true, balance: true, impact: true }, live: null, scrub: null,
}
const listeners = new Set<Listener>()
const actions = new Set<(a: BenchAction) => void>()

/** What the tab's action buttons do to the character. */
export type BenchActWhat = 'trip' | 'push' | 'fall' | 'bail' | 'knockOut' | 'kill' | 'getUp' | 'hit'

/** One-off things the tab asks the bench to do. */
export type BenchAction =
  | { kind: 'start' }
  | { kind: 'reset' }
  | { kind: 'act'; what: BenchActWhat }
  | { kind: 'step' }
  | { kind: 'capture'; name: string }

export const benchStore = {
  recorder: new BenchRecorder(),
  get: (): BenchState => state,
  set(change: Partial<BenchState>): void {
    state = { ...state, ...change }
    for (const l of listeners) l(state)
  },
  subscribe(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l) } },
  /** Ask the bench (the viewport side) to do something. */
  act(a: BenchAction): void { for (const f of actions) f(a) },
  onAction(f: (a: BenchAction) => void): () => void { actions.add(f); return () => { actions.delete(f) } },
}
