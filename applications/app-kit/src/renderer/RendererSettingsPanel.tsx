import { useCallback, useEffect, useState } from 'react';
import {
  engineEventBus, TERRAIN_LAYER_TEXTURE_SIZES, AUTO_EXPOSURE_PRESETS, LENS_LOOK_PRESETS, DOF_PRESETS, applyPreset,
} from 'cleo';
import type { ExposureCurveKey, Preset } from 'cleo';
import { useEngineHost } from '../engine/EngineHost';
import { DocScope, Section, Slider, Toggle, Field, NumberInput, PresetMenu, SegmentedControl, Select, Hint, TexturePicker, cn, labelClass } from '../ui';

// The renderer's labels ("Foliage Density", "LOD1 Detail") are longer than the inspector's; at the shared
// 12px they wrap in Field's default 70px column.
const LABEL_W = 'w-[112px]';
import BackendSelector from './BackendSelector';
import ExposureSettingsFields from './ExposureSettingsFields';

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
  { key: 'ssil',      label: 'Indirect' },
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

// Spot-light shadow map resolution. One map per casting spot light, redrawn whenever something in its
// cone moves, with no cascade-style stagger, so this ladder tops out lower than the cascades'.
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
  const { instance, isPlayMode, eventEmitter } = useEngineHost();
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
  const [debugValidity, setDebugValidity] = useState<boolean>(() => renderer?.debugValidity ?? false);
  // EV100, not the raw multiplier: same storage, written the way a photographer writes it.
  const [ev100, setEv100] = useState<number>(() => renderer?.ev100 ?? 15);
  const [autoExposure, setAutoExposure] = useState<boolean>(() => renderer?.autoExposureEnabled ?? true);
  const [specularOcclusion, setSpecularOcclusion] = useState<boolean>(() => renderer?.specularOcclusionEnabled ?? true);
  const [specularAa, setSpecularAa] = useState<boolean>(() => renderer?.specularAaEnabled ?? true);
  const [horizonOcclusion, setHorizonOcclusion] = useState<boolean>(() => renderer?.horizonOcclusionEnabled ?? true);
  const [exposureComp, setExposureComp] = useState<number>(() => renderer?.exposureCompensation ?? 1);
  const [exposureCurve, setExposureCurve] = useState<ExposureCurveKey[]>(() => renderer?.exposureCompensationCurve ?? []);
  const [exposureMinEV, setExposureMinEV] = useState<number>(() => renderer?.exposureMinEV ?? 2);
  const [exposureMaxEV, setExposureMaxEV] = useState<number>(() => renderer?.exposureMaxEV ?? 17);
  const [exposureSpeedUp, setExposureSpeedUp] = useState<number>(() => renderer?.exposureSpeedUp ?? 3);
  const [exposureSpeedDown, setExposureSpeedDown] = useState<number>(() => renderer?.exposureSpeedDown ?? 1);
  const [bloomThreshold, setBloomThreshold] = useState<number>(() => renderer?.bloomThreshold ?? 2.0);
  const [bloomKnee, setBloomKnee] = useState<number>(() => renderer?.bloomKnee ?? 0.5);
  const [bloomIntensity, setBloomIntensity] = useState<number>(() => renderer?.bloomIntensity ?? 0.35);
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
  const [ssaoThickness, setSsaoThickness] = useState<number>(() => renderer?.ssaoThickness ?? 0.25);
  const [ssilEnabled, setSsilEnabled] = useState<boolean>(() => renderer?.ssilEnabled ?? true);
  const [ssilIntensity, setSsilIntensity] = useState<number>(() => renderer?.ssilIntensity ?? 1);
  const [gridVisible, setGridVisible] = useState<boolean>(() => renderer?.gridVisible ?? true);
  const [gridPlane, setGridPlane] = useState<string>(() => renderer?.gridPlane ?? 'xz');
  const [frustumCulling, setFrustumCulling] = useState<boolean>(() => renderer?.frustumCulling ?? true);
  const [occlusionCulling, setOcclusionCulling] = useState<'off' | 'terrain' | 'all'>(() => renderer?.occlusionCulling ?? 'all');
  const [occlusionQueries, setOcclusionQueries] = useState<boolean>(() => renderer?.occlusionQueries ?? true);
  const [lightOcclusion, setLightOcclusion] = useState<boolean>(() => renderer?.lightOcclusionCulling ?? true);
  const [foliageShadowDistance, setFoliageShadowDistance] = useState<number>(() => renderer?.foliageShadowDistance ?? 0);
  const [foliagePrepass, setFoliagePrepass] = useState<boolean>(() => renderer?.foliagePrepass ?? false);
  const [foliageGpuCulling, setFoliageGpuCulling] = useState<boolean>(() => renderer?.foliageGpuCulling ?? true);
  const [foliageCullDistance, setFoliageCullDistance] = useState<number>(() => renderer?.foliageCullDistance ?? 65);
  const [particleLodScale, setParticleLodScale] = useState<number>(() => renderer?.particleLodDistanceScale ?? 1);
  const [foliageCellSize, setFoliageCellSize] = useState<number>(() => renderer?.foliageCellSize ?? 13);
  const [foliageDensity, setFoliageDensity] = useState<number>(() => renderer?.foliageDensityFalloff ?? 0.75);
  const [terrainLod, setTerrainLod] = useState<boolean>(() => renderer?.terrainLodEnabled ?? true);
  const [layerTexSize, setLayerTexSize] = useState<number>(() => renderer?.terrainLayerTextureSize ?? 1024);
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
  const [shadowFarDistance, setShadowFarDistance] = useState<number>(() => renderer?.shadowFarDistance ?? 0);
  const [shadowDebugLayer, setShadowDebugLayer] = useState<number>(() => renderer?.shadowDebugLayer ?? 0);
  const [spotShadows, setSpotShadows] = useState<boolean>(() => renderer?.spotShadowsEnabled ?? true);
  const [spotShadowRes, setSpotShadowRes] = useState<number>(() => renderer?.spotShadowResolution ?? 1024);
  const [spotShadowDist, setSpotShadowDist] = useState<number>(() => renderer?.spotShadowDistance ?? 100);
  const [spotShadowBias, setSpotShadowBias] = useState<number>(() => renderer?.spotShadowBias ?? 0.0015);
  const [pointShadows, setPointShadows] = useState<boolean>(() => renderer?.pointShadowsEnabled ?? true);
  const [pointShadowRes, setPointShadowRes] = useState<number>(() => renderer?.pointShadowResolution ?? 512);
  const [pointShadowDist, setPointShadowDist] = useState<number>(() => renderer?.pointShadowDistance ?? 50);
  const [pointShadowBias, setPointShadowBias] = useState<number>(() => renderer?.pointShadowBias ?? 0.0015);

  // Leaving Options › Engine › Renderer (unmount) must restore the normal composited image for the other modes.
  useEffect(() => () => {
    if (!renderer) return;
    renderer.debugView = 'final';
    renderer.debugValidity = false;
  }, [renderer]);

  // Pull every mirrored value back off the renderer. Everything the renderer can change behind this
  // panel's back belongs here, not just what play/stop touches: a quality preset from the Performance
  // panel rewrites bloom, SSAO, motion blur and render scale in one move.
  const syncFromRenderer = useCallback(() => {
    if (!renderer) return;
    setDebugViewState(renderer.debugView);
    setDebugValidity(renderer.debugValidity);
    setEv100(renderer.ev100);
    setAutoExposure(renderer.autoExposureEnabled);
    setSpecularOcclusion(renderer.specularOcclusionEnabled);
    setSpecularAa(renderer.specularAaEnabled);
    setHorizonOcclusion(renderer.horizonOcclusionEnabled);
    setExposureComp(renderer.exposureCompensation);
    setExposureCurve(renderer.exposureCompensationCurve);
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
    setSsaoThickness(renderer.ssaoThickness);
    setSsilEnabled(renderer.ssilEnabled);
    setSsilIntensity(renderer.ssilIntensity);
    setGridVisible(renderer.gridVisible);
    setGridPlane(renderer.gridPlane);
    setFrustumCulling(renderer.frustumCulling);
    setOcclusionCulling(renderer.occlusionCulling);
    setOcclusionQueries(renderer.occlusionQueries);
    setLightOcclusion(renderer.lightOcclusionCulling);
    setFoliageShadowDistance(renderer.foliageShadowDistance);
    setFoliagePrepass(renderer.foliagePrepass);
    setFoliageGpuCulling(renderer.foliageGpuCulling);
    setFoliageCullDistance(renderer.foliageCullDistance);
    setParticleLodScale(renderer.particleLodDistanceScale);
    setFoliageCellSize(renderer.foliageCellSize);
    setFoliageDensity(renderer.foliageDensityFalloff);
    setTerrainLod(renderer.terrainLodEnabled);
    setLayerTexSize(renderer.terrainLayerTextureSize);
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
    setShadowFarDistance(renderer.shadowFarDistance);
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
  // While metering, the EV moves every frame on its own: follow it, so the "Metered at" readout and the
  // compensation curve's "now" line show where the scene actually sits.
  useEffect(() => {
    if (!renderer || !autoExposure) return;
    const id = window.setInterval(() => setEv100(renderer.ev100), 250);
    return () => window.clearInterval(id);
  }, [renderer, autoExposure]);

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

  if (!renderer) return <div className='p-3 text-muted text-ui'>Renderer not ready.</div>;

  const setDebug = (key: string) => { renderer.debugView = key; setDebugViewState(key); };
  // Beside `setDebug`, and NOT marking the scene dirty for the same reason it does not: both are ways
  // of LOOKING at a scene rather than part of it, and neither is persisted (asserted in
  // tests/renderSettingsPersistence.test.ts).
  const setValidity = (on: boolean) => { renderer.debugValidity = on; setDebugValidity(on); };

  // A preset is a dozen setter writes in one click, so re-read the whole mirror rather than track which.
  const applyRenderPreset = <O extends object>(table: readonly Preset<O>[], p: Preset<O>) => {
    applyPreset(renderer, table, p);
    syncFromRenderer();
    touch();
  };

  return (
    // Each section is a heading of docs/editor/rendering.md › Renderer Settings, and the fields its docs
    // table names take their cards from that table: the explanation lives there, not in hints here.
    // The content column is capped rather than filling the dock group (see PerformancePanel); the panel
    // itself stays resizable.
    <DocScope page='editor/rendering'>
    <div className='h-full overflow-y-auto p-3 text-ui-sm text-fg'>
      <div className='w-full max-w-[420px]'>
      <Section title='Graphics API'>
        <BackendSelector />
      </Section>

      <Section title='Channels'>
        <SegmentedControl
          className='grid grid-cols-3 gap-1'
          size='sm'
          value={debugView}
          onChange={setDebug}
          options={CHANNELS.map(({ key, label }) => ({ value: key, label, title: label }))}
        />
        {/* A modifier on the channel above, not a channel of its own: "which buffer first holds the
            bad value" has to be asked of each one in turn. Magenta = NaN, orange = Inf (on an
            rgba16float target that usually means a value over 65504 on store, not a division),
            cyan = a negative where the channel's encoding forbids one. */}
        <Toggle label='Highlight Invalid Pixels' checked={debugValidity} className='mt-2'
          onChange={setValidity} />
      </Section>

      <Section title='Optimizations'>
        <Toggle label='Frustum Culling' checked={frustumCulling} className='my-1'
          onChange={(c) => { renderer.frustumCulling = c; setFrustumCulling(c); touch(); }} />
        {/* CPU occlusion culling (graphics/occlusion): what is behind a hill, or behind an Occluder volume,
            is skipped before it is drawn. Conservative by construction, so it never hides what can be seen. */}
        <div className='flex items-center gap-1 my-1 text-ui'
             title='Skip models and foliage hidden behind the landscape (Terrain) or behind the landscape and Occluder volumes (All). Needs Frustum Culling on.'>
          <span className={cn(labelClass, LABEL_W, 'shrink-0')}>Occlusion</span>
          <SegmentedControl
            value={occlusionCulling}
            onChange={(mode) => { renderer.occlusionCulling = mode; setOcclusionCulling(mode); touch(); }}
            options={[
              { value: 'off' as const, label: 'Off', title: 'No occlusion culling' },
              { value: 'terrain' as const, label: 'Terrain', title: 'Hidden behind the landscape' },
              { value: 'all' as const, label: 'All', title: 'Hidden behind the landscape or an Occluder volume' },
            ]}
          />
        </div>
        <Toggle label='GPU Occlusion Queries' checked={occlusionQueries} className='my-1'
          disabled={occlusionCulling === 'off'}
          title='Also ask the GPU which large or heavy objects are hidden behind what was actually drawn — a building, a cliff, a rock — not just the landscape and Occluder volumes. Results arrive a frame or two late, so an object can appear a frame late when what hid it moves away fast.'
          onChange={(c) => { renderer.occlusionQueries = c; setOcclusionQueries(c); touch(); }} />
        <Toggle label='Light Occlusion' checked={lightOcclusion} className='my-1'
          disabled={occlusionCulling === 'off' || !occlusionQueries}
          title='Leave out every point and spot light whose whole reach is hidden behind what was drawn — the torch in the next room — so it takes no lighting work and no shadow map. Like the queries, a light can come back a frame late.'
          onChange={(c) => { renderer.lightOcclusionCulling = c; setLightOcclusion(c); touch(); }} />
        <Field labelClassName={LABEL_W} label='Foliage Dist'>
          <NumberInput value={foliageCullDistance} min={0} step={5} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.foliageCullDistance = v; setFoliageCullDistance(v); touch(); }} />
        </Field>
        <Field labelClassName={LABEL_W} label='Foliage Shadow'>
          <NumberInput value={foliageShadowDistance} min={0} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.foliageShadowDistance = v; setFoliageShadowDistance(renderer.foliageShadowDistance); touch(); }} />
        </Field>
        <Toggle label='Foliage Prepass' checked={foliagePrepass} className='my-1'
          title='Write the depth of alpha-tested mesh foliage first, then shade each pixel once. Saves fragment work where foliage overlaps heavily, costs a second vertex pass: compare the foliage GPU row with it on and off.'
          onChange={(c) => { renderer.foliagePrepass = c; setFoliagePrepass(c); touch(); }} />
        <Toggle label='GPU Foliage Culling' checked={foliageGpuCulling && renderer.foliageGpuCullingSupported} className='my-1'
          disabled={!renderer.foliageGpuCullingSupported}
          title={renderer.foliageGpuCullingSupported
            ? 'Cull every foliage instance on the GPU — each one faded out of its detail band or off screen is dropped before a vertex of it runs — and draw indirectly, with no instance upload per frame.'
            : 'Needs WebGPU (compute and indirect draws). On WebGL2 foliage is culled per cell and packed on the CPU.'}
          onChange={(c) => { renderer.foliageGpuCulling = c; setFoliageGpuCulling(c); touch(); }} />
        <Field labelClassName={LABEL_W} label='Cell Size'>
          <NumberInput value={foliageCellSize} min={1} step={4} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.foliageCellSize = v; setFoliageCellSize(v); touch(); }} />
        </Field>
        {/* Density scaling, for GRASS (billboard) layers only: dropping trees at a LOD switch is a
            visible pop, so mesh props are never thinned. 1 draws every instance. */}
        <Field labelClassName={LABEL_W} label='Grass Density'>
          <NumberInput value={foliageDensity} min={0.1} max={1} step={0.05} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.foliageDensityFalloff = v; setFoliageDensity(renderer.foliageDensityFalloff); touch(); }} />
        </Field>
        {/* Each .vfx authors its own LOD distances; this stretches or shrinks all of them at once. */}
        <Slider label='Particle LOD' labelClassName={LABEL_W} min={0.25} max={4} step={0.05} value={particleLodScale}
          title="Multiplies every particle effect's LOD and cull distances: 2 keeps full detail twice as far, 0.5 thins effects sooner. Set by the quality tier."
          readout={v => `×${v.toFixed(2)}`}
          onChange={(v) => { renderer.particleLodDistanceScale = v; setParticleLodScale(renderer.particleLodDistanceScale); touch(); }} />
        <Toggle label='Terrain LOD' checked={terrainLod} className='my-1'
          onChange={(c) => { renderer.terrainLodEnabled = c; setTerrainLod(c); touch(); }} />
        <Field labelClassName={LABEL_W} label='LOD1 Dist'>
          <NumberInput value={terrainLodDist1} min={0} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.terrainLodDistance1 = v; setTerrainLodDist1(renderer.terrainLodDistance1); touch(); }} />
        </Field>
        <div className='flex items-center gap-1 my-1 text-ui'>
          <span className={cn(labelClass, LABEL_W, 'shrink-0')}>LOD1 Detail</span>
          <SegmentedControl
            value={terrainLodStep1}
            onChange={(step) => { renderer.terrainLodStep1 = step; setTerrainLodStep1(step); touch(); }}
            options={LOD_DETAIL.map((d) => ({ value: d.step, label: d.label, title: d.title }))}
          />
        </div>
        <Field labelClassName={LABEL_W} label='LOD2 Dist'>
          <NumberInput value={terrainLodDist2} min={0} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.terrainLodDistance2 = v; setTerrainLodDist2(renderer.terrainLodDistance2); touch(); }} />
        </Field>
        <div className='flex items-center gap-1 my-1 text-ui'>
          <span className={cn(labelClass, LABEL_W, 'shrink-0')}>LOD2 Detail</span>
          <SegmentedControl
            value={terrainLodStep2}
            onChange={(step) => { renderer.terrainLodStep2 = step; setTerrainLodStep2(step); touch(); }}
            options={LOD_DETAIL.map((d) => ({ value: d.step, label: d.label, title: d.title }))}
          />
        </div>
        {/* Every landscape surface is resampled into ONE texture array, and an array has ONE size — so
            this is the size they all get, not a per-material choice. Changing it re-bakes them. */}
        <Field labelClassName={LABEL_W} label='Surface Tex'>
          <SegmentedControl
            value={layerTexSize}
            onChange={(size) => { renderer.terrainLayerTextureSize = size; setLayerTexSize(renderer.terrainLayerTextureSize); touch(); }}
            options={TERRAIN_LAYER_TEXTURE_SIZES.map((n) => ({
              value: n, label: `${n}`,
              title: `Resample every landscape surface to ${n}x${n}. They share one texture array, so they share one size.`,
            }))}
          />
        </Field>
      </Section>

      <Section title='Tone / Post'
        right={<>
          <PresetMenu label='Exposure' presets={AUTO_EXPOSURE_PRESETS}
            title='Exposure presets — metered ranges and adaptation, or a fixed EV'
            onApply={(p) => applyRenderPreset(AUTO_EXPOSURE_PRESETS, p)} />
          <PresetMenu label='Look' presets={LENS_LOOK_PRESETS}
            title='Lens looks — bloom, flare, dirt, vignette, grain, fringing and saturation; the tone map and LUT stay yours'
            onApply={(p) => applyRenderPreset(LENS_LOOK_PRESETS, p)} />
        </>}>
        <ExposureSettingsFields labelClassName={LABEL_W} meteredEV={ev100}
          values={{
            autoExposureEnabled: autoExposure, ev100, exposureCompensation: exposureComp,
            exposureCompensationCurve: exposureCurve, exposureMinEV, exposureMaxEV, exposureSpeedUp, exposureSpeedDown,
          }}
          onChange={(p) => {
            if (p.autoExposureEnabled !== undefined) { renderer.autoExposureEnabled = p.autoExposureEnabled; setAutoExposure(p.autoExposureEnabled); }
            if (p.ev100 !== undefined) { renderer.ev100 = p.ev100; setEv100(p.ev100); }
            if (p.exposureCompensation !== undefined) { renderer.exposureCompensation = p.exposureCompensation; setExposureComp(p.exposureCompensation); }
            if (p.exposureCompensationCurve !== undefined) { renderer.exposureCompensationCurve = p.exposureCompensationCurve; setExposureCurve(renderer.exposureCompensationCurve); }
            if (p.exposureMinEV !== undefined) { renderer.exposureMinEV = p.exposureMinEV; setExposureMinEV(p.exposureMinEV); }
            if (p.exposureMaxEV !== undefined) { renderer.exposureMaxEV = p.exposureMaxEV; setExposureMaxEV(p.exposureMaxEV); }
            if (p.exposureSpeedUp !== undefined) { renderer.exposureSpeedUp = p.exposureSpeedUp; setExposureSpeedUp(p.exposureSpeedUp); }
            if (p.exposureSpeedDown !== undefined) { renderer.exposureSpeedDown = p.exposureSpeedDown; setExposureSpeedDown(p.exposureSpeedDown); }
            touch();
          }} />
        <div className='flex items-center gap-1 my-1 text-ui'>
          <span className={cn(labelClass, LABEL_W, 'shrink-0')}>Tone Map</span>
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
        <Field labelClassName={LABEL_W} label='Colour LUT'>
          <LutPicker value={lutId}
            onChange={(id) => { renderer.colorGradingLut = id; setLutId(id); touch(); }} />
        </Field>
        {/* Hidden rather than disabled with no LUT: there is nothing for it to blend toward. */}
        {lutId && <Slider label='LUT Amount' value={lutIntensity} min={0} max={1} step={0.01}
          onChange={(v) => { renderer.colorGradingIntensity = v; setLutIntensity(v); touch(); }} />}
      </Section>

      <Section title='Bloom'>
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
        right={<PresetMenu presets={DOF_PRESETS} title='Depth-of-field presets — the focus distance stays yours'
          onApply={(p) => applyRenderPreset(DOF_PRESETS, p)} />}
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

      <Section title='Lens Flare'>
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

      <Section title='Lens Dirt'>
        <Slider label='Intensity' value={dirtIntensity} min={0} max={4} step={0.05}
          onChange={(v) => { renderer.lensDirtIntensity = v; setDirtIntensity(v); touch(); }} />
        {dirtIntensity > 0 && <Field labelClassName={LABEL_W} label='Mask'>
          <TexturePicker value={dirtId} emptyLabel='(built-in)'
            onChange={(id) => { renderer.lensDirtTexture = id; setDirtId(id); touch(); }} />
        </Field>}
        {dirtIntensity > 0 && bloomOff && flare <= 0 &&
          <Hint>Nothing to catch: lens dirt only shows where bloom or lens flare put glare on the frame.</Hint>}
      </Section>

      <Section title='Vignette'>
        <Slider label='Strength' value={vignette} min={0} max={1} step={0.01}
          onChange={(v) => { renderer.vignetteStrength = v; setVignette(v); touch(); }} />
        {vignette > 0 && <>
          <Slider label='Roundness' value={vignetteRound} min={0} max={1} step={0.01}
            onChange={(v) => { renderer.vignetteRoundness = v; setVignetteRound(v); touch(); }} />
          <Slider label='Smoothness' value={vignetteSmooth} min={0.01} max={1} step={0.01}
            onChange={(v) => { renderer.vignetteSmoothness = v; setVignetteSmooth(v); touch(); }} />
        </>}
      </Section>

      <Section title='Film Grain'>
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

      <Section title='Antialiasing'>
        <Toggle label='Temporal AA' checked={taa} className='my-1'
          onChange={(c) => { renderer.taaEnabled = c; setTaa(c); touch(); }} />
        {taa && !renderer.taaSupported &&
          <Hint>Disabled on this device: float render targets are unavailable, so the history and
            velocity buffers cannot hold the values TAA needs.</Hint>}
      </Section>

      <Section title='Motion Blur'>
        <Toggle label='Enabled' checked={motionBlur} className='my-1'
          onChange={(c) => { renderer.motionBlurEnabled = c; setMotionBlur(c); touch(); }} />
        <Slider label='Amount' value={motionBlurIntensity} min={0} max={4} step={0.05}
          onChange={(v) => { renderer.motionBlurIntensity = v; setMotionBlurIntensity(v); touch(); }} />
        <div className='flex items-center gap-1 my-1 text-ui'>
          <span className={cn(labelClass, LABEL_W, 'shrink-0')}>Quality</span>
          <SegmentedControl
            value={motionBlurSamples}
            onChange={(samples) => { renderer.motionBlurSamples = samples; setMotionBlurSamples(samples); touch(); }}
            options={MB_QUALITY.map((q) => ({ value: q.samples, label: q.label }))}
          />
        </div>
      </Section>

      <Section title='Shadows'>
        <Toggle label='Enabled' checked={shadowsEnabled} className='my-1'
          onChange={(c) => { renderer.shadowsEnabled = c; setShadowsEnabled(c); touch(); }} />

        <div className='flex items-center gap-1 my-1 text-ui'>
          <span className={cn(labelClass, LABEL_W, 'shrink-0')}>Resolution</span>
          <SegmentedControl
            value={shadowRes}
            onChange={(size) => { renderer.shadowMapResolution = size; setShadowRes(renderer.shadowMapResolution); touch(); }}
            options={SHADOW_RES.map((r) => ({ value: r.size, label: r.label, title: r.title }))}
          />
        </div>
        <div className='flex items-center gap-1 my-1 text-ui'>
          <span className={cn(labelClass, LABEL_W, 'shrink-0')}>Cascades</span>
          <SegmentedControl
            value={shadowCascades}
            onChange={(n) => { renderer.shadowCascades = n; setShadowCascades(renderer.shadowCascades); touch(); }}
            options={SHADOW_CASCADES}
          />
        </div>
        <Field labelClassName={LABEL_W} label='Distance'>
          <NumberInput value={shadowDistance} min={1} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.shadowDistance = v; setShadowDistance(renderer.shadowDistance); touch(); }} />
        </Field>
        <Field labelClassName={LABEL_W} label='Far Distance'>
          <NumberInput value={shadowFarDistance} min={0} step={100} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.shadowFarDistance = v; setShadowFarDistance(renderer.shadowFarDistance); touch(); }} />
        </Field>
        <Slider label='Split &#955;' value={shadowLambda} min={0} max={1} step={0.05}
          onChange={(v) => { renderer.shadowSplitLambda = v; setShadowLambda(v); touch(); }} />

        <div className='flex items-center gap-1 my-1 text-ui'>
          <span className={cn(labelClass, LABEL_W, 'shrink-0')}>Filter</span>
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
        <Field labelClassName={LABEL_W} label='Caster Pad'>
          <NumberInput value={shadowCasterPad} min={0} step={5} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.shadowCasterPad = v; setShadowCasterPad(renderer.shadowCasterPad); touch(); }} />
        </Field>

        {debugView === 'shadow' && (
          <div className='flex items-center gap-1 my-1 text-ui'>
            <span className={cn(labelClass, LABEL_W, 'shrink-0')}>View Layer</span>
            <SegmentedControl
              value={shadowDebugLayer}
              onChange={(n) => { renderer.shadowDebugLayer = n; setShadowDebugLayer(renderer.shadowDebugLayer); touch(); }}
              options={Array.from({ length: shadowCascades + (shadowFarDistance > 0 ? 1 : 0) },
                (_, i) => ({ value: i, label: i < shadowCascades ? String(i) : 'Far' }))}
            />
          </div>
        )}
        {!shadowsEnabled && <Hint>Shadows are off — every lookup returns fully lit.</Hint>}
      </Section>

      <Section title='Spot Shadows'>
        <Toggle label='Enabled' checked={spotShadows} className='my-1'
          onChange={(c) => { renderer.spotShadowsEnabled = c; setSpotShadows(c); touch(); }} />
        <div className='flex items-center gap-1 my-1 text-ui'>
          <span className={cn(labelClass, LABEL_W, 'shrink-0')}>Resolution</span>
          <SegmentedControl
            value={spotShadowRes}
            onChange={(size) => { renderer.spotShadowResolution = size; setSpotShadowRes(renderer.spotShadowResolution); touch(); }}
            options={SPOT_RES.map((r) => ({ value: r.size, label: r.label }))}
          />
        </div>
        <Field labelClassName={LABEL_W} label='Max Dist'>
          <NumberInput value={spotShadowDist} min={1} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.spotShadowDistance = v; setSpotShadowDist(renderer.spotShadowDistance); touch(); }} />
        </Field>
        <Slider label='Bias' value={spotShadowBias} min={0} max={0.02} step={0.0005}
          readout={(v) => v.toFixed(4)}
          onChange={(v) => { renderer.spotShadowBias = v; setSpotShadowBias(v); touch(); }} />
        {!shadowsEnabled && <Hint>The global Shadows toggle above is off, which also disables these.</Hint>}
      </Section>

      <Section title='Point Shadows'>
        <Toggle label='Enabled' checked={pointShadows} className='my-1'
          onChange={(c) => { renderer.pointShadowsEnabled = c; setPointShadows(c); touch(); }} />
        <div className='flex items-center gap-1 my-1 text-ui'>
          <span className={cn(labelClass, LABEL_W, 'shrink-0')}>Resolution</span>
          <SegmentedControl
            value={pointShadowRes}
            onChange={(size) => { renderer.pointShadowResolution = size; setPointShadowRes(renderer.pointShadowResolution); touch(); }}
            options={POINT_RES.map((r) => ({ value: r.size, label: r.label }))}
          />
        </div>
        <Field labelClassName={LABEL_W} label='Max Dist'>
          <NumberInput value={pointShadowDist} min={1} step={10} className='flex-1 text-right px-1 py-0.5'
            onChange={(v) => { renderer.pointShadowDistance = v; setPointShadowDist(renderer.pointShadowDistance); touch(); }} />
        </Field>
        <Slider label='Bias' value={pointShadowBias} min={0} max={0.02} step={0.0005}
          readout={(v) => v.toFixed(4)}
          onChange={(v) => { renderer.pointShadowBias = v; setPointShadowBias(v); touch(); }} />
        {!shadowsEnabled && <Hint>The global Shadows toggle above is off, which also disables these.</Hint>}
      </Section>

      <Section title='Ambient Occlusion & Indirect Light'>
        <Toggle label='Enabled' checked={ssaoEnabled} className='my-1'
          onChange={(c) => { renderer.ssaoEnabled = c; setSsaoEnabled(c); touch(); }} />
        <Toggle label='Indirect Light' checked={ssilEnabled} className='my-1'
          onChange={(c) => { renderer.ssilEnabled = c; setSsilEnabled(c); touch(); }} />
        <Slider label='Indirect Intensity' value={ssilIntensity} min={0} max={4} step={0.05}
          onChange={(v) => { renderer.ssilIntensity = v; setSsilIntensity(v); touch(); }} />
        <Slider label='Radius' value={ssaoRadius} min={0} max={2} step={0.05}
          onChange={(v) => { renderer.ssaoRadius = v; setSsaoRadius(v); touch(); }} />
        <Slider label='Power' value={ssaoPower} min={0} max={5} step={0.1}
          onChange={(v) => { renderer.ssaoPower = v; setSsaoPower(v); touch(); }} />
        <Slider label='Thickness' value={ssaoThickness} min={0} max={2} step={0.05}
          onChange={(v) => { renderer.ssaoThickness = v; setSsaoThickness(v); touch(); }} />
        <Slider label='Bias' value={ssaoBias} min={0} max={0.2} step={0.005}
          onChange={(v) => { renderer.ssaoBias = v; setSsaoBias(v); touch(); }} />
      </Section>

      <Section title='Shading'>
        <Toggle label='Specular occlusion' checked={specularOcclusion} className='my-1'
          onChange={(c) => { renderer.specularOcclusionEnabled = c; setSpecularOcclusion(c); touch(); }} />
        <Toggle label='Specular antialiasing' checked={specularAa} className='my-1'
          onChange={(c) => { renderer.specularAaEnabled = c; setSpecularAa(c); touch(); }} />
        <Toggle label='Horizon occlusion' checked={horizonOcclusion} className='my-1'
          onChange={(c) => { renderer.horizonOcclusionEnabled = c; setHorizonOcclusion(c); touch(); }} />
      </Section>

      <Section title='Grid'>
        <Toggle label='Visible' checked={gridVisible} className='my-1'
          onChange={(c) => { renderer.setGridVisible(c); setGridVisible(c); touch(); }} />
        <div className='flex items-center gap-1 my-1 text-ui'>
          <span className={cn(labelClass, LABEL_W, 'shrink-0')}>Plane</span>
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
    </DocScope>
  );
}
