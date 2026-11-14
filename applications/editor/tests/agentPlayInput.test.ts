import { describe, expect, it } from 'vitest'
import { DEFAULT_INPUT_MAP, type InputMap } from 'cleo'
import { formatTrace, planEnd, planInput, resolveAction, yawOf, type WatchSample } from '../src/features/agentBridge/playInput'
import { applyTextEdits } from '../src/features/agentBridge/textEdits'
import { cropRegion, fitSize } from '../src/features/agentBridge/capture'

// What play_control's `input` turns into (the DOM events, on one clock), what `watch` reads back as, and
// the pure halves of script patches and pane captures. The dispatch itself needs a page; this is the rest.

const map: InputMap = {
  ...DEFAULT_INPUT_MAP,
  maps: [{
    name: 'Gameplay', enabled: true, actions: [
      { name: 'Jump', kind: 'button', bindings: [{ id: 'j', source: { device: 'gamepad', button: 'south' } as any }, { id: 'k', source: { device: 'key', code: 'Space' } }] },
      { name: 'Fire', kind: 'button', bindings: [{ id: 'f', source: { device: 'mouse', button: 'left' } }] },
      { name: 'Move', kind: 'vector', bindings: [
        { id: 'w', source: { device: 'key', code: 'KeyW' }, part: 'up' },
        { id: 'd', source: { device: 'key', code: 'KeyD' }, part: 'right' },
      ] },
      { name: 'Aim', kind: 'vector', bindings: [{ id: 's', source: { device: 'gamepadAxis', axis: 'rightStickX' } as any }] },
    ],
  }],
}

describe('play input', () => {
  it('resolves an action to its first key or mouse binding, a part of a composite by name', () => {
    expect(resolveAction(map, 'Jump')).toEqual({ key: 'Space' })
    expect(resolveAction(map, 'jump')).toEqual({ key: 'Space' })
    expect(resolveAction(map, 'Fire')).toEqual({ mouse: 'left' })
    expect(resolveAction(map, 'Move.right')).toEqual({ key: 'KeyD' })
    expect(() => resolveAction(map, 'Dash')).toThrow(/No input action "Dash"\. Actions: Jump, Fire, Move, Aim/)
    expect(() => resolveAction(map, 'Move.down')).toThrow(/Its parts: Move\.up, Move\.right/)
    expect(() => resolveAction(map, 'Aim')).toThrow(/no key or mouse binding/)
  })

  it('plans presses and releases on one clock, releases first when they meet a press', () => {
    const steps = planInput([
      { at: 0.5, key: 'KeyW', hold: 1 },
      { at: 1.5, key: 'KeyW', hold: 0.5 },
      { at: 0.2, action: 'Jump' },
    ], map)
    expect(steps.map(s => `${s.t.toFixed(1)} ${s.kind} ${'code' in s ? s.code : ''}`)).toEqual([
      '0.2 keydown Space', '0.3 keyup Space', '0.5 keydown KeyW', '1.5 keyup KeyW', '1.5 keydown KeyW', '2.0 keyup KeyW',
    ])
    expect(planEnd(steps)).toBe(2)
  })

  it('spreads mouse movement over its hold, and a button with it is a drag', () => {
    const steps = planInput([{ at: 0, mouse: 'right', move: [90, -30], hold: 0.1 }], map)
    const moves = steps.filter(s => s.kind === 'mousemove') as { dx: number; dy: number }[]
    expect(moves.length).toBe(3)
    expect(moves.reduce((n, m) => n + m.dx, 0)).toBeCloseTo(90)
    expect(moves.reduce((n, m) => n + m.dy, 0)).toBeCloseTo(-30)
    expect(steps[0]).toMatchObject({ kind: 'mousedown', button: 2 })
    expect(steps.at(-1)).toMatchObject({ kind: 'mouseup', button: 2 })
  })

  it('refuses an input that asks for nothing, for two things, or names a key wrongly', () => {
    expect(() => planInput([{ at: 0 }], map)).toThrow(/input 1: says nothing/)
    expect(() => planInput([{ at: 0, key: 'KeyW', action: 'Jump' }], map)).toThrow(/one of key, action or mouse/)
    expect(() => planInput([{ at: 0, key: 'w' }], map)).toThrow(/not a KeyboardEvent\.code/)
  })

  it('traces a watched node as a summary and the rows that change', () => {
    const s = (t: number, z: number, grounded: boolean): WatchSample => ({ t, pos: [0, 1, z], yaw: 0, vel: [0, 0, z ? 4 : 0], grounded })
    const text = formatTrace('/Player', [s(0, 0, true), s(0.25, 0, true), s(0.5, 1, false), s(0.75, 2, true)])
    expect(text.split('\n')[0]).toBe('/Player: moved 2 m [0,1,0] -> [0,1,2]; yaw 0 -> 0; top speed 4 m/s; left the ground and landed')
    // The second sample repeats the first and is folded away.
    expect(text.split('\n').length).toBe(4)
    expect(formatTrace('/Gone', [])).toMatch(/no samples/)
  })

  it('reads a world yaw the way setWorldYaw takes it', () => {
    expect(yawOf([0, 0, 1])).toBeCloseTo(0)
    expect(yawOf([1, 0, 0])).toBeCloseTo(90)
    expect(yawOf([-1, 0, 0])).toBeCloseTo(-90)
  })
})

describe('script patches', () => {
  const src = 'export default class A extends Node {\n  speed = 1\n  onUpdate() { this.rotateY(this.speed) }\n}\n'

  it('replaces each old text found exactly once, in order', () => {
    const out = applyTextEdits(src, [{ old: 'speed = 1', new: 'speed = 2' }, { old: 'rotateY(this.speed)', new: 'rotateY(this.speed * 2)' }])
    expect(out).toContain('speed = 2')
    expect(out).toContain('this.speed * 2')
  })

  it('names a miss (and where its first line is) and an ambiguous match', () => {
    expect(() => applyTextEdits(src, [{ old: 'speed = 3', new: '' }])).toThrow(/edit 1: its old text is not in the script/)
    expect(() => applyTextEdits(src, [{ old: '  speed = 1\n  onUpdate() {}', new: '' }])).toThrow(/first line "speed = 1" is at line 2/)
    expect(() => applyTextEdits(src, [{ old: 'speed', new: 'pace' }])).toThrow(/found 2 times \(lines 2, 3\)/)
  })

  it('takes "$" in the new text literally', () => {
    expect(applyTextEdits('a', [{ old: 'a', new: '$&$1' }])).toBe('$&$1')
  })
})

describe('pane captures', () => {
  it('keeps the editing pane, clamped to the canvas, or the whole canvas without one', () => {
    expect(cropRegion(1600, 900, null)).toEqual({ x: 0, y: 0, w: 1600, h: 900 })
    expect(cropRegion(1600, 900, { x: 800, y: 0, w: 800, h: 450 })).toEqual({ x: 800, y: 0, w: 800, h: 450 })
    expect(cropRegion(1600, 900, { x: 800, y: 450, w: 900, h: 900 })).toEqual({ x: 800, y: 450, w: 800, h: 450 })
    expect(cropRegion(1600, 900, { x: 2000, y: 0, w: 10, h: 10 })).toEqual({ x: 0, y: 0, w: 1600, h: 900 })
  })

  it('scales down to the longest side, never up', () => {
    expect(fitSize(1600, 900, 800)).toEqual({ width: 800, height: 450 })
    expect(fitSize(400, 300, 1024)).toEqual({ width: 400, height: 300 })
  })
})
