import * as cleo from 'cleo'
import type { Node, Scene } from 'cleo'
import { isWindowPlayActive, windowPlay } from '../playWindow/windowPlay'
import { readPlayTarget } from '../playWindow/playTarget'
import { CancelledError, ready, refIn, sleep, throwIfAborted, until, vec, type BridgeHost, type CommandResult, type GetHost } from './bridgeHost'
import { formatLogs, logCursor, readLogs } from './agentLogs'
import { nodePath } from './nodeRefs'
import { simpleValue } from './inspect'
import { formatTrace, planEnd, planInput, yawOf, type InputStep, type WatchSample } from './playInput'
import { withCapture } from './shots'

// play_control: Play, Simulate, a run of a game already going, pause, stop. A run lasts `runSeconds` (or
// until its last input is let go), returns early on the first error, and can drive the player with input
// and sample nodes as numbers, so one call is a test. The game always runs in the EDITOR: a game in its own
// window (Play target "Window") has no scene, camera or state this side can read, only a stop and a pause.

/** How often a watched node is sampled, in seconds, and how many samples one node keeps. */
const SAMPLE_EVERY = 0.25
const MAX_SAMPLES = 40

interface Watch { path: string; node: Node; props: string[]; samples: WatchSample[] }

/** The game window's state, when one is running; never creates the controller just to ask. */
function windowSession() {
  return isWindowPlayActive() ? windowPlay().getSnapshot() : null
}

function playState(getHost: GetHost): string {
  const e = getHost().engine
  if (e.isPlayMode) return `${e.isSimulating ? 'simulate' : 'play'}${e.instance?.isPaused ? ' (paused)' : ''}`
  const win = windowSession()
  return win ? `editing; a game is running in its own window (${win.status}${win.scene ? `, scene "${win.scene}"` : ''})` : 'editing'
}

/** The `key` a KeyboardEvent carries for a code, for scripts that read it: "KeyW" -> "w", "Digit1" -> "1". */
function keyOf(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (code === 'Space') return ' '
  return code
}

/** Plays a plan into the page as the sampler sees it: keys on the window, the mouse on the render canvas. */
class InputDriver {
  private keys = new Set<string>()
  private buttons = new Set<number>()
  private next = 0
  constructor(private steps: InputStep[], private canvas: HTMLCanvasElement) {}

  /** Dispatch every step due by `t` seconds. */
  advance(t: number) {
    while (this.next < this.steps.length && this.steps[this.next].t <= t) this.dispatch(this.steps[this.next++])
  }

  get pending(): number { return this.steps.length - this.next }

  private dispatch(s: InputStep) {
    const rect = this.canvas.getBoundingClientRect()
    const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }
    switch (s.kind) {
      case 'keydown':
      case 'keyup':
        if (s.kind === 'keydown') this.keys.add(s.code); else this.keys.delete(s.code)
        window.dispatchEvent(new KeyboardEvent(s.kind, { code: s.code, key: keyOf(s.code), bubbles: true, cancelable: true }))
        break
      case 'mousedown':
        this.buttons.add(s.button)
        this.canvas.dispatchEvent(new MouseEvent('mousedown', { ...at, button: s.button, buttons: 1 << s.button }))
        break
      case 'mouseup':
        this.buttons.delete(s.button)
        window.dispatchEvent(new MouseEvent('mouseup', { ...at, button: s.button }))
        break
      case 'mousemove':
        this.canvas.dispatchEvent(new MouseEvent('mousemove', { ...at, movementX: s.dx, movementY: s.dy } as MouseEventInit))
        break
      case 'wheel':
        this.canvas.dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: s.dy }))
        break
    }
  }

  /** Let go of everything still held: a run never leaves a key down behind it. */
  releaseAll() {
    for (const code of this.keys) window.dispatchEvent(new KeyboardEvent('keyup', { code, key: keyOf(code), bubbles: true }))
    for (const button of this.buttons) window.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true }))
    this.keys.clear()
    this.buttons.clear()
    this.next = this.steps.length
  }
}

/** The animation state a node (or the first model under it) is in, if it runs a state machine. */
function animState(node: Node): string | null {
  const stack: Node[] = [node]
  for (let i = 0; i < stack.length && i < 64; i++) {
    const n = stack[i] as any
    const name = n.animator?.currentStateName
    if (typeof name === 'string') return name
    if (n instanceof cleo.AnimatedSpriteNode) return n.state ?? n.clip
    stack.push(...n.children)
  }
  return null
}

function sample(w: Watch, t: number): WatchSample {
  const n = w.node as any
  const body = n.body ?? n.character?.body
  const s: WatchSample = { t, pos: vec(n.worldPosition), yaw: yawOf(n.worldForward) }
  if (n instanceof cleo.CharacterBody2DNode) {
    s.vel = Array.from(n.velocity2D as ArrayLike<number>)
    s.grounded = n.isGrounded
  } else if (n instanceof cleo.Body2DNode) {
    s.grounded = n.grounded
  } else if (body) {
    s.vel = vec(n.velocity)
    s.grounded = !!n.isGrounded
  }
  s.state = animState(w.node)
  if (w.props.length) {
    s.props = {}
    for (const p of w.props) {
      let v: unknown
      try { v = p.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), n) } catch { v = undefined }
      s.props[p] = simpleValue(v) ?? (v === undefined ? 'undefined' : String(v))
    }
  }
  return s
}

/** The watch list resolved in the running game; refs that miss are notes, not failures (the game started). */
function resolveWatch(h: BridgeHost, scene: Scene, list: unknown[] | undefined): { watches: Watch[]; notes: string[] } {
  const watches: Watch[] = []
  const notes: string[] = []
  for (const item of list ?? []) {
    const ref = typeof item === 'string' ? item : (item as any).node
    const props = typeof item === 'string' ? [] : ((item as any).props ?? [])
    try {
      const node = refIn(h, scene, ref, undefined, null)
      watches.push({ path: nodePath(node, scene.root), node, props, samples: [] })
    } catch (err) { notes.push(`watch ${ref}: ${err instanceof Error ? err.message : String(err)}`) }
  }
  return { watches, notes }
}

/** Keep the running game going: input, samples, logs; early on the first error; then capture and stop. */
async function run(getHost: GetHost, p: any, steps: InputStep[], cursor: number, signal?: AbortSignal): Promise<CommandResult> {
  const h = getHost()
  const engine = h.engine.instance!
  const length = Math.max(p.runSeconds ?? 1.5, steps.length ? planEnd(steps) + 0.3 : 0)
  const { watches, notes } = resolveWatch(h, engine.scene, p.watch)
  const driver = new InputDriver(steps, engine.renderer.canvas)
  const started = performance.now()
  let nextSample = 0
  let errorAt = 0
  let cancelled = false
  try {
    for (;;) {
      throwIfAborted(signal)
      const t = (performance.now() - started) / 1000
      driver.advance(t)
      if (t >= nextSample) {
        for (const w of watches) if (w.samples.length < MAX_SAMPLES) w.samples.push(sample(w, t))
        nextSample += SAMPLE_EVERY
      }
      if (t >= length) break
      // A first error usually explains the run: answer with it (and what follows within 300 ms) now.
      if (!errorAt && readLogs({ since: cursor, level: 'error', limit: 1 }).length) errorAt = performance.now()
      if (errorAt && performance.now() - errorAt >= 300) break
      if (!getHost().engine.isPlayMode) break
      await sleep(steps.length && driver.pending ? 8 : 50)
    }
  } catch (err) {
    if (!(err instanceof CancelledError)) throw err
    cancelled = true
  } finally {
    driver.releaseAll()
  }
  const ran = ((performance.now() - started) / 1000).toFixed(1)
  if (getHost().engine.isPlayMode) for (const w of watches) w.samples.push(sample(w, (performance.now() - started) / 1000))

  const entries = readLogs({ since: cursor, limit: 500 })
  const errors = entries.filter(e => e.level === 'error').length
  const lines = [
    `State: ${playState(getHost)}. Ran ${ran} s${cancelled ? ' (cancelled)' : errorAt ? ' (returned early: an error was logged)' : ''}.`
      + (steps.length ? ` ${steps.length} input event${steps.length === 1 ? '' : 's'} sent.` : ''),
    `${entries.length} new log entr${entries.length === 1 ? 'y' : 'ies'}${errors ? ` (${errors} error${errors === 1 ? '' : 's'})` : ''}:`,
    formatLogs(entries, { maxLines: 40 }) || '(none)',
    ...watches.map(w => formatTrace(w.path, w.samples)),
    ...notes,
    `cursor: ${logCursor()}`,
  ]
  let result: CommandResult = { text: lines.join('\n'), isError: false }
  if (!cancelled) result = await withCapture(result, p.capture, getHost, undefined, signal)
  if (p.stopAfter || cancelled) {
    if (getHost().engine.isPlayMode) {
      getHost().engine.stopPlay()
      await until(() => !getHost().engine.isPlayMode, 20000, 'the game to stop')
    }
    result = { ...result, text: `${result.text}\nStopped; back to editing.` }
  }
  return result
}

export async function playControl(p: any, getHost: GetHost, signal?: AbortSignal): Promise<CommandResult> {
  const h = ready(getHost)
  const win = windowSession()
  switch (p.action) {
    case 'status':
      return {
        text: `State: ${playState(getHost)}. Play target: ${readPlayTarget()} (play_control always plays in the editor). `
          + `${win ? 'The window game\'s logs arrive scoped "Game/<scope>"; play_control stop or pause reach it. ' : ''}Log cursor: ${logCursor()}.`,
      }
    case 'play':
    case 'simulate': {
      if (win) throw new Error(`A game is running in its own window (${win.status}): stop it first with play_control {"action":"stop"}.`)
      if (h.engine.isPlayMode) return { text: `Already running (${playState(getHost)}). Use run to keep it going, or stop first to restart.` }
      if (p.input?.length && p.action === 'simulate')
        throw new Error('input drives the player, and Simulate possesses none (its Gameplay input is off): use play.')
      // Checked before the game starts: a bad key or an unknown action costs no run.
      const steps = planInput(p.input ?? [], h.engine.inputMap)
      const cursor = logCursor()
      if (p.action === 'play') h.engine.startPlay(); else h.engine.startSimulate()
      await until(() => getHost().engine.isPlayMode, 20000, 'the game to start', signal)
      return run(getHost, p, steps, cursor, signal)
    }
    case 'run': {
      if (!h.engine.isPlayMode) throw new Error(`Nothing is running in the editor (${playState(getHost)}): play or simulate first.`)
      if (p.input?.length && h.engine.isSimulating)
        throw new Error('input drives the player, and Simulate possesses none (its Gameplay input is off): stop and play.')
      // A paused game resumes: starting the session it is already in un-pauses it (SET_PLAY_STATE).
      if (h.engine.instance?.isPaused) { if (h.engine.isSimulating) h.engine.startSimulate(); else h.engine.startPlay() }
      const steps = planInput(p.input ?? [], h.engine.inputMap)
      return run(getHost, p, steps, logCursor(), signal)
    }
    case 'pause':
      if (win) {
        if (win.status === 'paused') windowPlay().resume(); else windowPlay().pause()
        await sleep(150)
        return { text: `State: ${playState(getHost)}.` }
      }
      if (!h.engine.isPlayMode) return { text: 'Not running.' }
      h.engine.pausePlay()
      await sleep(100)
      return { text: `State: ${playState(getHost)}.` }
    case 'stop':
      if (win) {
        windowPlay().stop()
        await until(() => !isWindowPlayActive(), 15000, 'the game window to close', signal)
        return { text: 'Stopped the game running in its own window.' }
      }
      if (!h.engine.isPlayMode) return { text: 'Already editing.' }
      h.engine.stopPlay()
      await until(() => !getHost().engine.isPlayMode, 20000, 'the game to stop', signal)
      return { text: 'Stopped; back to editing. Anything changed during play was discarded.' }
    default:
      throw new Error(`Unknown action ${JSON.stringify(p.action)}.`)
  }
}

export { playState }
