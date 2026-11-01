import type { WeatherOptions } from "./weatherNode";
import { definePresets, type Preset } from "../../presets";

/** One-click weather for the scene's WeatherNode: how wet, how much snow. */
export type WeatherPreset = Preset<WeatherOptions>;

const BASE: WeatherOptions = { wetness: 0, snow: 0 };

export const WEATHER_PRESETS: WeatherPreset[] = definePresets(BASE, [
    ['dry', 'Dry', 'The default: nothing wet, no snow.', {}],
    ['drizzle', 'Drizzle', 'Damp leaves, a little darker and glossier.', { wetness: 0.4 }],
    ['rain', 'Rain', 'Soaked: dark, glossy leaves bowed under the water.', { wetness: 1 }],
    ['lightSnow', 'Light Snow', 'A dusting on the tops of leaves and blades.', { wetness: 0.2, snow: 0.35 }],
    ['snowedIn', 'Snowed In', 'Thick snow on everything that faces up, branches bowed under it.', { snow: 1 }],
]);
