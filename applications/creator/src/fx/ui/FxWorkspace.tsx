import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DockviewApi, IDockviewPanelProps } from 'dockview-react';
import type { FluidVolumeNode } from 'cleo';
import { DockShell } from '@cleo/app-kit/layout/DockShell';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import ConsolePanel from '@cleo/app-kit/feedback/ConsolePanel';
import { ViewportHost } from '@cleo/app-kit/engine/ViewportHost';
import { Button, Collapsable, DocScope, PresetMenu, Select, Toggle, VisibilityMenu } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { useCreatorEngine } from '../../app/CreatorEngine';
import { GenerationBar } from '../../app/StatusBar';
import { downloadAll } from '../../core/download';
import { useGeneration } from '../../core/useGeneration';
import { fluidDims } from '../fluidCpu';
import { gpuBackend } from '../fluidGpu';
import { DEFAULT_FX, FX_PRESETS, FX_SCHEMA, normaliseFx, type FxParams } from '../fxParams';
import { cpuBackend, exportFx, generateFx, type FxOutput } from '../generateFx';
import { LiveFx, type LiveStats } from '../liveSim';
import { legacySunDirection, loadScene, saveScene, type FxScene } from '../fxScene';
import { EFFECT_SECTION_PRESETS, effectPresetLabel, effectPresetParams, type SectionPreset } from '../fxPresets';
import { frameAt, frameBox, hideFxVolume, installOrbitCamera, showFxVolume } from './fxPreview';
import { emitterPose, FxGizmos, type FxSelection } from './FxGizmos';
import type { GizmoMode, GizmoSpace } from '@cleo/app-kit/gizmo/types';
import { GizmoModeControls } from '@cleo/app-kit/gizmo/GizmoModeControls';
import { FxStage } from './fxStage';
import { ScenePanel } from './ScenePanel';
import { BakePanel } from './BakePanel';

// FX Creator: fire and smoke simulated on a voxel grid, shown live in the 3D viewport as an engine
// FluidVolumeNode -- every parameter change reaches the next simulation step, so there is nothing to
// press to see it. The Bake tab (beside Parameters) runs the deterministic offline simulation from t = 0
// (warm-up, capture, loop blend) and packs the tileset -- and any extra outputs -- the export writes. The Scene panel dresses the stage the
// effect is previewed in (sun, sky, wind, ground, placed bodies); none of it reaches a bake.

const STORAGE_KEY = 'cleo_creator_fx_params_v1';
/** The effect preset picked last: what Reset returns to. */
const PRESET_KEY = 'cleo_creator_fx_preset_v1';
/** A grid or seed change restarts the simulation, so it waits for the slider to settle. */
const RESTART_DEBOUNCE_MS = 300;
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
  live: React.MutableRefObject<LiveFx | null>;
  scene: FxScene;
  setScene: (s: FxScene) => void;
  selection: FxSelection;
  select: (s: FxSelection) => void;
  /** Everything the viewport's gizmos need, assembled once here. */
  gizmos: React.ReactNode;
  viewportRef: React.RefObject<HTMLDivElement>;
  bakeRunning: boolean;
  onBake: () => void;
  onExport: () => void;
  /** The effect preset picked last, or null for the defaults. */
  presetId: string | null;
  setPresetId: (id: string | null) => void;
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
  const stageRef = useRef(stageScene);
  stageRef.current = stageScene;
  const [output, setOutput] = useState<FxOutput | null>(null);
  const [liveFrames, setLiveFrames] = useState<Uint8Array[]>([]);
  const [useGpu, setUseGpu] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const bake = useGeneration();
  const gpu = hasCompute && useGpu;

  const live = useRef<LiveFx | null>(null);
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
  // when the solver changes (GPU / CPU); parameters flow in below without tearing anything down.
  useEffect(() => {
    if (!scene || !camera) return;
    const volume = showFxVolume(scene);
    node.current = volume;
    const sim = new LiveFx(volume, gpu, paramsRef.current);
    sim.onStats = s => { stats.current = s; };
    sim.playing = playing;
    sim.speed = speed;
    sim.setScene(stageRef.current);
    live.current = sim;
    volume.onUpdate = (dt: number) => {
      sim.tick(dt);
      stage.current?.updateFire(sim.fireLight, paramsRef.current);
      stage.current?.updateShadow(sim.shadowTexture, sim.shadowPlacement());
    };
    orbit.current ??= installOrbitCamera(camera, frameBox(volume.size, 20, stageRef.current.regionOffset ?? [0, 0, 0]));
    return () => {
      sim.dispose();
      volume.onUpdate = () => { /* the simulation is gone; the volume holds its last frame */ };
      live.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, camera, gpu]);
  // The stage's own nodes (sun settings, sky, ground, wind, fire light, bodies), for as long as the
  // workspace is open.
  useEffect(() => {
    if (!instance || !scene) return;
    stage.current = new FxStage(instance, scene, sun);
    stage.current.apply(stageRef.current, paramsRef.current);
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
      o.frame(frameAt(o.current(), e.position, Math.max(e.radius * 8, 1.5)));
      return;
    }
    o.frame(frameBox(n.regionSize, o.current().yaw, off));
  };

  // W / E / R pick the gizmo, X flips local/world, F frames, Delete removes a selected body, Escape
  // clears the selection -- as in the editor. Not while typing into a field.
  const keys = useRef({ frameSelection, selection, stageScene });
  keys.current = { frameSelection, selection, stageScene };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || t?.closest?.('input, textarea, select, [contenteditable]')) return;
      const k = e.key.toLowerCase();
      const { selection: sel, stageScene: sc } = keys.current;
      if (k === 'w') setGizmoMode('position');
      else if (k === 'e') setGizmoMode('rotation');
      else if (k === 'r') setGizmoMode('scale');
      else if (k === 'x') setGizmoSpace(s => (s === 'world' ? 'local' : 'world'));
      else if (k === 'f') keys.current.frameSelection();
      else if (k === 'escape') setSelection(null);
      else if ((k === 'delete' || k === 'backspace') && sel?.kind === 'body') {
        setStageScene({ ...sc, bodies: sc.bodies.filter(b => b.id !== sel.id) });
        setSelection(null);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { if (live.current) live.current.playing = playing; }, [playing]);
  useEffect(() => { if (live.current) live.current.speed = speed; }, [speed]);

  const bakeFlipbook = async () => {
    const frames: Uint8Array[] = [];
    setLiveFrames([]);
    // Its own solver instance, from t = 0: the live preview keeps running beside it.
    const out = await bake.run(ctx => generateFx(params, ctx, {
      backend: gpu ? gpuBackend : cpuBackend,
      onFrame: (_, tile) => { frames.push(tile); setLiveFrames([...frames]); },
    }));
    if (out) {
      setOutput(out);
      toast.success(`Baked ${out.frames.length} frames from ${out.dims.nx}x${out.dims.ny}x${out.dims.nz} voxels on the ${out.backend.toUpperCase()}.`);
    }
  };

  const exportFiles = async () => {
    if (!output) return;
    await downloadAll(await exportFx(output, params));
  };

  const dims = fluidDims(normaliseFx(params));
  const gizmos = (<>
    {/* The editor's own floating controls, top-right over the viewport. */}
    <div data-cleo-overlay className='absolute top-2 right-2 z-20 flex items-center gap-2'>
      <VisibilityMenu items={[
        { key: 'grid', label: 'Grid', checked: stageScene.grid },
        { key: 'groundPlane', label: 'Floor', checked: stageScene.groundPlane },
        { key: 'sky', label: 'Sky', checked: stageScene.sky },
        { key: 'effectShadow', label: 'Ground shadow', checked: stageScene.effectShadow },
        { key: 'showRegion', label: 'Region wireframe', checked: stageScene.showRegion },
        { key: 'showEmitter', label: 'Emitter', checked: stageScene.showEmitter },
        { key: 'showBodies', label: 'Bodies', checked: stageScene.showBodies },
      ].map(item => ({ ...item, onChange: (v: boolean) => setStageScene(s => ({ ...s, [item.key]: v })) }))} />
      <GizmoModeControls mode={gizmoMode} space={gizmoSpace} onMode={setGizmoMode} onSpace={setGizmoSpace} />
      <Button size='sm' variant='ghost' className='bg-surface-raised/80' title='Frame the selection (F)' onClick={frameSelection}>Frame</Button>
    </div>
    <FxGizmos instance={instance} scene={scene} bus={bus} stage={stage} volume={node} viewportRef={viewportRef}
              params={params} setParams={setParams} fxScene={stageScene} setFxScene={setStageScene}
              selection={selection} select={setSelection} mode={gizmoMode} space={gizmoSpace} />
  </>);
  const value = useMemo(() => ({
    params, setParams, output, liveFrames, tile: normaliseFx(params).tileSize, stats, live, scene: stageScene, setScene: setStageScene,
    selection, select: setSelection, gizmos, viewportRef,
    bakeRunning: bake.status.running, onBake: bakeFlipbook, onExport: exportFiles, presetId, setPresetId,
  }), [params, output, liveFrames, stageScene, selection, gizmoMode, gizmoSpace, instance, scene, bake.status.running, gpu, presetId]);

  return (
    <FxContext.Provider value={value}>
      <DocScope page='creator/fx'>
        <div className='flex flex-col h-full'>
          <div className='toolbar'>
            <span className='text-dim' title='The grid: the region divided by the voxel size'>
              {dims.nx}×{dims.ny}×{dims.nz} = {((dims.nx * dims.ny * dims.nz) / 1e6).toFixed(2)} M voxels
            </span>
            <Button size='sm' onClick={() => setPlaying(p => !p)}>{playing ? 'Pause' : 'Play'}</Button>
            <Button size='sm' onClick={() => live.current?.restart()}>Restart</Button>
            <Select value={String(speed)} onChange={e => setSpeed(Number(e.target.value))}>
              {[0.25, 0.5, 1, 2].map(s => <option key={s} value={s}>{s}× speed</option>)}
            </Select>
            <div className='flex-1' />
            <label className='flex items-center gap-1 text-muted'>
              <Toggle checked={gpu} onChange={setUseGpu} /> GPU solver {hasCompute ? '' : '(unavailable)'}
            </label>
          </div>
          <div className='flex-1 min-h-0'>
            <DockShell components={FX_PANELS} storageKey='cleo_creator_fx_layout' version={4} buildDefault={buildFxLayout} anchorPanel='viewport' />
          </div>
          <GenerationBar status={bake.status} onCancel={bake.cancel}
                         idle={output ? `Baked: ${output.frames.length} frames, ${output.layout.columns}×${output.layout.rows} atlas (${output.layout.width}×${output.layout.height}), ${output.fps} fps, ${output.backend.toUpperCase()}` : 'Live preview — bake the tileset in the Bake tab'} />
        </div>
      </DocScope>
    </FxContext.Provider>
  );
}

function buildFxLayout(api: DockviewApi) {
  api.addPanel({ id: 'viewport', component: 'viewport', title: 'Viewport' });
  api.addPanel({ id: 'scene', component: 'scene', title: 'Scene', position: { referencePanel: 'viewport', direction: 'left' }, initialWidth: 300 });
  api.addPanel({ id: 'parameters', component: 'parameters', title: 'Parameters', position: { referencePanel: 'viewport', direction: 'right' }, initialWidth: 340 });
  api.addPanel({ id: 'bake', component: 'bake', title: 'Bake', position: { referencePanel: 'parameters', direction: 'within' } });
  api.addPanel({ id: 'console', component: 'console', title: 'Console', position: { referencePanel: 'viewport', direction: 'below' }, initialHeight: 160 });
  api.getPanel('parameters')?.api.setActive();
}

/** The live 3D view, with the solver's numbers in a corner. */
function ViewportPanel(_: IDockviewPanelProps) {
  const { gizmos, viewportRef } = useFx();
  return (
    <ViewportHost viewportRef={viewportRef}>
      <LiveReadout />
      {gizmos}
    </ViewportHost>
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
  if (!s) return null;
  return (
    <div data-cleo-overlay className='absolute left-2 top-2 rounded bg-surface/80 px-2 py-1 text-ui-xs text-muted tabular-nums pointer-events-none'>
      {s.backend.toUpperCase()} · {s.dims.nx}×{s.dims.ny}×{s.dims.nz} · {s.simMs.toFixed(1)} ms/frame · t {s.simTime.toFixed(1)} s
    </div>
  );
}

/**
 * The RIGHT dock panel: the effect's own composition -- emitter, combustion, forces, dissipation,
 * simulation and look. Baking is the Bake tab beside it. Whole-effect presets at the top, a Presets ▾ menu on each section.
 * The scene-side effect values (region size, sun direction, preview quality) are the left panel's.
 */
function ParametersPanel(_: IDockviewPanelProps) {
  const { params, setParams, presetId, setPresetId } = useFx();
  const values = { ...params, tileSize: String(params.tileSize) } as unknown as Record<string, unknown>;
  // An effect preset replaces every parameter -- seed, sun direction and bake settings included -- except
  // the viewport's preview quality. Reset applies the preset picked last again.
  const applyEffect = (p: { id: string }) => {
    setParams(effectPresetParams(p.id, params));
    setPresetId(p.id);
  };
  const reset = () => {
    setParams(effectPresetParams(presetId, params));
    toast.success(`Reset to ${effectPresetLabel(presetId)}.`);
  };
  return (
    <div className='p-2 overflow-auto h-full'>
      <div className='flex items-center gap-2 pb-1'>
        <span className='flex-1 min-w-0 truncate text-ui-sm text-muted'>Effect · <span className='text-fg'>{effectPresetLabel(presetId)}</span></span>
        <Button size='sm' variant='ghost' onClick={reset}>Reset</Button>
        <PresetMenu label='Effect presets' presets={FX_PRESETS.map(p => ({ ...p, description: p.description ?? p.label }))} onApply={applyEffect} />
      </div>
      {FX_SCHEMA.filter(group => group.side !== 'bake').map(group => (
        <Collapsable key={group.title} title={group.title} persistKey={`cleo_creator_fx_${group.title}`}
                     right={EFFECT_SECTION_PRESETS[group.title]
                       ? <PresetMenu presets={EFFECT_SECTION_PRESETS[group.title]}
                                     onApply={(p: SectionPreset<Partial<FxParams>>) => setParams({ ...params, ...p.values })} />
                       : undefined}>
          <ParamForm schema={group.specs} values={values}
                     onChange={patch => setParams({ ...params, ...(patch as Partial<FxParams>), tileSize: Number(patch.tileSize ?? params.tileSize) })} />
        </Collapsable>
      ))}
    </div>
  );
}

function SceneTab(_: IDockviewPanelProps) {
  const { scene, setScene, params, setParams, selection, select } = useFx();
  return <ScenePanel scene={scene} setScene={setScene} params={params} setParams={setParams} selection={selection} select={select} />;
}

function BakeTab(_: IDockviewPanelProps) {
  const { params, setParams, output, liveFrames, bakeRunning, onBake, onExport } = useFx();
  return <BakePanel params={params} setParams={setParams} output={output} liveFrames={liveFrames}
                    running={bakeRunning} onBake={onBake} onExport={onExport} />;
}

function ConsoleTab(_: IDockviewPanelProps) {
  return <ConsolePanel />;
}

const FX_PANELS = { viewport: ViewportPanel, scene: SceneTab, parameters: ParametersPanel, bake: BakeTab, console: ConsoleTab };
