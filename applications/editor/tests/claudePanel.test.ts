import { describe, expect, it } from 'vitest'
import { NEWLINE, sessionTitle, terminalKeyAction, type Conversation } from '../src/features/agentChat/terminalStore'
import { conversationOrigin, filterConversations, whenLabel } from '../src/features/agentChat/conversations'

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

  it('starts a new line on Shift+Enter and Shift+Space, and sends on a plain Enter', () => {
    expect(terminalKeyAction(key('Enter', { shiftKey: true }), false)).toBe('newline')
    expect(terminalKeyAction(key(' ', { shiftKey: true }), false)).toBe('newline')
    // The keypress the browser follows it with would type the Enter or the space as well.
    expect(terminalKeyAction(key('Enter', { shiftKey: true }, 'keypress'), false)).toBe('swallow')
    expect(terminalKeyAction(key(' ', { shiftKey: true }, 'keypress'), false)).toBe('swallow')
    expect(terminalKeyAction(key('Enter', { shiftKey: true }, 'keyup'), false)).toBe('pass')
    expect(terminalKeyAction(key('Enter'), false)).toBe('pass')
    expect(terminalKeyAction(key(' '), false)).toBe('pass')
    // Other modifiers keep their meaning in Claude Code (Alt+Enter is its own new line, Ctrl+Space is the program's).
    expect(terminalKeyAction(key('Enter', { shiftKey: true, altKey: true }), false)).toBe('pass')
    expect(terminalKeyAction(key(' ', { shiftKey: true, ctrlKey: true }), false)).toBe('pass')
    // A line feed (Ctrl+J): a new line in Claude Code's prompt, where a carriage return would send it.
    expect(NEWLINE).toBe('\n')
  })
})

// The header's picker: the conversations Claude Code saved for its folder.
describe('Claude Code conversations', () => {
  const conv = (over: Partial<Conversation>): Conversation => ({
    id: '01d36ca5-d040-4bda-a4bc-3ae9aea94ff4', title: 'Untitled', prompt: null, modifiedAt: 0, createdAt: null,
    entrypoint: 'cli', branch: null, hosted: false, livePid: null, ...over,
  })

  it('says where each was started', () => {
    expect(conversationOrigin(conv({ hosted: true, entrypoint: 'cli' }))).toBe('panel')
    expect(conversationOrigin(conv({ entrypoint: 'claude-vscode' }))).toBe('ide')
    expect(conversationOrigin(conv({ entrypoint: 'cli' }))).toBe('terminal')
    expect(conversationOrigin(conv({ entrypoint: 'sdk-ts' }))).toBe('other')
    expect(conversationOrigin(conv({ entrypoint: null }))).toBe('other')
  })

  it('says when each was last used', () => {
    const now = new Date(2026, 10, 23, 15, 0).getTime()
    expect(whenLabel(now - 20_000, now)).toBe('just now')
    expect(whenLabel(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(whenLabel(new Date(2026, 10, 23, 9, 30).getTime(), now)).toBe('5 h ago')
    expect(whenLabel(new Date(2026, 10, 22, 23, 50).getTime(), now)).toBe('yesterday')
    expect(whenLabel(new Date(2026, 10, 20, 12, 0).getTime(), now)).toBe(new Date(2026, 10, 20).toLocaleDateString(undefined, { weekday: 'long' }))
    expect(whenLabel(new Date(2026, 9, 2).getTime(), now)).toBe(new Date(2026, 9, 2).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
    expect(whenLabel(new Date(2025, 9, 2).getTime(), now)).toMatch(/2025/)
  })

  it('keeps what a search names, in its title, first prompt or branch', () => {
    const list = [
      conv({ id: 'a', title: 'Water shader fix', prompt: 'there is a webgpu texture error' }),
      conv({ id: 'b', title: 'Car simulation', branch: 'feature/sandbox-car' }),
      conv({ id: 'c', title: 'Mouse input' }),
    ]
    expect(filterConversations(list, '').map(c => c.id)).toEqual(['a', 'b', 'c'])
    expect(filterConversations(list, 'WEBGPU water').map(c => c.id)).toEqual(['a'])
    expect(filterConversations(list, 'sandbox').map(c => c.id)).toEqual(['b'])
    expect(filterConversations(list, 'water car')).toEqual([])
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
