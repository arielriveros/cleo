// Collision layers. A Collider or Trigger is ON one layer (its `layer`, a single bit) and COLLIDES WITH a set of
// layers (its `mask`); two bodies collide when each one's mask holds the other's layer. Queries take a mask too:
// a camera rig's Blocked by and See through, a foot IK rig's trace layers, a raycast's `layerMask`.
//
// Sixteen of them: Jolt and Rapier pack a body's layer and mask into 16 bits each, and Jolt is the default
// backend. The project names them (Project Settings > Collision Layers); the first four are the engine's own.
//
// A leaf module, so the unit suite, the editor and the example tools can all load it.

/** How many collision layers a project has. */
export const LAYER_COUNT = 16;

/** Every bit set: collides with, or a query keeps, every layer. */
export const ALL_LAYERS = -1;

/** The bits a layer can be: the low {@link LAYER_COUNT}. */
export const LAYER_BITS = (1 << LAYER_COUNT) - 1;

/** The engine's own layers, as bits. Their names are fixed; every other layer is the project's to name. */
export const LAYER = {
    /** Layer 1: everything that does not say otherwise, and every body the engine makes itself (terrain, ground, tilemaps). */
    DEFAULT: 1,
    /** Layer 2: ragdoll bones. */
    RAGDOLL: 2,
    /** Layer 3: what a camera rig sees through by default (the boom passes, the dither hole cuts its meshes). */
    SEE_THROUGH: 4,
    /** Layer 4: what a camera rig ignores by default (small props, debris). */
    NO_CAMERA: 8,
} as const;

/** How many of the first layers are the engine's ({@link LAYER}), their names fixed. */
export const BUILT_IN_LAYERS = 4;

/** The names a project starts with: the engine's four, then sixteen-less-four unnamed ("Layer 5" ...). */
export const DEFAULT_LAYER_NAMES: readonly string[] = Object.freeze([
    'Default', 'Ragdoll', 'See Through', 'No Camera',
    ...Array.from({ length: LAYER_COUNT - BUILT_IN_LAYERS }, () => ''),
]);

/** Longest name a layer may have. */
export const LAYER_NAME_MAX = 32;

/** A camera rig's Blocked by when nothing says otherwise: every layer but See Through and No Camera. */
export const DEFAULT_CAMERA_BLOCKED_BY = ALL_LAYERS & ~(LAYER.SEE_THROUGH | LAYER.NO_CAMERA);
/** A camera rig's See through when nothing says otherwise: the See Through layer. */
export const DEFAULT_CAMERA_SEE_THROUGH = LAYER.SEE_THROUGH;

/** The bit of the layer at `index` (0-based: layer 1 is index 0). */
export function layerBit(index: number): number {
    return index >= 0 && index < LAYER_COUNT ? 1 << index : 0;
}

/** The 0-based index of the one layer `value` holds, or null when it holds none or several (shown "Mixed"). */
export function singleLayerOf(value: number): number | null {
    const bits = value & LAYER_BITS;
    if (bits === 0 || (bits & (bits - 1)) !== 0) return null;
    return 31 - Math.clz32(bits);
}

/** Whether `mask` keeps every layer. */
export function isAllLayers(mask: number): boolean {
    return (mask & LAYER_BITS) === LAYER_BITS;
}

/** A mask as stored: every layer on is -1, else just the layer bits. */
export function storedMask(mask: number): number {
    return isAllLayers(mask) ? ALL_LAYERS : mask & LAYER_BITS;
}

/** The name shown for the layer at `index`: the project's, or "Layer N" for an unnamed one. */
export function layerLabel(names: readonly string[] | null | undefined, index: number): string {
    const name = index < BUILT_IN_LAYERS ? DEFAULT_LAYER_NAMES[index] : names?.[index]?.trim();
    return name || `Layer ${index + 1}`;
}

/**
 * A stored name table read tolerantly: always {@link LAYER_COUNT} strings, the engine's four fixed, the rest
 * trimmed to {@link LAYER_NAME_MAX} characters (anything else becomes unnamed).
 */
export function normalizeLayerNames(raw: unknown): string[] {
    const list = Array.isArray(raw) ? raw : [];
    return Array.from({ length: LAYER_COUNT }, (_, i) => {
        if (i < BUILT_IN_LAYERS) return DEFAULT_LAYER_NAMES[i];
        const v = list[i];
        return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, LAYER_NAME_MAX) : '';
    });
}

/** The bit of the layer called `name` (case-insensitive; "Layer 7" names layer 7 whatever it is called), or 0. */
export function layerByName(names: readonly string[] | null | undefined, name: string): number {
    const want = name.trim().toLowerCase();
    if (!want) return 0;
    for (let i = 0; i < LAYER_COUNT; i++) if (layerLabel(names, i).toLowerCase() === want) return layerBit(i);
    const numbered = /^layer\s+(\d+)$/.exec(want);
    return numbered ? layerBit(Number(numbered[1]) - 1) : 0;
}

/** The labels of the layers `mask` holds, in order. */
export function layerLabelsOf(names: readonly string[] | null | undefined, mask: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < LAYER_COUNT; i++) if (mask & (1 << i)) out.push(layerLabel(names, i));
    return out;
}

/** Whether two bodies collide by their layers: each one's mask holds the other's layer. */
export function layersCollide(groupA: number, maskA: number, groupB: number, maskB: number): boolean {
    return (groupA & maskB) !== 0 && (groupB & maskA) !== 0;
}
