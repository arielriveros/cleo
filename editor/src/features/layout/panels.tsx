import { IDockviewPanelProps, IDockviewPanelHeaderProps } from 'dockview-react';
import { ModelNode } from 'cleo';
import EngineViewport from '../EngineViewport';
import UIEditorLayer from '../gameUi/UIEditorLayer';
import StateGraph from '../animation/StateGraph';
import FieldGraph from '../animationField/FieldGraph';
import LoadingScreen from '../../components/LoadingScreen';
import SceneInspector from '../sceneInspector/SceneInspector';
import AddNew from '../sceneInspector/AddNew';
import SkeletonTree from '../animation/SkeletonTree';
import { ClipsPanel as AnimClips, VariablesPanel as AnimVariables, StateMachinePanel as AnimStateMachine } from '../animation/StateMachineEditor';
import TerrainMaterialInspector from '../terrainMaterials/TerrainMaterialInspector';
import ModelInspector from '../models/ModelInspector';
import PropertyEditor from '../nodeInspector/propertyEditors/PropertyEditor';
import MaterialEditor from '../nodeInspector/propertyEditors/MaterialEditor';
import ScriptEditor from '../nodeInspector/scriptEditor/ScriptEditor';
import ScriptTabView from '../nodeInspector/scriptEditor/ScriptTabView';
import AnimationFieldPanel from '../animationField/AnimationFieldPanel';
import TilesetTabView from '../tileset/TilesetTabView';
import TextureTabView from '../texture/TextureTabView';
import TextureSettingsPanel from '../texture/TextureSettingsPanel';
import SoundTabView from '../sound/SoundTabView';
import SoundSettingsPanel from '../sound/SoundSettingsPanel';
import TilesetInspector from '../tileset/TilesetInspector';
import TilePalette from '../tilemap/TilePalette';
import TilemapLayersPanel from '../tilemap/TilemapLayersPanel';
import PhysicsEditor from '../nodeInspector/physicsEditors/PhysicsEditor';
import TemplateInstanceNotice from '../nodeInspector/TemplateInstanceNotice';
import { useSelectedNode } from '../nodeInspector/useSelectedNode';
import ConsolePanel from '../logger/ConsolePanel';
import PerformancePanel from '../renderer/PerformancePanel';
import RendererSettingsPanel from '../renderer/RendererSettingsPanel';
import AssetsExplorer from '../assets/AssetsExplorer';
import { useCleoEngine, MODE_RENDERS_VIEWPORT } from '../EngineContext';

// The wrapper must stay `relative` so UIOverlay/StateGraph/LoadingScreen (absolute inset-0) and the
// data-cleo-overlay HUD anchor to the viewport, not the dock. Its group is locked and headerless.
function ViewportPanel(_: IDockviewPanelProps) {
  const { isSceneReady, loadingProgress, editorMode } = useCleoEngine();
  return (
    <div className="relative h-full w-full overflow-hidden">
      <EngineViewport />
      {/* Game UI: real scene nodes, laid out by the engine and painted as DOM over the canvas. Gated on
          the same predicate as the viewport chrome — a UI node carrying a z-index would otherwise paint
          over the full-panel editors below, which cover the canvas completely. */}
      {MODE_RENDERS_VIEWPORT[editorMode] && <UIEditorLayer />}
      {/* Animation-mode node graph overlays the viewport when Graph view is active */}
      <StateGraph />
      {/* Animation-field mode: the blend-space plot overlays the viewport, with the 3D preview showing
          through it so the pose can be judged while the field is authored */}
      <FieldGraph />
      {/* Script mode: the dedicated code editor fills the main area (no 3D preview) */}
      {editorMode === 'script' && <ScriptTabView />}
      {/* Tileset mode: the atlas + slicing grid fills the main area (also no 3D preview) */}
      {editorMode === 'tileset' && <TilesetTabView />}
      {/* Texture mode: the image, drawn the way its sampling settings say it is read. No 3D preview. */}
      {editorMode === 'texture' && <TextureTabView />}
      {/* Sound mode: the waveform, transport and loop region fill the main area. No 3D preview. */}
      {editorMode === 'soundSample' && <SoundTabView />}
      {/* Loading splash covers only the viewport; the rest of the editor stays visible */}
      {!isSceneReady && <LoadingScreen progress={loadingProgress} />}
    </div>
  );
}

// Vertical scroll, no horizontal overflow. `scroll={false}` is for a panel that scrolls its own content:
// the virtualized trees need a bounded height, and an outer scroller adds a second idle scrollbar.
function SidePanel({ children, scroll = true }: { children: React.ReactNode; scroll?: boolean }) {
  return (
    <div className={`flex flex-col h-full w-full overflow-x-hidden select-none ${scroll ? 'overflow-y-auto' : 'overflow-y-hidden'}`}>
      {children}
    </div>
  );
}

// The Scene panel doubles as the Animation editor's skeleton tree (DockLayout retitles the tab).
function ScenePanel(_: IDockviewPanelProps) {
  const { editorMode } = useCleoEngine();
  return <SidePanel scroll={false}>{editorMode === 'animation' ? <SkeletonTree /> : <SceneInspector />}</SidePanel>;
}

// The two Add palettes: the same `AddNew` grid over the same catalog and drop handlers, with `scope`
// picking which half of the categories each shows.
function SceneAddPanel(_: IDockviewPanelProps) {
  return <SidePanel><AddNew scope='scene' /></SidePanel>;
}
function UIAddPanel(_: IDockviewPanelProps) {
  return <SidePanel><AddNew scope='ui' /></SidePanel>;
}

// Material editor mode: the panel focuses on the preview sphere's material only (name + controls).
function MaterialPanel() {
  const { editingMaterialName, setActiveMaterialName, eventEmitter } = useCleoEngine();
  const { node } = useSelectedNode();
  return (
    <div className='flex flex-col text-white bg-surface-raised w-full h-full overflow-y-auto'>
      <div className='p-2 border-b border-border'>
        <label className='text-xs text-slate-300 block mb-1'>Material name</label>
        <input
          className='bg-control text-white border border-border rounded px-2 py-1 w-full text-sm'
          value={editingMaterialName ?? ''}
          onChange={(e) => setActiveMaterialName(e.target.value)} />
      </div>
      {/* Any edit inside the material controls marks the tab dirty (drives the unsaved dot / close guard). */}
      {node && node.nodeType === 'model' &&
        <div onChange={() => eventEmitter.emit('SCENE_CHANGED')}>
          <MaterialEditor node={node as ModelNode} />
        </div>}
    </div>
  );
}

// The Properties panel hosts the mode-specific inspectors too, so DockLayout retitles its tab per mode.
// Animation is the exception: it has its own three panels and hides Properties entirely.
function PropertiesPanel(_: IDockviewPanelProps) {
  const { editorMode, editingTerrainMaterialNode } = useCleoEngine();
  const { node, readOnly } = useSelectedNode();

  // Terrain-material mode edits the dedicated unrendered edit node; the visible preview node carries
  // the composite terrain material.
  if (editorMode === 'terrainMaterial') return <SidePanel><TerrainMaterialInspector node={editingTerrainMaterialNode} /></SidePanel>;
  if (editorMode === 'material') return <SidePanel><MaterialPanel /></SidePanel>;
  if (editorMode === 'tileset') return <SidePanel><TilesetInspector /></SidePanel>;
  if (editorMode === 'texture') return <SidePanel><TextureSettingsPanel /></SidePanel>;
  if (editorMode === 'soundSample') return <SidePanel><SoundSettingsPanel /></SidePanel>;
  // Mesh mode keeps the normal node inspector below the mesh-level controls (LOD levels + cull).
  if (editorMode === 'model') return (
    <SidePanel>
      <ModelInspector />
      {node && <PropertyEditor node={node} readOnly={readOnly} />}
    </SidePanel>
  );

  return (
    <SidePanel>
      {readOnly && <TemplateInstanceNotice />}
      {node && <PropertyEditor node={node} readOnly={readOnly} />}
    </SidePanel>
  );
}

function ScriptsPanel(_: IDockviewPanelProps) {
  return <SidePanel><ScriptEditor /></SidePanel>;
}

function PhysicsPanel(_: IDockviewPanelProps) {
  const { node, readOnly } = useSelectedNode();
  return (
    <SidePanel>
      {readOnly && <TemplateInstanceNotice />}
      {node &&
        <fieldset disabled={readOnly} className={`${readOnly ? 'opacity-60' : ''} border-0 m-0 p-0 min-w-0`}>
          <PhysicsEditor node={node} />
        </fieldset>}
    </SidePanel>
  );
}

// The console owns its own scrolling (stick-to-bottom), so the wrapper must not add a second one.
function LoggerPanel(_: IDockviewPanelProps) {
  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <ConsolePanel />
    </div>
  );
}

function AssetsPanel(_: IDockviewPanelProps) {
  return (
    <div className="flex flex-col h-full w-full text-white bg-surface-raised overflow-hidden">
      <AssetsExplorer />
    </div>
  );
}

// The animation editor's three panels. They share one StateMachineProvider session wrapping the whole
// dock (Editor.tsx), so each can be dragged anywhere. Each fills and scrolls itself, so no SidePanel.
function AnimClipsPanel(_: IDockviewPanelProps) { return <AnimClips />; }
// The Animation Field editor's single panel, inside the same dock-wide provider (Editor.tsx).
function AnimFieldPanel(_: IDockviewPanelProps) { return <AnimationFieldPanel />; }
function AnimVariablesPanel(_: IDockviewPanelProps) { return <AnimVariables />; }
function AnimStateMachinePanel(_: IDockviewPanelProps) { return <AnimStateMachine />; }
// The tilemap editor's two panels. Shown only in tilemap mode — see hiddenPanelIds.
function TilePalettePanel(_: IDockviewPanelProps) { return <TilePalette />; }
function TilemapLayersDockPanel(_: IDockviewPanelProps) { return <SidePanel><TilemapLayersPanel /></SidePanel>; }
// The two renderer-mode panels. Both own their scrolling, so neither takes a SidePanel wrapper.
function PerformanceDockPanel(_: IDockviewPanelProps) {
  return (
    <div className="flex flex-col h-full w-full bg-surface-raised overflow-hidden">
      <PerformancePanel />
    </div>
  );
}

function RendererSettingsDockPanel(_: IDockviewPanelProps) {
  return (
    <div className="flex flex-col h-full w-full bg-surface-raised overflow-hidden">
      <RendererSettingsPanel />
    </div>
  );
}

// Panels are movable but not closable, so the tab renders the title only; dockview's tab wrapper still
// owns drag behavior and colors.
export function PanelTab(props: IDockviewPanelHeaderProps) {
  return (
    <div className="flex items-center h-full px-2 text-xs whitespace-nowrap select-none">
      {props.api.title}
    </div>
  );
}

export const dockComponents = {
  viewport: ViewportPanel,
  scene: ScenePanel,
  sceneAdd: SceneAddPanel,
  uiAdd: UIAddPanel,
  properties: PropertiesPanel,
  scripts: ScriptsPanel,
  physics: PhysicsPanel,
  logger: LoggerPanel,
  assets: AssetsPanel,
  animClips: AnimClipsPanel,
  animVariables: AnimVariablesPanel,
  animStateMachine: AnimStateMachinePanel,
  animField: AnimFieldPanel,
  tilePalette: TilePalettePanel,
  tilemapLayers: TilemapLayersDockPanel,
  performance: PerformanceDockPanel,
  rendererSettings: RendererSettingsDockPanel,
};
