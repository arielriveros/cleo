import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  SerializedDockview,
} from 'dockview-react';
import { dockComponents, PanelTab } from './panels';
import { PANEL_TITLES, panelTitle } from './panelTitles';
import { EditorMode, useCleoEngine } from '../EngineContext';
import { LS_KEYS, lsKey } from '../../utils/lsScope';
import { cleoDockTheme as cleoTheme, lockAnchorPanel } from '@cleo/app-kit/layout/DockShell';
import { setOptionsPage } from '@cleo/app-kit/ui/OptionsShell';
import { useEditorPrefs } from '../options/editorPrefs';

// Per-project. Both live keys resolve through lsScope, so deleting a project takes them with it.
const dockLayoutKey = () => lsKey(LS_KEYS.dockLayout);
// Pre-dockview layout blob ({ barsDimensions, bottomTab }); removed once on startup.
const OLD_LAYOUT_KEY = 'cleo_project_layout';
// Superseded layout keys, cleared on startup. Bump LAYOUT_VERSION whenever the panel set or the store's
// shape changes: a stored tree cannot gain a panel it has never heard of, and a stale panel id resolves
// to a component that no longer exists.
const OLD_DOCK_LAYOUT_KEYS = [
  'cleo_dock_layout_v1', 'cleo_dock_layout_v2', 'cleo_dock_layout_v3', 'cleo_dock_layout_v4',
  'cleo_dock_layout_v5', 'cleo_dock_layout_v6', 'cleo_dock_layout_v7', 'cleo_dock_layout_v8',
  'cleo_dock_layout_v9', 'cleo_dock_layout_v10', 'cleo_dock_layout_v14', 'cleo_dock_layout_v15',
  'cleo_dock_layout_v18',
];
// 13: the AI modes came and went; a tree stored at 12 still references panels that no longer exist,
// and one from 11 predates them. A stored tree cannot gain or lose a panel on its own, so every saved
// arrangement is discarded.
// 15: the rig mode arrived, and it reuses the Scene panel as a skeleton tree the way animation does — a
// tree stored at 14 has no arrangement for it.
// 16: the clip editor arrived with two panels of its own, and the old `animation` mode was renamed
// `stateMachine` — so a tree stored at 15 is keyed by a mode name that no longer exists AND has no
// arrangement for the new panels. Both halves make a stored layout unreadable rather than merely stale.
// 17: landscape mode gained its Tools and Layers panels; a tree stored at 16 has nowhere for them.
// 18: those two panels moved apart — Layers into a group of its own under the right rail, because
// painting needs the tool AND the layer it paints into on screen at the same time, and a tree stored at
// 17 has them tabbed behind Properties where the material slots could not be found.
// 19: the particle-system mode arrived with a transport panel of its own in the bottom strip; a tree
// stored at 18 has no `particleTransport` and no arrangement for the mode.
// 20: Renderer and Input modes folded into one Options mode with Engine / Editor / Project panels; a
// tree stored at 19 has the retired panels and no arrangement for the new ones.
// 21: the clip editor became the Clip Player, and its right-rail panel `clipTracks` (per-bone key tracks)
// became `clipInspector`; a tree stored at 20 names a panel that no longer exists.
// 22: the rig mode's Ragdoll and Bone Masks moved out of Properties into tabs of their own; a tree stored at
// 21 has nowhere for them.
// 23: Options mode opens at a quarter of the width (sizeOptionsRail). Nothing else changed, so a store
// at 22 is still read; only its Options tree is dropped, which rebuilds that one mode at the new size.
// 24: the Sequencer arrived in the bottom strip of the scene and template modes; a tree stored at 23 has
// nowhere for it.
const LAYOUT_VERSION = 24;

/**
 * One saved arrangement per editor mode. There is deliberately no key for play: play is a restriction
 * applied on top of a mode, so nothing is saved while playing and Stop restores `layouts[mode]`.
 */
type LayoutStore = { version: typeof LAYOUT_VERSION; layouts: Partial<Record<EditorMode, SerializedDockview>> };

/**
 * Which of the stacked bottom panels the user last chose. Tracked outside the dockview layout blob so it
 * survives a restricted mode's discarded arrangement, the buildDefaultLayout fallback, and a reload.
 */
const bottomTabKey = () => lsKey(LS_KEYS.dockBottomTab);
const BOTTOM_PANELS = ['logger', 'assets', 'sequencer'] as const;
type BottomPanel = (typeof BOTTOM_PANELS)[number];

function loadBottomTab(): BottomPanel {
  try {
    const v = localStorage.getItem(bottomTabKey());
    if (v && (BOTTOM_PANELS as readonly string[]).includes(v)) return v as BottomPanel;
  } catch { /* ignore */ }
  return 'logger';
}

/**
 * Which bottom tab is currently selected, or null when the mode hides them both. Must read the group's
 * `activePanel`, not `panel.api.isVisible`: both bottom panels are `renderer: 'always'`, so visibility
 * does not track tab selection for them.
 */
function activeBottomTab(dock: DockviewApi): BottomPanel | null {
  for (const id of BOTTOM_PANELS) {
    const selected = dock.getPanel(id)?.group?.activePanel?.id;
    if (selected && (BOTTOM_PANELS as readonly string[]).includes(selected)) return selected as BottomPanel;
  }
  return null;
}

/** State-machine panels. Present in every layout, shown only in that mode — see hiddenPanelIds. */
const STATE_MACHINE_PANELS = ['animClips', 'animVariables', 'animStateMachine'] as const;

/**
 * Clip Player panels: the clip inspector on the right rail, and the timeline (transport + Events track)
 * down in the bottom strip beside Logger and Assets. Same arrangement as ANIMATION_FIELD_PANELS, and for the
 * same reason — a timeline is a wide, short thing that wants the full width of the window.
 */
const CLIP_PANELS = ['clipInspector', 'clipTimeline'] as const;

/**
 * Animation-field panels: the settings sidebar on the right rail, and the blend-space plot down in the
 * bottom strip with Logger and Assets. Same visibility arrangement as STATE_MACHINE_PANELS.
 */
const ANIMATION_FIELD_PANELS = ['animField', 'animFieldPlot'] as const;

/**
 * Particle-editor panels: the preview transport, down in the bottom strip with Logger and Assets — a work
 * surface, like the clip timeline. Its emitter stack needs no panel of its own: it lives in Properties.
 */
const PARTICLE_PANELS = ['particleTransport'] as const;

/** Tilemap-editor panels: the tile palette and the layer stack. Shown only in tilemap mode. */
const TILEMAP_PANELS = ['tilePalette', 'tilemapLayers'] as const;

/** Landscape-mode panels: the brush and its tools, and the base + paint layer stack. Shown only there. */
const LANDSCAPE_PANELS = ['landscapeTools', 'landscapeLayers'] as const;

/**
 * Rig-mode panels: the skeleton's ragdoll and its bone masks, tabbed beside Properties (titled Skeleton) so
 * each gets the whole rail instead of a stretch of one long inspector. Shown only in rig mode.
 */
const RIG_PANELS = ['rigRagdoll', 'rigBoneMasks'] as const;

/** The two Add palettes, stacked as tabs above the Scene tree. Ordinary chrome, shown wherever the tree is. */
const ADD_PANELS = ['sceneAdd', 'uiAdd'] as const;

/**
 * Options-mode panels: engine (renderer, performance, runtime), editor (preferences) and project (general,
 * input map). Shown only there, over the live viewport, with every other panel hidden.
 */
const OPTIONS_PANELS = ['optionsEngine', 'optionsEditor', 'optionsProject'] as const;

/**
 * The Sequencer: the timeline of the selected Sequence node, down in the bottom strip beside Logger and
 * Assets. It edits the AUTHORED scene, so it shows in scene and template modes and not while Simulating.
 */
const SEQUENCER_PANELS = ['sequencer'] as const;


const CHROME_PANELS = [
  'scene', 'properties', 'scripts', 'physics', 'logger', 'assets',
  ...STATE_MACHINE_PANELS, ...ANIMATION_FIELD_PANELS, ...CLIP_PANELS, ...PARTICLE_PANELS, ...TILEMAP_PANELS, ...LANDSCAPE_PANELS,
  ...RIG_PANELS, ...ADD_PANELS, ...SEQUENCER_PANELS,
] as const;


// The viewport is the immovable center anchor: no tab header and no dropping into it; edge drops beside
// it still work. Returns false when the panel is missing, which marks a restored layout as corrupt.
const assertViewportLock = (api: DockviewApi): boolean => lockAnchorPanel(api, 'viewport');

// Scene/UI tabbed 20vw left, Properties/Scripts/Physics tabbed 25vw right, Logger/Assets in a 30vh strip
// under the viewport only. Every panel can be dragged out of its group and re-docked.
function buildDefaultLayout(api: DockviewApi) {
  api.clear();
  const width = api.width || window.innerWidth;
  const height = api.height || window.innerHeight;
  api.addPanel({ id: 'viewport', component: 'viewport', title: 'Viewport', renderer: 'always' });
  const scene = api.addPanel({
    id: 'scene', component: 'scene', title: 'Scene',
    position: { referencePanel: 'viewport', direction: 'left' },
    initialWidth: Math.round(width * 0.20),
  });
  // The palettes sit in their own group ABOVE the tree so the tree stays visible while either is in use.
  // The only place a non-viewport panel is split rather than tabbed.
  api.addPanel({
    id: 'sceneAdd', component: 'sceneAdd', title: PANEL_TITLES['sceneAdd'],
    position: { referencePanel: 'scene', direction: 'above' },
    initialHeight: Math.round(height * 0.34),
  });
  api.addPanel({
    id: 'uiAdd', component: 'uiAdd', title: PANEL_TITLES['uiAdd'],
    position: { referencePanel: 'sceneAdd', direction: 'within' },
  });
  const properties = api.addPanel({
    id: 'properties', component: 'properties', title: 'Properties',
    position: { referencePanel: 'viewport', direction: 'right' },
    initialWidth: Math.round(width * 0.25),
  });
  api.addPanel({
    id: 'scripts', component: 'scripts', title: 'Scripts',
    position: { referencePanel: 'properties', direction: 'within' },
  });
  api.addPanel({
    id: 'physics', component: 'physics', title: 'Physics',
    position: { referencePanel: 'properties', direction: 'within' },
  });
  // The animation panels share the Properties tab strip; they are hidden everywhere but the one mode that
  // owns them, where Properties itself is hidden. `clipInspector` joins them; `clipTimeline` goes below.
  // The rig panels are tabs beside Properties, which rig mode keeps (as Skeleton) and opens on.
  for (const id of [...STATE_MACHINE_PANELS, 'animField', 'clipInspector', ...TILEMAP_PANELS, 'landscapeTools', ...RIG_PANELS]) {
    api.addPanel({
      id, component: id, title: PANEL_TITLES[id],
      position: { referencePanel: 'properties', direction: 'within' },
    });
  }
  // The landscape layer stack gets a group of its OWN under the right rail rather than a tab beside the
  // tools: painting is a two-handed job — the brush in one panel, the layer it paints into (and that
  // layer's material) in the other — and behind a tab the material slots simply were not found.
  api.addPanel({
    id: 'landscapeLayers', component: 'landscapeLayers', title: PANEL_TITLES['landscapeLayers'],
    position: { referencePanel: 'properties', direction: 'below' },
    initialHeight: Math.round(height * 0.45),
  });
  // Docked with Properties on the right rail. None of these is in CHROME_PANELS, so they survive into
  // the mode that owns them, where the rest of that tab strip is hidden.
  for (const id of OPTIONS_PANELS) {
    api.addPanel({
      id, component: id, title: PANEL_TITLES[id],
      position: { referencePanel: 'properties', direction: 'within' },
    });
  }
  scene.api.setActive();
  properties.api.setActive();
  // Logger and Assets need renderer:'always' so the hidden tab stays in the DOM: unmounting the asset
  // explorer tears down the SVAR store + drag patch and loses the folder being browsed.
  const logger = api.addPanel({
    id: 'logger', component: 'logger', title: 'Logger', renderer: 'always',
    position: { referencePanel: 'viewport', direction: 'below' },
    initialHeight: Math.round(height * 0.30),
  });
  const assets = api.addPanel({
    id: 'assets', component: 'assets', title: 'Assets', renderer: 'always',
    position: { referencePanel: 'logger', direction: 'within' },
  });
  // The blend-space plot belongs with Logger/Assets, not on the right rail: it is a work surface. Also
  // renderer:'always', so its transport keeps driving the animator while another bottom tab is up.
  api.addPanel({
    id: 'animFieldPlot', component: 'animFieldPlot', title: PANEL_TITLES['animFieldPlot'], renderer: 'always',
    position: { referencePanel: 'logger', direction: 'within' },
  });
  // The clip timeline, for exactly the same reasons: a work surface that wants the window's full width,
  // and a transport that must keep driving the animator when another bottom tab is showing.
  api.addPanel({
    id: 'clipTimeline', component: 'clipTimeline', title: PANEL_TITLES['clipTimeline'], renderer: 'always',
    position: { referencePanel: 'logger', direction: 'within' },
  });
  // The particle transport joins them. Not `renderer: 'always'`: the preview scene plays on the engine's
  // own clock, so nothing stops if the panel unmounts behind another bottom tab.
  api.addPanel({
    id: 'particleTransport', component: 'particleTransport', title: PANEL_TITLES['particleTransport'],
    position: { referencePanel: 'logger', direction: 'within' },
  });
  // The Sequencer: renderer:'always', so its preview clock keeps running behind another bottom tab.
  const sequencer = api.addPanel({
    id: 'sequencer', component: 'sequencer', title: PANEL_TITLES['sequencer'], renderer: 'always',
    position: { referencePanel: 'logger', direction: 'within' },
  });
  // Honour the remembered bottom tab; this is also the fallback when restoring a stashed layout fails.
  // animationField mode overrides this in restoreBottomTab, which runs after every layout build.
  const remembered = loadBottomTab();
  (remembered === 'assets' ? assets : remembered === 'sequencer' ? sequencer : logger).api.setActive();
  assertViewportLock(api);
}

/**
 * Re-assert `renderer: 'always'` on the panels that cannot survive being unmounted; a restored blob is not
 * guaranteed to carry it. The default 'onlyWhenVisible' unmounts an unselected panel, tearing down the SVAR
 * store and drag patch for `assets`, the WebGL canvas host for `viewport`, and the rAF loop that poses the
 * model for `animFieldPlot` and `clipTimeline`.
 *
 * NOT for a tab beside Properties: a restored group mixing 'always' with an unmounting active panel came
 * back with Properties' content missing (an empty Skeleton tab after every mode switch into rig mode). The
 * rig tabs re-read what they mirror when they mount instead (RAGDOLL_QUERY, QUERY_SELECTED_JOINT).
 */
function assertRenderers(api: DockviewApi) {
  for (const id of ['viewport', 'logger', 'assets', 'animFieldPlot', 'clipTimeline', 'sequencer']) {
    const panel = api.getPanel(id);
    if (panel && panel.api.renderer !== 'always') panel.api.setRenderer('always');
  }
}

function loadLayouts(): LayoutStore['layouts'] {
  try {
    const raw = localStorage.getItem(dockLayoutKey());
    if (!raw) return {};
    const saved = JSON.parse(raw) as LayoutStore;
    if (!saved?.layouts) return {};
    // See LAYOUT_VERSION 24: a stored tree cannot gain the Sequencer, so older arrangements are dropped.
    if (saved.version !== LAYOUT_VERSION) return {};
    return saved.layouts;
  } catch {
    return {};
  }
}

/** Store the current tree as `mode`'s arrangement, leaving every other mode's untouched. */
function saveLayoutFor(api: DockviewApi, mode: EditorMode) {
  try {
    const store: LayoutStore = { version: LAYOUT_VERSION, layouts: { ...loadLayouts(), [mode]: api.toJSON() } };
    localStorage.setItem(dockLayoutKey(), JSON.stringify(store));
  } catch { /* quota or a serialization failure — a lost arrangement is not worth breaking the editor */ }
}

/**
 * Options mode's rail at a quarter of the width. Its panels are tabs of the right rail, which starts at a
 * quarter too, but closing the left column for the mode hands that column's width to the rail (dockview
 * gives freed space to the last view), so a fresh Options tree would open at nearly half.
 */
function sizeOptionsRail(api: DockviewApi) {
  const group = api.getPanel('optionsEngine')?.group;
  if (group) group.api.setSize({ width: Math.round((api.width || window.innerWidth) * 0.25) });
}

function clearLayouts() {
  try { localStorage.removeItem(dockLayoutKey()); } catch { /* ignore */ }
}

/**
 * Force a layout pass after rebuilding the tree programmatically. `renderer: 'always'` panels are
 * positioned by a layout pass, not normal flow, so re-adding panels in the same tick leaves them stale.
 * Deferred a frame so the new groups have been measured first.
 */
function relayout(api: DockviewApi) {
  requestAnimationFrame(() => {
    const w = api.width || window.innerWidth;
    const h = api.height || window.innerHeight;
    try { api.layout(w, h, true); } catch { /* ignore */ }
  });
}

/**
 * Which panels a given mode / play state hides. A group is hidden once by default and a mode opts out, so
 * a new mode-specific group cannot leak into unrelated modes.
 */
export function hiddenPanelIds(mode: EditorMode, playing: boolean, simulating: boolean = false, pinPerformance: boolean = false): readonly string[] {
  // Options mode is the only branch that keeps the options panels, alone over the live viewport.
  if (mode === 'options') return CHROME_PANELS;
  // Play strips the chrome AND every mode-specific panel. Simulate does not: nobody is possessed, so the
  // editor stays the user's — the tree and Inspector show the running simulation, and the Engine options
  // panel (Performance, Renderer) can be docked beside it.
  // The one exception: the Performance page's lock keeps the Engine options panel up beside the game.
  if (playing && !simulating) {
    const hidden = [...CHROME_PANELS, ...OPTIONS_PANELS];
    return pinPerformance ? hidden.filter(id => id !== 'optionsEngine') : hidden;
  }

  const hidden = new Set<string>(simulating ? OPTIONS_PANELS.filter(id => id !== 'optionsEngine') : OPTIONS_PANELS);

  // Mode-specific panels: hidden everywhere, revealed by the single mode that owns them.
  if (mode !== 'stateMachine') for (const id of STATE_MACHINE_PANELS) hidden.add(id);
  if (mode !== 'animationField') for (const id of ANIMATION_FIELD_PANELS) hidden.add(id);
  if (mode !== 'tilemap') for (const id of TILEMAP_PANELS) hidden.add(id);
  if (mode !== 'landscape') for (const id of LANDSCAPE_PANELS) hidden.add(id);
  if (mode !== 'animation') for (const id of CLIP_PANELS) hidden.add(id);
  if (mode !== 'particleSystem') for (const id of PARTICLE_PANELS) hidden.add(id);
  if (mode !== 'rig') for (const id of RIG_PANELS) hidden.add(id);
  // The Sequencer edits a `.sequence` asset in its own tab, over the open scene: Sequencer mode alone shows it.
  if (mode !== 'sequence') for (const id of SEQUENCER_PANELS) hidden.add(id);

  const hide = (...ids: readonly string[]) => { for (const id of ids) hidden.add(id); };

  switch (mode) {
    // Each Add palette belongs to the mode that authors it: Scene Elements to scene mode, UI Elements to UI
    // mode. A template can hold either kind of node, so it keeps both.
    case 'scene':
      hide('uiAdd');
      break;
    case 'template':
      break;
    // Sequencer mode is Scene mode on the open scene with every property change keyed. What cannot be a key —
    // adding nodes, scripts, physics — is not offered: the tree and Properties stay, the Add palettes,
    // Scripts and Physics go.
    case 'sequence':
      hide(...ADD_PANELS, 'scripts', 'physics');
      break;
    // A screen rect has no rigid body.
    case 'ui':
      hide('physics', 'sceneAdd');
      break;
    // Landscape and tilemap keep the tree and Properties: a terrain's size and heightmap live there. They are
    // scene sub-modes, so they keep Scene Elements and leave UI Elements to UI mode.
    case 'landscape':
    case 'tilemap':
      hide('uiAdd', 'scripts', 'physics');
      break;
    // A model tab edits one thing, so there is no tree to browse: the model node stays selected (the
    // SELECT_NODE coercion in EngineContext) and Properties hosts both its inspector and its transform.
    case 'model':
      hide(...ADD_PANELS, 'scene', 'scripts', 'physics');
      break;
    // A rig is authored the way a skeleton is: the Scene panel becomes its bone tree (see panelTitle) and
    // Properties hosts the rig's own inspector. Unlike `animation` it keeps Properties, which is where its
    // clips, retarget table and IK live.
    case 'rig':
      hide(...ADD_PANELS, 'scripts', 'physics');
      break;
    // The state machine brings its own three panels; the Scene panel becomes the skeleton tree.
    case 'stateMachine':
      hide(...ADD_PANELS, 'scripts', 'physics', 'properties');
      break;
    // The Clip Player: the Scene panel is the bone tree, `clipInspector` holds the clip list and root
    // motion, and `clipTimeline` runs along the bottom. Properties would show the preview character's node,
    // which is not what is being edited.
    case 'animation':
      hide(...ADD_PANELS, 'scripts', 'physics', 'properties');
      break;
    // A field tab previews one model and edits one asset: its own panel is the only inspector that applies.
    case 'animationField':
      hide(...ADD_PANELS, 'scene', 'scripts', 'physics', 'properties');
      break;
    // Asset editors: Properties hosts the asset's own inspector, and there is no scene to browse.
    case 'material':
    case 'terrainMaterial':
    case 'tileset':
    case 'texture':
    case 'soundSample':
    case 'aiBrain':
      hide(...ADD_PANELS, 'scene', 'scripts', 'physics');
      break;
    // A particle tab previews ONE editor-owned node: there is no tree worth browsing, and Properties hosts
    // the emitter/module stack (see PropertiesPanel) rather than a node inspector.
    case 'particleSystem':
      hide(...ADD_PANELS, 'scene', 'scripts', 'physics');
      break;
    // A script tab is a pure code editor rendered over the viewport.
    case 'script':
      hide(...ADD_PANELS, 'scene', 'properties', 'scripts', 'physics');
      break;
  }

  // The Add palettes build into the AUTHORED scene, which is not the one on screen while Simulating.
  if (simulating) hide(...ADD_PANELS);
  // The Sequencer previews and edits the authored scene too.
  if (simulating) hide(...SEQUENCER_PANELS);

  return [...hidden];
}

export default function DockLayout() {
  const { eventEmitter, editorMode, isPlayMode, isSimulating } = useCleoEngine();
  const { pinPerformanceInPlay } = useEditorPrefs();
  const [api, setApi] = useState<DockviewApi | null>(null);
  // The controller's own memory of the last commit, not derived state: the effect needs the OUTGOING mode
  // to know which key to save the tree under before it swaps trees.
  const keyRef = useRef<EditorMode | null>(null);
  const playingRef = useRef(false);
  const bottomTabRef = useRef<BottomPanel>(loadBottomTab());
  // Non-zero while a layout pass we initiated is in flight. A rebuild emits a burst of layout events in
  // which the bottom group transiently reports the first tab, overwriting the remembered choice.
  const programmaticLayoutRef = useRef(0);
  // The rig tab a FOCUS_RIG_ASSET asked for while another mode was still up: the event fires right after
  // `enterRigEditor`, before the rig layout exists. Taken by the next mode pass, whichever mode it is.
  const pendingRigTabRef = useRef<string | null>(null);

  /** Run a programmatic layout change with bottom-tab tracking muted until its events have settled. */
  const withProgrammaticLayout = useCallback((fn: () => void) => {
    programmaticLayoutRef.current++;
    try { fn(); } finally {
      // relayout() defers a frame, so the trailing events arrive after this call returns.
      requestAnimationFrame(() => requestAnimationFrame(() => { programmaticLayoutRef.current--; }));
    }
  }, []);

  /**
   * Put the remembered bottom tab back if a layout pass moved it. A no-op when it is already showing or
   * the mode hides it entirely: `setActive` also takes global focus.
   *
   * animationField mode is the exception: the blend-space plot IS its work surface, so it takes the strip
   * there. bottomTabRef is deliberately not touched, so the user's Logger/Assets choice comes back intact
   * when the mode is left — which is also why animFieldPlot is not one of BOTTOM_PANELS.
   */
  const restoreBottomTab = useCallback((dock: DockviewApi) => {
    const want = editorMode === 'animationField' ? 'animFieldPlot'
      : editorMode === 'animation' ? 'clipTimeline'
      : editorMode === 'particleSystem' ? 'particleTransport'
      // The timeline is Sequencer mode's work surface.
      : editorMode === 'sequence' ? 'sequencer'
      : bottomTabRef.current;
    const panel = dock.getPanel(want);
    // Read the group directly rather than activeBottomTab(), which only knows the two persisted ids.
    if (panel && panel.group?.activePanel?.id !== want) panel.api.setActive();
  }, [editorMode]);

  // Legacy cleanup only. The mode controller below owns every path that builds a tree and runs immediately
  // after this, because `editorMode` is already correct on the first render.
  const onReady = (event: DockviewReadyEvent) => {
    try { localStorage.removeItem(OLD_LAYOUT_KEY); } catch { /* ignore */ }
    for (const key of OLD_DOCK_LAYOUT_KEYS) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    }
    setApi(event.api);
  };

  // Persist the current mode's arrangement (debounced). Muted only while playing: play is a transient
  // restriction, not an arrangement worth remembering.
  useEffect(() => {
    if (!api) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      const mode = keyRef.current;
      if (playingRef.current || !mode) return;
      saveLayoutFor(api, mode);
    };
    const disposable = api.onDidLayoutChange(() => {
      clearTimeout(timer);
      timer = setTimeout(flush, 300);
    });
    // localStorage is synchronous, so this flush lands a drag that finished inside the debounce window.
    window.addEventListener('beforeunload', flush);
    return () => { clearTimeout(timer); disposable.dispose(); window.removeEventListener('beforeunload', flush); };
  }, [api]);

  /**
   * Retitle for the mode and close the panels it forbids. Every path that produces a full layout must run
   * this, including Reset Layout, which builds one while the mode is unchanged.
   */
  const applyRestriction = useCallback((dock: DockviewApi) => {
    for (const id of Object.keys(PANEL_TITLES)) dock.getPanel(id)?.api.setTitle(panelTitle(id, editorMode));
    for (const id of hiddenPanelIds(editorMode, isPlayMode, isSimulating, pinPerformanceInPlay)) dock.getPanel(id)?.api.close();
  }, [editorMode, isPlayMode, isSimulating, pinPerformanceInPlay]);

  // Mode/play controller. One path serves mode->mode, mode->play and play->mode: bank the outgoing mode's
  // arrangement, put the incoming mode's tree up, then restrict it. applyRestriction must run even on a
  // saved tree — it also expresses play and repairs a tree written by a build with a different panel set.
  useEffect(() => {
    if (!api) return;
    const prev = keyRef.current;
    const wasPlaying = playingRef.current;
    withProgrammaticLayout(() => {
      // Never bank a play tree: it is viewport-only and would overwrite the real arrangement.
      if (prev && !wasPlaying) saveLayoutFor(api, prev);

      const saved = loadLayouts()[editorMode];
      let restored = false;
      if (saved) {
        try {
          // reuseExistingPanels keeps each panel's React subtree mounted across the swap; without it the
          // viewport re-parents the WebGL canvas on every mode switch.
          api.fromJSON(saved, { reuseExistingPanels: true });
          restored = assertViewportLock(api);
        } catch { restored = false; }
      }
      if (!restored) buildDefaultLayout(api);

      assertRenderers(api);
      applyRestriction(api);
      // A scene tree never carries the Engine options panel (scene mode closes it), so Simulate docks it
      // beside Properties itself: Performance is the reason to keep the editor open while simulating.
      // Inactive, so Properties stays the visible tab; the tree is never saved (playingRef mutes it).
      if (isSimulating && !api.getPanel('optionsEngine') && api.getPanel('properties')) {
        api.addPanel({
          id: 'optionsEngine', component: 'optionsEngine', title: PANEL_TITLES['optionsEngine'],
          position: { referencePanel: 'properties', direction: 'within' }, inactive: true,
        });
      }
      // Play with the Performance page locked: the viewport plus that page, docked on its right and open
      // on Performance. Never saved, like every play tree.
      if (isPlayMode && !isSimulating && pinPerformanceInPlay) {
        setOptionsPage('engine', 'performance');
        if (!api.getPanel('optionsEngine')) {
          api.addPanel({
            id: 'optionsEngine', component: 'optionsEngine', title: PANEL_TITLES['optionsEngine'],
            position: { referencePanel: 'viewport', direction: 'right' },
            initialWidth: Math.round((api.width || window.innerWidth) * 0.25),
          });
        }
      }
      // fromJSON restores the tab selected when the tree was saved; put the user's choice back.
      restoreBottomTab(api);
      // Landscape mode opens on its tools, not on Properties: the tools and the layer stack under them
      // ARE the mode. Skipped when they are already up, because setActive also takes global focus.
      if (editorMode === 'landscape') {
        const tools = api.getPanel('landscapeTools');
        if (tools && tools.group?.activePanel?.id !== 'landscapeTools') tools.api.setActive();
      }
      // Options opens on Engine, a quarter of the width, the first time; a saved Options tree remembers the
      // tab that was up and the width it was left at.
      if (editorMode === 'options' && !restored) {
        sizeOptionsRail(api);
        api.getPanel('optionsEngine')?.api.setActive();
      }
      // A mask or pose double-clicked from another mode: open on the tab that edits it.
      const rigTab = pendingRigTabRef.current;
      pendingRigTabRef.current = null;
      if (editorMode === 'rig' && rigTab) api.getPanel(rigTab)?.api.setActive();
      relayout(api); // opening/closing panels moves the always-rendered viewport and logger
    });
    keyRef.current = editorMode;
    playingRef.current = isPlayMode;
  }, [api, editorMode, isPlayMode, isSimulating, pinPerformanceInPlay, applyRestriction, restoreBottomTab, withProgrammaticLayout]);

  // Remember which bottom tab the user is on. When a mode hides both there is no selection to read, so
  // the remembered value is left alone.
  useEffect(() => {
    if (!api) return;
    const sync = () => {
      if (programmaticLayoutRef.current > 0) return; // mid-rebuild: the reported selection is transient
      const current = activeBottomTab(api);
      if (!current || current === bottomTabRef.current) return;
      bottomTabRef.current = current;
      try { localStorage.setItem(bottomTabKey(), current); } catch { /* ignore */ }
    };
    sync();
    const disposables = [api.onDidLayoutChange(sync), api.onDidActivePanelChange(sync)];
    return () => { disposables.forEach(d => d.dispose()); };
  }, [api]);

  // "New asset" flows focus the Assets tab (legacy per-kind tab names all meant Assets).
  useEffect(() => {
    if (!api) return;
    const onFocus = (tab: unknown) => {
      // A programmatic focus is still the tab the user ends up on, so it becomes the remembered one.
      const id: BottomPanel = tab === 'Logger' ? 'logger' : tab === 'Sequencer' ? 'sequencer' : 'assets';
      bottomTabRef.current = id;
      try { localStorage.setItem(bottomTabKey(), id); } catch { /* ignore */ }
      api.getPanel(id)?.api.setActive();
    };
    eventEmitter.on('FOCUS_BOTTOM_TAB', onFocus);
    return () => { eventEmitter.off('FOCUS_BOTTOM_TAB', onFocus); };
  }, [api, eventEmitter]);

  // A double-clicked mask or pose opens in the rig editor: bring up the tab that edits it. Which item is
  // focused inside that tab is RigContext's `focus`, which outlives the panel being mounted.
  useEffect(() => {
    if (!api) return;
    const onFocus = (e: { kind?: string } | undefined) => {
      const tab = e?.kind === 'boneMask' ? 'rigBoneMasks' : e?.kind === 'pose' ? 'properties' : null;
      if (!tab) return;
      if (keyRef.current === 'rig' && !playingRef.current) api.getPanel(tab)?.api.setActive();
      else pendingRigTabRef.current = tab;
    };
    eventEmitter.on('FOCUS_RIG_ASSET', onFocus);
    return () => { eventEmitter.off('FOCUS_RIG_ASSET', onFocus); };
  }, [api, eventEmitter]);

  useEffect(() => {
    if (!api) return;
    const onReset = () => {
      // Every mode, not just this one: reset is also the escape hatch for a corrupt stored arrangement.
      clearLayouts();
      withProgrammaticLayout(() => {
        buildDefaultLayout(api);
        // buildDefaultLayout adds EVERY panel and the mode has not changed, so the effect above will not
        // fire: reset must re-apply the restriction itself.
        assertRenderers(api);
        applyRestriction(api);
        if (editorMode === 'options') sizeOptionsRail(api);
        restoreBottomTab(api);
        relayout(api);
      });
    };
    eventEmitter.on('RESET_DOCK_LAYOUT', onReset);
    return () => { eventEmitter.off('RESET_DOCK_LAYOUT', onReset); };
  }, [api, eventEmitter, editorMode, applyRestriction, restoreBottomTab, withProgrammaticLayout]);

  // `data-editor-mode` lets the dock's skin tint a mode's chrome: Sequencer mode's headers turn orange, so it is
  // never mistaken for Scene mode, which it otherwise looks just like (app-kit styles/dockview.css).
  return (
    <div className="flex-1 min-h-0 relative" data-editor-mode={editorMode}>
      <DockviewReact
        components={dockComponents}
        defaultTabComponent={PanelTab}
        theme={cleoTheme}
        onReady={onReady}
      />
    </div>
  );
}
