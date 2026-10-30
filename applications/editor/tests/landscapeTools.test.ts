import { describe, it, expect, beforeEach } from 'vitest'
import { SCULPT_TOOLS, PAINT_TOOLS, MODES, toolForHotkey, modeForHotkey } from '../src/features/landscape/landscapeTools'
import {
  getBrush, setBrush, activeStrength, setActiveStrength, strengthSpec, resetBrushForTests, subscribeBrush,
} from '../src/features/landscape/landscapeBrushStore'

// The landscape tool catalog and brush store: every sculpt tool the engine offers is reachable, no two
// tools in a mode share a key, and strength is remembered per tool.

describe('landscape tool catalog', () => {
  it('offers every engine sculpt tool', () => {
    expect(SCULPT_TOOLS.map(t => t.id).sort()).toEqual(
      ['erode', 'flatten', 'hydro', 'lower', 'noise', 'raise', 'ramp', 'setHeight', 'smooth', 'stamp', 'terrace'])
  })

  it('no two tools in a mode share a hotkey, and the modes do not collide with the tools', () => {
    for (const list of [SCULPT_TOOLS, PAINT_TOOLS]) {
      const keys = list.map(t => t.hotkey).filter(Boolean)
      expect(new Set(keys).size).toBe(keys.length)
    }
    const modeKeys = MODES.map(m => m.hotkey.toLowerCase())
    expect(new Set(modeKeys).size).toBe(modeKeys.length)
    for (const t of [...SCULPT_TOOLS, ...PAINT_TOOLS]) if (t.hotkey) expect(modeKeys).not.toContain(t.hotkey.toLowerCase())
  })

  it('resolves hotkeys per mode', () => {
    expect(toolForHotkey('sculpt', '3')).toBe('smooth')
    expect(toolForHotkey('paint', '2')).toBe('erase')
    expect(toolForHotkey('foliage', '1')).toBeUndefined()
    expect(modeForHotkey('w')).toBe('paint')
  })
})

describe('landscape brush store', () => {
  beforeEach(() => resetBrushForTests())

  it('remembers strength per tool', () => {
    setBrush({ mode: 'sculpt', sculptTool: 'raise' })
    setActiveStrength(20)
    setBrush({ sculptTool: 'smooth' })
    expect(activeStrength()).toBe(strengthSpec('smooth').initial)
    setActiveStrength(0.9)
    setBrush({ sculptTool: 'raise' })
    expect(activeStrength()).toBe(20)
  })

  it('clamps strength to the tool range', () => {
    setBrush({ mode: 'paint', paintTool: 'paint' })
    setActiveStrength(99)
    expect(activeStrength()).toBe(strengthSpec('paint').max)
  })

  it('does not notify on a no-op patch, and replaces the snapshot on a real one', () => {
    let calls = 0
    const off = subscribeBrush(() => calls++)
    const before = getBrush()
    setBrush({ radius: before.radius })
    expect(calls).toBe(0)
    setBrush({ radius: before.radius + 1 })
    expect(calls).toBe(1)
    expect(getBrush()).not.toBe(before)
    off()
  })
})
