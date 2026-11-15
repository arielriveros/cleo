// What the Weather feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export {
    WeatherNode, WEATHER_DEFAULTS, MIN_WEATHER_VOLUME_SIZE, PRECIPITATION_KINDS, parsePrecipitationSprite,
    type WeatherOptions, type PrecipitationKind, type PrecipitationSprite,
} from "../../core/scene/nodes/weatherNode";
// Falling rain and snow: the particle system a WeatherNode's precipitation falls with, and its own sprites.
export { PrecipitationRig } from "../../core/scene/precipitationRig";
export {
    precipitationSystem, PRECIPITATION_DEFAULTS, builtinSpriteOf,
    type FallingKind, type PrecipitationStyle, type PrecipitationEnvironment,
} from "../../particles/precipitation";
