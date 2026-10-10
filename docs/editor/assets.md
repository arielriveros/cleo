# Assets

The **Assets** panel is one file manager over every library in the project, with real folders. All
19 asset kinds live in it.

## The panel

A single toolbar row:

| Control | Does |
|---|---|
| **+ Add ▾** | Material, Landscape Material, Template, Script, Tileset, **AI Brain (Machine)**, **AI Brain (Goals)**, **Particle System**, **Animation Controller**, Sound, Animation, Scene, Folder, Import Files… |
| **Search** | Filters by name. |
| **Audit** | Flags assets a library holds but the explorer is not showing, and orphan entries pointing at deleted assets. Carries a warning badge when either exists. |
| **Details** | Toggles the details pane. |
| **View** | Table, Cards, or Split. |

Drop OS files on the panel to import them. Drop a **scene node** on it to save that node as a
template. Right-click empty space for **New folder**.

Folders are yours to arrange; nothing depends on where an asset sits.

## The 19 kinds

| Kind | Ext | Created by | Edited in | Used by |
|---|---|---|---|---|
| **Image** | real | Import / drop / model import | *no editor* — raw bytes, filed under `Source/` | backs Textures |
| **Texture** | `.tex` | Derived automatically from whatever registers as a texture | [Texture mode](#textures) | material slots, tileset atlases, LUTs, lens dirt |
| **Material** | `.mat` | **+ Add**, or model import | [Material mode](models-and-materials.md#the-material-editor) | model nodes |
| **Landscape Material** | `.tmat` | **+ Add** | Landscape Material mode | a landscape's base layer or any paint layer |
| **Template** | `.tpl` | **+ Add**, or dragging a scene node onto this panel | Template mode | placed instances, runtime spawning |
| **Model** | `.model` | Model import, or adopting a node subtree | Model mode | placed in scenes |
| **Scene** | `.scene` | **+ Add** | The scene tab | one is the main scene |
| **Script** | `.script` | **+ Add** | [Script mode](scripting-workflow.md) | attached to nodes |
| **Animation** | `.anim` | **+ Add** (pick a `.fbx`/`.glb`/`.gltf`) | [Clip mode](animation.md) — clips stay in source-rig space | rig clip lists, state machines |
| **Rig** | `.rig` | Model or animation import — one per distinct skeleton | [Rig mode](animation.md): clips, retargeting, IK, sockets, bone masks, poses | models built on that skeleton |
| **Animation Controller** | `.controller` | **+ Add**, or **Save as Controller…** in the state machine editor | [State machine editor](animation.md#animation-controllers), previewed on a character on its rig | characters' **Animation** section |
| **Bone Mask** | `.mask` | The rig editor's **Bone Masks** section | Rig mode, **Bone Masks** section | controller layers and action slots |
| **Pose Asset** | `.pose` | Saving a pose in the clip editor, or **+ New pose asset** in the rig editor's **Poses** section | Rig mode, **Poses** section | clip pose offsets, controller pose states |
| **Animation Field** | `.afield` | Model inspector, or **+ Add** | Animation Field mode | a state in a state machine |
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

Texture mode gives you:

| Setting | Options |
|---|---|
| Wrap | Repeat / Clamp / Mirror |
| Filter | Linear / Nearest |
| Mipmaps | On/off, with the chain shown |
| Anisotropy | 1–16× |
| Colour space | With a **data-slot audit**: a texture used as a normal, metallic, roughness, occlusion, displacement or mask map must be linear, and the panel says so if it is not |

That audit catches the single most common material bug — a normal map imported as sRGB, which makes
lighting subtly and inexplicably wrong.

## Missing assets

The audit button reports two problems:

- assets a library holds that the explorer is not showing (they exist but have no folder entry), and
- folder entries pointing at assets that no longer exist.

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

## Storage

Assets live in the project's own storage, namespaced per project, not as files on disk. To get them
out, **Export** the project; to work on scripts in a real editor, use the
[VS Code workspace](scripting-workflow.md#editing-in-vs-code).

## See also

[Models and materials](models-and-materials.md) · [Projects](projects.md) · [File formats](../reference/file-formats.md)
