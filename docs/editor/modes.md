# Editor modes

The editor is always in exactly one mode. The mode decides what the viewport is for and which panels
are visible.

There are **17**. Five are chosen from the top bar; the rest you enter by **opening an asset**, which
also opens a document tab for it.

## Modes you choose

The mode selector sits in the top bar and is only shown while the **scene tab** is active — opening
an asset tab hides it, because that tab's mode is not a choice. All five are disabled during Play.

| Mode | For | Availability |
|---|---|---|
| **Scene** | Normal scene authoring. | Always. |
| **Landscape** | Sculpt, paint and scatter foliage on terrain. | **3D scenes only.** |
| **Tilemap** | Paint tiles. | **2D scenes only.** |
| **UI** | Screen-space layout and anchoring. | Always. |
| **Renderer** | Render settings and debug channels, over a live render. | Always. |
| **Input** | Action maps and bindings, judged against a live scene. | Always. |

Landscape and Tilemap share one slot, chosen by the scene's authored dimension — see
[Scene settings](scene-authoring.md#scene-settings).

## Modes you enter by opening an asset

| Mode | Entered by | For |
|---|---|---|
| **Template** | Opening a `.tpl` | Authoring a prefab in its own throwaway scene. |
| **Model** | Opening a `.model` | LOD levels, cull distance, and a preview. |
| **Material** | Opening a `.mat` | Editing a material on a preview sphere. |
| **Terrain Material** | Opening a `.tmat` | Base surface, blend settings and foliage rules. |
| **Animation** | The Animation Editor button on a skinned model | Clips, state graph, blend spaces, IK, events. |
| **Animation Field** | Opening an `.afield` | Authoring a 1D or 2D blend space. |
| **AI Brain** | Opening a `.brain` | Behaviour, goal and fuzzy graphs. *(unreleased)* |
| **Script** | Opening a `.script` | The code editor. |
| **Tileset** | Opening a `.tileset` | Atlas slicing and per-tile metadata. |
| **Texture** | Opening a `.tex` | Sampling settings, drawn as they apply. |
| **Sound** | Opening a `.sound` | Waveform, transport, loop region, effects. |

## What each mode shows

| Mode | Viewport | Panels |
|---|---|---|
| `scene` | 3D/2D scene | Everything: tree, both Add palettes, Properties, Scripts, Physics, Logger, Assets |
| `template` | The template's own scene | Same as Scene, with the tree rooted at the template root |
| `landscape` | Scene + brush | Tree, Properties, Add palettes, plus a floating brush card. **No Scripts, no Physics** |
| `tilemap` | Scene + tools | Tree, Properties, **Tiles**, **Layers**, plus a floating tool card. No Scripts, no Physics |
| `ui` | Scene + DOM overlay | Everything except **Physics** — a screen rectangle has no rigid body |
| `renderer` | Live render | **Only** Performance and Renderer Settings |
| `input` | Live scene | **Only** the Input panel |
| `material` | Preview sphere | Properties, titled *Material*. No tree, no Add palettes |
| `terrainMaterial` | Preview sphere | Properties, titled *Terrain Material* |
| `model` | Model preview | Model inspector plus the node property editor |
| `animation` | Character + skeleton | Scene panel becomes **Skeleton**, plus **Clips**, **Variables**, **State Machine**. *Properties hidden* |
| `animationField` | Character preview | **Field Settings** on the right, **Blend Space** plot at the bottom |
| `aiBrain` | *(full-panel graph)* | The graph canvas fills the viewport area. Properties (titled *Brain*), Logger, Assets |
| `script` | *(full-panel editor)* | The code editor. Logger and Assets only |
| `tileset` | *(full-panel editor)* | The slicing grid. Properties, titled *Tileset* |
| `texture` | *(full-panel editor)* | The image as its settings say. Properties, titled *Texture* |
| `soundSample` | *(full-panel editor)* | Waveform and transport. Properties, titled *Sound* |
| *Play* | Runtime | **All chrome hidden.** Viewport only |

The five full-panel modes — `aiBrain`, `script`, `tileset`, `texture`, `soundSample` — do not paint
the 3D canvas at all, and the viewport's floating chrome (gizmo buttons, the debug eye menu, the
2D/3D switch) is hidden with it.

## Asset previews are not graded

Only the scene tab meters exposure and runs the post-processing chain. A material preview or a model
preview is therefore shown on its own terms rather than through your scene's bloom, depth of field
and colour grading — which is what makes a material you tuned in a bright scene still readable when
you open it.

## Notes on particular modes

**Template mode** opens the prefab in a scene of its own. This is where to change anything inside a
template: a placed instance is read-only in the scene except for its transform.

**Animation mode** replaces the scene tree with the model's skeleton, and hides Properties — the
three animation panels are the inspector there.

**AI Brain mode** *(unreleased)* is new: the Behaviour, Goals and Fuzzy graphs used to be an overlay
opened from a Controller's inspector, and are now a proper tab-backed editor over a reusable asset.
See [AI brains](ai-brains.md).

**Renderer and Input modes** deliberately show almost nothing. They are for judging a change against
a live scene, so the scene gets the space.

## See also

[Interface](interface.md) · [Assets](assets.md) · [Scene authoring](scene-authoring.md)
