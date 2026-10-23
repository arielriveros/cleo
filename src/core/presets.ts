/**
 * One-click configurations for nodes and render settings. A preset is a named set of fields assigned onto a
 * target through its own setters, so the target's clamping still applies.
 */
export interface Preset<O extends object = Record<string, unknown>> {
    id: string;
    label: string;
    description: string;
    options: O;
}

/**
 * Builds a preset table in which every entry is spread over `base`, so applying one never leaves fields from
 * the previous preset behind. `base`'s key order is the assignment order: put a limit before the value it
 * clamps (pitchMin before pitch, fadeStart before fadeEnd).
 */
export function definePresets<O extends object>(
    base: O, entries: ReadonlyArray<[id: string, label: string, description: string, options: Partial<O>]>,
): Preset<O>[] {
    return entries.map(([id, label, description, options]) => ({ id, label, description, options: { ...base, ...options } }));
}

// A fresh copy of `v`; an array lands as the same typed-array class the target holds (a gl-matrix vec3 stays one).
const copy = (v: unknown, current: unknown): unknown => {
    if (Array.isArray(v))
        return ArrayBuffer.isView(current) ? new (current.constructor as new (a: number[]) => unknown)(v) : [...v];
    if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return { ...v };
    return v;
};

/**
 * Assigns a preset — by id from `table`, or a preset object — onto `target` in key order. Arrays and plain
 * objects are copied so the shared table is never mutated through the target. Returns false for an unknown id.
 */
export function applyPreset<O extends object>(
    target: object, table: readonly Preset<O>[], idOrPreset: string | Preset<O>,
): boolean {
    const preset = typeof idOrPreset === 'string' ? table.find(p => p.id === idOrPreset) : idOrPreset;
    if (!preset) return false;
    for (const [k, v] of Object.entries(preset.options)) {
        if (v === undefined) continue;
        (target as any)[k] = copy(v, (target as any)[k]);
    }
    return true;
}
