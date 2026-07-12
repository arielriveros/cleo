import { useEffect, useState } from 'react';
import { useCleoEngine } from '../EngineContext';
import { OverlayPanel, Section, Slider, Checkbox, Field, NumberInput, SegmentedControl, Hint } from '../../components/ui';

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
  { key: 'velocity',  label: 'Velocity' },
];

// Motion-blur quality presets: sample taps per pixel (higher = smoother, costlier).
const MB_QUALITY: { label: string; samples: number }[] = [
  { label: 'Low',  samples: 8 },
  { label: 'Med',  samples: 16 },
  { label: 'High', samples: 24 },
];

export default function RendererOptions() {
  const { instance, isPlayMode } = useCleoEngine();
  const renderer: any = instance?.renderer ?? null;

  // Local mirror of renderer state so the controls re-render; initialized from the renderer getters.
  const [debugView, setDebugViewState] = useState<string>(() => renderer?.debugView ?? 'final');
  const [exposure, setExposure] = useState<number>(() => renderer?.exposure ?? 2.0);
  const [bloomThreshold, setBloomThreshold] = useState<number>(() => renderer?.bloomThreshold ?? 1.0);
  const [bloomKnee, setBloomKnee] = useState<number>(() => renderer?.bloomKnee ?? 0.5);
  const [bloomIntensity, setBloomIntensity] = useState<number>(() => renderer?.bloomIntensity ?? 0.6);
  const [chromatic, setChromatic] = useState<number>(() => renderer?.chromaticAberrationStrength ?? 0);
  const [ssaoEnabled, setSsaoEnabled] = useState<boolean>(() => renderer?.ssaoEnabled ?? true);
  const [ssaoRadius, setSsaoRadius] = useState<number>(() => renderer?.ssaoRadius ?? 0.5);
  const [ssaoPower, setSsaoPower] = useState<number>(() => renderer?.ssaoPower ?? 1.5);
  const [ssaoBias, setSsaoBias] = useState<number>(() => renderer?.ssaoBias ?? 0.025);
  const [gridVisible, setGridVisible] = useState<boolean>(() => renderer?.gridVisible ?? true);
  const [gridPlane, setGridPlane] = useState<string>(() => renderer?.gridPlane ?? 'xz');
  const [frustumCulling, setFrustumCulling] = useState<boolean>(() => renderer?.frustumCulling ?? true);
  const [foliageCullDistance, setFoliageCullDistance] = useState<number>(() => renderer?.foliageCullDistance ?? 65);
  const [foliageCellSize, setFoliageCellSize] = useState<number>(() => renderer?.foliageCellSize ?? 13);
  const [motionBlur, setMotionBlur] = useState<boolean>(() => renderer?.motionBlurEnabled ?? true);
  const [motionBlurIntensity, setMotionBlurIntensity] = useState<number>(() => renderer?.motionBlurIntensity ?? 1.0);
  const [motionBlurSamples, setMotionBlurSamples] = useState<number>(() => renderer?.motionBlurSamples ?? 12);

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
    setMotionBlur(renderer.motionBlurEnabled);
    setMotionBlurIntensity(renderer.motionBlurIntensity);
    setMotionBlurSamples(renderer.motionBlurSamples);
  }, [isPlayMode, renderer]);

  if (!renderer) {
    return (
      <OverlayPanel className='w-64'>
        <div className='font-semibold text-sm mb-2'>Renderer</div>
        <div className='text-xs text-muted'>Renderer not ready.</div>
      </OverlayPanel>
    );
  }

  const setDebug = (key: string) => { renderer.debugView = key; setDebugViewState(key); };

  return (
    <OverlayPanel className='w-64 max-h-[85%] overflow-y-auto'>
      <div className='font-semibold text-sm mb-2'>Renderer</div>

      <Section title='Channels'>
        <SegmentedControl
          className='grid grid-cols-3 gap-1'
          size='sm'
          value={debugView}
          onChange={setDebug}
          options={CHANNELS.map(({ key, label }) => ({ value: key, label, title: label }))}
        />
      </Section>

      <Section title='Optimizations'>
        <Checkbox label='Frustum Culling' checked={frustumCulling} labelClassName='my-1'
          onChange={(c) => { renderer.frustumCulling = c; setFrustumCulling(c); }} />
        <Field label='Foliage Dist'>
          <NumberInput value={foliageCullDistance} min={0} step={5} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.foliageCullDistance = v; setFoliageCullDistance(v); }} />
        </Field>
        <Field label='Cell Size'>
          <NumberInput value={foliageCellSize} min={1} step={4} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.foliageCellSize = v; setFoliageCellSize(v); }} />
        </Field>
        <Hint>Foliage cull distance &amp; grid cell size in world units (distance 0 = off).</Hint>
      </Section>

      <Section title='Tone / Post'>
        <Slider label='Exposure' value={exposure} min={0} max={5} step={0.05}
          onChange={(v) => { renderer.exposure = v; setExposure(v); }} />
        <Slider label='Chromatic' value={chromatic} min={0} max={2} step={0.01}
          onChange={(v) => { renderer.chromaticAberrationStrength = v; setChromatic(v); }} />
      </Section>

      <Section title='Bloom'>
        <Slider label='Threshold' value={bloomThreshold} min={0} max={5} step={0.05}
          onChange={(v) => { renderer.bloomThreshold = v; setBloomThreshold(v); }} />
        <Slider label='Knee' value={bloomKnee} min={0} max={2} step={0.05}
          onChange={(v) => { renderer.bloomKnee = v; setBloomKnee(v); }} />
        <Slider label='Intensity' value={bloomIntensity} min={0} max={3} step={0.05}
          onChange={(v) => { renderer.bloomIntensity = v; setBloomIntensity(v); }} />
        <Hint>HDR bright-pass (linear). Threshold is a luminance cutoff; knee softens the ramp.</Hint>
      </Section>

      <Section title='Motion Blur'>
        <Checkbox label='Enabled' checked={motionBlur} labelClassName='my-1'
          onChange={(c) => { renderer.motionBlurEnabled = c; setMotionBlur(c); }} />
        <Slider label='Amount' value={motionBlurIntensity} min={0} max={4} step={0.05}
          onChange={(v) => { renderer.motionBlurIntensity = v; setMotionBlurIntensity(v); }} />
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Quality</span>
          <SegmentedControl
            value={motionBlurSamples}
            onChange={(samples) => { renderer.motionBlurSamples = samples; setMotionBlurSamples(samples); }}
            options={MB_QUALITY.map((q) => ({ value: q.samples, label: q.label }))}
          />
        </div>
        <Hint>Camera-reprojection motion blur (UE5-style). Amount scales the shutter length.</Hint>
      </Section>

      <Section title='SSAO'>
        <Checkbox label='Enabled' checked={ssaoEnabled} labelClassName='my-1'
          onChange={(c) => { renderer.ssaoEnabled = c; setSsaoEnabled(c); }} />
        <Slider label='Radius' value={ssaoRadius} min={0} max={2} step={0.05}
          onChange={(v) => { renderer.ssaoRadius = v; setSsaoRadius(v); }} />
        <Slider label='Power' value={ssaoPower} min={0} max={5} step={0.1}
          onChange={(v) => { renderer.ssaoPower = v; setSsaoPower(v); }} />
        <Slider label='Bias' value={ssaoBias} min={0} max={0.2} step={0.005}
          onChange={(v) => { renderer.ssaoBias = v; setSsaoBias(v); }} />
      </Section>

      <Section title='Grid'>
        <Checkbox label='Visible' checked={gridVisible} labelClassName='my-1'
          onChange={(c) => { renderer.setGridVisible(c); setGridVisible(c); }} />
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Plane</span>
          <SegmentedControl
            value={gridPlane}
            onChange={(p) => { renderer.setGridPlane(p); setGridPlane(p); }}
            itemClassName='uppercase'
            options={[{ value: 'xz', label: 'XZ' }, { value: 'xy', label: 'XY' }]}
          />
        </div>
      </Section>
    </OverlayPanel>
  );
}
