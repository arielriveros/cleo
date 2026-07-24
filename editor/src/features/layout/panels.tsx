import { IDockviewPanelProps, IDockviewPanelHeaderProps } from 'dockview-react';
import { ModelNode } from 'cleo';
import EngineViewport from '../EngineViewport';
import UIOverlay from '../uiInspector/UIOverlay';
import StateGraph from '../animation/StateGraph';
import FieldGraph from '../animationField/FieldGraph';
import LoadingScreen from '../../components/LoadingScreen';
import SceneInspector from '../sceneInspector/SceneInspector';
import UIInspector from '../uiInspector/UIInspector';
import SkeletonTree from '../animation/SkeletonTree';
import { ClipsPanel as AnimClips, VariablesPanel as AnimVariables, StateMachinePanel as AnimStateMachine } from '../animation/StateMachineEditor';
import TerrainMaterialInspector from '../terrainMaterials/TerrainMaterialInspector';
import ModelInspector from '../models/ModelInspector';
import PropertyEditor from '../nodeInspector/propertyEditors/PropertyEditor';
import MaterialEditor from '../nodeInspector/propertyEditors/MaterialEditor';
import ScriptEditor from '../nodeInspector/scriptEditor/ScriptEditor';
import ScriptTabView from '../nodeInspector/scriptEditor/ScriptTabView';
import AnimationFieldPanel from '../animationField/AnimationFieldPanel';
import PhysicsEditor from '../nodeInspector/physicsEditors/PhysicsEditor';
import TemplateInstanceNotice from '../nodeInspector/TemplateInstanceNotice';
import { useSelectedNode } from '../nodeInspector/useSelectedNode';
import ConsolePanel from '../logger/ConsolePanel';
import AssetsExplorer from '../assets/AssetsExplorer';
import { useCleoEngine } from '../EngineContext';

// The viewport panel reproduces the old Center stack: a `relative` wrapper so UIOverlay/StateGraph/
// LoadingScreen (absolute inset-0) and the data-cleo-overlay HUD keep anchoring to the viewport,
// not the dock. Its group is locked and headerless (see DockLayout) — the immovable center anchor.
function ViewportPanel(_: IDockviewPanelProps) {
  const { isSceneReady, loadingProgress, editorMode } = useCleoEngine();
  return (
    <div className="relative h-full w-full overflow-hidden">
      <EngineViewport />
      {/* UI overlay sits on top of the WebGL canvas */}
      <UIOverlay />
      {/* Animation-mode node graph overlays the viewport when Graph view is active */}
      <StateGraph />
      {/* Animation-field mode: the blend-space plot overlays the viewport, with the 3D preview showing
          through it so the pose can be judged while the field is authored */}
      <FieldGraph />
      {/* Script mode: the dedicated code editor fills the main area (no 3D preview) */}
      {editorMode === 'script' && <ScriptTabView />}
      {/* Loading splash covers only the viewport; the rest of the editor stays visible */}
      {!isSceneReady && <LoadingScreen progress={loadingProgress} />}
    </div>
  );
}

// Side panels keep the old Sidebar's container behavior (vertical scroll, no horizontal overflow).
function SidePanel({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col h-full w-full overflow-x-hidden overflow-y-auto select-none">{children}</div>;
}

// The Scene panel doubles as the Animation editor's skeleton tree (DockLayout retitles the tab).
function ScenePanel(_: IDockviewPanelProps) {
  const { editorMode } = useCleoEngine();
  return <SidePanel>{editorMode === 'animation' ? <SkeletonTree /> : <SceneInspector />}</SidePanel>;
}

function UIPanel(_: IDockviewPanelProps) {
  return <SidePanel><UIInspector /></SidePanel>;
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

// The Properties panel hosts the mode-specific inspectors too (material and terrain-material authoring),
// which is why DockLayout retitles its tab per mode. Animation is the exception: it has its own three
// panels (below) and hides Properties entirely.
function PropertiesPanel(_: IDockviewPanelProps) {
  const { editorMode, editingTerrainMaterialNode } = useCleoEngine();
  const { node, readOnly } = useSelectedNode();

  // Terrain-material mode edits the dedicated (unrendered) edit node — the visible preview node
  // carries the composite terrain material.
  if (editorMode === 'terrainMaterial') return <SidePanel><TerrainMaterialInspector node={editingTerrainMaterialNode} /></SidePanel>;
  if (editorMode === 'material') return <SidePanel><MaterialPanel /></SidePanel>;
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

// The animation editor's three panels. They share one StateMachineProvider session (it wraps the whole
// dock, see Editor.tsx), so each is free to be dragged anywhere without losing the working copy. Shown
// only in animation mode — see hiddenPanelIds. Each already fills and scrolls itself, so no SidePanel.
function AnimClipsPanel(_: IDockviewPanelProps) { return <AnimClips />; }
// The Animation Field editor's single panel. Like the animation panels it lives inside the shared provider
// that wraps the whole dock (see Editor.tsx), so it can be dragged anywhere without losing the session.
function AnimFieldPanel(_: IDockviewPanelProps) { return <AnimationFieldPanel />; }
function AnimVariablesPanel(_: IDockviewPanelProps) { return <AnimVariables />; }
function AnimStateMachinePanel(_: IDockviewPanelProps) { return <AnimStateMachine />; }

// Panels are movable but not closable — a lost panel would need Reset Layout, so the tab renders
// the title only (dockview's tab wrapper still owns drag behavior and colors).
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
  ui: UIPanel,
  properties: PropertiesPanel,
  scripts: ScriptsPanel,
  physics: PhysicsPanel,
  logger: LoggerPanel,
  assets: AssetsPanel,
  animClips: AnimClipsPanel,
  animVariables: AnimVariablesPanel,
  animStateMachine: AnimStateMachinePanel,
  animField: AnimFieldPanel,
};
