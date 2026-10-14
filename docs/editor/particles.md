# Particles *(unreleased)*

Particle effects are split the way audio is: a **particle system** asset (`.vfx`) holds what an effect
*is* — its emitters and their modules — and a **Particle System node** plays it somewhere in a scene.

Everything runs on the GPU. On WebGPU each simulation step is a compute dispatch; on WebGL2 it is a
fullscreen draw that ping-pongs between two sets of float textures. Both run the same shader code, so an
effect behaves the same on either backend. Nothing is read back to the CPU, which is why the editor
shows pool sizes rather than a live particle count.

## Creating an effect

**+ Add ▸ Particle System** in the Assets panel creates a `.vfx` and opens it. You can also add a
**Particle System** node from **Add ▸ Effects** in a scene, then use **Create asset from this effect**
on its inspector slot.

## The particle editor

The effect plays over a ground plane in its own tab. **Properties** holds the stack:

- **Emitters** — every emitter simulates and draws independently. **+ Emitter** offers presets: Empty,
  Smoke, Fire, Sparks, Fountain, Magic, Snow, Rain. Each preset is an ordinary stack you can take apart.
- **Emitter** — capacity, simulation space, duration, looping, prewarm, start delay and seed.
- **Spawn**, **Initialize**, **Update** — the module stack in three stages. Add modules from the
  drop-down at the end of each stage. Every module can be disabled or removed.
- **Render** — how the emitter draws.
- **Bounds** — a fixed box the particles stay inside, used for culling and selection.

**Particle Preview** at the bottom has restart, play/pause, stop, clear, a one-shot burst, a speed
slider, and a timeline for each emitter that shows its cycle and marks its bursts.

Edits apply live. A change that keeps every pool the same size (most of them) updates the running
simulation in place, so the preview doesn't restart. Changing capacity, simulation space or the
emitter list restarts it. Edits support undo; **Save** (Ctrl+S) also re-renders the asset's card and
pushes the new definition into every open scene whose nodes link the asset.

## Modules

Modules run in a fixed order whatever their order in the stack: forces, integration, velocity limits,
collision, then the over-life changes. This is Unity's module model rather than a free-form graph.
The order is fixed so that one precompiled program serves every emitter.

| Stage | Module | Does |
|---|---|---|
| Spawn | **Spawn Rate** | Particles per second (with a multiplier curve over the cycle) and per metre the emitter moves. |
| | **Bursts** | Counts at set times, optionally repeating. |
| | **Sub-Emitter** | Spawns from another emitter's particles when they die or collide. |
| Initialize | **Shape** | Point, sphere, hemisphere, cone, box, circle or edge, from the surface or the whole volume. |
| | **Lifetime**, **Size** | A random range each. |
| | **Velocity** | From the shape, a fixed direction, or radial, with spread and speed range; can inherit the emitter's motion. |
| | **Rotation** | Starting angle and spin. |
| | **Color** | Constant, random between two colours, or random from a gradient, with an HDR intensity. |
| Update | **Gravity**, **Drag**, **Wind** | Scene gravity (scaled), linear drag, coupling to a wind velocity. |
| | **Turbulence** | Curl noise: swirling without bunching up. |
| | **Vortex**, **Point Attractor** | Spin around an axis; pull toward (or push from) a point, with a kill radius. |
| | **Force Fields** | Responds to Force Field nodes in the scene. |
| | **Limit Velocity** | Caps speed, softly. |
| | **Collision** | Against physics bodies, the visible scene (its depth buffer) and up to four planes: bounce, friction, lifetime loss, or kill. |
| | **Color / Size / Spin / Speed over Life** | Curves and gradients over each particle's life. |
| | **Color / Size by Speed** | The same, over a speed range. |
| | **Custom Code** | Your own WGSL. See below. |

### Collision

**Physics bodies** collision bounces particles off the colliders around the effect — the floors, walls,
props and characters the physics already knows — so sparks ricochet off flagstones and magic skitters
across the ground, on screen or off. Each frame the 12 colliders nearest the effect's **Bounds** (plus
2 m) are handed to the simulation. Spheres, boxes, capsules, cylinders, planes and convex hulls (as their
bounding box) are tested. Collisions are measured relative to a body's velocity, so a moving shield or a
walking character pushes particles along instead of letting them sink in. Mesh and terrain colliders
are not included; keep **Scene depth** on as well to cover them. Triggers never collide. The Performance
panel's **physics colliders** row counts what was handed over. New Collision modules have this on;
assets authored before it keep their old behaviour until you turn it on.

**Scene depth** collision uses the previous frame's depth buffer, the way Niagara's GPU collision
does. It is cheap and works against any geometry, but it only knows what the camera sees: a particle off
screen, or further behind a surface than **Surface thickness**, passes through. **Planes** work
everywhere, including 2D scenes and off screen.

### Sub-emitters

A sub-emitter's pool is sized to its parent's: **Per event** slots for each parent slot. Each child slot
belongs to one parent slot and is born when that parent dies or collides, so no event list is needed. An
emitter with a Sub-Emitter module ignores its own spawn rate and bursts.

### Custom code

The **Custom Code** module runs your WGSL on every live particle after the built-in update. It reads
and writes the particle through `p`: `(*p).position`, `velocity`, `age`, `lifetime`, `size`,
`rotation`, `spin`, `color`, `seed`. `dt` and the four `custom` values are in scope. Set
`(*p).lifetime = 0.0` to kill a particle.

Press **Compile** (Ctrl+Enter). Code runs only after a successful compile of exactly that text; until
then the emitter runs without it. Compile also produces the WebGL2 version, so a published game never
needs the shader compiler.

## Rendering

| Setting | Meaning |
|---|---|
| **Renderer** | Billboard, or Mesh (cube, sphere, shard, cylinder, or a model asset — its geometry is copied into the effect). |
| **Alignment** | Face camera, stretch along velocity, vertical, or horizontal. Meshes tumble, or point +Y along velocity. |
| **Blend** | Alpha, additive, or cutout. |
| **Texture** | A texture asset; with no texture a billboard is a soft round puff. Flipbook settings appear once one is set. |
| **Soft fade** | Fades particles out where they meet opaque geometry instead of clipping. |
| **Brightness** | HDR multiplier. Values above 1 bloom. |
| **Lit** | Half-Lambert sun plus sky fill. |
| **Sort particles** | Back to front on the GPU every frame. Alpha blending only; up to 65,536 particles. |
| **Sorting order** | Draw order between emitters, and the sorting band in 2D scenes. |

In a 2D scene (an orthographic camera over a tilemap) particles draw in the 2D pass, sorted with the
sprites by their emitter's Y, and simulate flat.

## Level of detail

An effect far from the camera does not need its full cost. The **LOD** section of the particle editor
(system-level, under the emitters) sets what happens with distance:

| Setting | Does |
|---|---|
| **Levels** | Each row starts at a distance. Past it, continuous spawning runs at its **Spawn %** and the effect **simulates** every 2nd, 3rd or 4th frame (30, 20 or 15 Hz) instead of every frame; skipped time is simulated in one longer step, so the effect stays in real time. Level 0 is full detail. |
| **Cull distance** | Past it the effect is not drawn, and a looping one stops simulating; a one-shot plays out, so it is finished rather than frozen when you come back. 0 = never. |
| **Scale bursts** | Off: a burst is an event and fires in full at every level. On: bursts thin out with the spawn rate. |
| **Emitter ▸ Detail** | Per emitter: the coarsest level it still spawns at. Set a detail layer (sparks, embers) to *Full detail only* and it drops out at level 1 while the main body stays; its live particles finish their lives. |

Distance is measured from the camera to the surface of the effect's **Bounds**, so standing at the edge
of a big fog bank counts as close. A level becomes finer again only once the camera is 10% back inside
its boundary, so hovering at one does not make the effect flicker between levels.

Two global controls: **Options ▸ Engine ▸ Renderer ▸ Particle LOD** multiplies every effect's
distances (×2 keeps full detail twice as far; the quality tiers set it from ×0.5 on Low to ×1.5 on
Ultra), and a placed node's **Distance LOD** toggle turns LOD off for that one copy — a hero effect the
camera watches from afar. Preview each level without moving the camera with the **LOD** select in the
Particle Preview transport. The Performance panel counts systems that are **LOD reduced** and
**LOD culled**.

## In a scene

The **Particle System** node's inspector links an asset and sets **Play on start**, **Simulation
speed**, **Spawn rate** (a multiplier on continuous spawning), **Off screen**, **Distance LOD** and
**Tint**, with play, stop, clear and burst buttons. Selecting the node draws its bounds.

Effects simulate while you author a scene. **Preview particles** in the viewport's eye menu switches
that off; play mode always simulates. **Effect icons** in the same menu shows or hides their
billboards.

Scripts drive the same calls:

```ts
const sparks = this.findNode('Sparks')
sparks.burst(80)
sparks.burst(20, 'Embers')   // one emitter only
sparks.stop()                // emitters stop, live particles finish
sparks.stop(true)            // clear at once
sparks.restart()
if (!sparks.isAlive) sparks.despawn()
```

## Force fields

**Add ▸ Effects ▸ Force Field** places a volume that pushes particles: **Wind** (along the node's local
+Y), **Radial** (attract, or repel with a negative strength), **Vortex** (around local +Y),
**Turbulence**, or **Drag**. A field is global, a sphere, or a box, with a falloff from its edge inward.
Selecting a field draws its shape. Only emitters with the **Force Fields** module respond; up to 16
fields act at once.
