// What the 2D world feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { TilemapNode } from "../../core/scene/nodes/tilemapNode";
export { Camera2DNode } from "../../core/scene/nodes/camera2DNode";
export { Room2DNode } from "../../core/scene/nodes/room2DNode";
export { ParallaxLayerNode } from "../../core/scene/nodes/parallaxLayerNode";
export { Tilemap, DEFAULT_FILL_LIMIT } from "../../graphics/tilemap/tilemap";
export type { EntitySort } from "../../graphics/tilemap/tilemap";
export type { TileEdit, TileOrientation } from "../../graphics/tilemap/tilemap";
export { TilemapLayer, defaultLayerConfig } from "../../graphics/tilemap/tilemapLayer";
export type { TilemapLayerConfig, LayerBounds } from "../../graphics/tilemap/tilemapLayer";
export {
    cellToWorld, worldToCell, cellCorners, cellSortY, neighbours, neighbourCount, normalizeGrid,
} from "../../graphics/tilemap/cellMath";
export type { GridSpec, GridKind, HexOrientation, HexOffset } from "../../graphics/tilemap/cellMath";
export {
    CHUNK_SIZE, CELL_EMPTY, packCell, cellTile, cellFlags, cellFlipX, cellFlipY, cellRot90, withTile, chunkKey, chunkCoord,
} from "../../graphics/tilemap/chunk";
export type { TileChunk } from "../../graphics/tilemap/chunk";
export { autoTileMask, resolveAutoTile, pickWeightedVariant } from "../../graphics/tilemap/autotile";
export { greedyMerge } from "../../graphics/tilemap/tilemapCollision";
export type { SolidBox } from "../../graphics/tilemap/tilemapCollision";
