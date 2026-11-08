import { describe, expect, it } from 'vitest'
import { terminalKeyAction } from '../src/features/agentChat/terminalStore'

// The Claude panel's terminal (Claude Code hosted by the agent host) keeps the editor's copy and paste habits
// without taking keys the program needs: Ctrl+C is its interrupt unless there is something selected to copy.
describe('Claude Code terminal keys', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}, type = 'keydown') =>
    ({ type, key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

  it('copies on Ctrl+C only with a selection, or on Ctrl+Shift+C', () => {
    expect(terminalKeyAction(key('c', { ctrlKey: true }), true)).toBe('copy')
    expect(terminalKeyAction(key('c', { ctrlKey: true }), false)).toBe('pass')
    expect(terminalKeyAction(key('C', { ctrlKey: true, shiftKey: true }), false)).toBe('copy')
    expect(terminalKeyAction(key('c', { metaKey: true }), true)).toBe('copy')
  })

  it('leaves pastes to the browser and every other key to the program', () => {
    expect(terminalKeyAction(key('v', { ctrlKey: true }), false)).toBe('paste')
    expect(terminalKeyAction(key('Insert', { shiftKey: true }), false)).toBe('paste')
    expect(terminalKeyAction(key('v', { altKey: true }), false)).toBe('pass') // Claude Code's image paste
    expect(terminalKeyAction(key('Escape'), false)).toBe('pass')
    expect(terminalKeyAction(key('c', { ctrlKey: true }, 'keyup'), true)).toBe('pass')
  })
})
