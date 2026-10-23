# Rendering

**Options ▸ Engine** has the **Renderer** and **Performance** pages, over a live render (see
[Options](options.md)). Render settings are saved with the open scene and carried into a published build.

Every field with its type and default is in [Render settings](../reference/render-settings.md); this
page is about using them.

## Renderer Settings

The panel, in order.

### Graphics API

A **request**, applied on the next editor reload — a graphics context cannot change API underneath
live buffers.

### Channels

Blit one internal buffer instead of the final composite. This is the fastest way to answer "why does
this look wrong":

**Final, Lit Scene, Albedo, Metallic, Normal, Roughness, Emissive, AO, Depth, SSAO, Indirect, Shadow,
Cascades, Bloom, Bloom Mask, Velocity, TAA History, Overdraw.**

**SSAO** is the screen-space occlusion; **Indirect** is the bounce light the same pass gathers, before
it is multiplied by each surface's colour.

| Looking at | Channel |
|---|---|
| A material that lights oddly | **Normal** — a normal map imported as sRGB is obvious here. |
| Something too shiny or too flat | **Metallic**, **Roughness** |
| Shadows in the wrong place | **Shadow**, **Cascades** |
| Bloom on the wrong things | **Bloom Mask** |
| Ghosting or smearing | **Velocity**, **TAA History** |
| Transparency cost | **Overdraw** (costs an extra pass) |

**Highlight Invalid Pixels** paints magenta for NaN, orange for Inf, cyan for an illegal negative.
Reach for it when something flickers or goes black in a way that makes no sense.

### Optimizations

Frustum culling; occlusion culling; foliage cull distance, shadow distance, prepass, GPU culling, cell
size and density falloff; terrain LOD with two distances and two detail steps.

**Occlusion** skips what is hidden, in two stages. The first rasterizes the landscape (lowered, so it
can only hide what the real ground hides) and any **Occluder** volumes into a small CPU depth buffer
the same frame: exact, and never wrong. **GPU Occlusion Queries** add what that cannot see — a cart
behind a house, a camp below a cliff that is not terrain — by drawing each large or heavy model's box
against the frame's real depth. Those results arrive a frame or two late, so an object can appear a
frame late when whatever hid it moves away fast; turn the queries off if that shows. The Performance
HUD's *occluded objects* row splits into the two.

**GPU Foliage Culling** (WebGPU) moves the per-instance half of foliage culling to a compute pass:
every tree faded out of its detail band, or off screen, is dropped before a vertex of it runs, and the
buckets draw indirectly. On WebGL2 the toggle is disabled and foliage is packed on the CPU.

### Tone and post

**Auto exposure** (compensation, min/max EV, adaptation speeds) or manual **EV100**; **tone map**
(AgX default, ACES, Neutral, None); saturation; chromatic aberration; a **colour LUT** and its
amount.

> ### EV runs backwards, and it is worth internalising
>
> `exposure = REFERENCE_ILLUMINANCE / (1.2 · 2^EV)` — so **`exposureMinEV` is a ceiling on
> brightness**, not a floor, and lowering it is what makes a scene blow out.
>
> | EV100 | exposure |
> |---|---|
> | 2 (default floor) | 16384 |
> | 9 | 128 — a white screen for a night scene |
> | 15.3 | 1.6 |
> | 16.5 | 0.7 |
>
> **With metering on, the manual exposure is ignored.** To ramp the look over a day/night cycle,
> animate `exposureCompensation`, which is applied after the clamp.
>
> And left free, metering normalises whatever it is shown toward middle grey — that is its entire
> job — so a night comes out as bright as a dawn and your lighting ramp becomes cosmetic. A night
> scene wants a **narrow EV band** bracketing the authored exposure, roughly a stop either side.

### Bloom, DoF, lens, vignette, grain

Each is a small block. Bloom shows an "inactive because…" hint when its threshold makes it a no-op,
which saves a lot of confusion — bloom emitting nothing is usually a threshold in the wrong space,
not a broken effect.

Depth of field is off by default and its focus controls mean nothing until it is on. A camera that
names a **focus target** measures the distance to that node and ignores the focus distance setting.

**Lens dirt** has an unusual polarity worth remembering: an empty texture means **the built-in
mask**, not "off". The intensity is the switch.

### Antialiasing and motion blur

**TAA** is one toggle by design. It resolves inside the scene render, so it applies to asset
previews as well.

**Motion blur** is camera-reprojection, with an amount and a quality (8 / 16 / 24 taps). Suppress it
per node with `node.motionBlur`.

### Shadows

Directional shadows with cascades, plus separate spot and point shadow blocks.

| Setting | Note |
|---|---|
| **Resolution** / **Cascades** | Per cascade. More cascades is more passes. |
| **Distance** / **Split λ** | How far, and how the range is divided. |
| **Filter** | 3×3 PCF or 16-tap rotated Poisson. |
| **Softness / Strength / Blend** | |
| **Depth Bias / Normal Bias** | Acne versus peter-panning. |
| **Stabilize** | Snaps the frustum to texels so shadows stop crawling as the camera moves. |
| **Stagger Updates** | Updates distant cascades on their own frames: cascade *i* every 2^*i* frames, never two on one frame. |
| **Caster Pad** | How far outside the view casters are still gathered. |

> **Stagger makes the frame-time graph deliberately uneven.** A periodic spike is the feature
> working. A *constant* stall is something else.

What keeps cascades cheap, all automatic:

- **Only what can show.** A caster is drawn into a cascade only if its shadow can land on a pixel that
  cascade shades. A hill too low to reach the valley floor stays out. The player, standing beside the
  camera, casts into the nearest cascade only.
- **Nothing redrawn for nothing.** A cascade whose contents have not moved since it was drawn is
  kept as it is. The Performance panel's **Shadow layers · kept** row counts these. An animated
  character or swaying foliage inside a cascade keeps it redrawing.
- **Turning is free.** With Stagger on, the distant cascades are fit around the camera, not its
  view, so mouse-look never forces them to redraw early. Walking does once the camera has
  travelled past their margin.
- **Cheaper far detail.** Beyond the nearest cascade, a mesh foliage layer with an octahedral
  impostor casts through the impostor, and terrain that only casts (no pixel of that cascade lands
  on it) draws at its coarsest level. The far cascade draws the landscape as a few dozen coarse
  blocks. The nearest cascade always draws the real meshes.

Point shadow resolution is **per cube face**, so it is six times the memory it looks like.

### Ambient occlusion and indirect light

One screen-space pass (deferred path only) gives both. Nearby geometry darkens the ambient light it
blocks, and with **Indirect Light** on it also sends back the light it received last frame — colour
bleeding from a red wall onto the floor, bounce light under eaves and at the foot of walls, an
emissive surface lighting what is next to it.

| Setting | What it does |
|---|---|
| **Enabled** | The whole pass. Off is no occlusion and no bounce. |
| **Indirect Light** | The bounce. Off leaves ambient occlusion alone, which is cheaper. On in the High and Ultra presets. |
| **Indirect Intensity** | Scales the bounce. 1 is physically based. |
| **Radius** | How far, in world units, an occluder can be and still count. Larger finds more bounce. |
| **Power** | Contrast of the occlusion. Does not affect the bounce. |
| **Thickness** | How deep each occluder is assumed to be. Light passes behind anything thinner, so a pole in front of a wall no longer paints a dark halo on it. |
| **Bias** | Samples closer than this are ignored, against a surface occluding itself. |

It only sees what is on screen: light from something behind the camera, or hidden behind another
object, is not bounced. Blinn-Phong, cel and custom forward materials neither receive it nor, being
outside the G-buffer, occlude.

### Shading

Three shading toggles, all on by default:

- **Specular occlusion** — gives the specular lobe its own occlusion term. Off, a polished floor
  standing in a corner visibly loses its reflection.
- **Specular antialiasing** — widens roughness by sub-pixel normal variance so highlights stop
  flickering. PBR and terrain only.
- **Horizon occlusion** — drops indirect specular where the reflection ray points into the surface.
  This is the fix for the wet-looking rim on strongly normal-mapped surfaces at glancing angles.

### Grid

Editor-only. Never in a published game.

## What is *not* in this panel

| Thing | Where it is |
|---|---|
| Height maps, parallax | On the **material** — [Height](models-and-materials.md#height-and-parallax) |
| Post-processing chain order | On the **camera** |
| Sky, clouds, light probes, sky light, decals | On their **nodes** |
| Scene ambient, clear colour, reflections | In [Scene settings](scene-authoring.md#scene-settings) |

## Performance HUD

The **Performance** panel, alongside.

| Section | Shows |
|---|---|
| **Frame** | An FPS graph against a 60/120/144 Hz budget line, and the quality preset. |
| **Frame budget** | Render CPU and GPU; physics broken into step, write-back, rays, bodies, contacts, broadphase and foliage colliders; scene broken into transforms, rigs, scripts and animators; plus unattributed time. |
| **Passes** | Per-pass CPU and GPU cost, with optional timer queries. |
| **Geometry** | Draw calls, instanced draws, objects, instances, triangles, culled objects and instances, nodes, and foliage draws, shadow draws, cells and scanned cells. |
| **Fill rate** | Screen passes, shaded megapixels, state changes and state changes saved. |
| **Memory** | Texture count and megabytes, estimated GPU memory, JS heap. |
| **Scene** | Lights, sprites, resolution and internal render scale. |

### Reading it

**Start with Frame budget**, not with the FPS number. It tells you which of four places the time is
going — render CPU, render GPU, physics, or scene — and the fix for each is different.

**Unattributed time** growing is usually garbage collection or something outside the engine.

**Foliage spikes only while the camera moves.** Cell admission and the cull boundary are per-motion
costs. A steady frame rate standing still and spikes while walking is this.

**Periodic spikes with shadows on** are cascade staggering. Turn Stagger off to confirm; that will
make the cost constant and higher, not lower. The **Shadow layers** rows under Geometry show how many
shadow maps were drawn and kept each frame, and how many draws and triangles they took.

Every number here is also readable from script — see
[Math and utilities](../scripting/math-and-utils.md#statistics) — so you can build an in-game debug
overlay from the same data.

## Quality presets

Low, Medium, High (default), Ultra, and Custom. Choosing one moves several settings at once; the
exact table is in [Render settings](../reference/render-settings.md#quality). Touching anything
afterwards puts you in Custom, which touches nothing.

Presets are the right thing to offer players in an options menu, and `Game.updateRenderSettings`
applies one at runtime.

## See also

[Render settings](../reference/render-settings.md) · [Rendering (scripting)](../scripting/rendering.md) · [Models and materials](models-and-materials.md)
