# Node inspector

The **Properties** panel. What it shows depends on the selected node's type.

Every selection is composed the same way:

1. **Node Information** — name, ID, node type, child count, **Spawn on start** (when off, the node
   stays dormant until a script calls `spawn()` on it), **Motion blur** and **See-through to camera** on
   nodes with geometry, and Delete. **See-through to camera** lets a camera rig in Dither collision mode
   see through this node where it stands between the camera and the player (it applies to the whole
   subtree).
2. **Transform** — position, rotation (degrees), scale. Hidden for screen-space UI, which has no
   meaningful transform.
3. **Model slot**, when the node has geometry.
4. **A type-specific editor.**

Selecting the scene **root** shows [Scene settings](scene-authoring.md#scene-settings) instead.

> On a node inside a placed template instance, only the Transform, the instance root's **name** and
> **script field values** are editable; they become that instance's overrides, each with a **revert**
> marker. Everything else is disabled: open the template to change it. A notice in the panel says so
> and offers **Revert all**.
>
> The node **type** can only be changed on a template root.

## Common sections

| Section | Appears on | What it does |
|---|---|---|
| **Model** | Nodes with geometry | Which model asset it came from, and a jump into the model editor. |
| **Material** | Model nodes, decals | Linked material thumbnail, edit / unlink / create. **One slot per submesh** on a merged import. A decal takes **PBR materials only**: linking any other kind is refused with a message. |
| **Skeleton** | Nodes that are, or contain, a skinned model | The skeleton asset the character's clips, animators and blend spaces come from, with a ✎ into the rig editor. The list holds only the character's own skeleton and the skeletons it has been retargeted to. **Retarget skeleton…** adds another: pick a skeleton that has clips, check the mapping (**Map bones…** drags bones between the two), and **Use skeleton** saves the mapping on the character's own skeleton and switches it over. Sockets, foot IK and the ragdoll keep following the character's own bones. |
| **Animation** | Nodes that are, or contain, a skinned model | **✨ Animate this character…** when it has no animator ([the wizard](animation.md#animate-a-character-in-a-minute)); which animator it runs — **its own** or a [shared one](animation.md#shared-animators); **Edit Animation** into the workspace; and, on a shared animator, **Clip overrides (this character only)**. |
| **Socket** | Any non-UI node, when a character with sockets is in reach or the node is already attached | Pins the node to a bone [socket](animation.md#sockets) on a character's skeleton — the sword in the hand: a target (**Nearest character above**, or a specific character) and a socket. |
| **Scripts** | Any node | Not in Properties: the separate **Scripts** panel, with the script slot and that node's values for the script's fields. See [Scripting workflow](scripting-workflow.md#the-scripts-panel). |
| **Physics** | Any node | Not in Properties: the separate **Physics** panel, with the rigid body, trigger and ragdoll. See [Physics](physics.md). |

> The Model and Animation sections appear only on the node that actually has the mesh, or on the
> root of a placed model instance. They no longer appear on cameras, spatial sounds or any ancestor
> above a mesh — those were showing because a debug helper counted as a child.

> A node **attached to a socket** has its transform rewritten every frame, so editing its Transform
> while attached does nothing visible. Move the socket's offset in the rig editor instead, or set the
> socket back to **Not attached**.

## By node type

### Cameras

**Camera** — projection (perspective / orthographic), FOV or orthographic size, near and far clip
planes, and a **Focus Target**: the node depth of field focuses on, in place of the renderer's focus
distance. While a camera rig controls the FOV, the field shows the rig's value instead.

**Post-Processing** — the camera's post chain: the built-in effects and its screen materials, run top
to bottom. Each pass switches on or off and moves up or down; a built-in can only be switched off,
never removed, so there is always a row to switch it back on from. **Add screen material…** (or a
screen material dropped from Assets) appends a [Screen-mode material](models-and-materials.md#custom-materials),
and **Reset to default order** returns to the renderer's order. Motion blur, auto-exposure and the
final tonemap are fixed: they run before and after this list.

**Camera Rig** — drives its child camera's position and rotation every frame, so edit the boom here
rather than moving the camera itself. Its groups:

- **Follow** — what drives position: the **Follow Target** (with none, the rig's own position is the
  pivot), an offset in world space or the target's heading or full rotation, and per-axis damping in
  seconds (`0` is rigid), along world or rig axes.
- **Aim** — what drives rotation: **Orbit** is script-driven (`rig.addYaw(dx)` / `rig.addPitch(dy)`,
  or a controller's look input), **Look At** turns to a target, **None** keeps the authored rotation.
  Then aim damping (look-at only), yaw and pitch, orbit sensitivity, and pitch and yaw limits. Setting
  a limit pair to one value locks that angle, which is how the Top-Down, Isometric and Side-Scroller
  presets hold their view.
- **Spring Arm** — **Arm Length**, how far back along the boom the camera sits (`0` is a
  first-person camera at the pivot), and **Socket Offset**. The rig's local +X is its *left*, so a
  negative X puts the camera over the right shoulder.
- **Field of View** — when **Rig Controls FOV** is on, the rig owns the camera's FOV and eases it
  with its own damping. Turning it off gives the camera back the FOV it had before.
- **Collision** — what happens when something is between the camera and the pivot. **Handle
  Obstruction** switches it on; **Response** picks how:
  - **Retract** pulls the camera in. It tests physics collider shapes, terrain included: the same
    solids the character collides with. A body blocks it only while its **Camera Collision** channel is
    on (Physics panel); trigger volumes, the follow and look-at targets and the rig's own character are
    always ignored.
  - **Dither** dithers away the part of each see-through obstruction that blocks the view, inside a
    hole around the camera-to-player line, instead of pulling in for it. Only nodes with **See-through to
    camera** on (and foliage rules with it) are cut, and their colliders stop pulling the camera in;
    anything else (a wall, a ceiling) still pulls it in, as **Retract** does. **Hole Radius** is the hole's
    size in metres, **Hole Strength** how much of the surface goes at its centre. Shadows are
    unaffected, and under TAA the dither reads as a smooth see-through.
- **Shake** — position and rotation amplitude, frequency and decay. Shake shows only while the scene
  runs (Play or Simulate), which is when **Test Shake** is worth pressing; a script calls
  `rig.shake(0.6)`.

> Put a shoulder offset on **Socket Offset**, not on the camera child — the rig rewrites the child's
> whole local position every frame.

### Lights and environment

#### Light

Photometric intensity — lux for directional, lumens for point and spot — colour, per-kind
parameters and shadow casting. **Presets** sets real-world lights: the colour from the source's colour
temperature, the range, cone and size of the real thing. Real brightness only shows in the setting a
light belongs to — a real 800 lm bulb changes no pixel in a scene exposed for daylight — so a preset
is brightened as far as the scene needs: a lamp until it lights the distance it is meant for as
brightly as that scene is exposed, a sun until it stands the right number of times over the ambient
fill. In a dark scene exposed for it, the real values apply unchanged. A new point or spot light
starts at 1500 lm, brightened the same way.

- **Emission** — colour and intensity, plus **Range** and **Source Radius** on point and spot
  lights. Brightness lives in the intensity, not the colour: keep the colour as the light's tint. A
  light converted from the old constant / linear / quadratic falloff says so, and **Reset to
  physical defaults** re-authors it in real units.
- **Shadows** — **Cast Shadows**. The first directional light with it on is the scene's sun, and the
  renderer fits its shadow cascades around the camera. Spot and point lights get shadow maps of their
  own, reaching as far as the light's range, a few at a time
  ([Spot shadows](rendering.md#spot-shadows), [Point shadows](rendering.md#point-shadows)); any
  beyond that cap go unshadowed.
- **Cone** — spot lights: **Inner Angle** and **Outer Angle**, half-angles in degrees. Full
  brightness inside the inner cone, nothing past the outer one. Narrowing the cone does not brighten
  the light.
- **Source** — directional lights: **Angular Radius**, the sun's apparent radius in radians (the
  real sun is 0.00465). It sets how broad the sun's reflection is on smooth surfaces, and softens
  shadow edges in proportion.

#### Light Probe

Influence volume, blend distance, intensity, what it affects (lighting, reflections, or both),
capture mode and bake controls. A reflections-only probe gives a room or a pond its local reflections
without changing how the sky and ambient light it.

**Cubemap Preview** — what the probe last captured, unwrapped into a 2 : 1 panorama. **Bake Probe**
captures again.

A bounded probe's box shows as a wireframe while it is selected, with square handles on its six faces
for sizing it in the viewport — see [Volume handles](scene-authoring.md#volume-handles).

#### Exposure Volume

A region with its own exposure. While the camera is inside the box, the fields it overrides replace the
scene's exposure settings ([Tone and post](rendering.md#tone-and-post)), eased in over the blend
distance at its faces, so walking into a cave or a lit hall adapts the eye there. The scene's settings
are never changed: leave the volume and they apply again. The *Exposure* presets fill in every field
they set.

| Field | Meaning |
|---|---|
| **Enabled** | Off leaves the volume in the scene without it changing anything. |
| **Size** | Full extents of the box in metres, before the node transform, which it follows, rotation included. The face handles in the viewport size it too. |
| **Blend distance** | How far inside its faces the override fades in, in metres. 0 is a hard edge; the exposure still eases at its adaptation speed. |
| **Priority** | Where volumes overlap, they apply lowest priority first, each over the result so far, so the highest wins. At equal priority the smaller box wins. |

**Overrides** — the scene's exposure fields, each with a tick box. A ticked field takes the value set
here; an unticked one shows the scene's value, dimmed, and passes it through. Editing a field ticks it.
Above them, a line says whether the camera is inside the volume now, how strongly, and the EV it is
exposed at.

#### Skybox

Six cube faces, laid out as an unfolded cube, each with its own image. Mutually exclusive with Sky
Atmosphere: adding one removes the other.

#### Sky Atmosphere

A physically based sky, baked to a cubemap whenever the sun moves, with air and fog **Presets**. See
[Node types](../reference/node-types.md#skyatmospherenode--skyatmosphere).

- **Sun** — follow the scene's directional light (**Use Scene Directional Light**) or point the sun
  yourself; its colour, intensity and disk size.
- **Atmosphere** — Rayleigh scattering (the blue of the sky) and Mie scattering (the haze around the
  sun) with their heights, exposure, ground colour, and the planet and atmosphere radii.
- **Night Sky** — procedural stars (brightness, density, colour variance) or a night-sky texture with
  its own intensity and rotation, plus airglow.
- **Moon** — part of the night sky. It rises opposite the sun, moved by the azimuth and elevation
  offsets, with a phase, size, colour and brightness. Once the sun has set, the scene's directional
  light shines from the moon at **Moonlight on Scene** times its intensity, shadows included. The
  whole night sky (moonlit air, stars, airglow and the disc) scales with it too, at the brightness it
  was tuned for at the default 0.08: a real moon is about 0.000002 of the sun, and with lights in real
  units an auto exposure opens up to a sky that dark rather than the sky lighting the night.
- **Quality** — the baked sky's resolution, and the view and light march steps.
- **Fog** — height fog, measured along each line of sight: density, start distance, maximum opacity,
  and the **Height** below which it is uniform and the **Height Falloff** with which it thins above
  that. Its colour is the sky's horizon colour in that direction, optionally blended toward a custom
  colour, and it hazes the sky near the horizon too, so fogged ground meets a fogged sky.
- **God Rays** — volumetric light shafts: intensity, density, anisotropy, maximum distance, march
  steps and tint.

#### Sky Light

Lights the scene with the sky itself: a surface facing up receives the zenith, one facing a sunset
receives the sunset. It works from the Sky Atmosphere or from a Skybox, whichever the scene has, so
there is no need for a light probe just to get ambient light.

Intensity, tint, ambient and night ambient, cloud response — and, while the scene draws volumetric
clouds, **Cloud Shadows** with a strength — plus an L0 read-out that separates "the projection has
not landed yet" from "the sky really is that dim". **Ambient** scales the scene's flat ambient fill
(Scene settings → Ambient); **Night Ambient** is how much of it is kept after sunset, so a night
without a moon can go almost pitch black while the day is unchanged.

#### Volumetric Clouds

Raymarched clouds: on or off, their opacity, and the groups below, with cloud **Presets**. See
[Node types](../reference/node-types.md#volumetriccloudsnode--volumetricclouds).

- **Shape** — coverage, density, cloud type (stratus to cumulonimbus), base altitude and thickness,
  the base and detail noise, curl turbulence, anvil bias and haze distance.
- **Lighting** — the sun (the scene's directional light, or a direction and colour of its own) and
  its intensity; the ambient, from the sky light or a colour of its own; ground albedo and sunset
  colour; extinction, albedo, forward and back scattering, silver lining and powder.
- **Multiple Scattering** — light that bounces more than once inside a cloud, approximated in
  octaves (1 is single scattering only): how many, and how much each octave keeps of the scattering
  (a), the extinction (b) and the phase eccentricity (c).
- **Animation** — how the clouds drift. **Follow Scene Wind** blows them the way the scene's
  [Wind](#wind) does, with **Wind Speed** as the altitude wind at that node's Strength 1: its
  Strength scales it, and 0 stills the sky. Without a Wind node the direction set here is used.
  **Detail Wind Factor** makes the detail noise drift faster than the base.
- **Sky Bake** — **Bake into Sky in Play**: play mode and published games bake the clouds into the
  sky cubemap at load and draw that as a static texture instead of raymarching every frame. Wind and
  cloud shadows freeze at the bake. The bake paints over the Sky Atmosphere, so without one the
  clouds stay live. **Preview Baked in Editor** shows the bake while authoring, **Re-bake When the
  Sun Moves** bakes again during play once the sun has moved about 2°, and **Regenerate** bakes now,
  at a face size of 256 to 1024.
- **Quality** — resolution scale (rays per screen axis), march and light steps, maximum distance,
  jitter (hides banding) and temporal upscale (traces 1/16 of the pixels each frame and rebuilds the
  rest from history).

#### Decal

Size, opacity, sort order, angle and depth fade, which attributes it affects, receivers (every
surface or terrain only), and the pattern: the linked material, or the radial gradient's colours,
curve and ring. A notice repeats the limit that surprises people most: surface decals do not show on
Blinn-Phong or Cel materials. See [Node types](../reference/node-types.md#decalnode--decal-unreleased).

**Radial pattern** — a procedural gradient instead of the material, for ground indicators: the outer
colour at the rim blends to the inner one at the centre along the chosen curve, with an optional ring
on the rim.

#### Wind

One wind for the whole scene. Plants sway only where their material (its
[Wind](models-and-materials.md#sections) section) or a billboard foliage rule has a wind strength
above 0; this node sets the direction, how strong every plant's lean is, and how gusts travel across
the landscape. Past **Fade end** plants stop moving, and distant foliage then uses the cheaper still
shaders. **Presets** set the strength and gusts and leave the direction alone. Volumetric clouds can
follow it too.

#### Water Volume

A box of water whose top face is the surface. Every dynamic body inside floats by its **mass** against
the water its colliders displace — denser than the water sinks, lighter floats higher — and is slowed
by the drag. Physics runs in Play. **Buoy characters** is off by default: a character capsule is
mostly air and would be launched out of the water. **Swell** makes the surface bob; a **Surface**
model whose custom material declares `vec4` uniforms `ripple0` … `ripple11` gets ripples from
whatever moves through, and a **Splash** template spawns where something enters the water or wades
through it. Liquid **Presets** (a still pool to lava) set the density, drag and swell, never the box
or what it links to.

#### Occluder

A box that hides whatever is behind it from rendering; it draws nothing and collides with nothing.
Keep it inside the solid part of what it stands for — the walls of a building, the bulk of a rock:
anything that pokes out of the real geometry hides things you can see past it. Landscapes occlude on
their own. Culling is switched off, or limited to terrain, in
[Renderer settings › Optimizations](rendering.md#optimizations).

### Effects

**Particle System** — the effect asset it plays and how this instance plays it. See
[Particles](particles.md#in-a-scene).

**Force Field** — pushes the particles of emitters that have the **Force Fields** module; nothing
else responds, and up to 16 fields act at once. **Force** picks what it does — **Wind** along the
node's local +Y, **Radial**, **Vortex** around local +Y, **Turbulence** or **Drag** — and **Shape**
where: everywhere, a sphere or a box, fading in over **Falloff** from its edge. Direction and axis
come from rotating the node, so there is no vector to type. See [Particles](particles.md#force-fields).

**Cloth** — a rectangular panel that hangs, swings and blows in the wind: a cape, a banner, a flag.
It simulates while the scene plays (Play and Simulate) and shows its rest shape while you edit. The
panel hangs in the node's local XY plane, down its −Y, so placing and turning the node places it.
- **Width** and **Height** size it in metres; **Columns** and **Rows** set how finely it folds.
- **Held Edge**: **Top** for a cape or a banner, **Left** for a flag on its pole, **None** to let it
  fall.
- **Ride On**: **This node** holds the edge where the node is. Under a character, **Chest**, **Spine**,
  **Neck** or **Hips** carries it on that bone instead, so a cape follows the body through a roll.
- **Stiffness** resists stretching, **Bend** resists folding (silk at 0, canvas at 1), and **Damping**
  calms the swing. **Mass** is the whole panel's, in kilograms.
- **Wind Response** scales how hard the scene's [Wind](#wind) pushes it; 0 ignores it.
- **Collide With Character** keeps it outside the limbs of the character it hangs from, using the
  same capsules as its ragdoll. **Thickness** is how far it stays off them.

Its material is any PBR material, double-sided so both faces draw. The simulation costs a little CPU
time per cloth each frame; the Performance panel lists it under **Scene** as **cloth**.

### Gameplay

**Character** — the pawn. It turns a control intent into velocity and facing and never asks where
the intent came from, so the same character walks under a player, an AI or a script; possess it with
a Controller node. Its section tunes movement: speeds, facing, turn-in-place, jump, and the three
values it publishes to its Animator, shown live while the scene runs. See
[Characters and controllers](../scripting/characters-and-controllers.md#character-tuning).

**Controller** — the driver that possesses a Character and decides what it does, from player actions
or from a brain. See [AI agents](ai-agents.md#the-controller-inspector).

**Nav Mesh** — bake bounds, bake settings and the Bake button. See
[AI agents](ai-agents.md#navigation-meshes).

### 2D

**Sprite** — tileset plus one tile, chosen from a tile grid.

**Animated Sprite** — an ordered tile list (drag a rectangle over the atlas), or the tile's own
animation metadata; fps and loop.

**Appearance** — tint, opacity, blending. **Tileset** — which tileset a sprite uses.

**Tilemap** — grid kind, cell width and height, entity layer, collision depth.

All four are described in full in [Tilemaps and 2D](tilemap-2d.md#sprites).

### Terrain

**Landscape** — the terrain's **structure**: size, resolution, chunk quads, paint resolution, and
heightmap import/export. The brushes are in [Landscape mode](terrain.md), not here.

### Audio

**Sound** — emitter behaviour: spatial or ambient, volume multiplier, loop, and for a spatial sound
its **Falloff**. The sample's own settings (loudness, loop points, fades, bus, effects) live in the
[sample editor](audio.md). See [Sound nodes](audio.md#sound-nodes).

### UI

One editor for every UI type, in three parts: the element's own fields (titled **Canvas** on a root,
**Element** on anything else), **Anchor & Rect** (not on a root), and **Appearance**. See [UI](ui.md).

## Materials

The material editor is reached from a model node's material slot, or by opening a `.mat` asset.
Shader modes: **Basic**, **Blinn-Phong**, **PBR**, **Cel (toon)**, **Custom (shader)**.

Sections, depending on the shader: Colors (diffuse, specular, ambient, emission, shininess,
opacity), Properties, Toon, Textures, UV Mapping, **Height** (height map, world-unit versus UV depth,
invert, clip-at-UV-border), Cutout, Wind, and Options (side, transparency, shadow casting, probe
participation, wireframe).

Full detail: [Models and materials](models-and-materials.md#the-material-editor).

## Node references

Several fields name another node — a camera rig's follow target, a controller's possession, a
camera's focus target. These use a node picker rather than a text field, and they are remapped when
a template is instantiated so a copy points at its own parts.

## See also

[Scene authoring](scene-authoring.md) · [Physics](physics.md) · [Node types](../reference/node-types.md)
