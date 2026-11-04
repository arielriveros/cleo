import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { FluidVolumeNode } from 'cleo';
import { Toggle } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { useCreatorEngine } from '../../app/CreatorEngine';
import { CreatorWorkspace, PanelBody, PanelHeader, SchemaSections, ViewportOverlay } from '../../app/workspace';
import { sectionPresets } from './sectionPresets';
import { downloadAll } from '../../core/download';
import { useGeneration } from '../../core/useGeneration';
import { AssetBar, useCreatorAsset } from '../../core/useCreatorAsset';
import { useStageCapture } from '../../core/stageCapture';
import { fluidDims } from '../fluidCpu';
import { gpuBackend } from '../fluidGpu';
import { DEFAULT_FX, FX_PRESETS, normaliseFx, particleCount, schemaGroupsFor, tileDims, voxelSizeRaised, type FxParams } from '../fxParams';
import { cpuBackend, exportFx, generateFx, type FxOutput } from '../generateFx';
import { LiveFx, type LiveStats } from '../liveSim';
import { LiveLiquid } from '../liveLiquid';
import { legacySunDirection, loadScene, saveScene, type FxScene } from '../fxScene';
import { EFFECT_SECTION_PRESETS, effectPresetLabel, effectPresetParams, type SectionPreset } from '../fxPresets';
import { frameAt, frameBox, hideFxVolume, installOrbitCamera, showFxVolume } from './fxPreview';
import { emitterPose, FxGizmos, type FxSelection } from './FxGizmos';
import type { GizmoMode, GizmoSpace } from '@cleo/app-kit/gizmo/types';
import { GizmoModeControls } from '@cleo/app-kit/gizmo/GizmoModeControls';
import { FxStage } from './fxStage';
import { FxStageSections, ScenePanel } from './ScenePanel';
import { BakePanel } from './BakePanel';

// FX Creator: fire and smoke simulated on a voxel grid, shown live in the 3D viewport as an engine
// FluidVolumeNode -- every parameter change reaches the next simulation step, so there is nothing to
// press to see it. The viewport's playback bar plays, pauses, restarts and speeds it. The Bake tab (beside
// Parameters) runs the deterministic offline simulation from t = 0 (warm-up, capture, loop blend) and
// packs the tileset -- and any extra outputs -- the toolbar's Export writes. The viewport's Stage menu
// lights the stage (sun, sky, wind, fire light) and the Scene panel places what is in it (the region,
// bodies); none of it reaches a bake. The Creator's shared layout: app/workspace.tsx.

const STORAGE_KEY = 'cleo_creator_fx_params_v1';
/** The presets a switch of medium starts from. */
const LIQUID_START = 'blood-splash';
const GAS_START = 'campfire';
/** The effect preset picked last: what Reset returns to. */
const PRESET_KEY = 'cleo_creator_fx_preset_v1';
/** A grid or seed change restarts the simulation, so it waits for the slider to settle. */
const RESTART_DEBOUNCE_MS = 300;
/** A saved asset re-bakes once its parameters have been still this long. */
const AUTO_BAKE_IDLE_MS = 1500;
const SAVE_DEBOUNCE_MS = 250;

interface FxState {
  params: FxParams;
  setParams: (p: FxParams) => void;
  output: FxOutput | null;
  /** Frames captured so far in the running bake, for the flipbook panel. */
  liveFrames: Uint8Array[];
  tile: number;
  /** The live preview's latest numbers; read by the panels that show them, not rendered from state. */
  stats: React.MutableRefObject<LiveStats | null>;
  live: React.MutableRefObject<LiveFx | LiveLiquid | null>;
  scene: FxScene;
  setScene: (s: FxScene) => void;
  selection: FxSelection;
  select: (s: FxSelection) => void;
  bakeRunning: boolean;
  onBake: () => void;
  /** The effect preset picked last, or null for the defaults. */
  presetId: string | null;
  setPresetId: (id: string | null) => void;
  /** Stand a new preset's region at the middle of the stage and aim the camera at it. */
  recentre: (p: FxParams) => void;
}

const FxContext = createContext<FxState | null>(null);
const useFx = () => useContext(FxContext)!;

function loadParams(): FxParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Normalised on the way in: a save from before the region box becomes the region it described.
    // A stage sun that used to point its own way becomes the effect's light (the sun is now the one light).
    if (raw) return normaliseFx({ ...DEFAULT_FX, ...JSON.parse(raw), ...(legacySunDirection() ?? {}) });
  } catch { /* fall through */ }
  return DEFAULT_FX;
}

/** The parameters that start the live simulation over when they change. */
const restartKey = (p: FxParams) => {
  const d = fluidDims(normaliseFx(p));
  return `${d.nx}x${d.ny}x${d.nz}:${p.seed}`;
};

export function FxWorkspace() {
  const { hasCompute, instance, scene, camera, sun, bus } = useCreatorEngine();
  const [selection, setSelection] = useState<FxSelection>(null);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('position');
  const [gizmoSpace, setGizmoSpace] = useState<GizmoSpace>('world');
  const viewportRef = useRef<HTMLDivElement>(null);
  const [params, setParamsState] = useState<FxParams>(loadParams);
  const [presetId, setPresetIdState] = useState<string | null>(() => { try { return localStorage.getItem(PRESET_KEY); } catch { return null; } });
  const setPresetId = (id: string | null) => {
    setPresetIdState(id);
    try { if (id) localStorage.setItem(PRESET_KEY, id); else localStorage.removeItem(PRESET_KEY); } catch { /* quota */ }
  };
  const [stageScene, setStageScene] = useState<FxScene>(loadScene);
  const stage = useRef<FxStage | null>(null);
  /** Bumped each time the stage is built, so the gizmos place their markers on the new one. */
  const [stageVersion, setStageVersion] = useState(0);
  const stageRef = useRef(stageScene);
  stageRef.current = stageScene;
  const [output, setOutput] = useState<FxOutput | null>(null);
  const [liveFrames, setLiveFrames] = useState<Uint8Array[]>([]);
  const [useGpu, setUseGpu] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const bake = useGeneration();
  const gpu = hasCompute && useGpu;

  const live = useRef<LiveFx | LiveLiquid | null>(null);
  const stats = useRef<LiveStats | null>(null);
  const node = useRef<FluidVolumeNode | null>(null);
  const orbit = useRef<ReturnType<typeof installOrbitCamera> | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const setParams = (p: FxParams) => setParamsState(p);

  // Saving is debounced: a slider drag writes once it pauses, not on every value it passes through.
  useEffect(() => {
    const t = setTimeout(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(params)); } catch { /* quota */ } }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [params]);
  useEffect(() => {
    const t = setTimeout(() => saveScene(stageScene), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [stageScene]);

  // The stage: the volume node, the orbit camera, and the live simulation feeding the node. Rebuilt only
  // when the solver changes (GPU / CPU, or gas / liquid); parameters flow in below without tearing
  // anything down.
  const liquid = params.medium === 'liquid';
  useEffect(() => {
    if (!scene || !camera) return;
    const volume = showFxVolume(scene);
    node.current = volume;
    volume.shading = liquid ? 'liquid' : 'gas';
    const sim = liquid ? new LiveLiquid(volume, paramsRef.current, gpu) : new LiveFx(volume, gpu, paramsRef.current);
    sim.onStats = s => { stats.current = s; };
    sim.playing = playing;
    sim.speed = speed;
    sim.setScene(stageRef.current);
    live.current = sim;
    volume.onUpdate = (dt: number) => {
      sim.tick(dt);
      stage.current?.updateFire(sim.fireLight, paramsRef.current);
      stage.current?.updateShadow(sim.shadowTexture, sim.shadowPlacement());
      stage.current?.updateFloorDecal(sim instanceof LiveLiquid ? sim.floorDecal() : null);
    };
    orbit.current ??= installOrbitCamera(camera, frameBox(volume.size, 20, stageRef.current.regionOffset ?? [0, 0, 0]));
    return () => {
      sim.dispose();
      volume.onUpdate = () => { /* the simulation is gone; the volume holds its last frame */ };
      stage.current?.updateFloorDecal(null);
      live.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, camera, gpu, liquid]);
  // The stage's own nodes (sun settings, sky, ground, wind, fire light, bodies), for as long as the
  // workspace is open.
  useEffect(() => {
    if (!instance || !scene) return;
    stage.current = new FxStage(instance, scene, sun);
    stage.current.apply(stageRef.current, paramsRef.current);
    setStageVersion(v => v + 1);
    return () => { stage.current?.dispose(); stage.current = null; };
  }, [instance, scene, sun]);
  useEffect(() => {
    stage.current?.apply(stageScene, params);
    live.current?.setScene(stageScene);
  }, [stageScene, params.lightYaw, params.lightElevation, params.fireColorMode]);

  useEffect(() => () => {
    orbit.current?.restore();
    orbit.current = null;
    if (scene) hideFxVolume(scene, node.current);
    node.current = null;
  }, [scene]);

  // Parameters into the running simulation. A grid or seed change restarts it, debounced; anything else
  // applies on the very next step.
  const appliedKey = useRef(restartKey(params));
  useEffect(() => {
    const key = restartKey(params);
    if (key === appliedKey.current) { live.current?.setParams(params); return; }
    const t = setTimeout(() => {
      appliedKey.current = key;
      live.current?.setParams(params);
    }, RESTART_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [params]);

  // A body that was removed takes its selection with it.
  useEffect(() => {
    if (selection?.kind === 'body' && !stageScene.bodies.some(b => b.id === selection.id)) setSelection(null);
  }, [stageScene, selection]);

  /** Aim the orbit at the selection (a body, the emitter, the region), or the whole region. */
  const frameSelection = () => {
    const o = orbit.current;
    if (!o) return;
    const n = normaliseFx(params);
    const off = stageScene.regionOffset ?? [0, 0, 0];
    if (selection?.kind === 'body') {
      const b = stageScene.bodies.find(x => x.id === selection.id);
      if (b) { o.frame(frameAt(o.current(), b.position, Math.max(...b.size) * 3)); return; }
    }
    if (selection?.kind === 'emitter') {
      const e = emitterPose(params, off);
      o.frame(frameAt(o.current(), e.position, Math.max(e.radius * 8, Math.max(...n.regionSize) * 0.6)));
      return;
    }
    o.frame(frameBox(n.regionSize, o.current().yaw, off));
  };

  // W / E / R pick the gizmo, X flips local/world, Delete removes a selected body, Escape clears the
  // selection -- as in the editor. F (frame) is the workspace's own.
  /** A preset's effect starts at the middle of the scene, whatever the last one was dragged to; the camera follows. */
  const recentre = (p: FxParams) => {
    const centred = [0, 0, 0] as [number, number, number];
    setStageScene(s => ({ ...s, regionOffset: centred }));
    const o = orbit.current;
    if (o) o.frame(frameBox(normaliseFx(p).regionSize, o.current().yaw, centred));
  };

  const removeSelectedBody = () => {
    if (selection?.kind !== 'body') return;
    setStageScene({ ...stageScene, bodies: stageScene.bodies.filter(b => b.id !== selection.id) });
    setSelection(null);
  };
  const hotkeys = {
    ' ': () => setPlaying(p => !p),
    w: () => setGizmoMode('position'), e: () => setGizmoMode('rotation'), r: () => setGizmoMode('scale'),
    x: () => setGizmoSpace(sp => (sp === 'world' ? 'local' : 'world')),
    escape: () => setSelection(null), delete: removeSelectedBody, backspace: removeSelectedBody,
  };

  useEffect(() => { if (live.current) live.current.playing = playing; }, [playing]);
  useEffect(() => { if (live.current) live.current.speed = speed; }, [speed]);

  // A gizmo drag holds the simulation's restarts (a liquid's source or a region resized) and its node
  // placement until the drag ends: one restart on release instead of one per mouse move.
  useEffect(() => {
    const start = () => live.current?.setDragging(true);
    const end = () => live.current?.setDragging(false);
    bus.on('GIZMO_DRAG_START', start);
    bus.on('GIZMO_DRAG_END', end);
    return () => { bus.off('GIZMO_DRAG_START', start); bus.off('GIZMO_DRAG_END', end); };
  }, [bus]);

  // --- The saved asset: every bake of it goes to the Creator library, which the editor follows. A saved
  // asset re-bakes on its own once edits pause (Auto-bake), so the editor's flipbook keeps up. ---
  const capture = useStageCapture();
  const asset = useCreatorAsset<FxParams>('fx', params, p => setParams(normaliseFx(p)), undefined, capture);
  /** The parameters the shown bake was made from. */
  const outputFrom = useRef<FxParams | null>(null);
  const [autoBake, setAutoBake] = useState(true);
  const publishBake = async (out: FxOutput, from: FxParams) => {
    if (asset.active) asset.publish({ from, files: await exportFx(out, from) });
  };

  const bakeFlipbook = async (quiet = false) => {
    const frames: Uint8Array[] = [];
    setLiveFrames([]);
    const from = params;
    // Its own solver instance, from t = 0: the live preview keeps running beside it.
    const out = await bake.run(ctx => generateFx(from, ctx, {
      backend: gpu ? gpuBackend : cpuBackend,
      onFrame: (_, tile) => { frames.push(tile); setLiveFrames([...frames]); },
    }));
    if (out) {
      setOutput(out);
      outputFrom.current = from;
      void publishBake(out, from);
      if (!quiet) toast.success(`Baked ${out.frames.length} frames from ${out.dims.nx}x${out.dims.ny}x${out.dims.nz} voxels on the ${out.backend.toUpperCase()}.`);
    }
  };
  // Saving (or opening) an asset publishes the bake on screen when it is of these parameters.
  useEffect(() => {
    if (output && outputFrom.current === params) void publishBake(output, params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.active?.id]);
  useEffect(() => {
    if (!asset.active || !autoBake || outputFrom.current === params) return;
    const t = setTimeout(() => { void bakeFlipbook(true); }, AUTO_BAKE_IDLE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, asset.active?.id, autoBake]);

  const exportFiles = async () => {
    if (!output) return;
    await downloadAll(await exportFx(output, params));
  };

  const norm = normaliseFx(params);
  const dims = fluidDims(norm);
  // A gas: its grid, flagged when the region outgrew the voxel budget and the voxels were coarsened (its
  // voxel-unit settings then mean bigger features). A liquid: its drops, whose size is its definition.
  const raised = norm.medium === 'gas' && voxelSizeRaised(params);
  const status = norm.medium === 'liquid'
    ? <span title='The liquid: its drops, and the size each stands for. The floor stain and the surface are drawn at this size, whatever the region.'>
        {particleCount(norm).toLocaleString()} drops · {(norm.dropletSize * 1000).toFixed(1)} mm
      </span>
    : <span className={raised ? 'text-warning' : undefined}
            title={raised ? `The region needs more voxels than the budget at the voxel size set: they were coarsened to ${(norm.voxelSize * 100).toFixed(2)} cm, so the effect's voxel-sized detail grows. Shrink the region or raise the voxel size.` : 'The grid: the region divided by the voxel size'}>
        {dims.nx}×{dims.ny}×{dims.nz} = {((dims.nx * dims.ny * dims.nz) / 1e6).toFixed(2)} M voxels
      </span>;
  const viewport = (<>
    <ViewportOverlay
      readout={<LiveReadout />}
      // The Foliage Creator's Stage menu: what the preview shows, the sun, then the light, the wind and
      // (a gas) the fire light.
      stage={{
        toggles: [
          { key: 'grid', label: 'Grid', checked: stageScene.grid },
          { key: 'groundPlane', label: 'Floor', checked: stageScene.groundPlane },
          { key: 'sky', label: 'Sky', checked: stageScene.sky },
          { key: 'wind', label: 'Wind', checked: stageScene.wind },
          // A liquid casts none: its mark on the floor is its film.
          ...(liquid ? [] : [{ key: 'effectShadow', label: 'Ground shadow', checked: stageScene.effectShadow }]),
          // The region wireframe, the emitter marker and the bodies: everything the stage draws that the
          // effect does not.
          { key: 'showHelpers', label: 'Helpers', checked: stageScene.showHelpers },
        ].map(item => ({ ...item, onChange: (v: boolean) => setStageScene(s => ({ ...s, [item.key]: v })) })),
        sun: { yaw: params.lightYaw, elevation: params.lightElevation,
               onChange: (yaw, elevation) => setParams({ ...params, lightYaw: yaw, lightElevation: elevation }) },
        extra: <FxStageSections scene={stageScene} setScene={setStageScene} params={params} setParams={setParams} />,
      }}
      controls={<GizmoModeControls mode={gizmoMode} space={gizmoSpace} onMode={setGizmoMode} onSpace={setGizmoSpace} />}
      onFrame={frameSelection} frameTitle='Frame the selection (F)'
      playback={{
        playing, onPlayPause: () => setPlaying(p => !p), onRestart: () => live.current?.restart(), speed, onSpeed: setSpeed,
        clock: () => (live.current ? { time: live.current.time, cycle: live.current.cycleTime } : null),
      }} />
    <FxGizmos instance={instance} scene={scene} bus={bus} stage={stage} volume={node} viewportRef={viewportRef}
              params={params} setParams={setParams} fxScene={stageScene} setFxScene={setStageScene}
              selection={selection} select={setSelection} mode={gizmoMode} space={gizmoSpace} stageVersion={stageVersion} />
  </>);
  const value = useMemo(() => ({
    params, setParams, output, liveFrames, tile: tileDims(normaliseFx(params)).width, stats, live, scene: stageScene, setScene: setStageScene,
    selection, select: setSelection, bakeRunning: bake.status.running, onBake: () => void bakeFlipbook(), presetId, setPresetId, recentre,
  }), [params, output, liveFrames, stageScene, selection, bake.status.running, gpu, presetId, asset.active?.id]);

  return (
    <FxContext.Provider value={value}>
      <CreatorWorkspace
        id='fx' page='creator/fx'
        toolbar={<>
          <label className='flex items-center gap-1 text-muted'>
            <Toggle checked={gpu} onChange={setUseGpu} /> GPU solver {hasCompute ? '' : '(unavailable)'}
          </label>
        </>}
        asset={<div className='flex items-center gap-2'>
          <AssetBar state={asset} />
          {asset.active && (
            <label className='flex items-center gap-1 text-muted' title='Re-bake the saved asset when edits pause, so the editor follows. Off: bake by hand in the Bake tab.'>
              <Toggle checked={autoBake} onChange={setAutoBake} /> Auto-bake
            </label>
          )}
        </div>}
        toolbarStatus={status}
        primaryAction={{ label: 'Export flipbook', disabled: !output || bake.status.running, onClick: exportFiles,
                         title: output ? 'The baked tileset and its sidecar' : 'Bake the flipbook first, in the Bake tab' }}
        left={{ id: 'scene', title: 'Scene', render: () => <SceneTab /> }}
        right={[
          { id: 'parameters', title: 'Parameters', render: () => <ParametersPanel /> },
          { id: 'bake', title: 'Bake', render: () => <BakeTab /> },
        ]}
        viewport={viewport} viewportRef={viewportRef} onFrame={frameSelection} hotkeys={hotkeys}
        generation={{ status: bake.status, onCancel: bake.cancel,
                      idle: output ? `Baked: ${output.frames.length} frames, ${output.layout.columns}×${output.layout.rows} atlas (${output.layout.width}×${output.layout.height}), ${output.fps} fps, ${output.backend.toUpperCase()}` : 'Live preview — bake the tileset in the Bake tab' }} />
    </FxContext.Provider>
  );
}

/** Polls the live stats a few times a second, so a 24 Hz simulation never re-renders the workspace. */
function LiveReadout() {
  const { stats } = useFx();
  const [s, setS] = useState<LiveStats | null>(null);
  useEffect(() => {
    const t = setInterval(() => setS(stats.current ? { ...stats.current } : null), 250);
    return () => clearInterval(t);
  }, [stats]);
  if (!s) return <>Starting…</>;
  const what = s.particles !== undefined ? `${s.particles.toLocaleString()} drops · ` : '';
  return <>{s.backend.toUpperCase()} · {what}{s.dims.nx}×{s.dims.ny}×{s.dims.nz} · {s.simMs.toFixed(1)} ms/frame · t {s.simTime.toFixed(1)} s</>;
}

/**
 * The RIGHT dock panel: the effect's own composition -- emitter, combustion, forces, dissipation,
 * simulation and look. Baking is the Bake tab beside it. Whole-effect presets at the top, a Presets ▾ menu on each section.
 * The scene-side effect values (region size, sun direction, preview quality) are the left panel's.
 */
function ParametersPanel() {
  const { params, setParams, presetId, setPresetId, recentre } = useFx();
  const values = { ...params, tileSize: String(params.tileSize) } as unknown as Record<string, unknown>;
  // Changing the medium starts from that medium's first preset: a liquid needs a region, droplets and a
  // source of its own, and a smoke grid's voxel size is far too coarse for drops.
  const change = (patch: Partial<FxParams>) => {
    if (patch.medium && patch.medium !== params.medium) {
      const id = patch.medium === 'liquid' ? LIQUID_START : GAS_START;
      const next = effectPresetParams(id, params);
      setParams(next);
      setPresetId(id);
      recentre(next);
      return;
    }
    setParams({ ...params, ...patch, tileSize: Number(patch.tileSize ?? params.tileSize) });
  };
  // An effect preset replaces every parameter -- seed, sun direction and bake settings included -- except
  // the viewport's preview quality. Reset applies the preset picked last again.
  const applyEffect = (p: { id: string }) => {
    const next = effectPresetParams(p.id, params);
    setParams(next);
    setPresetId(p.id);
    recentre(next);
  };
  const reset = () => {
    const next = effectPresetParams(presetId, params);
    setParams(next);
    recentre(next);
    toast.success(`Reset to ${effectPresetLabel(presetId)}.`);
  };
  return (
    <PanelBody>
      <PanelHeader kind='Effect' name={effectPresetLabel(presetId)} onReset={reset} presetLabel='Effect presets'
                   presets={FX_PRESETS.map(p => ({ ...p, description: p.description ?? p.label }))} onPreset={applyEffect} />
      <SchemaSections groups={schemaGroupsFor(params.medium, 'parameters')} values={values} persist='cleo_creator_fx'
                      onChange={patch => change(patch as Partial<FxParams>)}
                      right={title => sectionPresets(title, params, setParams)} />
    </PanelBody>
  );
}

function SceneTab() {
  const { scene, setScene, params, setParams, selection, select } = useFx();
  return <ScenePanel scene={scene} setScene={setScene} params={params} setParams={setParams} selection={selection} select={select} />;
}

function BakeTab() {
  const { params, setParams, output, liveFrames, bakeRunning, onBake } = useFx();
  return <BakePanel params={params} setParams={setParams} output={output} liveFrames={liveFrames} running={bakeRunning} onBake={onBake} />;
}
