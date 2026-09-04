import { useCallback, useEffect, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  MarkerType, useNodesState, useEdgesState, useReactFlow,
  type Node as RFNode, type Edge as RFEdge, type Connection, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import FloatingEdge from '../features/animation/FloatingEdge'

/**
 * The node-graph canvas, shared by every state machine the editor edits.
 *
 * Extracted from the animation state machine's graph, which was the only one that had it. The AI
 * behaviour machine is the same shape — named states with layout coordinates, transitions gated by a
 * condition tree, one entry state — and it had been getting a list instead purely because the canvas
 * was welded to `StateMachineContext` and to clips.
 *
 * Nothing here knows what a state CONTAINS. A caller hands over positioned nodes with a subtitle and
 * a badge, links that already know which directions exist, and callbacks; what a node means is the
 * caller's business. That is the whole seam: two machines share the interaction — drag to move,
 * handle-to-handle to connect, right-click for the entry state, Delete to remove — and disagree only
 * about what to write inside a box.
 *
 * ## Links, not transitions
 *
 * An edge is a LINK between two states, carrying up to two directions. A→B and B→A are ONE line, and
 * `FloatingEdge` draws it as a single line for one direction or two parallel lines for both. Deleting
 * an edge therefore removes both directions; dropping just one is the sidebar's job. This mirrors how
 * an author thinks about a pair of states rather than how the data is stored.
 */

const NODE_W = 156

export type BadgeTone = 'dim' | 'warning' | 'primary'

export interface GraphNodeModel {
  id: string
  x: number
  y: number
  /** Drawn with the entry marker and a distinct border. Exactly one node should carry it. */
  isEntry?: boolean
  /** The line under the title: what this state DOES. */
  subtitle?: string
  /** Red subtitle, for a reference that no longer resolves. */
  subtitleMissing?: boolean
  /** A glyph before the title, for a state whose kind the name cannot convey. */
  glyph?: string
  glyphTitle?: string
  /** Small right-aligned readout. */
  badge?: string
  badgeTitle?: string
  badgeTone?: BadgeTone
}

export interface GraphLinkModel {
  a: string
  b: string
  forward: boolean
  backward: boolean
  /** Short summary of the gate, drawn on the line. */
  label: string
}

export interface MachineGraphProps {
  nodes: GraphNodeModel[]
  links: GraphLinkModel[]
  /** Highlighted as the state the machine is currently in. Drives the edge animation too. */
  activeId?: string | null
  selectedNode?: string | null
  selectedLink?: { a: string; b: string } | null

  onMoveNode(id: string, x: number, y: number): void
  onConnect(from: string, to: string): void
  /** One call, so deleting a node and the edges it cascades is a single atomic update. */
  onDelete(nodeIds: string[], links: [string, string][]): void
  onSelectNode(id: string | null): void
  onSelectLink(a: string, b: string): void
  onAddNode(x: number, y: number): void
  onSetEntry(id: string): void
  onRemoveNode(id: string): void

  /** Buttons for the toolbar's left end — the caller's own actions. */
  toolbar?: React.ReactNode
  /** Trailing hint text. Defaults to the interactions this canvas provides. */
  hint?: string
}

interface NodeData extends Record<string, unknown> {
  label: string
  subtitle: string
  subtitleMissing: boolean
  glyph?: string
  glyphTitle?: string
  badge?: string
  badgeTitle?: string
  badgeTone: BadgeTone
  isEntry: boolean
  active: boolean
}

const TONE_CLASS: Record<BadgeTone, string> = {
  dim: 'text-dim',
  warning: 'text-warning',
  primary: 'text-primary',
}

function GraphNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  const border = d.active ? 'border-highlight'
    : selected ? 'border-selected'
    : d.isEntry ? 'border-success'
    : 'border-control-hover'
  return (
    <div className={`rounded border-2 ${border} bg-control text-white shadow-panel`} style={{ width: NODE_W }}>
      <Handle type='target' position={Position.Left} className='!bg-primary !w-2 !h-2' />
      <div className='px-2 py-1 border-b border-border flex items-center gap-1'>
        {d.isEntry && <span className='text-[9px] px-1 rounded bg-success text-white' title='Entry state'>▶</span>}
        <span className='text-xs font-semibold truncate flex-1' title={d.label}>{d.label}</span>
      </div>
      <div className='px-2 py-1 text-[10px] text-muted flex items-center justify-between gap-1'>
        <span className={`truncate ${d.subtitleMissing ? 'text-red-400' : ''}`} title={d.subtitle}>
          {d.glyph && <span className='mr-1 text-primary' title={d.glyphTitle}>{d.glyph}</span>}
          {d.subtitle}
        </span>
        {d.badge && (
          <span className={`shrink-0 ${TONE_CLASS[d.badgeTone]}`} title={d.badgeTitle}>{d.badge}</span>
        )}
      </div>
      <Handle type='source' position={Position.Right} className='!bg-primary !w-2 !h-2' />
    </div>
  )
}

const nodeTypes = { state: GraphNode }
const edgeTypes = { transition: FloatingEdge }

function Flow(props: MachineGraphProps) {
  const {
    nodes: model, links, activeId = null, selectedNode = null, selectedLink = null,
    onMoveNode, onConnect, onDelete, onSelectNode, onSelectLink, onAddNode, onSetEntry, onRemoveNode,
    toolbar, hint,
  } = props

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([])
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const { screenToFlowPosition } = useReactFlow()

  useEffect(() => {
    setNodes(model.map(n => ({
      id: n.id,
      type: 'state',
      position: { x: n.x, y: n.y },
      selected: selectedNode === n.id,
      data: {
        label: n.id,
        subtitle: n.subtitle ?? '',
        subtitleMissing: !!n.subtitleMissing,
        glyph: n.glyph,
        glyphTitle: n.glyphTitle,
        badge: n.badge,
        badgeTitle: n.badgeTitle,
        badgeTone: n.badgeTone ?? 'dim',
        isEntry: !!n.isEntry,
        active: n.id === activeId,
      } as NodeData,
    })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, selectedNode])

  useEffect(() => {
    // Markers must stay on the edge: xyflow resolves them into `url(#…)` strings for the custom edge.
    const arrow = { type: MarkerType.ArrowClosed, width: 14, height: 14 }
    setEdges(links.map(l => {
      const isSelected = !!selectedLink
        && ((selectedLink.a === l.a && selectedLink.b === l.b)
          || (selectedLink.a === l.b && selectedLink.b === l.a))
      return {
        id: `${l.a}|${l.b}`,
        type: 'transition',
        source: l.a,
        target: l.b,
        label: l.label,
        selected: isSelected,
        markerEnd: l.forward ? arrow : undefined,
        markerStart: l.backward ? arrow : undefined,
        data: { a: l.a, b: l.b, forward: l.forward, backward: l.backward },
        // Light up whichever direction could actually fire from where the machine currently is.
        animated: activeId === l.a ? l.forward : activeId === l.b ? l.backward : false,
        style: { stroke: isSelected ? 'var(--color-selected, #6b8afd)' : undefined },
        labelStyle: { fontSize: 10, fill: '#cbd5e1' },
        labelBgStyle: { fill: 'rgba(20,22,28,0.85)' },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
      }
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links, selectedLink, activeId])

  // Patched in place rather than rebuilt, so the highlight cannot reset a drag in progress.
  useEffect(() => {
    setNodes(nds => nds.map(n => ({ ...n, data: { ...(n.data as NodeData), active: n.id === activeId } })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const handleDragStop = useCallback((_: unknown, node: RFNode) => {
    onMoveNode(node.id, Math.round(node.position.x), Math.round(node.position.y))
  }, [onMoveNode])

  const handleConnect = useCallback((c: Connection) => {
    // A self-transition can never fire and draws as an invisible stub behind the node, so refuse it
    // rather than leave dead data around.
    if (!c.source || !c.target || c.source === c.target) return
    onConnect(c.source, c.target)
  }, [onConnect])

  const handleDelete = useCallback(({ nodes: dn, edges: de }: { nodes: RFNode[]; edges: RFEdge[] }) => {
    const ids = dn.map(n => n.id)
    const removed = de
      .map(e => [(e.data as { a?: string })?.a, (e.data as { b?: string })?.b] as [string, string])
      .filter(([a, b]) => typeof a === 'string' && typeof b === 'string')
    if (ids.length || removed.length) onDelete(ids, removed)
  }, [onDelete])

  const handleNodeContextMenu = useCallback((e: React.MouseEvent, node: RFNode) => {
    e.preventDefault()
    onSelectNode(node.id)
    setMenu({ id: node.id, x: e.clientX, y: e.clientY })
  }, [onSelectNode])

  const handlePaneDoubleClick = useCallback((e: React.MouseEvent) => {
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    onAddNode(Math.round(p.x - NODE_W / 2), Math.round(p.y - 20))
  }, [screenToFlowPosition, onAddNode])

  const entry = model.find(n => n.id === menu?.id)

  return (
    <div className='absolute inset-0 z-10 bg-bg' onDoubleClick={handlePaneDoubleClick}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={handleDragStop}
        onConnect={handleConnect}
        onDelete={handleDelete}
        onNodeClick={(_, node) => { onSelectNode(node.id); setMenu(null) }}
        onEdgeClick={(_, edge) => {
          const { a, b } = (edge.data ?? {}) as { a?: string; b?: string }
          if (a && b) onSelectLink(a, b)
          setMenu(null)
        }}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneClick={() => { onSelectNode(null); setMenu(null) }}
        deleteKeyCode={['Delete', 'Backspace']}
        fitView
        proOptions={{ hideAttribution: true }}
        className='!bg-bg'>
        <Background color='#3a3f4b' gap={18} />
        <Controls className='!bg-surface-raised !border-border' showInteractive={false} />
        <MiniMap pannable zoomable className='!bg-surface-sunken' maskColor='rgba(0,0,0,0.5)' nodeColor='#4b5563' />
      </ReactFlow>

      <div data-cleo-overlay className='absolute top-2 left-2 z-20 flex items-center gap-2'
        onMouseDown={e => e.stopPropagation()}>
        {toolbar}
        <span className='text-[10px] text-dim ml-1'>
          {hint ?? 'drag handle → handle to connect · right-click a state · Del to remove'}
        </span>
      </div>

      {menu && entry && (
        <NodeMenu
          id={menu.id} x={menu.x} y={menu.y} isEntry={!!entry.isEntry}
          onSetEntry={() => { onSetEntry(menu.id); setMenu(null) }}
          onRemove={() => { onRemoveNode(menu.id); setMenu(null) }}
          onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

/** Right-click menu on a node. Positioned in client space, so it is a sibling of the graph, not a child. */
function NodeMenu(
  { id, x, y, isEntry, onSetEntry, onRemove, onClose }: {
    id: string; x: number; y: number; isEntry: boolean
    onSetEntry(): void; onRemove(): void; onClose(): void
  },
) {
  const item = 'w-full text-left px-2 py-1 text-xs hover:bg-control disabled:opacity-40 disabled:hover:bg-transparent'
  return (
    <>
      {/* Catch the next click anywhere so the menu behaves like a menu. */}
      <div className='fixed inset-0 z-30' onMouseDown={onClose}
        onContextMenu={e => { e.preventDefault(); onClose() }} />
      <div data-cleo-overlay
        className='fixed z-40 min-w-[132px] rounded border border-border bg-surface-raised shadow-panel py-0.5'
        style={{ left: x, top: y }}
        onMouseDown={e => e.stopPropagation()}>
        <div className='px-2 py-1 text-[10px] uppercase tracking-wide text-dim truncate'>{id}</div>
        <button className={item} disabled={isEntry}
          title={isEntry ? 'Already the entry state' : 'The machine starts here'}
          onClick={onSetEntry}>
          {isEntry ? '▶ Entry state' : 'Set as entry'}
        </button>
        <button className={item + ' text-red-400'} onClick={onRemove}>Delete state</button>
      </div>
    </>
  )
}

export default function MachineGraph(props: MachineGraphProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  )
}
