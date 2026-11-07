import type { WeatherOptions } from "./weatherNode";
import { definePresets, type Preset } from "../../presets";

/**
 * One-click weather for a WeatherNode: how wet, how much stands in puddles, how much snow. The weather
 * only, never the box, the snow material or the shelter.
 */
export type WeatherPreset = Preset<WeatherOptions>;

const BASE: WeatherOptions = { wetness: 0, snow: 0, puddles: 0 };

export const WEATHER_PRESETS: WeatherPreset[] = definePresets(BASE, [
    ['dry', 'Dry', 'The default: nothing wet, no snow.', {}],
    ['drizzle', 'Drizzle', 'Damp ground and leaves, a little darker and glossier; no standing water.', { wetness: 0.4 }],
    ['rain', 'Rain', 'Soaked: dark, glossy ground with water standing in its hollows, leaves bowed under it.', { wetness: 1, puddles: 0.7 }],
    ['lightSnow', 'Light Snow', 'A dusting on flat ground and on the tops of leaves and blades.', { wetness: 0.2, snow: 0.35 }],
    ['snowedIn', 'Snowed In', 'Thick snow on everything flat enough to hold it, branches bowed under it.', { snow: 1 }],
]);
