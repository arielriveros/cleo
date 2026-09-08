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

1. **Rig picker** — which skeleton is this for?
2. **Bone mapping table** — every source bone against a target bone, colour-coded by how it was
   matched: exact, by name, auto-humanoid, spine, by index, manual, or none. Counts update live as
   you correct it.
3. **Clip list** — check the clips you want and rename them. Mixamo's `mixamo.com` and glTF's
   `Animation` are auto-named from the filename, because those names are useless.

> **A model with no bone names cannot be mapped by name**, only by index, and the Clips panel warns
> about it. Fix the export if you can.

## LOD generation

Open a model asset to reach the **Model inspector**: name, LOD levels, cull distance, *Generate
LODs*, and the animation fields that use it.

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

**Height** — see below.

**Options** — side (front / back / double), transparency, shadow casting, probe participation,
wireframe.

### Height: displacement, tessellation and parallax

The single most confusing part of the material editor, so it is worth being precise.

| Control | Meaning |
|---|---|
| **Displacement map** | A height map, read from the red channel. Available on every material type. |
| **Depth** | How deep the relief is, in **world units**. |
| **Tessellation level** | How finely the mesh is subdivided to carry that relief, with a read-out of triangles, megabytes and texels per edge. |
| **Clip at UV border** | Silhouette handling on surfaces mapped `0..1`. |

Depth is in **world units** for materials authored since that changed. Older materials keep UV
units, because converting the stored number needs the mesh's chart scale, and one material can sit
on both a cube and a photogrammetry scan. The panel shows what one UV unit is worth on the mesh in
front of you and converts when you switch the unit.

> The reason this changed: `displacementScale` used to be a fraction of one texture repeat, which
> means nothing until you know what a repeat is worth. Measured on a scanned branch, one UV unit was
> 47.97 world units — so a default of `0.05` asked for 2.4 units of relief on a branch 12.7 units
> thick.

Tessellation turns the height map into **real geometry**, with a real silhouette and real
self-shadowing, and it is picked up by every draw path including shadows and depth. It requires
WebGPU (there is no compute stage in WebGL 2, which draws the mesh as authored), and **skinned
models are refused** — an animated mesh is deformed by bone matrices in the vertex stage, so
displacing its buffer would displace the bind pose.

**Parallax occlusion mapping is off by default and was withdrawn**, including for materials saved
before the flag existed. Real displacement replaced it for the case it was being used for.

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
