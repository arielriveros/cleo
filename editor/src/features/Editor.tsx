import { useEffect, useState } from "react";
import { useCleoEngine } from "./EngineContext";
import EngineViewport from "./EngineViewport";
import Center from "../components/Center";
import Content from "../components/Content";
import NodeInspector from "./nodeInspector/NodeInspector";
import Sidebar, { SidebarResizer } from "../components/Sidebar";
import MenuBar from "./MenuBar";
import Explorer from "./sceneInspector/Explorer";
import BottomBar, { BottomBarResizer } from "../components/BottomBar";
import Logger from "./logger/Logger";
import Tabs, { Tab } from "../components/Tabs";
import AssetExplorer from "./assets/AssetExplorer";
import TemplateExplorer from "./sceneInspector/TemplateExplorer";
import UIOverlay from "./uiInspector/UIOverlay";
import LoadingScreen from "../components/LoadingScreen";

export default function Editor() {
  const { instance, eventEmitter, isSceneReady, loadingProgress } = useCleoEngine();
  const [barsDimensions, setBarsDimensions] = useState({
    left: 20, right: 25, minLeft: 12, minRight: 21, height: 30, minHeight: 15
  });
  const [bottomTab, setBottomTab] = useState<'Logger' | 'Assets' | 'Templates'>('Logger');

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
    if (bottomTab === 'Assets') {
      eventEmitter.emit('TEXTURES_CHANGED');
    }
  }, [bottomTab]);

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
      <Content>
        <Sidebar width={`${barsDimensions.left}vw`} minWidth={`${barsDimensions.minLeft}vw`}>
          <Explorer />
        </Sidebar>
        <SidebarResizer 
          onDrag={ e => {
            setBarsDimensions({...barsDimensions, left: 100 * e.clientX / window.innerWidth, right: barsDimensions.right});
          }}
        />
        <Center width={`${100 - barsDimensions.left - barsDimensions.right}vw`}>
          <div className="flex flex-col h-full">
            <div className="flex-1 min-h-0 relative">
              <EngineViewport />
              {/* UI overlay sits on top of the WebGL canvas */}
              <UIOverlay />
              {/* Loading splash covers only the viewport; the rest of the editor stays visible */}
              {!isSceneReady && <LoadingScreen progress={loadingProgress} />}
            </div>
            <BottomBarResizer onDrag={ e => {
              setBarsDimensions({...barsDimensions, height: 100 - (100 * e.clientY) / window.innerHeight});
            }} />
            <BottomBar height={`${barsDimensions.height}vh`} minHeight={`${barsDimensions.minHeight}vh`}>
              <Tabs>
                <Tab title='Logger' onClick={() => setBottomTab('Logger')} selected={bottomTab === 'Logger'} />
                <Tab title='Assets' onClick={() => setBottomTab('Assets')} selected={bottomTab === 'Assets'} />
                <Tab title='Templates' onClick={() => setBottomTab('Templates')} selected={bottomTab === 'Templates'} />
              </Tabs>
              <div className="flex flex-col text-white bg-[#202020] w-full h-full overflow-hidden">
                <div className={`${bottomTab === 'Logger' ? 'block' : 'hidden'} w-full h-full overflow-y-auto`}>
                  <Logger />
                </div>
                <div className={`${bottomTab === 'Assets' ? 'block' : 'hidden'} w-full h-full overflow-y-auto`}>
                  <AssetExplorer />
                </div>
                <div className={`${bottomTab === 'Templates' ? 'block' : 'hidden'} w-full h-full overflow-y-auto`}>
                  <TemplateExplorer />
                </div>
              </div>
            </BottomBar>
          </div>
        </Center>
        <SidebarResizer
          onDrag={ e => {
            setBarsDimensions({...barsDimensions, left: barsDimensions.left, right: 100 - (100 * e.clientX) / window.innerWidth});
          }}
        />
        <Sidebar width={`${barsDimensions.right}vw`} minWidth={`${barsDimensions.minRight}vw`}>
          <NodeInspector />
        </Sidebar>
      </Content>
    </>
  );
}