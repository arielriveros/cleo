import type { WindOptions } from "./windNode";
import { definePresets, type Preset } from "../../presets";

/**
 * One-click weather for the scene's WindNode. A preset sets how hard the wind blows, how its gusts travel
 * and how much it wanders — never `direction`, which is where the author aimed it, nor the fade distances,
 * which are a performance budget rather than a look.
 */
export type WindPreset = Preset<WindOptions>;

const BASE: WindOptions = { strength: 1, gustScale: 18, gustSpeed: 4, gustiness: 0.8, veer: 20 };

export const WIND_PRESETS: WindPreset[] = definePresets(BASE, [
    ['calm', 'Calm', 'Barely a stir — plants all but still, the faint air drifting where it likes.',
        { strength: 0.15, gustScale: 30, gustSpeed: 1, gustiness: 0.5, veer: 30 }],
    ['lightBreeze', 'Light Breeze', 'A gentle sway with slow, broad gusts.',
        { strength: 0.5, gustScale: 25, gustSpeed: 2.5, gustiness: 0.7, veer: 25 }],
    ['breezy', 'Breezy', 'The default: what wind-enabled materials are authored for.', {}],
    ['rollingFields', 'Rolling Fields', 'Wide gusts that sweep whole fields of grass together, all one way.',
        { strength: 0.8, gustScale: 60, gustSpeed: 5, gustiness: 0.9, veer: 12 }],
    ['windy', 'Windy', 'A steady lean with brisk gusts running through it.',
        { strength: 1.4, gustScale: 14, gustSpeed: 7, gustiness: 0.75, veer: 15 }],
    ['gale', 'Gale', 'Strong, fast, choppy gusts.',
        { strength: 1.8, gustScale: 10, gustSpeed: 11, gustiness: 0.85, veer: 22 }],
    ['storm', 'Storm', 'Everything thrashing — short, violent gusts that keep changing their mind.',
        { strength: 2, gustScale: 8, gustSpeed: 15, gustiness: 0.9, veer: 35 }],
]);
