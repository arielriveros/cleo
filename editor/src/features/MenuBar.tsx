import Topbar from "../components/Topbar";
import PlayIcon from '../icons/play.png'
import PauseIcon from '../icons/pause.png'
import StopIcon from '../icons/stop.png'
import { useCleoEngine } from "./EngineContext";
import { Scene } from "cleo";

export default function MenuBar() {
  const { instance, editorScene, scripts, playState, setPlayState } = useCleoEngine();
  const clearDebuggingNodes = (json: any) => {
    const iterateChildren = (children: any[]) => {
        return children.filter((child: any) => {
            if (child.name.includes('__debug__')) {
                console.log('removing debugging node', child.name);
                return false;
            }
            if (child.name.includes('__editor__')) {
                console.log('removing editor node', child.name);
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
    if(rootScript) {
      scene.scripts = rootScript;
    }

    const iterateChildren = (children: any[]) => {
      children.forEach((child: any) => {
        const nodeScripts = scripts.get(child.id);
        if(nodeScripts) {
          child.scripts = nodeScripts;
        }

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
    editorScene?.serialize().then((json) => {
      if (json) {
        // Clear debugging nodes from the editor scene
        clearDebuggingNodes(json.scene)
        // Assign the scripts to the new scene
        setScripts(json);
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

    const newScene = new Scene();
    editorScene?.serialize(false).then(json => {
      // Clear debugging nodes from the editor scene
      clearDebuggingNodes(json.scene)
      // Assign the scripts to the new scene
      setScripts(json);
      // Parse the scene from the editor
      newScene.parse(json, false);
      console.log('Starting scene: ', newScene);
      // Set the new scene to the engine then start it
      instance.setScene(newScene);
      instance.isPaused = false;
      instance.scene.start();

      setPlayState('playing');
    });
  }

  const onStop = () => {
    if (!instance) return;

    
    instance.setScene(editorScene as Scene);

    setPlayState('stopped');
  }

  const onPause = () => {
    if (!instance) return
    
    instance.isPaused = !instance.isPaused || false;
    if (instance.isPaused) {
      setPlayState('paused');
    }
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
        <div />
      </Topbar>
  )
}
