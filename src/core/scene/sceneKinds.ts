// The node kinds a scene's typed lists are built from, one bit each (see `kindsOf` in scene.ts). A leaf, so an
// optional feature's module can name the bit its node class fills (src/core/features/registry.ts) without
// importing scene.ts, which reaches the engine and the renderer.
export const K = {
    LIGHT: 1, MODEL: 2, SPRITE: 4, LANDSCAPE: 8, TILEMAP: 16, LOD_GROUP: 32, CAMERA_RIG: 64, CHARACTER: 128,
    CONTROLLER: 256, NAV_MESH: 512, DECAL: 1024, FLUID: 2048, CLOTH: 4096, PARTICLES: 8192, FORCE_FIELD: 16384,
    WATER: 32768, EXPOSURE: 65536, GI: 131072, FOG: 262144, OCCLUSION: 524288, SOUND: 1048576, PROBE: 2097152,
    SKYBOX: 4194304, CLOUDS: 8388608, ATMOSPHERE: 16777216, SKY_LIGHT: 33554432, WIND: 67108864,
    WEATHER: 134217728, CAMERA: 268435456, UI_NODE: 536870912, UI_ROOT: 1073741824,
} as const;

export type SceneKind = typeof K[keyof typeof K];
