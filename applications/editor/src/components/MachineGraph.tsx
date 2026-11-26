import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  MarkerType, useNodesState, useEdgesState, useReactFlow,
  type Node as RFNode, type Edge as RFEdge, type Connection, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import RoutedEdge from '../features/animation/RoutedEdge'
import { insertPoint, type ReroutePoint } from '../features/animation/reroutes'
import { token } from '@cleo/app-kit/utils/cssTokens'
import { CloseIcon, JOINED_DIVIDER_CLASS, JOINED_GROUP_CLASS, MenuItem, cn } from '@cleo/app-kit/ui'
import { RerouteAcrossIcon, RerouteDownIcon, TidyIcon } from './graphIcons'

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
 * `RoutedEdge` draws it as a single line for one direction or two parallel lines for both. Deleting
 * an edge therefore removes both directions; dropping just one is the sidebar's job. This mirrors how
 * an author thinks about a pair of states rather than how the data is stored.
 *
 * ## Ported nodes
 *
 * A node with `ports` (a state GROUP standing for several states) draws a row per port, an input on its
 * left for each outside node its lines come from and an output on its right for each one they go to, plus
 * one handle each way for a new connection. A link that names a `sourceHandle`/`targetHandle` is drawn
 * handle to handle instead of floating along the borders, so a group's lines leave from the row that says
 * where they go.
 *
 * ## Forks
 *
 * A node with `shape: 'fork'` is drawn as a small pill with a diamond: a junction, not a place the machine is
 * in. It has the same two handles as a state, and the same floating lines.
 *
 * ## Reroute points
 *
 * A link's `points` route its line, as a Blueprint's reroute nodes do. Each is a small node of the canvas, so it is
 * dragged, selected and deleted as any node is, and its line follows it live. Double-clicking a line adds one where
 * it was clicked (`onAddLinkPoint`); hovering one shows its two buttons: which way the line passes through it, left
 * to right or top to bottom (`onToggleLinkPoint`), and delete (`onRemoveLinkPoints`). A caller without the callbacks
 * gets plain lines, and a double-click on a line does nothing.
 */

const NODE_W = 156

export type BadgeTone = 'dim' | 'warning' | 'primary'

export interface GraphNodeModel {
  id: string
  x: number
  y: number
  /** The title, when it is not the id (an "Any State" node whose id is `*`). */
  label?: string
  /** Transitions only LEAVE this node: no incoming handle (the "Any State" node). */
  sourceOnly?: boolean
  /** False keeps Delete from removing the node (its links still can be). Default true. */
  deletable?: boolean
  /** Small tags under the title — the triggers that enter a state directly. */
  chips?: string[]
  /** Drawn before each chip's text (the trigger bolt). */
  chipIcon?: ReactNode
  chipsTitle?: string
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
  /**
   * Draw this node as a GROUP: its rows of ports instead of a subtitle and badge. Inputs on the left,
   * outputs on the right; each port's `id` is its handle's.
   */
  ports?: { inputs: GraphPort[]; outputs: GraphPort[] }
  /**
   * Draw this node as a FORK: a small diamond-marked pill, not a state box (a junction lines go through). Its
   * subtitle is a one-line readout under the name.
   */
  shape?: 'fork'
  /** False: the right-click menu offers no "Set as entry" for this node (a group, a stand-in). */
  entryable?: boolean
  /** False keeps a drag from moving it for good: it springs back on the next render (a stand-in). */
  draggable?: boolean
  /** What "Delete …" calls this node in its menu, when not the canvas's noun. */
  noun?: string
  /**
   * What KIND of thing this node is, for styling only.
   *
   * The fuzzy canvas needs it: a variable and a rule are both nodes there, and telling them apart by
   * reading the title is exactly the work a graph is supposed to save. Nothing here interprets the
   * value beyond looking it up in {@link KIND_CLASS}.
   */
  kind?: GraphNodeKind
}

/** `proxy`: a stand-in for something drawn elsewhere (an outside state inside an opened group). */
export type GraphNodeKind = 'default' | 'accent' | 'muted' | 'proxy'

export interface GraphPort {
  /** The handle id. */
  id: string
  label: string
  title?: string
}

export interface GraphLinkModel {
  a: string
  b: string
  forward: boolean
  backward: boolean
  /** Short summary of the gate, drawn on the line. */
  label: string
  /** The edge's identity when `a|b` is not unique (several lines join one pair) or not what it stands for. */
  key?: string
  /** The node ids it joins, when they are not `a`/`b` (a stand-in node for an outside state). */
  nodeA?: string
  nodeB?: string
  /** Attach to these handles (a group's ports) instead of floating along the node borders. */
  sourceHandle?: string
  targetHandle?: string
  /** Drawn dashed: a group's own transition. */
  dashed?: boolean
  /** False keeps Delete from removing it (a line that stands for several transitions). Default true. */
  deletable?: boolean
  /** The points its line is routed through, from its first end (`a`'s node) to its second. */
  points?: ReroutePoint[]
}

/** A reroute point of a link, as the canvas reports it: the link, and the point's place among its points. */
export interface LinkPointRef {
  link: GraphLinkModel
  index: number
}

/** An extra row of the right-click menu: the caller's own action on a node. */
export interface GraphMenuItem {
  label: string
  icon?: ReactNode
  title?: string
  danger?: boolean
  disabled?: boolean
  onClick(): void
}

export interface MachineGraphProps {
  nodes: GraphNodeModel[]
  links: GraphLinkModel[]
  /** Highlighted as the state the machine is currently in. Drives the edge animation too. */
  activeId?: string | null
  selectedNode?: string | null
  selectedLink?: { a: string; b: string } | null
  /** Highlights the link with this `key`; wins over `selectedLink` for links that have a key. */
  selectedLinkKey?: string | null

  onMoveNode(id: string, x: number, y: number): void
  /**
   * Every node a drag moved, at once (a multi-selection dragged together). Without it, `onMoveNode` is
   * called once per node.
   */
  onMoveNodes?(moves: { id: string; x: number; y: number }[]): void
  onConnect(from: string, to: string): void
  /**
   * One call, so deleting a node and the edges it cascades is a single atomic update. `keys` are the
   * `key`s of the deleted links that have one.
   */
  onDelete(nodeIds: string[], links: [string, string][], keys?: string[]): void
  onSelectNode(id: string | null): void
  onSelectLink(a: string, b: string, key?: string): void
  /** A node was double-clicked (a group opens). */
  onNodeDoubleClick?(id: string): void
  /**
   * What the canvas is showing (a layer, a group opened in it). When it changes the view is fitted to the new
   * nodes: a group's states were laid out for the whole graph, so they open spread across it otherwise.
   */
  viewKey?: string
  /** Every node now selected, a multi-selection included (Ctrl+click, Shift+drag a box). */
  onSelectionChange?(ids: string[]): void
  /** Rows the right-click menu adds for a node, after the canvas's own. */
  menuItems?(id: string): GraphMenuItem[]
  onAddNode(x: number, y: number): void
  onSetEntry(id: string): void
  onRemoveNode(id: string): void

  /**
   * Whether this machine HAS an entry node.
   *
   * False for the goal and fuzzy canvases, which have no such concept — a goal graph arbitrates by
   * score and a fuzzy model fires every rule at once, so neither has a "starts here". The right-click
   * item and the entry badge are hidden rather than shown doing nothing.
   */
  allowEntry?: boolean
  /** What a node is called, for the menu and the hint. "state" unless a caller says otherwise. */
  nodeNoun?: string

  /** A line was double-clicked: add a reroute point at `index` among its points (see the class notes). */
  onAddLinkPoint?(ref: LinkPointRef, point: ReroutePoint): void
  /** Reroute points dragged: each one's new place (graph coordinates, its centre). */
  onMoveLinkPoints?(moves: (LinkPointRef & { x: number; y: number })[]): void
  /** A reroute point's way through turned: left to right, or top to bottom. */
  onToggleLinkPoint?(ref: LinkPointRef): void
  /** Reroute points deleted (its button, or Delete on the selected ones). */
  onRemoveLinkPoints?(refs: LinkPointRef[]): void

  /** Buttons for the toolbar's left end — the caller's own actions. */
  toolbar?: React.ReactNode
  /** Trailing hint text. Defaults to the interactions this canvas provides. */
  hint?: string
}

interface NodeData extends Record<string, unknown> {
  ports?: { inputs: GraphPort[]; outputs: GraphPort[] }
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
  kind: GraphNodeKind
  sourceOnly: boolean
  chips: string[]
  chipIcon?: ReactNode
  chipsTitle?: string
}

/** Body tint per node kind. Border colour still comes from selection/active/entry, which outrank it. */
const KIND_CLASS: Record<GraphNodeKind, string> = {
  default: 'bg-control',
  accent: 'bg-primary/25',
  muted: 'bg-surface-raised',
  proxy: 'bg-surface-sunken border-dashed opacity-80',
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
    <div className={`rounded border-2 ${border} ${KIND_CLASS[d.kind]} text-fg shadow-panel`} style={{ width: NODE_W }}>
      {!d.sourceOnly && <Handle type='target' position={Position.Left} className='!bg-primary !w-2 !h-2' />}
      <div className='px-2 py-1 border-b border-border flex items-center gap-1'>
        {d.isEntry && <span className='text-ui-2xs px-1 rounded bg-success text-fg' title='Entry state'>▶</span>}
        <span className='text-ui font-semibold truncate flex-1' title={d.label}>{d.label}</span>
      </div>
      <div className='px-2 py-1 text-ui-xs text-muted flex items-center justify-between gap-1'>
        <span className={`truncate ${d.subtitleMissing ? 'text-danger-fg' : ''}`} title={d.subtitle}>
          {d.glyph && <span className='mr-1 text-primary' title={d.glyphTitle}>{d.glyph}</span>}
          {d.subtitle}
        </span>
        {d.badge && (
          <span className={`shrink-0 ${TONE_CLASS[d.badgeTone]}`} title={d.badgeTitle}>{d.badge}</span>
        )}
      </div>
      {d.chips.length > 0 && (
        <div className='px-2 pb-1 flex flex-wrap gap-1' title={d.chipsTitle}>
          {d.chips.map(c => (
            <span key={c} className='inline-flex items-center gap-0.5 text-ui-2xs px-1 rounded bg-primary/25 text-fg max-w-full'>
              {d.chipIcon}<span className='truncate'>{c}</span>
            </span>
          ))}
        </div>
      )}
      <Handle type='source' position={Position.Right} className='!bg-primary !w-2 !h-2' />
    </div>
  )
}

/**
 * A group: its name and member count, then a row per port. Inputs sit on the left edge, outputs on the right;
 * the header's own pair of handles takes a NEW connection (into the group, out of the group).
 */
function GroupNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  const border = d.active ? 'border-highlight' : selected ? 'border-selected' : 'border-primary/60'
  const inputs = d.ports?.inputs ?? [], outputs = d.ports?.outputs ?? []
  const rows = Math.max(inputs.length, outputs.length)
  const handle = '!bg-primary !w-2 !h-2'
  return (
    <div className={`rounded-md border-2 ${border} bg-surface-raised text-fg shadow-panel`} style={{ width: NODE_W + 24 }}>
      <div className='relative px-2 py-1 border-b border-border flex items-center gap-1 bg-primary/15'>
        <Handle type='target' id='in' position={Position.Left} className={handle} title='Into the group: enters its entry state' />
        <GroupGlyph />
        <span className='text-ui font-semibold truncate flex-1' title={d.label}>{d.label}</span>
        <span className='text-ui-2xs text-dim shrink-0' title={d.subtitle}>{d.badge}</span>
        <Handle type='source' id='out' position={Position.Right} className={handle} title='Out of the group: fires from any of its states' />
      </div>
      {rows === 0
        ? <div className='px-2 py-1 text-ui-xs text-dim'>{d.subtitle}</div>
        : Array.from({ length: rows }, (_, k) => {
            const i = inputs[k], o = outputs[k]
            return (
              <div key={k} className='relative flex items-center gap-1 px-2 text-ui-2xs text-muted' style={{ height: PORT_ROW }}>
                <span className='flex-1 truncate' title={i?.title}>{i?.label ?? ''}</span>
                <span className='flex-1 truncate text-right' title={o?.title}>{o?.label ?? ''}</span>
                {i && <Handle type='target' id={i.id} position={Position.Left} className='!bg-control-hover !w-1.5 !h-1.5' />}
                {o && <Handle type='source' id={o.id} position={Position.Right} className='!bg-control-hover !w-1.5 !h-1.5' />}
              </div>
            )
          })}
    </div>
  )
}

/** Height of one port row: the handle sits in the middle of it. */
const PORT_ROW = 16

/** Width of a fork's pill. */
const FORK_W = 116

/** A fork: a diamond and its name, a line under it saying how many come in and go out. */
function ForkNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  const border = selected ? 'border-selected' : d.isEntry ? 'border-success' : 'border-warning/70'
  const handle = '!bg-primary !w-2 !h-2'
  return (
    <div className={`rounded-full border-2 ${border} bg-surface-raised text-fg shadow-panel`} style={{ width: FORK_W }}>
      <Handle type='target' position={Position.Left} className={handle} />
      <div className='px-2.5 py-0.5 flex items-center gap-1'>
        {d.isEntry && <span className='text-ui-2xs text-success' title='Entry of its group'>▶</span>}
        <ForkGlyph />
        <span className='text-ui-xs font-semibold truncate flex-1' title={d.label}>{d.label}</span>
      </div>
      {d.subtitle && <div className='px-2.5 pb-0.5 -mt-0.5 text-ui-2xs text-dim truncate text-center' title={d.subtitle}>{d.subtitle}</div>}
      <Handle type='source' position={Position.Right} className={handle} />
    </div>
  )
}

/** A diamond: a fork. */
export const ForkGlyph = () => (
  <svg viewBox='0 0 24 24' className='w-3 h-3 shrink-0 text-warning' fill='none' stroke='currentColor' strokeWidth='2.2' aria-hidden>
    <path d='M12 4l8 8-8 8-8-8z' />
  </svg>
)

/** Stacked boxes: a group of states. */
export const GroupGlyph = () => (
  <svg viewBox='0 0 24 24' className='w-3.5 h-3.5 shrink-0 text-primary' fill='none' stroke='currentColor' strokeWidth='1.8' aria-hidden>
    <rect x='3' y='7' width='13' height='10' rx='2' /><path d='M8 4h11a2 2 0 0 1 2 2v9' />
  </svg>
)

/** Half a reroute point's size: its node's top-left is the point less this. */
const REROUTE_R = 6
/** A reroute point's node id: the line's id, then its place among the line's points. */
const REROUTE_PREFIX = '@@reroute:'
const rerouteId = (lineId: string, index: number) => `${REROUTE_PREFIX}${lineId}#${index}`
const isReroute = (id: string) => id.startsWith(REROUTE_PREFIX)
const rerouteOf = (id: string): { lineId: string; index: number } => {
  const cut = id.lastIndexOf('#')
  return { lineId: id.slice(REROUTE_PREFIX.length, cut), index: Number(id.slice(cut + 1)) }
}

interface RerouteData extends Record<string, unknown> {
  axis: 'h' | 'v'
  onToggle?(): void
  onRemove?(): void
}

/**
 * A reroute point: a dot its line passes through. Hovered (or selected) it shows which way the line passes through it,
 * a button that turns it, and one that deletes it.
 */
function RerouteNode({ data, selected }: NodeProps) {
  const d = data as RerouteData
  const [hover, setHover] = useState(false)
  const across = d.axis !== 'v'
  const button = 'flex items-center justify-center px-1 py-0.5 text-muted hover:bg-surface-raised hover:text-fg'
  return (
    <div className='relative' style={{ width: REROUTE_R * 2, height: REROUTE_R * 2 }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className={cn('w-full h-full rounded-full border-2 shadow-panel', selected ? 'border-selected bg-selected/50' : 'border-control-hover bg-surface-raised')}
        title={across ? 'Reroute point: the line passes left to right' : 'Reroute point: the line passes top to bottom'} />
      {(hover || selected) && (d.onToggle || d.onRemove) && (
        // Padded down to the dot, so the pointer can reach the buttons without leaving the point.
        <div className='nodrag nopan absolute left-1/2 -translate-x-1/2 bottom-full pb-1'>
          <div className={cn(JOINED_GROUP_CLASS, 'bg-surface shadow-panel')}>
            {d.onToggle && (
              <button type='button' className={button} onClick={e => { e.stopPropagation(); d.onToggle?.() }}
                title={across ? 'Left to right: make the line pass top to bottom' : 'Top to bottom: make the line pass left to right'}>
                <span className='w-3.5 h-3.5'>{across ? <RerouteAcrossIcon /> : <RerouteDownIcon />}</span>
              </button>
            )}
            {d.onRemove && (
              <button type='button' className={cn(button, JOINED_DIVIDER_CLASS)} onClick={e => { e.stopPropagation(); d.onRemove?.() }}
                title='Delete this reroute point'>
                <span className='w-3.5 h-3.5'><CloseIcon /></span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Tidy: a toolbar button that lays the canvas out (the caller's `onTidy`, handed every node's measured size), then
 * fits the view to it. Rendered inside the canvas's toolbar, where it can read the measured nodes.
 */
export function GraphTidyButton({ onTidy, className, title }: {
  onTidy(sizes: Record<string, { w: number; h: number }>): void
  className?: string
  title?: string
}) {
  const { getNodes, fitView } = useReactFlow()
  return (
    <button type='button' className={className} title={title ?? 'Tidy: lay the graph out in columns'}
      onClick={() => {
        const sizes: Record<string, { w: number; h: number }> = {}
        for (const n of getNodes()) {
          if (isReroute(n.id)) continue
          sizes[n.id] = { w: n.measured?.width ?? NODE_W, h: n.measured?.height ?? 52 }
        }
        onTidy(sizes)
        // Once the new positions have reached the canvas (the caller's state, then the nodes rebuilt from it).
        window.setTimeout(() => { void fitView({ padding: 0.2, duration: 200 }) }, 120)
      }}>
      <span className='w-4 h-4'><TidyIcon /></span>
    </button>
  )
}

const nodeTypes = { state: GraphNode, group: GroupNode, fork: ForkNode, reroute: RerouteNode }
const edgeTypes = { transition: RoutedEdge }

function Flow(props: MachineGraphProps) {
  const {
    nodes: model, links, activeId = null, selectedNode = null, selectedLink = null, selectedLinkKey = null,
    onMoveNode, onMoveNodes, onConnect, onDelete, onSelectNode, onSelectLink, onAddNode, onSetEntry, onRemoveNode,
    onNodeDoubleClick, onSelectionChange, menuItems, toolbar, hint, allowEntry = true, nodeNoun = 'state', viewKey,
    onAddLinkPoint, onMoveLinkPoints, onToggleLinkPoint, onRemoveLinkPoints,
  } = props
  // A link's line id (its edge's), and the link a line id names: reroute points are reported by link.
  const lineIdOf = (l: GraphLinkModel) => l.key ?? `${l.a}|${l.b}`
  const lineById = useMemo(() => new Map(links.map(l => [lineIdOf(l), l])), [links])

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([])
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  // xyflow takes these as JS colour strings, so they are read off the design tokens (lazily: on mount).
  const colors = useMemo(() => ({
    grid: token('--control'),
    minimapMask: token('--scrim', 0.5),
    minimapNode: token('--control-hover'),
  }), [])
  const { screenToFlowPosition, fitView } = useReactFlow()

  // A new view (another layer, a group opened or left): fit it, once its nodes have been measured.
  const viewKeyRef = useRef(viewKey)
  useEffect(() => {
    if (viewKeyRef.current === viewKey) return
    viewKeyRef.current = viewKey
    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => { void fitView({ padding: 0.2, duration: 200 }) }) })
    return () => cancelAnimationFrame(raf)
  }, [viewKey, fitView])

  useEffect(() => {
    // A rebuild keeps a multi-selection that holds the selected node (a group drag just committed);
    // a selection moved elsewhere from outside the canvas starts afresh.
    setNodes(prev => {
      const was = new Set(prev.filter(n => n.selected).map(n => n.id))
      const keep = selectedNode !== null && was.has(selectedNode)
      // The reroute points: a node each, centred on the point, kept selected across a rebuild (a drag just committed).
      const reroutes: RFNode[] = links.flatMap(l => (l.points ?? []).map((p, i) => {
        const id = rerouteId(lineIdOf(l), i)
        const ref = { link: l, index: i }
        return {
          id,
          type: 'reroute',
          position: { x: p.x - REROUTE_R, y: p.y - REROUTE_R },
          selected: was.has(id),
          connectable: false,
          zIndex: 1000,
          data: {
            axis: p.axis === 'v' ? 'v' : 'h',
            onToggle: onToggleLinkPoint ? () => onToggleLinkPoint(ref) : undefined,
            onRemove: onRemoveLinkPoints ? () => onRemoveLinkPoints([ref]) : undefined,
          } as RerouteData,
        }
      }))
      return [...model.map(n => ({
      id: n.id,
      type: n.ports ? 'group' : n.shape === 'fork' ? 'fork' : 'state',
      position: { x: n.x, y: n.y },
      selected: selectedNode === n.id || (keep && was.has(n.id)),
      deletable: n.deletable ?? true,
      draggable: n.draggable ?? true,
      data: {
        ports: n.ports,
        label: n.label ?? n.id,
        subtitle: n.subtitle ?? '',
        subtitleMissing: !!n.subtitleMissing,
        glyph: n.glyph,
        glyphTitle: n.glyphTitle,
        badge: n.badge,
        badgeTitle: n.badgeTitle,
        badgeTone: n.badgeTone ?? 'dim',
        isEntry: !!n.isEntry,
        active: n.id === activeId,
        kind: n.kind ?? 'default',
        sourceOnly: !!n.sourceOnly,
        chips: n.chips ?? [],
        chipIcon: n.chipIcon,
        chipsTitle: n.chipsTitle,
      } as NodeData,
    })), ...reroutes]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, selectedNode, links])

  useEffect(() => {
    // Markers must stay on the edge: xyflow resolves them into `url(#…)` strings for the custom edge.
    const arrow = { type: MarkerType.ArrowClosed, width: 14, height: 14 }
    const selectedStroke = token('--selected')
    const labelFill = token('--text')
    const labelBg = token('--bg', 0.85)
    setEdges(links.map(l => {
      const isSelected = l.key !== undefined && selectedLinkKey !== null
        ? selectedLinkKey === l.key
        : !!selectedLink
          && ((selectedLink.a === l.a && selectedLink.b === l.b)
            || (selectedLink.a === l.b && selectedLink.b === l.a))
      const source = l.nodeA ?? l.a, target = l.nodeB ?? l.b
      const ported = l.sourceHandle !== undefined || l.targetHandle !== undefined
      const lineId = lineIdOf(l)
      const points = l.points ?? []
      return {
        id: lineId,
        // A ported line runs handle to handle; the rest float along the borders. Either through its points.
        type: 'transition',
        source,
        target,
        ...(l.sourceHandle !== undefined ? { sourceHandle: l.sourceHandle } : {}),
        ...(l.targetHandle !== undefined ? { targetHandle: l.targetHandle } : {}),
        label: l.label,
        selected: isSelected,
        deletable: l.deletable ?? true,
        markerEnd: l.forward ? arrow : undefined,
        markerStart: l.backward ? arrow : undefined,
        data: {
          a: l.a, b: l.b, key: l.key, forward: l.forward, backward: l.backward, ported,
          points, pointIds: points.map((_, i) => rerouteId(lineId, i)), pointRadius: REROUTE_R,
        },
        // Light up whichever direction could actually fire from where the machine currently is.
        animated: activeId === source ? l.forward : activeId === target ? l.backward : false,
        style: { stroke: isSelected ? selectedStroke : undefined, ...(l.dashed ? { strokeDasharray: '5 4' } : {}) },
        labelStyle: { fontSize: 10, fill: labelFill },
        labelBgStyle: { fill: labelBg },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
      }
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links, selectedLink, selectedLinkKey, activeId])

  // Patched in place rather than rebuilt, so the highlight cannot reset a drag in progress.
  useEffect(() => {
    setNodes(nds => nds.map(n => ({ ...n, data: { ...(n.data as NodeData), active: n.id === activeId } })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // Every node the drag moved: a multi-selection dragged together moves them all, not just the one grabbed.
  const handleDragStop = useCallback((_: unknown, node: RFNode, dragged?: RFNode[]) => {
    const all = dragged?.length ? dragged : [node]
    // Reroute points are reported by their line, at their centres.
    const points: (LinkPointRef & { x: number; y: number })[] = []
    for (const n of all) {
      if (!isReroute(n.id)) continue
      const { lineId, index } = rerouteOf(n.id)
      const link = lineById.get(lineId)
      if (link) points.push({ link, index, x: Math.round(n.position.x + REROUTE_R), y: Math.round(n.position.y + REROUTE_R) })
    }
    if (points.length) onMoveLinkPoints?.(points)
    const moves = all.filter(n => !isReroute(n.id)).map(n => ({ id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) }))
    if (!moves.length) return
    if (onMoveNodes) onMoveNodes(moves)
    else for (const m of moves) onMoveNode(m.id, m.x, m.y)
  }, [onMoveNode, onMoveNodes, onMoveLinkPoints, lineById])

  const handleConnect = useCallback((c: Connection) => {
    // A self-transition can never fire and draws as an invisible stub behind the node, so refuse it
    // rather than leave dead data around.
    if (!c.source || !c.target || c.source === c.target) return
    onConnect(c.source, c.target)
  }, [onConnect])

  const handleDelete = useCallback(({ nodes: dn, edges: de }: { nodes: RFNode[]; edges: RFEdge[] }) => {
    // Selected reroute points go on their own: Delete takes the points, not the line.
    const points: LinkPointRef[] = []
    for (const n of dn) {
      if (!isReroute(n.id)) continue
      const { lineId, index } = rerouteOf(n.id)
      const link = lineById.get(lineId)
      if (link) points.push({ link, index })
    }
    if (points.length) onRemoveLinkPoints?.(points)
    const ids = dn.filter(n => !isReroute(n.id)).map(n => n.id)
    // A keyed line says exactly what it stands for, so it is reported by key alone.
    const keys = de.map(e => (e.data as { key?: string })?.key).filter((k): k is string => typeof k === 'string')
    const removed = de
      .filter(e => typeof (e.data as { key?: string })?.key !== 'string')
      .map(e => [(e.data as { a?: string })?.a, (e.data as { b?: string })?.b] as [string, string])
      .filter(([a, b]) => typeof a === 'string' && typeof b === 'string')
    if (ids.length || removed.length || keys.length) onDelete(ids, removed, keys)
  }, [onDelete, onRemoveLinkPoints, lineById])

  const handleNodeContextMenu = useCallback((e: React.MouseEvent, node: RFNode) => {
    e.preventDefault()
    if (isReroute(node.id)) return
    onSelectNode(node.id)
    setMenu({ id: node.id, x: e.clientX, y: e.clientY })
  }, [onSelectNode])

  const handlePaneDoubleClick = useCallback((e: React.MouseEvent) => {
    // A double-click on a line (or a point) is the line's: it never adds a state under it.
    if ((e.target as Element | null)?.closest?.('.react-flow__edge, .react-flow__node-reroute')) return
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    onAddNode(Math.round(p.x - NODE_W / 2), Math.round(p.y - 20))
  }, [screenToFlowPosition, onAddNode])

  // Double-click a line: a reroute point where it was clicked, on the stretch of the line nearest the click.
  const { getInternalNode } = useReactFlow()
  const handleEdgeDoubleClick = useCallback((e: React.MouseEvent, edge: RFEdge) => {
    e.stopPropagation()
    const link = lineById.get(edge.id)
    if (!link || !onAddLinkPoint) return
    const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const centre = (id: string) => {
      const n = getInternalNode(id)
      return n ? { x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2, y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2 } : at
    }
    const { index, point } = insertPoint(link.points ?? [], centre(edge.source), centre(edge.target), at)
    onAddLinkPoint({ link, index }, point)
  }, [lineById, onAddLinkPoint, screenToFlowPosition, getInternalNode])

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
        onNodeClick={(_, node) => { if (!isReroute(node.id)) onSelectNode(node.id); setMenu(null) }}
        onNodeDoubleClick={(e, node) => {
          // A point's double-click is its own: never a state added under it.
          if (isReroute(node.id)) { e.stopPropagation(); return }
          if (!onNodeDoubleClick) return
          // Not also a double-click on the canvas, which would add a state under the pointer.
          e.stopPropagation()
          onNodeDoubleClick(node.id)
        }}
        onSelectionChange={onSelectionChange ? ({ nodes: sel }) => onSelectionChange(sel.filter(n => !isReroute(n.id)).map(n => n.id)) : undefined}
        onEdgeClick={(_, edge) => {
          const { a, b, key } = (edge.data ?? {}) as { a?: string; b?: string; key?: string }
          if (a && b) onSelectLink(a, b, key)
          setMenu(null)
        }}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        zoomOnDoubleClick={false}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneClick={() => { onSelectNode(null); setMenu(null) }}
        deleteKeyCode={['Delete', 'Backspace']}
        fitView
        proOptions={{ hideAttribution: true }}
        className='!bg-bg'>
        <Background color={colors.grid} gap={18} />
        <Controls className='!bg-surface-raised !border-border' showInteractive={false} />
        <MiniMap pannable zoomable className='!bg-surface-sunken' maskColor={colors.minimapMask}
          nodeColor={n => (isReroute(n.id) ? 'transparent' : colors.minimapNode)} />
      </ReactFlow>

      {/* Bounded by the canvas: what does not fit gives way (the hint truncates, a caller's scroller scrolls). */}
      <div data-cleo-overlay className='absolute top-2 left-2 right-2 z-20 flex items-center gap-2 pointer-events-none [&>*]:pointer-events-auto'
        onMouseDown={e => e.stopPropagation()}>
        {toolbar}
        <span className='text-ui-xs text-dim ml-1 min-w-0 truncate' title={hint}>
          {hint ?? `drag handle → handle to connect · right-click a ${nodeNoun} · Del to remove`}
        </span>
      </div>

      {menu && entry && (
        <NodeMenu
          id={entry.label ?? menu.id} x={menu.x} y={menu.y} isEntry={!!entry.isEntry}
          allowEntry={allowEntry && entry.entryable !== false} noun={entry.noun ?? nodeNoun}
          deletable={entry.deletable !== false}
          extra={menuItems?.(menu.id) ?? []}
          onSetEntry={() => { onSetEntry(menu.id); setMenu(null) }}
          onRemove={() => { onRemoveNode(menu.id); setMenu(null) }}
          onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

/** Right-click menu on a node. Positioned in client space, so it is a sibling of the graph, not a child. */
function NodeMenu(
  { id, x, y, isEntry, allowEntry, noun, deletable, extra, onSetEntry, onRemove, onClose }: {
    id: string; x: number; y: number; isEntry: boolean; allowEntry: boolean; noun: string
    deletable: boolean; extra: GraphMenuItem[]
    onSetEntry(): void; onRemove(): void; onClose(): void
  },
) {
  return (
    <>
      {/* Catch the next click anywhere so the menu behaves like a menu. */}
      <div className='fixed inset-0 z-30' onMouseDown={onClose}
        onContextMenu={e => { e.preventDefault(); onClose() }} />
      <div data-cleo-overlay
        className='fixed z-40 min-w-[132px] rounded border border-border bg-surface-raised shadow-panel p-0.5'
        style={{ left: x, top: y }}
        onMouseDown={e => e.stopPropagation()}>
        <div className='px-2 py-1 text-ui-xs uppercase tracking-wide text-dim truncate'>{id}</div>
        {allowEntry && (
          <MenuItem className='disabled:hover:bg-transparent' disabled={isEntry}
            title={isEntry ? 'Already the entry state' : 'The machine starts here'}
            onClick={onSetEntry}>
            {isEntry ? '▶ Entry state' : 'Set as entry'}
          </MenuItem>
        )}
        {extra.map(item => (
          <MenuItem key={item.label} icon={item.icon} title={item.title} danger={item.danger} disabled={item.disabled}
            className='disabled:hover:bg-transparent'
            onClick={() => { item.onClick(); onClose() }}>
            {item.label}
          </MenuItem>
        ))}
        {deletable && <MenuItem danger onClick={onRemove}>Delete {noun}</MenuItem>}
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
