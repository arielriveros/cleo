# Project features

Project ▸ Features chooses which of the engine's optional features this project's games ship with. A
2D game can leave out the landscape and global illumination; a cinematic that plays itself can leave out
input and game UI. A published game then carries less engine: fewer shaders, no data for what was left out
and less code. Global illumination, volumetric fog and clouds, decals, water, particles, fire and smoke,
weather, cloth, cinematics, the 2D world and 2D physics are each a part of the player of their own, and a game
ships only those it was built with; so do the physics backends. In a game built without 2D physics,
`scene.physics2D` is null; without weather, nothing falls from `scene.precipitation`.

The choice is the project's: it is saved in its Project Settings and travels with its bundle. The editor
itself keeps everything, so a feature left out still works while you edit; what changes is what you are
offered and what a publish ships.

This follows Godot's build profiles, which list the classes and options to leave out of a custom export
template and can be detected from the project. Cleo does not recompile anything: the published player is
built once in parts, and a publish copies the parts a game needs.

## Presets

A preset sets every box at once. Every box stays yours to change afterwards: a set that matches no preset
reads as *Custom*, and **Save as preset** keeps it on this computer for other projects.

- **2D** — tilemaps, sprites and 2D physics, no 3D world rendering. A new project's first scene is 2D.
- **2.5D** — a 3D world played on a plane: sprites and 2D physics in 3D, lean lighting.
- **3D** — landscape, particles, decals, fog and sky, without 2D or the high-end lighting.
- **High-fidelity 3D** — every 3D feature: global illumination, reflections, clouds, weather and cloth.
- **Cinematic** — full 3D rendering and sequences, with no input, game UI or AI navigation.
- **Everything** — every feature. What a project made before features existed has.

## What turning a feature off does

- **In the editor**, its nodes leave the Add menu, its assets leave the New menu and its mode leaves the
  mode selector. A node already in a scene stays, shown struck through in the scene tree with a note in its
  inspector: it is not shipped. The renderer's settings for it say so too. The AI agent cannot add one.
- **When publishing**, its nodes are removed from every scene and template (a 2D body's children are kept
  in its place), the render settings that run it are turned off, and its shaders are left out of the game.
  A game without **Input** binds no input map and shows no touch controls.
- **In the game's scripts**, a name of a feature the game was published without (`DecalNode` without Decals)
  throws an error that names the feature, rather than reading `undefined`.

Each row shows what leaving the feature out saves, and **in use** when the project uses it. Hover the mark
for where. The estimate under the list is the engine a game downloads, before its own scenes, meshes and
textures.

**Detect from project** reads every scene, template and script and turns each feature on if the project uses
it and off if not. Besides each feature's nodes it counts a trigger in a 2D scene as 2D physics, a controller
driven by AI as AI navigation, a model with cloth parts as Cloth, and a script naming any of a feature's
classes or functions as that feature. Like Godot's, the detection is static: a node a script builds at runtime from a type
name, or a feature reached only through another, is not seen. Features it cannot see (Input, WebGL 2
fallback) keep their state.

## Rendering

- **Global illumination** — GI Volumes: baked and live bounce light from probe grids.
- **Screen-space reflections** — reflections traced through the depth buffer.
- **Ambient occlusion & indirect light** — screen-space ambient occlusion and its bounce light (SSAO, SSIL).
- **Volumetric fog** — fog volumes lit by the sun and local lights.
- **Volumetric clouds** — raymarched cloud layers and the shadows they cast.
- **Sky atmosphere** — a physically scattered sky and aerial perspective.
- **Decals** — decal volumes projected onto surfaces.
- **Cel shading** — the toon shading model for materials.
- **Blinn-Phong shading** — the classic Blinn-Phong shading model for materials.

## World

- **Landscape** — sculpted terrain with painted layers, foliage and impostors.
- **Water volumes** — water that floats bodies and ripples.

## Effects

- **Particles** — GPU particle systems and force fields.
- **Fire & smoke volumes** — simulated fluid volumes for fire and smoke.
- **Weather** — weather volumes: rain, snow, wetness and puddles. Needs Particles.

## 2D

- **2D world** — tilemaps, 2D cameras, rooms and parallax layers.
- **2D physics** — 2D character and rigid bodies, and 2D areas.

## Simulation

- **Cloth** — simulated capes, banners and flags.

## Gameplay

- **Input** — the input map: keyboard, mouse, gamepad and touch controls.
- **AI navigation** — navmeshes that AI controllers path and patrol on.
- **Game UI** — UI nodes: menus, HUDs and their widgets.

## Cinematic

- **Cinematics** — sequences: timed camera cuts, animation and events.

## Platform

- **WebGL 2 fallback** — the WebGL 2 shaders, for browsers and devices without WebGPU. The same switch as
  Options ▸ Project ▸ Published game ▸ WebGL 2 fallback.

The physics engine is chosen in Options ▸ Engine ▸ Runtime; a game ships only the one it runs on.

## New projects

**New project** in the project browser asks for a name, the features (a preset to start from) and the
addons the project turns on. Everything can be changed later in Project ▸ Features and Project ▸ Addons.

## Publishing

When a game still uses a feature the project leaves out, Publish lists every use — the scene and node, the
material, the render setting or the script — and asks:

- **Turn them on and publish** turns those features back on in Project ▸ Features and publishes with them.
- **Publish without them** publishes this build without them; the project keeps everything as it is.
- **Cancel** stops the publish.

Play in window plays the game as a publish would ship it, without asking.
