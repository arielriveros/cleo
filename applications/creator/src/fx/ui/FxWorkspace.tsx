import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DockviewApi, IDockviewPanelProps } from 'dockview-react';
import { DockShell } from '@cleo/app-kit/layout/DockShell';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import ConsolePanel from '@cleo/app-kit/feedback/ConsolePanel';
import { Button, Collapsable, DocScope, Select, Toggle } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { useCreatorEngine } from '../../app/CreatorEngine';
import { GenerationBar } from '../../app/StatusBar';
import { downloadAll } from '../../core/download';
import { useGeneration } from '../../core/useGeneration';
import { fluidDims } from '../fluidCpu';
import { gpuBackend } from '../fluidGpu';
import { DEFAULT_FX, FX_PRESETS, FX_SCHEMA, normaliseFx, type FxParams } from '../fxParams';
import { cpuBackend, exportFx, generateFx, type FxOutput } from '../generateFx';

// FX Creator: simulate fire and smoke on a voxel grid (GPU compute when the engine's device has it, the
// CPU reference otherwise), render it from a chosen view into a flipbook, export the tileset.

const STORAGE_KEY = 'cleo_creator_fx_params_v1';

interface FxState {
  params: FxParams;
  setParams: (p: FxParams) => void;
  output: FxOutput | null;
  /** Frames captured so far in the running simulation, for the live view. */
  liveFrames: Uint8Array[];
  tile: number;
  useGpu: boolean;
  setUseGpu: (v: boolean) => void;
}

const FxContext = createContext<FxState | null>(null);
const useFx = () => useContext(FxContext)!;

function loadParams(): FxParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_FX, ...JSON.parse(raw) };
  } catch { /* fall through */ }
  return DEFAULT_FX;
}

export function FxWorkspace() {
  const { hasCompute } = useCreatorEngine();
  const [params, setParamsState] = useState<FxParams>(loadParams);
  const [output, setOutput] = useState<FxOutput | null>(null);
  const [liveFrames, setLiveFrames] = useState<Uint8Array[]>([]);
  const [useGpu, setUseGpu] = useState(true);
  const gen = useGeneration();
  const gpu = hasCompute && useGpu;

  const setParams = (p: FxParams) => {
    setParamsState(p);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch { /* quota */ }
  };

  const simulate = async () => {
    const frames: Uint8Array[] = [];
    setLiveFrames([]);
    const out = await gen.run(ctx => generateFx(params, ctx, {
      backend: gpu ? gpuBackend : cpuBackend,
      onFrame: (_, tile) => { frames.push(tile); setLiveFrames([...frames]); },
    }));
    if (out) {
      setOutput(out);
      toast.success(`Simulated ${out.dims.nx}x${out.dims.ny}x${out.dims.nz} voxels on the ${out.backend.toUpperCase()}.`);
    }
  };

  const exportFiles = async () => {
    if (!output) return;
    await downloadAll(await exportFx(output, params));
  };

  const dims = fluidDims(normaliseFx(params));
  const value = useMemo(() => ({ params, setParams, output, liveFrames, tile: normaliseFx(params).tileSize, useGpu, setUseGpu }),
    [params, output, liveFrames, useGpu]);

  return (
    <FxContext.Provider value={value}>
      <DocScope page='creator/fx'>
        <div className='flex flex-col h-full'>
          <div className='toolbar'>
            <span className='text-muted'>Preset</span>
            <Select value='' onChange={e => { const p = FX_PRESETS.find(x => x.id === e.target.value); if (p) setParams({ ...p.params, seed: params.seed }); }}>
              <option value=''>Choose…</option>
              {FX_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
            <span className='text-dim'>{dims.nx}×{dims.ny}×{dims.nz} voxels</span>
            <div className='flex-1' />
            <label className='flex items-center gap-1 text-muted' title={hasCompute ? 'Run the solver as WebGPU compute' : 'The WebGL2 backend has no compute: the CPU solver runs instead'}>
              <Toggle checked={gpu} onChange={setUseGpu} /> GPU solver {hasCompute ? '' : '(unavailable)'}
            </label>
            <Button variant='primary' disabled={gen.status.running} onClick={simulate}>Simulate</Button>
            <Button disabled={!output || gen.status.running} onClick={exportFiles}>Export flipbook</Button>
          </div>
          <div className='flex-1 min-h-0'>
            <DockShell components={FX_PANELS} storageKey='cleo_creator_fx_layout' version={1} buildDefault={buildFxLayout} anchorPanel='preview' />
          </div>
          <GenerationBar status={gen.status} onCancel={gen.cancel}
                         idle={output ? `${output.frames.length} frames, ${output.layout.columns}×${output.layout.rows} atlas (${output.layout.width}×${output.layout.height}), ${output.fps} fps, ${output.backend.toUpperCase()}` : 'Press Simulate'} />
        </div>
      </DocScope>
    </FxContext.Provider>
  );
}

function buildFxLayout(api: DockviewApi) {
  api.addPanel({ id: 'preview', component: 'preview', title: 'Preview' });
  api.addPanel({ id: 'parameters', component: 'parameters', title: 'Parameters', position: { referencePanel: 'preview', direction: 'right' }, initialWidth: 340 });
  api.addPanel({ id: 'atlas', component: 'atlas', title: 'Atlas', position: { referencePanel: 'preview', direction: 'below' }, initialHeight: 260 });
  api.addPanel({ id: 'console', component: 'console', title: 'Console', position: { referencePanel: 'atlas', direction: 'within' } });
  api.getPanel('atlas')?.api.setActive();
}

function paint(canvas: HTMLCanvasElement | null, pixels: Uint8Array | undefined, width: number, height: number) {
  if (!canvas || !pixels) return;
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  image.data.set(pixels.subarray(0, width * height * 4));
  ctx.putImageData(image, 0, 0);
}

/** Plays the finished flipbook (or the frames so far, while simulating) at its own frame rate. */
function PreviewPanel(_: IDockviewPanelProps) {
  const { output, liveFrames, tile, params } = useFx();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(true);
  const [frame, setFrame] = useState(0);
  const frames = output?.frames ?? liveFrames;
  const size = output?.layout.tile ?? tile;
  const fps = output?.fps ?? Math.round(1 / params.frameTime);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const id = setInterval(() => setFrame(f => (f + 1) % frames.length), 1000 / Math.max(1, fps));
    return () => clearInterval(id);
  }, [playing, frames.length, fps]);
  useEffect(() => { paint(canvasRef.current, frames[Math.min(frame, frames.length - 1)], size, size); }, [frame, frames, size]);

  return (
    <div className='flex flex-col h-full cleo-texture-checker'>
      <div className='flex-1 min-h-0 flex items-center justify-center p-2'>
        {frames.length
          ? <canvas ref={canvasRef} className='h-full max-w-full aspect-square' style={{ imageRendering: 'auto' }} />
          : <span className='text-dim'>No frames yet — press Simulate.</span>}
      </div>
      <div className='flex items-center gap-2 px-2 py-1 bg-surface-sunken border-t border-border'>
        <Button size='sm' onClick={() => setPlaying(p => !p)}>{playing ? 'Pause' : 'Play'}</Button>
        <input type='range' min={0} max={Math.max(0, frames.length - 1)} value={Math.min(frame, Math.max(0, frames.length - 1))}
               onChange={e => { setPlaying(false); setFrame(Number(e.target.value)); }} className='flex-1' />
        <span className='text-dim tabular-nums'>{frames.length ? `${Math.min(frame, frames.length - 1) + 1} / ${frames.length}` : '–'}</span>
      </div>
    </div>
  );
}

function AtlasPanel(_: IDockviewPanelProps) {
  const { output } = useFx();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (output) paint(ref.current, output.atlas, output.layout.width, output.layout.height); }, [output]);
  return (
    <div className='h-full overflow-auto cleo-texture-checker flex items-start justify-center p-2'>
      {output ? <canvas ref={ref} className='max-h-full max-w-full' /> : <span className='text-dim'>The packed flipbook appears here.</span>}
    </div>
  );
}

function ParametersPanel(_: IDockviewPanelProps) {
  const { params, setParams } = useFx();
  const values = { ...params, tileSize: String(params.tileSize) } as unknown as Record<string, unknown>;
  return (
    <div className='p-2 overflow-auto h-full'>
      {FX_SCHEMA.map(group => (
        <Collapsable key={group.title} title={group.title} persistKey={`cleo_creator_fx_${group.title}`}>
          <ParamForm schema={group.specs} values={values}
                     onChange={patch => setParams({ ...params, ...(patch as Partial<FxParams>), tileSize: Number(patch.tileSize ?? params.tileSize) })} />
        </Collapsable>
      ))}
    </div>
  );
}

function ConsoleTab(_: IDockviewPanelProps) {
  return <ConsolePanel />;
}

const FX_PANELS = { preview: PreviewPanel, parameters: ParametersPanel, atlas: AtlasPanel, console: ConsoleTab };
