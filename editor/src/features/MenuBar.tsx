import { useEffect, useState } from "react";
import { Logger } from "cleo";
import { useCleoEngine } from "./EngineContext";
import Topbar from "../components/Topbar";
import PlayIcon from '../icons/play.png'
import PauseIcon from '../icons/pause.png'
import StopIcon from '../icons/stop.png'

export default function MenuBar() {
  const { instance, editorScene, scripts, bodies, triggers, ui, setUI, startPlay, stopPlay, pausePlay, editorMode, setEditorMode, eventEmitter: eventEmitter } = useCleoEngine();
  const [playState, setPlayState] = useState<'playing' | 'paused' | 'stopped'>('stopped');

  useEffect(() => {
    const handlePlayState = (state: 'play' | 'pause' | 'stop') => {
      if (state === 'play') setPlayState('playing');
      if (state === 'pause') setPlayState('paused');
      if (state === 'stop') setPlayState('stopped');
    }
    eventEmitter.on('SET_PLAY_STATE', handlePlayState);
    return () => { eventEmitter.off('SET_PLAY_STATE', handlePlayState) };
  }, [eventEmitter]);
  
  const clearDebuggingNodes = (json: any) => {
    const iterateChildren = (children: any[]) => {
      return children.filter((child: any) => {
        if (child.name.includes('__debug__')) {
          Logger.info(`Removing debugging node ${child.name}`, 'Editor');
          return false;
        }
        if (child.name.includes('__editor__')) {
          Logger.info(`Removing editor node ${child.name}`, 'Editor');
          return false;
        }
        child.children = iterateChildren(child.children);
        return true;
      });
    }

    json.children = iterateChildren(json.children);
  }

  const setScripts = (json: any) => {
    const scene = json.scene;
    const rootScript = scripts.get(scene.id);

    if(rootScript) scene.script = rootScript;

    const iterateChildren = (children: any[]) => {
      children.forEach((child: any) => {
        const nodeScript = scripts.get(child.id);
        if(nodeScript) child.script = nodeScript;
        iterateChildren(child.children);
      });
    }
    iterateChildren(scene.children);
  }

  const setBodies = (json: any) => {
    const scene = json.scene;

    const iterateChildren = (children: any[]) => {
      children.forEach((child: any) => {
        const body = bodies.get(child.id);
        if(body) child.body = body;

        const trigger = triggers.get(child.id);
        if(trigger) child.trigger = trigger;
        iterateChildren(child.children);
      });
    }
    iterateChildren(scene.children);

  }

  const onLoad = (filelist: FileList | null) => {
    if (filelist) {
      const reader = new FileReader();
      reader.readAsText(filelist[0]);
      reader.onload = (e) => {
        const data = e.target?.result;
        if (data) {
          const json = JSON.parse(data as string);
          // Load UI if present
          if (json.ui) {
            setUI({ version: json.ui.version ?? 1, elements: json.ui.elements ?? [] });
          } else if (json.scene?.ui) {
            setUI({ version: json.scene.ui.version ?? 1, elements: json.scene.ui.elements ?? [] });
          }
          editorScene?.parse(json);
        }
      };
    }
  };

  const onSave = () => {
    /* TODO: Remove __editor__ and __debug__ textures */
    editorScene?.serialize().then((json) => {
      if (json) {
        // Clear debugging nodes from the editor scene
        clearDebuggingNodes(json.scene)
        // Assign the scripts to the new scene
        setScripts(json);
        // Assign the bodies to the new scene
        setBodies(json);
        // Attach UI overlay data
        json.ui = { version: ui.version, elements: ui.elements };
        const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'scene.json';
        a.click();
      }
    });
  };

  const onPlay = () => startPlay();

  const onStop = () => stopPlay();

  const onPause = () => pausePlay();

  return (
    <Topbar>
      <div className='flex items-center h-full'>
        <div className='text-white h-[25px] border border-[#ccc] bg-[#3b3b3b] text-center w-[98px] inline-block cursor-pointer my-[2px] mx-[5px] px-2 rounded' onClick={() => onSave()}>Save</div>
        <label htmlFor='load-scene-file' className='text-white h-[25px] border border-[#ccc] bg-[#3b3b3b] text-center w-[98px] inline-block cursor-pointer my-[2px] mx-[5px] px-2 rounded'>Load</label>
        <input className="hidden" type='file' id='load-scene-file' name='file' onChange={(e) => onLoad(e.target.files)} />
      </div>
      <div className='flex items-center h-full'>
        <button className='text-white bg-[#2c2cff] cursor-pointer w-[30px] h-[30px] mx-[2px] p-0 rounded-full disabled:bg-[#3b3b3b] disabled:cursor-not-allowed hover:bg-[#3f3fb4] disabled:hover:bg-[#3b3b3b]' disabled={playState==='playing'} onClick={() => onPlay()}>
          <img src={PlayIcon} alt='Play' className='inline-block h-full w-full align-middle' />
        </button>
        <button className='text-white bg-[#2c2cff] cursor-pointer w-[30px] h-[30px] mx-[2px] p-0 rounded-full disabled:bg-[#3b3b3b] disabled:cursor-not-allowed hover:bg-[#3f3fb4] disabled:hover:bg-[#3b3b3b]' disabled={playState==='paused' || playState==='stopped'} onClick={() => onPause()}>
          <img src={PauseIcon} alt='Pause' className='inline-block h-full w-full align-middle' />
        </button>
        <button className='text-white bg-[#2c2cff] cursor-pointer w-[30px] h-[30px] mx-[2px] p-0 rounded-full disabled:bg-[#3b3b3b] disabled:cursor-not-allowed hover:bg-[#3f3fb4] disabled:hover:bg-[#3b3b3b]' disabled={playState==='stopped'} onClick={() => onStop()}>
          <img src={StopIcon} alt='Stop' className='inline-block h-full w-full align-middle' />
        </button>
      </div>
      <div className='flex items-center justify-between h-full w-[100px] text-white'>
        <p className='m-0'>Mode</p>
        <select className='bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1 disabled:opacity-50' disabled={ playState==='playing' || playState==='paused' } onChange={(e) => eventEmitter.emit('CHANGE_DIMENSION', (e.target.value as '2D' | '3D'))}>
          <option value='3D'>3D</option>
          <option value='2D'>2D</option>
        </select>
      </div>
      <div className='flex items-center h-full'>
        <div
          className={`text-white h-[25px] border text-center inline-block cursor-pointer my-[2px] mx-[5px] px-2 rounded ${editorMode === 'landscape' ? 'bg-[#2c7a2c] border-[#8fe08f]' : 'bg-[#3b3b3b] border-[#ccc]'} ${(playState==='playing' || playState==='paused') ? 'opacity-50 pointer-events-none' : ''}`}
          title='Toggle landscape sculpting mode'
          onClick={() => setEditorMode(editorMode === 'landscape' ? 'default' : 'landscape')}
        >
          Landscape
        </div>
      </div>
      <div />
    </Topbar>
  )
}
