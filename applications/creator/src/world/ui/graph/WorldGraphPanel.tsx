// The World's terrain graph on a canvas (@xyflow/react): typed ports (heights blue, masks amber), drag to
// wire an output into an input, a thumbnail of each node's output, right-click or double-click the canvas
// to add a node, right-click a node to duplicate, switch off or delete it. Every change goes back through
// `onChange` as a new graph, so the document (and its undo history) stays the one source of truth.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, useNodesInitialized, useNodesState, useReactFlow,
  type Connection, type Edge as RFEdge, type Node as RFNode, type NodeProps, type IsValidConnection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { token } from '@cleo/app-kit/utils/cssTokens';
import { Button, ContextMenu, MenuItem } from '@cleo/app-kit/ui';
import { newId } from '../../ids';
import { layoutGraph, makeNode } from '../../graph/build';
import { connect, wouldCycle, type GraphNode, type WorldGraph } from '../../graph/graphDoc';
import { nodeType, NODE_TYPE_LIST } from '../../graph/nodeRegistry';
import { CATEGORY_LABELS, type NodeCategory, type NodeType } from '../../graph/nodeTypes';
import type { NodeThumb } from '../../worldWorker';
import { NodeGlyph, PORT_COLOR } from './nodeIcons';

export interface NodeBadge {
  text: string;
  title: string;
  tone: 'dim' | 'warning' | 'primary';
}

export interface WorldGraphPanelProps {
  graph: WorldGraph;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** A new graph; `label` names the change for the undo history. */
  onChange: (graph: WorldGraph, label: string) => void;
  thumbs: Record<string, NodeThumb>;
  badges: Record<string, NodeBadge>;
}

const NODE_W = 172;
const TONE: Record<NodeBadge['tone'], string> = { dim: 'text-dim', warning: 'text-warning-fg', primary: 'text-highlight' };
const CATEGORY_ORDER: NodeCategory[] = ['shape', 'landform', 'combine', 'mask', 'erosion', 'paint'];

const thumbUrls = new WeakMap<NodeThumb, string>();
function thumbUrl(t: NodeThumb): string {
  const cached = thumbUrls.get(t);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = t.size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(t.size, t.size);
  for (let i = 0; i < t.pixels.length; i++) {
    const v = t.pixels[i];
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL();
  thumbUrls.set(t, url);
  return url;
}

interface CardData extends Record<string, unknown> {
  node: GraphNode;
  type: NodeType | undefined;
  thumb: NodeThumb | undefined;
  badge: NodeBadge | undefined;
  onToggle: (id: string) => void;
}

const Card = memo(function Card({ data, selected }: NodeProps<RFNode<CardData>>) {
  const { node, type, thumb, badge } = data;
  const inputs = type?.inputs ?? [];
  const outputs = type?.outputs ?? [];
  const rows = Math.max(inputs.length, outputs.length);
  return (
    <div className={`rounded border ${selected ? 'border-highlight' : 'border-border'} bg-surface-raised text-fg shadow-panel ${node.enabled ? '' : 'opacity-50'}`}
         style={{ width: NODE_W }} title={type?.description}>
      <div className='flex items-center gap-1.5 px-2 py-1 border-b border-border'>
        <span className='text-primary'><NodeGlyph icon={type?.icon ?? 'constant'} /></span>
        <span className='text-ui font-semibold truncate flex-1'>{node.name}</span>
        {!type?.singleton && (
          <button type='button' className={`nodrag w-2.5 h-2.5 rounded-full border ${node.enabled ? 'bg-success border-success' : 'border-dim'}`}
                  title={node.enabled ? 'On: click to switch it off (its input passes through)' : 'Off: click to switch it on'}
                  onClick={e => { e.stopPropagation(); data.onToggle(node.id); }} />
        )}
      </div>
      <div className='relative py-1'>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className='relative flex justify-between items-center h-[18px] px-2 text-ui-2xs text-muted'>
            <span>{inputs[i]?.label ?? ''}{inputs[i]?.optional ? '' : ''}</span>
            <span>{outputs[i]?.label ?? ''}</span>
            {inputs[i] && (
              <Handle type='target' id={inputs[i].id} position={Position.Left}
                      style={{ background: PORT_COLOR[inputs[i].type], width: 9, height: 9, border: '1px solid #0008', left: -5 }}
                      title={`${inputs[i].label} (${inputs[i].type}${inputs[i].optional ? ', optional' : ''})`} />
            )}
            {outputs[i] && (
              <Handle type='source' id={outputs[i].id} position={Position.Right}
                      style={{ background: PORT_COLOR[outputs[i].type], width: 9, height: 9, border: '1px solid #0008', right: -5 }}
                      title={`${outputs[i].label} (${outputs[i].type})`} />
            )}
          </div>
        ))}
      </div>
      {thumb && (
        <div className='px-2 pb-1.5'>
          <img src={thumbUrl(thumb)} alt='' draggable={false} className='w-full aspect-square rounded-sm border border-border' style={{ imageRendering: 'pixelated' }} />
        </div>
      )}
      {badge && <div className={`px-2 pb-1 text-ui-2xs ${TONE[badge.tone]} truncate`} title={badge.title}>{badge.text}</div>}
    </div>
  );
});

const nodeTypes = { world: Card };

/** The add-node menu's entries, grouped by category. */
function AddMenu({ onAdd }: { onAdd: (type: string) => void }) {
  return (
    <div className='max-h-[60vh] overflow-auto min-w-[220px]'>
      {CATEGORY_ORDER.map(cat => (
        <div key={cat}>
          <div className='px-2 pt-1.5 pb-0.5 text-ui-2xs uppercase tracking-wide text-dim'>{CATEGORY_LABELS[cat]}</div>
          {NODE_TYPE_LIST.filter(t => t.category === cat).map(t => (
            <MenuItem key={t.type} icon={<NodeGlyph icon={t.icon} />} hint={t.description} onClick={() => onAdd(t.type)}>{t.label}</MenuItem>
          ))}
        </div>
      ))}
    </div>
  );
}

function Canvas({ graph, selected, onSelect, onChange, thumbs, badges }: WorldGraphPanelProps) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode<CardData>>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; node: string | null } | null>(null);
  const colors = useMemo(() => ({ grid: token('--control') }), []);

  const toggle = useCallback((id: string) => {
    onChange({ ...graph, nodes: graph.nodes.map(n => (n.id === id ? { ...n, enabled: !n.enabled } : n)) }, 'Switch node');
  }, [graph, onChange]);

  useEffect(() => {
    setNodes(graph.nodes.map(n => ({
      id: n.id, type: 'world', position: { x: n.x, y: n.y }, selected: n.id === selected,
      deletable: !nodeType(n.type)?.singleton,
      data: { node: n, type: nodeType(n.type), thumb: thumbs[n.id], badge: badges[n.id], onToggle: toggle },
    })));
  }, [graph, selected, thumbs, badges, toggle, setNodes]);

  // Frame the graph once its cards have been measured, never so far out that they cannot be read.
  const framed = useRef(false);
  const nodesInit = useNodesInitialized();
  useEffect(() => {
    if (framed.current || !nodesInit) return;
    framed.current = true;
    requestAnimationFrame(() => fitView({ minZoom: 0.6, maxZoom: 1 }));
  }, [nodesInit, fitView]);

  const edges: RFEdge[] = useMemo(() => graph.edges.map(e => {
    const from = graph.nodes.find(n => n.id === e.from.node);
    const port = from ? nodeType(from.type)?.outputs.find(o => o.id === e.from.port) : undefined;
    return {
      id: e.id, source: e.from.node, sourceHandle: e.from.port, target: e.to.node, targetHandle: e.to.port,
      style: { stroke: PORT_COLOR[port?.type ?? 'height'], strokeWidth: 1.6 },
    };
  }), [graph]);

  const isValid: IsValidConnection = useCallback(c => !!c.source && !!c.target && !wouldCycle(graph, c.source, c.target), [graph]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
    const next = connect(graph, { node: c.source, port: c.sourceHandle }, { node: c.target, port: c.targetHandle }, newId('e'));
    if (next !== graph) onChange(next, 'Connect');
  }, [graph, onChange]);

  const onDelete = useCallback(({ nodes: ns, edges: es }: { nodes: RFNode[]; edges: RFEdge[] }) => {
    const dropN = new Set(ns.map(n => n.id).filter(id => !nodeType(graph.nodes.find(x => x.id === id)?.type ?? '')?.singleton));
    const dropE = new Set(es.map(e => e.id));
    if (!dropN.size && !dropE.size) return;
    onChange({
      nodes: graph.nodes.filter(n => !dropN.has(n.id)),
      edges: graph.edges.filter(e => !dropE.has(e.id) && !dropN.has(e.from.node) && !dropN.has(e.to.node)),
    }, dropN.size ? 'Delete node' : 'Disconnect');
    if (selected && dropN.has(selected)) onSelect(null);
  }, [graph, onChange, onSelect, selected]);

  const onDragStop = useCallback((_e: unknown, _n: RFNode, moved: RFNode[]) => {
    const pos = new Map(moved.map(n => [n.id, n.position]));
    onChange({ ...graph, nodes: graph.nodes.map(n => (pos.has(n.id) ? { ...n, x: Math.round(pos.get(n.id)!.x), y: Math.round(pos.get(n.id)!.y) } : n)) }, 'Move node');
  }, [graph, onChange]);

  const add = (type: string, at: { x: number; y: number }) => {
    const n = { ...makeNode(type), ...screenToFlowPosition(at) };
    n.x = Math.round(n.x - NODE_W / 2); n.y = Math.round(n.y - 20);
    onChange({ ...graph, nodes: [...graph.nodes, n] }, `Add ${n.name}`);
    onSelect(n.id);
    setMenu(null);
  };

  const duplicate = (id: string) => {
    const src = graph.nodes.find(n => n.id === id);
    if (!src || nodeType(src.type)?.singleton) return;
    const copy: GraphNode = { ...structuredClone(src), id: newId(src.type), x: src.x + 30, y: src.y + 30, name: `${src.name} copy` };
    onChange({ ...graph, nodes: [...graph.nodes, copy] }, 'Duplicate node');
    onSelect(copy.id);
  };

  const menuNode = menu?.node ? graph.nodes.find(n => n.id === menu.node) : null;

  return (
    <div className='absolute inset-0 bg-bg' onDoubleClick={e => {
      if ((e.target as HTMLElement).closest('.react-flow__node')) return;
      setMenu({ x: e.clientX, y: e.clientY, node: null });
    }}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onDragStop}
        onConnect={onConnect}
        isValidConnection={isValid}
        onDelete={onDelete}
        onNodeClick={(_, n) => { onSelect(n.id); setMenu(null); }}
        onPaneClick={() => { onSelect(null); setMenu(null); }}
        onPaneContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, node: null }); }}
        onNodeContextMenu={(e, n) => { e.preventDefault(); onSelect(n.id); setMenu({ x: e.clientX, y: e.clientY, node: n.id }); }}
        deleteKeyCode={['Delete', 'Backspace']}
        zoomOnDoubleClick={false}
        minZoom={0.2}
        colorMode='dark'
        proOptions={{ hideAttribution: true }}
        className='!bg-bg'>
        <Background color={colors.grid} gap={18} />
        <Controls className='!bg-surface-raised !border-border' showInteractive={false} />
      </ReactFlow>
      <div data-cleo-overlay className='absolute top-2 left-2 z-20 flex items-center gap-1' onMouseDown={e => e.stopPropagation()}>
        <Button size='sm' variant='ghost' className='bg-surface-raised/80' title='Add a node (or right-click / double-click the canvas)'
                onClick={e => setMenu({ x: e.clientX, y: e.clientY + 16, node: null })}>
          <span className='w-3.5 h-3.5 inline-block'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'><path d='M12 5v14M5 12h14' /></svg></span>
        </Button>
        <Button size='sm' variant='ghost' className='bg-surface-raised/80' title='Tidy: lay the graph out in columns'
                onClick={() => { onChange(layoutGraph(graph), 'Tidy graph'); setTimeout(() => fitView({ duration: 200, minZoom: 0.6, maxZoom: 1 }), 0); }}>
          <span className='w-3.5 h-3.5 inline-block'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinejoin='round'><path d='M3 4h6v6H3Z M15 4h6v6h-6Z M9 14h6v6H9Z' /></svg></span>
        </Button>
      </div>
      <ContextMenu at={menu ? { x: menu.x, y: menu.y } : null} onClose={() => setMenu(null)}>
        {close => menuNode ? (
          <>
            {!nodeType(menuNode.type)?.singleton && <MenuItem onClick={() => { duplicate(menuNode.id); close(); }}>Duplicate</MenuItem>}
            {!nodeType(menuNode.type)?.singleton && <MenuItem onClick={() => { toggle(menuNode.id); close(); }}>{menuNode.enabled ? 'Switch off' : 'Switch on'}</MenuItem>}
            {!nodeType(menuNode.type)?.singleton && (
              <MenuItem danger onClick={() => { onDelete({ nodes: [{ id: menuNode.id } as RFNode], edges: [] }); close(); }}>Delete</MenuItem>
            )}
            {nodeType(menuNode.type)?.singleton && <div className='px-2 py-1 text-ui-xs text-dim'>The Output is always there.</div>}
          </>
        ) : <AddMenu onAdd={t => add(t, { x: menu!.x, y: menu!.y })} />}
      </ContextMenu>
    </div>
  );
}

export function WorldGraphPanel(props: WorldGraphPanelProps) {
  return (
    <div className='relative h-full w-full'>
      <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>
    </div>
  );
}
