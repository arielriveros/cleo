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
import './Editor.css'

export default function Editor() {
  const { instance, eventEmitter } = useCleoEngine();
  const [barsDimensions, setBarsDimensions] = useState({
    left: 20, right: 25, minLeft: 12, minRight: 21, height: 30, minHeight: 15
  });

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
          <div style={{height: `${100 - barsDimensions.height}vh`}}>
            <EngineViewport />
          </div>
          <BottomBarResizer onDrag={ e => {
            setBarsDimensions({...barsDimensions, height: 100 - (100 * e.clientY) / window.innerHeight});
          }} />
          <BottomBar height={`${barsDimensions.height}vh`} minHeight={`${barsDimensions.minHeight}vh`}>
            <Logger />
          </BottomBar>
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