import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NodeRendererProps, Tree, TreeApi } from 'react-arborist'
import { useCleoEngine } from '../EngineContext'
import { Logger, Node, isUINodeType } from 'cleo';
import type { SceneChange } from 'cleo';
import { SkyIcon } from '../nodeInspector/sectionIcons'
import {
  CameraIcon, CameraRigIcon, CharacterAddIcon, ControllerAddIcon, ModelIcon, LightIcon, LightProbeIcon, SkyboxIcon, SkyLightIcon, CloudsIcon,
  SpriteIcon, AnimatedSpriteIcon, TilemapIcon, LandscapeIcon, VisibleIcon, HiddenIcon, SoundIcon,
} from './nodeIcons'
import { NEW_NODE_MIME, addItemTo, findAddItem } from './addCatalog';
import { TEMPLATE_ID_VAR, isWithinTemplateInstance } from '../../utils/templates';
import { getScriptIdOf } from '../../utils/scripts';
import { validateNodeName } from '../../utils/nodeNames';
import { useElementSize } from '../../utils/useElementSize';
import { useScopedDndManager } from '../../utils/treeDnd';
import { hoveredScriptStore, useHoveredScript } from './hoveredScriptStore';
import {
  CanvasIcon, PanelIcon, StackIcon, SpacerIcon, TextIcon, ImageIcon,
  ButtonIcon, ProgressIcon, SliderIcon, ToggleIcon, TextInputIcon,
} from './uiIcons';

/** Glyph per node type, as a table rather than a chain of per-type conditionals in the row. */
const TYPE_ICONS: Record<string, () => JSX.Element> = {
  camera: CameraIcon, cameraRig: CameraRigIcon, model: ModelIcon,
  character: CharacterAddIcon, controller: ControllerAddIcon,
  sprite: SpriteIcon, animatedSprite: AnimatedSpriteIcon, tilemap: TilemapIcon,
  light: LightIcon, lightProbe: LightProbeIcon,
  skybox: SkyboxIcon, volumetricClouds: CloudsIcon, skyAtmosphere: SkyIcon, skyLight: SkyLightIcon,
  landscape: LandscapeIcon,
  // One glyph for both modes: the tree shows what a node IS, and ambient vs spatial is a property of it.
  sound: SoundIcon,
};

/** UI node types, kept separate because `isUINodeType` also gates the inspector and picking. */
const UI_ICONS: Record<string, () => JSX.Element> = {
  uiRoot: CanvasIcon, uiPanel: PanelIcon, uiText: TextIcon, uiImage: ImageIcon,
  uiButton: ButtonIcon, uiStack: StackIcon, uiSpacer: SpacerIcon,
  uiProgressBar: ProgressIcon, uiSlider: SliderIcon, uiToggle: ToggleIcon,
  uiTextInput: TextInputIcon,
};

const ROW_HEIGHT = 24;
const INDENT = 12;
const GUTTER = 6;   // left inset before the first level, so a rule never hugs the panel edge
const CHEVRON = 16; // the disclosure column; guides are centred on it

/** The one MIME the tree accepts besides new nodes. Node-to-node moves are react-arborist's job now. */
const SCRIPT_MIME = 'text/cleo-script';

interface NodeDescription {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  spawnOnStart: boolean;
  templateId?: string;
  scriptId?: string;
  children: NodeDescription[];
}

const PenIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
  </svg>
);

// A code-brackets glyph marking a node that carries a script. `</>` reads as "script/code" at 14px.
const ScriptIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 6 3 12l5 6" />
    <path d="M16 6l5 6-5 6" />
  </svg>
);

/**
 * Nodes the tree never shows: debug/editor helpers and the chunks a landscape subdivides itself into.
 * The names are load-bearing elsewhere — the publish pass strips every node whose name contains
 * '__editor__' or '__debug__' — so this only mirrors them.
 */
const isHiddenInTree = (node: Node): boolean =>
  node.name.includes('__debug__') || node.name.includes('__editor__') || node.name.startsWith('__terrain_chunk__');

/** A parent's children as the tree shows them — the index space react-arborist reports drops in. */
const shownChildren = (node: Node): Node[] => node.children.filter(child => !isHiddenInTree(child));

const isAncestorOf = (maybeAncestor: Node, node: Node): boolean => {
  for (let p: Node | null = node.parent; p; p = p.parent) if (p === maybeAncestor) return true;
  return false;
};

/** Disclosure arrow: one rotating chevron rather than two glyphs. */
const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="3.2"
       strokeLinecap="round" strokeLinejoin="round"
       className={`transition-transform duration-100 ${open ? 'rotate-90' : ''}`}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

/**
 * The faint vertical rules tying a child to its parent: one per level, absolutely positioned and centred
 * on that level's ancestor chevron. Drawn inside the row rather than as padding, so hover and selection
 * fills still sweep the full width.
 */
const IndentGuides = ({ level }: { level: number }) => (
  <>
    {Array.from({ length: level }, (_, i) => (
      <span key={i} aria-hidden className='absolute inset-y-0 w-px bg-white/[0.08] pointer-events-none'
            style={{ left: GUTTER + i * INDENT + CHEVRON / 2 }} />
    ))}
  </>
);

/** The inline rename field. Enter commits through onRename; Escape and blur abandon the edit. */
function RenameInput({ node }: { node: NodeRendererProps<NodeDescription>['node'] }) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <input
      ref={input}
      autoFocus
      defaultValue={node.data.name}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => node.reset()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') node.reset();
        if (e.key === 'Enter') node.submit(input.current?.value ?? '');
      }}
      className='type-value bg-black/40 text-white rounded px-1 outline-none ring-1 ring-primary/60 w-full min-w-0' />
  );
}

/**
 * One row: type icon, script/template shortcuts, visibility toggle, dormant dimming and UI tint.
 * react-arborist's `style` (its indent, as padding) is re-derived below instead of applied, so the row can
 * add its own gutter and paint the guides behind a fill that runs the full width.
 */
function SceneNodeRow({ node, dragHandle }: NodeRendererProps<NodeDescription>) {
  const { editorScene, isPlayMode, enterTemplateEditor, enterScriptEditor } = useCleoEngine();
  const data = node.data;
  const hoveredScript = useHoveredScript();
  const selected = node.isSelected;
  // A script glyph on a template-instance node is greyed (its script is authored in the template) but
  // stays clickable, and is highlighted while its script is the one hovered anywhere.
  const scriptGrey = !!data.templateId;
  const scriptHot = !!data.scriptId && data.scriptId === hoveredScript;
  // UI elements are tinted so a HUD subtree is distinguishable from world geometry. A SELECTED row drops
  // the tint for the standard indigo fill and white text: selection must never be ambiguous.
  const isUI = isUINodeType(data.type);
  const TypeIcon = isUI ? UI_ICONS[data.type] : TYPE_ICONS[data.type];

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    // react-dnd carries moves within the tree; these are for targets outside it (the Assets explorer,
    // node-reference fields). The dedicated MIME tells a scene node from other text/plain drags.
    event.dataTransfer.setData('text/cleo-node', data.id);
    event.dataTransfer.setData('text/plain', data.id);
  };

  const toggleVisibility = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (isPlayMode) return; // Don't allow visibility changes during play mode
    const target = editorScene?.getNodeById(data.id);
    if (target) target.visible = !target.visible;
  };

  return (
    <div
      id={data.id}
      ref={dragHandle}
      onDoubleClick={() => { if (node.isEditable) void node.edit(); }}
      onDragStart={handleDragStart}
      style={{ paddingLeft: GUTTER + node.level * INDENT }}
      className={`scene-item group relative flex items-center h-[22px] mt-[1px] pr-[6px] rounded-md overflow-hidden whitespace-nowrap ${
        selected ? 'bg-primary/40 text-white cursor-default'
          : node.willReceiveDrop ? 'bg-primary/20 cursor-pointer'
            : `${isUI ? 'text-node-ui ' : 'text-fg '}hover:bg-white/[0.06] cursor-pointer`}`}>
      <IndentGuides level={node.level} />
      {/* Always occupied, so names line up whether or not a row can be opened. */}
      <span className='flex items-center justify-center w-[16px] shrink-0 text-muted hover:text-fg z-[1]'
            onClick={(e) => { e.stopPropagation(); if (data.children.length) node.toggle(); }}>
        { data.children.length > 0 && <Chevron open={node.isOpen} /> }
      </span>
      {/* Dormant nodes (spawnOnStart off) read as "present but asleep": the row is dimmed, but stays fully
          interactive — it is still authored here, and the only way to select it. */}
      <div className={`flex items-center min-w-0 flex-1 ${data.spawnOnStart === false ? 'opacity-50' : ''}`}
           title={data.spawnOnStart === false ? 'Dormant until a script spawns it' : undefined}>
        { TypeIcon && <span className='inline-flex w-4 h-4 mr-1.5 align-middle items-center justify-center'><TypeIcon /></span> }
        { node.isEditing ? <RenameInput node={node} /> : <span className='truncate'>{data.name}</span> }
      </div>
      {/* The row's own controls. They fade in with the row rather than sitting there permanently, so a deep
          hierarchy reads as names first and buttons second. */}
      <div className='flex flex-row items-center shrink-0 gap-1 pl-1'>
        { data.scriptId &&
          <button
            title={scriptGrey ? 'Edit script (authored in the template)' : 'Edit script'}
            onClick={(e) => { e.stopPropagation(); enterScriptEditor(data.scriptId); }}
            onMouseEnter={() => hoveredScriptStore.set(data.scriptId ?? null)}
            onMouseLeave={() => hoveredScriptStore.set(null)}
            className={`inline-flex items-center justify-center w-4 h-4 transition-colors ${
              scriptHot ? 'text-highlight' : scriptGrey ? 'text-white/35 hover:text-white/70' : 'text-white/70 hover:text-highlight'}`}>
            <ScriptIcon />
          </button>
        }
        { data.templateId &&
          <button
            title='Edit template'
            onClick={(e) => { e.stopPropagation(); enterTemplateEditor(data.templateId); }}
            className='inline-flex items-center justify-center w-4 h-4 text-white/70 hover:text-highlight transition-colors'>
            <PenIcon />
          </button>
        }
        {/* A button rather than the <img onClick> this used to be: it is a control, so it should be
            focusable and activate on Enter like the script and template buttons beside it. */}
        <button
          type='button'
          onClick={toggleVisibility}
          title={data.visible ? 'Hide' : 'Show'}
          className={`inline-flex items-center justify-center w-4 h-4 transition-opacity ${
            data.visible ? 'opacity-0 group-hover:opacity-60 hover:!opacity-100 focus-visible:opacity-100' : 'opacity-70 hover:opacity-100'}`}>
          {data.visible ? <VisibleIcon /> : <HiddenIcon />}
        </button>
      </div>
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
  const { editorScene, eventEmitter, bodies, triggers, isPlayMode, editorMode, templateRootId, attachScriptToNode,
          activeTab, sceneList, openSceneId, selectedNode } = useCleoEngine()
  const [ nodes, setNodes ] = useState<NodeDescription | null>(null);
  const [ filter, setFilter ] = useState('');
  const treeRef = useRef<TreeApi<NodeDescription> | undefined>(undefined);
  // react-arborist is virtualized, so it needs real pixel dimensions; the same element also scopes its
  // drag-and-drop backend, which would otherwise disable every native drop in the editor (see treeDnd).
  const { ref: viewportRef, element: viewportEl, size } = useElementSize<HTMLDivElement>();
  const dndManager = useScopedDndManager(viewportEl);

  // The scene tab's root row is labelled from SceneMeta; the engine node stays named 'root' because
  // Scene.parse re-finds the root by that literal name. Display only.
  const sceneName = activeTab.kind === 'scene' ? sceneList.find(s => s.id === openSceneId)?.name : undefined;

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
    const onSceneChanged = (e?: SceneChange) => {
      if (e && e.kind !== 'structure' && e.kind !== 'visibility' && e.kind !== 'name') return;
      rebuild();
    };
    eventEmitter.on('SCENE_CHANGED', onSceneChanged);
    return () => { eventEmitter.off("SCENE_CHANGED", onSceneChanged) }; // Remove the listener on component unmount
  }, [eventEmitter, generateNodeList, treeRoot, sceneName]);

  const rootId = nodes?.id;
  const data = useMemo(() => (nodes ? [nodes] : []), [nodes]);

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

  const handleSelect = (selection: { id: string }[]) => {
    if (isPlayMode) return; // Don't allow node selection during play mode
    const id = selection.length ? selection[selection.length - 1].id : null;
    if (id === selectedRef.current) return; // the echo of the sync above, or a rebuild re-reporting the same row
    eventEmitter.emit('SELECT_NODE', id);
  };

  // --- moving nodes ---------------------------------------------------------------------------------

  // Rows stay draggable even when they cannot be re-parented (a node with a body, the root): the same
  // gesture drops a node onto the Assets explorer to save it as a template. What a move may do is here.
  const handleMove = ({ dragIds, parentId, index }: { dragIds: string[]; parentId: string | null; index: number }) => {
    if (isPlayMode) return;
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
      // TODO: Temporary solution, in the future inner nodes should be able to have bodies
      if (bodies.get(id)) { Logger.warn('Cannot move a node with a body', 'Editor'); continue; }
      // Dragging a parent already carries its children; moving them too would flatten the subtree.
      if (node.parent && dragging.has(node.parent.id)) continue;
      if (node === parent || isAncestorOf(node, parent)) {
        Logger.warn('Cannot move a node to its child', 'Editor');
        continue;
      }
      moving.push(node);
    }
    if (!moving.length) return;

    // react-arborist counts `index` among the parent's VISIBLE children with the dragged rows still in
    // place; addChild indexes the real children array, which also holds terrain chunks and editor helpers.
    // Anchoring on the sibling the rows land in front of translates between the two, and the -1 accounts
    // for addChild detaching the node before it splices it back in.
    // A drop ON a row is also reported as index 0, so the two cases are told apart by the cursor shown.
    const siblings = shownChildren(parent);
    const anchor = treeRef.current?.cursorOverFolder ? undefined : siblings[index];
    let engineIndex = anchor ? parent.children.indexOf(anchor) : parent.children.length;
    for (const node of moving) {
      const from = node.parent === parent ? parent.children.indexOf(node) : -1;
      parent.addChild(node, from >= 0 && from < engineIndex ? engineIndex - 1 : engineIndex);
      engineIndex = parent.children.indexOf(node) + 1;
    }
  };

  // --- rename / delete ------------------------------------------------------------------------------

  const handleRename = ({ id, name }: { id: string; name: string }) => {
    const node = editorScene?.getNodeById(id);
    if (!node || name === node.name) return;
    const problem = validateNodeName(name);
    if (problem) { Logger.warn(problem, 'Editor'); return; }
    // No event of our own: the engine's name setter emits SCENE_CHANGED { kind: 'name' }, which rebuilds
    // this tree, refreshes the Properties panel and marks the tab unsaved.
    node.name = name;
  };

  const handleDelete = ({ ids }: { ids: string[] }) => {
    if (isPlayMode) return;
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
    if (!nativeDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop: React.DragEventHandler<HTMLDivElement> = (event) => {
    const kind = nativeDrag(event.dataTransfer.types);
    if (!kind) return;
    event.preventDefault();
    event.stopPropagation();

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
    addItemTo(item, parent, { editorScene, eventEmitter, triggers }).catch(err => console.error(err));
  };

  // Delete and F2, on top of react-arborist's own keymap. Capture phase and stopping propagation, because
  // react-arborist treats any unrecognised key as type-ahead. Ignored while a field has focus.
  const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
    const tree = treeRef.current;
    if (!tree || tree.isEditing) return;
    if ((event.target as HTMLElement).closest('input')) return;
    if (event.key !== 'Delete' && event.key !== 'F2') return;
    event.preventDefault();
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
    <div className='flex flex-col text-white bg-surface-raised w-full h-full min-h-[40px] overflow-hidden'
         onDragOverCapture={handleDragOver} onDropCapture={handleDrop} onKeyDownCapture={handleKeyDown}>
      <div className='shrink-0 px-[5px] py-1'>
        <input
          type='text' value={filter} placeholder='Filter nodes'
          onChange={(e) => setFilter(e.target.value)}
          className='type-value w-full bg-white/[0.06] text-white placeholder:text-dim rounded-md px-2 py-[3px] outline-none focus:bg-white/[0.1] transition-colors' />
      </div>
      <div ref={viewportRef} className='flex-1 min-h-0'>
        { dndManager && size.height > 0 &&
          <Tree<NodeDescription>
            ref={treeRef}
            data={data}
            dndManager={dndManager}
            width={size.width}
            height={size.height}
            rowHeight={ROW_HEIGHT}
            indent={INDENT}
            openByDefault
            selectionFollowsFocus
            searchTerm={filter}
            searchMatch={(node, term) => node.data.name.toLowerCase().includes(term.toLowerCase())}
            onSelect={handleSelect}
            onMove={handleMove}
            onRename={handleRename}
            onDelete={handleDelete}
            disableEdit={(d) => isPlayMode || d.id === rootId}
            disableDrop={({ parentNode }) => isPlayMode || !!parentNode.data.templateId || !editorScene?.getNodeById(parentNode.id)}
            renderCursor={DropCursor}
            className='outline-none'>
            {SceneNodeRow}
          </Tree>
        }
      </div>
    </div>
  )
}
