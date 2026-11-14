import { describe, expect, it } from 'vitest'
import { sessionTitle, terminalKeyAction } from '../src/features/agentChat/terminalStore'

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

// The header shows what the session is about, from the title Claude Code gives its terminal.
describe('Claude Code session title', () => {
  it('drops the state glyph in front of the summary', () => {
    expect(sessionTitle('✳ Build a cube player')).toBe('Build a cube player')
    expect(sessionTitle('⠂ Fix the door script')).toBe('Fix the door script')
    expect(sessionTitle('3D scene review')).toBe('3D scene review')
  })

  it('names no task until Claude Code has one', () => {
    expect(sessionTitle('✳ Claude Code')).toBeNull()
    expect(sessionTitle('claude')).toBeNull()
    expect(sessionTitle('')).toBeNull()
    // What the Windows console host titles it with before Claude Code starts.
    expect(sessionTitle('C:\\users\\me\\.local\\bin\\claude.exe')).toBeNull()
    expect(sessionTitle('/usr/local/bin/claude')).toBeNull()
  })
})
