import { useCallback, useEffect, useState } from 'react';
import { engineEventBus } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import { OverlayPanel, Section, Slider, Toggle, Field, NumberInput, SegmentedControl, Hint } from '../../components/ui';

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
  { key: 'bloomMask', label: 'Bloom Mask' },
  { key: 'velocity',  label: 'Velocity' },
  // Overdraw re-rasterizes the scene with additive blending into its own target, so unlike every
  // other channel here it costs an extra pass — but it is the only view that shows how many times
  // each pixel was shaded, which is what a fill-rate-bound frame is actually spending its time on.
  { key: 'overdraw',  label: 'Overdraw' },
];

// Terrain LOD detail steps: the grid stride a level draws with (triangles scale by 1/step²).
const LOD_DETAIL: { label: string; step: number; title: string }[] = [
  { label: '½', step: 2, title: 'Every 2nd vertex — a quarter of the triangles' },
  { label: '¼', step: 4, title: 'Every 4th vertex — a sixteenth of the triangles' },
  { label: '⅛', step: 8, title: 'Every 8th vertex — a sixty-fourth of the triangles' },
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
  const [bloomMask, setBloomMask] = useState<boolean>(() => renderer?.bloomMaskEnabled ?? false);
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
  const [terrainLod, setTerrainLod] = useState<boolean>(() => renderer?.terrainLodEnabled ?? true);
  const [terrainLodDist1, setTerrainLodDist1] = useState<number>(() => renderer?.terrainLodDistance1 ?? 120);
  const [terrainLodDist2, setTerrainLodDist2] = useState<number>(() => renderer?.terrainLodDistance2 ?? 300);
  const [terrainLodStep1, setTerrainLodStep1] = useState<number>(() => renderer?.terrainLodStep1 ?? 2);
  const [terrainLodStep2, setTerrainLodStep2] = useState<number>(() => renderer?.terrainLodStep2 ?? 4);
  const [motionBlur, setMotionBlur] = useState<boolean>(() => renderer?.motionBlurEnabled ?? true);
  const [motionBlurIntensity, setMotionBlurIntensity] = useState<number>(() => renderer?.motionBlurIntensity ?? 1.0);
  const [motionBlurSamples, setMotionBlurSamples] = useState<number>(() => renderer?.motionBlurSamples ?? 12);

  // Leaving Renderer mode (unmount) must restore the normal composited image for the other modes.
  useEffect(() => () => { if (renderer) renderer.debugView = 'final'; }, [renderer]);

  // Pull every mirrored value back off the renderer.
  //
  // Everything the renderer can change behind this panel's back belongs here, not just what play/stop
  // touches: selecting a quality preset (from the Profiler panel) rewrites bloom, SSAO, motion blur
  // and render scale in one move. Bloom used to be left out, so choosing the `low` tier — which
  // switches bloom off — left the Intensity slider reading 0.6 while the renderer held 0, and bloom
  // looked broken rather than switched off.
  const syncFromRenderer = useCallback(() => {
    if (!renderer) return;
    setDebugViewState(renderer.debugView);
    setExposure(renderer.exposure);
    setBloomThreshold(renderer.bloomThreshold);
    setBloomKnee(renderer.bloomKnee);
    setBloomIntensity(renderer.bloomIntensity);
    setBloomMask(renderer.bloomMaskEnabled);
    setChromatic(renderer.chromaticAberrationStrength);
    setSsaoEnabled(renderer.ssaoEnabled);
    setSsaoRadius(renderer.ssaoRadius);
    setSsaoPower(renderer.ssaoPower);
    setSsaoBias(renderer.ssaoBias);
    setGridVisible(renderer.gridVisible);
    setGridPlane(renderer.gridPlane);
    setFrustumCulling(renderer.frustumCulling);
    setFoliageCullDistance(renderer.foliageCullDistance);
    setFoliageCellSize(renderer.foliageCellSize);
    setTerrainLod(renderer.terrainLodEnabled);
    setTerrainLodDist1(renderer.terrainLodDistance1);
    setTerrainLodDist2(renderer.terrainLodDistance2);
    setTerrainLodStep1(renderer.terrainLodStep1);
    setTerrainLodStep2(renderer.terrainLodStep2);
    setMotionBlur(renderer.motionBlurEnabled);
    setMotionBlurIntensity(renderer.motionBlurIntensity);
    setMotionBlurSamples(renderer.motionBlurSamples);
  }, [renderer]);

  // Play/stop resets debugView and toggles the grid on the renderer directly.
  useEffect(() => { syncFromRenderer(); }, [isPlayMode, syncFromRenderer]);

  // A quality preset moves a dozen knobs at once, from a different panel. Without this the mirror
  // only refreshes when this panel remounts, so the two panels can sit side by side disagreeing.
  useEffect(() => {
    engineEventBus.on('RENDER_SETTINGS_CHANGED', syncFromRenderer);
    return () => { engineEventBus.off('RENDER_SETTINGS_CHANGED', syncFromRenderer); };
  }, [syncFromRenderer]);

  // Bloom has kill switches this panel does not own — the Profiler panel's per-pass toggles, and the
  // quality preset, which zeroes the intensity on tiers without bloom. Say so here rather than letting
  // the sliders imply bloom is on when nothing can reach the screen.
  const bloomOff = (() => {
    if (!renderer) return null;
    if (renderer.bloomIntensity <= 0) return 'intensity is 0 (the Low quality preset switches bloom off).';
    const passes = renderer.passEnabled;
    const dead = (['bloom.bright', 'bloom.blur', 'bloom.composite'] as const).filter((p) => !passes[p]);
    if (dead.length > 0) return `${dead.join(', ')} switched off in the Profiler panel's pass switches.`;
    return null;
  })();

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
        <Toggle label='Frustum Culling' checked={frustumCulling} className='my-1'
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

        <Toggle label='Terrain LOD' checked={terrainLod} className='my-1'
          onChange={(c) => { renderer.terrainLodEnabled = c; setTerrainLod(c); }} />
        <Field label='LOD1 Dist'>
          <NumberInput value={terrainLodDist1} min={0} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.terrainLodDistance1 = v; setTerrainLodDist1(renderer.terrainLodDistance1); }} />
        </Field>
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>LOD1 Detail</span>
          <SegmentedControl
            value={terrainLodStep1}
            onChange={(step) => { renderer.terrainLodStep1 = step; setTerrainLodStep1(step); }}
            options={LOD_DETAIL.map((d) => ({ value: d.step, label: d.label, title: d.title }))}
          />
        </div>
        <Field label='LOD2 Dist'>
          <NumberInput value={terrainLodDist2} min={0} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.terrainLodDistance2 = v; setTerrainLodDist2(renderer.terrainLodDistance2); }} />
        </Field>
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>LOD2 Detail</span>
          <SegmentedControl
            value={terrainLodStep2}
            onChange={(step) => { renderer.terrainLodStep2 = step; setTerrainLodStep2(step); }}
            options={LOD_DETAIL.map((d) => ({ value: d.step, label: d.label, title: d.title }))}
          />
        </div>
        <Hint>Terrain chunks past each distance (world units) draw on a coarser grid. Chunk borders stay
          full-detail, so levels meet seamlessly.</Hint>
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
        <Toggle label='Restrict to lit surfaces' checked={bloomMask}
          onChange={(v) => { renderer.bloomMaskEnabled = v; setBloomMask(v); }} />
        <Hint>HDR bright-pass. Threshold is a luminance cutoff measured after exposure, so it means
          &quot;bloom what would clip on screen&quot;; knee softens the ramp. Restricting to lit surfaces
          uses the scene buffer&apos;s alpha mask — sprites, tilemaps, transparents and unlit materials
          cannot set it, so they never bloom while it is on (see the Bloom Mask channel).</Hint>
        {bloomOff && <Hint>Bloom is currently inactive: {bloomOff}</Hint>}
      </Section>

      <Section title='Motion Blur'>
        <Toggle label='Enabled' checked={motionBlur} className='my-1'
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
        <Toggle label='Enabled' checked={ssaoEnabled} className='my-1'
          onChange={(c) => { renderer.ssaoEnabled = c; setSsaoEnabled(c); }} />
        <Slider label='Radius' value={ssaoRadius} min={0} max={2} step={0.05}
          onChange={(v) => { renderer.ssaoRadius = v; setSsaoRadius(v); }} />
        <Slider label='Power' value={ssaoPower} min={0} max={5} step={0.1}
          onChange={(v) => { renderer.ssaoPower = v; setSsaoPower(v); }} />
        <Slider label='Bias' value={ssaoBias} min={0} max={0.2} step={0.005}
          onChange={(v) => { renderer.ssaoBias = v; setSsaoBias(v); }} />
      </Section>

      <Section title='Grid'>
        <Toggle label='Visible' checked={gridVisible} className='my-1'
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
