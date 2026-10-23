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

Import stops and asks before it commits:

| Control | Does |
|---|---|
| **Missing textures** | Lists textures the model references but that were not in the drop, and lets you pick replacements. The file is aliased to the expected name and re-parsed. |
| **Unloadable references** | Reports what could not be read at all. |
| **Normalize scale** | Rescales to a target bounding diameter. Use it — imported models disagree wildly about what one unit means. |
| **Separate** | One asset per sub-model. |
| **Merge** | Collapse sub-meshes into one mesh with one submesh per material. |
| **Submesh grouping** | With both Separate and Merge on, partition the parts into assets by hand. |

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

1. **Character picker**: which character are these clips for? They are linked to its skeleton.
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

Open a model (double-click it in Assets) and use the **Parts** section. It lists every mesh in the model
and, under a merged mesh, each of its material **sub-meshes**. Each row has two actions:

- **Save as model** copies that piece into a new model, named `<model> – <part>`, beside the original
  in the asset folder. The original is untouched.
- **Extract** does the same and removes the piece from the open model. **Save** the model afterwards to
  keep it; placed copies update as with any model edit. The last mesh can't be extracted.

The new model keeps the piece's orientation and size inside the original, is centred on its own bounds,
and links the same materials. A piece of a skinned character keeps the rig and its animations.

## LOD generation

Open a model asset to reach the **Model inspector**: name, LOD levels, cull distance, *Generate
LODs*, and the blend spaces that use it.

**Generate LODs** builds a ladder — each level a ratio and a takeover distance, defaulting to
`0.5 / 0.25 / 0.1` at distances derived from the model's diameter. **Downscale textures** halves
maps alongside the geometry; levels landing on the same size share one image, small maps stop at
64 px, and maps carrying alpha are left at full size.

Each generated level becomes its own model asset and is *referenced*. Regenerating updates them
rather than adding more. You can also add a LOD level from an existing asset by hand.

A model with LOD levels instantiates as a LOD group node.

**Cull distance** stops drawing it entirely past a distance.

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

**Colours** — diffuse, specular, ambient, emission, shininess, opacity.

**Textures** — one slot per map. Drop a texture on a slot, or pick one.

**Cutout** — `alphaCutoff`. **`0` disables cutout entirely**; above zero it tests the mask texture's
red channel (PBR also falls back to base-colour alpha). Cutout casts correct shadows, which blended
transparency does not — so prefer it for foliage, fences and grates.

**Toon** — band count and spread, for Cel.

**UV Mapping** — see below (Blinn-Phong, Cel and PBR).

**Height** — see below.

**Options** — side (front / back / double), transparency, shadow casting, probe participation,
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

**Screen** mode makes the material a fullscreen post-processing pass, ordered within a camera's
post chain. Screen materials run for the **active camera only**.

Set uniforms from script through the material's properties — see
[Rendering (scripting)](../scripting/rendering.md#custom-materials).

## See also

[Assets](assets.md) · [Animation](animation.md) · [Rendering](rendering.md) · [Terrain](terrain.md)
