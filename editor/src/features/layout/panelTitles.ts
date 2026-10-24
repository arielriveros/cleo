import type { EditorMode } from '../engineContextTypes';

// The dock's panel titles and the docs page each panel's content is described on. A plain module (no
// React, no engine) so the docs coverage test can check every title against docs/editor/interface.md.

// The Scene panel hosts the mode-specific tree, so its tab label follows the mode.
export const PANEL_TITLES: Record<string, string> = {
  viewport: 'Viewport', scene: 'Scene', sceneAdd: 'Scene Elements', uiAdd: 'UI Elements', properties: 'Properties',
  scripts: 'Scripts', physics: 'Physics', logger: 'Logger', assets: 'Assets',
  animClips: 'Clips', animVariables: 'Parameters', animStateMachine: 'Animator',
  animField: 'Blend Space Settings', animFieldPlot: 'Blend Space',
  clipTracks: 'Clip', clipTimeline: 'Timeline',
  particleTransport: 'Particle Preview',
  tilePalette: 'Tiles', tilemapLayers: 'Layers',
  landscapeTools: 'Landscape Tools', landscapeLayers: 'Landscape Layers',
  optionsEngine: 'Engine', optionsEditor: 'Editor', optionsProject: 'Project',
};

/** Every title `panelTitle` can return beyond PANEL_TITLES, for the coverage test. */
export const MODE_PANEL_TITLES = ['Skeleton', 'Material', 'Landscape Material', 'Tileset', 'Brain', 'Particle System', 'Texture', 'Sound'] as const;

export function panelTitle(id: string, mode: EditorMode): string {
  if (id === 'scene' && (mode === 'stateMachine' || mode === 'rig' || mode === 'animation')) return 'Skeleton';
  if (id === 'properties') {
    if (mode === 'material') return 'Material';
    if (mode === 'terrainMaterial') return 'Landscape Material';
    if (mode === 'tileset') return 'Tileset';
    if (mode === 'aiBrain') return 'Brain';
    if (mode === 'particleSystem') return 'Particle System';
    if (mode === 'texture') return 'Texture';
    if (mode === 'soundSample') return 'Sound';
    if (mode === 'rig') return 'Skeleton';
  }
  return PANEL_TITLES[id];
}

/** Where a dock tab's own card comes from: the "Every panel" table. */
export const PANEL_TAB_DOC_PAGE = 'editor/interface';
export const PANEL_TAB_DOC_SECTION = 'every-panel';

/**
 * The page that documents what a mode puts in the viewport and in Properties — the outermost scope of
 * every title inside those panels. Exhaustive, so a new mode has to say where it is documented.
 */
export const MODE_DOC_PAGE: Record<EditorMode, string> = {
  scene: 'editor/scene-authoring',
  template: 'editor/scene-authoring',
  landscape: 'editor/terrain',
  tilemap: 'editor/tilemap-2d',
  ui: 'editor/ui',
  options: 'editor/options',
  material: 'editor/models-and-materials',
  terrainMaterial: 'editor/terrain',
  stateMachine: 'editor/animation',
  animation: 'editor/animation',
  animationField: 'editor/animation',
  model: 'editor/models-and-materials',
  script: 'editor/scripting-workflow',
  tileset: 'editor/tilemap-2d',
  texture: 'editor/assets',
  soundSample: 'editor/audio',
  aiBrain: 'editor/ai-brains',
  rig: 'editor/animation',
  particleSystem: 'editor/particles',
};

const PANEL_DOC_PAGE: Record<string, string> = {
  sceneAdd: 'editor/scene-authoring', uiAdd: 'editor/scene-authoring',
  scripts: 'editor/scripting-workflow', physics: 'editor/physics',
  logger: 'editor/interface', assets: 'editor/assets',
  animClips: 'editor/animation', animVariables: 'editor/animation', animStateMachine: 'editor/animation',
  animField: 'editor/animation', animFieldPlot: 'editor/animation',
  clipTracks: 'editor/animation', clipTimeline: 'editor/animation',
  particleTransport: 'editor/particles',
  tilePalette: 'editor/tilemap-2d', tilemapLayers: 'editor/tilemap-2d',
  landscapeTools: 'editor/terrain', landscapeLayers: 'editor/terrain',
  optionsEngine: 'editor/options', optionsEditor: 'editor/options', optionsProject: 'editor/options',
};

/** The docs page a panel's content is described on, in a mode. */
export function panelDocPage(id: string, mode: EditorMode): string {
  if (id === 'viewport') return MODE_DOC_PAGE[mode];
  if (id === 'scene') return panelTitle(id, mode) === 'Skeleton' ? 'editor/animation' : 'editor/scene-authoring';
  // Scene-like modes show the node inspector; PropertyEditor declares that page itself, so a model tab's
  // mesh controls (models-and-materials) and its node inspector each resolve where they are documented.
  if (id === 'properties') return MODE_DOC_PAGE[mode];
  return PANEL_DOC_PAGE[id] ?? MODE_DOC_PAGE[mode];
}
