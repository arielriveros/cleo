import { useEffect, useRef, useState } from 'react';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import { Button, Collapsable, PresetMenu, Select } from '@cleo/app-kit/ui';
import { FX_SCHEMA, type FxParams } from '../fxParams';
import { BAKE_PRESETS, EFFECT_SECTION_PRESETS, type SectionPreset } from '../fxPresets';
import { bakeKinds, OUTPUT_LABELS, type FxOutput, type FxOutputKind } from '../generateFx';

// The Bake tab, beside Parameters in the right dock: everything about turning the effect into textures.
// The bake-side sections (Flipbook, Outputs), the Bake and Export buttons, and a player and atlas view
// for whichever output is selected. The bake runs its own deterministic simulation from t = 0; the live
// preview keeps going beside it.

export interface BakePanelProps {
  params: FxParams;
  setParams: (p: FxParams) => void;
  output: FxOutput | null;
  /** Frames captured so far in the running bake (colour). */
  liveFrames: Uint8Array[];
  running: boolean;
  onBake: () => void;
  onExport: () => void;
}

export function BakePanel({ params, setParams, output, liveFrames, running, onBake, onExport }: BakePanelProps) {
  const values = { ...params, tileSize: String(params.tileSize) } as unknown as Record<string, unknown>;
  const kinds = output ? (Object.keys(output.outputs) as FxOutputKind[]) : bakeKinds(params);
  const [kind, setKind] = useState<FxOutputKind>('color');
  const shown = kinds.includes(kind) ? kind : 'color';
  const atlas = output?.outputs[shown] ?? null;
  const frames = atlas?.frames ?? (shown === 'color' ? liveFrames : []);
  const size = output?.layout.tile ?? params.tileSize;
  const fps = output?.fps ?? Math.round(1 / params.frameTime);
  return (
    <div className='flex flex-col h-full min-h-0'>
      <div className='p-2 overflow-auto shrink-0' style={{ maxHeight: '55%' }}>
        <div className='flex items-center justify-between pb-1'>
          <span className='text-ui-sm text-muted'>Bake</span>
          <PresetMenu label='Bake presets' presets={BAKE_PRESETS}
                      onApply={(p: SectionPreset<Partial<FxParams>>) => setParams({ ...params, ...p.values })} />
        </div>
        {FX_SCHEMA.filter(g => g.side === 'bake').map(group => (
          <Collapsable key={group.title} title={group.title} persistKey={`cleo_creator_fx_${group.title}`}
                       right={EFFECT_SECTION_PRESETS[group.title]
                         ? <PresetMenu presets={EFFECT_SECTION_PRESETS[group.title]}
                                       onApply={(p: SectionPreset<Partial<FxParams>>) => setParams({ ...params, ...p.values })} />
                         : undefined}>
            <ParamForm schema={group.specs} values={values}
                       onChange={patch => setParams({ ...params, ...(patch as Partial<FxParams>), tileSize: Number(patch.tileSize ?? params.tileSize) })} />
          </Collapsable>
        ))}
        <div className='flex items-center gap-2 pt-2'>
          <Button variant='primary' disabled={running} onClick={onBake}>Bake flipbook</Button>
          <Button disabled={!output || running} onClick={onExport}>Export</Button>
        </div>
      </div>
      <div className='flex items-center gap-2 px-2 py-1 border-y border-border bg-surface-sunken'>
        <span className='text-ui-xs text-muted'>Output</span>
        <Select value={shown} onChange={e => setKind(e.target.value as FxOutputKind)}>
          {kinds.map(k => <option key={k} value={k}>{OUTPUT_LABELS[k]}</option>)}
        </Select>
      </div>
      <div className='flex-1 min-h-0 flex flex-col'>
        <Player frames={frames} size={size} fps={fps} />
        {output && atlas && <AtlasView pixels={atlas.atlas} width={output.layout.width} height={output.layout.height} />}
      </div>
    </div>
  );
}

function paint(canvas: HTMLCanvasElement | null, pixels: Uint8Array | undefined, width: number, height: number) {
  if (!canvas || !pixels) return;
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  image.data.set(pixels.subarray(0, width * height * 4));
  ctx.putImageData(image, 0, 0);
}

/** Plays the frames at the flipbook's own rate. */
function Player({ frames, size, fps }: { frames: Uint8Array[]; size: number; fps: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(true);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const id = setInterval(() => setFrame(f => (f + 1) % frames.length), 1000 / Math.max(1, fps));
    return () => clearInterval(id);
  }, [playing, frames.length, fps]);
  useEffect(() => { paint(canvasRef.current, frames[Math.min(frame, frames.length - 1)], size, size); }, [frame, frames, size]);
  return (
    <div className='flex flex-col flex-1 min-h-0 cleo-texture-checker'>
      <div className='flex-1 min-h-0 flex items-center justify-center p-2'>
        {frames.length
          ? <canvas ref={canvasRef} className='h-full max-w-full aspect-square' />
          : <span className='text-dim'>No flipbook yet — press Bake flipbook.</span>}
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

/** The packed atlas of the selected output. */
function AtlasView({ pixels, width, height }: { pixels: Uint8Array; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { paint(ref.current, pixels, width, height); }, [pixels, width, height]);
  return (
    <div className='h-1/3 min-h-0 overflow-auto cleo-texture-checker flex items-start justify-center p-2 border-t border-border'>
      <canvas ref={ref} className='max-h-full max-w-full' />
    </div>
  );
}
