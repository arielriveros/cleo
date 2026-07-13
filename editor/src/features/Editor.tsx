import { useEffect, useState } from "react";
import { useCleoEngine } from "./EngineContext";
import EngineViewport from "./EngineViewport";
import Center from "../components/Center";
import Content from "../components/Content";
import NodeInspector from "./nodeInspector/NodeInspector";
import Sidebar, { SidebarResizer } from "../components/Sidebar";
import MenuBar from "./MenuBar";
import TabBar from "./TabBar";
import Explorer from "./sceneInspector/Explorer";
import BottomBar, { BottomBarResizer } from "../components/BottomBar";
import Logger from "./logger/Logger";
import Tabs, { Tab } from "../components/Tabs";
import AssetExplorer from "./assets/AssetExplorer";
import TemplateExplorer from "./sceneInspector/TemplateExplorer";
import MaterialExplorer from "./materials/MaterialExplorer";
import TerrainMaterialExplorer from "./terrainMaterials/TerrainMaterialExplorer";
import MeshExplorer from "./meshes/MeshExplorer";
import MeshImportModal from "./meshes/MeshImportModal";
import AnimationImportModal from "./animation/AnimationImportModal";
import { StateMachineProvider } from "./animation/StateMachineContext";
import StateGraph from "./animation/StateGraph";
import UIOverlay from "./uiInspector/UIOverlay";
import LoadingScreen from "../components/LoadingScreen";
import { LAYOUT_KEY } from "../utils/projectStorage";

const DEFAULT_BARS = { left: 20, right: 25, minLeft: 12, minRight: 21, height: 30, minHeight: 15 };

// Restore persisted panel layout (falls back to defaults).
function readLayout(): { barsDimensions: typeof DEFAULT_BARS; bottomTab: 'Logger' | 'Textures' | 'Templates' | 'Materials' | 'TerrainMaterials' | 'Meshes' } {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const l = JSON.parse(raw);
      // Migrate the old 'Assets' tab name to 'Textures'.
      const bottomTab = l.bottomTab === 'Assets' ? 'Textures' : (l.bottomTab ?? 'Logger');
      return { barsDimensions: { ...DEFAULT_BARS, ...(l.barsDimensions ?? {}) }, bottomTab };
    }
  } catch { /* ignore */ }
  return { barsDimensions: DEFAULT_BARS, bottomTab: 'Logger' };
}

export default function Editor() {
  const { instance, eventEmitter, isSceneReady, loadingProgress, editorMode, isPlayMode } = useCleoEngine();
  const [barsDimensions, setBarsDimensions] = useState(() => readLayout().barsDimensions);
  const [bottomTab, setBottomTab] = useState<'Logger' | 'Textures' | 'Templates' | 'Materials' | 'TerrainMaterials' | 'Meshes'>(() => readLayout().bottomTab);

  // Landscape mode hides both side inspectors; renderer mode additionally hides the bottom bar,
  // leaving only the viewport + the floating Renderer Options window. Material mode hides only the
  // left (scene/UI) sidebar — the right sidebar keeps the material inspector.
  const hideSides = editorMode === 'landscape' || editorMode === 'renderer';
  const hideLeft = hideSides || editorMode === 'material' || editorMode === 'terrainMaterial';
  const hideBottom = editorMode === 'renderer';
  const effLeft = hideLeft ? 0 : barsDimensions.left;
  const effRight = hideSides ? 0 : barsDimensions.right;

  useEffect(() => {
    const handlePlayState = (state: 'play' | 'pause' | 'stop') => {
      if (state === 'stop') {
        setBarsDimensions({left: 20, right: 25, minLeft: 12, minRight: 21, height: 30, minHeight: 15});
      }
  
      if (state === 'play' || state === 'pause') {
        setBarsDimensions({left: 0, right: 0, minLeft: 0, minRight: 0, height: 0, minHeight: 0});
      }
    }
    eventEmitter.on('SET_PLAY_STATE', handlePlayState);
    return () => { eventEmitter.off('SET_PLAY_STATE', handlePlayState) };    
  }, [eventEmitter]);

  useEffect(() => {
    if (bottomTab === 'Textures') {
      eventEmitter.emit('TEXTURES_CHANGED');
    }
  }, [bottomTab]);

  // The Template mode segment focuses the Templates bottom panel.
  useEffect(() => {
    const onFocus = (tab: 'Logger' | 'Textures' | 'Templates' | 'Materials' | 'TerrainMaterials' | 'Meshes') => setBottomTab(tab);
    eventEmitter.on('FOCUS_BOTTOM_TAB', onFocus);
    return () => { eventEmitter.off('FOCUS_BOTTOM_TAB', onFocus); };
  }, [eventEmitter]);

  // Persist panel layout (but not the collapsed play-mode dimensions).
  useEffect(() => {
    if (isPlayMode) return;
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ barsDimensions, bottomTab })); } catch { /* ignore */ }
  }, [barsDimensions, bottomTab, isPlayMode]);

  // Resize the renderer when sidebars appear/disappear on mode change.
  useEffect(() => {
    if (instance) instance.renderer.resize();
  }, [editorMode, instance]);

  useEffect(() => {
    if (!instance) return;

    if (barsDimensions.left < barsDimensions.minLeft)
      setBarsDimensions({...barsDimensions, left: barsDimensions.minLeft, right: barsDimensions.right});

    if (barsDimensions.right < barsDimensions.minRight)
      setBarsDimensions({...barsDimensions, left: barsDimensions.left, right: barsDimensions.minRight});

    instance.renderer.resize();

  }, [barsDimensions]);

  return (
    <>
      <MenuBar />
      <StateMachineProvider>
      <Content>
        <Sidebar width={`${effLeft}vw`} minWidth={`${hideLeft ? 0 : barsDimensions.minLeft}vw`}>
          <Explorer />
        </Sidebar>
        {!hideLeft && <SidebarResizer
          onDrag={ e => {
            setBarsDimensions({...barsDimensions, left: 100 * e.clientX / window.innerWidth, right: barsDimensions.right});
          }}
        />}
        <Center width={`${100 - effLeft - effRight}vw`}>
          <div className="flex flex-col h-full">
            <TabBar />
            <div className="flex-1 min-h-0 relative">
              <EngineViewport />
              {/* UI overlay sits on top of the WebGL canvas */}
              <UIOverlay />
              {/* Animation-mode node graph overlays the viewport when Graph view is active */}
              <StateGraph />
              {/* Loading splash covers only the viewport; the rest of the editor stays visible */}
              {!isSceneReady && <LoadingScreen progress={loadingProgress} />}
            </div>
            {!hideBottom && <>
            <BottomBarResizer onDrag={ e => {
              setBarsDimensions({...barsDimensions, height: 100 - (100 * e.clientY) / window.innerHeight});
            }} />
            <BottomBar height={`${barsDimensions.height}vh`} minHeight={`${barsDimensions.minHeight}vh`}>
              <Tabs>
                <Tab title='Logger' onClick={() => setBottomTab('Logger')} selected={bottomTab === 'Logger'} />
                <Tab title='Textures' onClick={() => setBottomTab('Textures')} selected={bottomTab === 'Textures'} />
                <Tab title='Templates' onClick={() => setBottomTab('Templates')} selected={bottomTab === 'Templates'} />
                <Tab title='Materials' onClick={() => setBottomTab('Materials')} selected={bottomTab === 'Materials'} />
                <Tab title='Terrain Mat.' onClick={() => setBottomTab('TerrainMaterials')} selected={bottomTab === 'TerrainMaterials'} />
                <Tab title='Meshes' onClick={() => setBottomTab('Meshes')} selected={bottomTab === 'Meshes'} />
              </Tabs>
              <div className="flex flex-col text-white bg-surface-raised w-full h-full overflow-hidden">
                <div className={`${bottomTab === 'Logger' ? 'block' : 'hidden'} w-full h-full overflow-y-auto`}>
                  <Logger />
                </div>
                <div className={`${bottomTab === 'Textures' ? 'block' : 'hidden'} w-full h-full overflow-y-auto`}>
                  <AssetExplorer />
                </div>
                <div className={`${bottomTab === 'Templates' ? 'block' : 'hidden'} w-full h-full overflow-y-auto`}>
                  <TemplateExplorer />
                </div>
                <div className={`${bottomTab === 'Materials' ? 'block' : 'hidden'} w-full h-full overflow-y-auto`}>
                  <MaterialExplorer />
                </div>
                <div className={`${bottomTab === 'TerrainMaterials' ? 'block' : 'hidden'} w-full h-full overflow-y-auto`}>
                  <TerrainMaterialExplorer />
                </div>
                <div className={`${bottomTab === 'Meshes' ? 'block' : 'hidden'} w-full h-full overflow-y-auto`}>
                  <MeshExplorer />
                </div>
              </div>
            </BottomBar>
            </>}
          </div>
        </Center>
        {!hideSides && <SidebarResizer
          onDrag={ e => {
            setBarsDimensions({...barsDimensions, left: barsDimensions.left, right: 100 - (100 * e.clientX) / window.innerWidth});
          }}
        />}
        <Sidebar width={`${effRight}vw`} minWidth={`${hideSides ? 0 : barsDimensions.minRight}vw`}>
          <NodeInspector />
        </Sidebar>
      </Content>
      </StateMachineProvider>
      {/* Global mesh-import review modal — overlays the whole editor while an import awaits the user. */}
      <MeshImportModal />
      {/* Global animation-import review modal (compatibility vs the skeleton). */}
      <AnimationImportModal />
    </>
  );
}