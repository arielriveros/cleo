# Models and materials

Getting geometry in, and making it look right.

## Importing a model

Accepted: `.gltf`, `.glb`, `.fbx`, `.obj` (with `.mtl`). Drop files on the Assets panel, or use
**+ Add ▸ Import Files…**.

A multi-file model — a `.gltf` beside its `.bin` and a `textures/` folder — must be dropped
**together**, and is grouped by relative path. Dropping a folder works.

`.fbx` and `.glb` are converted to glTF2 first and then read by the same reader as a `.gltf`, so all
three routes end up in the same place.

### The review modal

Import stops once per model and asks before it commits: which textures are missing, how the file's
parts become assets, and what size it comes in at. **Accept & Import** commits it; **Cancel** skips
that model.

| Control | Does |
|---|---|
| **Missing textures** | Textures the model references that were not in the drop, listed under **Textures** with **Select missing textures…** to pick replacements. A picked file is aliased to the expected name and the model re-parsed. |
| **Unloadable references** | Textures embedded in the model in a format the browser cannot read. There is no file to pick: re-export the model with its textures as separate `.png` / `.jpg` files and import them together. |
| **Contents** | Shown when the file holds more than one part: whether they become one asset or several, merged into one mesh or kept as separate nodes. |
| **Separate** | One asset per sub-model, each centred on its own origin. |
| **Merge** | Collapse sub-meshes into one mesh with one submesh per material. Parts that use different material types, or mix opaque and transparent, stay separate, and the log says why. |
| **Groups** | With both Separate and Merge on, each group becomes one model asset, its parts merged into a single mesh. It starts with one group per material; drag a part to another group (or pick the group's number beside it), and **+ Add group** for another. |
| **Size** / **Normalize size** | Rescales to a target bounding diameter (**Fit to**, in units). Use it — imported models disagree wildly about what one unit means. |

Progress runs queued → parsing → **review** → reparsing → scaling → textures → materials → saving.
The review step shows as *paused*, which is how you tell "waiting on you" from "still working".

Import creates **material assets** automatically, one per material the file declares.

### Merge or separate?

**Merge** when the parts are one object and share a transform — a chair, a rifle. One node, one
draw call per material.

**Separate** when the parts move independently, or when you want to place them individually.

Merging is constrained: submeshes must share a material *type* and transparency setting, which is
why a model with both opaque and transparent parts cannot fully merge.

## Animation import and retargeting

Clips are shared assets (`.anim`), stored in their **source rig's space** and retargeted when used.
One walk cycle can therefore drive several different characters.

**+ Add ▸ Animation**, pick a `.fbx`/`.glb`/`.gltf`, then:

1. **Character picker**: which character are these clips for? Its skeleton is what the clips are
   matched and linked to, so every character built on it plays them. The clips themselves stay in the
   file's own skeleton space, so they can be linked to other skeletons later.
2. **Skeleton**: a one-line summary of the bone match, and **Map bones…**, which opens the
   [bone mapper](#the-bone-mapper). Whatever you change there is saved on the character's skeleton, so
   every later clip from the same source skeleton is matched the same way.
3. **Clip list**: check the clips you want and rename them. Mixamo's `mixamo.com` and glTF's
   `Animation` are auto-named from the filename, because those names are useless.

> **A model with no bone names cannot be mapped by name**, only by index, and the import warns
> about it. Fix the export if you can.

### The bone mapper

**Map bones…** (in the import dialog, or in a skeleton's **Retargeting** section after picking *Clips
from…*) shows both skeletons side by side in a front view of their bind pose: the clips' skeleton on the
left, the character's on the right.

- **Drag** a bone from the left onto a bone on the right to make it drive that bone, or click one and then
  the other. The searchable lists at the sides do the same for bones that overlap in the drawing.
- **Right-click** a left bone: *Don't animate this bone*, or *Back to automatic*.
- **Scroll** to zoom (fingers), drag the background to pan. **Mirror left → right** copies your left-side
  changes to the right side; **Auto-match all** forgets every change.

Every bone is coloured by what the retarget will actually do with it:

| Clip bone | Meaning |
|---|---|
| green | matched automatically |
| blue | matched by hand |
| purple | merged into the matched bone below it |
| red | animated, but its motion is lost: map it |
| grey (dashed) | turned off on purpose |
| grey | no clip animates it |

| Character bone | Meaning |
|---|---|
| green | driven by one bone |
| purple | driven by several bones, combined |
| teal | shares the bend of the bone below it |
| grey | holds its rest pose |

#### When the two skeletons do not match bone for bone

Three rules keep the posture right when the bone counts differ:

1. **Merge.** Several clip bones mapped to one character bone are combined: their rotations add up, so a
   3-bone spine onto a 2-bone spine bends just as far. A clip bone with no counterpart that sits between
   matched bones (a clavicle the character lacks, an extra spine bone) is merged into the matched bone
   below it automatically: its motion is not lost.
2. **Share.** A character bone that nothing drives, sitting in a single chain between two driven bones (a
   3-bone spine played from a 2-bone one, a clavicle the clips lack), takes an even share of the bend
   below it instead of staying rigid. Twist, roll and helper bones never share.
3. **Leftovers are fine.** A clip bone with nothing to drive at the end of a chain (finger tips, helper
   bones) is dropped; a character bone outside any driven chain (twist, props, face) holds its rest pose.
   The colours show both, so nothing goes missing silently.

## Splitting a model into parts

Open a model (double-click it in Assets) to split pieces of it off into models of their own, from its
**Parts** section.

**Parts** — every mesh in the model and, under a merged mesh, each of its material **sub-meshes**.
Each row has two actions: **Save as model** copies the piece into a new model next to this one, and
**Extract** also removes it from this model — save the model afterwards to keep that.

- **Save as model** names the new model `<model> – <part>` and files it beside the original in the
  asset folder. The original is untouched.
- **Extract** does the same and removes the piece from the open model. **Save** the model afterwards to
  keep it; placed copies update as with any model edit. The last mesh can't be extracted.

The new model keeps the piece's orientation and size inside the original, is centred on its own bounds,
and links the same materials. A piece of a skinned character keeps the rig and its animations.

## The model inspector

Open a model asset (double-click it in Assets) and Properties shows the **Model inspector** above the
usual node inspector: the model's name, its [Parts](#splitting-a-model-into-parts), the blend spaces
on its skeleton, and its cloth and its LOD levels.

**Blend spaces** — on a skinned model, the blend spaces of the skeleton it is built on, shared by every
character on that skeleton: click one to open it, or **+ New Blend Space** to make one from this
model. A blend space mixes clips by one or two parameters and stands in an animator as a state of its
own instead of a single clip — see [Blend spaces](animation.md#blend-spaces).

### Cloth

On a skinned model: paint which parts of the mesh are cloth, and how freely each part moves — see
[Cloth on a character](physics.md#cloth-on-a-character). A painted vertex follows the skin with slack
instead of exactly; the more weight, the more slack, up to **Max Distance**.

- **Mesh** — which of the model's skinned meshes is painted, when it has more than one.
- **Paint** — left-drag in the viewport paints instead of selecting. The painted parts are shown over the
  model as a heat map: blue for a little weight, through green, to red for fully free; unpainted parts are
  left bare. **Shift** erases (or paints, with Erase chosen), **Ctrl** smooths, `[` / `]` and
  **Ctrl+wheel** size the brush, **Esc** stops painting. Each stroke is one undo step.
- **Preview** — simulates the cloth in the tab, swinging the model from side to side so it moves. Turn
  it off to put the cloth back on the skin.
- **Paint tools** — **Paint** moves the weights toward **Value**, **Erase** toward 0, **Smooth**
  evens them out with their neighbours, and **Fill** sets the whole connected piece under the cursor
  (within its material) to Value in one click. A vertex is always painted with the other vertices at
  its position, so seams never split.
- **Value** — the weight Paint and Fill lay down: 0 stays on the skin, 1 is fully free.
- **Radius** — the brush size.
- **Strength** — how quickly a stroke reaches its goal.
- **Falloff** — 0 a hard edge, 1 fully feathered toward the rim.
- **Fill material** — sets every vertex of one material to Value: the quickest start for a tunic.
- **Clear** — removes all the cloth from the mesh.
- **Max Distance** — how far, in metres, a fully free vertex may stray from where the skin puts it.
- **Stiffness** — how much the cloth resists stretching.
- **Bend** — how much it resists folding; low hangs in soft folds.
- **Damping** — how quickly a swing dies down.
- **Mass** — heavier cloth is moved less by the wind.
- **Gravity Scale** — above 1 the cloth falls and settles harder.
- **Wind Response** — how much the scene's wind blows it.
- **Thickness** — how far the cloth keeps off the body's collision capsules.
- **Backstop** — how far it may sink behind its skinned place, which keeps it out of the body or armour
  under it.

### LOD levels

Each level takes over at its distance. Only LOD0 is edited here; selecting another level just
previews it. Generated levels are part of this model — deleted with it, moved with it — and a level
added from another model updates when that model is edited. A skinned model has no LOD levels.

- **From** / **From distance** — where a level takes over. With a cull distance set it is a share of
  it (50% of a 200 m cull starts the level at 100 m), kept when the cull changes; without one it is a
  distance in metres.
- **Cull distance** — copies disappear beyond this camera distance, and foliage dissolves out rather
  than popping. 0 is automatic: a placed copy never culls, and foliage draws on past its last LOD or
  impostor band, at least to the scene foliage distance. A level whose band starts at or past the
  cull distance is never drawn, and the panel says so.
- **Generate LOD levels…** — decimates this model into a ladder, each level a ratio and a takeover
  distance, defaulting to `0.5 / 0.25 / 0.1` at distances derived from the model's diameter.
  **Halve texture resolution per level** gives each level smaller textures too: levels landing on the
  same size share one image, small maps stop at 64 px, and maps whose alpha carries data are left at
  full size. From LOD2 on, only the colour, normal and alpha-mask textures are kept. Regenerating
  replaces the levels a previous generate made, and keeps the ones added by hand.
- **Add LOD level from model…** — uses another, lower-poly model asset as a level.

A model with LOD levels instantiates as a LOD group node.

> LOD generation is static-only: skinned models are excluded.

## The material editor

Reached from a model node's material slot, or by opening a `.mat`. In Material mode it renders on a
preview sphere under a neutral studio rig, so a material you tune is not being judged through your
scene's grading.

### Shader modes

| Mode | Use for |
|---|---|
| **Basic** | Unlit. UI-ish things, effects, anything that should not react to light. |
| **Blinn-Phong** | Cheap classical shading. Specular is genuine `pow(NdotH, shininess)`. |
| **PBR** | The default choice. Metallic-roughness. |
| **Cel (toon)** | Banded shading. **Forward only.** |
| **Custom (shader)** | Your own GLSL/WGSL fragment shader with declared uniforms. |

### Sections

**Colors** — Blinn-Phong and Cel: diffuse, specular, ambient, emission and opacity, plus shininess
(Blinn-Phong) or the rim colour (Cel).

**Properties** — Basic and PBR. Basic has a colour and an opacity. PBR has base colour, metallic,
roughness, reflectance, opacity, an emissive colour and **Emissive power**: the colour is the hue and
the power how hot, and above about 2 an emissive surface starts to bloom. **Exposure weight** is how
much of the camera's exposure the glow takes: 1 (the default) is physical, faint in daylight and
fierce in the dark like any other light; lower values hold it closer to one look in every exposure,
for a rune or a magic effect that must read the same at noon and in a cave. The base colour multiplies a
base-colour texture, and the section warns when a texture sits under a non-white colour.
**Translucency** (PBR) is how much light passes through a thin surface: a leaf or a grass blade with
the sun behind it glows in its own colour instead of going dark. Like a real leaf it scatters that light
forward, so the glow is something you see through it: bright looking through the leaves toward the sun
or a light, faint from the side, gone with the light at your back; a little of the sky shows through
the back as well. 0 (the default) is opaque; 0.3–0.6 suits foliage. A translucent surface is always shaded as a non-metal. glTF files carry it as
`KHR_materials_diffuse_transmission`, which the importer reads. A foliage layer's far impostor carries
the translucency of its coarsest level's leaves, so a back-lit tree keeps its glow at any distance.
**Translucency colour** and **Colour blend** tint the light that comes through: real back-lit leaves
lose their blues and glow yellow-green, autumn ones orange. The glow blends toward the colour by the
blend amount; only its hue counts, matched to the surface's own brightness, so Translucency stays the
intensity. Blend 0 (the default) glows in the surface's own colour. glTF carries it as the extension's
`diffuseTransmissionColorFactor`, and Cleo's own exports carry the exact value. The far impostor of a
foliage layer glows untinted.

**Textures** — one slot per map. Drop a texture on a slot, or pick one.

**Cutout** — **Alpha cutoff**, with the **Mask** texture beside it (Blinn-Phong and Cel keep the mask
with their other textures). **`0` disables cutout entirely**; above zero it tests the mask texture's
red channel (PBR also falls back to base-colour alpha). Cutout casts correct shadows, which blended
transparency does not — so prefer it for foliage, fences and grates.

**Toon** — Cel only: the number of bands (or a **Ramp** texture in their place), edge softness, the
highlight's shininess and cut, and the rim's power and strength.

**UV Mapping** — Blinn-Phong, Cel and PBR: how the textures are laid on the surface. **Mesh UV** uses
the model's own texture coordinates; **Box** projects along each face's axis in metres, so a scaled
wall or floor keeps its texel size; **Triplanar** blends all three axes for rocks and organic shapes.
See [UV mapping](#uv-mapping-textures-that-dont-stretch).

**Height** — a height map turned into parallax relief on PBR, with its depth in world units, an
invert for depth maps and clipping at the UV border. See [Height and parallax](#height-and-parallax).

**Wind** — how a plant wearing this material sways in the scene's [Wind](node-inspector.md#wind):
**Strength** (the lean at full gust, as a fraction of the plant's height), **Stiffness**, and **Moves
as** — **Whole plant** rides the sway rigidly, like a trunk; **Leaves** follows it and adds its own
sprig sway and **Flutter**, more toward the outside of the canopy. Read by foliage only, while the
scene has a Wind node; a tree's materials bend as one, the strongest setting the lean. Not on terrain
materials.

**Options** — side (front / back / both), transparency, shadow casting, probe participation,
wireframe.

### UV mapping: textures that don't stretch

A primitive's texture coordinates run 0..1 across each face whatever its size, so a texture on a wall
made from a cube scaled to 10 × 3 m shows one repeat stretched across the whole face. **UV Mapping**
fixes that the way other engines do: Unreal's world-aligned / triplanar textures, Unity's Tiling &
Offset plus ProBuilder's world UVs, Godot's UV1 Triplanar.

| Projection | Use it for |
|---|---|
| **Mesh UV** | Imported, UV-unwrapped models. **Tiling** repeats the texture, **Offset** slides it. |
| **Box** | Walls, floors, crates, level blocks. Each face is textured along its own axis at **Size** metres per repeat, so any scale keeps the same texel size. |
| **Triplanar** | Rocks, cliffs, organic shapes. All three axes, blended by the surface direction (**Blend**: higher = sharper seams, cheaper look). |

**Space** decides what the projection is measured against:
- **Object** follows the object, including its scale, and keeps the texture still when the object moves.
- **World** lines neighbouring pieces up into one continuous pattern, which suits modular walls.

Tiling and Offset still apply on top of a projection. Projections ignore the model's UVs entirely, and
normal maps keep working (their tangent frame is rebuilt per face). Parallax relief runs in Mesh UV and
Box modes but not Triplanar. Cutout shadows still use the model's UVs. The material preview's **Box**
shape (a stretched 2 × 1 × 0.5 m block) is the quickest way to compare modes.

### Height and parallax

A **Height** map turns into parallax occlusion mapping, on every PBR material that has one: there is
no separate switch, the map being there is the request.

| Control | Meaning |
|---|---|
| **Height map** | Read from the red channel, white = high. Available on every material type (Basic and Blinn-Phong carry it for terrain layers; only PBR marches it). |
| **Depth** | How deep the relief is, in **world units**. |
| **Invert** | The map is a *depth* map (white = deep), as most downloaded `*_disp.png` files are. |
| **Clip at UV border** | Also bite the relief into the edges of flat faces mapped `0..1` (cube faces, quads). Leave it off on tiled surfaces. |

What the march does, per pixel:
- **Offsets every texture fetch** to where the view ray meets the height field, and self-shadows the
  relief from the sun.
- **Carves curved silhouettes.** The ray bends with the surface's curvature, which is measured from
  the mesh's own normals, so the outline of a sphere, a cylinder or an organic model is bitten into
  by the relief instead of staying smooth. Nothing to set up and no import step; skinned models work
  too. A flat face has no curvature to bend with, which is what **Clip at UV border** is for.
- **Writes the relief's depth**, so other objects intersect the bumps rather than the flat polygon,
  and lighting and SSAO see it too. This costs early depth rejection for those draws only — materials
  without a height map never pay for it.

Limits: shadow casters still use the flat polygon, and the relief cannot bulge *outward* past the
mesh — it carves inward from the surface. Triplanar mapping does not march.

Depth is in **world units** for materials authored since that changed. Older materials keep UV
units, because converting the stored number needs the mesh's chart scale, and one material can sit
on both a cube and a photogrammetry scan. The panel shows what one UV unit is worth on the mesh in
front of you and converts when you switch the unit.

> The reason this changed: `displacementScale` used to be a fraction of one texture repeat, which
> means nothing until you know what a repeat is worth. Measured on a scanned branch, one UV unit was
> 47.97 world units — so a default of `0.05` asked for 2.4 units of relief on a branch 12.7 units
> thick.

Compute-shader tessellation (turning the height map into real geometry) was tried and removed; a
`displaceLevel` stored in an older material is ignored and dropped on the next save.

## Textures

Opening a texture asset gives wrap, filter, mipmaps, anisotropy and colour space, with a **data-slot
audit** — see [Assets → Textures](assets.md#textures). That audit catches the most common material
bug there is: a normal map imported as sRGB.

## Custom materials

**Custom (shader)** mode gives you a fragment-shader source editor with syntax highlighting, a
uniform list (name, type, default), and a forward / deferred / screen render mode.

Uniform types: `float`, `vec2`, `vec3`, `vec4`, `int`, `bool`, `sampler2D`, `samplerCube`.

**Uniforms** — the material's declared uniforms, each a name, a type and a value. A uniform is
`u_<name>` in the shader; a sampler binds the texture you pick, and a scalar or vector uploads its
value every frame. Adding, removing or retyping one recompiles the shader.

**Screen** mode makes the material a fullscreen post-processing pass, ordered within a camera's
post chain. Screen materials run for the **active camera only**.

Set uniforms from script through the material's properties — see
[Rendering (scripting)](../scripting/rendering.md#custom-materials).

## See also

[Assets](assets.md) · [Animation](animation.md) · [Rendering](rendering.md) · [Terrain](terrain.md)
