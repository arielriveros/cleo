import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, BaseEdge,
  useNodesState, useReactFlow, useStore, getViewportForBounds,
  type Node as RFNode, type Edge as RFEdge, type NodeProps, type EdgeProps, type NodeHandle,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { isUINodeType } from 'cleo';
import { cn } from '@cleo/app-kit/ui'
import { token } from '@cleo/app-kit/utils/cssTokens'
import {
  CARD_H, CARD_W, STACK_INDENT, V_GAP, layoutSceneGraph, nearestInDirection, zoneAt,
  type Direction, type DropZone, type GraphCard, type NodeDescription, type SceneGraphLayout,
} from './sceneGraphLayout'
import { Chevron, NodeControls, RenameField, typeIconFor } from './sceneNodeParts'

// The Scene panel's Graph view: the same hierarchy as the tree, drawn top-down with xyflow.
//
// Everything the tree does happens here too, through the SAME handlers in SceneInspector: selection,
// rename, delete, collapse, re-parent and re-order, script and new-node drops, and dragging a node out to
// the Assets panel or a node-reference field. xyflow is used as a canvas only: its own node dragging,
// selection, connecting and keyboard handling are all off. Moves are native HTML5 drags, so one gesture
// keeps reaching every drop target outside the panel, exactly as a tree row's does.

export interface GraphMove { dragIds: string[]; targetId: string; zone: DropZone }

export interface SceneGraphViewProps {
  /** The tree to draw, already filtered; null when the filter matches nothing. */
  root: NodeDescription | null;
  /** The filter term, so the view can refit when it changes. */
  filter: string;
  collapsed: ReadonlySet<string>;
  onToggleCollapse: (id: string) => void;
  selectedIds: ReadonlySet<string>;
  /** The node the engine has selected: the one kept in view. */
  primaryId: string | null;
  onSelect: (ids: string[], primary: string | null) => void;
  editingId: string | null;
  onStartRename: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onCancelRename: () => void;
  canEdit: (id: string) => boolean;
  /** False while nothing may be restructured at all (Play, Sequencer mode). */
  canMove: boolean;
  onMove: (move: GraphMove) => void;
}

/** The transient state a card renders from, kept out of node data so the nodes array only changes with the layout. */
interface GraphUi {
  selectedIds: ReadonlySet<string>;
  editingId: string | null;
  drop: { id: string; zone: DropZone } | null;
  canEdit: (id: string) => boolean;
  onCardClick: (id: string, event: React.MouseEvent) => void;
  onStartRename: (id: string) => void;
  onSubmitRename: (id: string, name: string) => void;
  onCancelRename: (byKey: boolean) => void;
  onToggleCollapse: (id: string) => void;
  onCardDragStart: (id: string, event: React.DragEvent) => void;
  onCardDragEnd: () => void;
}

const GraphUiContext = createContext<GraphUi | null>(null);

// Handles are invisible: nothing connects here, they only fix where edges meet a card. They are declared
// on the node as well (HANDLES) so an edge to a card that onlyRenderVisibleElements has not mounted still
// knows its endpoints; the two sets must agree, which is why both are 1px and centred on the border.
const HANDLE_CLASS = '!w-px !h-px !min-w-0 !min-h-0 !border-0 !bg-transparent !opacity-0';
const HANDLES: NodeHandle[] = [
  { id: 'top', type: 'target', position: Position.Top, x: CARD_W / 2 - 0.5, y: -0.5, width: 1, height: 1 },
  { id: 'left', type: 'target', position: Position.Left, x: -0.5, y: CARD_H / 2 - 0.5, width: 1, height: 1 },
  { id: 'bottom', type: 'source', position: Position.Bottom, x: CARD_W / 2 - 0.5, y: CARD_H - 0.5, width: 1, height: 1 },
];

type CardData = { card: GraphCard };

function SceneGraphCard({ data }: NodeProps) {
  const { card } = data as unknown as CardData;
  const ui = useContext(GraphUiContext)!;
  const desc = card.desc;
  const selected = ui.selectedIds.has(desc.id);
  const editing = ui.editingId === desc.id;
  const zone = ui.drop?.id === desc.id ? ui.drop.zone : null;
  // UI elements are tinted so a HUD subtree is distinguishable from world geometry; a SELECTED card drops
  // the tint for the standard selection fill, exactly as a tree row does.
  const isUI = isUINodeType(desc.type);
  const TypeIcon = typeIconFor(desc.type);

  return (
    <div
      id={desc.id}
      draggable={!editing}
      onDragStart={(e) => ui.onCardDragStart(desc.id, e)}
      onDragEnd={ui.onCardDragEnd}
      onClick={(e) => ui.onCardClick(desc.id, e)}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return; // a fast second click on the eye is not a rename
        if (ui.canEdit(desc.id)) ui.onStartRename(desc.id);
      }}
      style={{ width: CARD_W, height: CARD_H }}
      // `scene-item` + `id` are what SceneInspector's script / new-node drop finds the target by. `nopan`
      // keeps xyflow's pan gesture off the card, which would otherwise cancel the native dragstart.
      // `pointer-events-auto`: xyflow gives a node that is neither selectable nor draggable
      // `pointer-events: none`, which would send every click and hover through to the pane.
      className={cn(
        'scene-item nopan pointer-events-auto group relative flex items-center pr-[6px] rounded-md border whitespace-nowrap',
        selected ? 'bg-primary/40 border-primary text-fg cursor-default'
          : zone === 'inside' ? 'bg-primary/20 border-highlight cursor-pointer'
            : cn('bg-surface-raised border-fg/[0.12] hover:bg-control hover:border-fg/20 cursor-pointer', isUI ? 'text-node-ui' : 'text-fg'),
      )}>
      <Handle type='target' id='top' position={Position.Top} isConnectable={false} className={HANDLE_CLASS} />
      <Handle type='target' id='left' position={Position.Left} isConnectable={false} className={HANDLE_CLASS} />
      <Handle type='source' id='bottom' position={Position.Bottom} isConnectable={false} className={HANDLE_CLASS} />
      {/* Always occupied, so the icons of a stacked column line up whether or not a card can be opened. */}
      <span className='flex items-center justify-center w-[16px] self-stretch shrink-0 text-muted hover:text-fg'
            title={card.hasChildren ? (card.collapsed ? `Expand (${card.hiddenCount} hidden)` : 'Collapse') : undefined}
            onClick={(e) => { e.stopPropagation(); if (card.hasChildren) ui.onToggleCollapse(desc.id); }}
            onDoubleClick={(e) => e.stopPropagation()}>
        { card.hasChildren && <Chevron open={!card.collapsed} /> }
      </span>
      {/* Dormant nodes (spawnOnStart off) read as "present but asleep", as in the tree. */}
      <div className={cn('flex items-center min-w-0 flex-1', desc.spawnOnStart === false && 'opacity-50')}
           title={desc.spawnOnStart === false ? 'Dormant until a script spawns it' : undefined}>
        { TypeIcon && <span className='inline-flex w-4 h-4 mr-1.5 shrink-0 items-center justify-center'><TypeIcon /></span> }
        { editing
          ? <RenameField initial={desc.name} className='nodrag nopan nowheel'
                         onSubmit={(name) => ui.onSubmitRename(desc.id, name)} onCancel={ui.onCancelRename} />
          : <span className='truncate'>{desc.name}</span> }
        { card.collapsed && !editing &&
          <span className='ml-1 shrink-0 rounded px-1 text-ui-2xs leading-[14px] bg-fg/[0.08] text-muted'>+{card.hiddenCount}</span> }
      </div>
      <NodeControls data={desc} />
      {/* Between-siblings drop cursor: a capped bar on the side the node would land, in the indigo accent
          of the tree's own cursor. Spread siblings sit left/right of each other; stacked ones above/below. */}
      { (zone === 'before' || zone === 'after') &&
        <span aria-hidden className={cn('absolute pointer-events-none rounded-full bg-highlight',
          card.stacked
            ? cn('left-1 right-1 h-[2px]', zone === 'before' ? '-top-[4px]' : '-bottom-[4px]')
            : cn('top-1 bottom-1 w-[2px]', zone === 'before' ? '-left-[5px]' : '-right-[5px]'))} /> }
    </div>
  );
}

/** An orthogonal polyline with rounded corners: every child of a parent shares one bus, every stack one trunk. */
function roundedPath(points: { x: number; y: number }[], radius: number): string {
  const pts = points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const inX = b.x - Math.sign(b.x - a.x) * r, inY = b.y - Math.sign(b.y - a.y) * r;
    const outX = b.x + Math.sign(c.x - b.x) * r, outY = b.y + Math.sign(c.y - b.y) * r;
    d += ` L ${inX} ${inY} Q ${b.x} ${b.y} ${outX} ${outY}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

function ElbowEdge({ id, sourceX, sourceY, targetX, targetY, targetPosition, style }: EdgeProps) {
  const busY = sourceY + V_GAP / 2;
  const points = targetPosition === Position.Left
    ? [{ x: sourceX, y: sourceY }, { x: sourceX, y: busY }, { x: targetX - STACK_INDENT / 2, y: busY },
       { x: targetX - STACK_INDENT / 2, y: targetY }, { x: targetX, y: targetY }]
    : [{ x: sourceX, y: sourceY }, { x: sourceX, y: busY }, { x: targetX, y: busY }, { x: targetX, y: targetY }];
  return <BaseEdge id={id} path={roundedPath(points, 4)} style={style} />;
}

const nodeTypes = { sceneNode: SceneGraphCard };
const edgeTypes = { elbow: ElbowEdge };

/**
 * The edge colour: halfway from the canvas to the dim text colour, but OPAQUE. Edges overlap along
 * a shared bus and trunk, and an alpha stroke would draw those stretches brighter than the rest.
 */
function edgeColor(): string {
  const channels = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).map(Number);
  const a = channels('--text-dim'), b = channels('--surface-sunken');
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some(Number.isNaN)) return token('--control-hover');
  return `rgb(${a.map((v, i) => Math.round(b[i] + (v - b[i]) * 0.45)).join(' ')})`;
}

const MIN_ZOOM = 0.1;

const ARROW_KEYS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

function Canvas(props: SceneGraphViewProps) {
  const { root, filter, collapsed, selectedIds, primaryId, onSelect, editingId, canEdit, canMove, onMove } = props;
  const { setViewport, setCenter, getViewport } = useReactFlow();
  const paneWidth = useStore(s => s.width);
  const paneHeight = useStore(s => s.height);
  const containerRef = useRef<HTMLDivElement>(null);

  const layout = useMemo<SceneGraphLayout | null>(() => (root ? layoutSceneGraph(root, collapsed) : null), [root, collapsed]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const rfNodes = useMemo<RFNode[]>(() => (layout?.cards ?? []).map(card => ({
    id: card.id,
    type: 'sceneNode',
    position: { x: card.x, y: card.y },
    data: { card } as unknown as Record<string, unknown>,
    width: CARD_W,
    height: CARD_H,
    // Known up front, so a card onlyRenderVisibleElements never mounted still counts for Fit View.
    measured: { width: CARD_W, height: CARD_H },
    handles: HANDLES,
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
  })), [layout]);

  // Held in xyflow's own node state rather than passed straight through: fitView (the Controls button,
  // the filter's fit) is queued as a node update, and with no onNodesChange to apply it the fit would sit
  // queued until some later rebuild, then fire out of nowhere.
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(rfNodes);
  useEffect(() => { setNodes(rfNodes); }, [rfNodes, setNodes]);

  const edgeStyle = useMemo(() => ({ stroke: edgeColor(), strokeWidth: 1.2 }), []);
  const rfEdges = useMemo<RFEdge[]>(() => (layout?.links ?? []).map(l => ({
    id: l.id,
    source: l.source,
    target: l.target,
    sourceHandle: 'bottom',
    targetHandle: l.targetHandle,
    type: 'elbow',
    selectable: false,
    focusable: false,
    style: edgeStyle,
  })), [layout, edgeStyle]);

  // --- keeping the right part in view ---------------------------------------------------------------

  /** The selected card if there is one, else the root at the top centre; always at 1:1. */
  const frameHome = useCallback(() => {
    const l = layoutRef.current;
    if (!l || !paneWidth) return;
    const target = (primaryId && l.byId.get(primaryId)) || l.byId.get(l.rootId);
    if (!target) return;
    if (target.id === l.rootId) setViewport({ x: paneWidth / 2 - (target.x + CARD_W / 2), y: 24 - target.y, zoom: 1 });
    else void setCenter(target.x + CARD_W / 2, target.y + CARD_H / 2, { zoom: 1 });
  }, [paneWidth, primaryId, setViewport, setCenter]);

  /**
   * Frames every card, from the layout rather than through xyflow's fitView: that one is queued behind a
   * node-state update and, right after a filter change, can still measure the previous graph.
   */
  const fitLayout = useCallback(() => {
    const l = layoutRef.current;
    if (!l || !l.cards.length || !paneWidth || !paneHeight) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of l.cards) {
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + CARD_W); maxY = Math.max(maxY, c.y + CARD_H);
    }
    const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    void setViewport(getViewportForBounds(bounds, paneWidth, paneHeight, MIN_ZOOM, 1, 0.15), { duration: 150 });
  }, [paneWidth, paneHeight, setViewport]);

  // Once per tree root (a scene or template switch), when the pane has a size to centre in.
  const framedRootRef = useRef<string | null>(null);
  const keptInViewRef = useRef<string | null>(null);
  useEffect(() => {
    if (!layout || !paneWidth || !paneHeight || framedRootRef.current === layout.rootId) return;
    framedRootRef.current = layout.rootId;
    keptInViewRef.current = primaryId;
    frameHome();
  }, [layout, paneWidth, paneHeight, primaryId, frameHome]);

  // A filter fits what it matches; clearing it goes back to the selection. After the new nodes are in
  // the store, not before: fitting the OLD extent frames the wrong graph. The request is held in a ref
  // until a frame actually runs it, so a re-render cancelling the frame only postpones it.
  const lastFilterRef = useRef(filter.trim());
  const pendingFrameRef = useRef<'fit' | 'home' | null>(null);
  useEffect(() => {
    const term = filter.trim();
    if (term === lastFilterRef.current) return;
    lastFilterRef.current = term;
    pendingFrameRef.current = term ? 'fit' : 'home';
  }, [filter]);
  useEffect(() => {
    if (!pendingFrameRef.current || !layout) return;
    const id = requestAnimationFrame(() => {
      const pending = pendingFrameRef.current;
      pendingFrameRef.current = null;
      if (pending === 'fit') fitLayout();
      else if (pending === 'home') frameHome();
    });
    return () => cancelAnimationFrame(id);
  }, [filter, layout, fitLayout, frameHome]);

  // A selection made elsewhere (the viewport, the keyboard) scrolls into view, once per selection: a
  // rebuild (an eye toggled, a rename) must not drag the view back after the user has panned away.
  useEffect(() => {
    if (!primaryId || !layout || !paneWidth || keptInViewRef.current === primaryId) return;
    const card = layout.byId.get(primaryId);
    if (!card) return; // not laid out yet: its ancestors are still opening
    keptInViewRef.current = primaryId;
    const { x, y, zoom } = getViewport();
    const left = card.x * zoom + x, top = card.y * zoom + y;
    const margin = 8;
    if (left >= margin && top >= margin && left + CARD_W * zoom <= paneWidth - margin && top + CARD_H * zoom <= paneHeight - margin) return;
    void setCenter(card.x + CARD_W / 2, card.y + CARD_H / 2, { zoom, duration: 200 });
  }, [primaryId, layout, paneWidth, paneHeight, getViewport, setCenter]);

  // --- selection and keys ---------------------------------------------------------------------------

  const focusGraph = () => containerRef.current?.focus({ preventScroll: true });

  const onCardClick = (id: string, event: React.MouseEvent) => {
    focusGraph();
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selectedIds);
      if (next.delete(id)) {
        const rest = [...next];
        onSelect(rest, rest.length ? rest[rest.length - 1] : null);
      } else onSelect([...next, id], id);
      return;
    }
    if (event.shiftKey) { onSelect([...new Set([...selectedIds, id])], id); return; }
    onSelect([id], id);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const dir = ARROW_KEYS[event.key];
    if (!dir || !layout || (event.target as HTMLElement).closest('input')) return;
    event.preventDefault();
    event.stopPropagation();
    const from = primaryId && layout.byId.has(primaryId) ? primaryId : null;
    const next = from ? nearestInDirection(layout.cards, from, dir) : layout.rootId;
    if (next) onSelect([next], next);
  };

  // --- moving nodes ---------------------------------------------------------------------------------

  const dragIdsRef = useRef<string[] | null>(null);
  const [drop, setDropState] = useState<{ id: string; zone: DropZone } | null>(null);
  const dropRef = useRef(drop);
  const setDrop = (next: { id: string; zone: DropZone } | null) => {
    const cur = dropRef.current;
    if (cur === next || (cur && next && cur.id === next.id && cur.zone === next.zone)) return;
    dropRef.current = next;
    setDropState(next);
  };

  const onCardDragStart = (id: string, event: React.DragEvent) => {
    // Targets outside the panel (the Assets explorer, node-reference fields, the Sequencer outliner) read
    // the node from these, as from a tree row. The moved set stays here: a selected card carries the
    // whole selection, an unselected one only itself.
    event.dataTransfer.setData('text/cleo-node', id);
    event.dataTransfer.setData('text/plain', id);
    dragIdsRef.current = selectedIds.has(id) ? [...selectedIds] : [id];
  };
  const onCardDragEnd = () => { dragIdsRef.current = null; setDrop(null); };

  /** Whether `dragIds` may land in `zone` of card `id`. handleMove re-checks the engine-side rules. */
  const canDropAt = (id: string, zone: DropZone, dragIds: string[]): boolean => {
    const l = layoutRef.current;
    const card = l?.byId.get(id);
    if (!l || !card || !canMove || dragIds.includes(id)) return false;
    // A collapsed template instance shows no interior, and it cannot take a child.
    if (zone === 'inside' && card.desc.templateId) return false;
    const parentId = zone === 'inside' ? id : l.parentOf.get(id);
    if (!parentId) return false;
    // Not into the subtree of anything being moved.
    const dragging = new Set(dragIds);
    for (let p: string | undefined = parentId; p; p = l.parentOf.get(p)) if (dragging.has(p)) return false;
    return true;
  };

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    const dragIds = dragIdsRef.current;
    if (!dragIds) return; // not a card being moved: scripts and new nodes are SceneInspector's
    const el = (event.target as HTMLElement).closest<HTMLElement>('.scene-item');
    const card = el ? layoutRef.current?.byId.get(el.id) : undefined;
    let target: { id: string; zone: DropZone } | null = null;
    if (el && card) {
      const rect = el.getBoundingClientRect();
      // The root has no siblings to land between; everything else splits along its siblings' axis.
      const zone = card.id === layoutRef.current?.rootId ? 'inside'
        : zoneAt(card.stacked ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width);
      if (canDropAt(card.id, zone, dragIds)) target = { id: card.id, zone };
    }
    setDrop(target);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const dragIds = dragIdsRef.current, target = dropRef.current;
    dragIdsRef.current = null;
    setDrop(null);
    if (!dragIds || !target) return;
    event.preventDefault();
    onMove({ dragIds, targetId: target.id, zone: target.zone });
  };

  const onDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setDrop(null);
  };

  const ui: GraphUi = {
    selectedIds, editingId, drop, canEdit,
    onCardClick,
    onStartRename: props.onStartRename,
    onSubmitRename: (id, name) => { props.onRename(id, name); focusGraph(); },
    // Escape gives the keyboard back to the graph; focus leaving for another field must not be taken back.
    onCancelRename: (byKey) => { props.onCancelRename(); if (byKey) focusGraph(); },
    onToggleCollapse: props.onToggleCollapse,
    onCardDragStart, onCardDragEnd,
  };

  return (
    <GraphUiContext.Provider value={ui}>
      <div ref={containerRef} tabIndex={0} className='relative w-full h-full !outline-none'
           onKeyDown={onKeyDown} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={onDragLeave}>
        <ReactFlow
          nodes={nodes}
          onNodesChange={onNodesChange}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          disableKeyboardA11y
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          zoomOnDoubleClick={false}
          // A big scene is thousands of cards; only the ones on screen are mounted (HANDLES keeps their edges).
          onlyRenderVisibleElements
          minZoom={MIN_ZOOM}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          // Dark, so xyflow's own chrome (the zoom controls) matches; the canvas a step darker than the
          // panel, so the cards stand off it.
          colorMode='dark'
          className='!bg-surface-sunken'>
          <Background color={token('--control')} gap={18} />
          <Controls position='bottom-left' showInteractive={false} />
        </ReactFlow>
        { !root && filter.trim() &&
          <div className='absolute inset-0 flex items-center justify-center pointer-events-none text-ui-sm text-dim'>
            No nodes match
          </div> }
      </div>
    </GraphUiContext.Provider>
  );
}

export default function SceneGraphView(props: SceneGraphViewProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
