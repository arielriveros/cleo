// The renderer's settings vocabulary: the persisted RenderSettings shape, the quality tiers and the
// small enums they use. A leaf (type-only imports) so modules split out of renderer.ts, and
// programUsage.ts, can use them without importing the renderer. renderer.ts re-exports all of it.

import type { ExposureCurveKey } from '../lighting';

/** Editor-only debug channels: which internal buffer the renderer blits to the screen. */
export type DebugView =
    'final' | 'scene' | 'albedo' | 'metallic' | 'normal' | 'roughness' |
    'emissive' | 'ao' | 'depth' | 'ssao' | 'ssil' | 'ssr' | 'ssrConfidence' | 'shadow' | 'cascades' | 'bloom' |
    'bloomMask' | 'mask' | 'velocity' | 'taaHistory' | 'overdraw';

/** How much occlusion culling does: nothing, the landscape, or the landscape and occlusion volumes. */
export type OcclusionMode = 'off' | 'terrain' | 'all';

/**
 * Coarse quality tier, setting the knobs that dominate GPU cost in one move: cloud and SSAO
 * resolution and step counts, cascade resolution, bloom and render scale. Becomes `custom` as soon as
 * any one knob is changed by hand.
 */
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom';

/**
 * The display transform applied at present — the curve that turns linear HDR into a picture.
 *
 * `agx` is the default. Its advantage over the ACES fit is what it does to an over-range saturated
 * colour: the inset matrix pulls the primaries in before the sigmoid, so a bright blue light
 * desaturates toward WHITE as it clips instead of skewing purple, which is the ACES fit's most
 * visible failure and the reason Godot changed its own default in 4.6.
 *
 * `aces` is the Narkowicz fit this engine shipped before the choice existed. `neutral` is Khronos
 * PBR Neutral, which leaves in-gamut albedo untouched — what an asset or product viewer wants.
 * `none` clamps, which is how you see what the buffer actually holds.
 */
export type ToneMapper = 'agx' | 'aces' | 'neutral' | 'none';

export interface RenderSettings {
    quality: QualityPreset;
    renderScale: number;
    clearColor: number[];
    exposure: number;
    bloomThreshold: number;
    bloomKnee: number;
    bloomIntensity: number;
    /**
     * 'physical' (the default; a scene saved without it re-grades to it, as with the tone mapper): no
     * threshold, a `bloomMix` share of the blurred image is lerped in, so glare follows energy.
     * 'threshold': only what clears `bloomThreshold` blooms, added on top at `bloomIntensity`.
     */
    bloomMode?: 'physical' | 'threshold';
    /** Physical bloom's share of the blurred image, 0..1 (default 0.04). */
    bloomMix?: number;
    /**
     * Night vision 0..1 (default 1; absent = 1): colour drains toward a bluish grey and reds darken below a
     * few cd/m2, per pixel on absolute luminance — moonlight reads as night while a torch's pool keeps its
     * warmth. Never affects a daylit pixel.
     */
    purkinjeStrength?: number;
    bloomMaskEnabled: boolean;
    chromaticAberrationStrength: number;
    /**
     * Lens fall-off toward the corners. 0 = off, 1 = corners fully dark.
     *
     * Multiplicative on linear radiance and applied BEFORE the tone curve, because that is what it
     * physically is: light the barrel stopped from reaching the sensor. Darkening after the curve
     * instead crushes the corners flat rather than exposing them down.
     */
    /**
     * Depth of field. Off by default; the focus controls below mean nothing until it is on.
     *
     * The lens is a thin lens with a real aperture, so the near field blurs harder than the far field
     * and the far field saturates at infinity — see `dofMath.ts`, which holds the same arithmetic in
     * a form that can be tested.
     */
    dofEnabled: boolean;
    /**
     * Metres to the focal plane. Ignored on a camera that names a focus target, which measures the
     * distance to that node instead — see `CameraNode.focusTargetId`.
     */
    dofFocusDistance: number;
    /** Metres around the plane that stay perfectly sharp. Not physical; it is what "keep the subject sharp" means. */
    dofFocusRange: number;
    /** Aperture as written on a lens barrel. Smaller is wider, and shallower. */
    dofAperture: number;
    /** Clamp on the blur radius in pixels. A COST control: the gather samples for a fixed radius. */
    dofMaxBlur: number;
    /**
     * Lens flare. 0 = off. Ghosts and a halo, generated from image brightness rather than anchored to
     * the sun — see lensFlare.wgsl for why that is the occlusion-correct choice, not just the cheap one.
     */
    lensFlareIntensity: number;
    /** Linear-HDR radiance a pixel must exceed before it throws a flare. */
    lensFlareThreshold: number;
    /** Ghosts traced back through the centre. Clamped to 8, which is the shader's compiled bound. */
    lensFlareGhosts: number;
    /** Radius of the halo ring, in uv. 0 disables the halo and keeps the ghosts. */
    lensFlareHaloWidth: number;
    /**
     * `TextureManager` id of a lens-dirt overlay, or null for the BUILT-IN mask.
     *
     * NOTE THE POLARITY, which is the opposite of {@link colorGradingLut}'s: null there means "no
     * LUT", null here means "the one that ships with the engine". The asymmetry is deliberate — dirt
     * is a property every real lens has, so the useful default is a sensible mask rather than none,
     * and {@link lensDirtIntensity} is the switch. A null that meant "off" would leave the built-in
     * unreachable without first importing a texture.
     */
    lensDirtTexture: string | null;
    /**
     * How much the dirt overlay boosts the bloom and lens flare it catches. 0 = off, which is the
     * default: the mask ships, the effect does not.
     */
    lensDirtIntensity: number;
    vignetteStrength: number;
    /** 0 follows the frame's aspect (a real lens vignettes elliptically); 1 is a circle. */
    vignetteRoundness: number;
    /** Width of the falloff band. Small is a hard iris edge, large is a gentle shade. */
    vignetteSmoothness: number;
    /**
     * Film grain. 0 = off; ~0.05 is a subtle 35mm stock, past ~0.3 it reads as sensor noise.
     *
     * Scaled by a midtone-peaked luminance response, so black stays clean and a blown highlight does
     * not sparkle — which is what separates grain from uniform video noise.
     */
    filmGrainIntensity: number;
    /** Grain cell size in pixels. 1 is per-pixel and aliases under TAA; 1.5-3 is filmic. */
    filmGrainSize: number;
    /** Tint each channel independently, as colour film does, instead of monochrome grain. */
    filmGrainColored: boolean;
    /** Final-image saturation trim. 1 = untouched. A sky light's cloud response multiplies on top. */
    saturation: number;
    /** The tone curve at present. See {@link ToneMapper}. */
    toneMapper: ToneMapper;
    /**
     * `TextureManager` id of a colour-grading LUT, or null.
     *
     * The texture is an N-tile horizontal strip, N x N per tile (width = N squared, height = N):
     * red runs left to right within a tile, green DOWNWARD from the top row, blue across the tiles.
     * See `graphics/colorGrading.ts`, which turns it into the 3D volume the present pass samples.
     */
    colorGradingLut: string | null;
    /** How far toward the LUT the display colour is pulled. 0 = off, 1 = the LUT as authored. */
    colorGradingIntensity: number;
    ssaoEnabled: boolean;
    /**
     * Whether the indirect SPECULAR lobe gets its own occlusion term rather than the diffuse one.
     *
     * On is correct and is the default: an AO map and SSAO both measure how much of the HEMISPHERE is
     * blocked, which is the right question for a diffuse lobe and the wrong one for a narrow specular
     * cone (see `computeSpecularAO`). Off restores the older behaviour of multiplying both by the same
     * number, which visibly strips the reflection off a polished floor standing in a corner.
     *
     * It is a setting rather than a constant for two reasons: it is the only way to gate the feature
     * from the harness, since unlike a light radius it is shading behaviour with nothing to patch; and
     * it gives an artist the same escape hatch every other AO knob here already has.
     */
    specularOcclusionEnabled: boolean;
    /**
     * Geometric specular antialiasing: widen roughness by the sub-pixel variance of the normal, so a
     * sharp highlight over a curved or normal-mapped surface stops flickering as it moves.
     *
     * On by default. It is a setting for the same two reasons {@link specularOcclusionEnabled} is: it
     * is the only way to A/B the feature from the harness, and it costs two derivative pairs per
     * fragment in four programs, which is a bill somebody may not want to pay.
     *
     * Applies to the PBR and terrain paths only — the metallic-roughness family, where the widened
     * NDF means something. Blinn-Phong's forward shading is genuine `pow(NdotH, shininess)` with no
     * roughness to filter, and its deferred twin derives one from shininess, so filtering there would
     * WIDEN the gap between its two paths rather than close it.
     */
    specularAaEnabled: boolean;
    /**
     * Horizon occlusion: drop the indirect specular where the reflection ray points INTO the surface.
     *
     * On by default. A normal map tilts the shading normal away from the real surface, and the
     * reflection is computed against the tilted one — so at a glancing angle the ray dips below the
     * geometry and the surface reflects sky it cannot see. That is the wet-looking rim on strongly
     * normal-mapped materials viewed at an angle.
     *
     * The forward path reads the geometric normal off the vertex basis for free. The deferred path
     * REBUILDS it from the depth buffer (`geometricNormal` in deferredLighting.wgsl), because the
     * G-buffer carries the shading normal only and the channel oct-packing freed went to reflectance.
     * Four extra depth taps, against the 8 bytes per pixel per frame a fourth attachment would cost.
     */
    horizonOcclusionEnabled: boolean;
    /**
     * Meter the frame and drive {@link exposure} from it, instead of holding a hand-set value.
     *
     * On by default, which is the point of phase 1: once lights carry lux and lumens, a fixed exposure
     * is the last non-physical link in the chain, and one global number can only meter one decade — at
     * EV100 15 a 1500 lm bulb two metres away is invisible, and that is physics rather than a bug.
     */
    autoExposureEnabled: boolean;
    /**
     * Pre-exposure (graphics/preExposure.ts): store every frame's light multiplied by its exposure, as a
     * power of two, so a moonlit scene keeps the half-float precision a sunlit one has. On by default and
     * invisible by day (it is 1 at EV100 15); off stores absolute radiance, the A/B for it. Absent = on.
     */
    preExposure?: boolean;
    /** Artist trim on the metered result, in stops. Positive is brighter, as on a camera. */
    exposureCompensation: number;
    /**
     * Extra trim in stops keyed on the METERED scene EV100 (Unreal's exposure compensation curve), on
     * top of `exposureCompensation`. Lights keep fixed physical values; this is how an artist keeps a
     * night or a cave darker than a fully adapted eye would show it. Empty = no curve.
     */
    exposureCompensationCurve: ExposureCurveKey[];
    /** Clamps on the metered EV100. Defaults span a night interior to a sunlit exterior. */
    exposureMinEV: number;
    exposureMaxEV: number;
    /**
     * Adaptation RATES, matching Unreal's `AutoExposureSpeedUp` / `SpeedDown` in both name and meaning:
     * higher adapts faster, and the defaults 3.0 and 1.0 are Unreal's. `Up` is the scene getting
     * brighter, which an eye handles faster than the reverse. 0 snaps instantly.
     */
    exposureSpeedUp: number;
    exposureSpeedDown: number;
    ssaoRadius: number;
    ssaoPower: number;
    ssaoBias: number;
    /**
     * How far behind its visible face an occluder is assumed to extend, in world units. What lets light
     * pass behind a thin object instead of every depth sample standing for a solid wall — see ssil.wgsl.
     */
    ssaoThickness: number;
    /**
     * Screen-space indirect light: the ambient-occlusion pass also gathers last frame's light off the
     * nearby surfaces that occlude, and adds it where their occlusion took the ambient away — colour
     * bleeding and bounce light near geometry. Off leaves the same pass as ambient occlusion alone.
     * Deferred surfaces only, like the AO.
     */
    ssilEnabled: boolean;
    /** Scale on that bounce light. 1 is energy-correct; the occlusion itself is unaffected. */
    ssilIntensity: number;
    /**
     * Screen-space reflections: what is on screen reflected in glossy deferred surfaces, one GGX ray per
     * pixel, with the light probes, the environment map and then the sky reflecting wherever a ray finds
     * nothing. A quality-tier field. Absent = the tier's value (on at high and ultra).
     */
    ssrEnabled?: boolean;
    /**
     * Local exposure (render/localExposure.ts): exposure fusion over regions of the frame, so a torch pool
     * and the moonlit field round it are both readable — the field lifted, the pool held back, the detail
     * in each untouched. A quality-tier field (high and ultra on).
     */
    localExposureEnabled?: boolean;
    /** 0..1: how much of the fused shift is applied (default 0.6). */
    localExposureStrength?: number;
    /** Stops the darkest regions can be lifted (default 1.5). */
    localExposureShadows?: number;
    /** Stops the brightest regions can be held back (default 1.5). */
    localExposureHighlights?: number;
    /**
     * Volumetric fog (render/volumetricFog.ts): the VolumetricFogNode volumes, lit by the sun, the torches
     * and the sky, drawn with a froxel grid. A quality-tier field (on from medium up). Nothing runs in a
     * scene with no fog volume.
     */
    volumetricFogEnabled?: boolean;
    /** Screen pixels per froxel column (tier: 12 ultra, 16 high, 20 medium). */
    volumetricFogTileSize?: number;
    /** Depth slices of the froxel grid (tier: 96 ultra, 64 high, 48 medium). */
    volumetricFogSlices?: number;
    /** Metres the fog reaches from the camera (default 128). */
    volumetricFogDistance?: number;
    /** Blend each froxel with the last frame's (default on): smooth, at a little lag. */
    volumetricFogTemporal?: boolean;
    /** Scatter the point and spot lights into the fog (default on): halos round torches. */
    volumetricFogLocalLights?: boolean;
    /**
     * Shade the light they scatter through their shadow maps, so a torch behind a wall lights none of the
     * fog on this side (tier: on from high up).
     */
    volumetricFogLocalShadows?: boolean;
    /**
     * The weather's shelter map (render/shadows.ts `renderShelter`): a depth map from straight above of
     * everything solid round the camera, so the ground and the plants under a roof stay dry and free of
     * snow. A quality-tier field (off on Low, where weather reaches everything inside its volume).
     */
    weatherShelterEnabled?: boolean;
    /** Its resolution over the 96 m it covers (tier: 2048 ultra, 1024 high and medium). */
    weatherShelterResolution?: number;
    /** Trace resolution as a fraction of the render size (0.25..1). A quality-tier field. Absent = the tier's. */
    ssrResolutionScale?: number;
    /** March steps per ray across the screen (8..128). A quality-tier field. Absent = the tier's. */
    ssrSteps?: number;
    /** Rougher surfaces than this (0..1) take the environment reflection alone. Absent = 0.6. */
    ssrMaxRoughness?: number;
    /** How far a reflection ray travels, world units. Absent = 50. */
    ssrMaxDistance?: number;
    /** How far behind its visible face a surface is assumed to extend, world units. Absent = 0.3. */
    ssrThickness?: number;
    motionBlurEnabled: boolean;
    motionBlurIntensity: number;
    motionBlurSamples: number;
    /**
     * Scale of the per-pixel offset along the blur, 0..1. Low values give discrete copies (banding),
     * high ones grain — motion blur runs after TAA, so nothing averages that grain away. Absent = 0.5.
     */
    motionBlurJitter?: number;
    /** Longest blur streak, pixels (4..20; 20 is the tile size and the hard cap). Absent = 20. */
    motionBlurMaxLength?: number;
    /** Temporal antialiasing. See `taaResolve.wgsl` for what the knobs below do. */
    taaEnabled: boolean;
    /** History weight when the pixel is still (0.8..0.98). Higher = smoother and slower to settle. Absent = 0.97. */
    taaFeedback?: number;
    /** History weight under fast motion (0.5..0.95). Lower = sharper in motion, more aliasing. Absent = 0.88. */
    taaMotionFeedback?: number;
    /** Width of the history clip box in standard deviations (0.5..2). Lower = less ghosting, more flicker. Absent = 1. */
    taaClipStrength?: number;
    /** How the history is fetched: one bilinear tap (softer) or 5-tap Catmull-Rom. Absent = 'catmullRom'. */
    taaHistoryFilter?: TaaHistoryFilter;
    /** Contrast-adaptive sharpening of the resolved image, 0..1 (0 = off). Absent = 0.25. */
    taaSharpness?: number;
    /** FXAA, a single-frame edge smoother; on its own or on top of TAA. Absent = off. */
    fxaaEnabled?: boolean;
    /** Edge search length: 'low' 5, 'medium' 8, 'high' 12 steps. Absent = 'medium'. */
    fxaaQuality?: FxaaQuality;
    /** Sub-pixel smoothing 0..1. Higher removes more shimmer and softens more. Absent = 0.75. */
    fxaaSubpixel?: number;
    /** Minimum relative contrast to count as an edge (0.063..0.333). Lower smooths more edges. Absent = 0.125. */
    fxaaEdgeThreshold?: number;
    frustumCulling: boolean;
    /**
     * Occlusion culling (graphics/occlusion): skip what is hidden behind the landscape (`terrain`), and
     * also the contents of every occlusion volume the camera cannot see (`all`). Absent = `all`.
     */
    occlusionCulling?: OcclusionMode;
    /**
     * How far terrain foliage casts shadows, metres. 0 (or absent) = as far as it draws. Past it a tree's
     * shadow is a few texels of a distant cascade; the cells are still drawn, only not into the shadow map.
     */
    foliageShadowDistance?: number;
    /**
     * Depth prepass for alpha-tested mesh foliage (the two nearest detail levels): its depth is written
     * first with a cutout-only program, then it is shaded ONCE per pixel with a no-discard program tested
     * 'equal'. Trades a second vertex pass for the fragment overdraw; a win only where foliage is
     * fill-bound — measure (the foliage GPU row, and the overdraw view) before leaving it on. Off by default.
     */
    foliagePrepass?: boolean;
    /**
     * GPU-driven foliage culling, WebGPU only (graphics/foliageGpuCulling.ts): a compute pass drops every
     * instance faded out of its detail band or off screen, and the buckets draw indirectly — no instance
     * upload per frame. On by default where the device supports it; WebGL2 always packs on the CPU.
     */
    foliageGpuCulling?: boolean;
    /**
     * Occlusion culling's second stage (graphics/gpuOcclusion.ts): hardware occlusion queries against the
     * frame's real depth, for what the CPU occluders cannot see — a house hiding the cart behind it. Results
     * arrive a frame or two late, so only a fresh "hidden" is acted on. Needs `occlusionCulling` on.
     */
    occlusionQueries?: boolean;
    /**
     * Leave out every point and spot light whose whole reach is hidden behind what is on screen: the same
     * occlusion queries, asked about the box round each light's influence sphere. A torch in the next room
     * then takes no cluster slot and no shadow map. Needs `occlusionQueries`.
     */
    lightOcclusionCulling?: boolean;
    foliageCullDistance: number;
    /**
     * Multiplies every particle system's LOD distances and cull distance (each `.vfx` authors its own;
     * see particles/particleLod.ts). 2 keeps full detail twice as far; 0.5 thins effects sooner.
     */
    particleLodDistanceScale: number;
    foliageDensityFalloff: number;
    foliageCellSize: number;
    terrainLodEnabled: boolean;
    terrainLodDistance1: number;
    terrainLodDistance2: number;
    terrainLodStep1: number;
    terrainLodStep2: number;
    /**
     * Side of the landscape layer arrays every surface is resampled into (512 / 1024 / 2048). The one
     * size is what makes the arrays possible; the memory is `2 * size² * 4 B * 1.33` per surface.
     */
    terrainLayerTextureSize: number;
    ssaoSamples: number;
    ssaoResolutionScale: number;
    shadowMapResolution: number;
    bloomEnabled: boolean;
    // Shadows. Everything here is authored in the editor's Renderer mode and rides the same blob
    // through save / publish / the standalone player.
    shadowsEnabled: boolean;
    shadowCascades: number;
    shadowDistance: number;
    shadowSplitLambda: number;
    shadowDepthBias: number;
    shadowNormalBias: number;
    shadowFilterRadius: number;
    shadowFilterMode: number;
    shadowStrength: number;
    shadowCascadeBlend: number;
    shadowStabilize: boolean;
    shadowStagger: boolean;
    shadowCasterPad: number;
    /** Reach of the far (landscape) cascade past `shadowDistance`; 0 = off. */
    shadowFarDistance: number;
    spotShadowsEnabled: boolean;
    spotShadowResolution: number;
    spotShadowDistance: number;
    spotShadowBias: number;
    pointShadowsEnabled: boolean;
    pointShadowResolution: number;
    pointShadowDistance: number;
    pointShadowBias: number;
}

/** The knobs each quality tier sets. `custom` has no entry — it means "don't touch anything". */
export interface QualityTier {
    renderScale: number;
    /** Cloud raymarch resolution as a fraction of the render size. */
    cloudResolutionScale: number;
    cloudSteps: number;
    cloudLightSteps: number;
    ssaoEnabled: boolean;
    ssaoSamples: number;
    ssaoResolutionScale: number;
    /** SSIL's bounce light on top of the AO (see RenderSettings.ssilEnabled). */
    ssilEnabled: boolean;
    /** Screen-space reflections (see RenderSettings.ssrEnabled), their trace resolution and march steps. */
    ssrEnabled: boolean;
    ssrResolutionScale: number;
    ssrSteps: number;
    /** Local exposure (see RenderSettings.localExposureEnabled). */
    localExposureEnabled: boolean;
    /** Volumetric fog (see RenderSettings.volumetricFogEnabled), its froxel tile and slice count. */
    volumetricFogEnabled: boolean;
    volumetricFogTileSize: number;
    volumetricFogSlices: number;
    volumetricFogLocalShadows: boolean;
    /** The weather's shelter map (see RenderSettings.weatherShelterEnabled) and its resolution. */
    weatherShelterEnabled: boolean;
    weatherShelterResolution: number;
    shadowMapResolution: number;
    shadowCascades: number;
    /** 0 = 3x3 tap grid, 1 = 16-tap rotated Poisson. */
    shadowFilterMode: number;
    /** Filter kernel radius in shadow texels; 0 collapses to a single (hard-edged) tap. */
    shadowFilterRadius: number;
    /** Particle LOD distance multiplier (see RenderSettings.particleLodDistanceScale). */
    particleLodDistanceScale: number;
    bloomEnabled: boolean;
    motionBlurEnabled: boolean;
    taaEnabled: boolean;
    /** The cheap edge smoother, standing in for TAA where the tier cannot afford it. */
    fxaaEnabled: boolean;
}

export type TaaHistoryFilter = 'bilinear' | 'catmullRom';

export type FxaaQuality = 'low' | 'medium' | 'high';
/** Edge search steps per FXAA quality preset. */
export const FXAA_SEARCH_STEPS: Record<FxaaQuality, number> = { low: 5, medium: 8, high: 12 };

/** `v` clamped to [lo, hi]; `fallback` when it is not a finite number (a hand-edited or old save). */
export function clampFinite(v: number, lo: number, hi: number, fallback: number): number {
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

// Tier definitions. Each step down roughly quarters the cost of the cloud raymarch and SSAO/SSIL, which
// scale with resolution squared AND with their step/sample count.
export const QUALITY_TIERS: Record<Exclude<QualityPreset, 'custom'>, QualityTier> = {
    ultra: {
        renderScale: 1.0,
        cloudResolutionScale: 1.0, cloudSteps: 48, cloudLightSteps: 6,
        ssaoEnabled: true, ssaoSamples: 64, ssaoResolutionScale: 1.0, ssilEnabled: true,
        ssrEnabled: true, ssrResolutionScale: 1.0, ssrSteps: 64, localExposureEnabled: true,
        volumetricFogEnabled: true, volumetricFogTileSize: 12, volumetricFogSlices: 96, volumetricFogLocalShadows: true,
        weatherShelterEnabled: true, weatherShelterResolution: 2048,
        shadowMapResolution: 4096, shadowCascades: 4, shadowFilterMode: 1, shadowFilterRadius: 2.0,
        bloomEnabled: true, motionBlurEnabled: true, taaEnabled: true, fxaaEnabled: false,
        particleLodDistanceScale: 1.5,
    },
    high: {
        renderScale: 1.0,
        cloudResolutionScale: 0.5, cloudSteps: 40, cloudLightSteps: 5,
        ssaoEnabled: true, ssaoSamples: 24, ssaoResolutionScale: 0.5, ssilEnabled: true,
        ssrEnabled: true, ssrResolutionScale: 0.5, ssrSteps: 32, localExposureEnabled: true,
        volumetricFogEnabled: true, volumetricFogTileSize: 16, volumetricFogSlices: 64, volumetricFogLocalShadows: true,
        weatherShelterEnabled: true, weatherShelterResolution: 1024,
        shadowMapResolution: 2048, shadowCascades: 3, shadowFilterMode: 0, shadowFilterRadius: 1.0,
        bloomEnabled: true, motionBlurEnabled: true, taaEnabled: true, fxaaEnabled: false,
        particleLodDistanceScale: 1,
    },
    medium: {
        renderScale: 1.0,
        cloudResolutionScale: 0.35, cloudSteps: 28, cloudLightSteps: 4,
        // AO alone: the bounce costs a normal and a radiance fetch per visible sample on top.
        ssaoEnabled: true, ssaoSamples: 16, ssaoResolutionScale: 0.5, ssilEnabled: false,
        ssrEnabled: false, ssrResolutionScale: 0.5, ssrSteps: 24, localExposureEnabled: false,
        volumetricFogEnabled: true, volumetricFogTileSize: 20, volumetricFogSlices: 48, volumetricFogLocalShadows: false,
        weatherShelterEnabled: true, weatherShelterResolution: 1024,
        shadowMapResolution: 1024, shadowCascades: 3, shadowFilterMode: 0, shadowFilterRadius: 1.0,
        // Kept at medium: one fullscreen resolve is cheap next to what this tier already spends on
        // clouds and shadows, and aliasing is the most visible artefact left at a reduced tier.
        bloomEnabled: true, motionBlurEnabled: false, taaEnabled: true, fxaaEnabled: false,
        particleLodDistanceScale: 0.75,
    },
    low: {
        renderScale: 0.75,
        cloudResolutionScale: 0.25, cloudSteps: 20, cloudLightSteps: 3,
        ssaoEnabled: false, ssaoSamples: 16, ssaoResolutionScale: 0.5, ssilEnabled: false,
        ssrEnabled: false, ssrResolutionScale: 0.5, ssrSteps: 16, localExposureEnabled: false,
        volumetricFogEnabled: false, volumetricFogTileSize: 24, volumetricFogSlices: 32, volumetricFogLocalShadows: false,
        weatherShelterEnabled: false, weatherShelterResolution: 512,
        shadowMapResolution: 1024, shadowCascades: 2, shadowFilterMode: 0, shadowFilterRadius: 0.0,
        bloomEnabled: false, motionBlurEnabled: false, taaEnabled: false, fxaaEnabled: true,
        particleLodDistanceScale: 0.5,
    },
};

/**
 * Editor-only skeleton overlay: joint spheres and bone connectors, drawn instanced and always-on-top
 * in the gizmo pass. The caller packs world-space matrices and refreshes them every frame.
 */
export interface SkeletonOverlay {
    jointMatrices: Float32Array;   // 16 * jointCount
    jointCount: number;
    jointColor: [number, number, number];
    boneMatrices: Float32Array;    // 16 * boneCount
    boneCount: number;
    boneColor: [number, number, number];
    highlightMatrix?: Float32Array | null; // 16, the selected joint (drawn over the rest)
    highlightColor?: [number, number, number];
    /**
     * Joints to mark in their own colour — bones an editor feature gave a ROLE. Distinct from
     * `highlightMatrix`, the transient selection; both need to be visible at once. 16 floats each.
     */
    markerMatrices?: Float32Array | null;
    markerCount?: number;
    markerColor?: [number, number, number];
    /**
     * How joints (and markers and the highlight) are drawn. 'sphere' (default): a solid ball. 'ring': a
     * flat circle outline in the instance's local XY plane, seen from both sides -- the caller turns it
     * to face the camera and sizes it per frame, so it reads as a constant-size circle on screen.
     */
    jointShape?: 'sphere' | 'ring';
}
