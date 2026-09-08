# Rendering

**Renderer mode** shows two panels over a live render: **Renderer Settings** and **Performance**.
Everything here is project-wide, saved with the project, and carried into a published build.

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

**Final, Lit Scene, Albedo, Metallic, Normal, Roughness, Emissive, AO, Depth, SSAO, Shadow,
Cascades, Bloom, Bloom Mask, Velocity, TAA History, Overdraw.**

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

Frustum culling; foliage cull distance, cell size and density falloff; terrain LOD with two
distances and two detail steps.

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
| **Stagger Updates** | Updates distant cascades on alternating frames. |
| **Caster Pad** | How far outside the view casters are still gathered. |

> **Stagger makes the frame-time graph deliberately uneven.** A periodic spike is the feature
> working. A *constant* stall is something else.

Point shadow resolution is **per cube face**, so it is six times the memory it looks like.

### SSAO and shading

SSAO (deferred path only) with a world-unit radius, power and bias. Then three shading toggles, all
on by default:

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
| Displacement, tessellation, parallax | On the **material** — [Height](models-and-materials.md#height-displacement-tessellation-and-parallax) |
| Post-processing chain order | On the **camera** |
| Sky, clouds, light probes, sky light | On their **nodes** |
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
make the cost constant and higher, not lower.

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
