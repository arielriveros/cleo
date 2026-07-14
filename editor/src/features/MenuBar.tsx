import { useEffect, useRef, useState } from "react";
import { Logger } from "cleo";
import { useCleoEngine } from "./EngineContext";
import { buildGameData } from "./publish/buildGameData";
import { applyGameData } from "../utils/projectStorage";
import { publishWeb, publishDesktop, isDesktop } from "./publish/publishClient";
import { parseJsonFile, stringifyJson } from "../workers/workerClient";
import { startTask } from "./progress/progressStore";
import Topbar from "../components/Topbar";
import ModeSelector from "./ModeSelector";
import { Button, buttonVariants, cn } from "../components/ui";
import {
  SaveIcon, ImportIcon, ExportIcon, PublishIcon, ChevronDownIcon,
  SpinnerIcon, CheckIcon, AlertIcon, LayoutIcon,
  PlayGlyph, PauseGlyph, StopGlyph,
} from "./topbarIcons";

// One playback control. Same shape as ModeSelector's Segment / the viewport's gizmo toggle — a 25px
// segment in a bordered, rounded group — so the transport reads as part of the same toolbar family
// instead of the three floating PNG circles it used to be.
interface TransportProps {
  title: string;
  disabled: boolean;
  active?: boolean;
  accent: string;     // hover color when idle
  activeClass: string; // fill when this is the current state
  onClick: () => void;
  children: React.ReactNode;
}
function Transport({ title, disabled, active, accent, activeClass, onClick, children }: TransportProps) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center justify-center w-[30px] h-[25px] border-r border-control-hover last:border-r-0 transition-colors
        ${active ? activeClass : `bg-control text-muted ${accent} hover:bg-control-hover`}
        ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      {children}
    </button>
  );
}

export default function MenuBar() {
  const { instance, editorScene, scripts, bodies, triggers, ui, setUI, startPlay, stopPlay, pausePlay, editorMode, saveProject, saveActiveTemplate, saveActiveMaterial, saveActiveTerrainMaterial, saveActiveMesh, savingState, eventEmitter: eventEmitter } = useCleoEngine();
  // Current renderer look (post/SSAO/motion-blur/clear color) — embedded in exports/publishes so the
  // standalone game reproduces what the editor is showing instead of falling back to renderer defaults.
  const renderSettings = () => instance?.renderer.getRenderSettings();
  const templateMode = editorMode === 'template';
  const materialMode = editorMode === 'material';
  const terrainMaterialMode = editorMode === 'terrainMaterial';
  const meshMode = editorMode === 'mesh';
  // Template, (terrain-)material and mesh tabs all hide the project/scene-level actions (they edit a library asset).
  const libEdit = templateMode || materialMode || terrainMaterialMode || meshMode;
  const saving = savingState === 'saving';
  // Save carries its own status: the icon and the color say what happened, the label says it in words.
  const saveLabel = savingState === 'saving' ? 'Saving…' : savingState === 'saved' ? 'Saved' : savingState === 'error' ? 'Failed' : 'Save';
  const saveIcon = savingState === 'saving' ? <SpinnerIcon /> : savingState === 'saved' ? <CheckIcon /> : savingState === 'error' ? <AlertIcon /> : <SaveIcon />;
  const saveVariant = savingState === 'saved' ? 'success' : savingState === 'error' ? 'danger' : 'default';
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
  // Reading and parsing the file happen in the project worker — a scene with embedded textures is many
  // MB of JSON, and JSON.parse on it visibly stalls the editor. Only applyGameData (which parses into
  // the live engine scene) has to run here.
  const onImport = async (filelist: FileList | null) => {
    if (!filelist || !filelist.length) return;
    try {
      const json = await parseJsonFile(filelist[0]);
      applyGameData(json, { scene: editorScene, scripts, bodies, triggers, setUI, renderer: instance?.renderer });
      eventEmitter.emit('TEXTURES_CHANGED');
      eventEmitter.emit('SCENE_CHANGED');
      eventEmitter.emit('SELECT_NODE', null);
    } catch (err) {
      Logger.error('Failed to import scene: ' + err, 'Editor');
    }
  };

  // Save the whole project (scene + scripts/bodies/triggers + UI + editor prefs) to local storage.
  const onSave = () => saveProject();

  // Export the scene as a downloadable .json file (the former Save behavior).
  // The stringify runs in the worker and comes back as transferable bytes we wrap straight into a Blob.
  const onExport = async () => {
    if (!editorScene) return;
    const task = startTask({ title: 'Exporting scene', steps: ['Serializing scene', 'Writing file'] });
    try {
      task.setStep(0, { status: 'running', detail: 'Embedding textures' });
      const json = await buildGameData({ scene: editorScene, scripts, bodies, triggers, ui, settings: renderSettings() });
      task.setStep(0, { status: 'done' });

      task.setStep(1, { status: 'running', detail: 'Encoding scene.json' });
      const bytes = await stringifyJson(json);
      const blob = new Blob([bytes], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'scene.json';
      a.click();
      URL.revokeObjectURL(url);
      task.setStep(1, { status: 'done', detail: 'Downloaded scene.json' });
    } catch (e: any) {
      const message = String(e?.message ?? e);
      Logger.error(`Export failed: ${message}`, 'Editor');
      task.setStep(1, { status: 'failed', error: message });
    } finally {
      task.finish();
    }
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
  //
  // Split into two reported phases because they fail for different reasons and take very different times:
  // serializing the scene (embedding every texture) and then the build itself (script obfuscation, asset
  // packing, zipping) — the latter runs in the project worker and is by far the longest thing the editor does.
  const runPublish = async (
    title: string,
    ship: (data: any) => Promise<string>,
  ) => {
    setShowPublish(false);
    setPublishing(true);
    const task = startTask({ title, steps: ['Serializing scene', 'Building & writing files'] });
    try {
      if (!editorScene) throw new Error('No scene to publish');

      task.setStep(0, { status: 'running', detail: 'Embedding textures' });
      let data: any;
      try {
        data = await buildGameData({ scene: editorScene, scripts, bodies, triggers, ui, settings: renderSettings() });
      } catch (e: any) {
        task.setStep(0, { status: 'failed', error: String(e?.message ?? e) });
        throw e;
      }
      task.setStep(0, { status: 'done' });

      task.setStep(1, { status: 'running', detail: 'Obfuscating scripts, packing assets' });
      let message: string;
      try {
        message = await ship(data);
      } catch (e: any) {
        task.setStep(1, { status: 'failed', error: String(e?.message ?? e) });
        throw e;
      }
      task.setStep(1, { status: 'done', detail: message });
      Logger.info(message, 'Publish');
    } catch (e: any) {
      Logger.error(`Publish failed: ${e?.message || e}`, 'Publish');
    } finally {
      task.finish();
      setPublishing(false);
    }
  };

  const onPublishWeb = () => runPublish('Publishing web build', data => publishWeb(data, { embedAssets }));

  const onPublishDesktop = (installer: boolean) =>
    runPublish(installer ? 'Publishing desktop installer' : 'Publishing desktop build',
      data => publishDesktop(data, { installer, embedAssets }));

  const onPlay = () => startPlay();

  const onStop = () => stopPlay();

  const onPause = () => pausePlay();

  return (
    <Topbar>
      <div className='flex items-center gap-1.5 h-full px-1.5'>
        {templateMode && (
          <Button variant='primary' size='sm' className='h-[25px]' title='Save this template and update its placed instances' onClick={() => saveActiveTemplate()}>
            <SaveIcon /> Save Template
          </Button>
        )}
        {materialMode && (
          <Button variant='primary' size='sm' className='h-[25px]' title='Save this material (captures a thumbnail) and update nodes that use it' onClick={() => saveActiveMaterial()}>
            <SaveIcon /> Save Material
          </Button>
        )}
        {terrainMaterialMode && (
          <Button variant='primary' size='sm' className='h-[25px]' title='Save this terrain material (captures a thumbnail) and update layers that use it' onClick={() => saveActiveTerrainMaterial()}>
            <SaveIcon /> Save Terrain Material
          </Button>
        )}
        {meshMode && (
          <Button variant='primary' size='sm' className='h-[25px]' title='Save this mesh (with its LOD levels) and update its placed copies' onClick={() => saveActiveMesh()}>
            <SaveIcon /> Save Mesh
          </Button>
        )}
        <Button
          variant={saveVariant} size='sm' className='h-[25px] w-[86px]'
          disabled={libEdit || saving}
          title='Save the project to local storage'
          onClick={() => onSave()}
        >
          {saveIcon} {saveLabel}
        </Button>
        {/* A file input needs a <label> to trigger it, so it borrows the Button styles rather than being one. */}
        <label
          htmlFor='load-scene-file'
          title='Import a .json scene file'
          className={cn(buttonVariants({ variant: 'subtle', size: 'sm' }), 'h-[25px] cursor-pointer', libEdit && 'opacity-60 pointer-events-none')}
        >
          <ImportIcon /> Import
        </label>
        <input className="hidden" type='file' accept='.json' id='load-scene-file' name='file' onChange={(e) => { onImport(e.target.files); e.currentTarget.value = ''; }} />
        <Button variant='subtle' size='sm' className='h-[25px]' disabled={libEdit} title='Export the scene to a .json file' onClick={() => onExport()}>
          <ExportIcon /> Export
        </Button>
        <div className='relative inline-block' ref={publishRef}>
          <Button
            variant='primary' size='sm' className='h-[25px]'
            disabled={publishing || libEdit}
            title='Publish an optimized build of your game'
            onClick={() => setShowPublish(v => !v)}
          >
            {publishing ? <SpinnerIcon /> : <PublishIcon />}
            {publishing ? 'Publishing…' : 'Publish'}
            {!publishing && <ChevronDownIcon />}
          </Button>
          {showPublish && (
            <div className='absolute left-[5px] top-[29px] z-50 w-[240px] bg-surface-raised border border-control-hover rounded shadow-lg py-1 text-white text-sm'>
              <label className='flex items-start gap-2 px-3 py-2 border-b border-control-hover cursor-pointer select-none' onClick={(e) => e.stopPropagation()}>
                <input type='checkbox' className='mt-[3px]' checked={embedAssets} onChange={(e) => setEmbedAssets(e.target.checked)} />
                <span>
                  <span className='font-semibold'>Embed assets in data</span>
                  <span className='block text-[11px] text-muted'>{embedAssets ? 'One self-contained game.json (larger)' : 'Loose assets/ files + small game.json'}</span>
                </span>
              </label>
              <div className='px-3 py-2 hover:bg-control cursor-pointer' onClick={onPublishWeb}>
                <div className='font-semibold'>Web (HTML)</div>
                <div className='text-[11px] text-muted'>{desktop ? 'Write index.html + game.js + game.json to a folder' : 'Download a .zip of the game'}</div>
              </div>
              <div
                className={`px-3 py-2 ${desktop ? 'hover:bg-control cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}
                onClick={() => desktop && onPublishDesktop(false)}
              >
                <div className='font-semibold'>Desktop (Electron)</div>
                <div className='text-[11px] text-muted'>{desktop ? 'Runnable Electron game folder' : 'Only available in the desktop app'}</div>
              </div>
              {desktop && (
                <div className='px-3 py-2 hover:bg-control cursor-pointer' onClick={() => onPublishDesktop(true)}>
                  <div className='font-semibold'>Desktop installer</div>
                  <div className='text-[11px] text-muted'>Package a native installer (electron-builder)</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className='flex items-center h-full'>
        <div className='flex items-center rounded overflow-hidden border border-control-hover my-[2px]'>
          <Transport
            title='Play' disabled={playState === 'playing' || libEdit}
            active={playState === 'playing'} activeClass='bg-success text-white'
            accent='hover:text-success' onClick={() => onPlay()}
          >
            <PlayGlyph />
          </Transport>
          <Transport
            title='Pause' disabled={playState === 'paused' || playState === 'stopped' || libEdit}
            active={playState === 'paused'} activeClass='bg-selected text-white'
            accent='hover:text-white' onClick={() => onPause()}
          >
            <PauseGlyph />
          </Transport>
          <Transport
            title='Stop' disabled={playState === 'stopped' || libEdit}
            active={false} activeClass=''
            accent='hover:text-danger' onClick={() => onStop()}
          >
            <StopGlyph />
          </Transport>
        </div>
      </div>
      <ModeSelector />
      <div className='flex items-center h-full px-1.5'>
        <Button
          variant='subtle' size='sm' className='h-[25px]'
          disabled={playState !== 'stopped'}
          title='Restore the default panel layout'
          onClick={() => eventEmitter.emit('RESET_DOCK_LAYOUT')}
        >
          <LayoutIcon /> Reset Layout
        </Button>
      </div>
    </Topbar>
  )
}
