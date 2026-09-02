// The post-process chain as DATA: which effects run, and in what order.
//
// Pure — no renderer, no device, no scene. `Renderer` turns the resolved chain into graph passes and
// the editor turns it into rows; both work from the same list, which is the point.
//
// What is reorderable and what is not is a physical question, not a UI one:
//
//   compose   the scene enters the chain. Motion blur IS this step when it runs (it reconstructs the
//             image out of `_sceneFBO` and the velocity buffer while copying), and a plain blit when
//             it does not. Either way nothing can precede it, because before it there is no chain.
//   exposure  meters `_sceneFBO` BEFORE anything adds light to the chain. Metering after god rays or
//             bloom makes exposure and bloom chase each other: bloom brightens the frame, the meter
//             darkens the exposure, which moves bloom's threshold, and round again.
//   <middle>  god rays, bloom, chromatic aberration and the camera's screen materials. This is the
//             part the user orders.
//   present   the single display resolve — exposure, tone curve, LUT, sRGB. Must be last by
//             definition; the outline composite and the editor's debug blits are variants of it.
//
// So the chain this module describes is the MIDDLE. The anchors are not entries and cannot be moved.

/** The built-in effects a user may reorder. Anchors are deliberately absent — see the note above. */
export type BuiltinEffectId =
    | 'depthOfField' | 'godRays' | 'bloom' | 'lensFlare' | 'chromatic' | 'vignette' | 'filmGrain';

/**
 * A screen-space custom material, by INDEX into `CameraNode.screenMaterials`.
 *
 * By index rather than by identity because a `CustomMaterial` has no stable id to key on: it
 * serializes inline with the camera, and its `type` is a content hash that changes on every edit of
 * the shader source (`CustomMaterial.refreshType`). An index survives an edit; it does not survive a
 * removal, which is what {@link resolvePostChain} repairs.
 */
export type MaterialEffectId = `material:${number}`;

export type PostEffectId = BuiltinEffectId | MaterialEffectId;

export interface PostChainEntry {
    readonly effect: PostEffectId;
    /**
     * Off means "in the chain, in this position, not running" — not "removed". A built-in is always
     * present so there is always somewhere to switch it back on from; only materials come and go, and
     * they come and go with the camera's material list rather than with this flag.
     */
    readonly enabled: boolean;
}

/**
 * What a camera that has authored no chain of its own runs, and the engine's considered answer to what
 * order these effects belong in. Load-bearing: every scene that has never been reordered renders THIS.
 *
 * The reasoning is per effect, not by analogy:
 *
 *   depthOfField  first, because it is the lens focusing on the SCENE. Everything after it is glare
 *                 produced inside the lens, which the focal plane does not act on. It is also what
 *                 makes bloom worth having here — a defocused highlight blooms as a bokeh disc.
 *   godRays       shafts must bloom, so before bloom; after DoF because defocusing them by the CoC of
 *                 whatever geometry sits behind would smear them against the sky.
 *   bloom         after both, so shafts and bokeh both bloom.
 *   lensFlare     ghosts and halo come from the same highlights bloom found, and share the dirt overlay.
 *   chromatic     lens dispersion, on the whole formed image including its glare.
 *   vignette      lens falloff, multiplicative on linear radiance — which is what it physically is.
 *   filmGrain     the sensor's own response: the last thing that happens before the image is read out.
 *
 * `godRays -> bloom -> chromatic` keep the relative order they had before the other four existed, and
 * all four ship switched off, so adding them changed no existing project's image. Reordering these, or
 * shipping one of them on, would.
 */
export const DEFAULT_POST_CHAIN: readonly BuiltinEffectId[] = [
    'depthOfField', 'godRays', 'bloom', 'lensFlare', 'chromatic', 'vignette', 'filmGrain',
];

export function isBuiltinEffect(id: string): id is BuiltinEffectId {
    return (DEFAULT_POST_CHAIN as readonly string[]).includes(id);
}

/** The material index an id names, or null when it does not name one. */
export function materialIndexOf(id: string): number | null {
    if (!id.startsWith('material:')) return null;
    const index = Number(id.slice('material:'.length));
    return Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * The chain a camera actually runs.
 *
 * `authored` is what the camera serialized, or null for "use the default" — which is what every scene
 * saved before per-camera chains existed carries, and why nothing has to be migrated on load. The
 * legacy order it reproduces is: the built-ins, then the screen materials, which is exactly where
 * `_screenMaterialsPass` sat.
 *
 * Repairs rather than rejects, because the input is a saved file and a user's material list that have
 * drifted apart: unknown ids are dropped (a chain written by a NEWER build), duplicates keep their
 * first position, a built-in nobody mentioned is appended in canonical order, and a material the
 * camera has but the chain does not is appended too — so adding a material in the inspector makes it
 * appear at the end, as it always has.
 */
export function resolvePostChain(
    authored: readonly PostChainEntry[] | null | undefined,
    screenMaterialCount: number,
): PostChainEntry[] {
    const resolved: PostChainEntry[] = [];
    const seen = new Set<string>();

    for (const entry of authored ?? []) {
        const id = entry?.effect;
        if (typeof id !== 'string' || seen.has(id)) continue;
        const materialIndex = materialIndexOf(id);
        // A material index past the end of the camera's list is a material that has been deleted.
        if (materialIndex !== null && materialIndex >= screenMaterialCount) continue;
        if (materialIndex === null && !isBuiltinEffect(id)) continue;
        seen.add(id);
        resolved.push({ effect: id as PostEffectId, enabled: entry.enabled !== false });
    }

    for (const id of DEFAULT_POST_CHAIN)
        if (!seen.has(id)) resolved.push({ effect: id, enabled: true });

    for (let index = 0; index < screenMaterialCount; index++) {
        const id: MaterialEffectId = `material:${index}`;
        if (!seen.has(id)) resolved.push({ effect: id, enabled: true });
    }

    return resolved;
}

/**
 * Is this chain equivalent to the default for a camera with this many screen materials? The editor
 * uses it to decide whether to store an override at all — a camera whose chain matches the default
 * should serialize nothing, so an untouched scene's blob does not change.
 */
export function isDefaultChain(
    chain: readonly PostChainEntry[] | null | undefined,
    screenMaterialCount: number,
): boolean {
    if (!chain) return true;
    const resolved = resolvePostChain(chain, screenMaterialCount);
    const fallback = resolvePostChain(null, screenMaterialCount);
    if (resolved.length !== fallback.length) return false;
    return resolved.every((entry, index) =>
        entry.effect === fallback[index].effect && entry.enabled === fallback[index].enabled);
}
