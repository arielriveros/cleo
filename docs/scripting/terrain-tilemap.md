# Terrain and tilemaps

Querying and editing landscapes and tilemaps at runtime — destructible ground, procedural levels,
placing things on the surface.

Authoring is in [Terrain](../editor/terrain.md) and [Tilemaps and 2D](../editor/tilemap-2d.md).

---

## Terrain

```ts
const terrain = (this.findNode('Landscape') as LandscapeNode).terrain
```

### Reading

```ts
heightAt(localX: number, localZ: number): number
raycast(origin: vec3, dir: vec3, maxDistance = 10000): vec3 | null
sampleSplat(x: number, z: number, out: number[]): number[]
layerCoverage(index: number): number

get config / chunks / heights / resolution / size / elementSize / origin
get splatResolution / layers / splatId / foliage
get/set material
```

`heightAt` is the cheap way to sit something on the ground when you already know the column.
`sampleSplat` tells you which paint layers are present at a point — useful for surface-dependent
footstep sounds.

> For finding ground **under physics**, prefer a downward raycast through
> `scene.physics.raycast` — a terrain hit has `hit.node === null`, because the landscape registers
> its heightfield directly with the physics world with no owning node. See
> [Raycasting](motion-and-physics.md#raycasting).

### Sculpting and painting

```ts
sculpt(worldPoint: vec3, brush: SculptBrush, dt: number): void
paint(worldPoint: vec3, brush: PaintBrush, dt: number): void

type SculptMode = 'raise' | 'lower' | 'smooth' | 'flatten'
interface PaintBrush { radius: number; strength: number; falloff: number; layer: number }
```

```ts
terrain.sculpt(hit.point, { mode: 'lower', radius: 3, strength: 4, falloff: 0.5 }, delta)
```

There are four splat layers (0–3).

### Layers

```ts
setLayer(index: number, source?, opts?): void
clearLayer(index: number): void
syncPackedLayers(frame: number): void
```

### Foliage

```ts
addFoliage(layer: FoliageLayer): void
removeFoliageLayer(key: string): void
scatterFoliage(index: number, worldPoint: vec3, radius: number): void
eraseFoliage(...)
scatterFoliageFromMaterials(...)
eraseAllFoliage() ; eraseFoliageExcept(...)
refreshFoliagePrototypes(opts?): void
generateFoliageEverywhere(): FoliageGenerateResult
regenerateFoliageForRule(rule): void
pruneFoliage(): void
```

```ts
FoliageLayer.Billboard(name: string, textureId: string, params?)
FoliageLayer.Mesh(name: string, model, params?)
FoliageLayer.fromRule(rule)
```

Budgets: `MAX_INSTANCES = 200000`, `FOLIAGE_DRAW_TRIANGLE_BUDGET = 4_000_000`.

### Colliders and LOD

```ts
ensureRegistered(world, material?): void
updateFoliageColliders(world, camPos: vec3, material?): void
get foliageColliderCount: number
node.updateLod(camPos: vec3, settings: TerrainLodSettings): void
```

Foliage colliders are pooled and created near the camera rather than for every instance — 200,000
of them would be neither useful nor affordable.

### Heightmaps

```ts
importHeightmap(path: string, amplitude: number): void
exportHeightmap()
resampleHeightsFrom(other) ; resampleSplatFrom(other) ; resampleFoliageFrom(other)
```

### Housekeeping

```ts
setOrigin(worldPos: vec3): void
dispose(world?): void
serialize() ; Terrain.deserialize(json, material?)
```

> `TERRAIN_RELIEF_ENABLED` is `false`: per-layer terrain relief is off, and the editor hides its
> controls behind the same flag. It is a flag rather than a deletion so the code can come back.

---

## Tilemaps

```ts
const tilemap = (this.findNode('Ground') as TilemapNode).tilemap
```

### Coordinates

```ts
cellToWorld(col: number, row: number): [number, number]
worldToCell(x: number, y: number): [number, number]
get/setGrid(grid: GridSpec): void
setOrigin(p: vec3): void
```

Grids can be orthogonal, isometric or hex, and the maths helpers (`cellCorners`, `cellSortY`,
`neighbours`, `neighbourCount`, `normalizeGrid`) handle all three.

### Reading and writing tiles

```ts
getTile(layer: number, col: number, row: number): number
getPacked(layer, col, row): number
setTile(layer: number, col: number, row: number, tileIndex: number, orient?: TileOrientation): void
eraseTile(layer, col, row): void
setPacked(layer, col, row, packed): void
setTint(layer, col, row, rgba): void
```

```ts
fillRect(layer, col0, row0, col1, row1, tileIndex, orient?): void
bucketFill(layer, col, row, tileIndex, limit = DEFAULT_FILL_LIMIT): void   // limit 100000
applyAutoTile(layer: number, col: number, row: number, terrainId: string): void
applyVariant(...): void
```

`applyAutoTile` picks the right tile from a Wang/terrain set by looking at the neighbours, which is
how a procedurally generated map gets correct edges for free.

### Batching edits

```ts
beginEdit() ; endEdit()
recordEdits(fn: () => void): TileEdit[]
applyEdits(edits: TileEdit[], undo: boolean): void
```

Wrap a bulk change so the map rebuilds once rather than per tile. `recordEdits` also gives you the
inverse, which is what makes undo possible.

### Collision

```ts
isSolid(col: number, row: number): boolean
solidAtWorld(x: number, y: number): boolean
ensureRegistered(world, material?): void
get colliderCount: number
collisionDepth: number = 0.5
entityLayer: number
```

Solid tiles are merged into as few boxes as possible (`greedyMerge`) before being handed to physics
— a hand-painted floor becomes a handful of colliders rather than hundreds.

### Layers and tilesets

```ts
addLayer(cfg?): TilemapLayer
removeLayer(i: number) ; moveLayer(from: number, to: number)
get layers / tilesets / version / time / editing / origin
registerTileset(ts: Tileset) ; tilesetById(id) ; tilesetOf(layerIndex)
```

### Bounds and chunks

```ts
chunkKeys(): string[]
bounds(): LayerBounds
```

Tilemaps are chunked and effectively infinite: `CHUNK_SIZE` cells per chunk, `CELL_EMPTY` for an
empty cell, and a packed cell carries tile index plus flip/rotate flags (`packCell`, `cellTile`,
`cellFlags`, `cellFlipX`, `cellFlipY`, `cellRot90`, `withTile`).

---

## Sprites

```ts
const sprite = this.findNode('Coin') as SpriteNode
sprite.tileIndex = 3
sprite.tint = [1, 0.9, 0.2]
sprite.opacity = 0.8
sprite.constraints = 'spherical'      // billboard toward the camera
```

Animated sprites:

```ts
const anim = this.findNode('Flame') as AnimatedSpriteNode
anim.frames = [0, 1, 2, 3]
anim.fps = 12
anim.loop = true
anim.reset()
```

`frameSource` chooses whether the frame list comes from the node (`'node'`) or from the tile's own
animation metadata in the tileset (`'tile'`).

Sprites reference a **tileset** and a tile index rather than a raw texture, which is what lets one
atlas back a whole set of sprites.

## See also

[Terrain (editor)](../editor/terrain.md) · [Tilemaps and 2D (editor)](../editor/tilemap-2d.md) · [Motion and physics](motion-and-physics.md)
