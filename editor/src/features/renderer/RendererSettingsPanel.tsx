import { useCallback, useEffect, useState } from 'react';
import { engineEventBus } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import { Section, Slider, Toggle, Field, NumberInput, SegmentedControl, Hint } from '../../components/ui';
import BackendSelector from './BackendSelector';

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
  { key: 'cascades',  label: 'Cascades' },
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

// Shadow map resolution per cascade layer. VRAM is size² x 4 bytes x cascade count, so 4096 x 4
// layers is ~268MB of depth — the top of the ladder is a "capture a still" setting, not a default.
const SHADOW_RES: { label: string; size: number; title: string }[] = [
  { label: '512',  size: 512,  title: '512px per cascade — lowest cost, visibly blocky up close' },
  { label: '1K',   size: 1024, title: '1024px per cascade' },
  { label: '2K',   size: 2048, title: '2048px per cascade — the default' },
  { label: '4K',   size: 4096, title: '4096px per cascade — ~268MB of depth at 4 cascades' },
];

// Cascade count. More cascades spend resolution where the camera actually is, at one extra depth
// rasterization each (the distant ones are staggered, so the real cost is well under linear).
const SHADOW_CASCADES = [1, 2, 3, 4].map((n) => ({ value: n, label: String(n), title: `${n} cascade${n > 1 ? 's' : ''}` }));

// PCF kernels. Both sample a hardware comparison texture, so every tap is already a 2x2 filter.
const SHADOW_FILTER: { label: string; mode: number; title: string }[] = [
  { label: '3×3',     mode: 0, title: '9 taps in a grid — the default' },
  { label: 'Poisson', mode: 1, title: '16 taps on a per-pixel rotated disk — softer at wide radii' },
];

// Spot-light shadow map resolution. One map PER casting spot light, re-rendered every frame (there
// is no equivalent of the cascade stagger), so this ladder tops out lower than the cascades'.
const SPOT_RES: { label: string; size: number }[] = [
  { label: '256', size: 256 },
  { label: '512', size: 512 },
  { label: '1K', size: 1024 },
  { label: '2K', size: 2048 },
];

// Motion-blur quality presets: sample taps per pixel (higher = smoother, costlier).
const MB_QUALITY: { label: string; samples: number }[] = [
  { label: 'Low',  samples: 8 },
  { label: 'Med',  samples: 16 },
  { label: 'High', samples: 24 },
];

export default function RendererSettingsPanel() {
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
  const [shadowsEnabled, setShadowsEnabled] = useState<boolean>(() => renderer?.shadowsEnabled ?? true);
  const [shadowRes, setShadowRes] = useState<number>(() => renderer?.shadowMapResolution ?? 2048);
  const [shadowCascades, setShadowCascades] = useState<number>(() => renderer?.shadowCascades ?? 3);
  const [shadowDistance, setShadowDistance] = useState<number>(() => renderer?.shadowDistance ?? 100);
  const [shadowLambda, setShadowLambda] = useState<number>(() => renderer?.shadowSplitLambda ?? 0.5);
  const [shadowDepthBias, setShadowDepthBias] = useState<number>(() => renderer?.shadowDepthBias ?? 0.03);
  const [shadowNormalBias, setShadowNormalBias] = useState<number>(() => renderer?.shadowNormalBias ?? 1.5);
  const [shadowSoftness, setShadowSoftness] = useState<number>(() => renderer?.shadowFilterRadius ?? 1);
  const [shadowFilterMode, setShadowFilterMode] = useState<number>(() => renderer?.shadowFilterMode ?? 0);
  const [shadowStrength, setShadowStrength] = useState<number>(() => renderer?.shadowStrength ?? 1);
  const [shadowBlend, setShadowBlend] = useState<number>(() => renderer?.shadowCascadeBlend ?? 0.1);
  const [shadowStabilize, setShadowStabilize] = useState<boolean>(() => renderer?.shadowStabilize ?? true);
  const [shadowStagger, setShadowStagger] = useState<boolean>(() => renderer?.shadowStagger ?? true);
  const [shadowCasterPad, setShadowCasterPad] = useState<number>(() => renderer?.shadowCasterPad ?? 50);
  const [shadowDebugLayer, setShadowDebugLayer] = useState<number>(() => renderer?.shadowDebugLayer ?? 0);
  const [spotShadows, setSpotShadows] = useState<boolean>(() => renderer?.spotShadowsEnabled ?? true);
  const [spotShadowRes, setSpotShadowRes] = useState<number>(() => renderer?.spotShadowResolution ?? 1024);
  const [spotShadowDist, setSpotShadowDist] = useState<number>(() => renderer?.spotShadowDistance ?? 100);
  const [spotShadowBias, setSpotShadowBias] = useState<number>(() => renderer?.spotShadowBias ?? 0.0015);

  // Leaving Renderer mode (unmount) must restore the normal composited image for the other modes.
  useEffect(() => () => { if (renderer) renderer.debugView = 'final'; }, [renderer]);

  // Pull every mirrored value back off the renderer.
  //
  // Everything the renderer can change behind this panel's back belongs here, not just what play/stop
  // touches: selecting a quality preset (from the Performance panel) rewrites bloom, SSAO, motion blur
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
    setShadowsEnabled(renderer.shadowsEnabled);
    setShadowRes(renderer.shadowMapResolution);
    setShadowCascades(renderer.shadowCascades);
    setShadowDistance(renderer.shadowDistance);
    setShadowLambda(renderer.shadowSplitLambda);
    setShadowDepthBias(renderer.shadowDepthBias);
    setShadowNormalBias(renderer.shadowNormalBias);
    setShadowSoftness(renderer.shadowFilterRadius);
    setShadowFilterMode(renderer.shadowFilterMode);
    setShadowStrength(renderer.shadowStrength);
    setShadowBlend(renderer.shadowCascadeBlend);
    setShadowStabilize(renderer.shadowStabilize);
    setShadowStagger(renderer.shadowStagger);
    setShadowCasterPad(renderer.shadowCasterPad);
    setShadowDebugLayer(renderer.shadowDebugLayer);
    setSpotShadows(renderer.spotShadowsEnabled);
    setSpotShadowRes(renderer.spotShadowResolution);
    setSpotShadowDist(renderer.spotShadowDistance);
    setSpotShadowBias(renderer.spotShadowBias);
  }, [renderer]);

  // Play/stop resets debugView and toggles the grid on the renderer directly.
  useEffect(() => { syncFromRenderer(); }, [isPlayMode, syncFromRenderer]);

  // A quality preset moves a dozen knobs at once, from a different panel. Without this the mirror
  // only refreshes when this panel remounts, so the two panels can sit side by side disagreeing.
  useEffect(() => {
    engineEventBus.on('RENDER_SETTINGS_CHANGED', syncFromRenderer);
    return () => { engineEventBus.off('RENDER_SETTINGS_CHANGED', syncFromRenderer); };
  }, [syncFromRenderer]);

  // Bloom has kill switches this panel does not own — the Performance panel's per-pass toggles, and the
  // quality preset, which zeroes the intensity on tiers without bloom. Say so here rather than letting
  // the sliders imply bloom is on when nothing can reach the screen.
  const bloomOff = (() => {
    if (!renderer) return null;
    if (renderer.bloomIntensity <= 0) return 'intensity is 0 (the Low quality preset switches bloom off).';
    const passes = renderer.passEnabled;
    const dead = (['bloom.bright', 'bloom.blur', 'bloom.composite'] as const).filter((p) => !passes[p]);
    if (dead.length > 0) return `${dead.join(', ')} switched off in the Performance panel's pass switches.`;
    return null;
  })();

  if (!renderer) return <div className='p-3 text-muted text-xs'>Renderer not ready.</div>;

  const setDebug = (key: string) => { renderer.debugView = key; setDebugViewState(key); };

  return (
    // The content column is capped rather than filling the dock group — see PerformancePanel. The
    // panel stays resizable; a two-digit number input just stops getting a 600px runway.
    <div className='h-full overflow-y-auto p-3 text-[11px] text-white'>
      <div className='w-full max-w-[420px]'>
      <Section
        title='Graphics API'
        hint={'Which API drives the renderer. A request, not a live switch: a context cannot change API '
            + 'underneath the buffers, textures and programs already built on it, so it applies when the '
            + 'editor reloads.'}
      >
        <BackendSelector />
      </Section>

      <Section title='Channels' hint='Blit one internal buffer to the viewport instead of the composited image. Overdraw costs an extra pass — it re-rasterizes the scene additively to show how many times each pixel was shaded.'>
        <SegmentedControl
          className='grid grid-cols-3 gap-1'
          size='sm'
          value={debugView}
          onChange={setDebug}
          options={CHANNELS.map(({ key, label }) => ({ value: key, label, title: label }))}
        />
      </Section>

      <Section
        title='Optimizations'
        hint={'Foliage cull distance and grid cell size are in world units (distance 0 = off). Terrain '
            + 'chunks past each LOD distance draw on a coarser grid; chunk borders stay full-detail, so '
            + 'levels meet seamlessly.'}
      >
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
      </Section>

      <Section title='Tone / Post' hint='Exposure scales linear HDR before the ACES tonemap and sRGB encode at the final present. Chromatic aberration offsets the colour channels radially.'>
        <Slider label='Exposure' value={exposure} min={0} max={5} step={0.05}
          onChange={(v) => { renderer.exposure = v; setExposure(v); }} />
        <Slider label='Chromatic' value={chromatic} min={0} max={2} step={0.01}
          onChange={(v) => { renderer.chromaticAberrationStrength = v; setChromatic(v); }} />
      </Section>

      <Section
        title='Bloom'
        hint={'HDR bright-pass. Threshold is a luminance cutoff measured AFTER exposure, so it means '
            + '"bloom what would clip on screen"; knee softens the ramp. Restricting to lit surfaces uses '
            + "the scene buffer's alpha mask — sprites, tilemaps, transparents and unlit materials cannot "
            + 'set it, so they never bloom while it is on (see the Bloom Mask channel).'}
      >
        <Slider label='Threshold' value={bloomThreshold} min={0} max={5} step={0.05}
          onChange={(v) => { renderer.bloomThreshold = v; setBloomThreshold(v); }} />
        <Slider label='Knee' value={bloomKnee} min={0} max={2} step={0.05}
          onChange={(v) => { renderer.bloomKnee = v; setBloomKnee(v); }} />
        <Slider label='Intensity' value={bloomIntensity} min={0} max={3} step={0.05}
          onChange={(v) => { renderer.bloomIntensity = v; setBloomIntensity(v); }} />
        <Toggle label='Restrict to lit surfaces' checked={bloomMask}
          onChange={(v) => { renderer.bloomMaskEnabled = v; setBloomMask(v); }} />
        {bloomOff && <Hint>Bloom is currently inactive: {bloomOff}</Hint>}
      </Section>

      <Section title='Motion Blur' hint='Camera-reprojection motion blur (UE5-style). Amount scales the shutter length.'>
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
      </Section>

      <Section
        title='Shadows'
        hint={'Distance is how far the cascades reach; nothing past it is shadowed. Split lambda trades '
            + 'near detail against far coverage (0 = even slabs, 1 = resolution packed near the camera) — '
            + 'watch the Cascades channel while dragging it. Softness is the filter radius in shadow '
            + 'texels (0 = one hard tap); Blend cross-fades the seam between cascades, and 0 leaves a '
            + 'visible line. Depth Bias is in WORLD units and is rescaled per cascade, so one value means '
            + 'the same thing in all of them — raise Normal Bias first for acne on steeply lit surfaces, '
            + 'since it moves the lookup across the map rather than pulling the surface toward the light. '
            + 'Stabilize snaps each cascade to a texel grid so edges stop crawling; Stagger re-draws the '
            + 'distant cascades every 2nd/4th frame; Caster Pad is how far behind a cascade the depth pass '
            + 'still captures occluders.'}
      >
        <Toggle label='Enabled' checked={shadowsEnabled} className='my-1'
          onChange={(c) => { renderer.shadowsEnabled = c; setShadowsEnabled(c); }} />

        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Resolution</span>
          <SegmentedControl
            value={shadowRes}
            onChange={(size) => { renderer.shadowMapResolution = size; setShadowRes(renderer.shadowMapResolution); }}
            options={SHADOW_RES.map((r) => ({ value: r.size, label: r.label, title: r.title }))}
          />
        </div>
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Cascades</span>
          <SegmentedControl
            value={shadowCascades}
            onChange={(n) => { renderer.shadowCascades = n; setShadowCascades(renderer.shadowCascades); }}
            options={SHADOW_CASCADES}
          />
        </div>
        <Field label='Distance'>
          <NumberInput value={shadowDistance} min={1} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.shadowDistance = v; setShadowDistance(renderer.shadowDistance); }} />
        </Field>
        <Slider label='Split &#955;' value={shadowLambda} min={0} max={1} step={0.05}
          onChange={(v) => { renderer.shadowSplitLambda = v; setShadowLambda(v); }} />

        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Filter</span>
          <SegmentedControl
            value={shadowFilterMode}
            onChange={(m) => { renderer.shadowFilterMode = m; setShadowFilterMode(renderer.shadowFilterMode); }}
            options={SHADOW_FILTER.map((f) => ({ value: f.mode, label: f.label, title: f.title }))}
          />
        </div>
        <Slider label='Softness' value={shadowSoftness} min={0} max={8} step={0.25}
          readout={(v) => (v <= 0 ? 'hard' : `${v.toFixed(2)} px`)}
          onChange={(v) => { renderer.shadowFilterRadius = v; setShadowSoftness(v); }} />
        <Slider label='Strength' value={shadowStrength} min={0} max={1} step={0.05}
          onChange={(v) => { renderer.shadowStrength = v; setShadowStrength(v); }} />
        <Slider label='Blend' value={shadowBlend} min={0} max={0.5} step={0.01}
          onChange={(v) => { renderer.shadowCascadeBlend = v; setShadowBlend(v); }} />

        <Slider label='Depth Bias' value={shadowDepthBias} min={0} max={0.5} step={0.005}
          onChange={(v) => { renderer.shadowDepthBias = v; setShadowDepthBias(v); }} />
        <Slider label='Normal Bias' value={shadowNormalBias} min={0} max={8} step={0.1}
          onChange={(v) => { renderer.shadowNormalBias = v; setShadowNormalBias(v); }} />

        <Toggle label='Stabilize' checked={shadowStabilize} className='my-1'
          onChange={(c) => { renderer.shadowStabilize = c; setShadowStabilize(c); }} />
        <Toggle label='Stagger Updates' checked={shadowStagger} className='my-1'
          onChange={(c) => { renderer.shadowStagger = c; setShadowStagger(c); }} />
        <Field label='Caster Pad'>
          <NumberInput value={shadowCasterPad} min={0} step={5} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.shadowCasterPad = v; setShadowCasterPad(renderer.shadowCasterPad); }} />
        </Field>

        {debugView === 'shadow' && (
          <div className='flex items-center gap-1 my-1 text-xs'>
            <span className='w-[70px] shrink-0'>View Layer</span>
            <SegmentedControl
              value={shadowDebugLayer}
              onChange={(n) => { renderer.shadowDebugLayer = n; setShadowDebugLayer(renderer.shadowDebugLayer); }}
              options={Array.from({ length: shadowCascades }, (_, i) => ({ value: i, label: String(i) }))}
            />
          </div>
        )}
        {!shadowsEnabled && <Hint>Shadows are off — every lookup returns fully lit.</Hint>}
      </Section>

      <Section
        title='Spot Shadows'
        hint={`Up to ${renderer.maxSpotShadows} spot lights cast at once — flag them per light with Cast `
            + `Shadows in the inspector; any beyond the cap simply go unshadowed. A spot's frustum matches `
            + `its outer cone, and its far plane comes from its attenuation, capped by Max Dist. Bias is in `
            + `DEPTH units here, not world units: perspective depth does not convert linearly.`}
      >
        <Toggle label='Enabled' checked={spotShadows} className='my-1'
          onChange={(c) => { renderer.spotShadowsEnabled = c; setSpotShadows(c); }} />
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Resolution</span>
          <SegmentedControl
            value={spotShadowRes}
            onChange={(size) => { renderer.spotShadowResolution = size; setSpotShadowRes(renderer.spotShadowResolution); }}
            options={SPOT_RES.map((r) => ({ value: r.size, label: r.label }))}
          />
        </div>
        <Field label='Max Dist'>
          <NumberInput value={spotShadowDist} min={1} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.spotShadowDistance = v; setSpotShadowDist(renderer.spotShadowDistance); }} />
        </Field>
        <Slider label='Bias' value={spotShadowBias} min={0} max={0.02} step={0.0005}
          readout={(v) => v.toFixed(4)}
          onChange={(v) => { renderer.spotShadowBias = v; setSpotShadowBias(v); }} />
        {!shadowsEnabled && <Hint>The global Shadows toggle above is off, which also disables these.</Hint>}
      </Section>

      <Section title='SSAO' hint='Screen-space ambient occlusion, deferred path only. Radius is in world units; Power sharpens the falloff; Bias lifts the sample off the surface to stop it occluding itself.'>
        <Toggle label='Enabled' checked={ssaoEnabled} className='my-1'
          onChange={(c) => { renderer.ssaoEnabled = c; setSsaoEnabled(c); }} />
        <Slider label='Radius' value={ssaoRadius} min={0} max={2} step={0.05}
          onChange={(v) => { renderer.ssaoRadius = v; setSsaoRadius(v); }} />
        <Slider label='Power' value={ssaoPower} min={0} max={5} step={0.1}
          onChange={(v) => { renderer.ssaoPower = v; setSsaoPower(v); }} />
        <Slider label='Bias' value={ssaoBias} min={0} max={0.2} step={0.005}
          onChange={(v) => { renderer.ssaoBias = v; setSsaoBias(v); }} />
      </Section>

      <Section title='Grid' hint='Editor-only reference grid. Never rendered in a published game.'>
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
      </div>
    </div>
  );
}
