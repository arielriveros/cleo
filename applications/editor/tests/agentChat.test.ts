import { describe, expect, it } from 'vitest'
import { reduceEvent, type ChatItem } from '../src/features/agentChat/chatStore'

// The chat panel rebuilds its transcript from the agent host's events (applications/mcp/src/chat.mjs), live
// and from a replay after a reload, so the reduction is what decides what the user sees.

const run = (events: any[]) => events.reduce((s, ev) => reduceEvent(s, ev), { items: [] as ChatItem[], permissions: [] as any[] })

describe('chat transcript', () => {
  it('streams text into one assistant item and fills tool cards as they run', () => {
    const t = run([
      { kind: 'user', text: 'add a cube' },
      { kind: 'assistant-start', messageId: 'm1' },
      { kind: 'block-start', messageId: 'm1', index: 0, block: 'text' },
      { kind: 'delta', messageId: 'm1', index: 0, text: 'On ' },
      { kind: 'delta', messageId: 'm1', index: 0, text: 'it.' },
      { kind: 'block-start', messageId: 'm1', index: 1, block: 'tool', toolUseId: 't1', name: 'scene_edit' },
      { kind: 'tool-input', toolUseId: 't1', name: 'scene_edit', input: { ops: [{ op: 'create', type: 'cube' }] } },
      { kind: 'tool-result', toolUseId: 't1', isError: false, text: '1 op applied', images: [{ data: 'AA', mimeType: 'image/jpeg' }] },
      { kind: 'turn-end', costUsd: 0.01, durationMs: 1200, isError: false, error: null },
    ])
    expect(t.items.map(i => i.kind)).toEqual(['user', 'assistant', 'turn'])
    const a = t.items[1] as Extract<ChatItem, { kind: 'assistant' }>
    expect(a.blocks[0]).toMatchObject({ type: 'text', text: 'On it.' })
    expect(a.blocks[1]).toMatchObject({ type: 'tool', status: 'done', input: { ops: [{ op: 'create', type: 'cube' }] }, result: { text: '1 op applied' } })
  })

  it('marks a tool waiting while its permission is pending, and running once answered', () => {
    let t = run([
      { kind: 'block-start', messageId: 'm', index: 0, block: 'tool', toolUseId: 't', name: 'execute_js' },
      { kind: 'permission', requestId: 'p1', toolUseId: 't', tool: 'execute_js', input: { code: 'return 1' }, canAlways: false },
    ])
    expect(t.permissions).toHaveLength(1)
    expect((t.items[0] as any).blocks[0].status).toBe('waiting')
    t = reduceEvent(t, { kind: 'permission-resolved', requestId: 'p1', allow: true })
    expect(t.permissions).toHaveLength(0)
    expect((t.items[0] as any).blocks[0].status).toBe('running')
  })

  it('closes what an interrupted turn left running', () => {
    const t = run([
      { kind: 'block-start', messageId: 'm', index: 0, block: 'tool', toolUseId: 't', name: 'play_control' },
      { kind: 'permission', requestId: 'p', toolUseId: 't', tool: 'play_control', input: {}, canAlways: true },
      { kind: 'turn-end', costUsd: 0, durationMs: 10, isError: true, error: 'interrupted' },
    ])
    expect((t.items[0] as any).blocks[0].status).toBe('error')
    expect(t.permissions).toHaveLength(0)
  })

  it('is idempotent about repeated block starts (a replay after a live stream)', () => {
    const t = run([
      { kind: 'block-start', messageId: 'm', index: 0, block: 'text' },
      { kind: 'block-start', messageId: 'm', index: 0, block: 'text' },
      { kind: 'delta', messageId: 'm', index: 0, text: 'x' },
    ])
    expect((t.items[0] as any).blocks).toHaveLength(1)
  })

  it('shows errors and notes as notices', () => {
    const t = run([{ kind: 'error', message: 'Invalid API key' }, { kind: 'info', message: 'Stopped.' }])
    expect(t.items).toMatchObject([{ kind: 'notice', tone: 'error', text: 'Invalid API key' }, { kind: 'notice', tone: 'info' }])
  })
})
