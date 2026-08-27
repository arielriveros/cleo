import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  MarkerType, useNodesState, useEdgesState, useReactFlow,
  type Node as RFNode, type Edge as RFEdge, type Connection, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCleoEngine } from '../EngineContext'
import { useStateMachine, OP_LABEL, effectiveType, sameLink } from './StateMachineContext'
import { SegmentedControl } from '../../components/ui'
import FloatingEdge from './FloatingEdge'
import { isConditionGroup } from 'cleo'
import type { AnimationTransition, AnimationCondition, AnimationConditionNode } from 'cleo'

// Center-canvas node-graph for the animation state machine: draggable state nodes and arrowed transition
// edges, both editing the shared machine from StateMachineContext.

const NODE_W = 156
const AUTO_COLS = 4
const AUTO_DX = 210
const AUTO_DY = 120

interface StateNodeData {
  label: string
  clipName: string
  /** Set when the state plays an Animation Field instead of a clip; '' when its asset is missing. */
  fieldName?: string
  playsField: boolean
  isEntry: boolean
  loop: boolean
  speed: number
  /** Parameter the playback rate is read from, when the state binds one instead of using `speed`. */
  speedParam?: string
  active: boolean
  [key: string]: unknown
}

function StateNode({ data, selected }: NodeProps) {
  const d = data as StateNodeData
  const border = d.active ? 'border-highlight' : selected ? 'border-selected' : d.isEntry ? 'border-success' : 'border-control-hover'
  // The ⊞ badge is what distinguishes a blend state from a clip state; the name alone does not.
  const what = d.playsField ? (d.fieldName || '(missing field)') : (d.clipName || '(no clip)')
  return (
    <div className={`rounded border-2 ${border} bg-control text-white shadow-panel`} style={{ width: NODE_W }}>
      <Handle type='target' position={Position.Left} className='!bg-primary !w-2 !h-2' />
      <div className='px-2 py-1 border-b border-border flex items-center gap-1'>
        {d.isEntry && <span className='text-[9px] px-1 rounded bg-success text-white' title='Entry state'>▶</span>}
        <span className='text-xs font-semibold truncate flex-1' title={d.label}>{d.label}</span>
      </div>
      <div className='px-2 py-1 text-[10px] text-muted flex items-center justify-between gap-1'>
        <span className={`truncate ${d.playsField && !d.fieldName ? 'text-red-400' : ''}`} title={what}>
          {d.playsField && <span className='mr-1 text-primary' title='Animation field (blend space)'>⊞</span>}
          {what}
        </span>
        {/* A rate read from a parameter is shown by NAME. It is the single most common reason a state looks
            right in a preview (which always runs at rate 1) and wrong in Play, so it has to be legible
            without selecting the node. Highlighted on a field state, where it multiplies an already
            speed-matched blend. */}
        <span className={`shrink-0 ${d.speedParam && d.playsField ? 'text-warning' : 'text-dim'}`}
          title={d.speedParam ? `Playback rate read from the "${d.speedParam}" parameter` : 'Fixed playback rate'}>
          {d.loop ? '↻' : '→'} ×{d.speedParam ?? d.speed}
        </span>
      </div>
      <Handle type='source' position={Position.Right} className='!bg-primary !w-2 !h-2' />
    </div>
  )
}

const nodeTypes = { state: StateNode }
const edgeTypes = { transition: FloatingEdge }

// Short human summary of a transition's gate for the edge label: the condition tree flattened to its first
// couple of leaves.
function transitionLabel(t: AnimationTransition, paramOf: (n: string) => any): string {
  const leaves: AnimationCondition[] = []
  const walk = (n: AnimationConditionNode) => { isConditionGroup(n) ? n.children.forEach(walk) : leaves.push(n) }
  if (t.condition) walk(t.condition)
  else t.conditions.forEach(c => leaves.push(c))

  if (leaves.length === 0) return t.hasExitTime ? 'exit' : ''
  const parts = leaves.slice(0, 2).map(c => {
    const type = effectiveType(paramOf(c.param))
    if (type === 'float') return `${c.param} ${OP_LABEL[c.op]} ${c.value ?? 0}`
    if (type === 'bool') return `${c.param} ${OP_LABEL[c.op]}`
    return `${c.param}`
  })
  // The join is a hint only: an OR gate reads as ', ' here, same as an AND.
  const extra = leaves.length > 2 ? ` +${leaves.length - 2}` : ''
  return parts.join(', ') + extra
}

function Flow() {
  const { editorMode } = useCleoEngine()
  const {
    target, sm, links, selection, setSelection, graphView, setGraphView,
    addState, setState, addTransition, apply, stateIndex, commitLayout, deleteElements, paramOf,
    animationFields, fieldOf,
  } = useStateMachine()
  const { screenToFlowPosition } = useReactFlow()

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([])
  const [activeState, setActiveState] = useState<string | null>(null)
  /** Open node context menu, in client coordinates. */
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null)

  // Position for a state: stored x/y, else deterministic auto-grid by list order.
  const posOf = useCallback((name: string, idx: number): { x: number; y: number } => {
    const s = sm.states[idx]
    if (s && typeof s.x === 'number' && typeof s.y === 'number') return { x: s.x, y: s.y }
    return { x: (idx % AUTO_COLS) * AUTO_DX, y: Math.floor(idx / AUTO_COLS) * AUTO_DY }
  }, [sm.states])

  // Persist auto-layout once for legacy machines whose states have no coordinates.
  useEffect(() => {
    if (!graphView || sm.states.length === 0) return
    const missing = sm.states.filter(s => typeof s.x !== 'number' || typeof s.y !== 'number')
    if (missing.length === 0) return
    const coords: Record<string, { x: number; y: number }> = {}
    sm.states.forEach((s, i) => { coords[s.name] = posOf(s.name, i) })
    commitLayout(coords)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphView, sm.states.length])

  // Rebuild nodes from the machine (positions from sm; not called mid-drag since sm is stable then).
  useEffect(() => {
    setNodes(sm.states.map((s, i) => ({
      id: s.name,
      type: 'state',
      position: posOf(s.name, i),
      selected: selection?.kind === 'state' && selection.name === s.name,
      data: {
        label: s.name, clipName: s.clipName, isEntry: !!s.isEntry,
        playsField: !!s.fieldId, fieldName: fieldOf(s.fieldId)?.name,
        loop: s.loop, speed: s.speed, speedParam: s.speedParam, active: s.name === activeState,
      } as StateNodeData,
    })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sm.states, selection, posOf, animationFields])

  // Rebuild edges from LINKS, not transitions: A→B and B→A are ONE edge. FloatingEdge draws it as a single
  // line for one direction and two parallel lines for both, and picks the borders to attach to itself.
  useEffect(() => {
    // Markers must stay on the edge: xyflow resolves them into `url(#…)` strings for the custom edge.
    const arrow = { type: MarkerType.ArrowClosed, width: 14, height: 14 }
    setEdges(links.map(l => {
      const isSelected = sameLink(selection, l.a, l.b)
      const fwd = l.forward ? transitionLabel(l.forward, paramOf) : ''
      const bwd = l.backward ? transitionLabel(l.backward, paramOf) : ''
      const both = !!l.forward && !!l.backward
      return {
        id: `${l.a}|${l.b}`,
        type: 'transition',
        source: l.a,
        target: l.b,
        label: both ? [fwd, bwd].filter(Boolean).join(' ⇄ ') || '⇄' : (fwd || bwd),
        selected: isSelected,
        markerEnd: l.forward ? arrow : undefined,
        markerStart: l.backward ? arrow : undefined,
        data: { a: l.a, b: l.b, forward: !!l.forward, backward: !!l.backward },
        // Light up whichever direction could actually fire from where the machine currently is.
        animated: activeState === l.a ? !!l.forward : activeState === l.b ? !!l.backward : false,
        style: { stroke: isSelected ? 'var(--color-selected, #6b8afd)' : undefined },
        labelStyle: { fontSize: 10, fill: '#cbd5e1' },
        labelBgStyle: { fill: 'rgba(20,22,28,0.85)' },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
      }
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sm.transitions, sm.parameters, selection, activeState])

  // Polls the animator's active state for the Simulate highlight, only while the graph is visible.
  useEffect(() => {
    if (!target || !graphView) { setActiveState(null); return }
    let raf = 0
    const tick = () => {
      const name = target.animator.currentStateName ?? null
      setActiveState(prev => (prev === name ? prev : name))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, graphView])

  // Patch node/edge `active` flags in place so the highlight doesn't reset drag positions.
  useEffect(() => {
    setNodes(nds => nds.map(n => ({ ...n, data: { ...(n.data as StateNodeData), active: n.id === activeState } })))
    setEdges(eds => eds.map(e => ({ ...e, animated: e.source === activeState })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeState])

  const onNodeDragStop = useCallback((_: any, node: RFNode) => {
    const i = stateIndex(node.id)
    if (i >= 0) setState(i, { x: Math.round(node.position.x), y: Math.round(node.position.y) })
  }, [stateIndex, setState])

  const onConnect = useCallback((c: Connection) => {
    // A self-transition can never fire (_evaluateStateMachine skips t.to === current) and draws as an
    // invisible stub behind the node, so refuse it rather than leave dead data around.
    if (!c.source || !c.target || c.source === c.target) return
    addTransition(c.source, c.target) // a duplicate is a no-op there
  }, [addTransition])

  // One combined callback so deleting a node (which cascades its edges) is a single atomic update.
  const onDelete = useCallback(({ nodes: dn, edges: de }: { nodes: RFNode[]; edges: RFEdge[] }) => {
    const stateNames = dn.map(n => n.id)
    // Deleting an edge removes the link, i.e. BOTH directions — the sidebar is where you drop just one.
    const removed = de
      .map(e => [(e.data as any)?.a, (e.data as any)?.b] as [string, string])
      .filter(([a, b]) => typeof a === 'string' && typeof b === 'string')
    if (stateNames.length || removed.length) deleteElements(stateNames, removed)
  }, [deleteElements])

  const onNodeClick = useCallback((_: any, node: RFNode) => {
    setSelection({ kind: 'state', name: node.id })
    setMenu(null)
  }, [setSelection])
  const onEdgeClick = useCallback((_: any, edge: RFEdge) => {
    const { a, b } = (edge.data ?? {}) as { a?: string; b?: string }
    if (a && b) setSelection({ kind: 'transition', a, b })
    setMenu(null)
  }, [setSelection])
  const onPaneClick = useCallback(() => { setSelection(null); setMenu(null) }, [setSelection])

  // Right-click a node for the things that have no room on it, entry state included.
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: RFNode) => {
    e.preventDefault()
    setSelection({ kind: 'state', name: node.id })
    setMenu({ name: node.id, x: e.clientX, y: e.clientY })
  }, [setSelection])

  const addAtCenter = useCallback(() => {
    // Spread new states so they don't stack; offset by current count.
    const n = sm.states.length
    addState({ x: (n % AUTO_COLS) * AUTO_DX + 40, y: Math.floor(n / AUTO_COLS) * AUTO_DY + 40 })
  }, [sm.states.length, addState])

  const onPaneDoubleClick = useCallback((e: React.MouseEvent) => {
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    addState({ x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - 20) })
  }, [screenToFlowPosition, addState])

  if (editorMode !== 'animation' || !graphView) return null

  return (
    <div className='absolute inset-0 z-10 bg-bg' onDoubleClick={onPaneDoubleClick}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onDelete={onDelete}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        deleteKeyCode={['Delete', 'Backspace']}
        fitView
        proOptions={{ hideAttribution: true }}
        className='!bg-bg'>
        <Background color='#3a3f4b' gap={18} />
        <Controls className='!bg-surface-raised !border-border' showInteractive={false} />
        <MiniMap pannable zoomable className='!bg-surface-sunken' maskColor='rgba(0,0,0,0.5)' nodeColor='#4b5563' />
      </ReactFlow>

      {/* Toolbar */}
      <div data-cleo-overlay className='absolute top-2 left-2 z-20 flex items-center gap-2'
           onMouseDown={e => e.stopPropagation()}>
        <SegmentedControl<'3d' | 'graph'>
          options={[{ value: '3d', label: 'Animations' }, { value: 'graph', label: 'Graph' }]}
          value='graph'
          onChange={v => setGraphView(v === 'graph')} />
        <button className='px-2 py-1 rounded bg-primary hover:bg-primary-hover text-white border border-primary-active text-xs'
                onClick={addAtCenter} title='Add a new state (or double-click the canvas)'>+ State</button>
        <button className='px-2 py-1 rounded bg-success hover:bg-success-hover text-white text-xs'
                onClick={apply} title='Save the machine onto the model (used at runtime and by Simulate)'>Apply</button>
        <span className='text-[10px] text-dim ml-1'>drag handle → handle to connect · right-click a state · Del to remove</span>
      </div>

      {menu && <NodeMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** Right-click menu on a state. Positioned in client space, so it is a sibling of the graph, not a child. */
function NodeMenu({ menu, onClose }: { menu: { name: string; x: number; y: number }; onClose: () => void }) {
  const { sm, stateIndex, setState, removeState } = useStateMachine()
  const i = stateIndex(menu.name)
  const state = i >= 0 ? sm.states[i] : null
  if (!state) return null

  const item = 'w-full text-left px-2 py-1 text-xs hover:bg-control disabled:opacity-40 disabled:hover:bg-transparent'
  return (
    <>
      {/* Catch the next click anywhere so the menu behaves like a menu. */}
      <div className='fixed inset-0 z-30' onMouseDown={onClose} onContextMenu={e => { e.preventDefault(); onClose() }} />
      <div data-cleo-overlay
        className='fixed z-40 min-w-[132px] rounded border border-border bg-surface-raised shadow-panel py-0.5'
        style={{ left: menu.x, top: menu.y }}
        onMouseDown={e => e.stopPropagation()}>
        <div className='px-2 py-1 text-[10px] uppercase tracking-wide text-dim truncate'>{state.name}</div>
        <button className={item} disabled={!!state.isEntry}
          title={state.isEntry ? 'Already the entry state' : 'The machine starts here'}
          onClick={() => { setState(i, { isEntry: true }); onClose() }}>
          {state.isEntry ? '▶ Entry state' : 'Set as entry'}
        </button>
        <button className={item + ' text-red-400'} onClick={() => { removeState(i); onClose() }}>Delete state</button>
      </div>
    </>
  )
}

export default function StateGraph() {
  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  )
}
