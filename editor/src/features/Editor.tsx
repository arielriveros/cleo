import { useCleoEngine } from "./EngineContext";
import EngineViewport from "./EngineViewport";
import Center from "../components/Center";
import Content from "../components/Content";
import Topbar from "../components/Topbar";
import SceneInspector from "./sceneInspector/SceneInspector";
import NodeInspector from "./nodeInspector/NodeInspector";
import './Editor.css'

export default function Editor() {

  const { scene } = useCleoEngine();

  const onLoad = (filelist: FileList | null) => {
    if (filelist) {
      const reader = new FileReader();
      reader.readAsText(filelist[0]);
      reader.onload = (e) => {
        const data = e.target?.result;
        if (data) {
          const json = JSON.parse(data as string);
          scene?.parse(json);
        }
      };
    }
  };

  const onSave = () => {
    scene?.serialize().then((json) => {
      if (json) {
        const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'scene.json';
        a.click();
      }
    });
  };

  return (
    <>
      <Topbar>
        <div>
          <div className='optionButton' onClick={() => onSave()}>Save</div>
          <label htmlFor='load-scene-file' className='optionButton'>Load</label>
          <input type='file' id='load-scene-file' name='file' onChange={(e) => onLoad(e.target.files)} />
        </div>
        <div>
          <div className='optionButton'>Play</div>
        </div>
      </Topbar>
      <Content>
        <SceneInspector />
        <Center>
          <EngineViewport />
        </Center>
        <NodeInspector />
      </Content>
    </>
  );
}