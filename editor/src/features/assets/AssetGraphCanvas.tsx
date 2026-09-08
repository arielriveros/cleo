import { useEffect, useMemo } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, MarkerType,
  useNodesState, useEdgesState, useReactFlow,
  type Node as RFNode, type Edge as RFEdge, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { iconFor } from './assetKinds'
import { KIND_LABEL } from '../../utils/vfs'
import type { AssetKind } from '../../utils/vfs'
import type { AssetNodeView, ReferenceView } from './assetGraphLayout'
import { cn } from '../../components/ui'

// The reference viewer's canvas.
//
// A SIBLING of components/MachineGraph rather than a mode of it, deliberately. MachineGraph merges A->B
// and B->A into one bidirectional link, which is right for a state machine and exactly wrong here: "the
// material uses the texture" and "the texture uses the material" are different claims, and only one of
// them is ever true. It also assumes a mutable model with connect/delete handlers; this view is read-only.
// The styling conventions (background grid, control chrome, token classes) are shared on purpose.

const NODE_W = 168

type AssetFlowData = {
  view: AssetNodeView
  isRoot: boolean
  onOpen: (view: AssetNodeView) => void
}

function AssetGraphNode({ data }: NodeProps) {
  const { view, isRoot } = data as unknown as AssetFlowData
  const kind = view.ref.kind as AssetKind

  return (
    <div
      className={cn(
        'relative rounded border px-2 py-1.5 flex items-center gap-2 select-none',
        view.missing
          ? 'border-dashed border-danger bg-danger-surface/40'
          : isRoot
            ? 'border-highlight bg-primary/25'
            : 'border-control-hover bg-control',
      )}
      style={{ width: NODE_W }}
      title={`${KIND_LABEL[kind] ?? kind} · ${view.ref.id}`}
    >
      {/* Both handles on every node: an edge can enter and leave the same card. */}
      <Handle type='target' position={Position.Left} className='!bg-primary !w-2 !h-2 !border-0' />
      <img src={iconFor(kind)} className='w-4 h-4 shrink-0' alt='' draggable={false} />
      <div className='min-w-0 flex-1'>
        <div className='truncate text-[11px] text-fg leading-tight'>{view.name}</div>
        <div className='truncate text-[9px] text-dim leading-tight'>
          {view.missing ? 'missing' : KIND_LABEL[kind] ?? kind}
          {view.partial && ' · partial'}
        </div>
      </div>
      <Handle type='source' position={Position.Right} className='!bg-primary !w-2 !h-2 !border-0' />
    </div>
  )
}

const nodeTypes = { asset: AssetGraphNode }

export type AssetGraphCanvasProps = {
  view: ReferenceView
  rootKey: string
  /** Click: re-root the graph here. */
  onSelect: (view: AssetNodeView) => void
  /** Double-click: open the asset's editor. */
  onOpen: (view: AssetNodeView) => void
}

function Canvas({ view, rootKey, onSelect, onOpen }: AssetGraphCanvasProps) {
  const { fitView } = useReactFlow()

  const nextNodes = useMemo<RFNode[]>(() => view.nodes.map(n => ({
    id: n.key,
    type: 'asset',
    position: { x: n.x, y: n.y },
    data: { view: n, isRoot: n.key === rootKey, onOpen } as unknown as Record<string, unknown>,
    // Dragging is allowed so a dense column can be untangled by hand; it changes nothing persistent.
    draggable: true,
  })), [view.nodes, rootKey, onOpen])

  const nextEdges = useMemo<RFEdge[]>(() => view.edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    // The field is the whole diagnostic value: "uses rock.png" vs "uses rock.png AS ITS NORMAL MAP".
    label: e.field,
    labelShowBg: false,
    labelStyle: { fill: 'rgb(138 138 160)', fontSize: 9 },
    style: { stroke: 'rgb(90 96 112)', strokeWidth: 1.2 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'rgb(90 96 112)' },
  })), [view.edges])

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(nextNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>(nextEdges)

  // Re-seeded whenever the view changes (a new root, a new depth, a library edit). Positions are derived,
  // never authored, so replacing them wholesale loses nothing the user meant to keep.
  useEffect(() => { setNodes(nextNodes) }, [nextNodes, setNodes])
  useEffect(() => { setEdges(nextEdges) }, [nextEdges, setEdges])
  // After the new nodes are laid out, not before — fitting the OLD extent leaves the new graph off-screen.
  useEffect(() => {
    const id = requestAnimationFrame(() => fitView({ padding: 0.18, duration: 200, maxZoom: 1.1 }))
    return () => cancelAnimationFrame(id)
  }, [rootKey, nextNodes, fitView])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => {
        const found = view.nodes.find(n => n.key === node.id)
        if (found) onSelect(found)
      }}
      onNodeDoubleClick={(_, node) => {
        const found = view.nodes.find(n => n.key === node.id)
        if (found) onOpen(found)
      }}
      // Read-only: this describes what the project IS, and an edge cannot be drawn into existence.
      nodesConnectable={false}
      elementsSelectable
      deleteKeyCode={null}
      proOptions={{ hideAttribution: true }}
      className='!bg-bg'
      minZoom={0.1}
      fitView
    >
      <Background color='#3a3f4b' gap={18} />
      <Controls className='!bg-surface-raised !border-border' showInteractive={false} />
      <MiniMap
        pannable zoomable
        className='!bg-surface-sunken'
        maskColor='rgba(0,0,0,0.5)'
        nodeColor={n => (n.id === rootKey ? '#8f8fff' : '#4b5563')}
      />
    </ReactFlow>
  )
}

export default function AssetGraphCanvas(props: AssetGraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}
