# Assets

The **Assets** panel is one file manager over every library in the project, with real folders. All
19 asset kinds live in it.

## The panel

A single toolbar row:

| Control | Does |
|---|---|
| **+ Add ▾** | Material, Landscape Material, Template, Script, Tileset, **AI Brain (Machine)**, **AI Brain (Goals)**, **Particle System**, **Animator**, Sound, Animation, Scene, Folder, Import Files… |
| **Search** | Filters by name. |
| **Audit** | Flags assets a library holds but the explorer is not showing, and orphan entries pointing at deleted assets. Carries a warning badge when either exists. |
| **Reference graph** | One asset in the middle, what uses it on the left and what it uses on the right, each followed one level, two, or all the way. Its badge counts references that point at an asset that no longer exists — the opposite question to **Audit**. |
| **Details** | Toggles the details pane. |
| **View** | Table, Cards, or Split. |

Drop OS files on the panel to import them. Drop a **scene node** on it to save that node as a
template. Right-click empty space for **New folder**, or a template for **Create Variant** (a template
that inherits it — see [Template variants](scene-authoring.md#template-variants)).

Folders are yours to arrange; nothing depends on where an asset sits.

## The 19 kinds

| Kind | Ext | Created by | Edited in | Used by |
|---|---|---|---|---|
| **Image** | real | Import / drop / model import | *no editor* — raw bytes, filed under `Source/`, hidden while a texture is made from it | backs Textures |
| **Texture** | `.tex` | Derived automatically from whatever registers as a texture | [Texture mode](#textures) | material slots, tileset atlases, LUTs, lens dirt |
| **Material** | `.mat` | **+ Add**, or model import | [Material mode](models-and-materials.md#the-material-editor) | model nodes |
| **Landscape Material** | `.tmat` | **+ Add** | Landscape Material mode | a landscape — each has exactly one, and its slots are the surfaces you paint |
| **Template** | `.tpl` | **+ Add**, or dragging a scene node onto this panel | Template mode | placed instances, runtime spawning |
| **Model** | `.model` | Model import, or adopting a node subtree | Model mode | placed in scenes |
| **Scene** | `.scene` | **+ Add** | The scene tab | one is the main scene |
| **Script** | `.script` | **+ Add** | [Script mode](scripting-workflow.md) | attached to nodes |
| **Animation** | `.anim` | **+ Add** (pick a `.fbx`/`.glb`/`.gltf`) | [Clip mode](animation.md) — clips stay in source-rig space | rig clip lists, state machines |
| **Rig** | `.rig` | Model or animation import — one per distinct skeleton | [Rig mode](animation.md): clips, retargeting, IK, sockets, bone masks, poses | models built on that skeleton |
| **Animator** | `.animator` | **+ Add**, the workspace's **Animator ▾ → + New Animator**, the [Animate wizard](animation.md#animate-a-character-in-a-minute), or **Share…** in the Animator | [Character Animation workspace](animation.md#shared-animators), previewed on a character on its skeleton | characters' **Animation** section |
| **Bone Mask** | `.mask` | The rig editor's **Bone Masks** section | Rig mode, **Bone Masks** section | controller layers and action slots |
| **Pose Asset** | `.pose` | Saving a pose in the clip editor, or **+ New pose asset** in the rig editor's **Poses** section | Rig mode, **Poses** section | clip pose offsets, controller pose states |
| **Blend Space** | `.blendspace` | The workspace's **Blend Spaces ▾ → + New Blend Space**, or the Animate wizard | The Character Animation workspace | a state in an animator |
| **AI Brain** | `.brain` | **+ Add ▸ AI Brain (Machine \| Goals)** | [AI Brain mode](ai-brains.md) | linked from a Controller |
| **Particle System** | `.vfx` | **+ Add ▸ Particle System**, or **Create asset from this effect** on a Particle System node | [Particle System mode](modes.md) | linked from a Particle System node, which embeds a copy |
| **Tileset** | `.tileset` | **+ Add** (pick an atlas) | Tileset mode | tilemap layers, sprites |
| **Audio source** | real | Import / drop | *no editor* | backs Sound samples |
| **Sound sample** | `.sound` | **+ Add**, or derived | [Sound mode](audio.md) | sound nodes |

Extensions in full are in [File formats](../reference/file-formats.md).

> **Make bone masks and pose assets from the rig editor.** Both are edited inside the rig editor of
> the skeleton they belong to, and double-clicking one opens that rig. One created from **+ Add**
> starts with no rig, so it has nowhere to open — the log says so.

## Operations

Every kind supports rename, delete and duplicate; the details differ.

**Rename** sets the asset's name and re-applies its extension, so a rename can never reclassify an
asset.

**Delete** confirms with a consequence line saying what will actually happen — for example, deleting
a brain says *"controllers keep the brain they copied, but stop tracking this asset"*. An animation
controller works the same way: characters keep the machine they copied, and so does a particle
system: nodes keep playing the effect they copied. A bone mask or a pose does
not — a layer whose mask is deleted stops affecting anything, and a state holding a deleted pose
holds nothing.

**Duplicate** copies the record. Textures and sound samples share the underlying bytes with their
original (two textures with different sampling over one image); images and audio sources copy the
bytes.

**Thumbnails** are generated for materials, terrain materials and models — the kinds that have
something to point a camera at. A brain, a particle system, a script or a tileset shows its kind icon
instead.

## Textures

A texture is **not** its image file: it is an image plus sampling settings, so one image can back
several textures.

Texture mode shows the image in the viewport — with a mip-level stepper while mipmaps are on — and
its settings in Properties. Wrapping, filters and mipmaps take effect in the viewport as you change
them; **Flip Y** and **Precision** change how the bytes are uploaded, so they apply on the next load.

### Source

Where the texture's pixels come from: an image, shown with its file size, or a **channel pack**
gathered from the channels of other textures. A texture the engine provides itself has no stored
image, but its sampling is still yours to set.

### Wrapping

What a lookup past the edge of the image returns, per axis.

- **U**, **V** — **Repeat** tiles the image, **Clamp** stretches the edge texel, and **Mirror** tiles
  it flipping every other repeat.

### Filtering

How the texels are sampled when the texture is not drawn at exactly its own size.

- **Magnify** — drawn larger than its texels. **Nearest** snaps to the nearest texel, which is what
  keeps pixel art sharp; **Linear** blends between texels.
- **Minify** — drawn smaller than its texels.

### Mipmaps

Prefiltered smaller copies of the image, sampled as a surface recedes. Without them a minified
texture shimmers.

- **Generate** — build the chain. Off, the GPU samples level 0 at every distance.
- **Between levels** — **Linear** blends neighbouring levels, **Nearest** snaps to one.
- **Anisotropy** — off to 16×: extra samples along the view direction, for surfaces seen at a grazing
  angle. Ignored while any filter is Nearest: WebGPU refuses such a sampler outright, so it is forced
  off on both backends.

### Interpretation

How the shaders read the bytes.

- **Contents** — **Colour** (albedo, emissive) is decoded to linear when lit; **Data** (normals,
  roughness, masks) is read as numbers and must not be. The **data-slot audit** checks it against the
  materials: a texture bound as a normal, metallic, roughness, occlusion, displacement or mask map
  must be Data, any other slot wants Colour, and the panel names the materials where that disagrees.
  Nothing is changed for you — which side is wrong depends on the map.
- **Flip Y** — images are top-left origin and the GPU samples bottom-left, so this is on for almost
  everything.
- **Precision** — **8-bit**, or **Float**, a wider format for maps whose values exceed 0..1.

That audit catches the single most common material bug — a normal map imported as sRGB, which makes
lighting subtly and inexplicably wrong.

## Missing assets

The **Audit** button opens the explorer audit, which reports two problems and repairs both:

- **Missing** — assets a library holds that the explorer is not showing: they exist but have no folder
  entry. **Restore all** gives them one, in the folder you are browsing.
- **Orphaned entries** — folder entries pointing at assets that no longer exist. Removing them frees
  their names for re-import.

Both are repairable from the popover. A project that has been merged from a bundle is the usual way
to acquire either.

## Drag and drop

| Drag | Onto | Result |
|---|---|---|
| A model | Viewport or tree | Places it |
| A template | Viewport or tree | Places an instance |
| A material | A model node's material slot | Assigns it |
| A texture | A texture slot | Assigns it |
| A script | A node in the tree | Attaches it |
| A tileset | A sprite node's slot | Assigns it |
| A brain | A Controller's Brain slot | Links it |
| A particle system | A Particle System node's **Effect** slot | Copies the effect onto the node and links it |
| An animation controller | A character's **Animation** section | Runs it on that character |
| A bone mask | A controller layer's or action slot's **Mask** row | Sets the mask |
| A pose asset | A state's **Plays** row | Makes the state hold that asset's first pose |
| A scene node | The Assets panel | Saves it as a template |

Hovering a script card highlights every node using it, which is the quickest way to answer "what is
this script attached to".

## Creator assets

Assets saved in [Cleo Creator](../creator/index.md#saved-assets) appear in every project under
`/Creator/<Foliage|FX|World>/<name>`: a Foliage asset as a model with its LOD levels, materials,
textures and impostor; an FX asset as a particle system and its flipbook textures; a World as its
heightmap and mask textures (apply the heightmap with **Import heightmap ▸ From Creator** on a
landscape). They follow every change made in the Creator, live.

The folder is read-only. Renaming, moving or deleting inside it is refused with a note, because the
next sync would undo it. Duplicate an asset into another folder to make a copy of your own. When an
asset is deleted in the Creator, a project that uses it keeps it, in `/Creator/Removed`; otherwise it is
removed.

## Storage

Assets live in the project's own storage, namespaced per project, not as files on disk. To get them
out, **Export** the project; to work on scripts in a real editor, use the
[VS Code workspace](scripting-workflow.md#editing-in-vs-code).

## See also

[Models and materials](models-and-materials.md) · [Projects](projects.md) · [File formats](../reference/file-formats.md)
