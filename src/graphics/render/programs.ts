// The renderer's shader programs: one WGSL import per program (each `.wgsl` import is a whole program,
// see src/wgsl.d.ts), the table of every program the renderer registers, and the per-family lookups the
// passes use to find a program's reflection by its registered name.

import type { ShaderProgramDescriptor } from '../rhi/shaderProgram';
import type { ShaderResource } from '../rhi/types';
import { PARTICLE_PROGRAMS } from '../particles/particleRenderer';

import BasicProgram from '../shaders/wgsl/basic.wgsl';
import BasicInstancedProgram from '../shaders/wgsl/basicInstanced.wgsl';
import BasicSkinnedProgram from '../shaders/wgsl/basicSkinned.wgsl';
import SpriteLitProgram from '../shaders/wgsl/spriteLit.wgsl';
import BlinnPhongProgram from '../shaders/wgsl/blinnPhong.wgsl';
import BlinnPhongSkinnedProgram from '../shaders/wgsl/blinnPhongSkinned.wgsl';
import CelProgram from '../shaders/wgsl/cel.wgsl';
import CelSkinnedProgram from '../shaders/wgsl/celSkinned.wgsl';
import OutlineProgram from '../shaders/wgsl/outline.wgsl';

import ShadowMapProgram from '../shaders/wgsl/shadowMap.wgsl';
import ShadowMapSkinnedProgram from '../shaders/wgsl/shadowMapSkinned.wgsl';
import ShadowMapInstancedProgram from '../shaders/wgsl/shadowMapInstanced.wgsl';
import ShadowMapInstancedCutoutProgram from '../shaders/wgsl/shadowMapInstancedCutout.wgsl';
import ShadowMapCutoutProgram from '../shaders/wgsl/shadowMapCutout.wgsl';
import ShadowMapSkinnedCutoutProgram from '../shaders/wgsl/shadowMapSkinnedCutout.wgsl';
import ShadowMapBasicCutoutProgram from '../shaders/wgsl/shadowMapBasicCutout.wgsl';
import ShadowMapBasicSkinnedCutoutProgram from '../shaders/wgsl/shadowMapBasicSkinnedCutout.wgsl';
import ShadowDebugProgram from '../shaders/wgsl/shadowDebug.wgsl';
import SkyboxProgram from '../shaders/wgsl/skybox.wgsl';
import VolumetricCloudsProgram from '../shaders/wgsl/volumetricClouds.wgsl';
import CloudNoiseBakeProgram from '../shaders/wgsl/cloudNoiseBake.wgsl';
// Compute-only, so it has no GLSL half and never enters the ShaderManager program table: it is
// compiled straight to a device shader module by _bakeCloudNoiseCompute. See the file's header.
import CloudNoiseBakeComputeProgram from '../shaders/wgsl/cloudNoiseBakeCompute.wgsl';
import CloudTemporalResolveProgram from '../shaders/wgsl/cloudTemporalResolve.wgsl';
import CloudUpsampleProgram from '../shaders/wgsl/cloudUpsample.wgsl';
import SkyAtmosphereProgram from '../shaders/wgsl/skyAtmosphere.wgsl';
import ProbePreviewProgram from '../shaders/wgsl/probePreview.wgsl';
import SkyProjectProgram from '../shaders/wgsl/skyProject.wgsl';
import SkyFogProgram from '../shaders/wgsl/skyFog.wgsl';
// Decal volumes: the DBuffer write, its resolve into the G-buffer, and the emissive/overlay colour pass.
import DecalSurfaceProgram from '../shaders/wgsl/decalSurface.wgsl';
import DecalResolveProgram from '../shaders/wgsl/decalResolve.wgsl';
import DecalColorProgram from '../shaders/wgsl/decalColor.wgsl';
// Smoke-and-fire volumes (FluidVolumeNode): a box-bounded raymarch of a voxel texture.
import FluidVolumeProgram from '../shaders/wgsl/fluidVolume.wgsl';
import FluidVolumeResolveProgram from '../shaders/wgsl/fluidVolumeResolve.wgsl';
import FluidVolumeCompositeProgram from '../shaders/wgsl/fluidVolumeComposite.wgsl';

// A `.wgsl` import is a whole PROGRAM: the loader translates both stages to GLSL ES 300 at build time
// and carries the WGSL through for WebGPU. The `.vs`/`.fs` imports above are the unconverted ones.
import ScreenProgram from '../shaders/wgsl/screen.wgsl';
import PresentProgram from '../shaders/wgsl/present.wgsl';
import OverlayCompositeProgram from '../shaders/wgsl/overlayComposite.wgsl';
import DebugViewProgram from '../shaders/wgsl/debugView.wgsl';
import OverdrawProgram from '../shaders/wgsl/overdraw.wgsl';
import OverdrawInstancedProgram from '../shaders/wgsl/overdrawInstanced.wgsl';
import BloomProgram from '../shaders/wgsl/bloom.wgsl';
import ExposureMeterProgram from '../shaders/wgsl/exposureMeter.wgsl';
import BloomDownsampleProgram from '../shaders/wgsl/bloomDownsample.wgsl';
import BloomUpsampleProgram from '../shaders/wgsl/bloomUpsample.wgsl';
import ChromaticAberrationProgram from '../shaders/wgsl/chromaticAberration.wgsl';
import DofCocProgram from '../shaders/wgsl/dofCoc.wgsl';
import DofGatherProgram from '../shaders/wgsl/dofGather.wgsl';
import DofCompositeProgram from '../shaders/wgsl/dofComposite.wgsl';
import LensFlareProgram from '../shaders/wgsl/lensFlare.wgsl';
import LensFlareCompositeProgram from '../shaders/wgsl/lensFlareComposite.wgsl';
import VignetteProgram from '../shaders/wgsl/vignette.wgsl';
import TaaSharpenProgram from '../shaders/wgsl/taaSharpen.wgsl';
import FxaaProgram from '../shaders/wgsl/fxaa.wgsl';
import FilmGrainProgram from '../shaders/wgsl/filmGrain.wgsl';
import ComposerProgram from '../shaders/wgsl/composer.wgsl';
import VolumetricGodRaysProgram from '../shaders/wgsl/volumetricGodRays.wgsl';
import GridProgram from '../shaders/wgsl/grid.wgsl';
import OutlinePostProgram from '../shaders/wgsl/outlinePost.wgsl';
import MotionBlurVelocityProgram from '../shaders/wgsl/motionBlurVelocity.wgsl';
import TaaResolveProgram from '../shaders/wgsl/taaResolve.wgsl';
import MotionBlurTileMaxProgram from '../shaders/wgsl/motionBlurTileMax.wgsl';
import MotionBlurNeighborMaxProgram from '../shaders/wgsl/motionBlurNeighborMax.wgsl';
import MotionBlurGatherProgram from '../shaders/wgsl/motionBlur.wgsl';
// Per-object velocity: drawn OVER the camera-reprojection buffer, one variant per vertex layout.
import ObjectVelocityProgram from '../shaders/wgsl/objectVelocity.wgsl';
import ObjectVelocitySkinnedProgram from '../shaders/wgsl/objectVelocitySkinned.wgsl';
import ObjectVelocityBasicSkinnedProgram from '../shaders/wgsl/objectVelocityBasicSkinned.wgsl';
import PBRProgram from '../shaders/wgsl/pbr.wgsl';
import PBRSkinnedProgram from '../shaders/wgsl/pbrSkinned.wgsl';
import TerrainForwardProgram from '../shaders/wgsl/terrainForward.wgsl';
import TilemapProgram from '../shaders/wgsl/tilemap.wgsl';

// Deferred pipeline shaders
import GeometryPBRProgram from '../shaders/wgsl/geometryPBR.wgsl';
import GeometryPBRSkinnedProgram from '../shaders/wgsl/geometryPBRSkinned.wgsl';
import GeometryPBRInstancedProgram from '../shaders/wgsl/geometryPBRInstanced.wgsl';
import GeometryBlinnPhongProgram from '../shaders/wgsl/geometryBlinnPhong.wgsl';
import GeometryBlinnPhongSkinnedProgram from '../shaders/wgsl/geometryBlinnPhongSkinned.wgsl';
import GeometryBlinnPhongInstancedProgram from '../shaders/wgsl/geometryBlinnPhongInstanced.wgsl';
import GeometryTerrainProgram from '../shaders/wgsl/geometryTerrain.wgsl';
import GeometryFoliageBillboardProgram from '../shaders/wgsl/geometryFoliageBillboard.wgsl';
import GeometryFoliageImpostorProgram from '../shaders/wgsl/geometryFoliageImpostor.wgsl';
import OcclusionBoxProgram from '../shaders/wgsl/occlusionBox.wgsl';
import ShadowMapImpostorProgram from '../shaders/wgsl/shadowMapImpostor.wgsl';
import GeometryBasicProgram from '../shaders/wgsl/geometryBasic.wgsl';
import GeometryBasicSkinnedProgram from '../shaders/wgsl/geometryBasicSkinned.wgsl';
import DeferredLightingProgram from '../shaders/wgsl/deferredLighting.wgsl';
import SsilProgram from '../shaders/wgsl/ssil.wgsl';
import SsilTemporalProgram from '../shaders/wgsl/ssilTemporal.wgsl';
import SsilBlurProgram from '../shaders/wgsl/ssilBlur.wgsl';
import SsilHistoryProgram from '../shaders/wgsl/ssilHistory.wgsl';
import SsrProgram from '../shaders/wgsl/ssr.wgsl';
import SsrResolveProgram from '../shaders/wgsl/ssrResolve.wgsl';
import SsrTemporalProgram from '../shaders/wgsl/ssrTemporal.wgsl';
import LocalExposureLumProgram from '../shaders/wgsl/localExposureLum.wgsl';
import LocalExposureDownProgram from '../shaders/wgsl/localExposureDown.wgsl';
import VolumetricFogInjectProgram from '../shaders/wgsl/volumetricFogInject.wgsl';
import VolumetricFogIntegrateProgram from '../shaders/wgsl/volumetricFogIntegrate.wgsl';
import VolumetricFogApplyProgram from '../shaders/wgsl/volumetricFogApply.wgsl';
// GI Volumes (render/gi/): capture reduce, visibility, relight radiance and integrate, apply.
import GiReduceProgram from '../shaders/wgsl/giReduce.wgsl';
import GiVisibilityProgram from '../shaders/wgsl/giVisibility.wgsl';
import GiRadianceProgram from '../shaders/wgsl/giRadiance.wgsl';
import GiIntegrateProgram from '../shaders/wgsl/giIntegrate.wgsl';
import GiResolveProgram from '../shaders/wgsl/giResolve.wgsl';
import GiAmbientCubeProgram from '../shaders/wgsl/giAmbientCube.wgsl';
import GiRescaleProgram from '../shaders/wgsl/giRescale.wgsl';
import GiProbeOverlayProgram from '../shaders/wgsl/giProbeOverlay.wgsl';
import GiStateStampProgram from '../shaders/wgsl/giStateStamp.wgsl';

// IBL (image-based lighting) precompute shaders
import IrradianceProgram from '../shaders/wgsl/irradiance.wgsl';
import PrefilterProgram from '../shaders/wgsl/prefilter.wgsl';
import PrefilterOctProgram from '../shaders/wgsl/prefilterOct.wgsl';
import BRDFProgram from '../shaders/wgsl/brdf.wgsl';
// A movie's sample accumulation (render/movieCapture.ts).
import MovieAccumulateProgram from '../shaders/wgsl/movieAccumulate.wgsl';

export {
    BasicProgram, BasicInstancedProgram, BasicSkinnedProgram, BlinnPhongProgram,
    BlinnPhongSkinnedProgram, CelProgram, CelSkinnedProgram, OutlineProgram,
    ShadowMapProgram, ShadowMapSkinnedProgram, ShadowMapInstancedProgram, ShadowMapInstancedCutoutProgram,
    ShadowMapCutoutProgram, ShadowMapSkinnedCutoutProgram, ShadowMapBasicCutoutProgram, ShadowMapBasicSkinnedCutoutProgram,
    ShadowDebugProgram, SkyboxProgram, VolumetricCloudsProgram, CloudNoiseBakeProgram,
    CloudNoiseBakeComputeProgram, CloudTemporalResolveProgram, CloudUpsampleProgram, SkyAtmosphereProgram,
    ProbePreviewProgram, SkyProjectProgram, SkyFogProgram, DecalSurfaceProgram,
    DecalResolveProgram, DecalColorProgram, FluidVolumeProgram, FluidVolumeResolveProgram,
    FluidVolumeCompositeProgram, ScreenProgram, PresentProgram, OverlayCompositeProgram,
    DebugViewProgram, OverdrawProgram, OverdrawInstancedProgram, BloomProgram,
    ExposureMeterProgram, BloomDownsampleProgram, BloomUpsampleProgram, ChromaticAberrationProgram,
    DofCocProgram, DofGatherProgram, DofCompositeProgram, LensFlareProgram,
    LensFlareCompositeProgram, VignetteProgram, TaaSharpenProgram, FxaaProgram,
    FilmGrainProgram, ComposerProgram, VolumetricGodRaysProgram, GridProgram,
    OutlinePostProgram, MotionBlurVelocityProgram, TaaResolveProgram, MotionBlurTileMaxProgram,
    MotionBlurNeighborMaxProgram, MotionBlurGatherProgram, ObjectVelocityProgram, ObjectVelocitySkinnedProgram,
    ObjectVelocityBasicSkinnedProgram, PBRProgram, PBRSkinnedProgram, TerrainForwardProgram,
    TilemapProgram, GeometryPBRProgram, GeometryPBRSkinnedProgram, GeometryPBRInstancedProgram,
    GeometryBlinnPhongProgram, GeometryBlinnPhongSkinnedProgram, GeometryBlinnPhongInstancedProgram, GeometryTerrainProgram,
    GeometryFoliageBillboardProgram, GeometryFoliageImpostorProgram, OcclusionBoxProgram, ShadowMapImpostorProgram,
    GeometryBasicProgram, GeometryBasicSkinnedProgram, DeferredLightingProgram, SsilProgram,
    SsilTemporalProgram, SsilBlurProgram, SsilHistoryProgram, IrradianceProgram,
    PrefilterProgram, PrefilterOctProgram, BRDFProgram, SpriteLitProgram, SsrProgram,
    SsrResolveProgram, SsrTemporalProgram, LocalExposureLumProgram, LocalExposureDownProgram,
    VolumetricFogInjectProgram, VolumetricFogIntegrateProgram, VolumetricFogApplyProgram,
    GiReduceProgram, GiVisibilityProgram, GiRadianceProgram, GiIntegrateProgram, GiResolveProgram,
    GiAmbientCubeProgram, GiRescaleProgram, GiProbeOverlayProgram, GiStateStampProgram,
    MovieAccumulateProgram,
};

// Every program the renderer registers, by the name `ShaderManager` knows it as. Built through
// `createShaderProgram`, so this is the list either backend builds.
// Do not REORDER: the driver assigns attribute locations per program.
export function programTable(): ReadonlyArray<readonly [string, Omit<ShaderProgramDescriptor, 'label'>]> {
    return [
        ['basic',                        BasicProgram],
        // Forward unlit instanced shader for the editor skeleton overlay (many spheres/bones in one draw).
        ['basicInstanced',               BasicInstancedProgram],
        ['blinn_phong',                  BlinnPhongProgram],
        ['basicSkinned',                 BasicSkinnedProgram],
        ['blinn_phongSkinned',           BlinnPhongSkinnedProgram],
        ['pbr',                          PBRProgram],
        ['pbrSkinned',                   PBRSkinnedProgram],
        // Deferred geometry-pass shaders (they reuse the material vertex shaders + G-buffer fragment shaders).
        ['pbrGeometry',                  GeometryPBRProgram],
        ['pbrGeometrySkinned',           GeometryPBRSkinnedProgram],
        ['blinn_phongGeometry',          GeometryBlinnPhongProgram],
        ['blinn_phongGeometrySkinned',   GeometryBlinnPhongSkinnedProgram],
        ['basicGeometry',                GeometryBasicProgram],
        ['basicGeometrySkinned',         GeometryBasicSkinnedProgram],
        // Instanced geometry variants (pbr/default share the 14-float vertex layout).
        ['pbrGeometryInstanced',         GeometryPBRInstancedProgram],
        ['blinn_phongGeometryInstanced', GeometryBlinnPhongInstancedProgram],
        // Terrain splat geometry shader (reuses the default 14-float vertex layout). Registered TWICE, and
        // the two names must resolve to the same object — see the alias note below.
        ['terrain',                      GeometryTerrainProgram],
        ['terrainGeometry',              GeometryTerrainProgram],
        // Forward-lit terrain: used only by the light-probe capture (a forward pass), where the deferred
        // terrain G-buffer shader cannot be lit. Same 14-float layout as the deferred terrain shader.
        ['terrainForward',               TerrainForwardProgram],
        // Tilemap chunks: a 2D-only pos/uv/colour layout of their own, not the 14-float model layout.
        ['tilemap',                      TilemapProgram],
        // Instanced billboard foliage (grass).
        ['foliageBillboardInstanced',    GeometryFoliageBillboardProgram],
        // Deferred lighting (fullscreen).
        ['deferredLighting',             DeferredLightingProgram],
        // SSIL: trace, temporal accumulation, edge-aware blur, and the radiance it bounces (fullscreen).
        ['ssil',                         SsilProgram],
        ['ssilTemporal',                 SsilTemporalProgram],
        ['ssilBlur',                     SsilBlurProgram],
        ['ssilHistory',                  SsilHistoryProgram],
        // IBL precompute.
        ['irradiance',                   IrradianceProgram],
        ['prefilter',                    PrefilterProgram],
        // A light probe's reflection, prefiltered into its layer of the octahedral reflection atlas.
        ['prefilterOct',                 PrefilterOctProgram],
        ['brdf',                         BRDFProgram],
        // Environment.
        ['shadowMap',                    ShadowMapProgram],
        // Skinned depth, so animated meshes cast their animated-pose shadow rather than the bind pose.
        ['shadowMapSkinned',             ShadowMapSkinnedProgram],
        ['shadowMapInstanced',           ShadowMapInstancedProgram],
        ['shadowMapInstancedCutout',     ShadowMapInstancedCutoutProgram],
        // One cutout depth variant per VERTEX FAMILY. texCoord sits at location 1 for the unlit
        // Basic layout and at 2 for the lit one, and the skinned variants pack bones at 2/3 and
        // 5/6 respectively, so no single program can read uv for all four.
        ['shadowMapCutout',              ShadowMapCutoutProgram],
        ['shadowMapSkinnedCutout',       ShadowMapSkinnedCutoutProgram],
        ['shadowMapBasicCutout',         ShadowMapBasicCutoutProgram],
        ['shadowMapBasicSkinnedCutout',  ShadowMapBasicSkinnedCutoutProgram],
        ['skybox',                       SkyboxProgram],
        // Volumetric clouds (fullscreen raymarch, on the screen vertex shader).
        ['volumetricClouds',             VolumetricCloudsProgram],
        ['cloudNoiseBake',               CloudNoiseBakeProgram],
        ['cloudTemporalResolve',         CloudTemporalResolveProgram],
        ['cloudUpsample',                CloudUpsampleProgram],
        // Sky atmosphere (per-direction Nishita scattering, baked into a cubemap via the IBL cube VS).
        ['skyAtmosphere',                SkyAtmosphereProgram],
        // Probe preview: equirectangular unwrap of a probe's captured cube, for the editor thumbnail.
        ['probePreview',                 ProbePreviewProgram],
        ['skyProject',                   SkyProjectProgram],
        // Sky fog (fullscreen distance fog whose colour is sampled from the atmosphere cubemap).
        ['skyFog',                       SkyFogProgram],
        // Screen.
        ['screen',                       ScreenProgram],
        // Final present: exposure -> tonemap -> sRGB (the single display resolve).
        ['present',                      PresentProgram],
        // Editor overlay composite: sRGB-encode the chrome layer over the resolved image.
        // APPENDED, never inserted mid-table — drivers assign attribute locations per program.
        ['overlayComposite',             OverlayCompositeProgram],
        ['godRays',                      VolumetricGodRaysProgram],
        ['debugView',                    DebugViewProgram],
        ['shadowDebug',                  ShadowDebugProgram],
        ['bloom',                        BloomProgram],
        ['exposureMeter',                ExposureMeterProgram],
        // Reuses the selection-mask vertex shader: the minimal MVP transform the mask pass already drives
        // over these same meshes, so no new vertex path is introduced.
        ['overdraw',                     OverdrawProgram],
        ['bloomDownsample',              BloomDownsampleProgram],
        ['bloomUpsample',                BloomUpsampleProgram],
        ['chromaticAberration',          ChromaticAberrationProgram],
        ['dofCoc',                       DofCocProgram],
        ['dofGather',                    DofGatherProgram],
        ['dofComposite',                 DofCompositeProgram],
        ['lensFlare',                    LensFlareProgram],
        ['lensFlareComposite',           LensFlareCompositeProgram],
        ['vignette',                     VignetteProgram],
        ['filmGrain',                    FilmGrainProgram],
        // Temporal antialiasing: reproject the history through the velocity buffer and blend.
        ['taaResolve',                   TaaResolveProgram],
        ['composer',                     ComposerProgram],
        // Editor infinite grid (fullscreen world-plane pass).
        ['grid',                         GridProgram],
        // Outline: the material shader stamps the selection silhouette into the mask; the screen shader
        // turns that mask into a border in a post pass.
        ['outline',                      OutlineProgram],
        ['outlinePost',                  OutlinePostProgram],
        // Motion blur (camera reprojection): velocity -> tile max -> neighbor max -> gather.
        ['motionBlurVelocity',           MotionBlurVelocityProgram],
        ['motionBlurTileMax',            MotionBlurTileMaxProgram],
        ['motionBlurNeighborMax',        MotionBlurNeighborMaxProgram],
        ['motionBlur',                   MotionBlurGatherProgram],
        // Per-object velocity, drawn over the reprojection buffer. Three variants for the three
        // skinned/unskinned vertex layouts — each declares the SAME attributes as the colour
        // program of its family.
        ['objectVelocity',               ObjectVelocityProgram],
        ['objectVelocitySkinned',        ObjectVelocitySkinnedProgram],
        ['objectVelocityBasicSkinned',   ObjectVelocityBasicSkinnedProgram],
        // Forward Cel (toon). APPENDED, per the note at the top of this table — cel is
        // forward-only, so there is no geometry twin to sit beside the other material pairs.
        ['cel',                          CelProgram],
        ['celSkinned',                   CelSkinnedProgram],
        // Decal volumes. APPENDED, per the note at the top of this table.
        ['decalSurface',                 DecalSurfaceProgram],
        ['decalResolve',                 DecalResolveProgram],
        ['decalColor',                   DecalColorProgram],
        // GPU particles: the WebGL2 ping-pong simulation step and the billboard draw. APPENDED.
        [PARTICLE_PROGRAMS.sim[0],       PARTICLE_PROGRAMS.sim[1]],
        [PARTICLE_PROGRAMS.billboard[0], PARTICLE_PROGRAMS.billboard[1]],
        [PARTICLE_PROGRAMS.mesh[0],      PARTICLE_PROGRAMS.mesh[1]],
        [PARTICLE_PROGRAMS.sort[0],      PARTICLE_PROGRAMS.sort[1]],
        // The overdraw debug view's instanced twin, for terrain foliage. APPENDED.
        ['overdrawInstanced',            OverdrawInstancedProgram],
        // Octahedral foliage impostors (terrain/octahedralImpostor.ts). APPENDED.
        ['foliageImpostorInstanced',     GeometryFoliageImpostorProgram],
        // GPU occlusion query boxes (graphics/gpuOcclusion.ts). APPENDED.
        ['occlusionBox',                 OcclusionBoxProgram],
        // Foliage shadows cast through the octahedral impostor, in the outer cascades. APPENDED.
        ['shadowMapImpostorInstanced',   ShadowMapImpostorProgram],
        // Antialiasing extras: RCAS sharpening of the TAA output, and FXAA. APPENDED.
        ['taaSharpen',                   TaaSharpenProgram],
        ['fxaa',                         FxaaProgram],
        // Smoke-and-fire volumes (core/scene/nodes/fluidVolumeNode.ts). APPENDED.
        ['fluidVolume',                  FluidVolumeProgram],
        ['fluidVolumeResolve',           FluidVolumeResolveProgram],
        ['fluidVolumeComposite',         FluidVolumeCompositeProgram],
        // Lit sprites (Sprite.lit: six-way lightmaps, surface maps, flat). APPENDED.
        ['spriteLit',                    SpriteLitProgram],
        // Screen-space reflections: trace, resolve, temporal accumulation (render/ssr.ts). APPENDED.
        ['ssr',                          SsrProgram],
        ['ssrResolve',                   SsrResolveProgram],
        ['ssrTemporal',                  SsrTemporalProgram],
        // Local exposure: the region weights and their pyramid (render/localExposure.ts). APPENDED.
        ['localExposureLum',             LocalExposureLumProgram],
        ['localExposureDown',            LocalExposureDownProgram],
        // Froxel volumetric fog for VolumetricFogNode (render/volumetricFog.ts). APPENDED.
        ['volumetricFogInject',          VolumetricFogInjectProgram],
        ['volumetricFogIntegrate',       VolumetricFogIntegrateProgram],
        ['volumetricFogApply',           VolumetricFogApplyProgram],
        // GI Volumes (render/gi/). APPENDED.
        ['giReduce',                     GiReduceProgram],
        ['giVisibility',                 GiVisibilityProgram],
        ['giRadiance',                   GiRadianceProgram],
        ['giIntegrate',                  GiIntegrateProgram],
        ['giResolve',                    GiResolveProgram],
        ['giAmbientCube',                GiAmbientCubeProgram],
        ['giRescale',                    GiRescaleProgram],
        // The editor's GI probe overlay (render/editorOverlays.ts). APPENDED.
        ['giProbeOverlay',               GiProbeOverlayProgram],
        // The probe states in the irradiance atlas's alpha (render/gi/giSystem.ts). APPENDED.
        ['giStateStamp',                 GiStateStampProgram],
        // A movie frame's samples, averaged before the display resolve (render/movieCapture.ts). APPENDED.
        ['movieAccumulate',              MovieAccumulateProgram],
    ];
}

/** WGSL reflection for the depth-only shadow programs, reachable by the name the pass picks. */
export const SHADOW_PROGRAMS: Record<string, { resources: readonly ShaderResource[] }> = {
    shadowMap: ShadowMapProgram,
    shadowMapSkinned: ShadowMapSkinnedProgram,
    shadowMapCutout: ShadowMapCutoutProgram,
    shadowMapSkinnedCutout: ShadowMapSkinnedCutoutProgram,
    shadowMapBasicCutout: ShadowMapBasicCutoutProgram,
    shadowMapBasicSkinnedCutout: ShadowMapBasicSkinnedCutoutProgram,
};

/** WGSL reflection for the per-object velocity programs, by the name `_velocityShaderFor` picks. */
export const VELOCITY_PROGRAMS: Record<string, { resources: readonly ShaderResource[] }> = {
    objectVelocity: ObjectVelocityProgram,
    objectVelocitySkinned: ObjectVelocitySkinnedProgram,
    objectVelocityBasicSkinned: ObjectVelocityBasicSkinnedProgram,
};

/**
 * The forward-lit programs, by registered name. Their group 0 is material textures PLUS the
 * environment cube — a forward shader resolves its own reflection. Custom materials are absent: their
 * programs compile at runtime, and their pipelines are built from the material's own reflection.
 */
export const FORWARD_PROGRAMS: Record<string, { resources: readonly ShaderResource[] }> = {
    pbr: PBRProgram,
    pbrSkinned: PBRSkinnedProgram,
    // The parallax variants' logical names; `_pipelineFor` swaps in the variant's own WGSL.
    pbrPom: PBRProgram,
    pbrSkinnedPom: PBRSkinnedProgram,
    blinn_phong: BlinnPhongProgram,
    blinn_phongSkinned: BlinnPhongSkinnedProgram,
    // Cel declares no env cube, so its group 0 is five plain material slots and
    // `BindGroupCache` yields no null entry for `materialGroup` to fill.
    cel: CelProgram,
    celSkinned: CelSkinnedProgram,
    terrainForward: TerrainForwardProgram,
    basic: BasicProgram,
    basicSkinned: BasicSkinnedProgram,
    basicInstanced: BasicInstancedProgram,
    // A lit sprite's private material (Sprite.drawMaterial); drawn by the 2D pass alone.
    spriteLit: SpriteLitProgram,
};

/** WGSL reflection for the geometry programs, by the name `GeometryPass._geometryShaderFor` picks at draw time. */
export const GEOMETRY_PROGRAMS: Record<string, { resources: readonly ShaderResource[] }> = {
    pbrGeometry: GeometryPBRProgram,
    pbrGeometrySkinned: GeometryPBRSkinnedProgram,
    pbrGeometryInstanced: GeometryPBRInstancedProgram,
    pbrGeometryPom: GeometryPBRProgram,
    pbrGeometrySkinnedPom: GeometryPBRSkinnedProgram,
    pbrGeometryInstancedPom: GeometryPBRInstancedProgram,
    pbrGeometryInstancedFoliage: GeometryPBRInstancedProgram,
    pbrGeometryOpaque: GeometryPBRProgram,
    pbrGeometrySkinnedOpaque: GeometryPBRSkinnedProgram,
    pbrGeometryInstancedOpaque: GeometryPBRInstancedProgram,
    pbrGeometryInstancedLean: GeometryPBRInstancedProgram,
    pbrGeometryInstancedLeanFoliage: GeometryPBRInstancedProgram,
    pbrGeometryInstancedPrepass: GeometryPBRInstancedProgram,
    pbrGeometryInstancedPrepassFoliage: GeometryPBRInstancedProgram,
    pbrGeometryInstancedLeanOpaque: GeometryPBRInstancedProgram,
    pbrGeometryInstancedLeanOpaqueFoliage: GeometryPBRInstancedProgram,
    terrainGeometry: GeometryTerrainProgram,
    basicGeometry: GeometryBasicProgram,
    basicGeometrySkinned: GeometryBasicSkinnedProgram,
    blinn_phongGeometry: GeometryBlinnPhongProgram,
    blinn_phongGeometrySkinned: GeometryBlinnPhongSkinnedProgram,
    blinn_phongGeometryInstanced: GeometryBlinnPhongInstancedProgram,
};
