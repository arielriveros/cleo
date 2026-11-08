import type { WeatherOptions } from "./weatherNode";
import { definePresets, type Preset } from "../../presets";

/**
 * One-click weather for a WeatherNode: how wet, how much stands in puddles, how much snow, and what falls
 * how hard. The weather only, never the box, the snow material, the shelter, or the look of what falls
 * (its sprite, size and speed).
 */
export type WeatherPreset = Preset<WeatherOptions>;

// The kind before its rate: the order the fields are assigned in.
const BASE: WeatherOptions = { wetness: 0, snow: 0, puddles: 0, precipitation: 'none', precipitationRate: 0, precipitationWind: 0.5 };

export const WEATHER_PRESETS: WeatherPreset[] = definePresets(BASE, [
    ['dry', 'Dry', 'The default: nothing wet, no snow, nothing falling.', {}],
    ['drizzle', 'Drizzle', 'A fine rain over damp ground and leaves, a little darker and glossier; no standing water.',
        { wetness: 0.4, precipitation: 'rain', precipitationRate: 0.2 }],
    ['rain', 'Rain', 'Steady rain on soaked, glossy ground, rippling the water standing in its hollows.',
        { wetness: 1, puddles: 0.7, precipitation: 'rain', precipitationRate: 0.6 }],
    ['storm', 'Storm', 'A downpour slanting in the wind, the hollows brimming.',
        { wetness: 1, puddles: 0.9, precipitation: 'rain', precipitationRate: 1, precipitationWind: 1 }],
    ['lightSnow', 'Light Snow', 'Flakes drifting down onto a dusting on flat ground and the tops of leaves and blades.',
        { wetness: 0.2, snow: 0.35, precipitation: 'snow', precipitationRate: 0.3 }],
    ['snowedIn', 'Snowed In', 'Thick snow on everything flat enough to hold it, branches bowed under it, still snowing.',
        { snow: 1, precipitation: 'snow', precipitationRate: 0.6 }],
    ['blizzard', 'Blizzard', 'Snow driven hard on the wind over a thick cover.',
        { snow: 1, precipitation: 'snow', precipitationRate: 1, precipitationWind: 1 }],
]);
