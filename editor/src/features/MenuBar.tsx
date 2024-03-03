import { useEffect, useState } from "react";
import { Scene, Logger } from "cleo";
import { useCleoEngine } from "./EngineContext";
import Topbar from "../components/Topbar";
import PlayIcon from '../icons/play.png'
import PauseIcon from '../icons/pause.png'
import StopIcon from '../icons/stop.png'

export default function MenuBar() {
  const { instance, editorScene, scripts, bodies, triggers, eventEmmiter } = useCleoEngine();
  const [started, setStarted] = useState(false);
  const [playState, setPlayState] = useState<'playing' | 'paused' | 'stopped'>('stopped');

  useEffect(() => {
    const handlePlayState = (state: 'play' | 'pause' | 'stop') => {
      if (state === 'play') setPlayState('playing');
      if (state === 'pause') setPlayState('paused');
      if (state === 'stop') setPlayState('stopped');
    }
    eventEmmiter.on('SET_PLAY_STATE', handlePlayState);
    return () => { eventEmmiter.off('SET_PLAY_STATE', handlePlayState) };
  }, [eventEmmiter]);
  
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
        const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'scene.json';
        a.click();
      }
    });
  };

  const onPlay = () => {
    if (!instance) return;

    if (started) {
      eventEmmiter.emit('SET_PLAY_STATE', 'play');
      return;
    }

    const newScene = new Scene();
    editorScene?.serialize(true).then(json => {
      // Clear debugging nodes from the editor scene
      clearDebuggingNodes(json.scene)
      // Assign the scripts to the new scene
      setScripts(json);
      // Assign the bodies to the new scene
      setBodies(json);
      // Parse the scene from the editor
      newScene.parse(json, true);
      // Set the new scene to the engine then start it
      instance.setScene(newScene);
      instance.isPaused = false;

      // add a little delay to make sure the scene is set before starting it
      setTimeout(() => { instance.scene.start(); } , 100);

      eventEmmiter.emit('SET_PLAY_STATE', 'play');
      setStarted(true);
    });
  }

  const onStop = () => {
    setStarted(false);
    if (!instance) return;
    instance.setScene(editorScene as Scene);
    eventEmmiter.emit('SET_PLAY_STATE', 'stop');
  }

  const onPause = () => {
    eventEmmiter.emit('SET_PLAY_STATE', 'pause');
  }

  return (
    <Topbar>
      <div className='file-controls'>
        <div className='option-button' onClick={() => onSave()}>Save</div>
        <label htmlFor='load-scene-file' className='option-button'>Load</label>
        <input type='file' id='load-scene-file' name='file' onChange={(e) => onLoad(e.target.files)} />
      </div>
      <div className='media-controls'>
        <button className='media-button' disabled={playState==='playing'} onClick={() => onPlay()}>
          <img src={PlayIcon} alt='Play' className='media-icon' />
        </button>
        <button className='media-button' disabled={playState==='paused' || playState==='stopped'} onClick={() => onPause()}>
          <img src={PauseIcon} alt='Pause' className='media-icon' />
        </button>
        <button className='media-button' disabled={playState==='stopped'} onClick={() => onStop()}>
          <img src={StopIcon} alt='Stop' className='media-icon' />
        </button>
      </div>
      <div className='dimension-controls'>
        <p>Mode</p>
        <select disabled={ playState==='playing' || playState==='paused' } onChange={(e) => eventEmmiter.emit('CHANGE_DIMENSION', (e.target.value as '2D' | '3D'))}>
          <option value='3D'>3D</option>
          <option value='2D'>2D</option>
        </select>
      </div>
      <div />
    </Topbar>
  )
}
