# Tilemaps and 2D

A 2D game in Cleo is a scene authored as **2D**: you get the Tilemap editor instead of Landscape, a
unified Y-sorted 2D draw pass, and sprites instead of meshes.

Set the dimension in [Scene settings](scene-authoring.md#scene-settings).

## Tilesets

A **tileset** (`.tileset`) is a sliced atlas plus per-tile metadata. Create one with
**+ Add ▸ Tileset** and pick an atlas image.

Tileset mode gives you:

**Atlas** — the image and how it is sliced: **Tile size**, **Margin** (a border around the whole
atlas) and **Spacing** (the gap between tiles), drawn as a grid over the atlas. Import an image, drop
one — or a texture from the Assets explorer — on the atlas box, or link a texture already imported.
The tileset's **Overdrive** is here too.

**Selected tiles** — what the tiles selected on the atlas mean: **Solid** (a collider, on any layer
with parallax 1), **Anchor row** and **Z bias** (where it depth-sorts — a two-tall tree anchors at its
trunk), **Span** (its footprint in cells, for a prop larger than one tile), **Tint**, **Opacity**, its
own **Overdrive**, and **Animated**. With several tiles selected the fields show the first one's
values, and every change applies to all of them.

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

**Variants** — variant sets: several tiles that mean the same thing, which the **Random** brush picks
from at random, by weight. This is what stops a large area of ground looking obviously repeated.
**+ Variant set** adds one; select tiles on the atlas and add them to it, each with its weight.

**Auto-tiling** — terrain sets (Wang sets), where the engine picks the right tile from the
neighbours: paint a shape with the **Auto** brush and the edges and corners resolve themselves. A set
is **Edge**, **Corner** or **Blob**; select its tiles in the Wang sheet's order and **Assign** them,
which records the neighbour mask each one fills.

> Sprites reference a **tileset and a tile index**, not a raw texture. That is what lets one atlas
> back a whole set of sprites and animations.

## Tilemaps

Add one from **Sprites ▸ Tilemap** — orthogonal, 1×1 cells, one "Ground" layer.

**Tilemap** — the node's inspector section: the grid kind — **orthogonal, isometric or hexagonal**,
with an orientation, offset and side length for hexagons — the cell width and height, the
[entity layer](#layers) sprites sort against, and the [collision depth](#collision). Painting and the
layer stack are in [Tilemap mode](#painting).

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
detail, props and anything the player walks behind. Painting always targets the active layer, the
one selected in the **Layers** panel; **+ Layer** adds one above.

One layer can be marked the **entity layer**, which is the one gameplay treats as containing
objects rather than scenery.

## Collision

Mark tiles **solid** in the tileset, and the tilemap builds colliders for them — merged into as few
boxes as possible, so a hand-painted floor becomes a handful of colliders rather than hundreds.
**Collision depth** on the node controls how thick they are in the third axis.

Nothing else is needed; there is no per-tile collider to place.

## Sprites

A sprite's inspector has three sections: the **Tileset** it draws from, its own section (**Sprite**
or **Animated Sprite**), and **Appearance**.

**Tileset** — which tileset the sprite draws from, with ✎ to edit it. **+ Tileset from image…**
imports an image and slices it into a new tileset; **Use existing…** picks one, or drag a tileset from
the Assets panel onto the slot. Unlinked, the sprite draws nothing.

**Sprite** — a static sprite: a tileset plus one tile index, picked on the tile grid.

**Animated Sprite** — an ordered list of tiles with fps and loop. **Frames from** chooses where the
list comes from: the node itself, or the tile's own animation metadata in the tileset, which is the
better choice when the same animation is used in several places.

- **Frames** — the sprite's own list: drag a rectangle over the atlas to set the frames in reading
  order, or type the order (`0,1,2,3,2,1`) for anything a rectangle cannot say.
- **Tile** — the tile whose animation this sprite plays. **Edit in tileset…** opens the tileset to
  give a tile one; a tile without one holds still.
- **Playback** — the **Frames per second** either way. For its own frame list it is the sprite's
  rate, with **Loop** and the loop length under it; for a tile's animation it shows the tile's rate
  from the tileset, and typing another value speeds up or slows down this sprite only (↺ follows the
  tile again).
- **Random start** — each copy starts on a random frame of its own list, so a row of the same sprite
  (torches along a wall) does not flicker in step. It applies when the sprite spawns.

**Appearance** — tint, opacity, blending, exposure weight, soft fade, transparency, which sides draw, and wireframe. A tileset with
**overdrive** makes its sprites glow through bloom; the value belongs to the tileset, and the section
only reports it.

- **Blending** — **Alpha** draws the sprite over what is behind it. **Additive** adds it as light, for
  fire and glows: black parts vanish and overlapping sprites brighten each other.
- **Exposure weight** — how much the camera's exposure brightens the sprite. A sprite is unlit, so at 1
  (the default) it is multiplied by the exposure like everything lit, and a flame that reads right in
  daylight turns to a white smear at night or in a dark interior, where the exposure is hundreds of times
  higher. At 0 it keeps the same brightness under any exposure; fire usually wants a little (0.1), so it
  still glows brighter in the dark.
- **Soft fade** — in metres, how far into the scene's geometry the sprite stays visible. At 0 a sprite is
  cut off wherever it goes inside a surface, so a flame set into its torch loses its base inside the torch
  head. Above 0 every part of the sprite within that distance behind a surface still shows, while a sprite
  behind a wall further away is hidden as usual. A torch flame wants about the depth of the torch head
  (0.2–0.3 m); much more lets the sprite show through things standing in front of it.

Both support **billboarding** (**Constraints**: `free`, `spherical`, `cylindrical`), which matters in
3D scenes where sprites are used for effects.

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
