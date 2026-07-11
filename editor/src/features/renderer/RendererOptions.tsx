import { useEffect, useState } from 'react';
import { useCleoEngine } from '../EngineContext';

// Debug channels map 1:1 to the renderer's `debugView` setter (see renderer.ts). Grouped only for
// display; clicking one blits that internal buffer to the viewport instead of the composited image.
const CHANNELS: { key: string; label: string }[] = [
  { key: 'final',     label: 'Final' },
  { key: 'scene',     label: 'Lit Scene' },
  { key: 'albedo',    label: 'Albedo' },
  { key: 'metallic',  label: 'Metallic' },
  { key: 'normal',    label: 'Normal' },
  { key: 'roughness', label: 'Roughness' },
  { key: 'emissive',  label: 'Emissive' },
  { key: 'ao',        label: 'AO' },
  { key: 'depth',     label: 'Depth' },
  { key: 'ssao',      label: 'SSAO' },
  { key: 'shadow',    label: 'Shadow' },
  { key: 'bloom',     label: 'Bloom' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className='mb-3'>
      <div className='text-[11px] uppercase tracking-wide text-[#9a9ad0] mb-1'>{title}</div>
      {children}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }:
  { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className='flex items-center justify-between gap-2 my-1 text-xs'>
      <span className='w-[70px] shrink-0'>{label}</span>
      <input className='flex-1' type='range' min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} />
      <span className='w-[34px] text-right tabular-nums'>{value.toFixed(2)}</span>
    </label>
  );
}

function NumberField({ label, value, min, step, onChange }:
  { label: string; value: number; min?: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className='flex items-center justify-between gap-2 my-1 text-xs'>
      <span className='w-[70px] shrink-0'>{label}</span>
      <input className='flex-1 bg-[#1e1e1e] border border-[#3b3b3b] rounded px-1 py-0.5 text-right tabular-nums'
        type='number' min={min} step={step} value={value}
        onChange={(e) => { const v = parseFloat(e.target.value); onChange(Number.isFinite(v) ? v : 0); }} />
    </label>
  );
}

export default function RendererOptions() {
  const { instance, isPlayMode } = useCleoEngine();
  const renderer: any = instance?.renderer ?? null;

  // Local mirror of renderer state so the controls re-render; initialized from the renderer getters.
  const [debugView, setDebugViewState] = useState<string>(() => renderer?.debugView ?? 'final');
  const [exposure, setExposure] = useState<number>(() => renderer?.exposure ?? 1.5);
  const [chromatic, setChromatic] = useState<number>(() => renderer?.chromaticAberrationStrength ?? 0);
  const [ssaoEnabled, setSsaoEnabled] = useState<boolean>(() => renderer?.ssaoEnabled ?? true);
  const [ssaoRadius, setSsaoRadius] = useState<number>(() => renderer?.ssaoRadius ?? 0.5);
  const [ssaoPower, setSsaoPower] = useState<number>(() => renderer?.ssaoPower ?? 1.5);
  const [ssaoBias, setSsaoBias] = useState<number>(() => renderer?.ssaoBias ?? 0.025);
  const [gridVisible, setGridVisible] = useState<boolean>(() => renderer?.gridVisible ?? true);
  const [gridPlane, setGridPlane] = useState<string>(() => renderer?.gridPlane ?? 'xz');
  const [frustumCulling, setFrustumCulling] = useState<boolean>(() => renderer?.frustumCulling ?? true);
  const [foliageCullDistance, setFoliageCullDistance] = useState<number>(() => renderer?.foliageCullDistance ?? 0);
  const [foliageCellSize, setFoliageCellSize] = useState<number>(() => renderer?.foliageCellSize ?? 32);

  // Leaving Renderer mode (unmount) must restore the normal composited image for the other modes.
  useEffect(() => () => { if (renderer) renderer.debugView = 'final'; }, [renderer]);

  // Play/stop resets debugView and toggles the grid on the renderer directly — re-sync the mirror.
  useEffect(() => {
    if (!renderer) return;
    setDebugViewState(renderer.debugView);
    setGridVisible(renderer.gridVisible);
    setGridPlane(renderer.gridPlane);
    setFrustumCulling(renderer.frustumCulling);
    setFoliageCullDistance(renderer.foliageCullDistance);
    setFoliageCellSize(renderer.foliageCellSize);
  }, [isPlayMode, renderer]);

  if (!renderer) {
    return (
      <div data-cleo-overlay className='absolute top-2 left-2 z-20 w-64 bg-[#252525]/95 border border-[#3b3b3b] rounded-md p-3 text-white shadow-lg select-none'>
        <div className='font-semibold text-sm mb-2'>Renderer</div>
        <div className='text-xs text-[#aaa]'>Renderer not ready.</div>
      </div>
    );
  }

  const setDebug = (key: string) => { renderer.debugView = key; setDebugViewState(key); };

  return (
    <div data-cleo-overlay className='absolute top-2 left-2 z-20 w-64 max-h-[85%] overflow-y-auto bg-[#252525]/95 border border-[#3b3b3b] rounded-md p-3 text-white shadow-lg select-none'>
      <div className='font-semibold text-sm mb-2'>Renderer</div>

      <Section title='Channels'>
        <div className='grid grid-cols-3 gap-1'>
          {CHANNELS.map(({ key, label }) => (
            <button key={key} title={label} onClick={() => setDebug(key)}
              className={`text-[11px] px-1 py-1 rounded border transition-colors ${
                debugView === key
                  ? 'bg-[#2c2cff] border-white'
                  : 'bg-[#3b3b3b] border-[#3b3b3b] hover:bg-[#4a4a4a]'}`}>
              {label}
            </button>
          ))}
        </div>
      </Section>

      <Section title='Optimizations'>
        <label className='flex items-center gap-2 my-1 text-xs'>
          <input type='checkbox' checked={frustumCulling}
            onChange={(e) => { renderer.frustumCulling = e.target.checked; setFrustumCulling(e.target.checked); }} />
          Frustum Culling
        </label>
        <NumberField label='Foliage Dist' value={foliageCullDistance} min={0} step={5}
          onChange={(v) => { renderer.foliageCullDistance = v; setFoliageCullDistance(v); }} />
        <NumberField label='Cell Size' value={foliageCellSize} min={1} step={4}
          onChange={(v) => { renderer.foliageCellSize = v; setFoliageCellSize(v); }} />
        <div className='text-[10px] text-[#8a8aa0] mt-0.5'>Foliage cull distance &amp; grid cell size in world units (distance 0 = off).</div>
      </Section>

      <Section title='Tone / Post'>
        <Slider label='Exposure' value={exposure} min={0} max={5} step={0.05}
          onChange={(v) => { renderer.exposure = v; setExposure(v); }} />
        <Slider label='Chromatic' value={chromatic} min={0} max={2} step={0.01}
          onChange={(v) => { renderer.chromaticAberrationStrength = v; setChromatic(v); }} />
      </Section>

      <Section title='SSAO'>
        <label className='flex items-center gap-2 my-1 text-xs'>
          <input type='checkbox' checked={ssaoEnabled}
            onChange={(e) => { renderer.ssaoEnabled = e.target.checked; setSsaoEnabled(e.target.checked); }} />
          Enabled
        </label>
        <Slider label='Radius' value={ssaoRadius} min={0} max={2} step={0.05}
          onChange={(v) => { renderer.ssaoRadius = v; setSsaoRadius(v); }} />
        <Slider label='Power' value={ssaoPower} min={0} max={5} step={0.1}
          onChange={(v) => { renderer.ssaoPower = v; setSsaoPower(v); }} />
        <Slider label='Bias' value={ssaoBias} min={0} max={0.2} step={0.005}
          onChange={(v) => { renderer.ssaoBias = v; setSsaoBias(v); }} />
      </Section>

      <Section title='Grid'>
        <label className='flex items-center gap-2 my-1 text-xs'>
          <input type='checkbox' checked={gridVisible}
            onChange={(e) => { renderer.setGridVisible(e.target.checked); setGridVisible(e.target.checked); }} />
          Visible
        </label>
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Plane</span>
          {(['xz', 'xy'] as const).map((p) => (
            <button key={p} onClick={() => { renderer.setGridPlane(p); setGridPlane(p); }}
              className={`px-2 py-1 rounded border uppercase ${
                gridPlane === p ? 'bg-[#2c2cff] border-white' : 'bg-[#3b3b3b] border-[#3b3b3b] hover:bg-[#4a4a4a]'}`}>
              {p}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}
