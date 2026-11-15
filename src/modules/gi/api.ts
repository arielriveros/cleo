// What the Global illumination feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { GIVolumeNode, GI_RAY_COUNTS, GI_CAPTURE_RESOLUTIONS, MIN_GI_PROBES_PER_AXIS, MAX_GI_PROBES_PER_AXIS, MAX_GI_PROBE_INSET, DEFAULT_NEW_GI_PROBE_INSET } from "../../core/scene/nodes/giVolumeNode";
export type { GiRayCount, GiCaptureResolution, GiVolumeOptions } from "../../core/scene/nodes/giVolumeNode";
export { encodeGiBake, decodeGiBake, GiBakeFormatError, GI_BAKE_VERSION, GI_BAKE_MIN_VERSION } from "../../graphics/render/gi/giBakeFormat";
