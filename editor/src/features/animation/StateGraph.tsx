import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  MarkerType, useNodesState, useEdgesState, useReactFlow,
  type Node as RFNode, type Edge as RFEdge, type Connection, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCleoEngine } from '../EngineContext'
import { useStateMachine, OP_LABEL, effectiveType } from './StateMachineContext'
import { SegmentedControl } from '../../components/ui'
import type { AnimationTransition } from 'cleo'

// Center-canvas node-graph for the animation state machine. States are draggable nodes, transitions
// are arrowed edges; both edit the shared machine from StateMachineContext. Rendered as an absolute
// overlay over the WebGL viewport in animation mode when the Graph view is active.

const NODE_W = 156
const AUTO_COLS = 4
const AUTO_DX = 210
const AUTO_DY = 120

interface StateNodeData {
  label: string
  clipName: string
  isEntry: boolean
  loop: boolean
  speed: number
  active: boolean
  [key: string]: unknown
}

function StateNode({ data, selected }: NodeProps) {
  const d = data as StateNodeData
  const border = d.active ? 'border-highlight' : selected ? 'border-selected' : d.isEntry ? 'border-success' : 'border-control-hover'
  return (
    <div className={`rounded border-2 ${border} bg-control text-white shadow-panel`} style={{ width: NODE_W }}>
      <Handle type='target' position={Position.Left} className='!bg-primary !w-2 !h-2' />
      <div className='px-2 py-1 border-b border-border flex items-center gap-1'>
        {d.isEntry && <span className='text-[9px] px-1 rounded bg-success text-white' title='Entry state'>▶</span>}
        <span className='text-xs font-semibold truncate flex-1' title={d.label}>{d.label}</span>
      </div>
      <div className='px-2 py-1 text-[10px] text-muted flex items-center justify-between gap-1'>
        <span className='truncate' title={d.clipName || '(no clip)'}>{d.clipName || '(no clip)'}</span>
        <span className='shrink-0 text-dim'>{d.loop ? '↻' : '→'} ×{d.speed}</span>
      </div>
      <Handle type='source' position={Position.Right} className='!bg-primary !w-2 !h-2' />
    </div>
  )
}

const nodeTypes = { state: StateNode }

// Short human summary of a transition's conditions for the edge label.
function transitionLabel(t: AnimationTransition, paramOf: (n: string) => any): string {
  if (t.conditions.length === 0) return t.hasExitTime ? 'exit' : ''
  const parts = t.conditions.slice(0, 2).map(c => {
    const type = effectiveType(paramOf(c.param))
    if (type === 'float') return `${c.param} ${OP_LABEL[c.op]} ${c.value ?? 0}`
    if (type === 'bool') return `${c.param} ${OP_LABEL[c.op]}`
    return `${c.param}`
  })
  const extra = t.conditions.length > 2 ? ` +${t.conditions.length - 2}` : ''
  return parts.join(', ') + extra
}

function Flow() {
  const { editorMode } = useCleoEngine()
  const {
    target, sm, selection, setSelection, graphView, setGraphView,
    addState, setState, addTransition, apply, stateIndex, commitLayout, deleteElements, paramOf,
  } = useStateMachine()
  const { screenToFlowPosition } = useReactFlow()

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([])
  const [activeState, setActiveState] = useState<string | null>(null)

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
        loop: s.loop, speed: s.speed, active: s.name === activeState,
      } as StateNodeData,
    })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sm.states, selection, posOf])

  // Rebuild edges from transitions.
  useEffect(() => {
    setEdges(sm.transitions.map((t, i) => ({
      id: `t${i}`,
      source: t.from,
      target: t.to,
      label: transitionLabel(t, paramOf),
      selected: selection?.kind === 'transition' && selection.index === i,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      data: { index: i },
      animated: t.from === activeState,
      style: { stroke: selection?.kind === 'transition' && selection.index === i ? 'var(--color-selected, #6b8afd)' : undefined },
      labelStyle: { fontSize: 10, fill: '#cbd5e1' },
      labelBgStyle: { fill: 'rgba(20,22,28,0.85)' },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
    })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sm.transitions, sm.parameters, selection, activeState])

  // Poll the animator's active state (for the Simulate highlight) without rebuilding on every frame.
  // Only runs while the graph is actually visible so it isn't a permanent global rAF loop.
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
    if (c.source && c.target) addTransition(c.source, c.target)
  }, [addTransition])

  // One combined callback so deleting a node (which cascades its edges) is a single atomic update.
  const onDelete = useCallback(({ nodes: dn, edges: de }: { nodes: RFNode[]; edges: RFEdge[] }) => {
    const stateNames = dn.map(n => n.id)
    const transitionIndices = de.map(e => (e.data as any)?.index as number).filter(i => typeof i === 'number')
    if (stateNames.length || transitionIndices.length) deleteElements(stateNames, transitionIndices)
  }, [deleteElements])

  const onNodeClick = useCallback((_: any, node: RFNode) => setSelection({ kind: 'state', name: node.id }), [setSelection])
  const onEdgeClick = useCallback((_: any, edge: RFEdge) => {
    const i = (edge.data as any)?.index
    if (typeof i === 'number') setSelection({ kind: 'transition', index: i })
  }, [setSelection])
  const onPaneClick = useCallback(() => setSelection(null), [setSelection])

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
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onDelete={onDelete}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
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
          options={[{ value: '3d', label: '3D' }, { value: 'graph', label: 'Graph' }]}
          value='graph'
          onChange={v => setGraphView(v === 'graph')} />
        <button className='px-2 py-1 rounded bg-primary hover:bg-primary-hover text-white border border-primary-active text-xs'
                onClick={addAtCenter} title='Add a new state (or double-click the canvas)'>+ State</button>
        <button className='px-2 py-1 rounded bg-success hover:bg-success-hover text-white text-xs'
                onClick={apply} title='Save the machine onto the model (used at runtime and by Simulate)'>Apply</button>
        <span className='text-[10px] text-dim ml-1'>drag handle → handle to connect · Del to remove</span>
      </div>
    </div>
  )
}

export default function StateGraph() {
  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  )
}
