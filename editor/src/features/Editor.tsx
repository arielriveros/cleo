import { useEffect, useState } from "react";
import { useCleoEngine } from "./EngineContext";
import { Scene } from "cleo";
import EngineViewport from "./EngineViewport";
import Center from "../components/Center";
import Content from "../components/Content";
import SceneInspector from "./sceneInspector/SceneInspector";
import NodeInspector from "./nodeInspector/NodeInspector";
import Sidebar, { SidebarResizer } from "../components/Sidebar";
import './Editor.css'
import MenuBar from "./MenuBar";
import Explorer from "./sceneInspector/Explorer";

export default function Editor() {
  const { instance, playState } = useCleoEngine();
  const [sidebarDimensions, setSidebarDimensions] = useState({left: 20, right: 25});
  const [sidebarMinDimensions, setSidebarMinDimensions] = useState({left: 12, right: 21});
  

  useEffect(() => {

    if (playState === 'stopped') {
      setSidebarDimensions({left: 20, right: 25});
      setSidebarMinDimensions({left: 12, right: 21});
    }

    if (playState === 'playing' || playState === 'paused') {
      setSidebarDimensions({left: 0, right: 0});
      setSidebarMinDimensions({left: 0, right: 0});
    }
    
  }, [playState]);

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