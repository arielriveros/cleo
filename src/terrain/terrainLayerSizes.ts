// The landscape's layer-texture sizes: a render setting every renderer keeps, whether or not the game was built with
// the landscape feature (src/modules/landscape), so a leaf of its own.

/** The layer-texture sizes a project may choose, smallest first. */
export const TERRAIN_LAYER_TEXTURE_SIZES = [512, 1024, 2048] as const;
export const DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE = 1024;
