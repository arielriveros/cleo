import type { Conversation } from './terminalStore'

// What the Claude panel's conversation picker (ConversationPicker.tsx) shows of a saved conversation: where it
// was started, when it was last used, and which ones a search keeps. Pure, so the tests read it directly.

export type ConversationOrigin = 'panel' | 'ide' | 'terminal' | 'other'

/** Where a conversation was started: this panel, an IDE (VS Code), a terminal, or elsewhere (an app, the SDK). */
export function conversationOrigin(c: Pick<Conversation, 'hosted' | 'entrypoint'>): ConversationOrigin {
  if (c.hosted) return 'panel'
  if (c.entrypoint === 'claude-vscode' || c.entrypoint?.includes('ide')) return 'ide'
  if (c.entrypoint === 'cli') return 'terminal'
  return 'other'
}

export const ORIGIN_LABEL: Record<ConversationOrigin, string> = {
  panel: 'Started in this panel',
  ide: 'Started in VS Code',
  terminal: 'Started in a terminal',
  other: 'Started outside the editor',
}

const DAY = 86_400_000

function dayStart(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** When a conversation was last used, as the picker says it: "just now", "5 min ago", "yesterday", "Nov 12". */
export function whenLabel(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  const days = Math.round((dayStart(now) - dayStart(ms)) / DAY)
  if (days === 0) return `${Math.floor(s / 3600)} h ago`
  if (days === 1) return 'yesterday'
  const d = new Date(ms)
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' })
}

/** The conversations a search keeps: every word in its title, first prompt or branch, in any case. */
export function filterConversations(list: readonly Conversation[], query: string): Conversation[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...list]
  return list.filter(c => {
    const text = `${c.title}\n${c.prompt ?? ''}\n${c.branch ?? ''}`.toLowerCase()
    return words.every(w => text.includes(w))
  })
}
