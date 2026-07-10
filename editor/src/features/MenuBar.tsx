import { useEffect, useRef, useState } from "react";
import { Logger } from "cleo";
import { useCleoEngine } from "./EngineContext";
import { buildGameData } from "./publish/buildGameData";
import { applyGameData } from "../utils/projectStorage";
import { publishWeb, publishDesktop, isDesktop } from "./publish/publishClient";
import Topbar from "../components/Topbar";
import ModeSelector from "./ModeSelector";
import PlayIcon from '../icons/play.png'
import PauseIcon from '../icons/pause.png'
import StopIcon from '../icons/stop.png'

export default function MenuBar() {
  const { editorScene, scripts, bodies, triggers, ui, setUI, startPlay, stopPlay, pausePlay, editorMode, saveProject, savingState, eventEmitter: eventEmitter } = useCleoEngine();
  const templateMode = editorMode === 'template';
  const saving = savingState === 'saving';
  const saveLabel = savingState === 'saving' ? 'Saving…' : savingState === 'saved' ? 'Saved ✓' : savingState === 'error' ? 'Save failed' : 'Save';
  const saveBorder = savingState === 'error' ? 'border-red-400' : savingState === 'saved' ? 'border-green-400' : 'border-[#ccc]';
  const [playState, setPlayState] = useState<'playing' | 'paused' | 'stopped'>('stopped');
  const [showPublish, setShowPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [embedAssets, setEmbedAssets] = useState(true);
  const publishRef = useRef<HTMLDivElement>(null);
  const desktop = isDesktop();

  useEffect(() => {
    const handlePlayState = (state: 'play' | 'pause' | 'stop') => {
      if (state === 'play') setPlayState('playing');
      if (state === 'pause') setPlayState('paused');
      if (state === 'stop') setPlayState('stopped');
    }
    eventEmitter.on('SET_PLAY_STATE', handlePlayState);
    return () => { eventEmitter.off('SET_PLAY_STATE', handlePlayState) };
  }, [eventEmitter]);
  
  // Import a .json scene file into the editor (delegates to the shared restore routine).
  const onImport = (filelist: FileList | null) => {
    if (!filelist || !filelist.length) return;
    const reader = new FileReader();
    reader.readAsText(filelist[0]);
    reader.onload = (e) => {
      const data = e.target?.result;
      if (!data) return;
      try {
        const json = JSON.parse(data as string);
        applyGameData(json, { scene: editorScene, scripts, bodies, triggers, setUI });
        eventEmitter.emit('TEXTURES_CHANGED');
        eventEmitter.emit('SCENE_CHANGED');
        eventEmitter.emit('SELECT_NODE', null);
      } catch (err) {
        Logger.error('Failed to import scene: ' + err, 'Editor');
      }
    };
  };

  // Save the whole project (scene + scripts/bodies/triggers + UI + editor prefs) to local storage.
  const onSave = () => saveProject();

  // Export the scene as a downloadable .json file (the former Save behavior).
  const onExport = async () => {
    if (!editorScene) return;
    const json = await buildGameData({ scene: editorScene, scripts, bodies, triggers, ui });
    const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scene.json';
    a.click();
  };

  // Close the Publish dropdown when clicking outside it.
  useEffect(() => {
    if (!showPublish) return;
    const onDocClick = (e: MouseEvent) => {
      if (publishRef.current && !publishRef.current.contains(e.target as Node)) setShowPublish(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showPublish]);

  // Publish targets embed all assets: buildGameData with useCache=false so textures serialize to base64.
  const runPublish = async (action: () => Promise<string>) => {
    setShowPublish(false);
    setPublishing(true);
    try {
      const message = await action();
      Logger.info(message, 'Publish');
    } catch (e: any) {
      Logger.error(`Publish failed: ${e?.message || e}`, 'Publish');
    } finally {
      setPublishing(false);
    }
  };

  const onPublishWeb = () => runPublish(async () => {
    if (!editorScene) throw new Error('No scene to publish');
    const data = await buildGameData({ scene: editorScene, scripts, bodies, triggers, ui });
    return publishWeb(data, { embedAssets });
  });

  const onPublishDesktop = (installer: boolean) => runPublish(async () => {
    if (!editorScene) throw new Error('No scene to publish');
    const data = await buildGameData({ scene: editorScene, scripts, bodies, triggers, ui });
    return publishDesktop(data, { installer, embedAssets });
  });

  const onPlay = () => startPlay();

  const onStop = () => stopPlay();

  const onPause = () => pausePlay();

  return (
    <Topbar>
      <div className='flex items-center h-full'>
        <div className={`text-white h-[25px] border ${saveBorder} bg-[#3b3b3b] text-center w-[90px] inline-block cursor-pointer my-[2px] mx-[4px] px-2 rounded ${(templateMode || saving) ? 'opacity-50 pointer-events-none' : ''}`} title='Save the project to local storage' onClick={() => onSave()}>{saveLabel}</div>
        <label htmlFor='load-scene-file' className={`text-white h-[25px] border border-[#ccc] bg-[#3b3b3b] text-center w-[80px] inline-block cursor-pointer my-[2px] mx-[4px] px-2 rounded ${templateMode ? 'opacity-50 pointer-events-none' : ''}`} title='Import a .json scene file'>Import</label>
        <input className="hidden" type='file' accept='.json' id='load-scene-file' name='file' onChange={(e) => { onImport(e.target.files); e.currentTarget.value = ''; }} />
        <div className={`text-white h-[25px] border border-[#ccc] bg-[#3b3b3b] text-center w-[80px] inline-block cursor-pointer my-[2px] mx-[4px] px-2 rounded ${templateMode ? 'opacity-50 pointer-events-none' : ''}`} title='Export the scene to a .json file' onClick={() => onExport()}>Export</div>
        <div className='relative inline-block' ref={publishRef}>
          <div
            className={`text-white h-[25px] border border-[#8f8fe0] bg-[#2c2c7a] text-center w-[90px] inline-block cursor-pointer my-[2px] mx-[4px] px-2 rounded ${(publishing || templateMode) ? 'opacity-50 pointer-events-none' : ''}`}
            title='Publish an optimized build of your game'
            onClick={() => setShowPublish(v => !v)}
          >
            {publishing ? 'Publishing…' : 'Publish ▾'}
          </div>
          {showPublish && (
            <div className='absolute left-[5px] top-[29px] z-50 w-[240px] bg-[#2b2b2b] border border-[#555] rounded shadow-lg py-1 text-white text-sm'>
              <label className='flex items-start gap-2 px-3 py-2 border-b border-[#444] cursor-pointer select-none' onClick={(e) => e.stopPropagation()}>
                <input type='checkbox' className='mt-[3px]' checked={embedAssets} onChange={(e) => setEmbedAssets(e.target.checked)} />
                <span>
                  <span className='font-semibold'>Embed assets in data</span>
                  <span className='block text-[11px] text-[#aaa]'>{embedAssets ? 'One self-contained game.json (larger)' : 'Loose assets/ files + small game.json'}</span>
                </span>
              </label>
              <div className='px-3 py-2 hover:bg-[#3b3b3b] cursor-pointer' onClick={onPublishWeb}>
                <div className='font-semibold'>Web (HTML)</div>
                <div className='text-[11px] text-[#aaa]'>{desktop ? 'Write index.html + game.js + game.json to a folder' : 'Download a .zip of the game'}</div>
              </div>
              <div
                className={`px-3 py-2 ${desktop ? 'hover:bg-[#3b3b3b] cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}
                onClick={() => desktop && onPublishDesktop(false)}
              >
                <div className='font-semibold'>Desktop (Electron)</div>
                <div className='text-[11px] text-[#aaa]'>{desktop ? 'Runnable Electron game folder' : 'Only available in the desktop app'}</div>
              </div>
              {desktop && (
                <div className='px-3 py-2 hover:bg-[#3b3b3b] cursor-pointer' onClick={() => onPublishDesktop(true)}>
                  <div className='font-semibold'>Desktop installer</div>
                  <div className='text-[11px] text-[#aaa]'>Package a native installer (electron-builder)</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className='flex items-center h-full'>
        <button className='text-white bg-[#2c2cff] cursor-pointer w-[30px] h-[30px] mx-[2px] p-0 rounded-full disabled:bg-[#3b3b3b] disabled:cursor-not-allowed hover:bg-[#3f3fb4] disabled:hover:bg-[#3b3b3b]' disabled={playState==='playing' || templateMode} onClick={() => onPlay()}>
          <img src={PlayIcon} alt='Play' className='inline-block h-full w-full align-middle' />
        </button>
        <button className='text-white bg-[#2c2cff] cursor-pointer w-[30px] h-[30px] mx-[2px] p-0 rounded-full disabled:bg-[#3b3b3b] disabled:cursor-not-allowed hover:bg-[#3f3fb4] disabled:hover:bg-[#3b3b3b]' disabled={playState==='paused' || playState==='stopped' || templateMode} onClick={() => onPause()}>
          <img src={PauseIcon} alt='Pause' className='inline-block h-full w-full align-middle' />
        </button>
        <button className='text-white bg-[#2c2cff] cursor-pointer w-[30px] h-[30px] mx-[2px] p-0 rounded-full disabled:bg-[#3b3b3b] disabled:cursor-not-allowed hover:bg-[#3f3fb4] disabled:hover:bg-[#3b3b3b]' disabled={playState==='stopped' || templateMode} onClick={() => onStop()}>
          <img src={StopIcon} alt='Stop' className='inline-block h-full w-full align-middle' />
        </button>
      </div>
      <div className='flex items-center justify-between h-full w-[90px] text-white'>
        <p className='m-0'>View</p>
        <select className='bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1 disabled:opacity-50' disabled={ playState==='playing' || playState==='paused' || templateMode } onChange={(e) => eventEmitter.emit('CHANGE_DIMENSION', (e.target.value as '2D' | '3D'))}>
          <option value='3D'>3D</option>
          <option value='2D'>2D</option>
        </select>
      </div>
      <ModeSelector />
      <div />
    </Topbar>
  )
}
