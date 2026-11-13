import { Logger } from '../../core/logger';
import { device } from '../rhi/deviceHandle';
import { Framebuffer } from '../framebuffer';
import { FramebufferPool } from '../renderGraph/pool';
import { frameStats } from '../renderStats';
import { TextureManager } from '../systems/textureManager';
import type { FrameTargets } from './frameTargets';
import type { TemporalPasses } from './temporal';
import type { PostEffects } from './postEffects';
import type { VolumetricCloudPasses } from './clouds';
import type { DecalPasses } from './decals';
import type { ShadowPasses } from './shadows';
import type { SsilPasses } from './ssil';
import type { SsrPasses } from './ssr';
import type { SceneRadianceCopy } from './sceneRadiance';
import type { SkyPasses } from './sky';
import type { DebugViews } from './debugViews';
import type { FluidVolumePasses } from './fluids';

/** What RenderStats reads from the renderer that owns it: its own state, not another subsystem's. */
export interface RenderStatsHost {
    readonly canvas: HTMLCanvasElement;
    readonly deferred: boolean;
    readonly postPool: FramebufferPool;
    readonly renderHeight: number;
    readonly renderScale: number;
    readonly renderWidth: number;
    /** The per-object table's texture (graphics/objectTable.ts). */
    readonly objectTableBytes: number;
}

/**
 * What the renderer reports about itself: the per-frame statistics the editor's performance HUD
 * reads, a lower-bound estimate of the GPU memory its targets and textures hold, and the opt-in
 * per-stage GL error check. Split out of Renderer, which keeps `stats` and `debugGLErrors` as
 * forwarding accessors.
 */
export class RenderStats {
    constructor(private readonly _host: RenderStatsHost,
                private readonly _targets: FrameTargets,
                private readonly _temporal: TemporalPasses,
                private readonly _post: PostEffects,
                private readonly _clouds: VolumetricCloudPasses,
                private readonly _decals: DecalPasses,
                private readonly _shadows: ShadowPasses,
                private readonly _ssil: SsilPasses,
                private readonly _sky: SkyPasses,
                private readonly _debugViews: DebugViews,
                private readonly _fluids: FluidVolumePasses,
                private readonly _ssr: SsrPasses,
                private readonly _radiance: SceneRadianceCopy) {}

    /**
     * Ask the device for its pending errors after each frame stage and count them. OFF by default — on
     * WebGL2 that is `getError`, a synchronous round trip that stalls the pipeline.
     */
    public debugGLErrors: boolean = false;
    private _glErrorCount: number = 0;

    /**
     * Report and count any device error raised since the last check, naming the stage that raised it.
     * Draining clears them, so the check is per stage. No-op unless {@link debugGLErrors}, and on a
     * device without the hook (WebGPU reports through `uncapturederror`, which the device handles).
     */
    public checkGLErrors(stage: string): void {
        if (!this.debugGLErrors || !device.drainDebugErrors) return;
        for (const error of device.drainDebugErrors()) {
            this._glErrorCount++;
            Logger.error(`GL error ${error} raised during the ${stage} stage`, 'Renderer');
        }
    }

    /** Per-frame render statistics for the editor's performance HUD (last completed frame). */
    public get stats() {
        return {
            drawCalls: frameStats.drawCalls,
            instancedDrawCalls: frameStats.instancedDrawCalls,
            objects: frameStats.objects,
            culledObjects: frameStats.culledObjects,
            occludedObjects: frameStats.occludedObjects,
            occludedCells: frameStats.occludedCells,
            occluderTriangles: frameStats.occluderTriangles,
            occlusionMs: frameStats.occlusionMs,
            occlusionVolumes: frameStats.occlusionVolumes,
            occlusionVolumesHidden: frameStats.occlusionVolumesHidden,
            volumeCulledNodes: frameStats.volumeCulledNodes,
            culledInstances: frameStats.culledInstances,
            // Surfaced here, not just on `frameStats`: the performance panel reads its per-frame
            // counters off THIS object, so a counter added to the accumulator and not to this list
            // reads as a permanent zero in the HUD - the same way the physics and scene rows once did.
            foliageDraws: frameStats.foliageDraws,
            foliageShadowDraws: frameStats.foliageShadowDraws,
            foliageCells: frameStats.foliageCells,
            foliageCellsScanned: frameStats.foliageCellsScanned,
            shadowLayers: frameStats.shadowLayers,
            shadowLayersSkipped: frameStats.shadowLayersSkipped,
            shadowDraws: frameStats.shadowDraws,
            shadowTriangles: frameStats.shadowTriangles,
            instances: frameStats.instances,
            triangles: frameStats.triangles,
            vertices: frameStats.vertices,
            tilemapChunks: frameStats.tilemapChunks,
            tilemapDraws: frameStats.tilemapDraws,
            spritesDrawn: frameStats.spritesDrawn,
            spriteDraws: frameStats.spriteDraws,
            fullscreenPasses: frameStats.fullscreenPasses,
            shadedMpx: frameStats.shadedMpx,
            stateChanges: frameStats.stateChanges,
            stateChangesSaved: frameStats.stateChangesSaved,
            rhiStateCalls: frameStats.rhiStateCalls,
            rhiStateCallsSaved: frameStats.rhiStateCallsSaved,
            uniformUploads: frameStats.uniformUploads,
            uniformUploadBytes: frameStats.uniformUploadBytes,
            objectRows: frameStats.objectRows,
            objectUploads: frameStats.objectUploads,
            objectUploadBytes: frameStats.objectUploadBytes,
            particlesDrawn: frameStats.particlesDrawn,
            particleSteps: frameStats.particleSteps,
            particleSystems: frameStats.particleSystems,
            particleSystemsCulled: frameStats.particleSystemsCulled,
            particleSystemsLodCulled: frameStats.particleSystemsLodCulled,
            particleSystemsLodReduced: frameStats.particleSystemsLodReduced,
            particleColliders: frameStats.particleColliders,
            particleDraws: frameStats.particleDraws,
            particleGpuCreates: frameStats.particleGpuCreates,
            particleGpuReuses: frameStats.particleGpuReuses,
            frameMs: frameStats.frameMs,
            pipeline: this._host.deferred ? 'deferred' as const : 'forward' as const,
            glErrors: this._glErrorCount,
            // Canvas size (what the display sees) and internal size (what the pipeline actually
            // shades) are different numbers once renderScale is below 1, and the gap between them is
            // exactly what the profiler panel is there to let you tune.
            width: this._host.canvas.width,
            height: this._host.canvas.height,
            renderWidth: this._host.renderWidth,
            renderHeight: this._host.renderHeight,
            renderScale: this._host.renderScale,
            gpuBytes: this._estimateGpuBytes(),
        };
    }

    /** Rough GPU memory estimate: the renderer's own render-target framebuffers + registered asset
     *  textures. Excludes vertex/instance buffers and IBL cubemaps, so it is a lower bound. */
    private _estimateGpuBytes(): number {
        let bytes = 0;
        const addFbo = (fbo?: Framebuffer) => {
            if (!fbo) return;
            for (const c of fbo.colors) bytes += c.byteSize;
            if (fbo.depth) bytes += fbo.depth.byteSize;
        };
        addFbo(this._targets.scene); addFbo(this._targets.gBuffer);
        bytes += this._shadows.shadowCascadeFBO.texture.byteSize; // one array texture, layers included
        bytes += this._shadows.spotShadowFBO.texture.byteSize;
        bytes += this._shadows.pointShadowFBO.texture.byteSize;
        for (const m of this._post.bloomMips) addFbo(m);
        // The cloud temporal targets and baked noise volumes belong here too — an 8MB volume absent
        // from the estimate defeats its purpose.
        addFbo(this._targets.sceneDepth); addFbo(this._clouds.cloudsFBO); addFbo(this._clouds.cloudTraceFBO);
        addFbo(this._targets.refraction ?? undefined);
        for (const f of this._clouds.cloudHistory.targets) addFbo(f);
        if (this._clouds.cloudBaseNoise) bytes += this._clouds.cloudBaseNoise.byteSize;
        if (this._clouds.cloudDetailNoise) bytes += this._clouds.cloudDetailNoise.byteSize;
        addFbo(this._ssil.ssaoFBO); addFbo(this._ssil.ssaoBlurFBO);
        for (const f of this._ssil.ssilHistory.targets) addFbo(f);
        // The TAA history and its depth copy, and the smoke-and-fire trace and history: allocated on first
        // use, so a project that never turns them on is charged nothing.
        for (const f of this._temporal.taaHistory.targets) addFbo(f);
        addFbo(this._temporal.prevDepthFBO ?? undefined);
        addFbo(this._fluids.traceFBO ?? undefined);
        for (const f of this._fluids.fluidHistory.targets) addFbo(f);
        addFbo(this._radiance.fbo ?? undefined);
        addFbo(this._ssr.traceFBO ?? undefined); addFbo(this._ssr.resolveFBO ?? undefined);
        for (const f of this._ssr.history.targets) addFbo(f);
        for (const cube of this._sky.skyReflectionCubes) if (cube) bytes += cube.byteSize;
        addFbo(this._sky.brdfFBO); addFbo(this._post.outlineMaskFBO); addFbo(this._targets.overlay);
        addFbo(this._debugViews.overdrawFBO ?? undefined);
        addFbo(this._targets.velocity); addFbo(this._temporal.velocityTileFBO); addFbo(this._temporal.velocityNeighborFBO);
        addFbo(this._decals.dBufferFBO ?? undefined); addFbo(this._decals.gBufferCopyFBO ?? undefined);
        addFbo(this._decals.decalReceiverFBO ?? undefined);
        bytes += this._host.postPool.byteSize;
        bytes += this._host.objectTableBytes;
        for (const tex of TextureManager.Instance.textures.values()) bytes += tex.byteSize;
        return bytes;
    }
}
