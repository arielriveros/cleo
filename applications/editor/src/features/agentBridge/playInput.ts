import type { InputMap } from 'cleo'
import { round } from './inspect'

// Input an agent feeds a running game, and what it reads back. Pure: the plan (every press, release and
// mouse move on one clock) and the trace (sampled numbers as text) are worked out here and unit-tested;
// play.ts dispatches the steps as DOM events and takes the samples.

/** One input of play_control `input`, as the tool takes it. */
export interface AgentInput {
  at: number
  key?: string
  action?: string
  mouse?: 'left' | 'right' | 'middle'
  hold?: number
  move?: number[]
  wheel?: number
}

export type InputStep =
  | { t: number; kind: 'keydown' | 'keyup'; code: string }
  | { t: number; kind: 'mousedown' | 'mouseup'; button: number }
  | { t: number; kind: 'mousemove'; dx: number; dy: number }
  | { t: number; kind: 'wheel'; dy: number }

/** MouseEvent.button for each of the sampler's buttons (DeviceSampler maps them back by index). */
const MOUSE_INDEX: Record<string, number> = { left: 0, middle: 1, right: 2, back: 3, forward: 4 }

/** A held input with no `hold` lasts one tenth of a second: long enough for a frame to see it. */
export const DEFAULT_HOLD = 0.1
/** Mouse movement is spread over its hold in steps of this many seconds (a 30 Hz mouse). */
const MOVE_STEP = 1 / 30

/**
 * A project action's first key or mouse binding: what pressing it means for an agent with no gamepad.
 * `Move.up` names one part of a composite action (up/down/left/right, positive/negative).
 */
export function resolveAction(map: InputMap, name: string): { key?: string; mouse?: string } {
  const [actionName, part] = name.split('.')
  const all = map.maps.flatMap(m => m.actions)
  const action = all.find(a => a.name === actionName) ?? all.find(a => a.name.toLowerCase() === actionName.toLowerCase())
  if (!action) throw new Error(`No input action "${actionName}". Actions: ${all.map(a => a.name).join(', ') || 'none'}.`)
  const usable = action.bindings.filter(b => b.source.device === 'key' || (b.source.device === 'mouse' && MOUSE_INDEX[b.source.button] !== undefined))
  const hit = usable.find(b => !part || b.part === part)
  if (!hit) {
    const parts = [...new Set(usable.map(b => b.part).filter(Boolean))]
    throw new Error(`Action "${action.name}" has no key or mouse binding${part ? ` for "${part}"` : ''}.`
      + (parts.length ? ` Its parts: ${parts.map(p => `${action.name}.${p}`).join(', ')}.` : ' Use key instead.'))
  }
  return hit.source.device === 'key' ? { key: hit.source.code } : { mouse: (hit.source as { button: string }).button }
}

/** The order of steps that share a moment: let go first, so a release and a re-press at t both happen. */
const RANK: Record<InputStep['kind'], number> = { keyup: 0, mouseup: 0, keydown: 1, mousedown: 1, mousemove: 2, wheel: 2 }

/**
 * Every DOM event the inputs make, in time order. An `action` becomes its binding (resolveAction); a key or
 * button is pressed at `at` and let go `hold` later; a `move` is spread over its hold (a drag when it comes
 * with a button). Throws, naming the input, for one that asks for nothing or for two things at once.
 */
export function planInput(events: readonly AgentInput[], map: InputMap): InputStep[] {
  const steps: InputStep[] = []
  events.forEach((e, i) => {
    const what = `input ${i + 1}`
    const hold = Math.max(0, e.hold ?? DEFAULT_HOLD)
    let key = e.key
    let mouse: string | undefined = e.mouse
    if (e.action) {
      if (key || mouse) throw new Error(`${what}: give one of key, action or mouse.`)
      const bound = resolveAction(map, e.action)
      key = bound.key
      mouse = bound.mouse
    }
    if (key && mouse) throw new Error(`${what}: give one of key, action or mouse.`)
    if (!key && !mouse && !e.move && e.wheel === undefined) throw new Error(`${what}: says nothing to press, move or scroll.`)
    if (key) {
      if (!/^[A-Z][A-Za-z0-9]+$/.test(key))
        throw new Error(`${what}: "${key}" is not a KeyboardEvent.code (e.g. "KeyW", "Space", "ArrowUp", "ShiftLeft", "Digit1").`)
      steps.push({ t: e.at, kind: 'keydown', code: key }, { t: e.at + hold, kind: 'keyup', code: key })
    }
    if (mouse) {
      const button = MOUSE_INDEX[mouse]
      steps.push({ t: e.at, kind: 'mousedown', button }, { t: e.at + hold, kind: 'mouseup', button })
    }
    if (e.move) {
      const n = Math.max(1, Math.round(hold / MOVE_STEP))
      for (let s = 0; s < n; s++)
        steps.push({ t: e.at + (hold * s) / n, kind: 'mousemove', dx: e.move[0] / n, dy: e.move[1] / n })
    }
    if (e.wheel !== undefined) steps.push({ t: e.at, kind: 'wheel', dy: e.wheel })
  })
  return steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.t - b.s.t || RANK[a.s.kind] - RANK[b.s.kind] || a.i - b.i)
    .map(x => x.s)
}

/** When the last step happens, in seconds (0 for none). */
export function planEnd(steps: readonly InputStep[]): number {
  return steps.reduce((m, s) => Math.max(m, s.t), 0)
}

/** One look at a watched node during a run. */
export interface WatchSample {
  t: number
  pos: number[]
  yaw: number
  vel?: number[]
  grounded?: boolean
  state?: string | null
  props?: Record<string, unknown>
}

const fmtVec = (v: readonly number[]) => `[${v.map(x => round(x, 2)).join(',')}]`
const fmtValue = (v: unknown) => (Array.isArray(v) ? fmtVec(v as number[]) : typeof v === 'number' ? String(round(v, 3)) : JSON.stringify(v))

/**
 * A watched node's samples as compact text: a summary line (how far it moved, its top speed, whether it
 * left the ground) and one row per sample. Rows that change nothing from the one before are folded.
 */
export function formatTrace(path: string, samples: readonly WatchSample[]): string {
  if (!samples.length) return `${path}: no samples (the node was not in the running game).`
  const first = samples[0], last = samples[samples.length - 1]
  const moved = Math.hypot(...last.pos.map((x, i) => x - first.pos[i]))
  const speeds = samples.map(s => s.vel ? Math.hypot(...s.vel) : 0)
  const air = samples.some(s => s.grounded === false), ground = samples.some(s => s.grounded === true)
  const summary = [
    `moved ${round(moved, 2)} m ${fmtVec(first.pos)} -> ${fmtVec(last.pos)}`,
    `yaw ${round(first.yaw, 1)} -> ${round(last.yaw, 1)}`,
    samples.some(s => s.vel) ? `top speed ${round(Math.max(...speeds), 2)} m/s` : null,
    air && ground ? 'left the ground and landed' : air ? 'airborne throughout' : ground ? 'grounded throughout' : null,
  ].filter(Boolean).join('; ')
  const rows: string[] = []
  let prev = ''
  for (const s of samples) {
    const cells = [
      `pos=${fmtVec(s.pos)}`, `yaw=${round(s.yaw, 1)}`,
      s.vel ? `vel=${fmtVec(s.vel)}` : '',
      s.grounded === undefined ? '' : s.grounded ? 'grounded' : 'air',
      s.state ? `state=${s.state}` : '',
      ...Object.entries(s.props ?? {}).map(([k, v]) => `${k}=${fmtValue(v)}`),
    ].filter(Boolean).join(' ')
    if (cells === prev) continue
    prev = cells
    rows.push(`  t=${round(s.t, 2)} ${cells}`)
  }
  return `${path}: ${summary}\n${rows.join('\n')}`
}

/** The world yaw a forward vector faces, in degrees (0 = +Z, 90 = +X), as setWorldYaw takes it. */
export function yawOf(forward: ArrayLike<number>): number {
  return (Math.atan2(forward[0], forward[2]) * 180) / Math.PI
}
