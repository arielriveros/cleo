import { useEffect, useState } from "react";
import { useCleoEngine } from "./EngineContext";
import EngineViewport from "./EngineViewport";
import Center from "../components/Center";
import Content from "../components/Content";
import NodeInspector from "./nodeInspector/NodeInspector";
import Sidebar, { SidebarResizer } from "../components/Sidebar";
import MenuBar from "./MenuBar";
import Explorer from "./sceneInspector/Explorer";
import './Editor.css'

export default function Editor() {
  const { instance, eventEmmiter } = useCleoEngine();
  const [sidebarDimensions, setSidebarDimensions] = useState({left: 20, right: 25});
  const [sidebarMinDimensions, setSidebarMinDimensions] = useState({left: 12, right: 21});
  

  useEffect(() => {
    const handlePlayState = (state: 'play' | 'pause' | 'stop') => {
      if (state === 'stop') {
        setSidebarDimensions({left: 20, right: 25});
        setSidebarMinDimensions({left: 12, right: 21});
      }
  
      if (state === 'play' || state === 'pause') {
        setSidebarDimensions({left: 0, right: 0});
        setSidebarMinDimensions({left: 0, right: 0});
      }
    }
    eventEmmiter.on('SET_PLAY_STATE', handlePlayState);
    return () => { eventEmmiter.off('SET_PLAY_STATE', handlePlayState) };    
  }, [eventEmmiter]);

  useEffect(() => {
    if (!instance) return;

    if (sidebarDimensions.left < sidebarMinDimensions.left)
      setSidebarDimensions({left: sidebarMinDimensions.left, right: sidebarDimensions.right});

    if (sidebarDimensions.right < sidebarMinDimensions.right)
      setSidebarDimensions({left: sidebarDimensions.left, right: sidebarMinDimensions.right});

    instance.renderer.resize();

  }, [sidebarDimensions]);

  return (
    <>
      <MenuBar />
      <Content>
        <Sidebar width={`${sidebarDimensions.left}vw`} minWidth={`${sidebarMinDimensions.left}vw`}>
          <Explorer />
        </Sidebar>
        <SidebarResizer 
          onDrag={ e => {
            setSidebarDimensions({left: 100 * e.clientX / window.innerWidth, right: sidebarDimensions.right});
          }}
        />
        <Center width={`${100 - sidebarDimensions.left - sidebarDimensions.right}vw`}>
          <EngineViewport />
        </Center>
        <SidebarResizer
          onDrag={ e => {
            setSidebarDimensions({left: sidebarDimensions.left, right: 100 - (100 * e.clientX) / window.innerWidth});
          }}
        />
        <Sidebar width={`${sidebarDimensions.right}vw`} minWidth={`${sidebarMinDimensions.right}vw`}>
          <NodeInspector />
        </Sidebar>
      </Content>
    </>
  );
}