import { useEffect, useRef, useState } from "react";
import { Logger, isDefaultInputMap } from "cleo";
import { isDefaultProjectSettings } from "./options/projectSettings";
import { useCleoEngine, KIND_LABEL } from "./EngineContext";
import { useVfs } from "./assets/VfsContext";
import { buildMultiSceneGameData } from "./publish/buildMultiSceneGameData";
import { publishWeb, publishDesktop, isDesktop } from "./publish/publishClient";
import WorkspaceStatusChip from "./scriptWorkspace/WorkspaceStatusChip";
import { importBundleJob } from "../workers/workerClient";
import { exportBundle } from "../utils/bundleExport";
import { applyBundleReplace, applyBundleMerge, applyBundleAsNewProject, IMPORT_WRITE_STEPS } from "../utils/bundleImport";
import { beginLoad, type LoadStepSpec } from "./loading/loadingStore";
import { confirmDiscard } from "./unloadGuard";
import type { BundleData } from "../utils/bundle";
import ImportBundleModal from "./dialogs/ImportBundleModal";
import { startTask } from "./progress/progressStore";
import Topbar from "../components/Topbar";
import ModeSelector from "./ModeSelector";
import UndoButtons from "./UndoButtons";
import { Button, MenuItem, buttonVariants, cn } from "../components/ui";
import {
  SaveIcon, ImportIcon, ExportIcon, PublishIcon, ChevronDownIcon,
  SpinnerIcon, CheckIcon, AlertIcon, LayoutIcon, ProjectsIcon,
  PlayGlyph, SimulateGlyph, PauseGlyph, StopGlyph,
} from "./topbarIcons";
import ProjectsModal from "./projects/ProjectsModal";
import { loadProjects } from "../utils/projects";
import { activeProjectId } from "../utils/projectScope";

// One playback control. Same shape as ModeSelector's Segment / the viewport's gizmo toggle — a 25px
// segment in a bordered, rounded group.
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
    <Button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'w-[30px] h-[25px] p-0 rounded-none border-0 border-r border-control-hover last:border-r-0 disabled:opacity-40',
        active ? activeClass : cn('text-muted', accent),
      )}
    >
      {children}
    </Button>
  );
}

export default function MenuBar() {
  const { instance, editorScene, scripts, scriptAssets, bodies, triggers, startPlay, startSimulate, stopPlay, pausePlay, editorMode, saveActiveTab, saveAll, dirtyTabs, activeTab, savingState, eventEmitter: eventEmitter, sceneList, mainSceneId, openSceneId, materials, terrainMaterials, templates, models, animationFields, animations, rigs, tilesets, aiBrains, particleSystems, animControllers, boneMasks, poseAssets, audioSources, soundSamples, sceneDimension, inputMap, scriptPaths, projectSettings } = useCleoEngine();
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
  // "saving" it applies the machine onto the source node, which is what its own Apply State Machine button does.
  const activeDirty = !!dirtyTabs[activeTab.id];
  const dirtyCount = Object.values(dirtyTabs).filter(Boolean).length;
  const saveTitle = activeTab.kind === 'stateMachine'
    ? 'Apply the state machine to the source model (Ctrl+S)'
    : `Save this ${KIND_LABEL[activeTab.kind].toLowerCase()} (Ctrl+S)`;
  const [playState, setPlayState] = useState<'playing' | 'simulating' | 'paused' | 'stopped'>('stopped');
  // Which kind of session is running (or paused): Play and Simulate are exclusive, and a paused session
  // resumes through its own button.
  const [sessionKind, setSessionKind] = useState<'play' | 'simulate' | null>(null);
  const [showProjects, setShowProjects] = useState(false);
  // The open project's name: re-read when the projects modal closes, pushed on a rename from Options.
  const [projectName, setProjectName] = useState('');
  useEffect(() => {
    void loadProjects().then(list => setProjectName(list.find(p => p.id === activeProjectId())?.name ?? ''));
  }, [showProjects]);
  // Options ▸ Project renames the open project in place.
  useEffect(() => {
    const onRename = (e: Event) => setProjectName((e as CustomEvent<string>).detail);
    window.addEventListener('cleo:project-renamed', onRename);
    return () => window.removeEventListener('cleo:project-renamed', onRename);
  }, []);
  const [showPublish, setShowPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const publishRef = useRef<HTMLDivElement>(null);
  const desktop = isDesktop();

  useEffect(() => {
    const handlePlayState = (state: 'play' | 'simulate' | 'pause' | 'stop') => {
      if (state === 'play') { setPlayState('playing'); setSessionKind('play'); }
      if (state === 'simulate') { setPlayState('simulating'); setSessionKind('simulate'); }
      if (state === 'pause') setPlayState('paused');
      if (state === 'stop') { setPlayState('stopped'); setSessionKind(null); }
    }
    eventEmitter.on('SET_PLAY_STATE', handlePlayState);
    return () => { eventEmitter.off('SET_PLAY_STATE', handlePlayState) };
  }, [eventEmitter]);
  
  // The two project-I/O buttons both operate on the whole workspace as one portable .zip.
  const projectMeta = () => ({ version: 2 as const, mainSceneId, openSceneId, scenes: sceneList });
  // The input map travels only when it differs from the default — see BundleLibraries.inputMap.
  const libraries = () => ({ materials, terrainMaterials, templates, models, scripts: scriptAssets, animationFields, animations, rigs, tilesets, aiBrains, particleSystems, animControllers, boneMasks, poseAssets, audioSources, soundSamples,
    inputMap: isDefaultInputMap(inputMap) ? null : inputMap,
    projectSettings: isDefaultProjectSettings(projectSettings) ? null : projectSettings });

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
    const file = filelist[0];
    // Reading is its own short load: it ends at the Replace/Merge question, and the writes the answer
    // starts are a second one (`applyImport`).
    const load = beginLoad(`Reading ${file.name}`, [
      { id: 'unpack', label: `Unpacking (${(file.size / (1024 * 1024)).toFixed(1)} MB)`, weight: 1 },
    ], 'fullscreen', { showAfterMs: 150 });
    try {
      load.step('unpack').start('off-thread');
      const bundle = await importBundleJob(file);
      load.step('unpack').done();
      setPendingBundle(bundle);
    } catch (err) {
      Logger.error('Failed to read project bundle: ' + err, 'Editor');
    } finally {
      load.finish();
    }
  };

  // Run the chosen import under the full loading screen. Every mode ends in a reload, after which the
  // startup splash carries the finished steps on; a declined confirm or a failure closes it again.
  const applyImport = async (title: string, steps: LoadStepSpec[], confirm: string | null,
                             apply: () => Promise<boolean>) => {
    // The unsaved-work question first: the loading screen would sit on top of its dialog.
    if (confirm && !(await confirmDiscard(confirm))) return;
    const load = beginLoad(title, steps);
    let leaving = false;
    try {
      leaving = await apply();
      if (leaving) setPendingBundle(null);
    } catch (err) {
      Logger.error(`Import failed: ${err}`, 'Editor');
    } finally {
      if (!leaving) load.finish();
    }
  };
  const bundleName = (b: NonNullable<typeof pendingBundle>) => b.manifest.projectName || 'project';

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
  // Split into two reported phases: serializing the scene (embedding every texture), then the build itself
  // (script obfuscation, asset packing, zipping), which runs in the project worker.
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
          // `rigs` is load-bearing: publish flattens each shipped animation's rig back into `sourceSkin`,
          // and without the table here every animation carrying only a `rigId` ships unretargetable.
          // Controllers, masks, poses and fields re-embed state machines in every scene that ships (see
          // `reembedMachine`); `poseAssets` also carries clip pose offsets into the published game.
          // `particleSystems` lets the resync refresh a CLOSED scene's embedded effects before it ships —
          // the game itself needs no library, the copies ride inside the scenes.
          libs: { materials, models, templates, terrainMaterials, scripts: scriptAssets, tilesets, aiBrains, animations, rigs,
            animControllers, boneMasks, poseAssets, animationFields, particleSystems },
          scriptAssets,
          // Script modules: each script's project path, so the build ships what the scripts import.
          scriptPaths,
          liveDimension: sceneDimension,
          settings: renderSettings(),
          // Written once at the top level of the build, never inside a scene: bindings are project-wide.
          input: inputMap,
          // Engine runtime + window options (Options ▸ Engine / Project ▸ General), into `config`.
          projectSettings,
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

  // The game's name: Options ▸ Project ▸ Published game ▸ Title, else the project name. A native publish
  // saves into a folder of this name; the browser download is a slug of it.
  const gameName = projectSettings.publish.title.trim() || projectName.trim();
  const onPublishWeb = () => runPublish('Publishing web build',
    data => publishWeb(data, gameName || undefined));

  const onPublishDesktop = (installer: boolean) =>
    runPublish(installer ? 'Publishing desktop installer' : 'Publishing desktop build',
      data => publishDesktop(data, { installer, name: gameName || undefined, window: projectSettings.publish }));

  const onPlay = () => startPlay();

  const onSimulate = () => startSimulate();

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
        {/* The script workspace appears here only when it needs attention (paused sync, error, conflict);
            setting it up and its everyday status live in Options ▸ Editor ▸ Scripts. */}
        <WorkspaceStatusChip />
        {/* The bundle is dropped only once the import commits. New project and Merge ask about
            unsaved work first (see bundleImport), and a declined confirm leaves this modal up so the
            choice can be made again rather than dumping the user back into the editor. A successful
            import reloads the page, so nothing here has to clean up after it. */}
        {pendingBundle && (
          <ImportBundleModal
            bundle={pendingBundle}
            onCancel={() => setPendingBundle(null)}
            onNewProject={() => { void applyImport(`Importing ${bundleName(pendingBundle)}`,
              [{ id: 'project', label: 'Creating project', weight: 1 }, ...IMPORT_WRITE_STEPS],
              'Switching to the imported project', () => applyBundleAsNewProject(pendingBundle, undefined, true)); }}
            onReplace={() => { void applyImport(`Importing ${bundleName(pendingBundle)}`, IMPORT_WRITE_STEPS,
              null, () => applyBundleReplace(pendingBundle)); }}
            onMerge={() => { void applyImport(`Merging ${bundleName(pendingBundle)}`, IMPORT_WRITE_STEPS,
              'Merging into this project', () => applyBundleMerge(pendingBundle, true)); }}
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
            <div className='absolute left-[5px] top-[29px] z-50 w-[240px] bg-surface-raised border border-control-hover rounded shadow-lg p-1 text-fg text-ui'>
              <MenuItem className='py-1.5' onClick={onPublishWeb}
                hint={desktop ? 'Write index.html + game.js + game.bin to a folder' : 'Download a .zip of the game'}>
                <span className='font-semibold'>Web (HTML)</span>
              </MenuItem>
              <MenuItem className='py-1.5' disabled={!desktop} onClick={() => onPublishDesktop(false)}
                hint={desktop ? 'Runnable Electron game folder' : 'Only available in the desktop app'}>
                <span className='font-semibold'>Desktop (Electron)</span>
              </MenuItem>
              {desktop && (
                <MenuItem className='py-1.5' onClick={() => onPublishDesktop(true)}
                  hint='Package a native installer (electron-builder)'>
                  <span className='font-semibold'>Desktop installer</span>
                </MenuItem>
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
            title='Play' disabled={playState === 'playing' || sessionKind === 'simulate'}
            active={playState === 'playing'} activeClass='bg-success hover:bg-success text-fg'
            accent='hover:text-success' onClick={() => onPlay()}
          >
            <PlayGlyph />
          </Transport>
          {/* Play without possession: physics, AI and scripts run on a throwaway copy, watched through the
              editor camera. Stop puts the scene back exactly as it was. */}
          <Transport
            title='Simulate — run physics, AI and scripts, viewed from the editor camera'
            disabled={playState === 'simulating' || sessionKind === 'play'}
            active={playState === 'simulating'} activeClass='bg-primary hover:bg-primary text-fg'
            accent='hover:text-primary' onClick={() => onSimulate()}
          >
            <SimulateGlyph />
          </Transport>
          <Transport
            title='Pause' disabled={playState === 'paused' || playState === 'stopped'}
            active={playState === 'paused'} activeClass='bg-selected hover:bg-selected text-fg'
            accent='hover:text-fg' onClick={() => onPause()}
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
