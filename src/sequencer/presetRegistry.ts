import type { Preset } from '../core/presets';
import { lerp } from '../core/math';
import { VOLUMETRIC_CLOUDS_PRESETS } from '../core/scene/nodes/volumetricCloudsPresets';
import { WIND_PRESETS } from '../core/scene/nodes/windPresets';
import { WEATHER_PRESETS } from '../core/scene/nodes/weatherPresets';

/**
 * The preset lists a sequence's Preset track can blend between, by node type: the same tables the inspectors'
 * Presets menus apply. The Sky Atmosphere is left out on purpose: nearly every one of its setters re-bakes
 * the sky, so blending it would bake every frame (key its fields with Property tracks instead, sparingly).
 */
const LISTS = new Map<string, readonly Preset<any>[]>([
    ['volumetricClouds', VOLUMETRIC_CLOUDS_PRESETS],
    ['wind', WIND_PRESETS],
    ['weather', WEATHER_PRESETS],
]);

/** Make `presets` blendable on nodes of `nodeType` (a game's own node types, or a test's). */
export function registerSequencePresets(nodeType: string, presets: readonly Preset<any>[]): void {
    LISTS.set(nodeType, presets);
}

/** The presets a node of this type (or this node) blends between, or null when it has none. */
export function sequencePresetsFor(nodeOrType: string | { nodeType?: string } | null | undefined): readonly Preset<any>[] | null {
    const type = typeof nodeOrType === 'string' ? nodeOrType : nodeOrType?.nodeType;
    return (type && LISTS.get(type)) || null;
}

/** Every field the presets of `list` set, in their assignment order (the first preset's, then any others). */
export function presetFields(list: readonly Preset<any>[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const p of list) for (const k of Object.keys(p.options)) if (!seen.has(k)) { seen.add(k); out.push(k); }
    return out;
}

/**
 * `a` to `b` at `t` (0..1): numbers and same-length number arrays interpolate, everything else (a kind, a
 * flag) switches at the half. Arrays come back as fresh arrays.
 */
export function blendPresetValue(a: unknown, b: unknown, t: number): unknown {
    if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t);
    const arrA = ArrayBuffer.isView(a) ? Array.from(a as unknown as ArrayLike<number>) : a;
    const arrB = ArrayBuffer.isView(b) ? Array.from(b as unknown as ArrayLike<number>) : b;
    if (Array.isArray(arrA) && Array.isArray(arrB) && arrA.length === arrB.length
        && arrA.every(x => typeof x === 'number') && arrB.every(x => typeof x === 'number'))
        return arrA.map((x: number, i: number) => lerp(x, arrB[i] as number, t));
    const pick = t < 0.5 ? arrA : arrB;
    return Array.isArray(pick) ? pick.slice() : pick;
}
