import type { WindOptions } from "./windNode";
import { definePresets, type Preset } from "../../presets";

/**
 * One-click weather for the scene's WindNode. A preset sets how hard the wind blows and how its gusts
 * travel — never `direction`, which is where the author aimed it, nor the fade distances, which are a
 * performance budget rather than a look.
 */
export type WindPreset = Preset<WindOptions>;

const BASE: WindOptions = { strength: 1, gustScale: 18, gustSpeed: 4 };

export const WIND_PRESETS: WindPreset[] = definePresets(BASE, [
    ['calm', 'Calm', 'Barely a stir — plants all but still.',
        { strength: 0.15, gustScale: 30, gustSpeed: 1 }],
    ['lightBreeze', 'Light Breeze', 'A gentle sway with slow, broad gusts.',
        { strength: 0.5, gustScale: 25, gustSpeed: 2.5 }],
    ['breezy', 'Breezy', 'The default: what wind-enabled materials are authored for.', {}],
    ['rollingFields', 'Rolling Fields', 'Wide gusts that sweep whole fields of grass together.',
        { strength: 0.8, gustScale: 60, gustSpeed: 5 }],
    ['windy', 'Windy', 'A steady lean with brisk gusts running through it.',
        { strength: 1.4, gustScale: 14, gustSpeed: 7 }],
    ['gale', 'Gale', 'Strong, fast, choppy gusts.',
        { strength: 1.8, gustScale: 10, gustSpeed: 11 }],
    ['storm', 'Storm', 'Everything thrashing — short, violent gusts.',
        { strength: 2, gustScale: 8, gustSpeed: 15 }],
]);
