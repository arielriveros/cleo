// The render subsystems of the engine's optional features (src/core/features/registry.ts), as the core sees them:
// each one's surface (picked off its class, as a TYPE: nothing here loads a feature) and a null stand-in for a
// renderer whose game was built without it. The Renderer asks the registry for each feature's factory and falls
// back to the stand-in, so every pass that holds one calls it the same way either way; the stand-ins draw
// nothing, allocate nothing, and keep any setting written to them so render settings still round-trip.
import { Framebuffer } from '../framebuffer';
import type { VolumetricCloudPasses } from './clouds';
import type { DecalPasses } from './decals';
import type { FluidVolumePasses } from './fluids';
import type { GiSystem } from './gi/giSystem';
import { GI_TIERS } from './gi/giSettings';
import type { VolumetricFogPasses } from './volumetricFog';
import type { ParticlePasses } from './particlePasses';
import type { FoliagePasses } from './foliage';
import { TemporalHistory } from './temporalHistory';

/** A screen-sized target matched to the render resolution, made on first use. */
export function sizedTarget(existing: Framebuffer | null, make: () => Framebuffer, width: number, height: number): Framebuffer {
    const fbo = existing ?? make();
    if (fbo.width !== width || fbo.height !== height) fbo.create(width, height);
    return fbo;
}

/** The registry name of each feature's render subsystem factory. */
export const RENDER_FACTORY = {
    decals: 'render.decals',
    fluids: 'render.fluids',
    clouds: 'render.clouds',
    gi: 'render.gi',
    volumetricFog: 'render.volumetricFog',
    particles: 'render.particles',
    foliage: 'render.foliage',
} as const;

// --- Decals (feature `decals`) ------------------------------------------------------------------------------------

export type DecalSubsystem = Pick<DecalPasses,
    'dBufferFBO' | 'gBufferCopyFBO' | 'decalReceiverFBO' | 'surfaceDecals' | 'emissiveDecals' | 'overlayDecals' |
    'collectDecals' | 'decalReceiverPass' | 'surfaceDecalPass' | 'emissiveDecalPass' | 'drawColorDecals'>;

export function createNullDecals(): DecalSubsystem {
    return {
        dBufferFBO: null, gBufferCopyFBO: null, decalReceiverFBO: null,
        surfaceDecals: [], emissiveDecals: [], overlayDecals: [],
        collectDecals() {}, decalReceiverPass() {}, surfaceDecalPass() {}, emissiveDecalPass() {}, drawColorDecals() {},
    };
}

// --- Smoke-and-fire volumes (feature `fluids`) ---------------------------------------------------------------------

export type FluidSubsystem = Pick<FluidVolumePasses, 'renderFluidVolumes' | 'traceFBO' | 'fluidHistory'>;

export function createNullFluids(): FluidSubsystem {
    return {
        renderFluidVolumes() {}, traceFBO: null,
        // Allocates nothing until first used, which a stand-in never is.
        fluidHistory: new TemporalHistory({ depth: false }),
    };
}

// --- Volumetric clouds (feature `volumetricClouds`) ---------------------------------------------------------------

export type CloudSubsystem = Pick<VolumetricCloudPasses,
    'cloudsFBO' | 'cloudTraceFBO' | 'cloudHistory' | 'cloudBaseNoise' | 'cloudDetailNoise' | 'cloudsTierApplied' |
    'windOffset' | 'advanceCloudWind' | 'cloudWindOffset' | 'renderVolumetricClouds' | 'paintSkyFaces'>;

export function createNullClouds(): CloudSubsystem {
    const windOffset: [number, number, number] = [0, 0, 0];
    return {
        // Never sized, so they hold no attachments: what RenderStats counts of them is nothing.
        cloudsFBO: new Framebuffer(), cloudTraceFBO: new Framebuffer(),
        cloudHistory: new TemporalHistory({}),
        cloudBaseNoise: null, cloudDetailNoise: null, cloudsTierApplied: null,
        windOffset,
        advanceCloudWind() {}, cloudWindOffset: () => windOffset, renderVolumetricClouds() {}, paintSkyFaces() {},
    };
}

// --- GI Volumes (feature `gi`) -------------------------------------------------------------------------------------

/** What the renderer, its passes, the editor (Renderer.gi) and the GI bake tool use of the GI Volumes. */
export type GiSubsystem = Pick<GiSystem,
    'producedThisFrame' | 'enabled' | 'resolutionScale' | 'raysPerFrame' | 'sunThreshold' | 'shadowTexel' |
    'shadowMaxSize' | 'fillDrawsPerFrame' | 'multiBounce' | 'texture' | 'targetWidth' | 'targetHeight' | 'supported' |
    'settled' | 'staleBakes' | 'outdatedBakes' | 'update' | 'resolve' | 'drawProbeOverlay' | 'lightingAt' | 'ambientAt' |
    'isCaptured' | 'exportBake' | 'describe'>;

export function createNullGi(): GiSubsystem {
    const t = GI_TIERS.high;
    return {
        producedThisFrame: false, enabled: true, multiBounce: true,
        resolutionScale: t.giResolutionScale, raysPerFrame: t.giRaysPerFrame, sunThreshold: t.giSunThreshold,
        shadowTexel: t.giShadowTexel, shadowMaxSize: t.giShadowMaxSize, fillDrawsPerFrame: t.giFillDrawsPerFrame,
        texture: null, targetWidth: 0, targetHeight: 0, supported: false, settled: true,
        staleBakes: new Set(), outdatedBakes: new Set(),
        update() {}, resolve: () => false, drawProbeOverlay() {}, lightingAt: () => 0, ambientAt: () => 0,
        isCaptured: () => false, exportBake: async () => null, describe: () => [],
    };
}

// --- Volumetric fog (feature `volumetricFog`) ----------------------------------------------------------------------

export type FogSubsystem = Pick<VolumetricFogPasses,
    'enabled' | 'tileSize' | 'slices' | 'distance' | 'temporal' | 'localLights' | 'localShadows' | 'frameVolumes' |
    'render' | 'invalidate'>;

/** With VolumetricFogPasses' defaults, so the settings read the same either way. */
export function createNullFog(): FogSubsystem {
    return {
        enabled: true, tileSize: 16, slices: 64, distance: 128, temporal: true, localLights: true, localShadows: true,
        frameVolumes: [], render: () => false, invalidate() {},
    };
}

// --- Particle systems (feature `particles`) --------------------------------------------------------------------

/** What the renderer and its forward and 2D passes use of the particle passes (render/particlePasses.ts). */
export type ParticleSubsystem = Pick<ParticlePasses,
    'simulateParticles' | 'renderParticles' | 'isFlatParticleScene' | 'draw2D' | 'rememberCollisionCamera' |
    'invalidateCollision' | 'particleLodDistanceScale' | 'precipitationDensity'>;

/** With ParticlePasses' defaults, so the settings read the same either way. */
export function createNullParticles(): ParticleSubsystem {
    return {
        particleLodDistanceScale: 1, precipitationDensity: 1,
        simulateParticles() {}, renderParticles() {}, isFlatParticleScene: () => false, draw2D() {},
        rememberCollisionCamera() {}, invalidateCollision() {},
    };
}

// --- Landscape foliage (feature `landscape`) --------------------------------------------------------------------

/** The `u_lodCamera` of a draw with no distance LOD (the geometry pass's ordinary models). */
export const FOLIAGE_LOD_OFF: readonly number[] = [0, 0, 0, 0];

/**
 * What the renderer and its passes use of the landscape's foliage passes (render/foliage.ts): upload, culling,
 * shadows, GI capture, the debug views and the weather's droop, and the foliage render settings.
 */
export type FoliageSubsystem = Pick<FoliagePasses,
    'foliageShadowDistance' | 'foliagePrepass' | 'foliageGpuCulling' | 'foliageCullDistance' | 'foliageCellSize' |
    'foliageAdmitPerFrame' | 'foliageDensityFalloff' | 'gpuCullingSupported' | 'weatherHash' | 'snowColor' |
    'ensureFoliageUploaded' | 'preparePreview' | 'updateInteraction' | 'foliagePass' | 'prepareFoliageShadow' |
    'foliageShadowPass' | 'prepareCapture' | 'drawCapture' | 'cellCullReasons' | 'colourChunks' | 'recordFoliageDraw'>;

/** With FoliagePasses' defaults (terrain/foliage.ts FOLIAGE_DENSITY_FALLOFF is 0.75), so the settings read the same. */
export function createNullFoliage(): FoliageSubsystem {
    return {
        foliageShadowDistance: 0, foliagePrepass: false, foliageGpuCulling: true, foliageCullDistance: 65,
        foliageCellSize: 13, foliageAdmitPerFrame: 4, foliageDensityFalloff: 0.75, gpuCullingSupported: false,
        weatherHash: 0, snowColor: [0.9, 0.9, 0.9, 0.85],
        ensureFoliageUploaded() {}, preparePreview() {}, updateInteraction() {}, foliagePass() {},
        prepareFoliageShadow: () => 0, foliageShadowPass() {}, prepareCapture: () => false, drawCapture: () => 0,
        cellCullReasons: () => null, colourChunks: () => undefined, recordFoliageDraw() {},
    };
}
