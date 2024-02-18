import { useCleoEngine } from "./EngineContext";
import { Scene } from "cleo";
import EngineViewport from "./EngineViewport";
import Center from "../components/Center";
import Content from "../components/Content";
import Topbar from "../components/Topbar";
import SceneInspector from "./sceneInspector/SceneInspector";
import NodeInspector from "./nodeInspector/NodeInspector";
import ScriptEditor from "./scriptEditor/ScriptEditor";
import './Editor.css'

export default function Editor() {

  const { instance, editorScene, mode, setMode, setSelectedScript, scripts } = useCleoEngine();

  const clearDebuggingNodes = (json: any) => {
    const iterateChildren = (children: any[]) => {
        return children.filter((child: any) => {
            if (child.name.includes('__debug__')) {
                console.log('removing debugging node', child.name);
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
    if (!instance)
      return;

    setMode('scene');
    setSelectedScript(null);
    const newScene = new Scene();
    editorScene?.serialize(false).then(json => {
      // Clear debugging nodes from the editor scene
      clearDebuggingNodes(json.scene)
      // Assign the scripts to the new scene
      setScripts(json);
      // Parse the scene from the editor
      newScene.parse(json, false);
      console.log('newScene', newScene);
      // Set the new scene to the engine then start it
      instance.setScene(newScene);
      instance.isPaused = false;
      instance.scene.start();
    });
  }

  const onStop = () => {
    if (instance)
      instance.setScene(editorScene as Scene);
  }

  const onPause = () => {
    if (instance)
      instance.isPaused = !instance.isPaused || false;
  }

  return (
    <>
      <Topbar>
        <div>
          <div className='optionButton' onClick={() => onSave()}>Save</div>
          <label htmlFor='load-scene-file' className='optionButton'>Load</label>
          <input type='file' id='load-scene-file' name='file' onChange={(e) => onLoad(e.target.files)} />
        </div>
        <div>
          <div className='optionButton' onClick={() => onPlay()}>Play</div>
          <div className='optionButton' onClick={() => onPause()}>Pause</div>
          <div className='optionButton' onClick={() => onStop()}>Stop</div>
        </div>
        <div>
          <select value={mode} onChange={
            e => {
              setMode(e.target.value as 'scene' | 'script');
              setSelectedScript(null);
            }}>
            <option value='scene'>Scene</option>
            <option value='script'>Scripts</option>
          </select>
        </div>
        <div />
      </Topbar>
      <Content>
        <SceneInspector />
        <Center>
        { mode === 'scene' && <EngineViewport /> }
        { mode === 'script' && <ScriptEditor /> }
        </Center>
        <NodeInspector />
      </Content>
    </>
  );
}