import { IDockviewPanelProps, IDockviewPanelHeaderProps } from 'dockview-react';
import EngineViewport from '../EngineViewport';
import UIOverlay from '../uiInspector/UIOverlay';
import StateGraph from '../animation/StateGraph';
import LoadingScreen from '../../components/LoadingScreen';
import Explorer from '../sceneInspector/Explorer';
import NodeInspector from '../nodeInspector/NodeInspector';
import Logger from '../logger/Logger';
import AssetsExplorer from '../assets/AssetsExplorer';
import { useCleoEngine } from '../EngineContext';

// The viewport panel reproduces the old Center stack: a `relative` wrapper so UIOverlay/StateGraph/
// LoadingScreen (absolute inset-0) and the data-cleo-overlay HUD keep anchoring to the viewport,
// not the dock. Its group is locked and headerless (see DockLayout) — the immovable center anchor.
function ViewportPanel(_: IDockviewPanelProps) {
  const { isSceneReady, loadingProgress } = useCleoEngine();
  return (
    <div className="relative h-full w-full overflow-hidden">
      <EngineViewport />
      {/* UI overlay sits on top of the WebGL canvas */}
      <UIOverlay />
      {/* Animation-mode node graph overlays the viewport when Graph view is active */}
      <StateGraph />
      {/* Loading splash covers only the viewport; the rest of the editor stays visible */}
      {!isSceneReady && <LoadingScreen progress={loadingProgress} />}
    </div>
  );
}

// Side panels keep the old Sidebar's container behavior (vertical scroll, no horizontal overflow).
function SidePanel({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col h-full w-full overflow-x-hidden overflow-y-auto select-none">{children}</div>;
}

function ExplorerPanel(_: IDockviewPanelProps) {
  return <SidePanel><Explorer /></SidePanel>;
}

function InspectorPanel(_: IDockviewPanelProps) {
  return <SidePanel><NodeInspector /></SidePanel>;
}

function LoggerPanel(_: IDockviewPanelProps) {
  return (
    <div className="flex flex-col h-full w-full text-white bg-surface-raised overflow-y-auto">
      <Logger />
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

// v1: panels are movable but not closable — a lost panel would need Reset Layout, so the tab renders
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
  explorer: ExplorerPanel,
  inspector: InspectorPanel,
  logger: LoggerPanel,
  assets: AssetsPanel,
};
