import { useCallback, useEffect, useState } from 'react';
import { engineEventBus, TextureManager, isDerivedTextureId } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import { Section, Slider, Toggle, Field, NumberInput, SegmentedControl, Select, Hint } from '../../components/ui';
import BackendSelector from './BackendSelector';

// Debug channels map 1:1 to the renderer's `debugView` setter; the grouping here is display only.
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
  { key: 'taaHistory', label: 'TAA History' },
  // Overdraw re-rasterizes the scene additively into its own target, so unlike every other channel
  // here it costs an extra pass.
  { key: 'overdraw',  label: 'Overdraw' },
];

// Terrain LOD detail steps: the grid stride a level draws with (triangles scale by 1/step²).
const LOD_DETAIL: { label: string; step: number; title: string }[] = [
  { label: '½', step: 2, title: 'Every 2nd vertex — a quarter of the triangles' },
  { label: '¼', step: 4, title: 'Every 4th vertex — a sixteenth of the triangles' },
  { label: '⅛', step: 8, title: 'Every 8th vertex — a sixty-fourth of the triangles' },
];

// Shadow map resolution per cascade layer. VRAM is size² x 4 bytes x cascade count, so 4096 x 4 layers
// is ~268MB of depth.
const SHADOW_RES: { label: string; size: number; title: string }[] = [
  { label: '512',  size: 512,  title: '512px per cascade — lowest cost, visibly blocky up close' },
  { label: '1K',   size: 1024, title: '1024px per cascade' },
  { label: '2K',   size: 2048, title: '2048px per cascade — the default' },
  { label: '4K',   size: 4096, title: '4096px per cascade — ~268MB of depth at 4 cascades' },
];

// Cascade count: one extra depth rasterization each, staggered for the distant ones.
const SHADOW_CASCADES = [1, 2, 3, 4].map((n) => ({ value: n, label: String(n), title: `${n} cascade${n > 1 ? 's' : ''}` }));

// PCF kernels. Both sample a hardware comparison texture, so every tap is already a 2x2 filter.
const SHADOW_FILTER: { label: string; mode: number; title: string }[] = [
  { label: '3×3',     mode: 0, title: '9 taps in a grid — the default' },
  { label: 'Poisson', mode: 1, title: '16 taps on a per-pixel rotated disk — softer at wide radii' },
];

// Spot-light shadow map resolution. One map per casting spot light, re-rendered every frame with no
// cascade-style stagger, so this ladder tops out lower than the cascades'.
const SPOT_RES: { label: string; size: number }[] = [
  { label: '256', size: 256 },
  { label: '512', size: 512 },
  { label: '1K', size: 1024 },
  { label: '2K', size: 2048 },
];

// Point-light shadow map resolution, PER CUBE FACE. Six layers per casting light rather than one, so
// the ladder stops a step below the spot list: 1K here is already 24 array layers of depth.
const POINT_RES: { label: string; size: number }[] = [
  { label: '256', size: 256 },
  { label: '512', size: 512 },
  { label: '1K', size: 1024 },
];

// The display transform. AgX is the default; ACES is what every scene authored before this control
// existed was graded under, which is why it stays on the list rather than being replaced.
const TONE_MAPPERS: { value: string; label: string; title: string }[] = [
  { value: 'agx',     label: 'AgX',     title: 'Rolls saturated highlights toward white instead of clipping them to a primary — the default' },
  { value: 'aces',    label: 'ACES',    title: 'The Narkowicz filmic fit; what this engine used before the curve was selectable' },
  { value: 'neutral', label: 'Neutral', title: 'Khronos PBR Neutral — leaves in-gamut albedo untouched, for asset and product viewing' },
  { value: 'none',    label: 'None',    title: 'Exposure and sRGB only, hard-clamped: what the buffer actually holds' },
];

/**
 * Picker for the colour-grading LUT, which holds a bare texture id in `RenderSettings` rather than a
 * `Material` slot. Derived (channel-packed) textures are engine-owned and never assignable.
 */
function TexturePicker(props: {
  value: string | null;
  onChange: (id: string | null) => void;
  /** What the empty option means. For the LUT that is "no LUT"; for lens dirt it is the built-in mask. */
  emptyLabel: string;
}) {
  const ids = Array.from(TextureManager.Instance.textures.keys())
    .filter((id) => !isDerivedTextureId(id) && !id.startsWith('__editor__'));
  return (
    <Select value={props.value ?? ''} onChange={(e) => props.onChange(e.target.value || null)}>
      <option value=''>{props.emptyLabel}</option>
      {/* A texture the scene references but the manager has dropped still has to be selectable, or
          the field silently resets itself the moment anything re-renders. It matters more here than
          anywhere else: the id lives in the render settings, so no node keeps it alive. */}
      {props.value && !ids.includes(props.value) && <option value={props.value}>{props.value} (missing)</option>}
      {ids.map((id) => <option key={id} value={id}>{id}</option>)}
    </Select>
  );
}

function LutPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  return <TexturePicker value={value} onChange={onChange} emptyLabel='(none)' />;
}

// Motion-blur quality presets: sample taps per pixel (higher = smoother, costlier).
const MB_QUALITY: { label: string; samples: number }[] = [
  { label: 'Low',  samples: 8 },
  { label: 'Med',  samples: 16 },
  { label: 'High', samples: 24 },
];

export default function RendererSettingsPanel() {
  const { instance, isPlayMode, eventEmitter } = useCleoEngine();
  const renderer: any = instance?.renderer ?? null;

  /**
   * Mark the scene dirty after a settings change, so the change is actually SAVED.
   *
   * Everything in this panel lives in `Renderer.getRenderSettings()`, which `saveCurrentScene` folds
   * into the scene blob as `config.render` and `applyGameData` restores on every open — so these are
   * per-scene state and ride the same blob through publish, export and the standalone player. What was
   * missing is the notification: writing `renderer.x = v` mutates the engine directly and emits
   * nothing, so a tuned look survived until the next refresh only if some UNRELATED edit happened to
   * mark the scene dirty first. `SceneSettings` does the same thing for the clear colour.
   */
  const touch = () => eventEmitter?.emit('SCENE_CHANGED');

  // Local mirror of renderer state so the controls re-render; initialized from the renderer getters.
  const [debugView, setDebugViewState] = useState<string>(() => renderer?.debugView ?? 'final');
  // EV100, not the raw multiplier: same storage, written the way a photographer writes it.
  const [ev100, setEv100] = useState<number>(() => renderer?.ev100 ?? 15);
  const [autoExposure, setAutoExposure] = useState<boolean>(() => renderer?.autoExposureEnabled ?? true);
  const [specularOcclusion, setSpecularOcclusion] = useState<boolean>(() => renderer?.specularOcclusionEnabled ?? true);
  const [specularAa, setSpecularAa] = useState<boolean>(() => renderer?.specularAaEnabled ?? true);
  const [horizonOcclusion, setHorizonOcclusion] = useState<boolean>(() => renderer?.horizonOcclusionEnabled ?? true);
  const [exposureComp, setExposureComp] = useState<number>(() => renderer?.exposureCompensation ?? 0);
  const [exposureMinEV, setExposureMinEV] = useState<number>(() => renderer?.exposureMinEV ?? 2);
  const [exposureMaxEV, setExposureMaxEV] = useState<number>(() => renderer?.exposureMaxEV ?? 17);
  const [exposureSpeedUp, setExposureSpeedUp] = useState<number>(() => renderer?.exposureSpeedUp ?? 3);
  const [exposureSpeedDown, setExposureSpeedDown] = useState<number>(() => renderer?.exposureSpeedDown ?? 1);
  const [bloomThreshold, setBloomThreshold] = useState<number>(() => renderer?.bloomThreshold ?? 1.0);
  const [bloomKnee, setBloomKnee] = useState<number>(() => renderer?.bloomKnee ?? 0.5);
  const [bloomIntensity, setBloomIntensity] = useState<number>(() => renderer?.bloomIntensity ?? 0.6);
  const [bloomMask, setBloomMask] = useState<boolean>(() => renderer?.bloomMaskEnabled ?? false);
  const [chromatic, setChromatic] = useState<number>(() => renderer?.chromaticAberrationStrength ?? 0);
  const [saturation, setSaturation] = useState<number>(() => renderer?.saturation ?? 1);
  const [toneMapper, setToneMapper] = useState<string>(() => renderer?.toneMapper ?? 'agx');
  const [lutId, setLutId] = useState<string | null>(() => renderer?.colorGradingLut ?? null);
  const [dofEnabled, setDofEnabled] = useState<boolean>(() => renderer?.dofEnabled ?? false);
  const [dofFocus, setDofFocus] = useState<number>(() => renderer?.dofFocusDistance ?? 10);
  const [dofRange, setDofRange] = useState<number>(() => renderer?.dofFocusRange ?? 0);
  const [dofAperture, setDofAperture] = useState<number>(() => renderer?.dofAperture ?? 2.8);
  const [dofMaxBlur, setDofMaxBlur] = useState<number>(() => renderer?.dofMaxBlur ?? 24);
  const [flare, setFlare] = useState<number>(() => renderer?.lensFlareIntensity ?? 0);
  const [flareThreshold, setFlareThreshold] = useState<number>(() => renderer?.lensFlareThreshold ?? 1);
  const [flareGhosts, setFlareGhosts] = useState<number>(() => renderer?.lensFlareGhosts ?? 4);
  const [flareHalo, setFlareHalo] = useState<number>(() => renderer?.lensFlareHaloWidth ?? 0.45);
  const [dirtId, setDirtId] = useState<string | null>(() => renderer?.lensDirtTexture ?? null);
  const [dirtIntensity, setDirtIntensity] = useState<number>(() => renderer?.lensDirtIntensity ?? 0);
  const [vignette, setVignette] = useState<number>(() => renderer?.vignetteStrength ?? 0);
  const [vignetteRound, setVignetteRound] = useState<number>(() => renderer?.vignetteRoundness ?? 0);
  const [vignetteSmooth, setVignetteSmooth] = useState<number>(() => renderer?.vignetteSmoothness ?? 0.4);
  const [grain, setGrain] = useState<number>(() => renderer?.filmGrainIntensity ?? 0);
  const [grainSize, setGrainSize] = useState<number>(() => renderer?.filmGrainSize ?? 2);
  const [grainColored, setGrainColored] = useState<boolean>(() => renderer?.filmGrainColored ?? false);
  const [lutIntensity, setLutIntensity] = useState<number>(() => renderer?.colorGradingIntensity ?? 1);
  const [ssaoEnabled, setSsaoEnabled] = useState<boolean>(() => renderer?.ssaoEnabled ?? true);
  const [ssaoRadius, setSsaoRadius] = useState<number>(() => renderer?.ssaoRadius ?? 0.5);
  const [ssaoPower, setSsaoPower] = useState<number>(() => renderer?.ssaoPower ?? 1.5);
  const [ssaoBias, setSsaoBias] = useState<number>(() => renderer?.ssaoBias ?? 0.025);
  const [gridVisible, setGridVisible] = useState<boolean>(() => renderer?.gridVisible ?? true);
  const [gridPlane, setGridPlane] = useState<string>(() => renderer?.gridPlane ?? 'xz');
  const [frustumCulling, setFrustumCulling] = useState<boolean>(() => renderer?.frustumCulling ?? true);
  const [foliageCullDistance, setFoliageCullDistance] = useState<number>(() => renderer?.foliageCullDistance ?? 65);
  const [foliageCellSize, setFoliageCellSize] = useState<number>(() => renderer?.foliageCellSize ?? 13);
  const [foliageDensity, setFoliageDensity] = useState<number>(() => renderer?.foliageDensityFalloff ?? 0.75);
  const [terrainLod, setTerrainLod] = useState<boolean>(() => renderer?.terrainLodEnabled ?? true);
  const [terrainLodDist1, setTerrainLodDist1] = useState<number>(() => renderer?.terrainLodDistance1 ?? 120);
  const [terrainLodDist2, setTerrainLodDist2] = useState<number>(() => renderer?.terrainLodDistance2 ?? 300);
  const [terrainLodStep1, setTerrainLodStep1] = useState<number>(() => renderer?.terrainLodStep1 ?? 2);
  const [terrainLodStep2, setTerrainLodStep2] = useState<number>(() => renderer?.terrainLodStep2 ?? 4);
  const [taa, setTaa] = useState<boolean>(() => renderer?.taaEnabled ?? true);
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
  const [pointShadows, setPointShadows] = useState<boolean>(() => renderer?.pointShadowsEnabled ?? true);
  const [pointShadowRes, setPointShadowRes] = useState<number>(() => renderer?.pointShadowResolution ?? 512);
  const [pointShadowDist, setPointShadowDist] = useState<number>(() => renderer?.pointShadowDistance ?? 50);
  const [pointShadowBias, setPointShadowBias] = useState<number>(() => renderer?.pointShadowBias ?? 0.0015);

  // Leaving Renderer mode (unmount) must restore the normal composited image for the other modes.
  useEffect(() => () => { if (renderer) renderer.debugView = 'final'; }, [renderer]);

  // Pull every mirrored value back off the renderer. Everything the renderer can change behind this
  // panel's back belongs here, not just what play/stop touches: a quality preset from the Performance
  // panel rewrites bloom, SSAO, motion blur and render scale in one move.
  const syncFromRenderer = useCallback(() => {
    if (!renderer) return;
    setDebugViewState(renderer.debugView);
    setEv100(renderer.ev100);
    setAutoExposure(renderer.autoExposureEnabled);
    setSpecularOcclusion(renderer.specularOcclusionEnabled);
    setSpecularAa(renderer.specularAaEnabled);
    setHorizonOcclusion(renderer.horizonOcclusionEnabled);
    setExposureComp(renderer.exposureCompensation);
    setExposureMinEV(renderer.exposureMinEV);
    setExposureMaxEV(renderer.exposureMaxEV);
    setExposureSpeedUp(renderer.exposureSpeedUp);
    setExposureSpeedDown(renderer.exposureSpeedDown);
    setBloomThreshold(renderer.bloomThreshold);
    setBloomKnee(renderer.bloomKnee);
    setBloomIntensity(renderer.bloomIntensity);
    setBloomMask(renderer.bloomMaskEnabled);
    setChromatic(renderer.chromaticAberrationStrength);
    setSaturation(renderer.saturation);
    setToneMapper(renderer.toneMapper);
    setLutId(renderer.colorGradingLut);
    setDofEnabled(renderer.dofEnabled);
    setDofFocus(renderer.dofFocusDistance);
    setDofRange(renderer.dofFocusRange);
    setDofAperture(renderer.dofAperture);
    setDofMaxBlur(renderer.dofMaxBlur);
    setFlare(renderer.lensFlareIntensity);
    setFlareThreshold(renderer.lensFlareThreshold);
    setFlareGhosts(renderer.lensFlareGhosts);
    setFlareHalo(renderer.lensFlareHaloWidth);
    setDirtId(renderer.lensDirtTexture);
    setDirtIntensity(renderer.lensDirtIntensity);
    setVignette(renderer.vignetteStrength);
    setVignetteRound(renderer.vignetteRoundness);
    setVignetteSmooth(renderer.vignetteSmoothness);
    setGrain(renderer.filmGrainIntensity);
    setGrainSize(renderer.filmGrainSize);
    setGrainColored(renderer.filmGrainColored);
    setLutIntensity(renderer.colorGradingIntensity);
    setSsaoEnabled(renderer.ssaoEnabled);
    setSsaoRadius(renderer.ssaoRadius);
    setSsaoPower(renderer.ssaoPower);
    setSsaoBias(renderer.ssaoBias);
    setGridVisible(renderer.gridVisible);
    setGridPlane(renderer.gridPlane);
    setFrustumCulling(renderer.frustumCulling);
    setFoliageCullDistance(renderer.foliageCullDistance);
    setFoliageCellSize(renderer.foliageCellSize);
    setFoliageDensity(renderer.foliageDensityFalloff);
    setTerrainLod(renderer.terrainLodEnabled);
    setTerrainLodDist1(renderer.terrainLodDistance1);
    setTerrainLodDist2(renderer.terrainLodDistance2);
    setTerrainLodStep1(renderer.terrainLodStep1);
    setTerrainLodStep2(renderer.terrainLodStep2);
    setTaa(renderer.taaEnabled);
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
    setPointShadows(renderer.pointShadowsEnabled);
    setPointShadowRes(renderer.pointShadowResolution);
    setPointShadowDist(renderer.pointShadowDistance);
    setPointShadowBias(renderer.pointShadowBias);
  }, [renderer]);

  // Play/stop resets debugView and toggles the grid on the renderer directly.
  useEffect(() => { syncFromRenderer(); }, [isPlayMode, syncFromRenderer]);

  // A quality preset moves a dozen knobs at once from a different panel; without this the mirror only
  // refreshes on remount and the two panels sit side by side disagreeing.
  useEffect(() => {
    engineEventBus.on('RENDER_SETTINGS_CHANGED', syncFromRenderer);
    return () => { engineEventBus.off('RENDER_SETTINGS_CHANGED', syncFromRenderer); };
  }, [syncFromRenderer]);

  // Bloom has kill switches this panel does not own: the Performance panel's per-pass toggles, and the
  // quality preset, which zeroes the intensity on tiers without bloom.
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
    // The content column is capped rather than filling the dock group (see PerformancePanel); the panel
    // itself stays resizable.
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
          onChange={(c) => { renderer.frustumCulling = c; setFrustumCulling(c); touch(); }} />
        <Field label='Foliage Dist'>
          <NumberInput value={foliageCullDistance} min={0} step={5} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.foliageCullDistance = v; setFoliageCullDistance(v); touch(); }} />
        </Field>
        <Field label='Cell Size'>
          <NumberInput value={foliageCellSize} min={1} step={4} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.foliageCellSize = v; setFoliageCellSize(v); touch(); }} />
        </Field>
        {/* Density scaling. LOD reduces what one instance COSTS; this reduces how many there are, and
            neither bounds a scatter on its own. 1 draws every instance. */}
        <Field label='Foliage Density'>
          <NumberInput value={foliageDensity} min={0.1} max={1} step={0.05} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.foliageDensityFalloff = v; setFoliageDensity(renderer.foliageDensityFalloff); touch(); }} />
        </Field>
        <Toggle label='Terrain LOD' checked={terrainLod} className='my-1'
          onChange={(c) => { renderer.terrainLodEnabled = c; setTerrainLod(c); touch(); }} />
        <Field label='LOD1 Dist'>
          <NumberInput value={terrainLodDist1} min={0} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.terrainLodDistance1 = v; setTerrainLodDist1(renderer.terrainLodDistance1); touch(); }} />
        </Field>
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>LOD1 Detail</span>
          <SegmentedControl
            value={terrainLodStep1}
            onChange={(step) => { renderer.terrainLodStep1 = step; setTerrainLodStep1(step); touch(); }}
            options={LOD_DETAIL.map((d) => ({ value: d.step, label: d.label, title: d.title }))}
          />
        </div>
        <Field label='LOD2 Dist'>
          <NumberInput value={terrainLodDist2} min={0} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.terrainLodDistance2 = v; setTerrainLodDist2(renderer.terrainLodDistance2); touch(); }} />
        </Field>
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>LOD2 Detail</span>
          <SegmentedControl
            value={terrainLodStep2}
            onChange={(step) => { renderer.terrainLodStep2 = step; setTerrainLodStep2(step); touch(); }}
            options={LOD_DETAIL.map((d) => ({ value: d.step, label: d.label, title: d.title }))}
          />
        </div>
      </Section>

      <Section title='Tone / Post' hint={'Exposure is written as a photographic EV100 — the same setting a light meter reads. '
        + 'It matters more than it used to: lights carry real photometric intensity, and the sun is about three decades '
        + 'brighter than a lamp, so one exposure can only meter one of them. A sunny exterior sits near EV 15, an '
        + 'interior near EV 5. Exposure is per-scene, so a cave and a hillside can each carry their own. '
        + 'The tone map is the curve that turns linear HDR into a displayable image, and it is the single biggest lever here: '
        + 'AgX rolls a saturated highlight toward white instead of clipping it to a primary, ACES is the older filmic fit '
        + 'every scene used before this control existed, and Khronos Neutral leaves in-gamut albedo untouched. '
        + 'Saturation is a trim applied in linear, before the tonemap, so the filmic shoulder still rolls off correctly — '
        + 'a Sky Light with clouds multiplies its own desaturation on top of this. AgX already desaturates highlights by '
        + 'construction, so the same trim reads stronger under it than under ACES. '
        + 'The colour LUT is a horizontal strip of N tiles, N by N each (256x16 or 1024x32): red runs left to right within '
        + 'a tile, green downward from the top row, blue across the tiles. It is applied AFTER the tone map, on the display '
        + 'colour, which is the space a .cube LUT from a grading tool was measured in. '
        + 'Chromatic aberration offsets the colour channels radially.'}>
        <Toggle label='Auto exposure' checked={autoExposure}
          onChange={(v) => { renderer.autoExposureEnabled = v; setAutoExposure(v); touch(); }} />
        {/* The manual slider is REPLACED rather than disabled while metering is on: a control that
            silently loses its value on the next frame is worse than one that is not there. The
            artist's handle is Compensation, which is how a camera works. */}
        {!autoExposure && <Slider label={`Exposure (EV ${ev100.toFixed(2)})`}
          value={ev100} min={-4} max={17} step={0.25}
          onChange={(v) => { renderer.ev100 = v; setEv100(v); touch(); }} />}
        {autoExposure && <>
          <Hint>Metered at EV {ev100.toFixed(2)}.</Hint>
          <Slider label='Compensation (stops)' value={exposureComp} min={-4} max={4} step={0.1}
            onChange={(v) => { renderer.exposureCompensation = v; setExposureComp(v); touch(); }} />
          <Slider label='Min EV' value={exposureMinEV} min={-4} max={17} step={0.5}
            onChange={(v) => { renderer.exposureMinEV = v; setExposureMinEV(v); touch(); }} />
          <Slider label='Max EV' value={exposureMaxEV} min={-4} max={20} step={0.5}
            onChange={(v) => { renderer.exposureMaxEV = v; setExposureMaxEV(v); touch(); }} />
          {/* SPEEDS, so right is faster — the same two controls Unreal exposes, under the same names
              and with its defaults (3 and 1). They were labelled as durations in seconds while the
              code treated them as a time constant, which made a higher number adapt SLOWER. */}
          <Slider label='Adaptation speed (to bright)' value={exposureSpeedUp} min={0} max={10} step={0.1}
            onChange={(v) => { renderer.exposureSpeedUp = v; setExposureSpeedUp(v); touch(); }} />
          <Slider label='Adaptation speed (to dark)' value={exposureSpeedDown} min={0} max={10} step={0.1}
            onChange={(v) => { renderer.exposureSpeedDown = v; setExposureSpeedDown(v); touch(); }} />
          <Hint>Higher adapts faster; 0 snaps with no easing. Eyes adjust to brightening
            faster than to darkening, which is why the two differ by default.</Hint>
        </>}
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Tone Map</span>
          <SegmentedControl
            value={toneMapper}
            onChange={(m) => { renderer.toneMapper = m; setToneMapper(m); touch(); }}
            options={TONE_MAPPERS}
          />
        </div>
        <Slider label='Saturation' value={saturation} min={0} max={2} step={0.01}
          onChange={(v) => { renderer.saturation = v; setSaturation(v); touch(); }} />
        <Slider label='Chromatic' value={chromatic} min={0} max={2} step={0.01}
          onChange={(v) => { renderer.chromaticAberrationStrength = v; setChromatic(v); touch(); }} />
        <Field label='Colour LUT'>
          <LutPicker value={lutId}
            onChange={(id) => { renderer.colorGradingLut = id; setLutId(id); touch(); }} />
        </Field>
        {/* Hidden rather than disabled with no LUT: there is nothing for it to blend toward. */}
        {lutId && <Slider label='LUT Amount' value={lutIntensity} min={0} max={1} step={0.01}
          onChange={(v) => { renderer.colorGradingIntensity = v; setLutIntensity(v); touch(); }} />}
      </Section>

      <Section
        title='Bloom'
        hint={'HDR bright-pass. Threshold is a luminance cutoff measured AFTER exposure, so it means '
            + '"bloom what would clip on screen"; knee softens the ramp. Restricting to lit surfaces uses '
            + "the scene buffer's alpha mask — sprites, tilemaps, transparents and unlit materials cannot "
            + 'set it, so they never bloom while it is on (see the Bloom Mask channel).'}
      >
        <Slider label='Threshold' value={bloomThreshold} min={0} max={5} step={0.05}
          onChange={(v) => { renderer.bloomThreshold = v; setBloomThreshold(v); touch(); }} />
        <Slider label='Knee' value={bloomKnee} min={0} max={2} step={0.05}
          onChange={(v) => { renderer.bloomKnee = v; setBloomKnee(v); touch(); }} />
        <Slider label='Intensity' value={bloomIntensity} min={0} max={3} step={0.05}
          onChange={(v) => { renderer.bloomIntensity = v; setBloomIntensity(v); touch(); }} />
        <Toggle label='Restrict to lit surfaces' checked={bloomMask}
          onChange={(v) => { renderer.bloomMaskEnabled = v; setBloomMask(v); touch(); }} />
        {bloomOff && <Hint>Bloom is currently inactive: {bloomOff}</Hint>}
      </Section>

      <Section
        title='Depth of Field'
        hint={'A thin lens with a real aperture, so the near field blurs harder than the far field and '
            + 'the far field settles at a fixed blur toward infinity. Aperture is written as an f-stop: '
            + 'smaller is wider, and shallower. A camera can name a Focus Target node in its inspector, '
            + 'which overrides the distance here and tracks that object instead.'}
      >
        <Toggle label='Enabled' checked={dofEnabled} className='my-1'
          onChange={(c) => { renderer.dofEnabled = c; setDofEnabled(c); touch(); }} />
        {dofEnabled && <>
          <Slider label='Focus Dist' value={dofFocus} min={0.1} max={100} step={0.1}
            readout={(v) => `${v.toFixed(1)} m`}
            onChange={(v) => { renderer.dofFocusDistance = v; setDofFocus(v); touch(); }} />
          <Slider label='Focus Range' value={dofRange} min={0} max={20} step={0.1}
            readout={(v) => (v <= 0 ? 'one plane' : `${v.toFixed(1)} m`)}
            onChange={(v) => { renderer.dofFocusRange = v; setDofRange(v); touch(); }} />
          <Slider label='Aperture' value={dofAperture} min={0.7} max={22} step={0.1}
            readout={(v) => `f/${v.toFixed(1)}`}
            onChange={(v) => { renderer.dofAperture = v; setDofAperture(v); touch(); }} />
          <Slider label='Max Blur' value={dofMaxBlur} min={0} max={64} step={1}
            readout={(v) => `${v.toFixed(0)} px`}
            onChange={(v) => { renderer.dofMaxBlur = v; setDofMaxBlur(v); touch(); }} />
        </>}
      </Section>

      <Section
        title='Lens Flare'
        hint={'Ghosts and a halo, traced from bright areas of the IMAGE rather than from the sun. That '
            + 'is what makes them occlude correctly: a sun behind a wall is not in the buffer, so it '
            + 'throws nothing. Threshold is the radiance a pixel must exceed before it flares.'}
      >
        <Slider label='Intensity' value={flare} min={0} max={2} step={0.01}
          onChange={(v) => { renderer.lensFlareIntensity = v; setFlare(v); touch(); }} />
        {flare > 0 && <>
          <Slider label='Threshold' value={flareThreshold} min={0} max={10} step={0.1}
            onChange={(v) => { renderer.lensFlareThreshold = v; setFlareThreshold(v); touch(); }} />
          <Slider label='Ghosts' value={flareGhosts} min={0} max={8} step={1}
            readout={(v) => v.toFixed(0)}
            onChange={(v) => { renderer.lensFlareGhosts = v; setFlareGhosts(renderer.lensFlareGhosts); touch(); }} />
          <Slider label='Halo' value={flareHalo} min={0} max={1} step={0.01}
            readout={(v) => (v <= 0 ? 'off' : v.toFixed(2))}
            onChange={(v) => { renderer.lensFlareHaloWidth = v; setFlareHalo(v); touch(); }} />
        </>}
      </Section>

      <Section
        title='Lens Dirt'
        hint={'Smudges on the front element, which brighten the bloom and flare that pass through them '
            + 'and are invisible everywhere else — so nothing shows until there is glare to catch. An '
            + 'overlay ships with the engine; leave the texture unset to use it.'}
      >
        <Slider label='Intensity' value={dirtIntensity} min={0} max={4} step={0.05}
          onChange={(v) => { renderer.lensDirtIntensity = v; setDirtIntensity(v); touch(); }} />
        {dirtIntensity > 0 && <Field label='Mask'>
          <TexturePicker value={dirtId} emptyLabel='(built-in)'
            onChange={(id) => { renderer.lensDirtTexture = id; setDirtId(id); touch(); }} />
        </Field>}
        {dirtIntensity > 0 && bloomOff && flare <= 0 &&
          <Hint>Nothing to catch: lens dirt only shows where bloom or lens flare put glare on the frame.</Hint>}
      </Section>

      <Section
        title='Vignette'
        hint={'The fall-off toward the corners every real lens has. Applied to linear radiance before '
            + 'the tone curve, so the corners are exposed down rather than crushed flat. Roundness 0 '
            + 'follows the frame shape, as a lens does; 1 is a circle.'}
      >
        <Slider label='Strength' value={vignette} min={0} max={1} step={0.01}
          onChange={(v) => { renderer.vignetteStrength = v; setVignette(v); touch(); }} />
        {vignette > 0 && <>
          <Slider label='Roundness' value={vignetteRound} min={0} max={1} step={0.01}
            onChange={(v) => { renderer.vignetteRoundness = v; setVignetteRound(v); touch(); }} />
          <Slider label='Smoothness' value={vignetteSmooth} min={0.01} max={1} step={0.01}
            onChange={(v) => { renderer.vignetteSmoothness = v; setVignetteSmooth(v); touch(); }} />
        </>}
      </Section>

      <Section
        title='Film Grain'
        hint={'Sensor and emulsion noise, weighted toward the midtones — black stays clean and a blown '
            + 'highlight does not sparkle, which is what separates grain from video noise. Animated, '
            + 'because a fixed pattern reads as dirt on the screen rather than as film.'}
      >
        <Slider label='Intensity' value={grain} min={0} max={0.5} step={0.005}
          onChange={(v) => { renderer.filmGrainIntensity = v; setGrain(v); touch(); }} />
        {grain > 0 && <>
          <Slider label='Size' value={grainSize} min={1} max={6} step={0.1}
            readout={(v) => `${v.toFixed(1)} px`}
            onChange={(v) => { renderer.filmGrainSize = v; setGrainSize(v); touch(); }} />
          <Toggle label='Coloured' checked={grainColored}
            onChange={(c) => { renderer.filmGrainColored = c; setGrainColored(c); touch(); }} />
        </>}
      </Section>

      <Section
        title='Antialiasing'
        hint={'Temporal antialiasing: the projection is offset by a fraction of a pixel each frame and '
            + 'the results are accumulated, so a still image converges on about eight times the '
            + 'sampling. Motion vectors carry the history across camera and object movement; the editor '
            + 'grid, gizmos and sprites are drawn afterwards and are never blended.'}
      >
        <Toggle label='Temporal AA' checked={taa} className='my-1'
          onChange={(c) => { renderer.taaEnabled = c; setTaa(c); touch(); }} />
        {taa && !renderer.taaSupported &&
          <Hint>Disabled on this device: float render targets are unavailable, so the history and
            velocity buffers cannot hold the values TAA needs.</Hint>}
      </Section>

      <Section title='Motion Blur' hint='Camera-reprojection motion blur (UE5-style). Amount scales the shutter length.'>
        <Toggle label='Enabled' checked={motionBlur} className='my-1'
          onChange={(c) => { renderer.motionBlurEnabled = c; setMotionBlur(c); touch(); }} />
        <Slider label='Amount' value={motionBlurIntensity} min={0} max={4} step={0.05}
          onChange={(v) => { renderer.motionBlurIntensity = v; setMotionBlurIntensity(v); touch(); }} />
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Quality</span>
          <SegmentedControl
            value={motionBlurSamples}
            onChange={(samples) => { renderer.motionBlurSamples = samples; setMotionBlurSamples(samples); touch(); }}
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
          onChange={(c) => { renderer.shadowsEnabled = c; setShadowsEnabled(c); touch(); }} />

        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Resolution</span>
          <SegmentedControl
            value={shadowRes}
            onChange={(size) => { renderer.shadowMapResolution = size; setShadowRes(renderer.shadowMapResolution); touch(); }}
            options={SHADOW_RES.map((r) => ({ value: r.size, label: r.label, title: r.title }))}
          />
        </div>
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Cascades</span>
          <SegmentedControl
            value={shadowCascades}
            onChange={(n) => { renderer.shadowCascades = n; setShadowCascades(renderer.shadowCascades); touch(); }}
            options={SHADOW_CASCADES}
          />
        </div>
        <Field label='Distance'>
          <NumberInput value={shadowDistance} min={1} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.shadowDistance = v; setShadowDistance(renderer.shadowDistance); touch(); }} />
        </Field>
        <Slider label='Split &#955;' value={shadowLambda} min={0} max={1} step={0.05}
          onChange={(v) => { renderer.shadowSplitLambda = v; setShadowLambda(v); touch(); }} />

        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Filter</span>
          <SegmentedControl
            value={shadowFilterMode}
            onChange={(m) => { renderer.shadowFilterMode = m; setShadowFilterMode(renderer.shadowFilterMode); touch(); }}
            options={SHADOW_FILTER.map((f) => ({ value: f.mode, label: f.label, title: f.title }))}
          />
        </div>
        <Slider label='Softness' value={shadowSoftness} min={0} max={8} step={0.25}
          readout={(v) => (v <= 0 ? 'hard' : `${v.toFixed(2)} px`)}
          onChange={(v) => { renderer.shadowFilterRadius = v; setShadowSoftness(v); touch(); }} />
        <Slider label='Strength' value={shadowStrength} min={0} max={1} step={0.05}
          onChange={(v) => { renderer.shadowStrength = v; setShadowStrength(v); touch(); }} />
        <Slider label='Blend' value={shadowBlend} min={0} max={0.5} step={0.01}
          onChange={(v) => { renderer.shadowCascadeBlend = v; setShadowBlend(v); touch(); }} />

        <Slider label='Depth Bias' value={shadowDepthBias} min={0} max={0.5} step={0.005}
          onChange={(v) => { renderer.shadowDepthBias = v; setShadowDepthBias(v); touch(); }} />
        <Slider label='Normal Bias' value={shadowNormalBias} min={0} max={8} step={0.1}
          onChange={(v) => { renderer.shadowNormalBias = v; setShadowNormalBias(v); touch(); }} />

        <Toggle label='Stabilize' checked={shadowStabilize} className='my-1'
          onChange={(c) => { renderer.shadowStabilize = c; setShadowStabilize(c); touch(); }} />
        <Toggle label='Stagger Updates' checked={shadowStagger} className='my-1'
          onChange={(c) => { renderer.shadowStagger = c; setShadowStagger(c); touch(); }} />
        <Field label='Caster Pad'>
          <NumberInput value={shadowCasterPad} min={0} step={5} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.shadowCasterPad = v; setShadowCasterPad(renderer.shadowCasterPad); touch(); }} />
        </Field>

        {debugView === 'shadow' && (
          <div className='flex items-center gap-1 my-1 text-xs'>
            <span className='w-[70px] shrink-0'>View Layer</span>
            <SegmentedControl
              value={shadowDebugLayer}
              onChange={(n) => { renderer.shadowDebugLayer = n; setShadowDebugLayer(renderer.shadowDebugLayer); touch(); }}
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
          onChange={(c) => { renderer.spotShadowsEnabled = c; setSpotShadows(c); touch(); }} />
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Resolution</span>
          <SegmentedControl
            value={spotShadowRes}
            onChange={(size) => { renderer.spotShadowResolution = size; setSpotShadowRes(renderer.spotShadowResolution); touch(); }}
            options={SPOT_RES.map((r) => ({ value: r.size, label: r.label }))}
          />
        </div>
        <Field label='Max Dist'>
          <NumberInput value={spotShadowDist} min={1} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.spotShadowDistance = v; setSpotShadowDist(renderer.spotShadowDistance); touch(); }} />
        </Field>
        <Slider label='Bias' value={spotShadowBias} min={0} max={0.02} step={0.0005}
          readout={(v) => v.toFixed(4)}
          onChange={(v) => { renderer.spotShadowBias = v; setSpotShadowBias(v); touch(); }} />
        {!shadowsEnabled && <Hint>The global Shadows toggle above is off, which also disables these.</Hint>}
      </Section>

      <Section
        title='Point Shadows'
        hint={`Up to ${renderer.maxPointShadows} point lights cast at once — flag them per light with `
            + `Cast Shadows in the inspector. A point light shadows in every direction, so it costs SIX `
            + `depth passes (one per cube face) where a spot light costs one; that is why the cap is low `
            + `and Resolution is per FACE. The lights nearest the camera get the maps, and only lights `
            + `whose range reaches the view are drawn at all — a light and its surroundings that have `
            + `not moved keep the maps they already have, so a static lamp is free after the first `
            + `frame. Bias is in DEPTH units, like Spot.`}
      >
        <Toggle label='Enabled' checked={pointShadows} className='my-1'
          onChange={(c) => { renderer.pointShadowsEnabled = c; setPointShadows(c); touch(); }} />
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Resolution</span>
          <SegmentedControl
            value={pointShadowRes}
            onChange={(size) => { renderer.pointShadowResolution = size; setPointShadowRes(renderer.pointShadowResolution); touch(); }}
            options={POINT_RES.map((r) => ({ value: r.size, label: r.label }))}
          />
        </div>
        <Field label='Max Dist'>
          <NumberInput value={pointShadowDist} min={1} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.pointShadowDistance = v; setPointShadowDist(renderer.pointShadowDistance); touch(); }} />
        </Field>
        <Slider label='Bias' value={pointShadowBias} min={0} max={0.02} step={0.0005}
          readout={(v) => v.toFixed(4)}
          onChange={(v) => { renderer.pointShadowBias = v; setPointShadowBias(v); touch(); }} />
        {!shadowsEnabled && <Hint>The global Shadows toggle above is off, which also disables these.</Hint>}
      </Section>

      <Section title='SSAO' hint='Screen-space ambient occlusion, deferred path only. Radius is in world units; Power sharpens the falloff; Bias lifts the sample off the surface to stop it occluding itself.'>
        <Toggle label='Enabled' checked={ssaoEnabled} className='my-1'
          onChange={(c) => { renderer.ssaoEnabled = c; setSsaoEnabled(c); touch(); }} />
        <Slider label='Radius' value={ssaoRadius} min={0} max={2} step={0.05}
          onChange={(v) => { renderer.ssaoRadius = v; setSsaoRadius(v); touch(); }} />
        <Slider label='Power' value={ssaoPower} min={0} max={5} step={0.1}
          onChange={(v) => { renderer.ssaoPower = v; setSsaoPower(v); touch(); }} />
        <Slider label='Bias' value={ssaoBias} min={0} max={0.2} step={0.005}
          onChange={(v) => { renderer.ssaoBias = v; setSsaoBias(v); touch(); }} />
      </Section>

      <Section title='Shading'
        hint={'Three corrections to how the specular lobe behaves, all on by default and all all but '
            + 'invisible on rough surfaces by design — they act where the highlight is sharp. '
            + 'Specular occlusion asks how much of the narrow reflection CONE is blocked rather than '
            + 'the whole hemisphere, so a polished floor in a corner keeps the reflection of the room. '
            + 'Specular AA widens roughness by the sub-pixel variance of the normal, which is what '
            + 'stops a sharp highlight flickering as it moves — MSAA cannot fix that, because the '
            + 'aliasing is in the shading rather than the coverage. Horizon occlusion drops the '
            + 'reflection where a normal map has tilted it INTO the surface, which is the wet-looking '
            + 'rim on strongly normal-mapped materials seen at an angle. Turn one off to see what it '
            + 'was doing.'}>
        <Toggle label='Specular occlusion' checked={specularOcclusion} className='my-1'
          onChange={(c) => { renderer.specularOcclusionEnabled = c; setSpecularOcclusion(c); touch(); }} />
        <Toggle label='Specular antialiasing' checked={specularAa} className='my-1'
          onChange={(c) => { renderer.specularAaEnabled = c; setSpecularAa(c); touch(); }} />
        <Toggle label='Horizon occlusion' checked={horizonOcclusion} className='my-1'
          onChange={(c) => { renderer.horizonOcclusionEnabled = c; setHorizonOcclusion(c); touch(); }} />
      </Section>

      <Section title='Grid' hint='Editor-only reference grid. Never rendered in a published game.'>
        <Toggle label='Visible' checked={gridVisible} className='my-1'
          onChange={(c) => { renderer.setGridVisible(c); setGridVisible(c); touch(); }} />
        <div className='flex items-center gap-1 my-1 text-xs'>
          <span className='w-[70px] shrink-0'>Plane</span>
          <SegmentedControl
            value={gridPlane}
            onChange={(p) => { renderer.setGridPlane(p); setGridPlane(p); touch(); }}
            itemClassName='uppercase'
            options={[{ value: 'xz', label: 'XZ' }, { value: 'xy', label: 'XY' }]}
          />
        </div>
      </Section>
      </div>
    </div>
  );
}
