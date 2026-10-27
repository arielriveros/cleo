# Rendering

**Options ▸ Engine** has the **Renderer** and **Performance** pages, over a live render (see
[Options](options.md)). Render settings are saved with the open scene and carried into a published build.
Each scene keeps its own: when a game switches scenes, the scene it loads brings its exposure, shadows
and post with it, in the editor's Play and in a published game alike. Changes made during Play are
undone by **Stop**, whether a script made them or the panel did.

Every field with its type and default is in [Render settings](../reference/render-settings.md); this
page is about using them.

## Renderer Settings

The **Renderer** page, section by section in panel order. The debug channels and the graphics API
are ways of looking at a scene rather than part of it, so neither is saved with the scene.

### Graphics API

Which API drives the renderer, **WebGL 2** or **WebGPU**. The choice is a request, applied on the
next editor reload: a graphics context cannot change API underneath the buffers, textures and
programs already built on it. It belongs to this machine, not to the scene or the project. The API
in use is marked *running*; a WebGPU request that could not be met says why and runs on WebGL 2.

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
| Transparency cost | **Overdraw** — how many times each pixel was shaded. It re-rasterizes the scene additively, so unlike the others it costs an extra pass. |

**Highlight Invalid Pixels** paints magenta for NaN, orange for Inf, cyan for an illegal negative.
Reach for it when something flickers or goes black in a way that makes no sense.

### Optimizations

What the renderer may skip, and how coarsely it may draw what is far away: frustum and occlusion
culling; foliage distances, prepass and GPU culling; particle LOD; terrain LOD with two distances and
two detail steps. Distances are in world units. A terrain chunk past each LOD distance draws on a
coarser grid, but its borders stay at full detail, so the levels meet without seams.

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

| Setting | What it does |
|---|---|
| **Foliage Dist** | How far grass draws, and the least distance any foliage draws. A tree with LOD levels or an impostor draws on past its last band (half as far again) unless its model sets its own cull distance. 0 = no limit. |
| **Foliage Shadow** | How far terrain foliage casts shadows (0 = as far as it draws). Past it the foliage still draws, only not into the shadow map — a distant tree's shadow is a few texels. |
| **Cell Size** | The foliage grid's cell size. Layers re-bucket to match on the next frame. |
| **Grass Density** | How much billboard grass thins with distance, 0.1 to 1 (1 = none). Mesh props such as trees are never thinned: dropping one at a LOD switch is a visible pop. |
| **LOD1 Dist** / **LOD2 Dist** | The camera distance past which a terrain chunk drops to its first / second detail step (½, ¼ or ⅛ of the vertices along each side). |
| **Surface Tex** | The size every landscape surface is resampled to: 512, 1024 or 2048. They share one texture array, and an array has one size, so this is not a per-material choice; changing it re-bakes them all. |

### Tone and post

**Auto exposure** (compensation, min/max EV, adaptation speeds) or manual **EV100**; **tone map**
(AgX default, ACES, Neutral, None); saturation; chromatic aberration; a **colour LUT** and its
amount. The section's *Exposure* and *Look* presets set metering and lens looks in one click; a look
leaves the tone map and the LUT alone.

Exposure is written as a photographic EV100, the number a light meter reads. Lights carry real
photometric intensity and the sun is about three decades brighter than a lamp, so one exposure can
only meter one of them: a sunny exterior sits near EV 15, an interior near EV 5. Exposure is per
scene, so a cave and a hillside can each carry their own.

The tone map is the curve that turns linear HDR into a displayable image, and it is the single
biggest lever here. *AgX* rolls a saturated highlight toward white instead of clipping it to a
primary; *ACES* is the older filmic fit every scene was graded under before the curve was
selectable; *Neutral* (Khronos PBR Neutral) leaves in-gamut albedo untouched, for asset viewing;
*None* is exposure and sRGB only, hard-clamped — what the buffer actually holds.

Saturation is a trim applied in linear light, before the tone map, so the filmic shoulder still
rolls off correctly. A Sky Light with clouds multiplies its own desaturation on top, and AgX already
desaturates highlights by construction, so the same trim reads stronger under it than under ACES.
Chromatic aberration is a lens that bends red and blue by slightly different amounts: red is pushed
outward and blue inward from the centre of the frame, growing toward the corners, while the picture
itself stays put. At 1 the corners carry a red-to-blue fringe of 1% of the frame height (about 11
pixels at 1080p); 0.2–0.4 is a subtle, cinematic amount.

The colour LUT is a horizontal strip of N tiles, N×N each (256×16 or 1024×32): red runs left to right
within a tile, green downward from the top row, blue across the tiles. It is applied *after* the tone
map, on display colour, which is the space a `.cube` LUT from a grading tool was measured in.

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

### Bloom

An HDR bright-pass. **Threshold** is a luminance cutoff measured *after* exposure, so it means "bloom
what would clip on screen"; **Knee** softens the ramp around it; **Intensity** is how much is added
back. **Restrict to lit surfaces** uses the scene buffer's alpha mask — sprites, tilemaps,
transparents and unlit materials cannot set it, so they never bloom while it is on (see the **Bloom
Mask** channel).

Bloom says it is inactive, and why, when something outside the section switches it off: an
intensity of 0 (the Low quality preset does that) or a bloom pass turned off under **Pass switches**
on the Performance page. Bloom that emits nothing with neither is usually a threshold in the wrong
space, not a broken effect.

### Depth of field

A thin lens with a real aperture, so the near field blurs harder than the far field and the far
field settles at a fixed blur toward infinity. Off by default; its focus controls appear once it is
on. **Aperture** is written as an f-stop: smaller is wider, and shallower. The sky blurs as far as the
lens blurs infinity, so a deep-focus shot keeps it as sharp as the far hills; **Max Blur** only caps
the near field. A wide camera (the default 60° FOV is about a 21 mm lens) defocuses little, so the
stronger presets read best with a narrower FOV. A camera that names a **Focus Target** node in its
inspector measures the distance to that node and ignores the focus distance here. The section's
presets leave the focus distance alone.

### Lens flare

Ghosts and a halo, traced from the bright areas of the *image* rather than from the sun. That is
what makes them occlude correctly: a sun behind a wall is not in the buffer, so it throws nothing.
**Intensity** 0 is off. **Threshold** is the brightness a pixel must exceed before it flares, measured
after exposure like bloom's, so it means the same thing in a sunlit field and in a cave;
**Ghosts** (up to 8) and **Halo** (0 keeps the ghosts and drops the halo) shape what it throws.

### Lens dirt

Smudges on the front element, which brighten the bloom and flare that pass through them and are
invisible everywhere else — so nothing shows until there is glare to catch. **Intensity** is the
switch.

**Mask** — the dirt texture, with an unusual polarity worth remembering: empty means **the built-in
mask** that ships with the engine, not "off".

### Vignette

The fall-off toward the corners every real lens has. It is applied to linear radiance before the
tone curve, so the corners are exposed down rather than crushed flat. **Roundness** 0 is a circle on
screen; 1 stretches it to the frame's shape. **Smoothness** is the width of the falloff band.

### Film grain

Sensor and emulsion noise, weighted toward the midtones — black stays clean and a blown highlight
does not sparkle, which is what separates grain from video noise. It is animated, because a fixed
pattern reads as dirt on the screen rather than as film. It is sized against the exposed image, so
one intensity looks the same outdoors and in a lamp-lit room: 0.02–0.04 is a subtle stock, 0.1 is
heavy. **Size** is the grain cell in pixels; **Coloured** tints each channel independently, as colour
film does.

### Antialiasing

Temporal antialiasing, deliberately a single toggle. The projection is offset by a fraction of a
pixel each frame and the results are accumulated, so a still image converges on about eight times
the sampling; motion vectors carry the history across camera and object movement. It resolves inside
the scene render, so it applies to asset previews as well. The editor grid, gizmos and sprites are
drawn afterwards and are never blended.

### Motion blur

Camera-reprojection motion blur. **Amount** scales the shutter length; **Quality** is 8, 16 or 24
taps per pixel (Low, Med, High). Suppress it per node with `node.motionBlur`.

### Shadows

Directional (sun) shadows in cascades: each cascade is one shadow map covering a slice of the view,
nearest first. **Distance** is how far they reach, and nothing past it is shadowed unless **Far
Distance** is on. Spot and point lights have their own sections below.

| Setting | Note |
|---|---|
| **Resolution** / **Cascades** | Per cascade, 512 to 4K; 4K at 4 cascades is about 268 MB of depth. Each cascade is one more depth pass. |
| **Distance** / **Split λ** | How far the cascades reach, and how the range is divided: 0 = even slabs, 1 = resolution packed near the camera. Watch the **Cascades** channel while dragging it. |
| **Far Distance** | Landscape-scale shadows past **Distance**: the terrain and large casters only, from one extra layer redrawn only as the camera travels or something in it changes. 0 = off. |
| **Filter** | 3×3 PCF or 16-tap rotated Poisson (softer at wide radii). |
| **Softness / Strength / Blend** | Softness is the filter radius in shadow texels (0 = one hard tap). Strength is how dark a shadowed pixel goes. Blend cross-fades the seam between cascades; 0 leaves a visible line. |
| **Depth Bias / Normal Bias** | Acne versus peter-panning. Depth Bias is in *world* units and rescaled per cascade, so one value means the same in all of them. For acne on steeply lit surfaces raise Normal Bias first: it moves the lookup across the map rather than pulling the surface toward the light. |
| **Stabilize** | Snaps the frustum to texels so shadows stop crawling as the camera moves. |
| **Stagger Updates** | Updates distant cascades on their own frames: cascade *i* every 2^*i* frames, never two on one frame. |
| **Caster Pad** | How far toward the light, past a cascade's own bounds, its depth pass still gathers casters — so something outside the view still throws its shadow into it. |

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

### Spot shadows

Up to **4** spot lights cast shadows at once. Flag each with **Cast Shadows** in its inspector; any
beyond the cap simply go unshadowed, and a light that already holds a map keeps it, so one at the
edge of the cap goes dark once rather than flickering. Each map is redrawn every frame. A spot's
frustum matches its outer cone, and its far plane is the light's range, capped by **Max Dist**. The
global Shadows toggle switches these off too.

| Setting | Note |
|---|---|
| **Resolution** | One map per casting spot light, 256 to 2K. |
| **Max Dist** | The farthest a spot shadow reaches; a light with a shorter range stops at its range. |
| **Bias** | In *depth* units, not world units — perspective depth does not convert linearly — so it is a small number. |

### Point shadows

Up to **4** point lights cast shadows at once, flagged per light with **Cast Shadows**. A point
light shadows in every direction, so it costs *six* depth passes, one per cube face, where a spot
light costs one; that is why the cap is low. Only lights whose range reaches the view are drawn at
all, the lights nearest the camera get the maps, and a light whose surroundings have not moved keeps
the maps it already has — a static lamp is free after the first frame. The global Shadows toggle
switches these off too.

| Setting | Note |
|---|---|
| **Resolution** | **Per cube face**, 256 to 1K — six times the memory it looks like. |
| **Max Dist** | The farthest a point shadow reaches; a light with a shorter range stops at its range. |
| **Bias** | In depth units, as for spot shadows. |

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

Three corrections to how the specular lobe behaves, all on by default. They act where a highlight is
sharp, so on rough surfaces they are all but invisible by design. Turn one off to see what it was
doing.

- **Specular occlusion** — gives the specular lobe its own occlusion term, asking how much of the
  narrow reflection *cone* is blocked rather than the whole hemisphere. Off, a polished floor
  standing in a corner visibly loses its reflection.
- **Specular antialiasing** — widens roughness by sub-pixel normal variance so highlights stop
  flickering as they move. MSAA cannot fix that, because the aliasing is in the shading rather than
  the coverage. PBR and terrain only.
- **Horizon occlusion** — drops indirect specular where the reflection ray points into the surface.
  This is the fix for the wet-looking rim on strongly normal-mapped surfaces at glancing angles.

### Grid

The editor's reference grid, on the XZ or XY plane. Editor-only: never rendered in a published game.

## What is *not* in this panel

| Thing | Where it is |
|---|---|
| Height maps, parallax | On the **material** — [Height](models-and-materials.md#height-and-parallax) |
| Post-processing chain order | On the **camera** |
| Sky, clouds, light probes, sky light, decals | On their **nodes** |
| Scene ambient, clear colour, reflections | In [Scene settings](scene-authoring.md#scene-settings) |

## Performance HUD

The **Performance** page, beside Renderer: what the frame costs, and where. Its sections, in order:

- **Frame** — the frame time and FPS, a frame-time graph against a 60, 120 or 144 Hz budget line,
  and the p50, p95 and worst frame. The mean alone hides hitching: a flat 12 ms and a 9 ms mean with
  a 30 ms p95 read the same in one number and are completely different problems. The budget buttons
  only move the target line.
- **Frame budget** — where the frame goes: render CPU and GPU; physics, split into step (with its
  broad/narrow and solve/integrate phases), write-back, rays, bodies and contacts, dynamic bodies
  (active, frozen, resting), broadphase and foliage colliders; scene, split into transforms, rigs, AI
  paths and navmesh builds, with scripts and animators on request; and unattributed time. Render is
  CPU time only — it returns as soon as the commands are queued, so GPU cost shows under Passes.
  Physics only steps in Play mode. Unattributed is whatever the three measured phases do not account
  for: browser work, GPU sync, rAF idle.
- **Passes** — two numbers per scope: the CPU time spent *submitting* it and the GPU time spent
  running it. They answer different questions: a scope that is expensive on the CPU and cheap on the
  GPU is issuing too many draws, not shading too much, and no amount of LOD will help it. CPU timing
  is always there; the GPU's **Timer queries** are gated by driver and browser, and where they are
  missing the pass switches attribute cost by A/B instead.
- **Geometry** — draw calls, instanced draws, objects, instances and triangles; culled objects and
  instances, with what occlusion accounts for; shadow layers drawn and kept, with their draws and
  triangles; nodes; foliage draws, shadow draws, cells and scanned cells. Each is the mean over the
  last refresh with the frame-to-frame range beside it. A wide range with a still camera is usually
  cascade staggering, which redraws casters on a 4-frame cycle — not a bug. A low draw count beside a
  high shaded-megapixel figure means the frame is spent on fullscreen passes, not on meshes.
- **Particles** — systems that stepped (and those paused off screen, LOD-culled or LOD-reduced),
  physics colliders, steps, draws, instances, and GPU builds against pooled reuses. Steps are the
  simulation cost: one GPU pass per emitter per step. A build is an emitter whose GPU state was
  created this frame; a spawned effect normally reuses a pooled one, so builds above zero during play
  are the allocation spikes.
- **Fill rate** — screen passes, shaded megapixels, state changes and state changes saved. Fill
  counts each fullscreen pass at *its own* resolution, so a half-res pass counts a quarter as much as
  a full-res one. It is the number that explains a frame whose triangle count is trivial.
- **Shaders** — how programs, pipelines and material parameters reach the GPU: material writes and
  the draws that found their material already in place; programs built after boot (background, sync,
  pending); stand-in draws; the worst stall; pipelines built, recorded and warmed. A program nobody
  built at boot compiles in the background while its family's uber program draws in its place; *sync*
  builds are the ones that held a frame up. Recorded pipelines ship with a publish, and the player
  builds them during its loading screen.
- **Memory** — texture count and megabytes, estimated GPU memory, and the JS heap (Chromium only).
  *GPU est.* is computed from each texture's requested format and mip chain, so it estimates texture
  memory, not total VRAM.
- **Scene** — lights, sprites, the display resolution and, below 100 % render scale, the internal
  one the pipeline actually shades at; the backend and pipeline.
- **Quality** — the quality preset and the render scale. Ultra reproduces the engine's original
  defaults exactly; High is the default. Render scale is the internal resolution: halving it quarters
  every fullscreen pass, so if that barely moves the frame time the frame is not fill-rate bound. See
  [Quality presets](#quality-presets).
- **Pass switches** — every toggleable pass, plus *Enable all*, *Reset timings* and *Copy report*
  (the numbers as plain text, for an issue or a before/after comparison). Turn a pass off and watch
  the frame graph: the drop is that pass's true marginal cost, including downstream savings a GPU
  timer around its draws would not capture. The list is the same on every backend on purpose —
  bisection is the fallback for a cost the timers cannot see, so it must not shrink where they are
  weaker.

On WebGPU the Passes rows are render *passes*, not the renderer scopes WebGL2 times, and the two
lists are not interchangeable. A pass with no matching scope appears as `pass:…`, and there is no
`frameEnd` row, because per-pass timestamps already exclude the end-of-frame drain it exists to
absorb. Absolute values run high — the renderer submits one command buffer per pass, so each pass
pays a submission at both ends of its own window. Compare passes with each other, not with WebGL2.

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
