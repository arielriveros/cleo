import { useProjectFeatures } from '../projectFeatures/featureUi';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NodeRendererProps, Tree, TreeApi } from 'react-arborist'
import { useCleoEngine } from '../EngineContext'
import { CleoEngine, Logger, Node, isEditorOwnedName, isUINodeType } from 'cleo';
import type { SceneChange } from 'cleo';
import { NEW_NODE_MIME, addItemTo, findAddItem } from './addCatalog';
import { TEMPLATE_ID_VAR, isWithinTemplateInstance } from '../../utils/templates';
import { setNameOverride } from '../../utils/templateOverrides';
import { getScriptIdOf } from '../../utils/scripts';
import { validateNodeName } from '../../utils/nodeNames';
import { useElementSize } from '@cleo/app-kit/utils/useElementSize';
import { useScopedDndManager } from '../../utils/treeDnd';
import { useTreeFocusGuard } from '../../utils/treeFocusGuard';
import { Button, TextInput } from '@cleo/app-kit/ui';
import { filterSceneTree, nameMatches, type NodeDescription } from './sceneGraphLayout';
import { Chevron, GraphViewIcon, NodeControls, NodeTypeGlyph, RenameField } from './sceneNodeParts';
import SceneGraphView, { type GraphMove } from './SceneGraphView';

/** The panel's two views of one hierarchy. The choice is kept across sessions. */
type SceneView = 'tree' | 'graph';
const VIEW_KEY = 'cleo_scene_tree_view';
const readView = (): SceneView => {
  try { return localStorage.getItem(VIEW_KEY) === 'graph' ? 'graph' : 'tree'; } catch { return 'tree'; }
};

const ROW_HEIGHT = 24;
const INDENT = 12;
const GUTTER = 6;   // left inset before the first level, so a rule never hugs the panel edge
const CHEVRON = 16; // the disclosure column; guides are centred on it

/** The one MIME the tree accepts besides new nodes. Node-to-node moves are react-arborist's job now. */
const SCRIPT_MIME = 'text/cleo-script';

/**
 * Nodes the tree never shows: debug/editor helpers and the chunks a landscape subdivides itself into.
 * The helper test is `isEditorOwnedName` — the same name contract the publish pass strips by — and
 * deliberately NAME-based, not `Node.isEditorOwned`: a flag-owned preview holder (the animation-field
 * subject, say) must stay visible in its tab's tree. Terrain chunks are engine content, not editor-owned,
 * so they are hidden separately.
 */
const isHiddenInTree = (node: Node): boolean =>
  isEditorOwnedName(node.name) || node.name.startsWith('__terrain_chunk__');

/** A parent's children as the tree shows them — the index space react-arborist reports drops in. */
const shownChildren = (node: Node): Node[] => node.children.filter(child => !isHiddenInTree(child));

const isAncestorOf = (maybeAncestor: Node, node: Node): boolean => {
  for (let p: Node | null = node.parent; p; p = p.parent) if (p === maybeAncestor) return true;
  return false;
};

/**
 * The faint vertical rules tying a child to its parent: one per level, absolutely positioned and centred
 * on that level's ancestor chevron. Drawn inside the row rather than as padding, so hover and selection
 * fills still sweep the full width.
 */
const IndentGuides = ({ level }: { level: number }) => (
  <>
    {Array.from({ length: level }, (_, i) => (
      <span key={i} aria-hidden className='absolute inset-y-0 w-px bg-fg/[0.08] pointer-events-none'
            style={{ left: GUTTER + i * INDENT + CHEVRON / 2 }} />
    ))}
  </>
);

/** The tree's rename field: arborist's own submit/reset. */
function RenameInput({ node }: { node: NodeRendererProps<NodeDescription>['node'] }) {
  return <RenameField initial={node.data.name} onSubmit={(name) => node.submit(name)} onCancel={() => node.reset()} />;
}

/**
 * One row: type icon, script/template shortcuts, visibility toggle, dormant dimming and UI tint.
 * react-arborist's `style` (its indent, as padding) is re-derived below instead of applied, so the row can
 * add its own gutter and paint the guides behind a fill that runs the full width.
 */
function SceneNodeRow({ node, dragHandle }: NodeRendererProps<NodeDescription>) {
  const data = node.data;
  const selected = node.isSelected;
  // UI elements are tinted so a HUD subtree is distinguishable from world geometry. A SELECTED row drops
  // the tint for the standard indigo fill and white text: selection must never be ambiguous.
  const isUI = isUINodeType(data.type);
  // A node of a feature the project leaves out (Project ▸ Features) stays in the scene, but a published game
  // drops it: the row says so.
  const offFeature = useProjectFeatures().offFeatureOfNodeType(data.type);

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    // react-dnd carries moves within the tree; these are for targets outside it (the Assets explorer,
    // node-reference fields). The dedicated MIME tells a scene node from other text/plain drags.
    event.dataTransfer.setData('text/cleo-node', data.id);
    event.dataTransfer.setData('text/plain', data.id);
  };

  return (
    <div
      id={data.id}
      ref={dragHandle}
      onDoubleClick={() => { if (node.isEditable) void node.edit(); }}
      onDragStart={handleDragStart}
      style={{ paddingLeft: GUTTER + node.level * INDENT }}
      className={`scene-item group relative flex items-center h-[22px] mt-[1px] pr-[6px] rounded-md overflow-hidden whitespace-nowrap ${
        selected ? 'bg-primary/40 text-fg cursor-default'
          : node.willReceiveDrop ? 'bg-primary/20 cursor-pointer'
            : `${isUI ? 'text-node-ui ' : 'text-fg '}hover:bg-fg/[0.06] cursor-pointer`}`}>
      <IndentGuides level={node.level} />
      {/* Always occupied, so names line up whether or not a row can be opened. */}
      <span className='flex items-center justify-center w-[16px] shrink-0 text-muted hover:text-fg z-[1]'
            onClick={(e) => { e.stopPropagation(); if (data.children.length) node.toggle(); }}>
        { data.children.length > 0 && <Chevron open={node.isOpen} /> }
      </span>
      {/* Dormant nodes (spawnOnStart off) read as "present but asleep": the row is dimmed, but stays fully
          interactive — it is still authored here, and the only way to select it. */}
      <div className={`flex items-center min-w-0 flex-1 ${data.spawnOnStart === false || offFeature ? 'opacity-50' : ''}`}
           title={offFeature ? `Not shipped: the ${offFeature.label} feature is off for this project (Project ▸ Features)`
             : data.spawnOnStart === false ? 'Dormant until a script spawns it' : undefined}>
        <NodeTypeGlyph type={data.type} templateId={data.templateId} />
        { node.isEditing ? <RenameInput node={node} /> : <span className={`truncate ${offFeature ? 'line-through' : ''}`}>{data.name}</span> }
      </div>
      <NodeControls data={data} />
    </div>
  );
}

/** Drop cursor drawn between rows: a capped line in the editor's indigo accent. The dot marks the level
 *  the row would land at. */
const DropCursor = ({ top, left, indent }: { top: number; left: number; indent: number }) => (
  <div style={{ position: 'absolute', pointerEvents: 'none', top: top - 3, left, right: indent }}
       className='flex items-center gap-[1px]'>
    <span className='w-[5px] h-[5px] rounded-full bg-highlight shrink-0' />
    <span className='flex-1 h-[2px] rounded-full bg-highlight' />
  </div>
);

export default function SceneInspector() {
  // `inspectedScene` is the running play scene while Simulating, so the tree shows the live simulation (spawns,
  // despawns, renames). Every structural edit below stays gated on isPlayMode, which Simulate keeps true.
  const { inspectedScene: editorScene, isSimulating, eventEmitter, isPlayMode, editorMode, templateRootId,
          attachScriptToNode, activeTab, sceneList, openSceneId, selectedNode, instance } = useCleoEngine()
  const [ nodes, setNodes ] = useState<NodeDescription | null>(null);
  const [ filter, setFilter ] = useState('');
  const filtering = filter.trim() !== '';
  const [ view, setViewState ] = useState<SceneView>(readView);
  const viewRef = useRef(view);
  viewRef.current = view;
  const setView = (next: SceneView) => {
    setViewState(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* ignore */ }
  };
  const treeRef = useRef<TreeApi<NodeDescription> | undefined>(undefined);
  // react-arborist is virtualized, so it needs real pixel dimensions; the same element also scopes its
  // drag-and-drop backend, which would otherwise disable every native drop in the editor (see treeDnd).
  const { ref: viewportRef, element: viewportEl, size } = useElementSize<HTMLDivElement>();
  const dndManager = useScopedDndManager(viewportEl);
  // Abandoning a rename by clicking into another field must not have the row take the keyboard back.
  useTreeFocusGuard(viewportEl, treeRef);

  // The scene tab's root row is labelled from SceneMeta; the engine node stays named 'root' because
  // Scene.parse re-finds the root by that literal name. Display only.
  // A Sequencer tab shows the same open scene, so it shows the same name.
  const sceneName = activeTab.kind === 'scene' || activeTab.kind === 'sequence' ? sceneList.find(s => s.id === openSceneId)?.name : undefined;
  // Sequencer mode keys nodes and never restructures the scene: selection (and the eye, which keys) only.
  const structureLocked = editorMode === 'sequence';

  // In template mode the inspector is rooted at the template node itself, so the editor camera/light
  // (siblings under the real scene root) stay hidden. Mesh mode keeps the real scene root: its root row is
  // the drop target and the parent for the LOD level nodes.
  const treeRoot = useCallback((): Node | undefined =>
    (editorMode === 'template' && templateRootId) ? editorScene.getNodeById(templateRootId) : editorScene.root,
    [editorScene, editorMode, templateRootId]);

  const generateNodeList = useCallback(function build(node: Node): NodeDescription {
    // Template instance roots collapse to a single leaf row in scene mode. The mode guard is essential:
    // in template mode the tree is rooted at the template's own instance root, which carries the marker.
    const templateId = editorMode === 'scene' ? node.getVariable(TEMPLATE_ID_VAR) : undefined;
    return {
      id: node.id,
      name: node.name,
      type: node.nodeType,
      visible: node.visible,
      spawnOnStart: node.spawnOnStart,
      templateId,
      scriptId: getScriptIdOf(node),
      children: templateId ? [] : shownChildren(node).map(build),
    }
  }, [editorMode]);

  useEffect(() => {
    const rebuild = () => {
      const r = treeRoot();
      if (!r) return;
      const list = generateNodeList(r);
      if (sceneName) list.name = sceneName;
      setNodes(list);
    };
    rebuild(); // also rebuild immediately when the mode / template root / scene name changes
    // Only structural changes (add/remove/rename/visibility) alter the tree; ignore the per-setter
    // transform/material events, or a gizmo drag rebuilds the tree 60x/sec.
    //
    // Coalesced: one rebuild per burst, not per event. A running game adds and removes nodes all the
    // time (every hit spawns several effects), and each event used to walk the whole tree and re-render
    // it synchronously. While playing the tree only needs to keep up loosely, so it waits longer.
    let pending = 0;
    const onSceneChanged = (e?: SceneChange) => {
      if (e && e.kind !== 'structure' && e.kind !== 'visibility' && e.kind !== 'name') return;
      if (pending) return;
      pending = window.setTimeout(() => { pending = 0; rebuild(); }, CleoEngine.authoringMode ? 0 : 250);
    };
    eventEmitter.on('SCENE_CHANGED', onSceneChanged);
    return () => { window.clearTimeout(pending); eventEmitter.off("SCENE_CHANGED", onSceneChanged) }; // Remove the listener on component unmount
  }, [eventEmitter, generateNodeList, treeRoot, sceneName]);

  const rootId = nodes?.id;
  const data = useMemo(() => (nodes ? [nodes] : []), [nodes]);
  // The Graph view filters here; the tree filters itself through `searchTerm` with the same test.
  const graphRoot = useMemo(() => (view === 'graph' && nodes ? filterSceneTree(nodes, filter) : null), [view, nodes, filter]);

  // --- collapse, shared by both views ---------------------------------------------------------------

  // Which nodes are collapsed, so closing a subtree in one view holds in the other. The tree reads it once,
  // when it mounts (it remounts on every switch), and reports each toggle back.
  //
  // Under a filter react-arborist keeps a SEPARATE open map, everything open, dropped when the filter
  // clears; the graph does the same with `filteredCollapsed`.
  const [ collapsed, setCollapsed ] = useState<ReadonlySet<string>>(() => new Set());
  const [ filteredCollapsed, setFilteredCollapsed ] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { if (!filtering) setFilteredCollapsed(prev => (prev.size ? new Set() : prev)); }, [filtering]);
  const treeOpenState = useMemo(() => Object.fromEntries([...collapsed].map(id => [id, false])), [collapsed]);

  const handleTreeToggle = (id: string) => {
    const tree = treeRef.current;
    if (!tree || tree.isFiltered) return;
    const open = tree.isOpen(id);
    setCollapsed(prev => {
      if (prev.has(id) !== open) return prev;
      const next = new Set(prev);
      if (open) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleGraphCollapse = (id: string) => {
    (filtering ? setFilteredCollapsed : setCollapsed)(prev => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  // --- selection ------------------------------------------------------------------------------------

  // NOT the `selection` prop: it collapses the tree to a single row on every change, undoing a ctrl/shift
  // multi-selection the instant it is reported. The engine's selection is pushed in only when the tree
  // does not already hold it.
  const selectedRef = useRef<string | null>(selectedNode ?? null);
  selectedRef.current = selectedNode ?? null;

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    if (!selectedNode) { if (tree.selectedIds.size) tree.deselectAll(); return; }
    if (tree.selectedIds.has(selectedNode)) return;
    // The row may sit inside a collapsed subtree: scrollTo opens its parents and waits for it to exist,
    // since tree.get only resolves nodes that are currently visible.
    const scrolled = tree.scrollTo(selectedNode);
    const select = () => {
      const t = treeRef.current;
      if (t && t.get(selectedNode)) t.select(selectedNode, { focus: false });
    };
    if (scrolled) scrolled.then(select).catch(() => undefined); else select();
    // dndManager/height are in here because the tree renders one pass after this panel does: without them
    // a selection made before it mounted would never reach it.
  }, [selectedNode, nodes, dndManager, size.height]);

  // The Graph view's selection. Held here, not in the view, so Delete, F2 and Edit ▸ Delete reach it.
  const [ graphSelected, setGraphSelected ] = useState<ReadonlySet<string>>(() => new Set(selectedNode ? [selectedNode] : []));
  const graphSelectedRef = useRef(graphSelected);
  graphSelectedRef.current = graphSelected;
  const [ graphEditingId, setGraphEditingId ] = useState<string | null>(null);

  useEffect(() => {
    if (view !== 'graph') return;
    if (!selectedNode) { setGraphSelected(prev => (prev.size ? new Set() : prev)); return; }
    if (graphSelectedRef.current.has(selectedNode)) return; // the graph's own click, echoed back
    setGraphSelected(new Set([selectedNode]));
    // Selected elsewhere (the viewport): open the subtree it sits in, as the tree's scrollTo does.
    const ancestors = new Set<string>();
    for (let p = editorScene?.getNodeById(selectedNode)?.parent; p; p = p.parent) ancestors.add(p.id);
    const reveal = (prev: ReadonlySet<string>) =>
      ([...prev].some(id => ancestors.has(id)) ? new Set([...prev].filter(id => !ancestors.has(id))) : prev);
    setCollapsed(reveal);
    setFilteredCollapsed(reveal);
  }, [view, selectedNode, editorScene]);

  const selectNode = (id: string | null) => {
    // No selection during Play (the panels are hidden anyway); Simulate selects to inspect the live node.
    if (isPlayMode && !isSimulating) return;
    if (id === selectedRef.current) return; // the echo of the sync above, or a rebuild re-reporting the same row
    eventEmitter.emit('SELECT_NODE', id);
  };

  // react-arborist clears its selection as it mounts (its provider deselects whenever no `selection` prop
  // is given) and reports that through onSelect. Switching back from the Graph view remounts the tree, and
  // that report would clear the editor's selection. So an empty report during the mounting commit is
  // dropped: the ref callback flags a NEW tree api, the provider's effect runs next (children first), and
  // this panel's own effect, last in the commit, lowers the flag again.
  // Compared against the last api seen, not treeRef: arborist re-runs its imperative handle on every one of
  // its own renders, so the callback sees null and then the SAME api again, with no commit of this panel
  // to lower the flag after it.
  const treeMountingRef = useRef(false);
  const lastTreeApiRef = useRef<TreeApi<NodeDescription> | null>(null);
  const setTreeApi = useCallback((api: TreeApi<NodeDescription> | null | undefined) => {
    if (api && api !== lastTreeApiRef.current) {
      lastTreeApiRef.current = api;
      treeMountingRef.current = true;
    }
    treeRef.current = api ?? undefined;
  }, []);
  useEffect(() => { treeMountingRef.current = false; });

  const handleSelect = (selection: { id: string }[]) => {
    if (treeMountingRef.current && !selection.length) return;
    selectNode(selection.length ? selection[selection.length - 1].id : null);
  };

  const handleGraphSelect = (ids: string[], primary: string | null) => {
    setGraphSelected(new Set(ids));
    selectNode(primary);
  };

  // --- moving nodes ---------------------------------------------------------------------------------

  // Rows stay draggable even when they cannot be re-parented (a node with a body, the root): the same
  // gesture drops a node onto the Assets explorer to save it as a template. What a move may do is here.
  // `index` counts the parent's VISIBLE children with the dragged rows still in place, as react-arborist
  // reports it; 'append' lands them after the last child.
  const moveNodes = (dragIds: string[], parentId: string | null, index: number | 'append') => {
    if (isPlayMode || structureLocked) return;
    const parent = parentId ? editorScene?.getNodeById(parentId) : undefined;
    if (!parent) return; // a drop past the root row would make a sibling of the scene root
    if (editorMode === 'scene' && isWithinTemplateInstance(parent)) {
      Logger.warn('Cannot move a node into a template instance', 'Editor');
      return;
    }

    const dragging = new Set(dragIds);
    const moving: Node[] = [];
    for (const id of dragIds) {
      const node = editorScene?.getNodeById(id);
      if (!node || id === rootId) continue;
      // Dragging a parent already carries its children; moving them too would flatten the subtree.
      if (node.parent && dragging.has(node.parent.id)) continue;
      if (node === parent || isAncestorOf(node, parent)) {
        Logger.warn('Cannot move a node to its child', 'Editor');
        continue;
      }
      moving.push(node);
    }
    if (!moving.length) return;

    // `index` counts the parent's VISIBLE children; addChild indexes the real children array, which also
    // holds terrain chunks and editor helpers. Anchoring on the sibling the rows land in front of
    // translates between the two, and the -1 accounts for addChild detaching the node before it splices
    // it back in.
    const siblings = shownChildren(parent);
    const anchor = index === 'append' ? undefined : siblings[index];
    let engineIndex = anchor ? parent.children.indexOf(anchor) : parent.children.length;
    for (const node of moving) {
      const from = node.parent === parent ? parent.children.indexOf(node) : -1;
      parent.addChild(node, from >= 0 && from < engineIndex ? engineIndex - 1 : engineIndex);
      engineIndex = parent.children.indexOf(node) + 1;
    }
  };

  // A drop ON a row is also reported as index 0, so the two cases are told apart by the cursor shown.
  const handleMove = ({ dragIds, parentId, index }: { dragIds: string[]; parentId: string | null; index: number }) =>
    moveNodes(dragIds, parentId, treeRef.current?.cursorOverFolder ? 'append' : index);

  // The graph names the card it was dropped on and which side: as that card's last child, or as the
  // sibling just before or after it.
  const handleGraphMove = ({ dragIds, targetId, zone }: GraphMove) => {
    if (zone === 'inside') { moveNodes(dragIds, targetId, 'append'); return; }
    const target = editorScene?.getNodeById(targetId);
    const parent = target?.parent;
    if (!target || !parent) return;
    const index = shownChildren(parent).indexOf(target);
    moveNodes(dragIds, parent.id, zone === 'before' ? index : index + 1);
  };

  // --- rename / delete ------------------------------------------------------------------------------

  const handleRename = ({ id, name }: { id: string; name: string }) => {
    if (structureLocked) return;
    const node = editorScene?.getNodeById(id);
    if (!node || name === node.name) return;
    const problem = validateNodeName(name);
    if (problem) { Logger.warn(problem, 'Editor'); return; }
    // Inside a placed template instance only the ROOT's name is the placement's own (an override that a
    // rebuild from the template restores). A child keeps the template's name, which is how it is found.
    if (editorMode === 'scene' && isWithinTemplateInstance(node.parent)) {
      Logger.warn('Cannot rename a node inside a template instance; rename it in the template', 'Editor');
      return;
    }
    if (editorMode === 'scene' && node.getVariable(TEMPLATE_ID_VAR)) setNameOverride(node, name);
    // No event of our own: the engine's name setter emits SCENE_CHANGED { kind: 'name' }, which rebuilds
    // this tree, refreshes the Properties panel and marks the tab unsaved.
    node.name = name;
  };

  const handleDelete = ({ ids }: { ids: string[] }) => {
    if (isPlayMode || structureLocked) return;
    for (const id of ids) {
      if (id === rootId) continue;
      const node = editorScene?.getNodeById(id);
      if (!node) continue;
      // The instance root itself is deletable; only its interior is off limits.
      if (editorMode === 'scene' && isWithinTemplateInstance(node.parent)) {
        Logger.warn('Cannot delete a node inside a template instance', 'Editor');
        continue;
      }
      // removeNode, not Node.remove(): the scene unwinds its own bookkeeping around the tree link.
      editorScene.removeNode(node);
    }
  };
  const handleDeleteRef = useRef(handleDelete);
  handleDeleteRef.current = handleDelete;

  // The graph's rename gate: the tree's `disableEdit`, inverted.
  const canEditNode = (id: string) => !(isPlayMode || structureLocked || id === rootId);

  // --- drops from outside the tree ------------------------------------------------------------------

  // What this panel accepts from elsewhere in the editor. Node-to-node moves must NOT be listed: they
  // belong to react-arborist, and leaving them out stops both drag systems acting on one drop.
  const nativeDrag = (types: readonly string[]) =>
    types.includes(SCRIPT_MIME) ? 'script' : types.includes(NEW_NODE_MIME) ? 'new-node' : null;

  /*
   * Both handlers run in the CAPTURE phase and stop propagation, so these drags never reach the react-dnd
   * listeners on the tree container below: that backend force-sets dropEffect='none' for any drag it does
   * not own and throws "cannot hover while not dragging" on release.
   */
  const handleDragOver: React.DragEventHandler<HTMLDivElement> = (event) => {
    if (structureLocked || !nativeDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop: React.DragEventHandler<HTMLDivElement> = (event) => {
    const kind = nativeDrag(event.dataTransfer.types);
    if (!kind || structureLocked) return;
    event.preventDefault();
    event.stopPropagation();
    // A Simulate session shows the running scene here: attaching a script writes the persistent script map
    // and a new node would land in a scene that is thrown away on Stop. Neither belongs in a session.
    if (isPlayMode) return;

    const targetElement = (event.target as HTMLElement).closest('.scene-item');

    // A script asset from the Assets explorer: attach it to the node it was dropped on (base type enforced
    // by attachScriptToNode). Read-only template-instance nodes are skipped.
    if (kind === 'script') {
      const scriptId = event.dataTransfer.getData(SCRIPT_MIME);
      const node = targetElement ? editorScene?.getNodeById(targetElement.id) : null;
      if (!node) { Logger.warn('Drop the script onto a node to attach it', 'Editor'); return; }
      if (editorMode === 'scene' && isWithinTemplateInstance(node)) {
        Logger.warn('Cannot attach a script to a template instance', 'Editor');
        return;
      }
      attachScriptToNode(node, scriptId);
      return;
    }

    // A new node from the Add section: parent it under the row it was dropped on, or under the tree root.
    const item = findAddItem(event.dataTransfer.getData(NEW_NODE_MIME));
    const parent = targetElement ? editorScene?.getNodeById(targetElement.id) : treeRoot();
    if (!item || !parent) return;
    if (editorMode === 'scene' && isWithinTemplateInstance(parent)) {
      Logger.warn('Cannot add a node inside a template instance', 'Editor');
      return;
    }
    addItemTo(item, parent, { editorScene, eventEmitter }).catch(err => console.error(err));
  };

  // Edit ▸ Delete in the menu bar: the same as the Delete key below, through the tree, so it is undoable
  // and honours the same locks.
  useEffect(() => {
    const onDeleteSelected = () => {
      if (viewRef.current === 'graph') {
        const ids = [...graphSelectedRef.current];
        if (ids.length && !structureLocked) handleDeleteRef.current({ ids });
        return;
      }
      const tree = treeRef.current;
      if (!tree || tree.isEditing || structureLocked) return;
      const ids = Array.from(tree.selectedIds);
      if (ids.length) void tree.delete(ids);
    };
    eventEmitter.on('DELETE_SELECTED', onDeleteSelected);
    return () => { eventEmitter.off('DELETE_SELECTED', onDeleteSelected); };
  }, [eventEmitter, structureLocked]);

  // Delete and F2, on top of react-arborist's own keymap. Capture phase and stopping propagation, because
  // react-arborist treats any unrecognised key as type-ahead. Ignored while a field has focus.
  const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (view === 'graph') {
      if (graphEditingId || (event.target as HTMLElement).closest('input')) return;
      if (event.key !== 'Delete' && event.key !== 'F2') return;
      event.preventDefault();
      event.stopPropagation();
      if (structureLocked) return;
      if (event.key === 'Delete') {
        const ids = [...graphSelected];
        if (ids.length) handleDelete({ ids });
        return;
      }
      if (selectedNode && graphSelected.has(selectedNode) && canEditNode(selectedNode)) setGraphEditingId(selectedNode);
      return;
    }
    const tree = treeRef.current;
    if (!tree || tree.isEditing) return;
    if ((event.target as HTMLElement).closest('input')) return;
    if (event.key !== 'Delete' && event.key !== 'F2') return;
    event.preventDefault();
    if (structureLocked) { event.stopPropagation(); return; }
    event.stopPropagation();
    if (event.key === 'Delete') {
      const ids = Array.from(tree.selectedIds);
      if (ids.length) void tree.delete(ids);
      return;
    }
    const node = tree.focusedNode;
    if (node?.isEditable) void tree.edit(node);
  };

  return (
    <div className='flex flex-col text-fg bg-surface-raised w-full h-full min-h-[40px] overflow-hidden'
         onDragOverCapture={handleDragOver} onDropCapture={handleDrop} onKeyDownCapture={handleKeyDown}>
      {structureLocked && (
        <div className='shrink-0 bg-sequence/20 px-2 py-1 text-ui-sm text-sequence'
          title="Sequencer mode keys nodes; it doesn't add, remove, move or rename them. Do that from the scene tab.">
          Select a node to key it. Drag one onto the Sequencer to give it a slot.
        </div>
      )}
      <div className='shrink-0 flex items-center gap-1 px-[5px] py-1'>
        <TextInput
          value={filter} placeholder='Filter nodes'
          onChange={setFilter}
          className='flex-1 min-w-0 bg-fg/[0.06] border-transparent focus-visible:border-transparent placeholder:text-dim rounded-md px-2 py-[3px] focus:bg-fg/[0.1] transition-colors' />
        <Button
          variant='ghost' size='icon'
          active={view === 'graph'} aria-pressed={view === 'graph'}
          onClick={() => setView(view === 'graph' ? 'tree' : 'graph')}
          title={view === 'graph' ? 'Back to the tree view' : 'Graph view: the hierarchy as a top-down node graph'}
          className='shrink-0 w-[24px] h-[24px] p-[4px] rounded-md'>
          <GraphViewIcon />
        </Button>
      </div>
      {/* The graph is deliberately NOT inside viewportRef: the tree's react-dnd backend is scoped to that
          element, and it would cancel the graph's native drops (see treeDnd). */}
      { view === 'graph'
        ? <div className='flex-1 min-h-0'>
            <SceneGraphView
              root={graphRoot}
              filter={filter}
              collapsed={filtering ? filteredCollapsed : collapsed}
              onToggleCollapse={toggleGraphCollapse}
              selectedIds={graphSelected}
              primaryId={selectedNode ?? null}
              onSelect={handleGraphSelect}
              editingId={graphEditingId}
              onStartRename={setGraphEditingId}
              onRename={(id, name) => { setGraphEditingId(null); handleRename({ id, name }); }}
              onCancelRename={() => setGraphEditingId(null)}
              canEdit={canEditNode}
              canMove={!isPlayMode && !structureLocked}
              onMove={handleGraphMove} />
          </div>
        : <div ref={viewportRef} className='flex-1 min-h-0'>
            { dndManager && size.height > 0 &&
              <Tree<NodeDescription>
                ref={setTreeApi}
                data={data}
                dndManager={dndManager}
                width={size.width}
                height={size.height}
                rowHeight={ROW_HEIGHT}
                indent={INDENT}
                openByDefault
                initialOpenState={treeOpenState}
                onToggle={handleTreeToggle}
                selectionFollowsFocus
                searchTerm={filter}
                searchMatch={(node, term) => nameMatches(node.data.name, term)}
                onSelect={handleSelect}
                onMove={handleMove}
                onRename={handleRename}
                onDelete={handleDelete}
                disableEdit={(d) => isPlayMode || structureLocked || d.id === rootId}
                disableDrop={({ parentNode }) => isPlayMode || structureLocked || !!parentNode.data.templateId || !editorScene?.getNodeById(parentNode.id)}
                renderCursor={DropCursor}
                className='outline-none'>
                {SceneNodeRow}
              </Tree>
            }
          </div> }
    </div>
  )
}
