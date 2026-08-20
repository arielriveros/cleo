import { useEffect, useRef, useState } from "react";
import { Logger } from "cleo";
import { useCleoEngine, KIND_LABEL } from "./EngineContext";
import { useVfs } from "./assets/VfsContext";
import { buildMultiSceneGameData } from "./publish/buildMultiSceneGameData";
import { publishWeb, publishDesktop, isDesktop } from "./publish/publishClient";
import WorkspaceStatusChip from "./scriptWorkspace/WorkspaceStatusChip";
import { useScriptWorkspace } from "./scriptWorkspace/ScriptWorkspaceContext";
import { NOT_DESKTOP_REASON } from "./scriptWorkspace/desktopScripts";
import { importBundleJob } from "../workers/workerClient";
import { exportBundle } from "../utils/bundleExport";
import { applyBundleReplace, applyBundleMerge, applyBundleAsNewProject } from "../utils/bundleImport";
import type { BundleData } from "../utils/bundle";
import ImportBundleModal from "./dialogs/ImportBundleModal";
import { startTask } from "./progress/progressStore";
import Topbar from "../components/Topbar";
import ModeSelector from "./ModeSelector";
import UndoButtons from "./UndoButtons";
import { Button, buttonVariants, cn } from "../components/ui";
import {
  SaveIcon, ImportIcon, ExportIcon, PublishIcon, ChevronDownIcon, CodeIcon,
  SpinnerIcon, CheckIcon, AlertIcon, LayoutIcon, ProjectsIcon,
  PlayGlyph, PauseGlyph, StopGlyph,
} from "./topbarIcons";
import ProjectsModal from "./projects/ProjectsModal";
import { loadProjects } from "../utils/projects";
import { activeProjectId } from "../utils/projectScope";

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
  const { instance, editorScene, scripts, scriptAssets, bodies, triggers, startPlay, stopPlay, pausePlay, editorMode, saveActiveTab, saveAll, dirtyTabs, activeTab, savingState, eventEmitter: eventEmitter, sceneList, mainSceneId, openSceneId, materials, terrainMaterials, templates, models, animationFields, animations, tilesets, sceneDimension } = useCleoEngine();
  const { vfs } = useVfs();
  // A parsed bundle awaiting the user's Replace/Merge choice (ImportBundleModal).
  const [pendingBundle, setPendingBundle] = useState<BundleData | null>(null);
  // Current renderer look (post/SSAO/motion-blur/clear color) — embedded in exports/publishes so the
  // standalone game reproduces what the editor is showing instead of falling back to renderer defaults.
  const renderSettings = () => instance?.renderer.getRenderSettings();
  // Import/export/publish are project-level and stay tied to the scene: they act on the whole project, so a
  // library tab (template, (terrain-)material, mesh, script) has nothing for them to operate on.
  const libEdit = editorMode === 'template' || editorMode === 'material' || editorMode === 'terrainMaterial'
    || editorMode === 'model' || editorMode === 'script';
  const saving = savingState === 'saving';
  // Save carries its own status: the icon and the color say what happened, the label says it in words.
  const saveLabel = savingState === 'saving' ? 'Saving…' : savingState === 'saved' ? 'Saved' : savingState === 'error' ? 'Failed' : 'Save';
  const saveIcon = savingState === 'saving' ? <SpinnerIcon /> : savingState === 'saved' ? <CheckIcon /> : savingState === 'error' ? <AlertIcon /> : <SaveIcon />;
  const saveVariant = savingState === 'saved' ? 'success' : savingState === 'error' ? 'danger' : 'default';
  // Save targets whatever the active tab edits; Save All sweeps the rest. An animation tab has no asset —
  // "saving" it applies the machine onto the source model, which is what its own Apply to Model button does.
  const activeDirty = !!dirtyTabs[activeTab.id];
  const dirtyCount = Object.values(dirtyTabs).filter(Boolean).length;
  const saveTitle = activeTab.kind === 'animation'
    ? 'Apply the state machine to the source model (Ctrl+S)'
    : `Save this ${KIND_LABEL[activeTab.kind].toLowerCase()} (Ctrl+S)`;
  const [playState, setPlayState] = useState<'playing' | 'paused' | 'stopped'>('stopped');
  const [showProjects, setShowProjects] = useState(false);
  // The open project's name, read once — it only ever changes by reloading into another project.
  const [projectName, setProjectName] = useState('');
  useEffect(() => {
    void loadProjects().then(list => setProjectName(list.find(p => p.id === activeProjectId())?.name ?? ''));
  }, [showProjects]);
  const [showPublish, setShowPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const publishRef = useRef<HTMLDivElement>(null);
  const desktop = isDesktop();
  const scriptWs = useScriptWorkspace();

  useEffect(() => {
    const handlePlayState = (state: 'play' | 'pause' | 'stop') => {
      if (state === 'play') setPlayState('playing');
      if (state === 'pause') setPlayState('paused');
      if (state === 'stop') setPlayState('stopped');
    }
    eventEmitter.on('SET_PLAY_STATE', handlePlayState);
    return () => { eventEmitter.off('SET_PLAY_STATE', handlePlayState) };
  }, [eventEmitter]);
  
  // The two project-I/O buttons both operate on the whole workspace as one portable .zip.
  const projectMeta = () => ({ version: 2 as const, mainSceneId, openSceneId, scenes: sceneList });
  const libraries = () => ({ materials, terrainMaterials, templates, models, scripts: scriptAssets, animationFields, animations, tilesets });

  // Export the entire project — every scene, all asset libraries, the folder layout (VFS) and texture
  // payloads — as project.cleoproj.zip: a full, portable replica of the workspace. Assembled off-thread.
  const onExport = async () => {
    const task = startTask({ title: 'Exporting project', steps: ['Gathering & zipping'] });
    try {
      task.setStep(0, { status: 'running', detail: 'Bundling scenes, assets and textures' });
      await exportBundle({ kind: 'project', meta: projectMeta(), libraries: libraries(), vfs, projectName });
      task.setStep(0, { status: 'done', detail: 'Downloaded the project bundle' });
    } catch (e: any) {
      task.setStep(0, { status: 'failed', error: String(e?.message ?? e) });
      Logger.error(`Project export failed: ${e?.message ?? e}`, 'Editor');
    } finally { task.finish(); }
  };

  // Import a project .zip: parse it (off-thread), then park the Replace/Merge decision on the user
  // (ImportBundleModal). Reads both project bundles and legacy asset packs.
  const onImport = async (filelist: FileList | null) => {
    if (!filelist || !filelist.length) return;
    try {
      const bundle = await importBundleJob(filelist[0]);
      setPendingBundle(bundle);
    } catch (err) {
      Logger.error('Failed to read project bundle: ' + err, 'Editor');
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
        // Multi-scene game data: the open scene from the live editor (unsaved edits included), every other
        // scene loaded + re-resolved against the current libraries, textures embedded once. Scripts can
        // switch scenes at runtime via Game.loadScene.
        data = await buildMultiSceneGameData({
          mainSceneId, openSceneId, scenes: sceneList,
          liveScene: editorScene, liveScripts: scripts, liveBodies: bodies, liveTriggers: triggers,
          libs: { materials, models, templates, terrainMaterials, scripts: scriptAssets, tilesets, animations },
          scriptAssets,
          liveDimension: sceneDimension,
          settings: renderSettings(),
        });
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

  const onPublishWeb = () => runPublish('Publishing web build', data => publishWeb(data));

  const onPublishDesktop = (installer: boolean) =>
    runPublish(installer ? 'Publishing desktop installer' : 'Publishing desktop build',
      data => publishDesktop(data, { installer }));

  const onPlay = () => startPlay();

  const onStop = () => stopPlay();

  const onPause = () => pausePlay();

  return (
    <Topbar>
      <div className='flex items-center gap-1.5 h-full px-1.5'>
        {/* Outermost scope first, so the row reads Projects → Save → Import/Export → Publish. Never gated by
            the active tab: which project you are in is not an editing mode. */}
        <Button
          variant='subtle' size='sm' className='h-[25px] max-w-[180px]'
          title='Switch, create or delete projects'
          onClick={() => setShowProjects(true)}
        >
          <ProjectsIcon /> <span className='truncate'>{projectName || 'Projects'}</span>
        </Button>
        {showProjects && <ProjectsModal onClose={() => setShowProjects(false)} />}
        <Button
          variant={saveVariant} size='sm' className='h-[25px] w-[86px]'
          disabled={saving || !activeDirty}
          title={saveTitle}
          onClick={() => void saveActiveTab()}
        >
          {saveIcon} {saveLabel}
        </Button>
        <Button
          variant='subtle' size='sm' className='h-[25px]'
          disabled={saving || dirtyCount === 0}
          title='Save every asset with unsaved changes'
          onClick={() => void saveAll()}
        >
          <SaveIcon /> Save All{dirtyCount > 0 && ` (${dirtyCount})`}
        </Button>
        {/* A file input needs a <label> to trigger it, so it borrows the Button styles rather than being one. */}
        <label
          htmlFor='load-project-file'
          title='Import a project .zip — replace or merge the whole workspace'
          className={cn(buttonVariants({ variant: 'subtle', size: 'sm' }), 'h-[25px] cursor-pointer', libEdit && 'opacity-60 pointer-events-none')}
        >
          <ImportIcon /> Import
        </label>
        <input className="hidden" type='file' accept='.zip' id='load-project-file' name='file' onChange={(e) => { onImport(e.target.files); e.currentTarget.value = ''; }} />
        <Button variant='subtle' size='sm' className='h-[25px]' disabled={libEdit} title='Export the whole project (scenes + assets + textures) to a .zip' onClick={onExport}>
          <ExportIcon /> Export
        </Button>
        {/* The script workspace: connected -> a status chip with its recovery actions; not connected -> the
            one-time folder picker. Disabled in the browser, which has no filesystem to mirror into. */}
        {scriptWs.status === 'off' ? (
          <Button
            variant='subtle' size='sm' className='h-[25px]'
            disabled={!scriptWs.available}
            title={scriptWs.available
              ? 'Mirror this project’s scripts to a folder you can open in VSCode'
              : NOT_DESKTOP_REASON}
            onClick={() => void scriptWs.setup()}
          >
            <CodeIcon /> Edit in VSCode
          </Button>
        ) : <WorkspaceStatusChip />}
        {pendingBundle && (
          <ImportBundleModal
            bundle={pendingBundle}
            onCancel={() => setPendingBundle(null)}
            onNewProject={() => { const b = pendingBundle; setPendingBundle(null); void applyBundleAsNewProject(b); }}
            onReplace={() => { const b = pendingBundle; setPendingBundle(null); void applyBundleReplace(b); }}
            onMerge={() => { const b = pendingBundle; setPendingBundle(null); void applyBundleMerge(b); }}
          />
        )}
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
              <div className='px-3 py-2 hover:bg-control cursor-pointer' onClick={onPublishWeb}>
                <div className='font-semibold'>Web (HTML)</div>
                <div className='text-[11px] text-muted'>{desktop ? 'Write index.html + game.js + game.bin to a folder' : 'Download a .zip of the game'}</div>
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
          {/* Never gated by the active tab. Play runs the game scene from anywhere: startPlay switches to
              the scene tab itself, and Stop returns to the tab you pressed it from. */}
          <Transport
            title='Play' disabled={playState === 'playing'}
            active={playState === 'playing'} activeClass='bg-success text-white'
            accent='hover:text-success' onClick={() => onPlay()}
          >
            <PlayGlyph />
          </Transport>
          <Transport
            title='Pause' disabled={playState === 'paused' || playState === 'stopped'}
            active={playState === 'paused'} activeClass='bg-selected text-white'
            accent='hover:text-white' onClick={() => onPause()}
          >
            <PauseGlyph />
          </Transport>
          <Transport
            title='Stop' disabled={playState === 'stopped'}
            active={false} activeClass=''
            accent='hover:text-danger' onClick={() => onStop()}
          >
            <StopGlyph />
          </Transport>
        </div>
      </div>
      <ModeSelector />
      <div className='flex items-center h-full px-1.5 gap-1.5'>
        <UndoButtons />
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
