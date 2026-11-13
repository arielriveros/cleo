# Tilemaps and 2D

A 2D game in Cleo is a scene authored as **2D**: you get the Tilemap editor instead of Landscape, a
unified Y-sorted 2D draw pass, and sprites instead of meshes.

Set the dimension in [Scene settings](scene-authoring.md#scene-settings).

## Tilesets

A **tileset** (`.tileset`) is a sliced atlas plus per-tile metadata. Create one with
**+ Add ▸ Tileset** and pick an atlas image.

Tileset mode shows the atlas with its slicing grid in the main area, and the tileset's settings in the
Properties panel, card by card. Every edit is undoable (**Ctrl+Z**), and dragging a value is one step.
**Save** (or **Ctrl+S**) writes the tileset and updates every tilemap and sprite using it. Unsaved edits
survive switching to another tab and back.

Numbers scrub: drag a field's label (**W**, **px**, **rows**…) sideways to change it, click the box to
type, double-click the label to reset it. Sliders take a typed value past their end: click the readout.

### Atlas

The image and how it is sliced into tiles. The grid is drawn over the atlas as you change it, and
whatever the slicing leaves over (the margin, and any strip at the right or bottom that no whole tile
fits in) is dimmed, so a wrong tile size shows at once.

| Field | What it does |
|---|---|
| **Image** | The atlas texture, in the same slot as a material's: hover it for **Select** (search the project's textures), upload, or drop an image file or a texture from the Assets explorer on it. A new image keeps the slicing you set; only a tileset with no atlas yet guesses its tile size. Beside it: how many tiles the grid makes, and a warning when the slicing does not divide the image. |
| **Tile size** | Width and height of one tile, in pixels. The link button keeps them equal (square tiles). The chips set a common size in one click, and **Guess** takes the largest of 64, 32, 16 and 8 that divides the image into at least 4 × 4 tiles, or 16 when none does. |
| **Margin** | A border around the whole atlas, in pixels, before the first tile. |
| **Spacing** | The gap between adjacent tiles, in pixels. |
| **Pixels per unit** | Art pixels in a world unit. Sprites drawn from the tileset take their size from it: a tile's pixel size over this, times the node's scale, so a 16 px tile at 16 is one unit and a 135 px character frame 8.4, and everything drawn from tilesets at the same value shares one pixel grid. **= tile** sets it to the tile width (one tile, one unit: the tilemap's default 1 × 1 cells). Off (0): the old rule, a sprite is a unit square sized by its scale. |
| **Overdrive** | Brightness past white, in linear light (default 1). A tint can only darken a tile; overdrive makes it brighter than its texture, so fire, lava or magic crosses the bloom threshold and glows. Every sprite and tilemap tile drawn from the tileset gets it, unless a tile has its own. Around 3–4 is a strong glow at the default bloom settings; the slider runs to 8, and a typed value can go to 32. |

### Selected tiles

What the tiles selected on the atlas mean. The card shows the first selected tile as it will draw —
animated, tinted, faded and brightened — with its position. With several tiles selected the fields show
the first one's values, a **mixed** tag marks a field the others disagree on, and every change applies to
all of them as one undo step. **Copy** and **Paste** carry a tile's collision, sorting and look to other
tiles (not its animation or auto-tile membership); **Clear** removes everything a tile carries.

| Field | What it does |
|---|---|
| **Collision** | What a body meets on this tile, on any tilemap layer with parallax 1: **None**; **Solid**; **One-way platform** (stood on from above, passed from below and the sides, dropped through with down + jump); a **slope** (45°, or either half of a 26° slope, rising or falling), solid below its line; or a **half block**. [2D character bodies](#2d-physics) read every kind; 3D bodies the solid ones (a slope is given the matching collider outline). A slope flipped on X mirrors. |
| **Anchor row** | Rows down from this tile that it depth-sorts at: a two-tall tree anchors at its trunk. |
| **Z bias** | A world-space nudge to the tile's depth sort, for when anchoring alone gets it wrong. |
| **Span** | The tile's footprint in cells, for a prop larger than one tile. |
| **Tint** | Multiplied into the tile's colour wherever it is placed. The reset button goes back to white. |
| **Opacity** | How opaque the tile draws. |
| **Overdrive** | This tile's own overdrive, for example a flare frame brighter than the rest of the flame, or an unlit tile in a glowing set. A tile that has none follows the tileset's, and the slider says **tileset**; moving it gives the tile its own value, and the reset button makes it follow the tileset again. An animated sprite uses the overdrive of the frame on screen; an animated tilemap tile keeps its base tile's. |
| **Animated** | The tile plays an animation. Turning it on narrows the selection to one tile and goes straight into frame picking (below). |
| **FPS** | How fast the animation plays, in frames per second. The slider runs to 30; a typed value can go to 120. |

**Animated tiles** — select a tile, turn on **Animated** and the editor goes straight into frame
picking: click tiles on the atlas in the order they play (drag a rectangle to add a row at once),
right-click a tile to remove its last use, **Done** to keep the frames, or **Cancel** (or Esc) to put the
tile back exactly as it was before picking — including turning Animated off again if picking started from
the toggle. The atlas numbers each tile with its place in the sequence (a tile used twice shows both,
e.g. `2,4`), and the frame chips under **Selected tiles** show each frame's tile, reorder it (‹ ›) or
remove it (×). The anchor tile is outlined while picking.

### Lighting maps

The atlases a **lit** sprite (**Appearance ▸ Lit**) shades with instead of drawing the atlas as it is,
cut into the same cells. Every sprite drawn from the tileset uses them. Each is a texture slot like the
atlas's, and the card's badge says how lit sprites from the tileset shade: **Six-way**, **Surface** or
**Flat**.

- **Six-way +** and **Six-way −** — six-way lightmaps, for smoke, steam, dust: anything soft and
  see-through. The FX Creator bakes them (**Bake ▸ Six-way lightmaps**, the Six-way + and Six-way −
  outputs): the effect rendered six more times, lit from its right, top and back, and from its left,
  bottom and front. A lit sprite blends them by each light's direction, so the side facing the sun is
  bright, the far side dark, a back-lit edge glows and a fire below lights the underside: the effect is
  relit by the scene's own lights, its self-shadowing baked in. This is the six-way lighting of Unity's
  VFX Graph, and the maps are the same.
- **Normal** and **ORM** — a surface, for liquids and anything solid: a tangent-space normal map (OpenGL
  convention: R right, G up, B toward the viewer) and an optional ORM map (R occlusion, G roughness,
  B metallic). The atlas is then the base colour. The FX Creator bakes all three for a liquid (**Bake ▸
  Surface maps**: the albedo, normal and ORM outputs; the albedo goes in the atlas slot).

Six-way wins when both six-way maps are set. With no maps a lit sprite is shaded flat.

### Variants

Variant sets: several tiles that mean the same thing, which the **Random** brush picks from at random,
by weight. This is what stops a large area of ground looking obviously repeated. **+ Variant set** adds
one; select tiles on the atlas and **Add** them to it. Each tile in a set shows its weight and the share
of picks that weight gives it, and × takes it out of the set. **Select on atlas** selects the set's tiles.

### Auto-tiling

Terrain sets (Wang sets), where the engine picks the right tile from the neighbours: paint a shape with
the **Auto** brush and the edges and corners resolve themselves. A set is **Edge**, **Corner** or
**Blob**; select its tiles in the Wang sheet's order and **Assign** them, which records the neighbour
mask each one fills. The set's tiles are shown in mask order, and **Select on atlas** selects them in
that order, so assigning them again gives the same rules.

### Working on the atlas

The atlas takes the keyboard when you click it, so these keys act on the tiles and never reach the scene.
The status bar names the tile under the pointer and what it carries, and explains the corner marks:
red for solid, yellow for animated, green for any other metadata.

| Control | Does |
|---|---|
| **Click / drag** | Selects a tile, or a rectangle of tiles. |
| **Shift + drag** | Adds the rectangle to the selection. |
| **Ctrl + click** | Toggles tiles in or out of the selection. |
| **Arrow keys** | Move the selection one tile; with **Shift**, extend it. |
| **Ctrl+A** | Selects every tile. |
| **Esc** | Clears the selection (or cancels frame picking). |
| **Delete** | Clears the selected tiles' metadata. |
| **Ctrl+C / Ctrl+V** | Copies the first selected tile's metadata, and pastes it onto the selection. |
| **Ctrl + wheel** | Zooms about the pointer. |
| **Middle-drag** | Pans. |
| **Fit / 1:1** | Fit the whole atlas in view, or show it at one atlas pixel per screen pixel. A tileset opens fitted. |

> Sprites reference a **tileset and a tile index**, not a raw texture. That is what lets one atlas
> back a whole set of sprites and animations.

## Tilemaps

Add one from **Sprites ▸ Tilemap** — orthogonal, 1×1 cells, one "Ground" layer.

**Tilemap** — the node's inspector section: the grid kind — **orthogonal, isometric or hexagonal**,
with an orientation, offset and side length for hexagons — the cell width and height, the
[entity layer](#layers) sprites sort against, the **sprite order** on it, and the
[collision depth](#collision). Painting and the layer stack are in [Tilemap mode](#painting).

- **Sprite order** — **By Y** (the default) suits a top-down map: a sprite sorts by the height of its base,
  so a character lower on screen draws in front, and against a Y-sorted layer's tile rows. **Side view**
  suits a platformer: sprites draw over the entity layer's tiles, by [sorting order](#sprites) and then
  scene order, never by height, so a character jumping past another never slips behind it.

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

One layer is the map's **entity layer**: the draw band sprites and particle systems join. Layers below it
draw behind them and layers above it in front, and on it they order by the map's
[sprite order](#tilemaps).

## Collision

Give tiles a **collision** in the tileset — solid, a one-way platform, a slope — and the tilemap collides:
nothing is placed per tile.

- **2D character bodies** ([2D physics](#2d-physics)) read the painted tiles directly, every kind of
  collision, the moment a tile is painted or erased.
- **3D bodies** on the XY plane collide with colliders the map builds from its solid tiles, merged into as
  few boxes as possible, so a hand-painted floor becomes a handful of colliders rather than hundreds.
  **Collision depth** on the node controls how thick they are in the third axis. A map only 2D bodies
  walk on turns **3D colliders** off and builds none.

## 2D physics

2D games move their characters with the 2D physics, which reads tilemaps' tiles (solid, one-way, slopes)
and 2D colliders, every frame the game plays.

### Character Body 2D

A **Character Body 2D** (**Sprites ▸ Character Body 2D**) is a character's body, a box standing on its feet at the node's position —
give its sprite a pivot at the feet and the two line up. It slides along walls, lands on floors and one-way
platforms, walks up and down slopes and steps (up to its **step height**), and keeps its sprite children
facing the way it faces (**flip sprites**).

- **Size** — the box's width and height.
- **Layer** — the 2D layers it is on; an [Area 2D](#area-2d) sees it if the area looks for one of them.
- **Controller** — **Platformer** (below), or **None**: it falls by its **gravity** and moves by the velocity
  a script gives it.
- **Player input** — read the **move**, **jump** and **dash** input actions. Off, a script drives it with the
  same feel (`move`, `jump`, `dash`): an enemy that walks and jumps like the player.

### Platformer

The platformer controller's feel, tuned the way a designer thinks: **jump height** and **time to apex**
rather than a gravity and a launch speed (both are shown). The jump is higher the longer jump is held
(**jump cut** is what is kept when it is let go early), still works for **coyote time** after walking off a
ledge, and a press within **jump buffer** before landing jumps on landing. **Fall gravity** above 1 falls
faster than it rose, which reads as weight.

The three abilities a metroidvania hands out are toggles, off until the game turns them on:

- **Double jump** — **air jumps** more jumps before landing, each a share of the full one.
- **Dash** — a straight burst at **dash speed** for **dash time**, gravity off, once in the air.
- **Wall jump** — pressing into a wall while falling slides down it no faster than **wall slide speed**;
  jumping kicks off it at **wall jump speed**.

### Collider 2D

A **Collider 2D** (**Sprites ▸ Collider 2D**) is a box, centred on the node, that bodies collide with like tiles: **solid**, or a
**one-way platform**. Move the node (a script, a sequence) and it is a moving platform: a body standing on
it rides along. **Enabled** off and nothing collides with it (a door that opened).

### Area 2D

An **Area 2D** (**Sprites ▸ Area 2D**) is a trigger box, centred on the node and moved by its **offset**, that tells scripts what
comes in and goes out — `onTriggerEnter(other)` and `onTriggerExit(other)`, on the area and on what came
in. It sees bodies on the layers it **looks for**, and with **detect areas**, other areas (a sword's hitbox
seeing an enemy's hurtbox). As the child of a character body it moves with it, its offset mirrored when
the character faces left. A pickup, a checkpoint, a hazard, a hitbox.

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

**Appearance** — tint, opacity, blending, sorting order, pivot, flip, lit, exposure weight, follow light, soft fade, transparency, which sides draw, and wireframe. A tileset with
**overdrive** makes its sprites glow through bloom; the value belongs to the tileset, and the section
only reports it.

- **Blending** — **Alpha** draws the sprite over what is behind it. **Additive** adds it as light, for
  fire and glows: black parts vanish and overlapping sprites brighten each other.
- **Sorting order** — a whole number; higher draws later, on top, whatever the distances say. In a 3D
  scene sprites draw by sorting order first and back to front within one, so a muzzle flash at 1 stays
  over the smoke around it. In a 2D scene it offsets the sprite's band from the
  [entity layer](#layers), as a particle emitter's sorting order does: 1 draws over the next layer up.
  0, the default, leaves the order to depth.
- **Pivot** — the point of the image that sits at the node's position: 0, 0 its bottom-left corner, 1, 1
  its top-right, 0.5, 0.5 (the default) its centre. **Base** puts it at the bottom centre. A character
  pivots at its feet: its position is then where it stands, and it turns about its own body. For a sheet
  with empty space under the feet, the pivot's height is that space over the frame's height.
- **Flip X**, **Flip Y** — mirror the image about the pivot: a character facing the other way.
- **Lit** — the sprite takes the scene's light instead of showing its texture as it is: the key light
  (the sun, or the moon) and the shadows it casts on the sprite, the sky and ambient light, and every
  point and spot light that reaches it, per pixel, so smoke over a fire is lit from below by the fire and
  from the side by a torch beside it. Its tileset's **Lighting maps** decide how: relit from each light's
  direction with six-way lightmaps (smoke), shaded as a surface with a normal map (a liquid's splash),
  or flat with neither. The **Tint** is then the colour of what scatters the light: a grey for smoke.
  A lit sprite takes the camera's whole exposure, like a model; **Exposure weight** applies only to what
  it emits (the fire a six-way negative map marks).
- **Exposure weight** — how much the camera's exposure brightens the sprite. A sprite is unlit, so at 1
  (the default) it is multiplied by the exposure like everything lit, and a flame that reads right in
  daylight turns to a white smear at night or in a dark interior, where the exposure is hundreds of times
  higher. At 0 it keeps the same brightness under any exposure; fire usually wants a little (0.1), so it
  still glows brighter in the dark.
- **Follow Light** — a point or spot light nearby, by name, whose flicker the sprite's brightness follows,
  with **Follow Amount** for how much of it: a flame swelling on the beat of its torch's light (the light's
  own **Flicker**). Lights are found under the sprite's parent and a couple of levels above.
- **Soft fade** — in metres: the sprite fades out over that distance as it nears the opaque surface behind
  it, as soft particles do. At 0 a sprite is cut along a hard line wherever it goes into a surface, so a
  flame set into its torch shows a straight edge at the torch head. Above 0 the edge melts away. The sprite
  is still hidden by whatever stands in front of it, so the torch head seen from below hides the flame. A
  flame wants a few centimetres to a little over a decimetre.

Both support **billboarding** (**Constraints**: `free`, `spherical`, `cylindrical`), which matters in
3D scenes where sprites are used for effects.

- **Free** — the sprite keeps its own rotation.
- **Spherical** — the sprite lies in the screen's plane, the usual choice for particles and icons.
- **Cylindrical** — the sprite keeps its own upright axis and turns about it to face the camera's
  position. A flame, a tree card or a smoke column at the edge of a wide view faces the eye, rather than
  lying parallel to the screen, squashed and leaning. With an orthographic camera it faces the view
  direction.

### Draw order and batching

Sprites draw in the order above: by sorting order, then by depth — back to front in 3D; on a tilemap's
entity layer, by the base's Y or in scene order, as its [sprite order](#tilemaps) says; in a 2D scene
without a tilemap, by Z and then scene order. They do not cost a draw call each: sprites that share a **tileset**, a **blending**, the same
**sides** and **wireframe** setting, and whether they are **Lit**, go out together as one draw, and so do
the editor's icons. Everything else (tint, opacity, the tile or animation frame, exposure weight, follow
light, soft fade, a lit sprite's light) is the sprite's own and never splits a draw.

The order is kept exactly. A sprite joins an earlier draw only where that cannot change a pixel: two
additive sprites can trade places (adding light is order-free), and so can two that do not overlap on
screen. Packing the sprites a scene uses into one tileset is what lets thousands of them draw in a handful
of calls; mixing alpha and additive sprites that overlap splits more of them. The Performance panel's
**Scene** section shows the sprites drawn and the draws they went out in.

## Picking in the viewport

A tilemap uses an analytic picker and **only registers a hit where a tile is actually painted**, so
clicking a gap selects what is behind it rather than the map.

## 2D cameras and rooms

In the editor a 2D scene is viewed through an orthographic camera of the editor's own. The wheel zooms,
and the viewport's 2D/3D switch changes the view without changing the scene's authored dimension.

### Camera 2D

The game sees through a **Camera 2D** (**Cameras ▸ Camera 2D**), which takes over in Play. It is
orthographic and sized in art pixels:

- **Pixels per unit** — art pixels in a world unit; match the tilesets'.
- **Reference resolution** — the view in art pixels at **zoom** 1, at least: a 480 × 270 reference on a
  1920 × 1080 screen is drawn four times over. On a screen between whole multiples the view shows more of
  the world rather than less.
- **Pixel perfect** — every art pixel is the same whole number of screen pixels: the 2D frame is drawn at
  the art resolution and scaled up unfiltered, keeping the part of a pixel the camera has moved, so a
  slow pan glides instead of stepping a whole art pixel at a time. Off: drawn at the screen's
  resolution at whatever scale the window gives.
- **Follow** — the name of the node it follows, with a **follow offset**, a **dead zone** (the box round
  the view's centre the target moves in before the camera moves), **damping** (about how long the camera
  takes to catch up) and **look ahead** (how far it leads a moving target).
- **Confine to rooms** — keep the view inside the room the target stands in, and slide into the next one
  over **room transition** seconds when it crosses over.

Its frame (the reference resolution at its zoom) is drawn in the editor where it stands.

### Room

A **Room** (**Sprites ▸ Room**) is one screen of a 2D world: a rectangle, **size** wide and high, centred
on the node, outlined in the editor. While the followed node stands in a room, the camera keeps its view
inside it, centring the view on a room smaller than the screen. Rooms may touch: walking out of one
slides the camera into the next, and scripts on the followed node and on the room hear `onRoomEnter` and
`onRoomExit`. **Zone** is a free label (an area of the world) for a map or a script.

### Parallax Layer

A **Parallax Layer** (**Sprites ▸ Parallax Layer**) is a backdrop sprite that moves with only part of the
camera's travel: **parallax** 1 moves with the world, 0 stays on screen (a sky), 0.2 is a far range. With
**repeat X** (and **repeat Y**) it fills the view however far the camera goes; repeating needs a tileset
whose one tile is the whole image, as a background imported on its own is. **Scroll** drifts it by itself
(clouds). It sorts like any sprite (negative sorting orders behind the tilemap's layers) and is selected
from the scene tree, never by a viewport click.

## The 2D frame

A 2D scene draws through the renderer's **flat 2D frame**: the background, then one sorted and batched
pass of tilemap layers, sprites and particles, then bloom and the rest of the post chain. None of the 3D
frame runs — no shadows, lighting pass, sky, fog, ambient occlusion, reflections, temporal antialiasing,
motion blur or exposure meter — so a 2D game spends its frame on its own art. The exposure is fixed at
1, so a pixel shows as it was drawn.

Two things follow from that:

- **3D content is not drawn** in a 2D scene: models, 3D lights' light, the sky. A scene that mixes them in
  (2.5D) sets [Renderer › 2D Scenes › Pipeline](rendering.md#2d-scenes) to **Full 3D**, which draws the
  whole 3D frame under the 2D content, as every 2D scene drew before.
- **Lit sprites draw unlit** for now: 2D lights come with their own lighting.

Switching a scene to 2D also gives it the **2D look**: no tone curve (Renderer › Tone and post ›
Tone mapper **None**), and bloom only from what is driven past white — a tileset's or sprite's
[overdrive](#atlas) — rather than the soft share of everything a 3D image gets. Switching back to 3D
restores the 3D look, unless the 2D one was retuned.

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
