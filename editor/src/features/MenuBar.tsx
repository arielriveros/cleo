import { useEffect, useRef, useState } from "react";
import { Logger } from "cleo";
import { useCleoEngine } from "./EngineContext";
import { buildGameData } from "./publish/buildGameData";
import { publishWeb, publishDesktop, isDesktop } from "./publish/publishClient";
import Topbar from "../components/Topbar";
import PlayIcon from '../icons/play.png'
import PauseIcon from '../icons/pause.png'
import StopIcon from '../icons/stop.png'

export default function MenuBar() {
  const { instance, editorScene, scripts, bodies, triggers, ui, setUI, startPlay, stopPlay, pausePlay, editorMode, setEditorMode, eventEmitter: eventEmitter } = useCleoEngine();
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

  const onSave = async () => {
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
        <div className='text-white h-[25px] border border-[#ccc] bg-[#3b3b3b] text-center w-[98px] inline-block cursor-pointer my-[2px] mx-[5px] px-2 rounded' onClick={() => onSave()}>Save</div>
        <label htmlFor='load-scene-file' className='text-white h-[25px] border border-[#ccc] bg-[#3b3b3b] text-center w-[98px] inline-block cursor-pointer my-[2px] mx-[5px] px-2 rounded'>Load</label>
        <input className="hidden" type='file' id='load-scene-file' name='file' onChange={(e) => onLoad(e.target.files)} />
        <div className='relative inline-block' ref={publishRef}>
          <div
            className={`text-white h-[25px] border border-[#8f8fe0] bg-[#2c2c7a] text-center w-[98px] inline-block cursor-pointer my-[2px] mx-[5px] px-2 rounded ${publishing ? 'opacity-50 pointer-events-none' : ''}`}
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
