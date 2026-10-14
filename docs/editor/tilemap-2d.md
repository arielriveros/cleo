# Tilemaps and 2D

A 2D game in Cleo is a scene authored as **2D**: you get the Tilemap editor instead of Landscape, a
unified Y-sorted 2D draw pass, and sprites instead of meshes.

Set the dimension in [Scene settings](scene-authoring.md#scene-settings).

## Tilesets

A **tileset** (`.tileset`) is a sliced atlas plus per-tile metadata. Create one with
**+ Add ▸ Tileset** and pick an atlas image.

Tileset mode gives you:

**Slicing** — tile size, margin and spacing, drawn as a grid over the atlas.

**Per-tile flags** — solid (collides), animated, tinted, depth-anchored.

**Animated tiles** — select a tile, turn on **Animated** and the editor goes straight into frame
picking: click tiles on the atlas in the order they play (drag a rectangle to add a row at once),
right-click a tile to remove its last use, **Done** to keep the frames, or **Cancel** (or Esc) to put the tile back exactly as it was before picking — including turning Animated off again if picking started from the toggle. The atlas numbers each tile with
its place in the sequence (a tile used twice shows both, e.g. `2,4`), and the frame chips under
**Selected tiles** reorder (‹ ›) or remove (×) a frame. The anchor tile is outlined while picking.

**Overdrive** — brightness past white, in linear light (**Atlas ▸ Overdrive**, default 1). A tint
can only darken a tile; overdrive makes it brighter than its texture, so fire, lava or magic crosses
the bloom threshold and glows. Every sprite and tilemap tile drawn from the tileset gets it. A tile
can set its own **Overdrive** under **Selected tiles**, for example a flare frame brighter than the rest
of the flame or an unlit tile in a glowing set; set it back to the tileset's value to follow the
tileset again. An animated sprite uses the overdrive of the frame on screen. An animated tilemap
tile keeps its base tile's value. Around 3–4 is a strong glow at the default bloom settings.

**Variant sets** — several tiles that mean the same thing, picked at random with weights. This is
what stops a large area of ground looking obviously repeated.

**Terrain sets (auto-tiling)** — Wang sets, where the engine picks the right tile from the
neighbours. Paint a shape and the edges and corners resolve themselves.

> Sprites reference a **tileset and a tile index**, not a raw texture. That is what lets one atlas
> back a whole set of sprites and animations.

## Tilemaps

Add one from **Sprites ▸ Tilemap** — orthogonal, 1×1 cells, one "Ground" layer.

The node inspector holds grid kind, cell width and height, sprite sort layer and collider depth.
Grids can be **orthogonal, isometric or hexagonal**.

Tilemaps are chunked and effectively infinite: you can paint outward as far as you like without
declaring a size up front.

## Painting

Switch to **Tilemap mode** (2D scenes only). A floating tool card gives you eight tools:

| Tool | Does |
|---|---|
| **Brush** | Paint the selected tile. |
| **Eraser** | Remove tiles. |
| **Rect** | Fill a rectangle. |
| **Bucket** | Flood fill. |
| **Stamp** | Paint a selected block of tiles as one unit. |
| **Pick** | Eyedropper — take the tile under the cursor. |
| **Random** | Paint from a variant set. |
| **Auto** | Paint with a terrain set; edges resolve automatically. |

**Orientation:** Flip X (**X**), Flip Y (**Y**), Rotate 90° (**Z**). These modify what the brush
lays down, so one tile covers four rotations.

**Panels:** the **Tiles** panel selects a tile or a block from the layer's tileset; the **Layers**
panel manages the layer stack.

> **Ctrl+Z undoes a whole stroke**, not one tile — a stroke is pushed as a single history entry.

## Layers

Each layer has its own tileset and its own place in the draw order. Use them to separate ground,
detail, props and anything the player walks behind.

One layer can be marked the **entity layer**, which is the one gameplay treats as containing
objects rather than scenery.

## Collision

Mark tiles **solid** in the tileset, and the tilemap builds colliders for them — merged into as few
boxes as possible, so a hand-painted floor becomes a handful of colliders rather than hundreds.
**Collider depth** on the node controls how thick they are in the third axis.

Nothing else is needed; there is no per-tile collider to place.

## Sprites

**Static sprite** — a tileset plus one tile index, with tint, opacity and blending.

**Animated sprite** — an ordered list of tiles with fps and loop. The frame list comes either from
the node itself or from the tile's own animation metadata in the tileset, which is the better choice
when the same animation is used in several places. **Playback** shows the **Frames per second** either way: for its
own frame list it is the sprite's rate (with the loop length under it); for a tile's animation it shows
the tile's rate from the tileset, and typing another value speeds up or slows down this sprite only (↺
follows the tile again).

Both support **billboarding** (`free`, `spherical`, `cylindrical`), which matters in 3D scenes where
sprites are used for effects.

## Picking in the viewport

A tilemap uses an analytic picker and **only registers a hit where a tile is actually painted**, so
clicking a gap selects what is behind it rather than the map.

## 2D cameras and zoom

2D scenes use an orthographic camera. The wheel zooms, and the viewport's 2D/3D switch changes the
view without changing the scene's authored dimension.

## Switching dimension

Changing a scene between 2D and 3D warns when it would strand authoring work — a landscape in a
scene about to become 2D, or a tilemap in one about to become 3D.

The warning is about real loss: a published build **discards** the authoring data for the dimension
it is not using.

## Runtime

Tilemaps can be read and written at runtime — `getTile`, `setTile`, `fillRect`, `bucketFill`,
`applyAutoTile`, batched edits, and collision queries. See
[Terrain and tilemaps (scripting)](../scripting/terrain-tilemap.md#tilemaps).

## See also

[Scene authoring](scene-authoring.md) · [Assets](assets.md) · [Terrain and tilemaps (scripting)](../scripting/terrain-tilemap.md)
