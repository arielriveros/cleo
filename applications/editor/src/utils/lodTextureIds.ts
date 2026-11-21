// The id scheme of a LOD level's downscaled texture twin, kept apart from lodTextures.ts (which drives
// the TextureManager) so worker-side code -- the project folder codec -- can recognise a twin without
// importing the engine.

/**
 * Derived id for a source texture at a target width.
 *
 * Deterministic on purpose, and it is what makes both requirements work: two levels that land on the
 * same size SHARE one image, and regenerating a model's LODs reuses the ids it minted last time instead
 * of leaking a new set each press. Not the `__packed__` prefix — those are treated as derived-and-
 * disposable and are excluded from persistence and publish, while these must survive a reload.
 */
export function lodTextureId(sourceId: string, width: number): string {
    // `lodc`: made with its alpha coverage preserved (preserveAlphaCoverage). The plain `lod` ids minted
    // before that are still recognised, but no longer reused, so a regenerate replaces them.
    return `${sourceId}__lodc${width}`
}

/**
 * True for a LOD level's downscaled twin. Those belong to the model whose generated levels draw them —
 * stored, shipped and preloaded like any texture, but never an asset of their own: the explorer hides
 * them and deleting the model deletes them.
 */
export function isLodTextureId(id: string | null | undefined): boolean {
    return !!id && /__lodc?\d+$/.test(id)
}
