import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@cleo/app-kit/ui/Button'
import { controlClass, Select } from '@cleo/app-kit/ui/inputs'
import { cn } from '@cleo/app-kit/ui/cn'
import { useCleoEngine } from '../EngineContext'
import { nodePath } from '../agentBridge/nodeRefs'
import ChatMarkdown from './ChatMarkdown'
import { chatActions, chatStore, CHAT_MIN_WIDTH, type ChatBlock, type ChatItem, type PermissionRequest } from './chatStore'
import { ChatIcon, ChevronIcon, HistoryIcon, KeyIcon, NewChatIcon, SendIcon, StopIcon, ToolIcon } from './chatIcons'

// The Claude chat, docked at the right edge of the editor (like an IDE's assistant panel). It talks to the
// agent host's chat manager (applications/mcp/src/chat.mjs) over the agent bridge; Claude acts on the
// project through the same tools the MCP server offers, and each of its edits is one undo step.

const TOOL_LABEL: Record<string, string> = {
  editor_status: 'Check the editor', scene_tree: 'Read the scene tree', node_get: 'Inspect a node',
  scene_edit: 'Edit the scene', script_write: 'Write a script', script_read: 'Read a script',
  material_write: 'Write a material', asset_list: 'List assets', view_capture: 'Look at the viewport',
  logs_read: 'Read the console', play_control: 'Play control', history: 'Undo / redo', scene_save: 'Save',
  execute_js: 'Run code in the editor',
}

const SUGGESTIONS = [
  'Add a ground plane, a sun and three coloured cubes, then show me.',
  'Make the selected node spin slowly and bob up and down.',
  'Play the game for a few seconds and tell me about any errors.',
]

const toolLabel = (name: string) => TOOL_LABEL[name] ?? name

/** One line saying what a tool call is about, from its input. */
function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  switch (name) {
    case 'scene_edit': {
      const ops: any[] = Array.isArray(input.ops) ? input.ops : []
      const head = ops.slice(0, 3).map(o => o.op === 'create'
        ? `create ${o.type ?? o.template ?? o.model ?? ''}${o.name ? ` "${o.name}"` : ''}`
        : `${o.op} ${o.node ?? ''}`).join(', ')
      return `${ops.length} op${ops.length === 1 ? '' : 's'}: ${head}${ops.length > 3 ? ', …' : ''}`
    }
    case 'script_write': return `"${input.name}"${input.attach?.length ? ` on ${input.attach.join(', ')}` : ''}`
    case 'script_read': case 'material_write': return `"${input.name}"`
    case 'node_get': return String(input.node ?? '')
    case 'scene_tree': return input.name ? `search "${input.name}"` : input.type ? `type ${input.type}` : input.root ? String(input.root) : ''
    case 'view_capture': return input.focus ? `framing ${input.focus}` : ''
    case 'play_control': return `${input.action}${input.runSeconds ? ` for ${input.runSeconds} s` : ''}`
    case 'history': return `${input.action}${input.steps ? ` ${input.steps}` : ''}`
    case 'execute_js': return String(input.code ?? '').split('\n')[0].slice(0, 80)
    case 'asset_list': return input.kind ?? input.query ?? ''
    case 'logs_read': return input.level ?? ''
    default: return ''
  }
}

function ToolDetails({ name, input }: { name: string; input: any }) {
  if (name === 'script_write' && typeof input?.source === 'string') {
    return <pre className='m-0 p-2 rounded bg-surface-sunken font-mono text-ui-sm text-fg overflow-auto max-h-64 whitespace-pre'>{input.source}</pre>
  }
  if (name === 'execute_js' && typeof input?.code === 'string') {
    return <pre className='m-0 p-2 rounded bg-surface-sunken font-mono text-ui-sm text-fg overflow-auto max-h-64 whitespace-pre'>{input.code}</pre>
  }
  const json = JSON.stringify(input ?? {}, null, 1)
  return <pre className='m-0 p-2 rounded bg-surface-sunken font-mono text-ui-xs text-muted overflow-auto max-h-48 whitespace-pre-wrap break-all'>{json.length > 4000 ? `${json.slice(0, 4000)}…` : json}</pre>
}

const STATUS_DOT: Record<string, string> = {
  running: 'bg-highlight animate-pulse', waiting: 'bg-warning animate-pulse', done: 'bg-success', error: 'bg-danger',
}

function ToolCard({ block }: { block: Extract<ChatBlock, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const summary = toolSummary(block.name, block.input)
  const images = block.result?.images ?? []
  return (
    <div className='rounded border border-border-subtle bg-surface-raised/60'>
      <button type='button' onClick={() => setOpen(v => !v)}
        className='flex items-center gap-1.5 w-full px-2 py-1 text-left text-ui-sm text-muted hover:text-fg'>
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', STATUS_DOT[block.status])} />
        <span className='w-3.5 h-3.5 shrink-0'><ToolIcon /></span>
        <span className='text-fg shrink-0'>{toolLabel(block.name)}</span>
        {summary && <span className='truncate text-dim'>{summary}</span>}
        {block.status === 'waiting' && <span className='ml-auto shrink-0 text-warning'>waiting for you</span>}
        <span className={cn('w-3 h-3 shrink-0 transition-transform', block.status !== 'waiting' && 'ml-auto', open && 'rotate-90')}><ChevronIcon /></span>
      </button>
      {images.length > 0 && (
        <div className='px-2 pb-2 flex flex-col gap-1'>
          {images.map((im, i) => <img key={i} src={`data:${im.mimeType};base64,${im.data}`} alt='Viewport capture' className='w-full rounded border border-border-subtle' />)}
        </div>
      )}
      {open && (
        <div className='px-2 pb-2 flex flex-col gap-1.5'>
          <ToolDetails name={block.name} input={block.input} />
          {block.result?.text && (
            <pre className={cn('m-0 p-2 rounded bg-surface-sunken font-mono text-ui-xs overflow-auto max-h-64 whitespace-pre-wrap break-words',
              block.status === 'error' ? 'text-danger-fg' : 'text-muted')}>{block.result.text}</pre>
          )}
        </div>
      )}
    </div>
  )
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return live ? <div className='text-ui-sm text-dim italic'>Thinking…</div> : null
  return (
    <div className='text-ui-sm text-dim'>
      <button type='button' onClick={() => setOpen(v => !v)} className='flex items-center gap-1 hover:text-muted'>
        <span className={cn('w-3 h-3 transition-transform', open && 'rotate-90')}><ChevronIcon /></span>
        <span className='italic'>{live ? 'Thinking…' : 'Thought'}</span>
      </button>
      {open && <div className='mt-1 pl-4 border-l border-border-subtle whitespace-pre-wrap'>{text}</div>}
    </div>
  )
}

function Item({ item, live }: { item: ChatItem; live: boolean }) {
  switch (item.kind) {
    case 'user':
      return <div className='self-end max-w-[90%] px-2.5 py-1.5 rounded-lg bg-control text-fg whitespace-pre-wrap break-words'>{item.text}</div>
    case 'assistant':
      return (
        <div className='flex flex-col gap-1.5 text-fg'>
          {item.blocks.map(b => b.type === 'tool' ? <ToolCard key={b.key} block={b} />
            : b.type === 'thinking' ? <Thinking key={b.key} text={b.text} live={live} />
            : b.text ? <ChatMarkdown key={b.key} text={b.text} /> : null)}
        </div>
      )
    case 'notice':
      return <div className={cn('text-ui-sm px-2 py-1 rounded', item.tone === 'error' ? 'bg-danger/15 text-danger-fg' : 'text-dim')}>{item.text}</div>
    case 'turn':
      return (
        <div className='text-ui-xs text-dim border-b border-border-subtle pb-2'>
          {item.isError && item.error ? `Stopped: ${item.error}. ` : ''}
          {(item.durationMs / 1000).toFixed(1)} s{item.costUsd > 0 ? ` · $${item.costUsd.toFixed(4)} so far` : ''}
        </div>
      )
  }
}

function PermissionCard({ req }: { req: PermissionRequest }) {
  const [open, setOpen] = useState(false)
  const summary = toolSummary(req.tool, req.input)
  return (
    <div className='mx-2 mb-2 p-2 rounded border border-warning bg-warning/10 text-ui-sm flex flex-col gap-1.5'>
      <div className='text-fg'>
        Claude wants to <span className='font-semibold'>{toolLabel(req.tool).toLowerCase()}</span>{summary ? `: ${summary}` : '.'}
      </div>
      <button type='button' onClick={() => setOpen(v => !v)} className='self-start flex items-center gap-1 text-dim hover:text-muted'>
        <span className={cn('w-3 h-3 transition-transform', open && 'rotate-90')}><ChevronIcon /></span> Details
      </button>
      {open && <ToolDetails name={req.tool} input={req.input} />}
      <div className='flex gap-1.5'>
        <Button size='sm' variant='primary' onClick={() => chatActions.respond(req.requestId, true)}>Allow</Button>
        {req.canAlways && <Button size='sm' onClick={() => chatActions.respond(req.requestId, true, true)}>Always allow in this chat</Button>}
        <Button size='sm' variant='ghost' onClick={() => chatActions.respond(req.requestId, false)}>Deny</Button>
      </div>
    </div>
  )
}

function KeySetup() {
  const [key, setKey] = useState('')
  return (
    <div className='m-2 p-3 rounded border border-border bg-surface-raised flex flex-col gap-2 text-ui-sm'>
      <div className='flex items-center gap-1.5 text-fg font-semibold'><span className='w-4 h-4'><KeyIcon /></span>Add an Anthropic API key</div>
      <div className='text-muted leading-snug'>
        The chat runs Claude with your own API key (from the Claude Console). It is stored on this machine only, in
        {' '}<code className='font-mono'>~/.cleo/agent-host.json</code>; or set <code className='font-mono'>ANTHROPIC_API_KEY</code> before starting the editor.
      </div>
      <form className='flex gap-1.5' onSubmit={e => { e.preventDefault(); if (key.trim()) { chatActions.setKey(key.trim()); setKey('') } }}>
        {/* A raw input on controlClass: TextInput has no password type. */}
        <input type='password' value={key} onChange={e => setKey(e.target.value)} placeholder='sk-ant-…' className={cn(controlClass, 'flex-1 min-w-0')} autoComplete='off' />
        <Button size='sm' variant='primary' type='submit' disabled={!key.trim()}>Save</Button>
      </form>
    </div>
  )
}

/** What the agent is told about the editor with each message: the open tab, the selection, the play state. */
function useEditorContext(): string {
  const { activeTab, selectedNode, editorScene, isPlayMode, isSimulating } = useCleoEngine()
  return useMemo(() => {
    const parts = [`Open tab: "${activeTab?.title ?? '?'}" (${activeTab?.kind ?? '?'}).`]
    const node = selectedNode ? editorScene?.getNodeById(selectedNode) : null
    if (node && editorScene) parts.push(`Selected node: ${nodePath(node, editorScene.root)} (${node.nodeType}).`)
    else parts.push('Nothing is selected.')
    if (isPlayMode) parts.push(`The game is running (${isSimulating ? 'simulate' : 'play'}).`)
    return parts.join(' ')
  }, [activeTab, selectedNode, editorScene, isPlayMode, isSimulating])
}

export default function AgentChatPanel() {
  const s = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot)
  const context = useEditorContext()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Follow the conversation while the user is at the bottom; leave them be when they scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [s.items, s.permissions])

  useEffect(() => { if (s.open) inputRef.current?.focus() }, [s.open])

  if (!s.open) return null

  const host = s.host
  const busy = !!host?.busy
  const ready = s.link === 'ready' && !!host
  const lastAssistant = [...s.items].reverse().find(i => i.kind === 'assistant')?.id

  const submit = () => {
    const text = draft.trim()
    if (!text || busy || !ready || host?.auth === 'missing') return
    if (chatActions.send(text, context)) setDraft('')
  }

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX, startW = s.width
    const move = (ev: PointerEvent) => chatActions.setWidth(startW + (startX - ev.clientX))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <aside className='relative flex flex-col shrink-0 min-h-0 border-l border-border bg-surface text-ui' style={{ width: Math.max(CHAT_MIN_WIDTH, s.width) }}>
      <div onPointerDown={onResizeStart} className='absolute left-0 top-0 bottom-0 w-1 -ml-0.5 cursor-col-resize hover:bg-primary/40 z-10' title='Drag to resize' />

      {/* Header */}
      <div className='flex items-center gap-1.5 h-[30px] px-2 border-b border-border shrink-0'>
        <span className='w-4 h-4 text-highlight'><ChatIcon /></span>
        <span className='font-semibold text-fg'>Claude</span>
        <span className={cn('w-1.5 h-1.5 rounded-full', ready ? (busy ? 'bg-highlight animate-pulse' : 'bg-success') : s.link === 'error' ? 'bg-danger' : 'bg-muted animate-pulse')}
          title={ready ? (busy ? 'Working' : 'Ready') : s.linkError ?? 'Connecting to the agent host'} />
        {host?.mock && <span className='text-ui-xs text-warning'>scripted test agent</span>}
        <div className='ml-auto flex items-center gap-0.5'>
          <Button variant='ghost' size='icon' title='Past conversations' disabled={!ready} onClick={() => chatActions.loadHistory()}><span className='w-3.5 h-3.5'><HistoryIcon /></span></Button>
          <Button variant='ghost' size='icon' title='New conversation' disabled={!ready || busy} onClick={() => chatActions.newChat()}><span className='w-3.5 h-3.5'><NewChatIcon /></span></Button>
          <Button variant='ghost' size='icon' title='Close the chat' onClick={() => chatActions.setOpen(false)}><span className='text-ui leading-none'>✕</span></Button>
        </div>
      </div>

      {/* Model and permission mode */}
      {host && (
        <div className='flex items-center gap-1.5 px-2 py-1 border-b border-border-subtle shrink-0'>
          <Select value={host.model} onChange={e => chatActions.setModel(e.target.value)} className='text-ui-sm py-0.5' title='Model'>
            {host.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
          <Select value={host.mode} onChange={e => chatActions.setMode(e.target.value as 'auto' | 'ask')} className='text-ui-sm py-0.5 min-w-0 flex-1'
            title='Whether Claude asks before changing the project. Running code always asks.'>
            <option value='auto'>Edit automatically</option>
            <option value='ask'>Ask before edits</option>
          </Select>
        </div>
      )}

      {/* Transcript */}
      <div ref={scrollRef} className='flex-1 min-h-0 overflow-y-auto px-3 py-2 flex flex-col gap-2.5'
        onScroll={e => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
        {s.history && (
          <div className='rounded border border-border bg-surface-raised p-2 flex flex-col gap-1 text-ui-sm'>
            <div className='flex items-center text-fg font-semibold'>Past conversations
              <Button variant='ghost' size='sm' className='ml-auto' onClick={() => chatActions.closeHistory()}>Close</Button>
            </div>
            {s.history.length === 0 && <div className='text-dim'>None yet for this project.</div>}
            {s.history.map(h => (
              <button key={h.sessionId} type='button' onClick={() => chatActions.openSession(h.sessionId)}
                className='text-left px-1.5 py-1 rounded hover:bg-control flex flex-col'>
                <span className='text-fg truncate'>{h.title}</span>
                <span className='text-ui-xs text-dim'>{new Date(h.lastModified).toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}

        {s.link === 'error' && (
          <div className='rounded bg-danger/15 text-danger-fg p-2 text-ui-sm flex flex-col gap-1.5'>
            <div>{s.linkError ?? 'Could not reach the agent host.'}</div>
            <Button size='sm' className='self-start' onClick={() => chatActions.retry()}>Retry</Button>
          </div>
        )}
        {s.link === 'no-chat' && (
          <div className='rounded bg-warning/15 p-2 text-ui-sm flex flex-col gap-1.5'>
            <div className='text-fg'>The editor is linked to an MCP server without chat. Start the agent host to use the chat; the MCP tools keep working through it.</div>
            <Button size='sm' className='self-start' onClick={() => chatActions.retry()}>Start the agent host</Button>
          </div>
        )}
        {(s.link === 'starting' || s.link === 'connecting' || s.link === 'idle') && <div className='text-dim text-ui-sm'>Starting Claude…</div>}

        {ready && host?.auth === 'missing' && <KeySetup />}

        {ready && s.items.length === 0 && host?.auth !== 'missing' && (
          <div className='flex flex-col gap-2 mt-2'>
            <div className='text-muted'>Ask Claude to build, script or test in this project. It works in the editor while you watch, and every change it makes is one undo step.</div>
            {SUGGESTIONS.map(t => (
              <button key={t} type='button' onClick={() => { setDraft(t); inputRef.current?.focus() }}
                className='text-left px-2 py-1.5 rounded border border-border-subtle text-ui-sm text-muted hover:text-fg hover:bg-control'>{t}</button>
            ))}
          </div>
        )}

        {s.items.map(item => <Item key={item.id} item={item} live={busy && item.id === lastAssistant} />)}
        {busy && s.permissions.length === 0 && <div className='text-ui-sm text-dim italic'>Working…</div>}
      </div>

      {s.permissions.map(p => <PermissionCard key={p.requestId} req={p} />)}

      {/* Composer */}
      <div className='shrink-0 border-t border-border p-2 flex flex-col gap-1'>
        <div className='flex items-end gap-1.5'>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            placeholder={ready ? 'Ask Claude… (Enter to send, Shift+Enter for a new line)' : 'Waiting for the agent host…'}
            disabled={!ready || host?.auth === 'missing'}
            className='flex-1 min-w-0 resize-none rounded border border-border bg-control text-fg px-2 py-1.5 outline-none focus-visible:border-primary text-ui leading-snug'
          />
          {busy
            ? <Button variant='danger' size='icon' title='Stop' onClick={() => chatActions.interrupt()}><span className='w-4 h-4'><StopIcon /></span></Button>
            : <Button variant='primary' size='icon' title='Send' disabled={!draft.trim() || !ready || host?.auth === 'missing'} onClick={submit}><span className='w-4 h-4'><SendIcon /></span></Button>}
        </div>
        <div className='flex items-center gap-2 text-ui-xs text-dim'>
          <span className='truncate' title={context}>{context}</span>
          {!!host?.cost && <span className='ml-auto shrink-0'>${host.cost.toFixed(4)}</span>}
        </div>
      </div>
    </aside>
  )
}

/** The menu-bar button that opens and closes the chat. */
export function AgentChatToggle() {
  const s = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot)
  return (
    <Button variant='subtle' size='sm' className='h-[25px]' active={s.open} title='Claude: build, script and test with an AI agent'
      onClick={() => chatActions.toggle()}>
      <span className='w-3.5 h-3.5'><ChatIcon /></span> Claude
    </Button>
  )
}
