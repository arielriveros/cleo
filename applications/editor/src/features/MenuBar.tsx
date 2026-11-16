import { useEffect, useRef, useState } from "react";
import { Logger, isDefaultInputMap } from "cleo";
import { isDefaultProjectSettings, resolveSaveFolder } from "./options/projectSettings";
import { useCleoEngine, KIND_LABEL } from "./EngineContext";
import { useVfs } from "./assets/VfsContext";
import { buildMultiSceneGameData, PublishCanceledError } from "./publish/buildMultiSceneGameData";
import { publishWeb, publishDesktop, isDesktop } from "./publish/publishClient";
import WorkspaceStatusChip from "./scriptWorkspace/WorkspaceStatusChip";
import { AddonSlot } from "./addons/AddonHost";
import AddonsModal from "./addons/AddonsModal";
import { importBundleJob } from "../workers/workerClient";
import { exportBundle } from "../utils/bundleExport";
import { applyBundleReplace, applyBundleMerge, applyBundleAsNewProject, IMPORT_WRITE_STEPS } from "../utils/bundleImport";
import { beginLoad, useLoad, type LoadStepSpec } from "@cleo/app-kit/feedback/loadingStore";
import { confirmDiscard } from "./unloadGuard";
import type { BundleData } from "../utils/bundle";
import ImportBundleModal from "./dialogs/ImportBundleModal";
import { startTask } from "@cleo/app-kit/feedback/progressStore";
import Topbar from "@cleo/app-kit/ui/Topbar";
import ModeSelector from "./ModeSelector";
import { UndoGlyph, RedoGlyph } from "./UndoButtons";
import { useHistory } from "./HistoryContext";
import { AboutDialog, AppMenuBar, BookIcon, Button, LogoButton, MenuItem, ShortcutsDialog, WhatsThisIcon, cn, type MenuSpec } from "@cleo/app-kit/ui";
import { openDocumentation } from "@cleo/app-kit/docs/viewer/DocsViewerHost";
import { startWhatsThis } from "@cleo/app-kit/docs/whatsThis";
import {
  SaveIcon, ImportIcon, ExportIcon, PublishIcon, ChevronDownIcon,
  SpinnerIcon, CheckIcon, AlertIcon, LayoutIcon,
  PlayGlyph, SimulateGlyph, PauseGlyph, StopGlyph, RestartGlyph, PlayWindowIcon, PlayEditorIcon,
  FrameIcon, DeleteIcon, KeyboardIcon, InfoIcon, WebIcon, DesktopIcon, InstallerIcon, FeaturesIcon, AddonsIcon,
} from "./topbarIcons";
import ProjectFeaturesModal from "./projectFeatures/ProjectFeaturesModal";
import FeatureCheckModal from "./projectFeatures/FeatureCheckModal";
import type { FeatureUsage } from "./publish/featureUsage";
import { iconFor } from "./assets/assetKinds";
import { useFrameSelected } from "./viewport/useFrameSelected";
import { VERSION_LABEL } from "../version";
import { useWindowPlay, windowPlay } from "./playWindow/windowPlay";
import { scriptDebugger, useScriptDebugger } from "./scriptDebugger/debugSession";
import { releaseVsCode, useVsCodeDebug } from "./scriptDebugger/vscodeAttach";
import { scriptLocationLabel, scriptSourceUrl } from "cleo";
import { usePlayTarget, writePlayTarget } from "./playWindow/playTarget";
import { playBlockedReason } from "./playWindow/playGate";
import ProjectsModal from "./projects/ProjectsModal";
import { useProjectName } from "./projects/useProjectName";

// One playback control. Same shape as ModeSelector's Segment / the viewport's gizmo toggle — a 25px
// segment in a bordered, rounded group.
interface TransportProps {
  title: string;
  disabled: boolean;
  active?: boolean;
  accent: string;     // hover color when idle
  activeClass: string; // fill when this is the current state
  onClick: () => void;
  /**
   * One half of a pair drawn as a single segment, `[ Play ▾ ]`: no divider, fill or dimming of its own.
   * The pair's frame draws those for both halves, and the two still click apart.
   */
  paired?: boolean;
  /** Extra classes: a paired half's width and where its mark sits. */
  className?: string;
  children: React.ReactNode;
}
function Transport({ title, disabled, active, accent, activeClass, onClick, paired, className, children }: TransportProps) {
  return (
    <Button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'w-[30px] h-[25px] p-0 rounded-none border-0 border-r border-control-hover last:border-r-0 disabled:opacity-40',
        paired && 'bg-transparent border-r-0 disabled:opacity-100 disabled:hover:bg-transparent',
        active ? activeClass : cn('text-muted', accent),
        className,
      )}
    >
      {children}
    </Button>
  );
}

/** The editor's logo (public/brand, tools/brandIcons.mjs), on the menu bar's projects button. */
const LOGO = `${import.meta.env.BASE_URL}brand/logo.png`;

export default function MenuBar() {
  const { instance, editorScene, scripts, scriptAssets, startPlay, startSimulate, stopPlay, pausePlay, buildWindowPlayData, editorMode, saveActiveTab, saveAll, dirtyTabs, activeTab, savingState, eventEmitter: eventEmitter, sceneList, mainSceneId, openSceneId, materials, terrainMaterials, templates, models, animationFields, animations, rigs, tilesets, aiBrains, particleSystems, sequences, animControllers, boneMasks, poseAssets, audioSources, soundSamples, sceneDimension, inputMap, scriptPaths, projectSettings, setProjectSettings, createScene, selectedNode, isPlayMode, isSceneReady } = useCleoEngine();
  const history = useHistory();
  // View ▸ Frame Selected, and the F key (installed here, once).
  const { canFrame, frameSelected } = useFrameSelected(true);
  const importInput = useRef<HTMLInputElement>(null);
  const [helpDialog, setHelpDialog] = useState<'shortcuts' | 'about' | null>(null);
  // Project ▸ Features, and Publish's question when the game uses one the project leaves out.
  const [showFeatures, setShowFeatures] = useState(false);
  const [showAddons, setShowAddons] = useState(false);
  const [featureCheck, setFeatureCheck] = useState<{ uses: FeatureUsage; answer: (enable: string[] | null) => void } | null>(null);
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
  const projectName = useProjectName(showProjects);
  const [publishing, setPublishing] = useState<string | null>(null);
  const desktop = isDesktop();
  // Play in window: where Play runs (per machine), and the window session when there is one.
  const playTarget = usePlayTarget();
  const windowSession = useWindowPlay();
  const debugSession = useScriptDebugger();
  const vscodeDebug = useVsCodeDebug();
  const [showTargets, setShowTargets] = useState(false);
  const targetsRef = useRef<HTMLDivElement>(null);

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
  const libraries = () => ({ materials, terrainMaterials, templates, models, scripts: scriptAssets, animationFields, animations, rigs, tilesets, aiBrains, particleSystems, sequences, animControllers, boneMasks, poseAssets, audioSources, soundSamples,
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

  // Close the Play target menu when clicking outside it.
  useEffect(() => {
    if (!showTargets) return;
    const onDocClick = (e: MouseEvent) => {
      if (targetsRef.current && !targetsRef.current.contains(e.target as Node)) setShowTargets(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showTargets]);

  // Publish targets embed all assets: buildGameData with useCache=false so textures serialize to base64.
  // Split into two reported phases: serializing the scene (embedding every texture), then the build itself
  // (script obfuscation, asset packing, zipping), which runs in the project worker.
  const runPublish = async (
    title: string,
    ship: (data: any) => Promise<string>,
  ) => {
    setPublishing(title);
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
          liveScene: editorScene, liveScripts: scripts,
          // `rigs` is load-bearing: publish flattens each shipped animation's rig back into `sourceSkin`,
          // and without the table here every animation carrying only a `rigId` ships unretargetable.
          // Controllers, masks, poses and fields re-embed state machines in every scene that ships (see
          // `reembedMachine`); `poseAssets` also carries clip pose offsets into the published game.
          // `particleSystems` lets the resync refresh a CLOSED scene's embedded effects before it ships —
          // the game itself needs no library, the copies ride inside the scenes. `sequences` does the same for
          // a closed scene's cinematics.
          libs: { materials, models, templates, terrainMaterials, scripts: scriptAssets, tilesets, aiBrains, animations, rigs,
            animControllers, boneMasks, poseAssets, animationFields, particleSystems, sequences },
          scriptAssets,
          // Script modules: each script's project path, so the build ships what the scripts import.
          scriptPaths,
          liveDimension: sceneDimension,
          settings: renderSettings(),
          // Written once at the top level of the build, never inside a scene: bindings are project-wide.
          input: inputMap,
          // Engine runtime + window options (Options ▸ Engine / Project ▸ General), into `config`.
          projectSettings,
          // What this session drew, so the published game can build those pipelines up front. The more of
          // the game was played (Play or Simulate) before publishing, the more of them there are.
          pipelines: instance?.renderer.pipelineRecipes(),
          // The game uses a feature the project leaves out (Project ▸ Features): ask. Turning one back on is
          // for good, as if done in Project ▸ Features.
          onDisabledFeatureUse: uses => new Promise<string[] | null>(resolve => {
            setFeatureCheck({ uses, answer: enable => {
              setFeatureCheck(null);
              if (enable?.length) setProjectSettings(prev => ({ ...prev, features: { ...prev.features, disabled: prev.features.disabled.filter(id => !enable.includes(id)) } }));
              resolve(enable);
            } });
          }),
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
      if (e instanceof PublishCanceledError) Logger.info('Publish canceled', 'Publish');
      else Logger.error(`Publish failed: ${e?.message || e}`, 'Publish');
    } finally {
      task.finish();
      setPublishing(null);
    }
  };

  // The game's name: Options ▸ Project ▸ Published game ▸ Title, else the project name. A native publish
  // saves into a folder of this name; the browser download is a slug of it.
  const gameName = projectSettings.publish.title.trim() || projectName.trim();
  const onPublishWeb = () => runPublish('Publishing web build',
    data => publishWeb(data, gameName || undefined));

  const onPublishDesktop = (installer: boolean) =>
    runPublish(installer ? 'Publishing desktop installer' : 'Publishing desktop build',
      data => publishDesktop(data, {
        installer, name: gameName || undefined, window: projectSettings.publish,
        savesFolder: resolveSaveFolder(projectSettings, projectName),
      }));

  // Play in window. The window opens inside this click (a web popup needs its user activation) and the
  // build follows; pressed while a window game runs, Play resumes it or brings its window forward.
  const windowActive = windowSession.active;
  const windowSize = () => ({
    width: projectSettings.publish.width, height: projectSettings.publish.height,
    title: projectSettings.publish.title.trim() || projectName.trim() || 'Cleo Game',
  });
  // Stopped in the script debugger (a breakpoint, an exception): Play continues it.
  const debugStopped = windowActive && debugSession.phase === 'paused';
  const debugFrame = debugSession.paused?.frames[debugSession.selectedFrame];
  // Or stopped in VS Code's (Debug scripts with ▸ VS Code): Play lets it go, as VS Code's Continue does.
  const vscodeStopped = windowActive && !!windowSession.sessionId && vscodeDebug.stopped.includes(windowSession.sessionId);
  // Until the project (or a scene, an import) has opened, the editor's scene is not the project's yet: a new
  // game would play the empty boot scene. Only STARTING one waits (playGate.ts); a running game is never held.
  const load = useLoad();
  const openingReason = playBlockedReason({ sceneReady: isSceneReady, openSceneId, load });
  const startBlocked = !!openingReason && !windowActive && playState === 'stopped';
  const onPlay = () => {
    if (debugStopped) { scriptDebugger().resume(); return; }
    if (vscodeStopped && windowSession.sessionId) { void releaseVsCode(windowSession.sessionId); return; }
    if (startBlocked) return;
    if (windowActive) {
      if (windowSession.status === 'paused') windowPlay().resume();
      else windowPlay().start(buildWindowPlayData, windowSize());
      return;
    }
    // A session in the editor (a paused one resumes through here) keeps the editor's Play, whatever the target.
    if (playTarget === 'window' && playState === 'stopped') windowPlay().start(buildWindowPlayData, windowSize());
    else startPlay();
  };

  const onSimulate = () => { if (!startBlocked) startSimulate(); };

  const onStop = () => { if (windowActive || windowSession.status === 'failed') windowPlay().stop(); else stopPlay(); };

  const onPause = () => { if (windowActive) windowPlay().pause(); else pausePlay(); };

  const onRestart = () => { if (!openingReason) windowPlay().restart(buildWindowPlayData); };

  const inEditorSession = playState !== 'stopped';
  // Play's own state, which its segment (Play and the target chevron) draws for both halves.
  const playLit = windowActive ? windowSession.status === 'running' : playState === 'playing';
  const playDisabled = startBlocked || (windowActive ? false : (playState === 'playing' || sessionKind === 'simulate'));
  const targetDisabled = windowActive || inEditorSession;
  const windowBusy = windowSession.status === 'building' || windowSession.status === 'starting' || windowSession.rebuilding;
  const windowLabel =
    vscodeStopped ? 'Stopped in VS Code'
    : debugStopped ? `Stopped · ${debugFrame?.moduleId ? scriptLocationLabel({ url: scriptSourceUrl(debugFrame.moduleId), line: debugFrame.line }) : 'engine code'}`
    : windowSession.rebuilding ? 'Rebuilding…'
    : windowSession.status === 'building' ? 'Building…'
    : windowSession.status === 'starting' ? 'Starting…'
    : windowSession.status === 'paused' ? `Paused${windowSession.scene ? ` · ${windowSession.scene}` : ''}`
    : windowSession.status === 'running' ? `In window${windowSession.scene ? ` · ${windowSession.scene}` : ''}`
    : windowSession.status === 'failed' ? 'Failed'
    : '';

  // What the old Save / Publish buttons said on their face, now that they live in the menus: the last
  // save's outcome and a publish under way. Status only; the menus hold the commands.
  const status = publishing ? { icon: <SpinnerIcon />, text: `${publishing}…`, tone: 'text-muted' }
    : savingState === 'saving' ? { icon: <SpinnerIcon />, text: 'Saving…', tone: 'text-muted' }
    : savingState === 'saved' ? { icon: <CheckIcon />, text: 'Saved', tone: 'text-success-fg' }
    : savingState === 'error' ? { icon: <AlertIcon />, text: 'Save failed', tone: 'text-danger-fg' }
    : null;

  const stopped = playState === 'stopped';
  const menus: MenuSpec[] = [
    {
      id: 'file', label: 'File', items: [
        { kind: 'item', label: 'Save', icon: <SaveIcon />, shortcut: 'Ctrl+S', title: saveTitle,
          disabled: saving || !activeDirty, onSelect: () => void saveActiveTab() },
        { kind: 'item', label: `Save All${dirtyCount > 0 ? ` (${dirtyCount})` : ''}`, icon: <SaveIcon />, shortcut: 'Ctrl+Shift+S',
          title: 'Save every asset with unsaved changes', disabled: saving || dirtyCount === 0, onSelect: () => void saveAll() },
        { kind: 'separator' },
        { kind: 'item', label: 'New Scene', icon: <img src={iconFor('scene')} className='h-3.5 w-3.5' alt='' draggable={false} />,
          title: 'Create a new scene asset', disabled: !stopped, onSelect: () => void createScene() },
      ],
    },
    {
      id: 'edit', label: 'Edit', items: [
        { kind: 'item', label: history.canUndo && history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo', icon: <UndoGlyph />,
          shortcut: 'Ctrl+Z', disabled: !history.canUndo || isPlayMode, onSelect: history.undo },
        { kind: 'item', label: history.canRedo && history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo', icon: <RedoGlyph />,
          shortcut: 'Ctrl+Shift+Z', disabled: !history.canRedo || isPlayMode, onSelect: history.redo },
        { kind: 'separator' },
        { kind: 'item', label: 'Delete', icon: <DeleteIcon />, shortcut: 'Del', title: 'Delete the selected node',
          disabled: !selectedNode || isPlayMode, onSelect: () => eventEmitter.emit('DELETE_SELECTED') },
      ],
    },
    {
      id: 'view', label: 'View', items: [
        { kind: 'item', label: 'Frame Selected', icon: <FrameIcon />, shortcut: 'F',
          title: 'Bring the selected node to the middle of the view being edited, keeping the camera\'s direction',
          disabled: !canFrame, onSelect: frameSelected },
        { kind: 'separator' },
        { kind: 'item', label: 'Reset Layout', icon: <LayoutIcon />, title: 'Restore the default panel layout',
          disabled: !stopped, onSelect: () => eventEmitter.emit('RESET_DOCK_LAYOUT') },
      ],
    },
    {
      id: 'project', label: 'Project', items: [
        { kind: 'item', label: 'Import Project…', icon: <ImportIcon />, title: 'Import a project .zip: a new project, or replace or merge this one',
          disabled: libEdit, onSelect: () => importInput.current?.click() },
        { kind: 'item', label: 'Export Project', icon: <ExportIcon />, title: 'Export the whole project (scenes, assets, textures) to a .zip',
          disabled: libEdit, onSelect: () => void onExport() },
        { kind: 'separator' },
        { kind: 'item', label: 'Features…', icon: <FeaturesIcon />, title: "Choose the engine features this project's games ship with: presets for 2D, 3D and more",
          disabled: !stopped, onSelect: () => setShowFeatures(true) },
        { kind: 'item', label: 'Addons…', icon: <AddonsIcon />, title: 'Turn editor addons on or off for this project, such as the Claude Code panel',
          disabled: !stopped, onSelect: () => setShowAddons(true) },
        { kind: 'separator' },
        { kind: 'submenu', label: 'Publish', icon: <PublishIcon />, title: 'Publish an optimized build of your game',
          disabled: !!publishing || libEdit, items: [
            { kind: 'item', label: 'Web (HTML)', icon: <WebIcon />,
              title: desktop ? 'Write index.html + game.js + game.bin to a folder' : 'Download a .zip of the game',
              onSelect: () => void onPublishWeb() },
            { kind: 'item', label: 'Desktop (Electron)', icon: <DesktopIcon />, disabled: !desktop,
              title: desktop ? 'Runnable Electron game folder' : 'Only available in the desktop app',
              onSelect: () => void onPublishDesktop(false) },
            ...(desktop ? [{ kind: 'item' as const, label: 'Desktop installer', icon: <InstallerIcon />,
              title: 'Package a native installer (electron-builder)', onSelect: () => void onPublishDesktop(true) }] : []),
          ] },
      ],
    },
    {
      id: 'help', label: 'Help', items: [
        { kind: 'item', label: 'Documentation', icon: <span className='inline-block w-3.5 h-3.5'><BookIcon /></span>, shortcut: 'F1',
          onSelect: openDocumentation },
        { kind: 'item', label: "What's This?", icon: <span className='inline-block w-3.5 h-3.5'><WhatsThisIcon /></span>, shortcut: 'Shift+F1',
          onSelect: startWhatsThis },
        { kind: 'separator' },
        { kind: 'item', label: 'Keyboard Shortcuts…', icon: <KeyboardIcon />, onSelect: () => setHelpDialog('shortcuts') },
        { kind: 'item', label: 'About Cleo Engine…', icon: <InfoIcon />, onSelect: () => setHelpDialog('about') },
      ],
    },
  ];

  return (
    <Topbar>
      <div className='flex items-center gap-1 h-full px-1.5 min-w-0'>
        {/* The projects: switch, create or delete them. Never gated by the active tab: which project you
            are in is not an editing mode. */}
        <LogoButton src={LOGO} title={`Projects${projectName ? ` (${projectName})` : ''}: switch, create or delete projects`}
                    onClick={() => setShowProjects(true)} />
        {showProjects && <ProjectsModal onClose={() => setShowProjects(false)} />}
        <AppMenuBar menus={menus} />
        {/* Read by Project ▸ Import Project…: a file picker needs an input to open. */}
        <input ref={importInput} className="hidden" type='file' accept='.zip' id='load-project-file' name='file' onChange={(e) => { onImport(e.target.files); e.currentTarget.value = ''; }} />
        {status && (
          <span className={cn('flex items-center gap-1 px-1.5 text-ui-xs whitespace-nowrap', status.tone)} role='status'>
            {status.icon}{status.text}
          </span>
        )}
        {/* The script workspace appears here only when it needs attention (paused sync, error, conflict);
            setting it up and its everyday status live in Options ▸ Editor ▸ Scripts. */}
        <WorkspaceStatusChip />
        {/* The addons' status chips: the Claude Code addon's agent link, shown while its panel is open and started. */}
        <AddonSlot name="topbarChips" />
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
        {showFeatures && <ProjectFeaturesModal onClose={() => setShowFeatures(false)} />}
        {showAddons && <AddonsModal onClose={() => setShowAddons(false)} />}
        {featureCheck && <FeatureCheckModal uses={featureCheck.uses} onAnswer={featureCheck.answer} />}
        {helpDialog === 'shortcuts' && (
          <ShortcutsDialog page='editor/interface' anchor='keyboard-shortcuts' onClose={() => setHelpDialog(null)} />
        )}
        {helpDialog === 'about' && (
          <AboutDialog appName='Cleo Engine' version={VERSION_LABEL} logo={LOGO}
                       lines={['The Cleo editor, with Cleo Creator.']} onClose={() => setHelpDialog(null)} />
        )}
      </div>
      <div className='relative flex items-center h-full gap-1.5' ref={targetsRef}>
        <div className='flex items-center rounded overflow-hidden border border-control-hover my-[2px]'>
          {/* Never gated by the active tab. Play runs the game scene from anywhere: startPlay switches to
              the scene tab itself, and Stop returns to the tab you pressed it from. Play in window builds
              from the scene tab's scene whichever tab is in front, and never leaves it. */}
          {/* Play and where it runs share one segment, [ Play ▾ | … ]: the chevron sits against the play
              mark, with no divider. They are still two buttons, so the mark plays and the chevron opens the
              menu. The frame carries Play's fill and dimming for both, so a running game lights the whole
              segment; a chevron that is fixed while Play is not dims only its own mark. */}
          <div className={cn('flex border-r border-control-hover', playLit ? 'bg-success' : 'bg-control', playDisabled && 'opacity-40')}>
            <Transport
              paired className='w-[22px] justify-end'
              title={startBlocked ? openingReason!
                : debugStopped ? 'Continue — the game is stopped in the script debugger (F8)'
                : vscodeStopped ? 'Continue — the game is stopped in VS Code'
                : windowActive
                ? (windowSession.status === 'paused' ? 'Resume the game in its window' : 'Bring the game window forward')
                : playTarget === 'window' && playState === 'stopped' ? 'Play in window — the game runs in a window and a process of its own' : 'Play'}
              disabled={playDisabled}
              active={playLit}
              activeClass='bg-success hover:bg-success text-fg'
              accent='hover:text-success' onClick={() => onPlay()}
            >
              {windowActive || (playTarget === 'window' && playState === 'stopped') ? <PlayWindowIcon /> : <PlayGlyph />}
            </Transport>
            {/* Where Play runs. Fixed while a game runs, either way. */}
            <Transport
              paired className={cn('w-[14px] justify-end [&>svg]:-ml-[2px]', !playDisabled && 'disabled:text-dim')}
              title='Where Play runs: in the editor, or in a window of its own'
              disabled={targetDisabled}
              active={showTargets} activeClass='bg-control-hover text-fg'
              accent='hover:text-fg' onClick={() => setShowTargets(v => !v)}
            >
              <ChevronDownIcon />
            </Transport>
          </div>
          {/* Play without possession: physics, AI and scripts run on a throwaway copy, watched through the
              editor camera. Stop puts the scene back exactly as it was. */}
          <Transport
            title={startBlocked ? openingReason! : 'Simulate — run physics, AI and scripts, viewed from the editor camera'}
            disabled={startBlocked || windowActive || playState === 'simulating' || sessionKind === 'play'}
            active={playState === 'simulating'} activeClass='bg-primary hover:bg-primary text-fg'
            accent='hover:text-primary' onClick={() => onSimulate()}
          >
            <SimulateGlyph />
          </Transport>
          <Transport
            title='Pause'
            disabled={windowActive ? (windowSession.status !== 'running' || debugStopped || vscodeStopped) : (playState === 'paused' || playState === 'stopped')}
            active={windowActive ? windowSession.status === 'paused' : playState === 'paused'}
            activeClass='bg-selected hover:bg-selected text-fg'
            accent='hover:text-fg' onClick={() => onPause()}
          >
            <PauseGlyph />
          </Transport>
          <Transport
            title={windowActive ? 'Stop — close the game window' : 'Stop'}
            disabled={!windowActive && windowSession.status !== 'failed' && playState === 'stopped'}
            active={false} activeClass=''
            accent='hover:text-danger' onClick={() => onStop()}
          >
            <StopGlyph />
          </Transport>
          {/* Play in window only: rebuild from what the editor holds now, and reload the window. The game
              that is running keeps going until the new one is ready. */}
          {windowActive && (
            <Transport
              title={openingReason ?? 'Restart — rebuild the game from the editor and reload its window'}
              disabled={windowBusy || !!openingReason}
              active={false} activeClass=''
              accent='hover:text-success' onClick={() => onRestart()}
            >
              <RestartGlyph />
            </Transport>
          )}
        </div>
        {windowLabel && (
          <button
            type='button'
            className={cn('h-[25px] max-w-[220px] truncate rounded px-1.5 text-ui-xs flex items-center gap-1',
              windowSession.status === 'failed' ? 'text-danger-fg hover:bg-control'
                : debugStopped || vscodeStopped ? 'text-warning hover:bg-control'
                : 'text-muted hover:text-fg hover:bg-control')}
            title={windowSession.status === 'failed'
              ? `${windowSession.error ?? 'The game window failed.'} Click to dismiss.`
              : debugStopped ? 'The game is stopped in the script debugger. Click to show the line.'
              : vscodeStopped ? 'The game is stopped at a breakpoint in VS Code. Continue it there, or with Play.'
              : 'The game is running in its own window. Click to bring it forward.'}
            onClick={() => {
              if (windowSession.status === 'failed') windowPlay().stop();
              else if (debugStopped) scriptDebugger().selectFrame(debugSession.selectedFrame);
              else windowPlay().start(buildWindowPlayData, windowSize());
            }}
          >
            {windowBusy && <SpinnerIcon />}
            <span className='truncate'>{windowLabel}</span>
          </button>
        )}
        {showTargets && (
          <div className='absolute left-0 top-[29px] z-50 w-[260px] bg-surface-raised border border-control-hover rounded shadow-lg p-1 text-fg text-ui'>
            <MenuItem className='py-1.5' icon={<PlayEditorIcon />} active={playTarget === 'editor'}
              onClick={() => { writePlayTarget('editor'); setShowTargets(false); }}
              hint='In the viewport. The editor locks until you press Stop.'>
              <span className='font-semibold'>Play in editor</span>
            </MenuItem>
            <MenuItem className='py-1.5' icon={<PlayWindowIcon />} active={playTarget === 'window'}
              onClick={() => { writePlayTarget('window'); setShowTargets(false); }}
              hint={desktop
                ? 'A window and a process of its own, built as Publish builds it. Keep editing; Restart picks it up.'
                : 'A pop-up window of its own, built as Publish builds it. Keep editing; Restart picks it up.'}>
              <span className='font-semibold'>Play in window</span>
            </MenuItem>
          </div>
        )}
      </div>
      <ModeSelector />
      <div className='flex items-center h-full px-1.5 gap-1.5'>
        {/* The addons' toggles: the Claude Code addon's opens its panel, docked at the right edge. */}
        <AddonSlot name="topbarRight" />
      </div>
    </Topbar>
  )
}
