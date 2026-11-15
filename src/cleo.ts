// The whole engine: the runtime (./cleoCore.ts, what a published game ships) and the editor's tools beside
// it -- the model importers, the script compiler and the movie renderer. The editor, Play in window and the
// tests import this; the published player imports cleo/cleoCore and leaves these out (vite.player.config.ts
// fails its build if anything there reaches this file).
export * from "./cleoCore";
// The optional features' names (src/modules/<id>/api.ts): the runtime barrel leaves them out, since a published
// game loads each feature as a chunk of its own; the full engine has them all, and installs them all below.
export * from "./modules/sequencer/api";
export * from "./modules/landscape/api";
export * from "./modules/weather/api";
export * from "./modules/particles/api";
export * from "./modules/physics2d/api";
export * from "./modules/world2d/api";
export * from "./modules/volumetricFog/api";
export * from "./modules/gi/api";
export * from "./modules/volumetricClouds/api";
export * from "./modules/fluids/api";
export * from "./modules/decals/api";
export * from "./modules/cloth/api";
export * from "./modules/water/api";
// The particle modules also name a `RenderSettings` (an emitter's draw settings, particles/particleModules.ts);
// the engine's own name is the renderer's.
export type { RenderSettings } from "./cleoCore";

export { Loader } from "./graphics/loader";
export type { TextureLoadReport, UnresolvedTexture } from "./graphics/loader";
// The pure (no DOM, no GL) half of model import, so the editor can run it inside a Web Worker.
// Pair with Loader.assembleAssimpModels, which does the GL half on the main thread.
export { parseAssimpFiles, parseResultTransferables, convertToGltf2FromFiles, readAssimpTextureSlots } from "./graphics/utils/assimpLoader";
export type { AssimpParseResult, AssimpTextureSlots, ParsedMesh, OutputMaterial } from "./graphics/utils/assimpLoader";
export { readFbxTextures, isBinaryFbx, fbxBaseName } from "./graphics/utils/fbxEmbedded";
export type { FbxTextureInfo, FbxEmbeddedImage, FbxMaterialTextures } from "./graphics/utils/fbxEmbedded";
export { GLTFLoader } from "./graphics/utils/gltfLoader";
export type { GltfParseResult, GltfMeshDescriptor, GltfMaterialDescriptor, GltfImageSource } from "./graphics/utils/gltfLoader";
// Which shader programs a game draws with, read off its scenes at publish (features/publish/collectProgramUsage.ts).
export { createProgramUsage, usageFromSceneJson, usageFromRenderSettings, castsShadows, programsFor, PROGRAM_CLASS } from "./graphics/programUsage";
export type { ProgramUsage } from "./graphics/programUsage";
export { MAX_SORTED_PARTICLES } from "./graphics/particles/particleRenderer";
// Rendering a sequence to video, offline (sequencer/movie/).
export {
    renderMovie, type MovieEngine, type MovieRenderOptions, type MovieFrame, type MovieSink, type MovieProgress,
    type MovieResult, type MovieEndReason, type MovieRunControls,
} from "./sequencer/movie/renderMovie";
export { beginMovieEngine, type MovieEngineHandle, type MovieEngineOptions } from "./sequencer/movie/movieEngine";
export { movieRenderSettings, type MovieQuality } from "./sequencer/movie/movieSettings";
export {
    frameRateOf, framesPerSecond, frameStart, frameTimestampUs, frameDurationUs, sampleTime, sampleJitter,
    shutterFromAngle, frameCountFor, type FrameRate, type SampleSettings,
} from "./sequencer/movie/movieTiming";

// The runtime reads model files and compiles script source through what is installed here, rather than
// importing the tools itself (graphics/model.ts, core/scripting/scriptRuntime.ts).
// Every optional feature, installed: the editor, Play in window and the tests run the whole engine.
import "./modules/all";
import { Loader as ModelFileLoader } from "./graphics/loader";
import { setModelFileImporter } from "./graphics/model";
import { setScriptTranspiler } from "./core/scripting/scriptRuntime";
import { sucraseTranspiler } from "./core/scripting/sucraseTranspiler";
setModelFileImporter(ModelFileLoader);
setScriptTranspiler(sucraseTranspiler);

// What a user script's `import { ... } from 'cleo'` resolves to wherever the full engine runs: the barrel's
// own namespace, over the runtime's. Must stay the LAST statement -- the self-import only works once every
// re-export above has been evaluated.
import * as CleoAPI from "./cleo";
import { registerScriptModule as register } from "./core/scripting/scriptRuntime";
register('cleo', CleoAPI);
