# Foliage Creator

Generate grass clumps, rocks and trees from parameters, each with its levels of detail, and export them
as glTF models ready for a foliage rule.

Pick **Grass**, **Rock** or **Tree** in the toolbar. Each kind keeps its own parameters, so switching
back and forth loses nothing. Every edit regenerates the asset in a background worker, and the
**Viewport** shows it as a real LOD group, switching levels by distance exactly as a game does. The
preview loads the same `.glb` files the export writes, through the Editor's own importer, so what you
see is what you import. Drag to orbit, right-drag to pan, scroll to move closer; **F** frames the asset.

The menu top-right of the viewport shows the grid, floor, sky, a patch of grass clumps, and wireframe.
The **LOD** menu beside it pins one level, or lets distance choose. The corner readout gives each
level's triangles and the level on screen.

The **right** dock holds **Parameters** (the shape and look), **LOD** (the level ladder) and **Export**
(file name, texture sizes, texture overrides, Download). The **left** dock holds presets, seeds, saved
variants and the preview stage.

Every asset is a pure function of its parameters and **Seed**. Random choices are keyed by what they
decide (this branch, this leaf), so changing one slider moves only what it touches. **New seed** gives
another plant from the same parameters.

## Presets

Starting points for the current kind. A preset replaces the kind's parameters and keeps the seed.

## Seeds

The seeds tried this session. Click one to go back to it.

## Saved variants

Keep the current kind, parameters and seed under a name, and load it again later. Stored in the browser.

## Stage

The light the preview is shown in. None of it reaches the export.

| Field | Meaning |
|---|---|
| **Sun direction** | The sun's compass direction. |
| **Sun elevation** | The sun's height above the horizon. Low and behind a plant shows its translucency. |
| **Sun illuminance** | Sunlight in lux; 60 000–100 000 is a clear day. |
| **Ambient light** | The flat fill under the sky, in lux. |

## Clump

A grass clump is the unit a foliage rule scatters: one instance, many blades.

| Field | Meaning |
|---|---|
| **Blades** | Blades in the clump. Each is a few triangles. |
| **Clump radius** | How far from the centre blades grow. They are denser near the middle. |
| **Clump facing** | How much blades lean away from the clump's centre, as real clumps splay. |

## Blade

Each blade is a strip along a bent spine, tapering to its tip.

| Field | Meaning |
|---|---|
| **Height** | Average blade height. Blades near the clump's edge are shorter. |
| **Height variance** | How much heights vary, as a fraction. |
| **Width** | Blade width at the root. |
| **Taper** | How much of the width is gone at the tip; 1 is pointed. |
| **Bend** | How far the tip leans out, as a fraction of the height. |
| **Curvature** | How the bend is spread: 1 a straight lean, higher values droop near the tip. |
| **Tilt** | Random lean from vertical. |
| **Segments** | Spine segments per blade. More curve smoothly; each adds two triangles. |
| **Normal rounding** | How far normals turn across the blade, so a flat strip shades as a rounded blade. |

## Shape

A rock starts as a dense sphere, is carved, and is then reduced to its triangle budget.

| Field | Meaning |
|---|---|
| **Size** | The rock's diameter before proportions. |
| **Proportions** | Width, height and depth relative to the size. |
| **Detail** | Subdivisions of the sphere the noise carves. Higher keeps finer features through the reduction. |
| **Triangles** | LOD 0's triangle count after reduction. The silhouette survives far better than starting coarse. |

## Surface

| Field | Meaning |
|---|---|
| **Noise amount** | How far the surface is pushed in and out. |
| **Noise scale** | How many bumps across the rock. |
| **Sharpness** | Blend from rolling noise to sharp ridged crests. |
| **Cuts** | Planar fractures: flat broken faces where the rock split. |
| **Cut depth** | How deep each fracture bites. |
| **Strata** | Sedimentary layering, as terraces in the shape and bands in the colour. |
| **Strata frequency** | How many layers. |
| **Flatten bottom** | How much of the base is cut flat so the rock sits on the ground. |

## Look

Colours are baked into the asset's textures.

| Field | Meaning |
|---|---|
| **Base colour** | Grass: the colour low on the blade. |
| **Tip colour** | Grass: the colour at the tip. |
| **Dryness** | Grass: the share of blades that are dry. |
| **Dry colour** | Grass: the dry blades' colour. |
| **Root shade** | Grass: darkening at the root, standing in for the shadow inside the clump. |
| **Colour** | Rock: the stone's base colour. |
| **Colour variation** | Rock: broad tonal patches across the stone. |
| **Edge wear** | Rock: lighter, worn crests. |
| **Cavity dirt** | Rock: darker hollows and base. |
| **Moss** | Rock: moss on faces that look up. |
| **Moss colour** | Rock: the moss's colour. |
| **Bumpiness** | Rock: strength of the baked normal map. |
| **Roughness** | Surface roughness: 1 is fully matte. |
| **Translucency** | How much light passes through, so blades and leaves glow when lit from behind. 0.3–0.6 suits foliage. |

## Trunk

| Field | Meaning |
|---|---|
| **Height** | The tree's height. |
| **Trunk radius** | Radius at the base, above the root flare. |
| **Bare trunk** | Fraction of the height with no branches. |
| **Root flare** | How much wider the base gets. |
| **Gnarliness** | How much every stem wanders. |
| **Trunk split** | Where the trunk forks into two leaders, as a fraction of the height; 0 never forks. |

## Crown

| Field | Meaning |
|---|---|
| **Crown shape** | The outline that sets first-level branch lengths up the trunk (Weber and Penn's shapes): conical for a spruce, spherical or tend-flame for a broadleaf, and so on. |
| **Branch levels** | How many levels of branching below the trunk. Each level multiplies the stem count. |
| **Rotation** | The turn between successive branches. 137.5° (the golden angle) never lines two up. |
| **Attraction up** | Stems bend toward the sky (positive) or droop (negative) as they grow. |
| **Branch thickness** | A branch's radius relative to its parent's at the fork. |

## Branches

First-level branches, along the trunk. The **Sub-branches** and **Twigs** sections set levels 2 and 3
with the same fields.

| Field | Meaning |
|---|---|
| **Branches** | How many: along the trunk for the first level, on each parent below that. |
| **Length** | Relative to the parent. First-level lengths also follow the crown shape. |
| **Angle** | The angle down from the parent's direction. |
| **Curve** | How much each branch bends along its length: positive up, negative down. |

## Sub-branches

Second-level branches, on each first-level branch. Fields as in [Branches](#branches).

## Twigs

Third-level branches. Fields as in [Branches](#branches).

## Leaves

Leaves are cards, each carrying a sprig of several leaves (or a brush of needles) from a generated
atlas: ten to twenty leaves for two triangles.

| Field | Meaning |
|---|---|
| **Leaf kind** | Broadleaf sprigs, needle brushes, or none. |
| **Leaf shape** | The broadleaf outline. |
| **Cards per branch** | Cards on each end branch, plus one at its tip. |
| **Card size** | One card's size. |
| **Size variance** | How much card sizes vary. |
| **Leaf start** | How far along an end branch leaves begin. |
| **Normal bend** | How far card normals lean outward from the crown's centre, so the canopy shades as one volume instead of a scatter of flat cards. |
| **Leaf colour** | The leaves' base colour. |
| **Colour variation** | Variation in hue and value between leaves. |
| **Autumn** | Blend toward autumn reds, oranges and yellows. |
| **Leaf roughness** | The leaves' roughness. |

## Bark

A tiling bark texture, wrapped around and along every stem. Texels stay square on thick and thin
stems.

| Field | Meaning |
|---|---|
| **Pattern** | Furrowed (oak), plated (pine), smooth (beech) or papery (birch). |
| **Bark colour** | The bark's base colour. |
| **Bark roughness** | The bark's roughness. |
| **Bark scale** | Metres of circumference one texture repeat covers. |

## Wind

Written into the materials, so the asset sways once it is in a foliage rule. The Creator's preview does
not sway.

| Field | Meaning |
|---|---|
| **Wind strength** | How far the plant leans in the wind, as a fraction of its height. |
| **Wind stiffness** | How hard it resists: higher sways less and faster. |
| **Flutter** | The leaves' (or blades') fast flutter. |

## Levels

The LOD ladder. Distances are metres from the camera to the asset's bounding sphere, which is how the
Editor switches levels.

| Field | Meaning |
|---|---|
| **LOD 1 distance** | Where LOD 1 takes over from LOD 0. |
| **LOD 1 blades** | Grass: the share of blades LOD 1 keeps (at half the segments), widened to cover. |
| **LOD 1 leaves** | Tree: the share of leaf cards LOD 1 keeps, grown to cover. LOD 1 also drops the twig level and halves branch sides. |
| **LOD 1 triangles** | Rock: LOD 1's triangles as a fraction of LOD 0. |
| **LOD 2 distance** | Where LOD 2 takes over. Grass's LOD 2 is three crossed cards showing a picture of the clump. |
| **LOD 2 leaves** | Tree: the share of cards LOD 2 keeps. LOD 2 keeps only the trunk and first-level branches. |
| **LOD 2 triangles** | Rock: LOD 2's triangles as a fraction of LOD 0. |
| **Cull distance** | Beyond this nothing is drawn. |

## Impostor

Trees only: an octahedral impostor (a sheet of views from around the upper hemisphere) replaces the
last mesh level in the distance.

| Field | Meaning |
|---|---|
| **Impostor** | Whether the tree gets an impostor. |
| **Impostor distance** | Where the impostor takes over. |
| **Frames** | Views per side of the atlas. |
| **Frame size** | Pixels per view. |

## Level costs

What each level costs to draw. LOD 0 is flagged when it is over budget: a foliage layer draws it many
times and stores every level in the scene.

## Impostor atlas

**Bake preview** bakes the impostor from LOD 2, the level it replaces, so the hand-over does not pop.
The export bakes it again and writes both atlases. In the Editor, the foliage rule's own impostor bake
is the one the engine uses.

## File

**Name** is the stem of every exported file.

## Textures

| Field | Meaning |
|---|---|
| **Texture size** | The generated textures' size. |
| **Bark texture size** | The bark albedo and normal map's size. |
| **Leaf texture size** | The leaf atlas's size. |

## Texture overrides

Replace any generated texture with an image of your own. It is resized to the slot's size. A rock's
albedo is baked into its own six-chart layout, so a tiling photo works but shows seams. **Use
generated** goes back.

## Using the export in the Editor

1. Import every `name_LODn.glb` as a model. Each arrives with its materials set up: cutout and
   double-siding on leaves and cards, translucency, and the wind response.
2. Open the LOD 0 model and add LOD 1 and LOD 2 as its levels, with the distances listed in
   `name.foliage.json`. Set its cull distance from the same file.
3. Use the model in a terrain material's foliage rule. For a tree, bake the impostor on the rule.
   `collider` in the sidecar suggests a foliage collider.
